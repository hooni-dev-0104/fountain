"""Explicit workspace administration grants, separate from content ACLs."""
import hashlib
import json
import re
import uuid

from .access import Access, ROLES
from .core import APIError, require

CATALOG = (
    ('audit.read', '감사 로그 조회'), ('analytics.read', '워크스페이스 분석 조회'),
    ('members.read', '멤버 조회'), ('members.manage', '멤버 관리'),
    ('groups.read', '그룹 조회'), ('groups.membership.manage', '기존 그룹 멤버 관리'),
    ('content.search.read', '관리자 콘텐츠 검색'), ('content.search.export', '관리자 검색 CSV 내보내기'),
    ('content.permissions.manage', '콘텐츠 공유 권한 관리'), ('content.publish.manage', '콘텐츠 게시 해제'),
)
ACTIONS = frozenset(action for action, _ in CATALOG)
MEMBERSHIP_ACTIONS = frozenset({'members.read', 'members.manage', 'groups.read', 'groups.membership.manage'})
GENERATION_PREFIX = '_admin_member_generation_v1:'
UUID = re.compile(r'[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def generation_key(member_id):
    require(Access.verification_id(member_id), 'Invalid admin member id')
    return GENERATION_PREFIX + hashlib.sha256(member_id.encode('utf-8')).hexdigest()


def _nonce(store, kind):
    allocate = getattr(store, 'allocate_id', None)
    return allocate(kind) if callable(allocate) else uuid.uuid4().hex


def invalidate_member(store, member_id):
    """Rotate only an existing generation; lifecycle writes never enroll users."""
    key = generation_key(member_id)
    if store.meta(key) is None:
        return False
    store.set_meta(key, _nonce(store, 'admin_generation'))
    return True


def _plain(value, limit, empty=True):
    space = ' \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000'
    return (isinstance(value, str) and len(value) <= limit and (empty or bool(value.strip(space)))
            and not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value))


def _actions(value):
    return (isinstance(value, list) and 1 <= len(value) <= len(ACTIONS)
            and all(isinstance(action, str) and action in ACTIONS for action in value)
            and len(set(value)) == len(value)
            and ('members.manage' not in value or 'members.read' in value)
            and ('groups.membership.manage' not in value or 'groups.read' in value)
            and (not any(action in value for action in ('content.search.export', 'content.permissions.manage', 'content.publish.manage'))
                 or 'content.search.read' in value))


def _eligible(member):
    return (isinstance(member, dict) and Access.verification_id(member.get('id'))
            and member.get('active', True) is True and member.get('role') in ('member', 'admin'))


def _valid_role(role):
    return (isinstance(role, dict) and Access.verification_id(role.get('id'))
            and type(role.get('version')) in (int, float) and role['version'] == 1
            and _plain(role.get('name'), 100, False) and _plain(role.get('description'), 1000)
            and _actions(role.get('actions')) and isinstance(role.get('nonce'), str)
            and UUID.fullmatch(role['nonce']) is not None
            and set(role) <= {'id', 'version', 'name', 'description', 'actions', 'nonce', 'created_at', 'updated_at'})


