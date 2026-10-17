/** Revision-pinned, server-only Store kernel. No SQL, Auth token, or byte payload
 * reaches a browser through this module. Domain handlers must only stage changes:
 * MissingSelection/CAS retries re-execute them, so external effects belong AFTER
 * an acknowledged commit (or in an atomic domain receipt/queued intent).
 */
import {APIError, clone, get, has, is_object, truth, valid_id} from './access.ts';
import type {Entity, StoreReader} from './access.ts';
import {PAGE_HEADER_META_KEY, projectPageHeader, validatePageHeaders} from './page-headers.ts';
import {VERIFICATION_INDEX_META_KEY,validateVerificationIndex,projectVerificationDatabase,projectVerificationRow,verificationProjectionSignature,type VerificationIndex} from './verification-index.ts';

export type StoreContext = Readonly<{workspaceId: string; memberId: string; userId: string; authSessionId: string; sessionHash: string; cacheBinding: string}>;
export type Selection = {kinds?: string[]; ids?: Record<string, string[]>; metaKeys?: string[]; pageSize?: number};
export type NormalizedSelection = {kinds: string[]; ids: Record<string, string[]>; metaKeys: string[]; pageSize: number};
export type SnapshotRecord = {kind: string; id: string; data: Entity; createdAt: string; updatedAt: string};
export type SnapshotPage = {workspaceId: string; memberId: string; revision: number; accessRevision: number; principal: Entity; entities: SnapshotRecord[]; meta: Array<{key: string; value: any; present: boolean}>; nextCursor: unknown | null};
export type ContentOrigin = {member_id:string;cause:'human'|'automation'|'import'|'public_form'};
export type Change = {op: 'put'; kind: string; id: string; data: Entity; previousCreatedAt: string | null; origin?:ContentOrigin} | {op: 'delete'; kind: string; id: string} | {op: 'meta'; key: string; value: any} | {op:'activity_view';kind:'page';id:string;commandId:string};
type DataContext = Readonly<{workspaceId:string;memberId:string}>;
type KernelSnapshot<C> = {context:C;selection:NormalizedSelection;cursor?:unknown;expectedRevision?:number};
type KernelCommit<C> = {context:C;expectedRevision:number;transactionId:string;digest:string;canonical:string;changes:Change[]};
interface KernelProvider<C> {snapshot(request:KernelSnapshot<C>):Promise<SnapshotPage>;commit(request:KernelCommit<C>):Promise<{revision:number}>;}
export type SnapshotRequest = KernelSnapshot<StoreContext>;
export type CommitRequest = KernelCommit<StoreContext>;
export type AttachmentReferences={context:StoreContext;attachmentId:string;revision:number;referenced:boolean};
export interface StoreProvider extends KernelProvider<StoreContext> {attachmentReferences?(request:{context:StoreContext;attachmentId:string}):Promise<AttachmentReferences>;}
// Service authority is a separate wire contract. None of these are accepted by
// validateContext(), and control-only maintenance has no domain principal.
type GrantContext = Readonly<{workspaceId:string;grantId:string;grantVersion:number}>;
type LeaseContext = Readonly<{leaseId:string;generation:number;ticketHash:string}>;
export type AutomationContext = GrantContext & LeaseContext & Readonly<{kind:'automation';memberId:string;resourceId:string;runId:string}>;
export type ScimContext = GrantContext & Readonly<{kind:'scim';memberId:string;tokenHash:string}>;
export type MaintenanceContext = GrantContext & LeaseContext & Readonly<{kind:'maintenance';purpose:'backup-gc'|'upload-gc'}>;
export type ServiceDataContext = AutomationContext | ScimContext;
export type ServiceContext = ServiceDataContext | MaintenanceContext;
export type ServiceSnapshotRequest = KernelSnapshot<ServiceDataContext>;
export type ServiceCommitRequest = KernelCommit<ServiceDataContext>;
export interface ServiceProvider extends KernelProvider<ServiceDataContext> {}
export class StoreError extends APIError {
  code: string;
  constructor(status: number, code: string, message: string) { super(status, message); this.name = 'StoreError'; this.code = code; }
}
export class MissingSelection extends StoreError {
  selection: Selection;
  constructor(selection: Selection) { super(409, 'MISSING_SELECTION', 'Workspace snapshot requires additional data'); this.name = 'MissingSelection'; this.selection = freeze(clone(selection)); }
}
const enc = new TextEncoder();
const MAX_BYTES = 16 * 1024 * 1024, MAX_RPC_BYTES = 48 * 1024 * 1024 + 4096, MAX_SELECTION = 1000, MAX_CHANGES = 1000, MAX_LOADED = 64 * 1024 * 1024;
const FORBIDDEN_KINDS = new Set(['credential', 'session']);
const FORBIDDEN_META = new Set(['local_cache_binding', 'attachment_file_root', 'attachment_file_gc_cursor']);
const ADMIN_GENERATIONS_META_KEY = 'admin_member_generations_v1';
const ADMIN_GENERATION_PREFIX = '_admin_member_generation_v1:';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fail = (code = 'STORAGE_UNAVAILABLE', status = 503, message = 'Workspace storage is unavailable'): never => { throw new StoreError(status, code, message); };
function check(value: unknown, code = 'INVALID_STORE_INPUT', status = 400): asserts value { if (!value) fail(code, status, status === 400 ? 'Invalid workspace storage input' : 'Workspace storage response is invalid'); }
function kind(value: unknown): asserts value is string { check(typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) && !FORBIDDEN_KINDS.has(value), 'SELECTION_FORBIDDEN'); }
function metaKey(value: unknown): asserts value is string { check(typeof value === 'string' && value.length > 0 && Array.from(value).length <= 160 && !FORBIDDEN_META.has(value), 'SELECTION_FORBIDDEN'); }
function id(value: unknown): asserts value is string { check(valid_id(value)); }
function exact(value: unknown, keys: string[]): asserts value is Entity { check(is_object(value) && Object.keys(value).length === keys.length && keys.every(key => has(value, key)), 'STORAGE_RESPONSE_INVALID', 503); }
// PostgreSQL jsonb cannot represent NUL or unpaired UTF16 surrogates, in keys
// as well as values. Reject before a staged mutation can become uncertain.
function jsonString(value: string): void {
  check(!value.includes('\u0000') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
}
/** Reject values JSON.stringify would silently coerce/drop; bounded iterative walk. */
function json(value: unknown, limit = MAX_BYTES): string {
  const pending: Array<{value:unknown;exit?:boolean;depth:number}> = [{value,depth:0}], active = new Set<object>(); let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!, item = entry.value;
    if (entry.exit) { active.delete(item as object); continue; }
    check(++nodes <= 1_000_000 && entry.depth <= 128, 'STORAGE_LIMIT', 413);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      if (typeof item === 'string') jsonString(item);
      continue;
    }
    if (typeof item === 'number') { check(Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))); continue; }
    check(typeof item === 'object' && item !== null && (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null));
    check(!active.has(item)); active.add(item);
    pending.push({value:item,exit:true,depth:entry.depth});
    check(Object.getOwnPropertySymbols(item).length === 0);
    for (const key of Object.keys(item)) jsonString(key);
    if (Array.isArray(item)) check(Object.keys(item).length === item.length);
    for (const child of Object.values(item)) pending.push({value:child,depth:entry.depth+1});
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return fail('INVALID_STORE_INPUT', 400, 'Invalid workspace storage input'); }
  check(enc.encode(serialized).length <= limit, 'STORAGE_LIMIT', 413);
  return serialized;
}
// Compare Unicode scalar values like Python/UTF8-C collation, not JS UTF16 order.
function compare(a: string, b: string): number {
  const first = Array.from(a), second = Array.from(b);
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    const delta = first[index].codePointAt(0)! - second[index].codePointAt(0)!;
    if (delta) return delta;
  }
  return first.length - second.length;
}
export function canonicalJSON(value: unknown): string {
  json(value);
  const encode = (item: any): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    return '{' + Object.keys(item).sort(compare).map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
  };
  try { return encode(value); } catch { return fail('INVALID_STORE_INPUT', 400, 'Invalid workspace storage input'); }
}
function freeze<T>(value:T):T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child);Object.freeze(value); } return value;
}
export function validateContext(context: StoreContext): StoreContext {
  exact(context, ['workspaceId','memberId','userId','authSessionId','sessionHash','cacheBinding']);
  check(Object.values(context).every(value=>typeof value==='string') && valid_id(context.workspaceId) && valid_id(context.memberId) && UUID.test(context.userId) && UUID.test(context.authSessionId) && /^[a-f0-9]{64}$/.test(context.sessionHash) && /^[a-f0-9]{32}$/.test(context.cacheBinding));
  return Object.freeze(clone(context));
}
export function validateServiceContext(context:ServiceContext):ServiceContext {
  check(is_object(context));
  const common=['kind','workspaceId','grantId','grantVersion'];
  const lease=['leaseId','generation','ticketHash'];
  if(context.kind==='scim')exact(context,[...common,'memberId','tokenHash']);
  else if(context.kind==='automation')exact(context,[...common,...lease,'memberId','resourceId','runId']);
  else if(context.kind==='maintenance')exact(context,[...common,...lease,'purpose']);
  else check(false);
  check(valid_id(context.workspaceId)&&typeof context.grantId==='string'&&UUID.test(context.grantId)&&integer(context.grantVersion)&&context.grantVersion>0);
  if(context.kind==='scim')check(valid_id(context.memberId)&&typeof context.tokenHash==='string'&&/^[a-f0-9]{64}$/.test(context.tokenHash));
  else {
    check(typeof context.leaseId==='string'&&UUID.test(context.leaseId)&&integer(context.generation)&&context.generation>0&&typeof context.ticketHash==='string'&&/^[a-f0-9]{64}$/.test(context.ticketHash));
    if(context.kind==='automation')check(valid_id(context.memberId)&&valid_id(context.resourceId)&&typeof context.runId==='string'&&/^[a-f0-9]{64}$/.test(context.runId));
    else check(['backup-gc','upload-gc'].includes(context.purpose));
  }
  json(context);return Object.freeze(clone(context));
}
function dataServiceContext(context:ServiceDataContext):ServiceDataContext {
  const checked=validateServiceContext(context);
  check(checked.kind!=='maintenance','SERVICE_SCOPE_FORBIDDEN',403);return checked;
}
export function normalizeSelection(selection: Selection): NormalizedSelection {
  check(is_object(selection) && Object.keys(selection).every(key => ['kinds','ids','metaKeys','pageSize'].includes(key)));
  const kinds = get(selection, 'kinds', []), keys = get(selection, 'metaKeys', []), ids = get(selection, 'ids', {}), pageSize = get(selection, 'pageSize', 200);
  check(Array.isArray(kinds) && Array.isArray(keys) && is_object(ids) && integer(pageSize) && pageSize >= 1 && pageSize <= 500);
  check(kinds.length + keys.length + Object.keys(ids).length <= MAX_SELECTION,'STORAGE_LIMIT',413);
  kinds.forEach(kind); keys.forEach(metaKey);
  const full = Array.from(new Set(kinds)).sort(compare), normalized: Array<[string, string[]]> = [];
  let count = full.length + keys.length;
  for (const [key, values] of Object.entries(ids)) {
    kind(key); check(Array.isArray(values)); count += values.length;check(count<=MAX_SELECTION,'STORAGE_LIMIT',413);values.forEach(id);
    if (!full.includes(key)) normalized.push([key, Array.from(new Set(values)).sort(compare)]);
  }
  check(count <= MAX_SELECTION, 'STORAGE_LIMIT', 413);
  return {kinds: full, ids: Object.fromEntries(normalized.sort(([a],[b]) => compare(a,b))), metaKeys: Array.from(new Set(keys)).sort(compare), pageSize};
}
export function mergeSelection(first: Selection, second: Selection): NormalizedSelection {
  const a = normalizeSelection(first), b = normalizeSelection(second), ids = new Map<string,string[]>();
  for (const source of [a.ids,b.ids]) for (const [key, values] of Object.entries(source)) ids.set(key,[...(ids.get(key)||[]),...values]);
  return normalizeSelection({kinds:[...a.kinds,...b.kinds],ids:Object.fromEntries(ids),metaKeys:[...a.metaKeys,...b.metaKeys],pageSize:Math.max(a.pageSize,b.pageSize)});
}
function timestamp(clock: () => number): string {
  const now = clock(); check(integer(now) && now <= 253402300799999);
  return new Date(now).toISOString().replace(/(\.\d{3})Z$/, (_, fraction) => fraction + '000+00:00');
}

