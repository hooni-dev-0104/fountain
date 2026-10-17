"""Current verification-expiry inbox; receipts are private per-member state.

This derives current conditions at request time, not a historical notification
queue, email sender, or background scheduler.
"""
from datetime import datetime, timezone
import hashlib
import json
import re

from .access import Access
from .core import require


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def inbox_query(query):
    require(isinstance(query, dict) and set(query) <= {'filter', 'limit', 'offset'}, 'Invalid inbox query')
    values = {}
    for key, default in [('filter', 'all'), ('limit', '50'), ('offset', '0')]:
        value = query.get(key, [default])
        require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], str), 'Invalid inbox query')
        values[key] = value[0]
    require(values['filter'] in {'all', 'unread', 'archived'}, 'Invalid inbox filter')
    for key, lower, upper in [('limit', 1, 100), ('offset', 0, 1000000)]:
        raw = values[key]
        require(bool(re.fullmatch(r'0|[1-9][0-9]{0,6}', raw)), 'Invalid inbox '+key)
        value = int(raw)
        require(lower <= value <= upper, 'Invalid inbox '+key)
        values[key] = value
    return values


class Inbox:
    def __init__(self, store, access, clock=None):
        self.store, self.access = store, access
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def candidates(self):
        if not self.access.active: return []
        now = self.clock()
        receipts = {record['id']: record for record in self.store.list('inbox_receipt')}
        found = []
        for page in self.store.list('page'):
            if (not Access.verification_id(page.get('id')) or page.get('archived') or page.get('deleted') or page.get('deleted_at')
                    or not self.access.can('page', page)): continue
            value = self.access.project_verification(page)
            if not value or self.access.member_id not in value['owners'] or value['expires_at'] is None: continue
            expiry = datetime.fromisoformat(value['expires_at']).astimezone(timezone.utc)
            if expiry > now: continue
            raw = page['verification']
            cycle = raw.get('cycle_revision')
            if cycle is not None and (type(cycle) not in (int, float) or not 0 <= cycle <= 9007199254740991 or cycle != int(cycle)): continue
            identity = digest([page['id'], value['verified_at'], value['expires_at'], int(cycle) if cycle is not None else None, Access.verification_owners(page)])
            receipt = receipts.get(digest([self.access.member_id, identity]), {})
            valid = receipt.get('member_id') == self.access.member_id and receipt.get('notification_id') == identity
            item = {'id': identity, 'type': 'verification.expired', 'page_id': page['id'],
                    'title': page.get('title') if isinstance(page.get('title'), str) else '',
                    'icon': page.get('icon') if isinstance(page.get('icon'), str) else None,
                    'verified_at': value['verified_at'], 'expires_at': value['expires_at'],
                    'read': valid and receipt.get('read') is True, 'archived': valid and receipt.get('archived') is True}
            found.append((expiry, item))
        found.sort(key=lambda entry: (-(entry[0].toordinal()*86400000000+entry[0].hour*3600000000+entry[0].minute*60000000+entry[0].second*1000000+entry[0].microsecond), entry[1]['id']))
        return [item for _, item in found]

    def get(self, query):
        options = inbox_query(query)
        items = self.candidates()
        unread = sum(not item['read'] and not item['archived'] for item in items)
        filtered = [item for item in items if (item['archived'] if options['filter'] == 'archived'
                    else not item['archived'] and (options['filter'] != 'unread' or not item['read']))]
        offset, limit = options['offset'], options['limit']
        return {'items': filtered[offset:offset+limit], 'unread_count': unread, 'total': len(filtered),
                'has_more': offset+limit < len(filtered), 'offset': offset, 'limit': limit}

    def patch(self, identity, body):
        require(isinstance(identity, str) and bool(re.fullmatch('[a-f0-9]{64}', identity)), 'Invalid inbox ID')
        require(isinstance(body, dict) and bool(body) and set(body) <= {'read', 'archived'}
                and all(type(value) is bool for value in body.values()), 'Invalid inbox fields')
        item = next((item for item in self.candidates() if item['id'] == identity), None)
        require(item is not None, 'Inbox item not found', 404)
        item = {**item, **body}
        self.store.put('inbox_receipt', {'id': digest([self.access.member_id, identity]),
            'member_id': self.access.member_id, 'notification_id': identity,
            'read': item['read'], 'archived': item['archived']})
        return item
