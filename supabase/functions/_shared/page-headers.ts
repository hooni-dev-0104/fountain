/** Private, body-free page topology for server-side ACL and wiki evaluation. */
import {APIError, clone, has, is_object, valid_id} from './access.ts';
import type {Entity, StoreReader} from './access.ts';

export const PAGE_HEADER_META_KEY = 'wiki_page_headers_v1';
export const PAGE_HEADER_FIELDS = Object.freeze(['id','title','icon','parent_id','teamspace_id','owner_id','permissions','archived','deleted','deleted_at','locked','revision','is_wiki','verification','created_at','updated_at']);
const fields = new Set<string>(PAGE_HEADER_FIELDS);
const adapted = Symbol('pageHeaderReader');
const invalid = (): never => { throw new APIError(503, 'Workspace page headers are unavailable'); };
/** Preserve absence and JSON null, including dictionary keys such as __proto__. */
export function projectPageHeader(page: Entity): Entity {
  if (!is_object(page) || !has(page,'id') || !valid_id(page.id)) return invalid();
  return Object.fromEntries(PAGE_HEADER_FIELDS.filter(key=>has(page,key)).map(key=>[key,clone(page[key])]));
}
/** The reserved snapshot is trusted only after complete shape validation. */
export function validatePageHeaders(value: unknown): Entity[] {
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  return value.map(page=>{
    if (!is_object(page) || !has(page,'id') || !valid_id(page.id) || ids.has(page.id) || Object.keys(page).some(key=>!fields.has(key))) return invalid();
    ids.add(page.id); return projectPageHeader(page);
  });
}
/** This adapter deliberately exposes no mutation methods. Cache only within
 * this Store, using a monotonic staging generation that also advances on
 * rollback; entity revisions alone can repeat on alternate transaction branches. */
export function pageHeaderReader(store: StoreReader): StoreReader {
  if ((store as any)[adapted] === true) return store;
  const source = store as StoreReader & {page_headers?:()=>Entity[];readonly page_header_generation?:number};
  let cachedGeneration: number|undefined, cached: Map<string,Entity>|null = null;
  const headers = (): Map<string,Entity> => {
    const before=source.page_header_generation;
    const stable=Number.isSafeInteger(before) && (before as number)>=0 && typeof source.page_headers === 'function';
    if (stable && cached && cachedGeneration===before) return cached;
    const pages=typeof source.page_headers === 'function'
      ? validatePageHeaders(source.page_headers())
      : source.list('page').map(projectPageHeader);
    const result=new Map(pages.map(page=>[page.id,page]));
    if (stable && source.page_header_generation===before) { cachedGeneration=before;cached=result; }
    return result;
  };
  return Object.freeze({
    [adapted]:true,
    get(kind: string, identity: unknown): Entity|null {
      if (kind !== 'page') return store.get(kind,identity);
      if (!valid_id(identity)) { void source.page_header_generation;return null; }
      return clone(headers().get(identity) ?? null);
    },
    list(kind: string): Entity[] { return kind === 'page' ? Array.from(headers().values(),clone) : store.list(kind); },
    meta(key: string, fallback: unknown = null): any { return store.meta(key,fallback); },
  });
}