// Private reusable staging machinery; public factories validate distinct authorities.
class StagingKernel<C extends DataContext> implements StoreReader {
  readonly context: C;
  readonly selection: NormalizedSelection;
  readonly principal: Entity;
  readonly requestTime: string;
  private provider: KernelProvider<C>;
  private entities = new Map<string,Map<string,SnapshotRecord>>();
  private metadata = new Map<string,any>();
  private generatedIds = new Map<string,Set<string>>();
  private baseRevision: number;
  private currentRevision: number;
  private headerGeneration = 0;
  private changes: Change[] = [];
  private contentActor: ContentOrigin | null = null;
  private transactionDepth = 0;
  private phase: 'ready'|'pending'|'uncertain'|'committed'|'aborted' = 'ready';
  private commitRequest: KernelCommit<C> | null = null;
  private inflight: Promise<{revision:number}> | null = null;
  private idFactory: () => string;
  protected constructor(provider: KernelProvider<C>, context: C, selection: NormalizedSelection, page: SnapshotPage, options: {clock?:()=>number;idFactory?:()=>string}) {
    this.provider = provider; this.context = context; this.selection = freeze(clone(selection));
    this.principal = freeze(clone(page.principal)); this.baseRevision = page.revision; this.currentRevision = page.revision;
    this.metadata.set('access_revision',page.accessRevision); this.metadata.set('workspace_id',context.workspaceId);
    this.requestTime = timestamp(options.clock ?? Date.now);
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID().replaceAll('-',''));
  }
  protected static async load<C extends DataContext,T extends StagingKernel<C>>(provider:KernelProvider<C>,context:C,selection:Selection,build:(selection:NormalizedSelection,page:SnapshotPage)=>T):Promise<T> {
    const selected = normalizeSelection(selection);
    let store: T | null = null, cursor: unknown = undefined, pages = 0, bytes = 0;
    const cursors = new Set<string>(), records = new Set<string>(), metavalues = new Map<string,string>();
    do {
      let page: SnapshotPage;
      try { page = await provider.snapshot({context,selection:clone(selected),...(cursor === undefined ? {} : {cursor}),...(store ? {expectedRevision:store.baseRevision} : {})}); }
      catch (error) { if (error instanceof StoreError) throw error; return fail(); }
      try {
        exact(page,['workspaceId','memberId','revision','accessRevision','principal','entities','meta','nextCursor']);
        check(page.workspaceId === context.workspaceId && page.memberId === context.memberId && integer(page.revision) && integer(page.accessRevision) && is_object(page.principal) && page.principal.id === context.memberId && ['owner','admin','member','guest'].includes(page.principal.role) && get(page.principal,'active',true) === true, 'STORAGE_RESPONSE_INVALID',503);
        check(Array.isArray(page.entities) && page.entities.length <= selected.pageSize && Array.isArray(page.meta), 'STORAGE_RESPONSE_INVALID',503);
        bytes += enc.encode(json(page)).length;
        check(++pages <= 10000 && bytes <= MAX_LOADED, 'STORAGE_LIMIT',413);
        if (!store) store = build(selected,page);
        check(store.baseRevision === page.revision, 'REVISION_CONFLICT',409);
        check(canonicalJSON(page.principal) === canonicalJSON(store.principal) && page.accessRevision === store.metadata.get('access_revision'), 'STORAGE_RESPONSE_INVALID',503);
        for (const record of page.entities) {
          exact(record,['kind','id','data','createdAt','updatedAt']); kind(record.kind); id(record.id);
          check(selected.kinds.includes(record.kind) || get(selected.ids,record.kind,[]).includes(record.id), 'STORAGE_RESPONSE_INVALID',503);
          check(is_object(record.data) && record.data.id === record.id && typeof record.createdAt === 'string' && typeof record.updatedAt === 'string' && record.data.created_at === record.createdAt && record.data.updated_at === record.updatedAt, 'STORAGE_RESPONSE_INVALID',503);
          check(record.kind !== 'attachment' || !has(record.data,'data'), 'STORAGE_RESPONSE_INVALID',503);
          const key = canonicalJSON([record.kind,record.id]); check(!records.has(key),'STORAGE_RESPONSE_INVALID',503); records.add(key);
          if (!store.entities.has(record.kind)) store.entities.set(record.kind,new Map());
          store.entities.get(record.kind)!.set(record.id,clone(record));
        }
        check(page.meta.length === selected.metaKeys.length, 'STORAGE_RESPONSE_INVALID',503);
        const seenMeta = new Set<string>();
        for (const item of page.meta) {
          exact(item,['key','value','present']); metaKey(item.key);
          check(typeof item.present === 'boolean','STORAGE_RESPONSE_INVALID',503);
          check(selected.metaKeys.includes(item.key) && !seenMeta.has(item.key),'STORAGE_RESPONSE_INVALID',503); seenMeta.add(item.key);
          const metaCanonical=canonicalJSON(item);
          if(metavalues.has(item.key))check(metavalues.get(item.key)===metaCanonical,'STORAGE_RESPONSE_INVALID',503);
          metavalues.set(item.key,metaCanonical);
          if (item.present) {
            if (store.metadata.has(item.key)) check(canonicalJSON(store.metadata.get(item.key)) === canonicalJSON(item.value),'STORAGE_RESPONSE_INVALID',503);
            store.metadata.set(item.key,clone(item.value));
          }
        }
        cursor = page.nextCursor;
        if (cursor !== null) { const key=canonicalJSON(cursor);check(!cursors.has(key),'STORAGE_RESPONSE_INVALID',503);cursors.add(key); }
      } catch (error) { if (error instanceof StoreError && error.status !== 400) throw error; return fail('STORAGE_RESPONSE_INVALID',503,'Workspace storage response is invalid'); }
    } while (cursor !== null);
    return store!;
  }
  get revision(): number { this.readable(); return this.currentRevision; }
  get state(): string { return this.phase; }
  private readable(): void { if (['pending','uncertain','aborted'].includes(this.phase)) fail('STORE_NOT_READABLE',409,'Workspace commit must be resolved before further reads'); }
  private writable(): void { this.readable(); if (this.phase !== 'ready') fail('STORE_CLOSED',409,'Workspace transaction is already committed'); }
  get(kindName: string, identity: unknown): Entity | null {
    this.readable(); if (!valid_id(identity)) return null; kind(kindName);
    if (!this.selection.kinds.includes(kindName) && !get(this.selection.ids,kindName,[]).includes(identity) && !this.generatedIds.get(kindName)?.has(identity)) throw new MissingSelection({ids:{[kindName]:[identity]}});
    return clone(this.entities.get(kindName)?.get(identity)?.data ?? null);
  }
  list(kindName: string): Entity[] {
    this.readable(); kind(kindName);
    if (!this.selection.kinds.includes(kindName)) throw new MissingSelection({kinds:[kindName]});
    return Array.from(this.entities.get(kindName)?.values() ?? []).sort((a,b) => compare(a.createdAt,b.createdAt) || compare(a.id,b.id)).map(record=>clone(record.data));
  }
  meta(key: string, fallback: any = null): any {
    this.readable(); metaKey(key);
    if (key === '_entity_revision') return this.currentRevision;
    if (key.startsWith(ADMIN_GENERATION_PREFIX) && this.selection.metaKeys.includes(ADMIN_GENERATIONS_META_KEY)) {
      const generations = this.admin_member_generations();
      return has(generations, key) ? clone(generations[key]) : clone(fallback);
    }
    if (!['workspace_id','access_revision'].includes(key) && !this.selection.metaKeys.includes(key)) throw new MissingSelection({metaKeys:[key]});
    if (key === PAGE_HEADER_META_KEY) {
      // Always derive from the pinned virtual snapshot and CURRENT staging log.
      // Rollback truncates that log, including an alternate branch at the same revision.
      const pages = new Map(validatePageHeaders(this.metadata.get(key)).map(page=>[page.id,page]));
      for (const change of this.changes) {
        if (change.op === 'put' && change.kind === 'page') pages.set(change.id,projectPageHeader(change.data));
        else if (change.op === 'delete' && change.kind === 'page') pages.delete(change.id);
      }
      return Array.from(pages.values()).sort((a,b)=>compare(a.id,b.id)).map(clone);
    }
    if (key === VERIFICATION_INDEX_META_KEY) {
      const base=validateVerificationIndex(this.metadata.get(key));
      const databases=new Map(base.databases.map(db=>[db.id,db])),rows=new Map(base.rows.map(row=>[row.id,row]));
      for(const change of this.changes){
        if(change.op==='meta')continue;
        if(change.kind==='database'){
          const previous=databases.get(change.id),next=change.op==='put'?projectVerificationDatabase(change.data):null;
          // A new/reconfigured projection may require absent row columns. No raw fallback.
          if(next&&(!previous||verificationProjectionSignature(previous)!==verificationProjectionSignature(next)))fail('STORAGE_RESPONSE_INVALID',503,'Workspace database verification index requires a fresh snapshot');
          if(next)databases.set(change.id,next);else {databases.delete(change.id);for(const [id,row] of rows)if(row.database_id===change.id)rows.delete(id);}
        }else if(change.kind==='row'){
          rows.delete(change.id);if(change.op==='put'){const db=databases.get(change.data.database_id);if(db){const projected=projectVerificationRow(change.data,db);if(projected)rows.set(change.id,projected);}}
        }
      }
      return {databases:Array.from(databases.values()).sort((a,b)=>compare(a.id,b.id)).map(clone),rows:Array.from(rows.values()).sort((a,b)=>compare(a.id,b.id)).map(clone)};
    }
    return this.metadata.has(key) ? clone(this.metadata.get(key)) : clone(fallback);
  }
  get page_header_generation(): number { this.readable(); return this.headerGeneration; }
  page_headers(): Entity[] { return this.meta(PAGE_HEADER_META_KEY); }
  admin_member_generations(): Entity {
    const value = this.meta(ADMIN_GENERATIONS_META_KEY);
    check(is_object(value) && Object.keys(value).every(key => /^_admin_member_generation_v1:[a-f0-9]{64}$/.test(key)), 'STORAGE_RESPONSE_INVALID', 503);
    const result = clone(value);
    for (const change of this.changes) {
      if (change.op === 'meta' && change.key.startsWith(ADMIN_GENERATION_PREFIX)) result[change.key] = clone(change.value);
    }
    return result;
  }
  get database_verification_generation():number { this.readable();return this.headerGeneration; }
  database_verification_rows():VerificationIndex { return this.meta(VERIFICATION_INDEX_META_KEY); }
  private stage(change: Change): void {
    check(this.changes.length < MAX_CHANGES && this.currentRevision < Number.MAX_SAFE_INTEGER,'STORAGE_LIMIT',413);
    const next = [...this.changes,change]; json({context:this.context,expectedRevision:this.baseRevision,changes:next});
    this.changes.push(clone(change)); this.currentRevision++; this.headerGeneration++;
  }
  /** Reserve an ID before related entities are staged, without widening a
   * snapshot for a newly generated value on every handler replay. The database
   * still checks previousCreatedAt=null, so an unseen collision cannot replace
   * an existing entity. Reservations roll back with staged transactions. */
  allocate_id(kindName: string): string {
    this.writable(); kind(kindName);
    for (let attempt=0;attempt<16;attempt++) {
      const identity=this.idFactory();id(identity);jsonString(identity);check(identity.trim().length>0);
      if(this.generatedIds.get(kindName)?.has(identity)||this.entities.get(kindName)?.has(identity))continue;
      if(!this.generatedIds.has(kindName))this.generatedIds.set(kindName,new Set());
      this.generatedIds.get(kindName)!.add(identity);return identity;
    }
    return fail('ID_ALLOCATION_FAILED',503,'A unique workspace identifier is unavailable');
  }
  /** Trusted server scope, separate from submitted entity fields and RPC Auth.
   * Only automation may attribute a write to another verified active author. */
  with_content_actor<T>(origin:ContentOrigin,action:()=>T):T {
    this.writable();check(is_object(origin)&&Object.keys(origin).length===2&&has(origin,'member_id')&&has(origin,'cause')&&valid_id(origin.member_id)&&['human','automation','import','public_form'].includes(origin.cause));
    jsonString(origin.member_id);
    const member=origin.member_id===this.context.memberId?this.principal:this.get('member',origin.member_id);
    check(member&&get(member,'active',true)===true&&['owner','admin','member','guest'].includes(member.role),'INVALID_CONTENT_ACTOR',403);
    check(origin.cause==='automation'?member.role!=='guest':origin.member_id===this.context.memberId,'INVALID_CONTENT_ACTOR',403);
    const previous=this.contentActor;this.contentActor=freeze(clone(origin));
    try {
      const value=action();
      if(value&&typeof (value as any).then==='function'){
        this.phase='aborted';void Promise.resolve(value).catch(()=>{});
        return fail('ASYNC_TRANSACTION_FORBIDDEN',400,'Content actor scopes must be synchronous');
      }
      return value;
    } finally { this.contentActor=previous; }
  }
  put(kindName: string, data: Entity): Entity {
    this.writable(); kind(kindName); check(is_object(data),'INVALID_STORE_INPUT'); json(data);
    const value = clone(data), generated = !truth(get(value,'id')), identity = generated ? this.allocate_id(kindName) : value.id;
    check(valid_id(identity) && identity.trim().length > 0);
    const previous = generated ? clone(this.entities.get(kindName)?.get(identity)?.data ?? null) : this.get(kindName,identity);
    value.id=identity;value.created_at=previous ? get(previous,'created_at',this.requestTime) : this.requestTime;value.updated_at=this.requestTime;
    check(kindName !== 'attachment' || !has(value,'data'),'SELECTION_FORBIDDEN');
    const origin=this.contentActor&&['page','database','row','site','form'].includes(kindName)?{origin:clone(this.contentActor)}:{};
    this.stage({op:'put',kind:kindName,id:identity,data:value,previousCreatedAt:previous ? previous.created_at : null,...origin});
    if (!this.entities.has(kindName)) this.entities.set(kindName,new Map());
    if(generated){if(!this.generatedIds.has(kindName))this.generatedIds.set(kindName,new Set());this.generatedIds.get(kindName)!.add(identity);}
    this.entities.get(kindName)!.set(identity,{kind:kindName,id:identity,data:clone(value),createdAt:value.created_at,updatedAt:value.updated_at});
    return clone(value);
  }
  delete(kindName: string, identity: unknown): void {
    this.writable(); kind(kindName); if (typeof identity !== 'string') return;
    if (!this.get(kindName,identity)) return;
    this.stage({op:'delete',kind:kindName,id:identity}); this.entities.get(kindName)!.delete(identity);
  }
  set_meta(key: string, value: any): any {
    this.writable(); metaKey(key); check(!['_entity_revision','_backup_storage_reserved',PAGE_HEADER_META_KEY,VERIFICATION_INDEX_META_KEY,ADMIN_GENERATIONS_META_KEY].includes(key) && (key !== 'workspace_id' || value === this.context.workspaceId),'SELECTION_FORBIDDEN');
    json(value); this.meta(key); this.stage({op:'meta',key,value:clone(value)});this.metadata.set(key,clone(value));return clone(value);
  }
  audit(action:string, details:Entity, user:string=this.context.memberId):Entity {
    return this.put('audit',{action,details,user});
  }
  /** A trusted route stages an explicit open with its authorized source snapshot.
   * The database resolves generation/digest after the same fresh Auth/CAS fence.
   */
  record_activity_view(kindName:'page',identity:string,commandId?:string):void {
    this.writable();validateContext(this.context);check(kindName==='page'&&valid_id(identity));
    check(this.get('page',identity)!==null,'ACTIVITY_SOURCE_CHANGED',409);
    const command=commandId??crypto.randomUUID().replaceAll('-','');
    check(typeof command==='string'&&/^[a-f0-9]{32}$/.test(command),'INVALID_STORE_INPUT');
    this.stage({op:'activity_view',kind:'page',id:identity,commandId:command});
  }
  transaction<T>(action: (store: this) => T): T {
    this.writable(); const entities=clone(this.entities), metadata=clone(this.metadata), generatedIds=clone(this.generatedIds), count=this.changes.length, revision=this.currentRevision;
    this.transactionDepth++;
    try {
      const result=action(this);
      if(result && typeof (result as any).then === 'function'){
        this.phase='aborted';void Promise.resolve(result).catch(()=>{});
        return fail('ASYNC_TRANSACTION_FORBIDDEN',400,'Staged transactions must be synchronous');
      }
      return result;
    }
    catch (error) { this.entities=entities;this.metadata=metadata;this.generatedIds=generatedIds;this.changes.length=count;this.currentRevision=revision;this.headerGeneration++;throw error; }
    finally { this.transactionDepth--; }
  }
  async commit(): Promise<{revision:number}> {
    if (this.inflight) return this.inflight;
    if (this.phase === 'committed') return {revision:this.currentRevision};
    if (this.phase === 'aborted' || this.transactionDepth) return fail('STORE_CLOSED',409,'Workspace transaction cannot be committed');
    const wasUncertain=this.phase==='uncertain';
    this.phase='pending';
    const run = async () => {
      try {
        if (!this.commitRequest) {
          const changes=clone(this.changes), canonical=canonicalJSON({context:this.context,expectedRevision:this.baseRevision,changes});
          const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(canonical))),byte=>byte.toString(16).padStart(2,'0')).join('');
          this.commitRequest={context:this.context,expectedRevision:this.baseRevision,transactionId:crypto.randomUUID(),digest,canonical,changes};
        }
        const result=await this.provider.commit(clone(this.commitRequest));
        exact(result,['revision']);check(integer(result.revision) && result.revision === this.currentRevision,'STORAGE_RESPONSE_INVALID',503);
        this.phase='committed';return {revision:result.revision};
      } catch (error) {
        if (error instanceof StoreError && error.status>=400&&error.status<500&&![408,429].includes(error.status)&&(!wasUncertain||['REVISION_CONFLICT','COMMIT_ID_REUSED'].includes(error.code))) { this.phase='aborted';throw error; }
        this.phase='uncertain';
        if (error instanceof StoreError) throw error;
        return fail('COMMIT_UNCERTAIN',503,'Workspace commit acknowledgement is unavailable; retry this transaction');
      } finally { this.inflight=null; }
    };
    this.inflight=run();return this.inflight;
  }
}