class AdminAuthority:
    def __init__(self, store, access):
        self.store, self.access = store, access

    def _current(self):
        principal = self.access.principal
        if not self.access.active or not Access.verification_id(self.access.member_id):
            return None
        member = self.store.get('member', self.access.member_id)
        if (not isinstance(member, dict) or member.get('id') != self.access.member_id
                or member.get('active', True) is not True or member.get('role') not in ROLES
                or member.get('role') != principal.get('role')):
            return None
        return member

    def _owner(self):
        member = self._current()
        return member is not None and member.get('role') == 'owner'

    def _roles(self):
        return {role['id']: role for role in self.store.list('admin_role') if _valid_role(role)}

    def _assignment(self, member_id, roles=None, generations=None):
        value = self.store.get('admin_assignment', member_id)
        if (not isinstance(value, dict) or value.get('id') != member_id or value.get('member_id') != member_id
                or set(value) - {'id', 'member_id', 'role_ids', 'role_nonces', 'generation', 'created_at', 'updated_at'}
                or not isinstance(value.get('generation'), str) or not UUID.fullmatch(value['generation'])
                or value['generation'] != (generations.get(generation_key(member_id)) if generations is not None
                                           else self.store.meta(generation_key(member_id)))):
            return []
        ids = value.get('role_ids')
        if (not isinstance(ids, list) or len(ids) > 32 or not all(Access.verification_id(identity) for identity in ids)
                or len(set(ids)) != len(ids)):
            return []
        nonces = value.get('role_nonces')
        if (not isinstance(nonces, dict) or set(nonces) != set(ids)
                or not all(isinstance(nonce, str) and UUID.fullmatch(nonce) for nonce in nonces.values())):
            return []
        roles = self._roles() if roles is None else roles
        return [identity for identity in ids if identity in roles and nonces[identity] == roles[identity]['nonce']]

    def actions(self):
        member = self._current()
        if member is None:
            return []
        if member['role'] == 'owner':
            return [action for action, _ in CATALOG]
        if not _eligible(member):
            return []
        actions = set(MEMBERSHIP_ACTIONS) if member['role'] == 'admin' else set()
        roles = self._roles()
        for identity in self._assignment(member['id'], roles):
            actions.update(roles[identity]['actions'])
        return [action for action, _ in CATALOG if action in actions]

    def allows(self, action):
        return isinstance(action, str) and action in ACTIONS and action in self.actions()

    def require_action(self, action):
        require(self.allows(action), 'Administrative action permission required', 403)

    def _generations(self):
        reader = getattr(self.store, 'admin_member_generations', None)
        if callable(reader):
            value = reader()
            require(isinstance(value, dict), 'Invalid administrative state', 503)
            return value
        return None

    def _revision(self, generations=None):
        members = self.store.list('member')
        assignments = self.store.list('admin_assignment')
        ids = {item.get('member_id') for item in assignments if isinstance(item, dict) and Access.verification_id(item.get('member_id'))}
        if generations is None:
            generations = self._generations()
        # Member extensions are neither authority nor owner review fields. Typed
        # fields and persisted timestamps still fence concurrent member edits.
        members = [{key: member.get(key) if isinstance(member.get(key), str) else ''
                    for key in ('id', 'name', 'email', 'role', 'created_at', 'updated_at')}
                   | {'active': member.get('active', True) is True} for member in members]
        state = {'roles': sorted(self.store.list('admin_role'), key=lambda item: item['id']),
                 'assignments': sorted(assignments, key=lambda item: item['id']),
                 'members': sorted(members, key=lambda item: item['id']),
                 'generations': [[identity, generations.get(generation_key(identity)) if generations is not None
                                  else self.store.meta(generation_key(identity))] for identity in sorted(ids)]}
        def canonical_numbers(value):
            if type(value) in (int, float):
                require(-9007199254740991 <= value <= 9007199254740991 and value == int(value), 'Invalid administrative state', 503)
                return int(value)
            if isinstance(value, list):
                return [canonical_numbers(item) for item in value]
            if isinstance(value, dict):
                return {key: canonical_numbers(item) for key, item in value.items()}
            return value
        try:
            state = canonical_numbers(state)
            return hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()
        except (TypeError, ValueError, UnicodeEncodeError):
            raise APIError(503, 'Invalid administrative state')

    def overview(self):
        require(self._owner(), 'Workspace owner permission required', 403)
        roles = self._roles()
        generations = self._generations()
        self.store.list('admin_assignment')
        members = sorted((member for member in self.store.list('member') if _eligible(member)), key=lambda member: member['id'])
        assignments = []
        for member in members:
            ids = self._assignment(member['id'], roles, generations)
            if ids:
                assignments.append({'member_id': member['id'], 'role_ids': sorted(ids)})
        return {'catalog': [{'id': action, 'label': label} for action, label in CATALOG],
                'roles': [{key: role[key] for key in ('id', 'name', 'description', 'actions')}
                          for _, role in sorted(roles.items())],
                'assignments': assignments,
                'eligible_members': [{key: member.get(key) if isinstance(member.get(key), str) else ''
                                      for key in ('id', 'name', 'email', 'role')} for member in members],
                'revision': self._revision(generations)}

    def _check_revision(self, body):
        revision = body.get('revision')
        require(isinstance(revision, str) and re.fullmatch(r'[0-9a-f]{64}', revision), 'Invalid admin revision')
        require(revision == self._revision(), 'Administrative state changed; reload and retry', 409)

    def _changed(self, action, details):
        revision = self.store.meta('access_revision', 0)
        require(type(revision) is int and 0 <= revision < 9007199254740991, 'Invalid access revision', 503)
        self.store.set_meta('access_revision', revision + 1)
        audit = getattr(self.store, 'audit', None)
        if callable(audit):
            audit(action, details, self.access.member_id)

    def _writable(self):
        require(all(callable(getattr(self.store, name, None)) for name in ('put', 'delete', 'set_meta', 'transaction')),
                'Administrative storage is read-only', 503)
        return self.store

    def route(self, method, path, body, query):
        require(isinstance(query, dict) and not query, 'Invalid admin query')
        require(isinstance(body, dict), 'Invalid admin body')
        if path == '/api/admin/self':
            require(method == 'GET', 'Unsupported admin method', 405)
            require(not body, 'Invalid admin body')
            require(self._current() is not None, 'Active member required', 403)
            return {'actions': self.actions(), 'can_manage_roles': self._owner()}
        roles_route = path == '/api/admin/roles'
        role_match = re.fullmatch(r'/api/admin/roles/([^/]+)', path)
        assignment_match = re.fullmatch(r'/api/admin/assignments/([^/]+)', path)
        require(roles_route or role_match or assignment_match, 'Admin route not found', 404)
        allowed = {'GET', 'POST'} if roles_route else {'PATCH', 'DELETE'} if role_match else {'PUT'}
        require(method in allowed, 'Unsupported admin method', 405)
        require(self._owner(), 'Workspace owner permission required', 403)
        if method == 'GET':
            require(not body, 'Invalid admin body')
            return self.overview()
        fields = {'revision', 'name', 'description', 'actions'} if method in ('POST', 'PATCH') else {'revision', 'role_ids'} if assignment_match else {'revision'}
        require(set(body) <= fields and 'revision' in body, 'Invalid admin fields')
        with self._writable().transaction():
            self._check_revision(body)
            created_id = None
            if roles_route or role_match:
                identity = role_match[1] if role_match else None
                if identity is not None:
                    require(Access.verification_id(identity), 'Invalid admin role id')
                    previous = self.store.get('admin_role', identity)
                    require(previous is not None, 'Admin role not found', 404)
                else:
                    previous = None
                if method == 'DELETE':
                    self.store.delete('admin_role', identity)
                    self._changed('admin.role.delete', {'role_id': identity})
                else:
                    require(method != 'PATCH' or bool(set(body) - {'revision'}), 'Provide admin role fields')
                    if previous is not None:
                        require(_valid_role(previous), 'Invalid admin role state', 409)
                    role = dict(previous or {})
                    role.update({key: body[key] for key in ('name', 'description', 'actions') if key in body})
                    role.setdefault('description', '')
                    require(_plain(role.get('name'), 100, False), 'Invalid admin role name')
                    require(_plain(role.get('description'), 1000), 'Invalid admin role description')
                    require(_actions(role.get('actions')), 'Invalid admin role actions')
                    role['actions'] = [action for action, _ in CATALOG if action in role['actions']]
                    if previous is None:
                        require(len(self.store.list('admin_role')) < 100, 'Admin role limit reached', 409)
                        identity = _nonce(self.store, 'admin_role')
                        require(self.store.get('admin_role', identity) is None, 'Admin role id collision', 409)
                        role.update(id=identity, version=1, nonce=_nonce(self.store, 'admin_role_nonce'))
                        created_id = identity
                    self.store.put('admin_role', role)
                    self._changed('admin.role.create' if previous is None else 'admin.role.update', {'role_id': identity})
            else:
                identity = assignment_match[1]
                require(Access.verification_id(identity), 'Invalid admin member id')
                require(_eligible(self.store.get('member', identity)), 'Admin role member is not eligible', 400)
                ids = body.get('role_ids')
                require(isinstance(ids, list) and len(ids) <= 32 and all(Access.verification_id(value) for value in ids)
                        and len(set(ids)) == len(ids), 'Invalid admin role ids')
                roles = self._roles()
                require(all(value in roles for value in ids), 'Admin role not found', 400)
                previous = self.store.get('admin_assignment', identity)
                if ids:
                    key = generation_key(identity)
                    generation = self.store.meta(key)
                    if not isinstance(generation, str) or not UUID.fullmatch(generation):
                        generation = _nonce(self.store, 'admin_generation')
                        self.store.set_meta(key, generation)
                    self.store.put('admin_assignment', {'id': identity, 'member_id': identity,
                                                       'role_ids': sorted(ids), 'role_nonces': {role_id: roles[role_id]['nonce'] for role_id in ids},
                                                       'generation': generation})
                elif previous is not None:
                    self.store.delete('admin_assignment', identity)
                if ids or previous is not None:
                    self._changed('admin.assignment.update', {'member_id': identity, 'role_ids': sorted(ids)})
            result = self.overview()
            if created_id is not None:
                result['created_role_id'] = created_id
            return result
