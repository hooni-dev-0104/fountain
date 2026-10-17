"""Read-only, authorized directory over current body-free verification headers."""
from datetime import datetime, timezone
import re
import unicodedata

from .access import Access
from .core import require
from .database_verification import DatabaseVerification
from .verification_index import inbox_store_reader

SPACE = re.compile(r'[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+')
KEYS = {'q', 'owner', 'teamspace', 'status', 'kind', 'limit', 'offset'}


def fold(value):
    return SPACE.sub(' ', unicodedata.normalize('NFKC', value).casefold()).strip(' ')


def verified_pages_query(query):
    require(isinstance(query, dict) and set(query) <= KEYS, 'Invalid verified pages query')
    result = {'q': '', 'status': 'all', 'kind': 'all', 'limit': '50', 'offset': '0'}
    for key, values in query.items():
        require(isinstance(values, list) and len(values) == 1 and isinstance(values[0], str), 'Invalid verified pages query')
        result[key] = values[0]
    q = result['q']
    require(len(q) <= 200 and '\0' not in q and not any(0xD800 <= ord(c) <= 0xDFFF for c in q), 'Invalid verified pages q')
    result['q'] = fold(q)
    for key in ('owner', 'teamspace'):
        if key in result: require(Access.verification_id(result[key]), 'Invalid verified pages '+key)
    require(result['status'] in ('all', 'verified', 'expired'), 'Invalid verified pages status')
    require(result['kind'] in ('all', 'page', 'row'), 'Invalid verified pages kind')
    for key, lower, upper in [('limit', 1, 100), ('offset', 0, 1000000)]:
        raw = result[key]
        require(bool(re.fullmatch(r'0|[1-9][0-9]{0,6}', raw)), 'Invalid verified pages '+key)
        result[key] = int(raw)
        require(lower <= result[key] <= upper, 'Invalid verified pages '+key)
    return result


class VerifiedPages:
    def __init__(self, store, access, clock=None):
        self.store, self.access = store, access
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def candidates(self):
        if not self.access.active: return []
        source = inbox_store_reader(self.store)
        # CloudStore learns these kinds once, rather than one request per Owner.
        members = {member['id']: member for member in source.list('member')}
        teamspaces = {space['id']: space for space in source.list('teamspace')}
        access = Access(source, self.access.principal)
        now = self.clock()
        pages = source.list('page')
        page_map = {page['id']: page for page in pages}
        def present(item):
            return not any(item.get(key) for key in ('archived', 'deleted', 'deleted_at'))
        def association(item, database=False):
            current, visited, links, kind = item, set(), 0, "database" if database else "page"
            while True:
                identity = current.get('id')
                token = (kind, identity)
                if not Access.verification_id(identity) or token in visited or not present(current): return None
                visited.add(token)
                parent = current.get('parent_id')
                if parent is None: break
                if links >= 64 or not Access.verification_id(parent): return None
                current = page_map.get(parent)
                if current is None: return None
                links += 1
                kind = "page"
            identity = current.get('teamspace_id')
            space = teamspaces.get(identity) if Access.verification_id(identity) else None
            return {'id': identity, 'name': space.get('name') if isinstance(space.get('name'), str) else ''} if space and access.can('teamspace', space) else None
        def make(item, kind, value, database=None):
            if value.get('verified_at') is None: return None
            expiry = value['expires_at']
            status = 'expired' if expiry is not None and datetime.fromisoformat(expiry).astimezone(timezone.utc) <= now else 'verified'
            owners = [{'id': identity, 'name': members[identity].get('name') if isinstance(members[identity].get('name'), str) else ''}
                      for identity in value['owners'] if identity in members]
            target = database if database is not None else item
            title = item.get('title', '') if kind == 'page' else item.get('properties', {}).get(next((p['id'] for p in database['properties'] if p['type'] == 'title'), None), '')
            result = {'id': item['id'], 'resource_type': kind, 'title': title if isinstance(title, str) else '',
                      'icon': target.get('icon') if isinstance(target.get('icon'), str) else None, 'owners': owners,
                      'teamspace': association(target, kind == 'row'), 'verification': {'status': status, 'verified_at': value['verified_at'], 'expires_at': expiry}}
            result.update({'page_id': item['id']} if kind == 'page' else {'database_id': database['id'], 'row_id': item['id']})
            return result
        found = []
        for page in pages:
            if Access.verification_id(page.get('id')) and present(page) and access.can('page', page):
                item = make(page, 'page', access.project_verification(page))
                if item: found.append(item)
        verification = DatabaseVerification(source, access)
        for row in source.list('row'):
            if not Access.verification_id(row.get('id')) or not present(row) or not access.can('row', row): continue
            database = source.get('database', row.get('database_id'))
            if not database or not present(database) or not access.can('database', database): continue
            value = verification.public_verification(database, row)
            if value['status'] not in ('verified', 'expired'): continue
            item = make(row, 'row', value, database)
            if item: found.append(item)
        found.sort(key=lambda item: (fold(item['title']), item['resource_type'], item['id']))
        return found

    def get(self, query):
        options = verified_pages_query(query)
        items = self.candidates()
        owners = {owner['id']: owner for item in items for owner in item['owners']}
        teamspaces = {item['teamspace']['id']: item['teamspace'] for item in items if item['teamspace'] is not None}
        sort = lambda values: sorted(values.values(), key=lambda value: (fold(value['name']), value['id']))
        filtered = [item for item in items if (not options['q'] or options['q'] in fold(item['title']))
                    and ('owner' not in options or any(owner['id'] == options['owner'] for owner in item['owners']))
                    and ('teamspace' not in options or item['teamspace'] is not None and item['teamspace']['id'] == options['teamspace'])
                    and (options['kind'] == 'all' or item['resource_type'] == options['kind'])
                    and (options['status'] == 'all' or item['verification']['status'] == options['status'])]
        limit, offset = options['limit'], options['offset']
        return {'items': filtered[offset:offset+limit], 'total': len(filtered), 'has_more': offset+limit < len(filtered),
                'limit': limit, 'offset': offset, 'filters': {'owners': sort(owners), 'teamspaces': sort(teamspaces)}}
