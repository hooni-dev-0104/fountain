"""Request authorization across document, database and management routes."""
from __future__ import annotations

import copy

from .core import require


class Authorization:
    def __init__(self, access):
        self.access = access
        self.store = access.store

    def owned(self, kind, identity):
        require(isinstance(identity, str) and 0 < len(identity) <= 160, 'Invalid resource ID')
        item = self.store.get(kind, identity)
        require(item is not None, 'Resource not found', 404)
        return item

    def manage_database(self, identity):
        return self.access.require_resource('database', identity, 4)

    def relation_values(self, database, body):
        values = body.get('properties', body.get('values', {}))
        if not isinstance(values, dict):
            return
        relations = {p['id'] for p in database.get('properties', []) if p.get('type') in {'relation', 'files'}}
        for key in relations.intersection(values):
            if isinstance(values[key], list):
                for identity in values[key]:
                    require(isinstance(identity, str), 'Relation IDs must be strings')
                    prop = next(p for p in database['properties'] if p['id'] == key)
                    if prop['type'] == 'files': self.attachment(identity)
                    else: self.access.require_resource('row', identity)

    def member_change(self, method, identity, body):
        a = self.access
        a.require_admin()
        existing = self.store.get('member', identity) if identity else None
        role = body.get('role', (existing or {}).get('role', 'member'))
        if not a.owner:
            require(role != 'owner' and (not existing or existing.get('role') != 'owner'), 'Only owners can manage owner membership', 403)
        if existing and existing.get('role') == 'owner' and (method == 'DELETE' or role != 'owner' or body.get('active') is False):
            required = self.store.meta('auth_accounts_required', False)
            other = [m for m in self.store.list('member') if m['id'] != identity and m.get('role') == 'owner'
                     and m.get('active', True) is True and (not required or self.store.get('credential', m['id']))]
            require(other, 'Cannot remove or deactivate the last active owner', 409)

    def attachment(self, identity, edit=False):
        require(isinstance(identity, str) and 0 < len(identity) <= 160, 'Invalid resource ID')
        item = self.store.get('attachment', identity)
        require(item is not None, 'Attachment not found', 404)
        a = self.access
        if a.owner or item.get('owner_id', 'local') == a.member_id:
            return item
        require(not edit, 'Insufficient attachment permission', 403)
        allowed = any(a.can('page', page) and any(block.get('attachment_id') == identity for block in page.get('blocks', []))
                      for page in self.store.list('page'))
        if not allowed:
            for row in self.store.list('row'):
                if not a.can('row', row): continue
                database = self.store.get('database', row.get('database_id')) or {}
                files = [prop['id'] for prop in database.get('properties', []) if prop.get('type') == 'files']
                if any(identity in (row.get('properties', {}).get(key) or []) for key in files):
                    allowed = True
                    break
        if not allowed:
            for version in self.store.list('version'):
                if any(block.get('attachment_id') == identity for block in version.get('blocks', [])):
                    page = self.store.get('page', version.get('page_id'))
                    if a.can('page', page, 3):
                        allowed = True
                        break
        require(allowed, 'Attachment not found', 404)
        return item

    def prepare(self, method, path, body):
        """Validate access and stamp trusted ownership; never trust caller metadata."""
        a = self.access
        require(a.active, 'Authentication required', 401)
        parts = path.strip('/').split('/')
        writing = method in {'POST', 'PATCH', 'PUT', 'DELETE'}
        if path.startswith('/scim/v2/'):
            a.require_admin(owner_only=True)
            if len(parts) == 4 and parts[2] == 'Users' and writing:
                changes = dict(body)
                operations = body.get('Operations', [])
                for operation in operations if isinstance(operations, list) else []:
                    if not isinstance(operation, dict): continue
                    if operation.get('path') == 'active': changes['active'] = operation.get('value')
                    if not operation.get('path') and isinstance(operation.get('value'), dict) and 'active' in operation['value']: changes['active'] = operation['value']['active']
                self.member_change(method, parts[3], changes)
            return
        if path in {'/api/health', '/api/workspace', '/api/search', '/api/capabilities', '/api/advanced'} and method == 'GET':
            return
        if path.startswith('/api/accounts'):
            a.require_admin(owner_only=True)
            return
        if path in {'/api/settings', '/api/retention/run', '/api/audit', '/api/analytics', '/api/backup', '/api/export', '/api/import'}:
            a.require_admin(owner_only=True)
            return
        if path == '/api/ai':
            require(a.regular, 'AI access requires a workspace member', 403)
            if body.get('page_id'):
                a.require_resource('page', body['page_id'])
            return
        if path == '/api/clipboard' and method == 'POST':
            body['owner_id'] = a.member_id
            return
        if parts[:2] == ['api', 'clipboard'] and len(parts) == 3:
            item = self.owned('clipboard', parts[2])
            require(a.owner or item.get('owner_id', 'local') == a.member_id, 'Clipboard not found', 404)
            return
        if path == '/api/pages' and method == 'POST':
            for key in ('parent_id', 'teamspace_id'):
                if key in body:
                    require(body[key] is None or isinstance(body[key], str) and 0 < len(body[key]) <= 160, 'Invalid ' + key)
            if body.get('parent_id'):
                parent = a.require_resource('page', body['parent_id'], 3)
                body['teamspace_id'] = parent.get('teamspace_id')
            else:
                require(a.regular, 'Top-level page creation requires a member', 403)
            teamspace = body.get('teamspace_id', 'general')
            if teamspace and not body.get('parent_id'):
                a.require_resource('teamspace', teamspace, 3)
            body['owner_id'] = a.member_id
            for block in body.get('blocks', []) if isinstance(body.get('blocks'), list) else []:
                if isinstance(block, dict) and block.get('attachment_id'): self.attachment(block['attachment_id'])
            if 'permissions' in body:
                body['permissions'] = a.validate_permissions(body['permissions'])
            return
        if parts[:2] == ['api', 'pages'] and len(parts) >= 3:
            needed = 1 if not writing else 3
            if method == 'DELETE' or parts[-1] == 'permissions': needed = 4 if writing else 1
            if parts[-1] == 'comments' and method == 'POST': needed = 2
            page = a.require_resource('page', parts[2], needed)
            if writing:
                if 'parent_id' in body or 'archived' in body or parts[-1] == 'restore': a.require_resource('page', parts[2], 4)
                if 'parent_id' in body:
                    require(body['parent_id'] is None or isinstance(body['parent_id'], str) and 0 < len(body['parent_id']) <= 160, 'Invalid parent_id')
                body.pop('owner_id', None)
                if 'permissions' in body and parts[-1] != 'permissions':
                    require(False, 'Use the permissions endpoint', 400)
                if body.get('parent_id'):
                    a.require_resource('page', body['parent_id'], 3)
                if 'parent_id' in body and not body.get('parent_id'):
                    require(a.regular, 'Guests cannot move pages to the workspace root', 403)
                for block in body.get('blocks', []) if isinstance(body.get('blocks'), list) else []:
                    if isinstance(block, dict) and block.get('attachment_id'):
                        self.attachment(block['attachment_id'])
                if parts[-1] == 'operations' and isinstance(body.get('ops'), list):
                    for operation in body['ops']:
                        if isinstance(operation, dict) and operation.get('type') == 'block.set' and operation.get('field') == 'attachment_id' and operation.get('value'):
                            self.attachment(operation['value'])
                if parts[-1] == 'comments': body['author'] = a.member_id
            return
        if parts[:2] == ['api', 'comments'] and len(parts) == 3:
            comment = self.owned('comment', parts[2])
            page = a.require_resource('page', comment['page_id'], 2)
            require(comment.get('author', 'local') == a.member_id or a.can('page', page, 4), 'Only the author or page manager can resolve this comment', 403)
            return
        if path == '/api/databases' and method == 'POST':
            require(a.regular, 'Database creation requires a workspace member', 403)
            a.require_resource('teamspace', body.get('teamspace_id', 'general'), 3)
            body['owner_id'] = a.member_id
            if 'permissions' in body: body['permissions'] = a.validate_permissions(body['permissions'])
            return
        if parts[:2] == ['api', 'databases'] and len(parts) >= 3:
            database = a.require_resource('database', parts[2], 4 if writing and len(parts) == 3 else 1)
            if len(parts) == 3 and writing:
                require('permissions' not in body and 'row_permissions' not in body, 'Use the permissions endpoint')
                body.pop('owner_id', None)
            if len(parts) >= 4 and parts[3] == 'permissions':
                if writing: a.require_resource('database', parts[2], 4)
                return
            if len(parts) == 6 and parts[3] == 'rows' and parts[5] == 'duplicate' and method == 'POST':
                require(a.can_create_row(database), 'Creating database rows is not allowed', 403)
                row = a.require_resource('row', parts[4])
                require(row.get('database_id') == database['id'], 'Row not found', 404)
                return
            if writing and len(parts) >= 4 and parts[3] == 'rows':
                if len(parts) == 4 and method == 'POST':
                    require(a.can_create_row(database), 'Creating database rows is not allowed', 403)
                    body['owner_id'] = a.member_id
                elif len(parts) == 5:
                    row = a.require_resource('row', parts[4], 3)
                    require(row.get('database_id') == database['id'], 'Row not found', 404)
                    body.pop('owner_id', None)
                old_row = self.store.get('row', parts[4]) if len(parts) == 5 else None
                if 'parent_row_id' in body and body['parent_row_id'] is not None:
                    parent = a.require_resource('row', body['parent_row_id'])
                    require(parent.get('database_id') == database['id'], 'Parent belongs to another database')
                if 'depends_on' in body:
                    require(isinstance(body['depends_on'], list), 'Dependencies must be a list')
                    for identity in body['depends_on']:
                        predecessor = a.require_resource('row', identity)
                        require(predecessor.get('database_id') == database['id'], 'Dependency belongs to another database')
                    if old_row:
                        hidden = [identity for identity in old_row.get('depends_on', []) if not a.can('row', self.store.get('row', identity))]
                        body['depends_on'] = list(dict.fromkeys([*body['depends_on'], *hidden]))
                self.relation_values(database, body)
            return
        if path == '/api/attachments' and method == 'POST':
            require(a.regular or any(a.can('page', page, 3) for page in self.store.list('page')), 'No document upload permission', 403)
            body['owner_id'] = a.member_id
            return
        if parts[:2] == ['api', 'attachments'] and len(parts) in {3, 4}:
            self.attachment(parts[2], method == 'DELETE')
            return
        if len(parts) >= 2 and parts[0] == 'api':
            kind = parts[1]
            identity = parts[2] if len(parts) > 2 else None
            if kind in {'members', 'groups'}:
                if kind == 'members' and writing: self.member_change(method, identity, body)
                else: a.require_admin()
                return
            if kind == 'teamspaces':
                if identity:
                    a.require_resource('teamspace', identity, 4 if writing else 1)
                    body.pop('owner_id', None)
                elif writing:
                    require(a.regular, 'Teamspace creation requires a workspace member', 403)
                    body['owner_id'] = a.member_id
                    require(isinstance(body.get('members', []), list), 'Members must be a list')
                    body['members'] = list(dict.fromkeys([a.member_id, *body.get('members', [])]))
                return
            if kind in {'forms', 'automations', 'sites'}:
                item = self.owned(kind[:-1], identity) if identity else body
                if kind == 'forms' and len(parts) == 4 and parts[3] == 'submit' and method == 'POST':
                    require(item.get('published'), 'Form not found', 404)
                    return
                if identity is None and method == 'GET':
                    return
                resource_kind, resource_id = ('page', item.get('page_id')) if kind == 'sites' else ('database', item.get('database_id', 'projects'))
                a.require_resource(resource_kind, resource_id, 4)
                if writing:
                    if body.get('page_id') and kind == 'sites': a.require_resource('page', body['page_id'], 4)
                    if body.get('database_id') and kind != 'sites': self.manage_database(body['database_id'])
                    body['owner_id'] = item.get('owner_id', 'local') if identity else a.member_id
                return
            if kind == 'integrations':
                a.require_admin(owner_only=True)
                return
        if path.startswith('/forms/') and method == 'GET':
            return  # Published form rendering validates publication and workspace sharing policy.
        if path.startswith('/sites/') and method == 'GET':
            return  # Explicit publication is the page owner's sharing decision.
        # Unknown routes still receive the normal 404; no generic object-store access exists.

    def project(self, path, payload):
        a = self.access
        if not isinstance(payload, dict): return payload
        result = copy.deepcopy(payload)
        def row_projection(row):
            database = self.store.get('database', row.get('database_id'))
            if not a.can('row', row):
                return {'id': row['id'], 'database_id': row.get('database_id'), 'access_level': 0}
            filtered = a.filter_database({'database': database, 'rows': [row]})['rows'][0]
            filtered['access_level'] = a.level('row', row)
            return filtered
        if isinstance(result.get('properties'), dict) and 'database_id' in result and 'id' in result:
            return row_projection(result)
        if isinstance(result.get('row'), dict):
            result['row'] = row_projection(result['row'])
        if path == '/api/workspace':
            result = a.filter_workspace(result)
        if path == '/api/search':
            for key in ('results', 'pages'):
                if key in result: result[key] = [p for p in result[key] if a.can('page', p)]
        parts = path.strip('/').split('/')
        if path == '/api/advanced':
            for kind, key in (('teamspace', 'teamspaces'), ('page', 'sites'), ('database', 'automations'), ('database', 'forms')):
                if key == 'teamspaces':
                    result[key] = [item for item in result.get(key, []) if a.can(kind, item)]
                else:
                    target = 'page_id' if kind == 'page' else 'database_id'
                    result[key] = [item for item in result.get(key, []) if a.can(kind, self.store.get(kind, item.get(target)), 4)]
            if not a.owner:
                result['audit'], result['integrations'] = [], []
                result['groups'] = [g for g in result.get('groups', []) if a.member_id in g.get('members', [])]
                result['members'] = a.filter_workspace({'members': result.get('members', [])}).get('members', [])
        if path == '/api/teamspaces':
            result['teamspaces'] = [item for item in result.get('teamspaces', []) if a.can('teamspace', item)]
        if len(parts) == 2 and parts[0] == 'api' and parts[1] in {'forms', 'automations', 'sites'}:
            key = parts[1]
            target_kind, target_key = ('page', 'page_id') if key == 'sites' else ('database', 'database_id')
            result[key] = [item for item in result.get(key, []) if a.can(target_kind, self.store.get(target_kind, item.get(target_key)), 4)]
        if isinstance(result.get('rows'), list) and 'database' not in result:
            result['rows'] = [row_projection(row) for row in result['rows']]
        if 'database' in result and 'rows' in result:
            result = a.filter_database(result)
            result['database']['access_level'] = a.level('database', result['database'])
            result['database']['can_create_row'] = a.can_create_row(result['database'])
            for row in result['rows']: row['access_level'] = a.level('row', row)
        if path.startswith('/api/forms/') and path.endswith('/submit') and not a.owner:
            form = self.store.get('form', parts[2])
            if form and (not a.can('database', self.store.get('database', form['database_id'])) or result.get('row', {}).get('access_level') == 0):
                return {'submitted': True, 'submission_id': result.get('submission', {}).get('id')}
        for key, kind in (('pages', 'page'), ('databases', 'database')):
            for item in result.get(key, []):
                if not isinstance(item, dict):
                    continue  # Imports return new database IDs rather than entity records.
                item['access_level'] = a.level(kind, item)
                item.setdefault('owner_id', 'local')
        if 'page' in result and isinstance(result['page'], dict):
            result['page']['access_level'] = a.level('page', result['page'])
            result['page'].setdefault('owner_id', 'local')
            if 'versions' in result and not a.can('page', result['page'], 3):
                result['versions'] = []
        if path.startswith('/api/pages/') and 'id' in result and 'title' in result:
            result['access_level'] = a.level('page', result)
            result.setdefault('owner_id', 'local')
        if path == '/api/pages' and 'id' in result:
            result['access_level'] = a.level('page', result)
        return result
