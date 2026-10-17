/** Offline mutation replay. Each operation owns a fresh transaction and receipt;
 * no batch-wide transaction, provider token or private receipt digest is returned. */
import { Access, APIError, clone, get, has, is_object, require, truth } from './access.ts';
import type { Entity } from './access.ts';
import type { AuthContext } from './auth.ts';
import { AuthError } from './auth.ts';
import { CloudStore, canonicalJSON } from './store.ts';
import type { StoreProvider } from './store.ts';
import { createTransactions } from './transaction.ts';
import { TaskGraph } from './tasks.ts';
import { seed_state } from './crdt.ts';
import { IncrementalSHA256 } from './storage.ts';

export type SyncContext = { access: Access; workspace_id: string; session_binding: string };
export type SyncDispatch = (store: CloudStore, method: string, path: string, body: Entity) => { status: number; payload: any };
type Config = { provider: StoreProvider; authorize: () => Promise<AuthContext>; dispatch: SyncDispatch; clock?: () => number };
const KINDS = new Set(['page.create', 'page.patch', 'row.create', 'row.patch', 'row.delete']);
const PAGE_FIELDS = new Set(['title', 'icon', 'cover', 'favorite']);
const ROW_FIELDS = new Set(['parent_row_id', 'depends_on']);
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/;
const encoder = new TextEncoder();

export class BindingError extends APIError { constructor(status: number, message: string) { super(status, message); this.name = 'BindingError'; } }
function sha256(value: string): string { const hash = new IncrementalSHA256(); hash.update(encoder.encode(value)); return hash.hex(); }
function compare(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let index = 0; index < Math.min(x.length, y.length); index++) { const delta = x[index].codePointAt(0)! - y[index].codePointAt(0)!; if (delta) return delta; }
  return x.length - y.length;
}
/** Python JSON float exponent spelling for noninteger values. Parsed JSON loses
 * lexical 1 vs 1.0; a legacy digest ambiguity deliberately conflicts, never replays. */