type StoreOptions = {clock?:()=>number;idFactory?:()=>string};
export class CloudStore extends StagingKernel<StoreContext> {
  private constructor(provider:StoreProvider,context:StoreContext,selection:NormalizedSelection,page:SnapshotPage,options:StoreOptions){super(provider,context,selection,page,options);}
  static async open(provider:StoreProvider,context:StoreContext,selection:Selection,options:StoreOptions={}):Promise<CloudStore>{
    context=validateContext(context);return this.load(provider,context,selection,(selected,page)=>new CloudStore(provider,context,selected,page,options));
  }
}
export class ServiceStore extends StagingKernel<ServiceDataContext> {
  private constructor(provider:ServiceProvider,context:ServiceDataContext,selection:NormalizedSelection,page:SnapshotPage,options:StoreOptions){super(provider,context,selection,page,options);}
  static async open(provider:ServiceProvider,context:ServiceDataContext,selection:Selection,options:StoreOptions={}):Promise<ServiceStore>{
    context=dataServiceContext(context);return this.load(provider,context,selection,(selected,page)=>new ServiceStore(provider,context,selected,page,options));
  }
}

/** Dependency-free PostgREST RPC transport. The secret stays in this closure. */
type ProviderConfig = {supabaseUrl:string;serviceKey:string;fetch?:typeof globalThis.fetch;timeoutMs?:number};
function rpcTransport(config:ProviderConfig,prefix:'store'|'service') {
  let origin: string;
  try {
    const url=new URL(config.supabaseUrl);
    check((url.protocol==='https:' || url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)) && !url.username && !url.password && !url.search && !url.hash && url.pathname==='/');origin=url.origin;
    check(typeof config.serviceKey==='string' && config.serviceKey.length<=4096 && !/[\r\n\x00]/.test(config.serviceKey));
  } catch { return fail(); }
  const headers: Record<string,string>={apikey:config.serviceKey,'Content-Type':'application/json'};
  if (config.serviceKey.startsWith('sb_secret_')) check(/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(config.serviceKey));
  else {
    try { const parts=config.serviceKey.split('.');check(parts.length===3 && parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)));check(JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-parts[1].length%4)%4))).role==='service_role');headers.Authorization='Bearer '+config.serviceKey; }
    catch { return fail(); }
  }
  const timeout=config.timeoutMs ?? 8000;check(integer(timeout) && timeout>0 && timeout<=15000);
  const request=config.fetch ?? globalThis.fetch;
  async function rpc(name:string, body:Entity,responseLimit=MAX_BYTES): Promise<any> {
    check(integer(responseLimit)&&responseLimit>0&&responseLimit<=MAX_BYTES);
    try {
      const response=await request(origin+'/rest/v1/rpc/fountain_cloud_'+prefix+'_'+name,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeout),headers:{...headers},body:json(body,MAX_RPC_BYTES)});
      if (!response.ok || response.redirected) {
        let conflict='';
        if(response.status===409&&response.body){
          const reader=response.body.getReader();let length=0,body='';const decoder=new TextDecoder();
          try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>4096)break;body+=decoder.decode(part.value,{stream:true});}
            if(length<=4096){const error=JSON.parse(body+decoder.decode());if(error?.code==='PT409'&&['REVISION_CONFLICT','COMMIT_ID_REUSED','LAST_OWNER_ACCOUNT'].includes(error.message))conflict=error.message;}
          }catch{/* Untrusted diagnostics are never propagated. */}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        }else await response.body?.cancel();
        if (response.status===401 || response.status===403) return fail('AUTH_REQUIRED',401,'Authentication required');
        if(response.status===409){
          if(conflict==='LAST_OWNER_ACCOUNT')return fail(conflict,409,'Cannot remove or deactivate the last active owner account');
          return fail(conflict||'STORAGE_CONFLICT',409,'Workspace changed; reload and authorize again');
        }
        if (response.status===413) return fail('STORAGE_LIMIT',413,'Workspace selection exceeds the storage limit');
        return fail();
      }
      const reader=response.body?.getReader();check(reader,'STORAGE_RESPONSE_INVALID',503);
      const parts:Uint8Array[]=[];let size=0;
      try {
        for (;;) { const next=await reader.read();if(next.done)break;size+=next.value.length;check(size<=responseLimit,'STORAGE_LIMIT',413);parts.push(next.value); }
        const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
        return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      } catch (error) { await reader.cancel().catch(()=>{});throw error; }
      finally { reader.releaseLock(); }
    } catch (error) { if (error instanceof StoreError) throw error;return fail(); }
  }
  return rpc;
}
// Match Python str.strip and SQL blank_chars; FEFF remains an opaque ID character.
export function validAttachmentReferenceId(value:unknown):value is string{return valid_id(value)&&!/[\u0000\uD800-\uDFFF]/u.test(value)&&!/^[\u0009-\u000D\u001C-\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/u.test(value);}
/** One bounded metadata fact, never a document body or authorization grant. */
export function validateAttachmentReferences(value:unknown,context:StoreContext,attachmentId:string):AttachmentReferences{
  try{
    exact(value,['context','attachmentId','revision','referenced']);
    check(canonicalJSON(validateContext(value.context))===canonicalJSON(context)&&value.attachmentId===attachmentId&&validAttachmentReferenceId(value.attachmentId)&&integer(value.revision)&&typeof value.referenced==='boolean','STORAGE_RESPONSE_INVALID',503);
    return freeze(clone(value)) as AttachmentReferences;
  }catch{return fail('STORAGE_RESPONSE_INVALID',503,'Attachment reference response is invalid');}
}
export function createStoreProvider(config:ProviderConfig):StoreProvider {
  const rpc=rpcTransport(config,'store');
  return Object.freeze({
    attachmentReferences:async(request:{context:StoreContext;attachmentId:string})=>{const context=validateContext(request.context);check(validAttachmentReferenceId(request.attachmentId));return validateAttachmentReferences(await rpc('attachment_references',{p_context:context,p_attachment_id:request.attachmentId},4096),context,request.attachmentId);},
    snapshot: (request:SnapshotRequest) => rpc('snapshot',{p_context:request.context,p_selection:request.selection,p_cursor:request.cursor ?? null,p_expected_revision:request.expectedRevision ?? null}),
    commit: (request:CommitRequest) => rpc('commit',{p_context:request.context,p_expected_revision:request.expectedRevision,p_transaction_id:request.transactionId,p_digest:request.digest,p_canonical:request.canonical,p_changes:request.changes}),
  });
}
export function createServiceProvider(config:ProviderConfig):ServiceProvider {
  const rpc=rpcTransport(config,'service');
  return Object.freeze({
    snapshot:async(request:ServiceSnapshotRequest)=>rpc('snapshot',{p_context:dataServiceContext(request.context),p_selection:request.selection,p_cursor:request.cursor??null,p_expected_revision:request.expectedRevision??null}),
    commit:async(request:ServiceCommitRequest)=>rpc('commit',{p_context:dataServiceContext(request.context),p_expected_revision:request.expectedRevision,p_transaction_id:request.transactionId,p_digest:request.digest,p_canonical:request.canonical,p_changes:request.changes}),
  });
}
