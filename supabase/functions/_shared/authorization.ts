/** Route guards and response projection. Domain validation still runs after prepare.
 * Port of fountain/authorization.py; unknown routes are left to the router's 404.
 */
import {Access, clone, dictionary, get, has, is_object, put_key, require, truth, valid_id} from './access.ts';
import type {Entity, StoreReader} from './access.ts';

export class Authorization {
  access: Access;
  store: StoreReader;
  private ownerAccounts: 'legacy-credentials'|'cloud-commit';
  constructor(access: Access, options: {ownerAccounts?:'legacy-credentials'|'cloud-commit'} = {}) { this.access = access; this.store = access.store; this.ownerAccounts=options.ownerAccounts??'legacy-credentials'; }
  owned(kind: string, identity: unknown): Entity {
    require(valid_id(identity), 'Invalid resource ID');
    const item = this.store.get(kind, identity);
    require(item !== null, 'Resource not found', 404);
    return item;
  }
  manage_database(identity: unknown): Entity { return this.access.require_resource('database', identity, 4); }
  schema_references(database: Entity, properties: Entity[]): void {
    const previous=new Map((get(database,'properties',[]) as Entity[]).map(prop=>[prop.id,prop]));
    const promoted=properties.filter(prop=>['files','relation'].includes(prop.type)&&(previous.get(prop.id)?.type!==prop.type||prop.type==='relation'&&get(previous.get(prop.id),'database_id')!==get(prop,'database_id')));
    if(!promoted.length)return;
    // Evaluate every new reference against the ORIGINAL stored schema. Putting
    // the replacement first would manufacture its own attachment-read authority.
    for(const row of this.store.list('row')){
      if(get(row,'database_id')!==database.id)continue;
      for(const prop of promoted){
        const values=get(get(row,'properties',{}),prop.id);
        if(values===null)continue;
        require(Array.isArray(values)&&values.length<=1000&&values.every(valid_id),'Promoted reference properties must contain resource ID lists');
        for(const id of values){
          if(prop.type==='files')this.attachment(id);
          else{
            const target=this.access.require_resource('row',id);
            require(!truth(get(prop,'database_id'))||get(target,'database_id')===prop.database_id,'Relation target row not found in target database');
          }
        }
      }
    }
  }
  relation_values(database: Entity, body: Entity, existing: Entity | null = null): void {
    const values = get(body, 'properties', get(body, 'values', {}));
    if (!is_object(values)) return;
    const properties: Entity[] = get(database, 'properties', []);
    for (const prop of properties.filter(prop => ['relation', 'files'].includes(get(prop, 'type')) && has(values, prop.id))) {
      const ids = get(values, prop.id);
      if (Array.isArray(ids)) for (const identity of ids) {
        require(typeof identity === 'string', 'Relation IDs must be strings');
        if (prop.type === 'files') this.attachment(identity);
        else this.access.require_resource('row', identity);
      }
    }
    // Validate incoming visible refs first; merge existing hidden refs only afterwards.
    if (truth(existing)) for (const prop of properties) {
      const key = prop.id;
      if (get(prop, 'type') !== 'relation' || !has(values, key)) continue;
      const previous = get(get(existing, 'properties', {}), key), next = get(values, key);
      if (!Array.isArray(previous) || (next !== null && !Array.isArray(next))) continue;
      const hidden = previous.filter(id => typeof id === 'string' && this.store.get('row', id) && !this.access.can('row', this.store.get('row', id)));
      if (hidden.length) put_key(values, key, Array.from(new Set([...(next || []), ...hidden])));
    }
  }
  member_change(method: string, identity: unknown, body: Entity): void {
    const a = this.access;
    a.require_admin();
    const existing = truth(identity) ? this.store.get('member', identity) : null;
    const role = get(body, 'role', get(existing, 'role', 'member'));
    if (!a.owner) require(role !== 'owner' && (!existing || get(existing, 'role') !== 'owner'), 'Only owners can manage owner membership', 403);
    if (existing && get(existing, 'role') === 'owner' && (method === 'DELETE' || role !== 'owner' || get(body, 'active') === false)) {
      // CloudStore never reads password hashes. Its SQL commit checks the final
      // owner set against actual mapped, active Supabase Auth accounts atomically.
      const required = this.ownerAccounts==='cloud-commit' ? false : this.store.meta('auth_accounts_required', false);
      const other = this.store.list('member').filter(member => member.id !== identity && get(member, 'role') === 'owner' && get(member, 'active', true) === true && (!truth(required) || this.store.get('credential', member.id)));
      require(other, 'Cannot remove or deactivate the last active owner', 409);
    }
  }
  attachment(identity: unknown, edit = false): Entity {
    require(valid_id(identity), 'Invalid resource ID');
    const item = this.store.get('attachment', identity), a = this.access;
    require(item !== null, 'Attachment not found', 404);
    if (a.owner || get(item, 'owner_id', 'local') === a.member_id) return item;
    require(!edit, 'Insufficient attachment permission', 403);
    let allowed = this.store.list('page').some(page => a.can('page', page) && get(page, 'blocks', []).some((block: Entity) => get(block, 'attachment_id') === identity));
    if (!allowed) for (const row of this.store.list('row')) {
      if (!a.can('row', row)) continue;
      const database = this.store.get('database', get(row, 'database_id')) || {};
      const files = get(database, 'properties', []).filter((prop: Entity) => get(prop, 'type') === 'files').map((prop: Entity) => prop.id);
      if (files.some((key: string) => {
        const value = get(get(row, 'properties', {}), key);
        return (Array.isArray(value) || typeof value === 'string') && value.includes(identity as string);
      })) { allowed = true; break; }
    }
    if (!allowed) for (const version of this.store.list('version')) {
      if (get(version, 'blocks', []).some((block: Entity) => get(block, 'attachment_id') === identity) && a.can('page', this.store.get('page', get(version, 'page_id')), 3)) { allowed = true; break; }
    }
    require(allowed, 'Attachment not found', 404);
    return item;
  }
  prepare(method: string, path: string, body: Entity): void {
    const a = this.access;
    require(a.active, 'Authentication required', 401);
    const parts = path.replace(/^\/+|\/+$/g, '').split('/'), last = parts.at(-1);
    const writing = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
    if (path.startsWith('/scim/v2/')) {
      a.require_admin(true);
      if (parts.length === 4 && parts[2] === 'Users' && writing) {
        const changes = clone(body), operations = get(body, 'Operations', []);
        if (Array.isArray(operations)) for (const operation of operations) {
          if (!is_object(operation)) continue;
          if (get(operation, 'path') === 'active') changes.active = get(operation, 'value');
          if (!truth(get(operation, 'path')) && is_object(get(operation, 'value')) && has(operation.value, 'active')) changes.active = operation.value.active;
        }
        this.member_change(method, parts[3], changes);
      }
      return;
    }
    if (['/api/health', '/api/workspace', '/api/search', '/api/search/advanced', '/api/capabilities', '/api/advanced'].includes(path) && method === 'GET') return;
    if (path.startsWith('/api/accounts')) { a.require_admin(true); return; }
    if (['/api/settings', '/api/retention/run', '/api/audit', '/api/analytics', '/api/backup', '/api/export', '/api/import'].includes(path)) { a.require_admin(true); return; }
    if (path === '/api/ai') {
      require(a.regular, 'AI access requires a workspace member', 403);
      if (truth(get(body, 'page_id'))) a.require_resource('page', body.page_id);
      return;
    }
    if (path === '/api/clipboard' && method === 'POST') { body.owner_id = a.member_id; return; }
    if (parts[0] === 'api' && parts[1] === 'clipboard' && parts.length === 3) {
      const item = this.owned('clipboard', parts[2]);
      require(a.owner || get(item, 'owner_id', 'local') === a.member_id, 'Clipboard not found', 404);
      return;
    }
    if (path === '/api/pages' && method === 'POST') {
      for (const key of ['parent_id', 'teamspace_id']) if (has(body, key)) require(body[key] === null || valid_id(body[key]), 'Invalid ' + key);
      if (truth(get(body, 'parent_id'))) {
        const parent = a.require_resource('page', body.parent_id, 3);
        body.teamspace_id = get(parent, 'teamspace_id');
      } else require(a.regular, 'Top-level page creation requires a member', 403);
      const teamspace = get(body, 'teamspace_id', 'general');
      if (truth(teamspace) && !truth(get(body, 'parent_id'))) a.require_resource('teamspace', teamspace, 3);
      body.owner_id = a.member_id;
      if (Array.isArray(get(body, 'blocks'))) for (const block of body.blocks) if (is_object(block) && truth(get(block, 'attachment_id'))) this.attachment(block.attachment_id);
      if (has(body, 'permissions')) body.permissions = a.validate_permissions(body.permissions);
      return;
    }
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'pages' && parts[3] === 'presence') {
      require(['GET', 'PUT', 'DELETE'].includes(method), 'Unsupported presence method', 405);
      a.require_resource('page', parts[2], 1);
      return;
    }
    if (parts[0] === 'api' && parts[1] === 'pages' && parts.length >= 3) {
      let needed = writing ? 3 : 1;
      if (method === 'DELETE' || last === 'permissions') needed = writing ? 4 : 1;
      if (last === 'comments' && method === 'POST') needed = 2;
      a.require_resource('page', parts[2], needed);
      if (writing) {
        if (has(body, 'parent_id') || has(body, 'archived') || last === 'restore') a.require_resource('page', parts[2], 4);
        if (has(body, 'parent_id')) require(body.parent_id === null || valid_id(body.parent_id), 'Invalid parent_id');
        delete body.owner_id;
        if (has(body, 'permissions') && last !== 'permissions') require(false, 'Use the permissions endpoint', 400);
        if (truth(get(body, 'parent_id'))) a.require_resource('page', body.parent_id, 3);
        if (has(body, 'parent_id') && !truth(get(body, 'parent_id'))) require(a.regular, 'Guests cannot move pages to the workspace root', 403);
        if (Array.isArray(get(body, 'blocks'))) for (const block of body.blocks) if (is_object(block) && truth(get(block, 'attachment_id'))) this.attachment(block.attachment_id);
        if (last === 'operations' && Array.isArray(get(body, 'ops'))) for (const op of body.ops) if (is_object(op) && get(op, 'type') === 'block.set' && get(op, 'field') === 'attachment_id' && truth(get(op, 'value'))) this.attachment(op.value);
        if (last === 'comments') body.author = a.member_id;
      }
      return;
    }
    if (parts[0] === 'api' && parts[1] === 'comments' && parts.length === 3) {
      const comment = this.owned('comment', parts[2]), page = a.require_resource('page', comment.page_id, 2);
      require(get(comment, 'author', 'local') === a.member_id || a.can('page', page, 4), 'Only the author or page manager can resolve this comment', 403);
      return;
    }
    if (path === '/api/databases' && method === 'POST') {
      require(a.regular, 'Database creation requires a workspace member', 403);
      a.require_resource('teamspace', get(body, 'teamspace_id', 'general'), 3);
      body.owner_id = a.member_id;
      if (has(body, 'permissions')) body.permissions = a.validate_permissions(body.permissions);
      return;
    }
    if (parts[0] === 'api' && parts[1] === 'databases' && parts.length >= 3) {
      const database = a.require_resource('database', parts[2], writing && parts.length === 3 ? 4 : 1);
      if (parts.length === 3 && writing) {
        require(!has(body, 'permissions') && !has(body, 'row_permissions'), 'Use the permissions endpoint');
        delete body.owner_id;
      }
      if (parts.length >= 4 && parts[3] === 'permissions') { if (writing) a.require_resource('database', parts[2], 4); return; }
      if (parts.length === 6 && parts[3] === 'rows' && parts[5] === 'duplicate' && method === 'POST') {
        require(a.can_create_row(database), 'Creating database rows is not allowed', 403);
        const row = a.require_resource('row', parts[4]);
        require(get(row, 'database_id') === database.id, 'Row not found', 404);
        return;
      }
      if (writing && parts.length >= 4 && parts[3] === 'rows') {
        if (parts.length === 4 && method === 'POST') {
          require(a.can_create_row(database), 'Creating database rows is not allowed', 403);
          body.owner_id = a.member_id;
        } else if (parts.length === 5) {
          const row = a.require_resource('row', parts[4], 3);
          require(get(row, 'database_id') === database.id, 'Row not found', 404);
          delete body.owner_id;
        }
        const old = parts.length === 5 ? this.store.get('row', parts[4]) : null;
        if (has(body, 'parent_row_id') && body.parent_row_id !== null) {
          const parent = a.require_resource('row', body.parent_row_id);
          require(get(parent, 'database_id') === database.id, 'Parent belongs to another database');
        } else if (has(body, 'parent_row_id') && old && truth(get(old, 'parent_row_id'))) {
          const parent = this.store.get('row', old.parent_row_id);
          if (parent && !a.can('row', parent)) body.parent_row_id = parent.id;
        }
        if (has(body, 'depends_on')) {
          require(Array.isArray(body.depends_on), 'Dependencies must be a list');
          for (const identity of body.depends_on) {
            const predecessor = a.require_resource('row', identity);
            require(get(predecessor, 'database_id') === database.id, 'Dependency belongs to another database');
          }
          if (old) {
            const hidden = get(old, 'depends_on', []).filter((id: unknown) => !a.can('row', this.store.get('row', id)));
            body.depends_on = Array.from(new Set([...body.depends_on, ...hidden]));
          }
        }
        this.relation_values(database, body, old);
      }
      return;
    }
    if (path === '/api/attachments' && method === 'POST') {
      require(a.regular || this.store.list('page').some(page => a.can('page', page, 3)), 'No document upload permission', 403);
      body.owner_id = a.member_id;
      return;
    }
    if (parts[0] === 'api' && parts[1] === 'uploads') {
      if (path === '/api/uploads/cleanup') a.require_admin(true);
      return; // FileStorage must check original page + upload actor on every operation.
    }
    if (parts[0] === 'api' && parts[1] === 'attachments' && [3, 4].includes(parts.length)) { this.attachment(parts[2], method === 'DELETE'); return; }
    if (parts.length >= 2 && parts[0] === 'api') {
      const kind = parts[1], identity = parts.length > 2 ? parts[2] : null;
      if (['members', 'groups'].includes(kind)) {
        if (kind === 'members' && writing) this.member_change(method, identity, body);
        else a.require_admin();
        return;
      }
      if (kind === 'teamspaces') {
        if (truth(identity)) { a.require_resource('teamspace', identity, writing ? 4 : 1); delete body.owner_id; }
        else if (writing) {
          require(a.regular, 'Teamspace creation requires a workspace member', 403);
          body.owner_id = a.member_id;
          require(Array.isArray(get(body, 'members', [])), 'Members must be a list');
          body.members = Array.from(new Set([a.member_id, ...get(body, 'members', [])]));
        }
        return;
      }
      if (['forms', 'automations', 'sites'].includes(kind)) {
        const item = truth(identity) ? this.owned(kind.slice(0, -1), identity) : body;
        if (kind === 'forms' && parts.length === 4 && parts[3] === 'submit' && method === 'POST') { require(get(item, 'published'), 'Form not found', 404); return; }
        if (identity === null && method === 'GET') return;
        const resource_kind = kind === 'sites' ? 'page' : 'database';
        const resource_id = kind === 'sites' ? get(item, 'page_id') : get(item, 'database_id', 'projects');
        a.require_resource(resource_kind, resource_id, 4);
        if (writing) {
          if (truth(get(body, 'page_id')) && kind === 'sites') a.require_resource('page', body.page_id, 4);
          if (truth(get(body, 'database_id')) && kind !== 'sites') this.manage_database(body.database_id);
          body.owner_id = truth(identity) ? get(item, 'owner_id', 'local') : a.member_id;
        }
        return;
      }
      if (kind === 'integrations') { a.require_admin(true); return; }
    }
    if ((path.startsWith('/forms/') || path.startsWith('/sites/')) && method === 'GET') return;
  }
  project(path: string, payload: any): any {
    const a = this.access;
    if (!is_object(payload)) return payload;
    let result = clone(payload);
    const row_projection = (row: Entity): Entity => {
      const database = this.store.get('database', get(row, 'database_id'));
      if (!a.can('row', row)) return {id: row.id, database_id: get(row, 'database_id'), access_level: 0};
      const filtered = a.filter_database({database, rows: [row]}).rows[0];
      filtered.access_level = a.level('row', row);
      return filtered;
    };
    if (is_object(get(result, 'properties')) && has(result, 'database_id') && has(result, 'id')) return row_projection(result);
    if (is_object(get(result, 'row'))) result.row = row_projection(result.row);
    if (path === '/api/workspace') {
      result = a.filter_workspace(result);
      for (const teamspace of get(result, 'teamspaces', [])) teamspace.access_level = a.level('teamspace', teamspace);
    }
    if (path === '/api/search') for (const key of ['results', 'pages']) if (has(result, key)) result[key] = result[key].filter((page: Entity) => a.can('page', page));
    const parts = path.replace(/^\/+|\/+$/g, '').split('/');
    if (path === '/api/advanced') {
      for (const [kind, key] of [['teamspace', 'teamspaces'], ['page', 'sites'], ['database', 'automations'], ['database', 'forms']]) {
        if (key === 'teamspaces') result[key] = get(result, key, []).filter((item: Entity) => a.can(kind, item));
        else {
          const target = kind === 'page' ? 'page_id' : 'database_id';
          result[key] = get(result, key, []).filter((item: Entity) => a.can(kind, this.store.get(kind, get(item, target)), 4));
        }
      }
      if (!a.owner) {
        result.audit = []; result.integrations = [];
        result.groups = get(result, 'groups', []).filter((group: Entity) => get(group, 'members', []).includes(a.member_id));
        result.members = a.filter_workspace({members: get(result, 'members', [])}).members;
      }
    }
    if (path === '/api/teamspaces') result.teamspaces = get(result, 'teamspaces', []).filter((item: Entity) => a.can('teamspace', item));
    if (parts.length === 2 && parts[0] === 'api' && ['forms', 'automations', 'sites'].includes(parts[1])) {
      const key = parts[1], kind = key === 'sites' ? 'page' : 'database', target = key === 'sites' ? 'page_id' : 'database_id';
      result[key] = get(result, key, []).filter((item: Entity) => a.can(kind, this.store.get(kind, get(item, target)), 4));
    }
    if (Array.isArray(get(result, 'rows')) && !has(result, 'database')) result.rows = result.rows.map(row_projection);
    if (has(result, 'database') && has(result, 'rows')) {
      result = a.filter_database(result);
      result.database.access_level = a.level('database', result.database);
      result.database.can_create_row = a.can_create_row(result.database);
      for (const row of result.rows) row.access_level = a.level('row', row);
    }
    if (path.startsWith('/api/forms/') && path.endsWith('/submit') && !a.owner) {
      const form = this.store.get('form', parts[2]);
      if (form && (!a.can('database', this.store.get('database', form.database_id)) || get(get(result, 'row', {}), 'access_level') === 0)) return {submitted: true, submission_id: get(get(result, 'submission', {}), 'id')};
    }
    for (const [key, kind] of [['pages', 'page'], ['databases', 'database']]) for (const item of get(result, key, [])) {
      if (!is_object(item)) continue; // Import responses contain IDs, not records.
      item.access_level = a.level(kind, item);
      if (!has(item, 'owner_id')) item.owner_id = 'local';
    }
    if (has(result, 'page') && is_object(result.page)) {
      result.page.access_level = a.level('page', result.page);
      if (!has(result.page, 'owner_id')) result.page.owner_id = 'local';
      if (has(result, 'versions') && !a.can('page', result.page, 3)) result.versions = [];
    }
    if (path.startsWith('/api/pages/') && has(result, 'id') && has(result, 'title')) {
      result.access_level = a.level('page', result);
      if (!has(result, 'owner_id')) result.owner_id = 'local';
    }
    if (path === '/api/pages' && has(result, 'id')) result.access_level = a.level('page', result);
    return result;
  }
}