function number(value: number): string {
  if (Object.is(value, -0)) return '-0.0';
  if (Number.isInteger(value)) return String(value);
  if (value !== 0 && (Math.abs(value) < 1e-4 || Math.abs(value) >= 1e16)) {
    const [mantissa, exponent] = value.toExponential().split('e'), sign = Number(exponent) < 0 ? '-' : '+';
    return mantissa + 'e' + sign + String(Math.abs(Number(exponent))).padStart(2, '0');
  }
  return JSON.stringify(value);
}
export function canonicalSyncJSON(value: unknown): string {
  // Also enforces JSONB-safe Unicode/safe integers and bounded depth/size
  // before private digest construction. HTTP callers supply parsed JSON only.
  try { canonicalJSON(value); }
  catch { throw new APIError(400, 'Sync operation contains invalid JSON'); }
  const encode = (item: any): string => {
    if (typeof item === 'number') return number(item);
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    return '{' + Object.keys(item).sort(compare).map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
  };
  return encode(value);
}
function equal(a: any, b: any): boolean {
  if (a === b || ['number', 'boolean'].includes(typeof a) && ['number', 'boolean'].includes(typeof b) && Number(a) === Number(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  return is_object(a) && is_object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => has(b, key) && equal(a[key], b[key]));
}
export class SyncService {
  readonly store: CloudStore;
  constructor(store: CloudStore) { this.store = store; }
  static _id(value: any): string { require(typeof value === 'string' && value !== '.' && value !== '..' && value.match(IDENTIFIER)?.[0] === value, 'Invalid sync identifier'); return value; }
  static _resource_id(value: any): string {
    require(typeof value === 'string' && Array.from(value).length > 0 && Array.from(value).length <= 160 && value.trim() && !['.', '..'].includes(value) && !/[\/\\\x00-\x1f\x7f-\x9f]/u.test(value), 'Invalid sync resource identifier');
    for (const char of value) require(!/[\uD800-\uDFFF]/u.test(char), 'Invalid Unicode resource identifier');
    return value;
  }
  static receipt_id(actorId: string, operationId: string): string { return sha256(JSON.stringify([actorId, operationId])); }
  static _digest(operation: unknown): string { return sha256(canonicalSyncJSON(operation)); }
  static validateRequest(body: unknown): asserts body is Entity {
    require(is_object(body) && Object.keys(body).every(key => ['workspace_id', 'session_binding', 'operations'].includes(key)), 'Invalid sync request');
    require(typeof body.workspace_id === 'string' && typeof body.session_binding === 'string', 'Sync requires workspace and session bindings');
    require(Array.isArray(body.operations) && body.operations.length <= 50, 'Send at most 50 offline mutations');
  }
  _receipt(actorId: string, operationId: string, workspaceId: string): Entity | null {
    const receipt = this.store.get('sync_receipt', SyncService.receipt_id(actorId, operationId));
    return receipt && receipt.actor_id === actorId && receipt.workspace_id === workspaceId ? receipt : null;
  }
  static context(body: Entity, context: SyncContext, expectedActor?: string): SyncContext {
    const access = context.access;
    if (!access?.active) throw new BindingError(401, 'Authentication required');
    if (context.workspace_id !== body.workspace_id) throw new BindingError(409, 'Workspace changed; preserve your offline changes');
    if (context.session_binding !== body.session_binding) throw new BindingError(403, 'Login changed; preserve changes under their original session');
    if (expectedActor !== undefined && access.member_id !== expectedActor) throw new BindingError(403, 'Offline changes belong to another member');
    return context;
  }
  _validate(operation: any): string {
    require(is_object(operation), 'Sync operation must be an object');
    require(Object.keys(operation).every(key => ['id', 'kind', 'target_id', 'database_id', 'depends_on', 'body', 'base', 'document_epoch', 'base_rows'].includes(key)), 'Unsupported sync operation fields');
    SyncService._id(get(operation, 'id')); SyncService._resource_id(get(operation, 'target_id'));
    const kind = get(operation, 'kind'); require(typeof kind === 'string' && KINDS.has(kind), 'Unsupported sync operation kind');
    if (kind.startsWith('row.')) SyncService._resource_id(get(operation, 'database_id'));
    const dependencies = get(operation, 'depends_on', []);
    require(Array.isArray(dependencies) && dependencies.length <= 50, 'Invalid sync dependencies');
    for (const id of dependencies) { SyncService._id(id); require(id !== operation.id, 'Operation cannot depend on itself'); }
    require(is_object(get(operation, 'body', {})), 'Sync mutation body must be an object');
    require(is_object(get(operation, 'base', {})), 'Sync base must be an object');
    return SyncService._digest(operation);
  }
  private call(dispatch: SyncDispatch, method: string, path: string, body: Entity): any {
    const { status, payload } = dispatch(this.store, method, path, clone(body));
    require(status >= 200 && status < 300, 'Resource mutation was rejected', status); return payload;
  }
  static _compare(touched: Entity, base: unknown, current: Entity, label: string): void {
    require(is_object(base) && Object.keys(touched).every(key => has(base, key)), 'Missing ' + label + ' base values');
    for (const key of Object.keys(touched)) require(equal(get(current, key), base[key]), label + ' changed while offline', 409);
  }
  static _schema(properties: any, base: Entity, database: Entity): void {
    const schema = get(base, 'schema', {}); require(is_object(properties) && is_object(schema), 'Invalid property schema base');
    const current = new Map(get(database, 'properties', []).map((property: Entity) => [property.id, property]));
    for (const key of Object.keys(properties)) {
      require(has(schema, key) && is_object(schema[key]), 'Missing touched property schema');
      const prop=current.get(key);
      require(current.has(key)&&(get(prop,'type')==='owner'?['type','generation','limit','default','initial_default'].every(field=>equal(get(prop,field),get(schema[key],field))):equal(prop,schema[key])),'Property schema changed while offline',409);
      require(!['formula', 'rollup','verification'].includes(get(current.get(key), 'type')), 'Computed properties cannot be assigned');
    }
  }
  private deleteBase(operation: Entity, access: Access, workspaceId: string): void {
    const rows = new TaskGraph(this.store).descendants(operation.database_id, operation.target_id);
    require(rows.every(row => access.can('row', row, 3)), 'Cannot delete unreadable or uneditable subitems', 403);
    const bases = get(operation, 'base_rows'); require(is_object(bases) && truth(bases), 'Offline deletion requires the complete subtree base');
    Object.keys(bases).forEach(SyncService._resource_id);
    require(equal(Object.keys(bases).sort(compare), rows.map(row => row.id).sort(compare)), 'Task subtree changed while offline', 409);
    for (const row of rows) {
      const base = bases[row.id]; require(is_object(base) && Object.keys(base).every(key => ['updated_at', 'after_operation'].includes(key)) && typeof get(base, 'updated_at') === 'string', 'Invalid subtree base');
      let expected = base.updated_at;
      if (truth(get(base, 'after_operation'))) {
        const id = SyncService._id(base.after_operation), receipt = this._receipt(access.member_id, id, workspaceId), previous = get(receipt, 'result', {});
        require(receipt !== null && ['row.create', 'row.patch'].includes(get(receipt, 'kind')) && get(receipt, 'database_id') === operation.database_id && previous.status === 'applied' && previous.resource_id === row.id && typeof previous.updated_at === 'string', 'Own preceding operation receipt is unavailable', 409);
        expected = previous.updated_at;
      }
      require(get(row, 'updated_at') === expected, 'Subitem changed while offline', 409);
    }
  }
  _execute(operation: Entity, context: SyncContext, dispatch: SyncDispatch): Entity {
    const kind = operation.kind, target = operation.target_id, body = clone(get(operation, 'body', {})), base = get(operation, 'base', {}), access = context.access;
    if (kind === 'page.create') {
      require(Object.keys(body).every(key => ['id', 'title', 'icon', 'cover', 'parent_id', 'teamspace_id', 'permissions'].includes(key)), 'Unsupported offline page creation fields');
      require(get(body, 'id', target) === target, 'Page id does not match sync target');
      const epoch = get(operation, 'document_epoch');
      const normalizedEpoch = typeof epoch === 'string' ? epoch.replaceAll('urn:', '').replaceAll('uuid:', '').replace(/^[{}]+|[{}]+$/g, '').replaceAll('-', '') : '';
      require(normalizedEpoch.length === 32 && /^[a-f0-9]{32}$/i.test(normalizedEpoch), 'Page creation requires a document epoch UUID');
      require(this.store.get('page', target) === null, 'Page id already exists', 409);
      this.call(dispatch, 'POST', '/api/pages', { ...body, id: target });
      const created = this.store.get('page', target); require(created !== null && !truth(get(created, 'blocks')), 'Offline page must be created empty', 409);
      this.store.put('collaboration', { id: target, epoch, seq: 0, state: seed_state([]) });
    } else if (kind === 'page.patch') {
      require(truth(body) && Object.keys(body).every(key => PAGE_FIELDS.has(key)), 'Unsupported offline page fields');
      const page = access.require_resource('page', target, 3);
      require(!truth(get(page, 'locked')) && !truth(get(page, 'archived')), 'Page is locked or archived', 423);
      SyncService._compare(body, get(base, 'fields'), page, 'Page metadata'); this.call(dispatch, 'PATCH', '/api/pages/' + target, body);
    } else {
      const detail = this.call(dispatch, 'GET', '/api/databases/' + operation.database_id, {});
      require(is_object(detail) && is_object(detail.database) && Array.isArray(detail.rows), 'Invalid database projection', 500);
      const database = detail.database, databaseId = operation.database_id;
      if (kind === 'row.create') {
        require(Object.keys(body).every(key => ['id', 'properties', ...ROW_FIELDS].includes(key)), 'Unsupported offline row creation fields');
        require(get(body, 'id', target) === target, 'Row id does not match sync target');
        require(this.store.get('row', target) === null, 'Row id already exists', 409);
        SyncService._schema(get(body, 'properties', {}), base, database);
        this.call(dispatch, 'POST', '/api/databases/' + databaseId + '/rows', { ...body, id: target });
        require(this.store.get('row', target) !== null, 'Row creation did not preserve its client id', 409);
      } else {
        const raw = access.require_resource('row', target, 3); require(get(raw, 'database_id') === databaseId, 'Row not found', 404);
        const visible = detail.rows.find((row: Entity) => get(row, 'id') === target && get(row, 'access_level', 1) > 0); require(visible, 'Row not found', 404);
        if (kind === 'row.patch') {
          require(truth(body) && Object.keys(body).every(key => ['properties', ...ROW_FIELDS].includes(key)), 'Unsupported offline row fields');
          const properties = get(body, 'properties', {}); SyncService._schema(properties, base, database);
          SyncService._compare(properties, get(base, 'properties', {}), get(visible, 'properties', {}), 'Row properties');
          const fields = Object.fromEntries(Object.entries(body).filter(([key]) => ROW_FIELDS.has(key)));
          SyncService._compare(fields, get(base, 'fields', {}), { parent_row_id: get(visible, 'parent_row_id'), depends_on: get(visible, 'depends_on', []) }, 'Task links');
          this.call(dispatch, 'PATCH', '/api/databases/' + databaseId + '/rows/' + target, body);
        } else {
          require(!truth(body), 'Offline row deletion body must be empty'); this.deleteBase(operation, access, context.workspace_id);
          this.call(dispatch, 'DELETE', '/api/databases/' + databaseId + '/rows/' + target, {});
        }
      }
    }
    const resource = this.store.get(kind.startsWith('page.') ? 'page' : 'row', target);
    const result: Entity = { id: operation.id, status: 'applied', http_status: kind.endsWith('create') ? 201 : 200, resource_id: target, data_revision: this.store.meta('_entity_revision', 0) };
    if (resource) for (const key of ['updated_at', 'revision']) if (has(resource, key)) result[key] = resource[key];
    return result;
  }
  static failure(id: any, error: APIError): Entity {
    const status = [409, 410, 423].includes(error.status) ? 'conflict' : [401, 403, 404].includes(error.status) ? 'denied' : error.status >= 500 || error.status === 425 ? 'deferred' : 'invalid';
    return { id, status, http_status: error.status, error: error.message };
  }
  applyOperation(body: Entity, operation: any, context: SyncContext, dispatch: SyncDispatch, processed = new Map<string, Entity>(), expectedActor = context.access.member_id): Entity {
    SyncService.context(body, context, expectedActor);
    require(is_object(operation), 'Sync operation must be an object'); SyncService._id(get(operation, 'id'));
    const actor = context.access.member_id, workspace = context.workspace_id, receipt = this._receipt(actor, operation.id, workspace);
    if (receipt) { require(receipt.digest === SyncService._digest(operation), 'Operation id was reused with different content', 409); return clone(receipt.result); }
    const digest = this._validate(operation);
    for (const dependency of get(operation, 'depends_on', [])) {
      const prior = processed.has(dependency) ? processed.get(dependency) : get(this._receipt(actor, dependency, workspace), 'result');
      require(prior && prior.status === 'applied', 'A preceding offline operation has not been applied', 425);
    }
    const result = this._execute(operation, context, dispatch);
    this.store.put('sync_receipt', { id: SyncService.receipt_id(actor, operation.id), actor_id: actor, workspace_id: workspace, operation_id: operation.id, kind: operation.kind, database_id: get(operation, 'database_id'), digest, result });
    return result;
  }
}

export function createSync(config: Config) {
  const execute = createTransactions(config);
  return async function apply(body: unknown, initial: AuthContext): Promise<Entity> {
    SyncService.validateRequest(body);
    const first = await execute(initial, store => SyncService.context(body, { access: new Access(store, store.principal), workspace_id: store.context.workspaceId, session_binding: store.context.cacheBinding }));
    const actor = first.value.access.member_id, workspace = first.value.workspace_id, processed = new Map<string, Entity>(), results: Entity[] = [];
    for (const operation of body.operations) {
      const id = is_object(operation) && typeof get(operation, 'id') === 'string' ? operation.id : null;
      let result: Entity;
      try {
        const accepted = await execute(initial, store => new SyncService(store).applyOperation(body, operation, { access: new Access(store, store.principal), workspace_id: store.context.workspaceId, session_binding: store.context.cacheBinding }, config.dispatch, processed, actor));
        result = accepted.value;
      } catch (error) {
        if (error instanceof BindingError || error instanceof AuthError || error instanceof APIError && error.status === 401) throw error;
        if (!(error instanceof APIError)) throw error;
        result = SyncService.failure(id, error);
      }
      results.push(result); if (id !== null) processed.set(id, result);
    }
    const final = await execute(initial, store => { SyncService.context(body, { access: new Access(store, store.principal), workspace_id: store.context.workspaceId, session_binding: store.context.cacheBinding }, actor); return store.meta('_entity_revision', 0); });
    return { workspace_id: workspace, current_member_id: actor, session_binding: first.value.session_binding, data_revision: final.value, results };
  };
}
