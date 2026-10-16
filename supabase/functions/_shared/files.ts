/** Resumable file domain. SQL changes use acknowledged CloudStore transactions;
 * object I/O is always outside them. Upload intents pin a chunk digest BEFORE
 * publication so concurrent different bytes cannot multiply private orphans.
 * All stored checkpoints/manifests are server state, never accepted from a body.
 */
import {Access,APIError,clone,get,is_object,require,truth,valid_id} from './access.ts';
import type {Entity} from './access.ts';
import {Authorization} from './authorization.ts';
import {AuthError} from './auth.ts';
import type {AuthContext} from './auth.ts';
import {CloudStore,MissingSelection,StoreError,canonicalJSON,mergeSelection} from './store.ts';
import type {Selection,StoreProvider} from './store.ts';
import {createTransactions,storeContext} from './transaction.ts';
import {createStorage,StorageError,checkQuota,CHUNK_SIZE,MAX_FILE_SIZE} from './storage.ts';
import type {ChunkManifest,AttachmentManifest} from './storage.ts';
import {jsonResponse,readBytes,readJSON} from './http.ts';
type Config={provider:StoreProvider;storage:ReturnType<typeof createStorage>;authorize:()=>Promise<AuthContext>;clock?:()=>number;quotaBytes?:number;verifyChunks?:number};
const TTL=86400_000,HASH=/^[a-f0-9]{64}$/;
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
async function hash(data:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function fileName(v:unknown):string {require(typeof v==='string'&&v.length>0&&Array.from(v).length<=255&&!/[\x00-\x1f\x7f/\\]/.test(v)&&!['.','..'].includes(v),'Invalid filename');require(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v),'Invalid Unicode filename');return v;}
function inlineBytes(value:unknown):Uint8Array {
  require(typeof value==='string'&&value.length<=7_000_000&&value.length%4===0,'Invalid base64 attachment');
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,end=value.length-padding;
  // Match the native transport's linear alphabet/padding scan. Repeated regex
  // groups exhaust V8's stack on valid multi-megabyte base64 input.
  for(let index=0;index<end;index++){
    const code=value.charCodeAt(index);
    require(code>=65&&code<=90||code>=97&&code<=122||code>=48&&code<=57||code===43||code===47,'Invalid base64 attachment');
  }
  const length=value.length/4*3-padding;require(length<=5_000_000,'Attachment exceeds 5 MB',413);
  let binary:string;try{binary=atob(value);}catch{throw new APIError(400,'Invalid base64 attachment');}
  const bytes=new Uint8Array(length);for(let index=0;index<length;index++)bytes[index]=binary.charCodeAt(index);return bytes;
}
function publicAttachment(item:Entity):Entity {return Object.fromEntries(['id','owner_id','page_id','name','size','mime','storage','sha256','created_at','updated_at'].filter(k=>Object.hasOwn(item,k)).map(k=>[k,clone(item[k])]));}
function publicUpload(item:Entity,attachment?:Entity|null):Entity {const value=Object.fromEntries(['id','owner_id','page_id','name','size','offset','chunk_size','expires_at','completed'].map(k=>[k,item[k]??null]));if(item.completed&&attachment)value.attachment=publicAttachment(attachment);return value;}
function sourceFingerprint(item:Entity):string {return canonicalJSON(Object.fromEntries(['id','owner_id','page_id','name','size','mime','storage','sha256','created_at','updated_at'].map(k=>[k,item[k]??null])));}
function manifest(item:Entity):AttachmentManifest {require(Array.isArray(item.cloud_chunks),'Attachment bytes need a verified migration',503);return {id:item.storage_id??item.id,name:item.name,size:item.size,...(item.sha256?{sha256:item.sha256}:{}),chunks:clone(item.cloud_chunks)};}

export function createFiles(config:Config){
  const execute=createTransactions(config),now=config.clock??Date.now,quota=config.quotaBytes??1_000_000_000,verifyChunks=config.verifyChunks??4;
  require(integer(quota)&&quota>0&&integer(verifyChunks)&&verifyChunks>=1&&verifyChunks<=4,'Invalid file storage configuration',500);
  // Read gates have no commit/receipt side effects. A fresh snapshot RPC itself
  // validates current vault/Auth session/member; missing ACL selection is retried.
  async function view<T>(initial:AuthContext,action:(s:CloudStore,a:Access)=>T,selection:Selection={},pinned?:{selection:Selection}):Promise<T>{
    const original=canonicalJSON(storeContext(initial));let selected=mergeSelection({kinds:['group']},pinned?.selection??selection);
    for(let round=0;round<64;round++){
      // A byte stream's initial Auth context has already passed native /user.
      // Every snapshot RPC STILL checks current vault, auth.sessions, mapping,
      // member and revision. Cache selection shape only, never authorization facts.
      const active=pinned?initial:await config.authorize();if(active.expiresAt<=now()||canonicalJSON(storeContext(active))!==original)throw new AuthError(401,'AUTH_REQUIRED','로그인 세션이 변경되었습니다.');
      let s:CloudStore;try{s=await CloudStore.open(config.provider,storeContext(active),selected,{clock:now});}catch(error){if(error instanceof StoreError&&error.code==='REVISION_CONFLICT')continue;throw error;}
      try{const value=action(s,new Access(s,s.principal));if(pinned)pinned.selection=selected;return value;}catch(error){if(!(error instanceof MissingSelection))throw error;selected=mergeSelection(selected,error.selection);}
    }throw new StoreError(503,'SELECTION_LIMIT','첨부 권한 확인 범위를 초과했습니다.');
  }
  function currentGate(initial:AuthContext,action:(s:CloudStore,a:Access)=>void):()=>Promise<void>{const pinned={selection:{} as Selection};return ()=>view(initial,action,{},pinned);}
  function checkUpload(s:CloudStore,a:Access,item:Entity,cleaning=false):void {
    require(a.active,'Authentication required',401);require(item.owner_id===a.member_id||cleaning&&a.owner,'Upload not found',404);
    if(cleaning&&a.owner||item.migration&&a.owner)return;
    if(!a.regular&&!item.page_id)require(item.legacy_inline&&s.list('page').some(page=>a.can('page',page,3)),'Guests must upload to an editable page',403);
    if(item.page_id){const page=s.get('page',item.page_id);require(page,'Upload page not found',404);require(!truth(get(page,'archived'))&&!truth(get(page,'locked')),'Upload page is locked or archived',423);require(a.can('page',page,3),'Upload page is no longer editable',403);}
  }
  function load(s:CloudStore,a:Access,id:string,cleaning=false):Entity {
    require(valid_id(id),'Invalid upload id');const item=s.get('upload',id);require(item,'Upload not found',404);checkUpload(s,a,item,cleaning);require(Number.isFinite(Date.parse(item.expires_at))&&Date.parse(item.expires_at)>now(),'Upload expired; start a new upload',410);require(integer(item.size)&&item.size<=MAX_FILE_SIZE&&integer(item.offset)&&item.offset<=item.size&&typeof item.completed==='boolean','Upload metadata is invalid',409);if(!item.completed)require(Array.isArray(item.cloud_chunks),'Upload bytes need a verified migration',409);return item;
  }
  function completed(s:CloudStore,item:Entity):Entity|null {
    const target=item.migration_target??item.id,original=s.get('attachment',target);if(!original)return null;
    const overlay=s.get('attachment_cloud',target);if(overlay){require(overlay.source_fingerprint===sourceFingerprint(original),'Original attachment changed during migration',409);return overlay;}
    if(item.migration)require(false,'Completed migration was removed',410);
    return original;
  }
  function quotaState(s:CloudStore,excluding?:string):{limitBytes:number;usedBytes:number;reservedBytes:number}{
    let usedBytes=0,reservedBytes=0;
    for(const item of s.list('attachment')){require(integer(item.size),'Invalid attachment quota metadata',409);usedBytes+=item.size;}
    for(const item of s.list('upload'))if(item.id!==excluding&&!item.completed&&!item.migration){require(integer(item.size),'Invalid upload quota metadata',409);reservedBytes+=item.size;}
    for(const item of s.list('upload_gc')){require(integer(item.reserved_bytes),'Invalid upload cleanup metadata',409);reservedBytes+=item.reserved_bytes;}
    const backupReserved=s.meta('_backup_storage_reserved',0);require(integer(backupReserved),'Invalid backup quota metadata',409);reservedBytes+=backupReserved;
    require(integer(usedBytes)&&integer(reservedBytes),'Invalid file quota totals',409);return {limitBytes:quota,usedBytes,reservedBytes};
  }
  async function begin(initial:AuthContext,body:unknown,legacyInline=false):Promise<Entity>{
    require(is_object(body),'Upload metadata must be an object');const name=fileName(body.name),size=body.size;require(integer(size)&&size<=MAX_FILE_SIZE,'Invalid file size',413);if(body.page_id!=null)require(valid_id(body.page_id),'Invalid page id');
    return (await execute(initial,s=>{
      const a=new Access(s,s.principal);checkQuota(size,quotaState(s));
      const item={id:s.allocate_id('upload'),owner_id:a.member_id,page_id:body.page_id??null,name,size,offset:0,chunk_size:CHUNK_SIZE,expires_at:new Date(now()+TTL).toISOString(),completed:false,cloud_chunks:[],pending:null,verify_checkpoint:null,...(legacyInline?{legacy_inline:true}:{})};
      checkUpload(s,a,item);return publicUpload(s.put('upload',item));
    })).value;
  }
  async function status(initial:AuthContext,id:string):Promise<Entity>{return view(initial,(s,a)=>{const item=load(s,a,id);return publicUpload(item,item.completed?completed(s,item):null);});}
  async function append(initial:AuthContext,id:string,offset:number,input:Uint8Array):Promise<Entity>{
    require(integer(offset)&&input instanceof Uint8Array&&input.length>0&&input.length<=CHUNK_SIZE,'Invalid chunk');const data=new Uint8Array(input),sha256=await hash(data),intent={offset,size:data.length,sha256},attemptId=crypto.randomUUID();
    const matches=(pending:Entity|null)=>!!pending&&pending.offset===intent.offset&&pending.size===intent.size&&pending.sha256===intent.sha256&&typeof pending.attempt_id==='string'&&/^[a-f0-9-]{36}$/.test(pending.attempt_id);
    const state=(await execute(initial,s=>{
      const item=load(s,new Access(s,s.principal),id);require(!item.completed,'Upload is already complete',409);require(offset<=item.offset,'Chunk would create a gap',409);require(offset%CHUNK_SIZE===0&&offset<item.size&&data.length===Math.min(CHUNK_SIZE,item.size-offset),'Incorrect chunk boundary or length');
      if(offset<item.offset){const stored=item.cloud_chunks.find((c:ChunkManifest)=>c.offset===offset);require(stored&&stored.size===data.length&&stored.sha256===sha256,'Retry chunk differs from the stored bytes',409);return {retry:true,publisher:false,chunk:stored,attempt:null};}
      if(item.pending){require(matches(item.pending),'Chunk publication is already reserved for different bytes',409);return {retry:false,publisher:false,chunk:null,attempt:item.pending.attempt_id};}
      s.put('upload',{...item,pending:{...intent,attempt_id:attemptId}});
      // Only the invocation which durably created this intent owns ONE POST.
      // Existing intents never authorize a replacement POST, even after timeout.
      return {retry:false,publisher:true,chunk:null,attempt:attemptId};
    })).value;
    const access=currentGate(initial,(s,a)=>{const item=load(s,a,id);require(!item.completed||state.retry,'Upload is already complete',409);require(item.offset>=offset&&(item.offset>offset||matches(item.pending)&&item.pending.attempt_id===state.attempt),'Upload changed during publication',409);});
    if(state.retry){await config.storage.readChunk(state.chunk!,access);return status(initial,id);}
    const expected:ChunkManifest={version:1,attachmentId:id,...intent};let published:ChunkManifest;
    if(state.publisher)published=await config.storage.writeChunk(id,offset,data,access);
    else{
      // An old worker may still publish. Only exact readback can settle its
      // attempt; absence is uncertainty, NOT permission to reuse its POST token.
      try{await config.storage.readChunk(expected,access);published=expected;}
      catch(error){if(error instanceof StorageError&&error.code==='STORAGE_BYTES_MISSING')throw new APIError(503,'Chunk publication is unresolved; verification must be retried');throw error;}
    }
    return (await execute(initial,s=>{
      const item=load(s,new Access(s,s.principal),id);
      if(item.offset>offset){const prior=item.cloud_chunks.find((c:ChunkManifest)=>c.offset===offset);require(prior&&canonicalJSON(prior)===canonicalJSON(published),'Upload changed during publication',409);return publicUpload(item);}
      require(!item.completed&&item.offset===offset&&matches(item.pending)&&item.pending.attempt_id===state.attempt,'Upload changed during publication',409);
      item.offset+=data.length;item.cloud_chunks.push(published);item.pending=null;item.verify_checkpoint=null;return publicUpload(s.put('upload',item));
    })).value;
  }
  async function complete(initial:AuthContext,id:string):Promise<Entity>{
    const starting=await view(initial,(s,a)=>{const item=load(s,a,id);if(item.completed){const file=completed(s,item);require(file,'Completed attachment was removed',410);return {done:file,upload:item};}require(item.offset===item.size&&!item.pending,'Upload is not complete',409);return {done:null,upload:item};});
    if(starting.done)return publicAttachment(starting.done);
    const upload=starting.upload,layout=canonicalJSON([upload.size,upload.cloud_chunks]);
    const access=currentGate(initial,(s,a)=>{const current=load(s,a,id);require(current.offset===current.size&&canonicalJSON([current.size,current.cloud_chunks])===layout,'Upload layout changed',409);});
    const result=await config.storage.verify({id,name:upload.name,size:upload.size,chunks:upload.cloud_chunks},access,{checkpoint:upload.verify_checkpoint??undefined,maxChunks:verifyChunks});
    return (await execute(initial,s=>{
      const item=load(s,new Access(s,s.principal),id);if(item.completed){const file=completed(s,item);require(file,'Completed attachment was removed',410);return publicAttachment(file);}
      require(item.offset===item.size&&!item.pending&&canonicalJSON([item.size,item.cloud_chunks])===layout,'Upload layout changed',409);
      if(!result.completed){if(!item.verify_checkpoint||item.verify_checkpoint.offset<result.verifiedOffset)s.put('upload',{...item,verify_checkpoint:result.checkpoint});return {...publicUpload(item),verification_pending:true,verified_offset:result.verifiedOffset};}
      let file:Entity;
      if(item.migration){const original=s.get('attachment',item.migration_target);require(original&&sourceFingerprint(original)===item.source_fingerprint,'Original attachment changed during migration',409);if(original.sha256)require(original.sha256===result.sha256,'Migration bytes differ from the original SHA',409);file=s.put('attachment_cloud',{...publicAttachment(original),id:item.migration_target,storage_id:id,storage:'chunks',sha256:result.sha256,cloud_chunks:item.cloud_chunks,source_fingerprint:item.source_fingerprint});}
      else file=s.put('attachment',{id,owner_id:item.owner_id,page_id:item.page_id,name:item.name,size:item.size,mime:'application/octet-stream',storage:'chunks',sha256:result.sha256,cloud_chunks:item.cloud_chunks});
      s.put('upload',{...item,completed:true,verify_checkpoint:result.checkpoint});s.audit('upload.completed',{attachment_id:file.id,size:item.size});return publicAttachment(file);
    })).value;
  }
  function retire(s:CloudStore,item:Entity):void {
    const chunks:ChunkManifest[]=clone(item.cloud_chunks??[]);
    // Keep an unresolved publication separate from confirmed manifests. Deleting
    // a missing path cannot fence an HTTP POST which is still in flight.
    if(chunks.length||item.pending)s.put('upload_gc',{id:item.id,owner_id:item.owner_id,page_id:item.page_id,reserved_bytes:item.size,cloud_chunks:chunks,pending:clone(item.pending??null),reason:'upload_cancelled'});
    s.delete('upload',item.id);
  }
  function gcUnreferenced(s:CloudStore,id:string):boolean{return !s.get('upload',id)&&!s.list('attachment_cloud').some(file=>file.storage_id===id||file.id===id)&&!s.get('attachment',id)?.cloud_chunks;}
  async function garbageCollect(initial:AuthContext,id:string):Promise<Entity>{
    const starting=await view(initial,(s,a)=>{const item=s.get('upload_gc',id);if(!item)return null;require(a.owner||item.owner_id===a.member_id,'Upload cleanup not found',404);require(gcUnreferenced(s,id),'Attachment is still referenced',409);return item;});
    if(!starting)return {id,removed:true};
    if(starting.pending){
      const pending=starting.pending,claim=canonicalJSON(pending);require(typeof pending.attempt_id==='string'&&/^[a-f0-9-]{36}$/.test(pending.attempt_id),'Invalid publication quarantine',409);
      const chunk:ChunkManifest={version:1,attachmentId:id,offset:pending.offset,size:pending.size,sha256:pending.sha256};
      const access=currentGate(initial,(s,a)=>{const item=s.get('upload_gc',id);require(item&&(a.owner||item.owner_id===a.member_id),'Upload cleanup not found',404);require(gcUnreferenced(s,id)&&canonicalJSON(item.pending??null)===claim,'Upload cleanup changed',409);});
      try{await config.storage.readChunk(chunk,access);}
      catch(error){if(error instanceof StorageError&&error.code==='STORAGE_BYTES_MISSING')return {id,removed:false,publication_pending:true};throw error;}
      // A verified object proves the single POST has published. Record that
      // evidence BEFORE deletion; lost DELETE ACKs can then retry safely.
      await execute(initial,s=>{const item=s.get('upload_gc',id);if(!item)return;const a=new Access(s,s.principal);require(a.owner||item.owner_id===a.member_id,'Upload cleanup not found',404);require(gcUnreferenced(s,id),'Attachment is still referenced',409);if(!item.pending)return;require(canonicalJSON(item.pending)===claim,'Upload cleanup changed',409);require(!item.cloud_chunks.some((prior:ChunkManifest)=>prior.offset===chunk.offset),'Duplicate cleanup chunk',409);item.cloud_chunks.push(chunk);item.pending=null;s.put('upload_gc',item);});
      return garbageCollect(initial,id);
    }
    const batch=starting.cloud_chunks.slice(0,100),fingerprint=canonicalJSON(starting.cloud_chunks);
    require(batch.length>0,'Invalid empty cleanup claim',409);
    const unreferenced=()=>view(initial,(s,a)=>{const item=s.get('upload_gc',id);require(item&&(a.owner||item.owner_id===a.member_id),'Upload cleanup not found',404);return !item.pending&&gcUnreferenced(s,id)&&canonicalJSON(item.cloud_chunks)===fingerprint;});
    await config.storage.removeChunks(batch,async()=>{require(await unreferenced(),'Attachment is still referenced',409);},unreferenced);
    return (await execute(initial,s=>{const item=s.get('upload_gc',id);if(!item)return {id,removed:true};const a=new Access(s,s.principal);require(a.owner||item.owner_id===a.member_id,'Upload cleanup not found',404);require(!item.pending&&gcUnreferenced(s,id)&&canonicalJSON(item.cloud_chunks)===fingerprint,'Upload cleanup changed',409);item.cloud_chunks.splice(0,batch.length);if(!item.cloud_chunks.length){s.delete('upload_gc',id);return {id,removed:true};}s.put('upload_gc',item);return {id,removed:false};})).value;
  }
  async function cancel(initial:AuthContext,id:string):Promise<Entity>{
    const result=(await execute(initial,s=>{const item=load(s,new Access(s,s.principal),id,true);const exists=s.get('attachment',id);if(item.completed||exists&&!item.migration)return {id,cancelled:false,completed:true};retire(s,item);s.audit('upload.cancelled',{upload_id:id});return {id,cancelled:true,completed:false};})).value;
    if(result.cancelled){try{const gc=await garbageCollect(initial,id);if(!gc.removed)result.cleanup_pending=true;}catch(error){if(error instanceof AuthError||error instanceof APIError&&[401,403].includes(error.status))throw error;result.cleanup_pending=true;}}return result;
  }
  async function remove(initial:AuthContext,id:string):Promise<Entity>{
    const result=(await execute(initial,s=>{
      const a=new Access(s,s.principal),original=new Authorization(a).attachment(id,true),file=resolve(s,a,id);
      require(!s.list('page').concat(s.list('version')).some(page=>(get(page,'blocks',[]) as Entity[]).some(block=>get(block,'attachment_id')===id)),'Attachment is still referenced by a document',409);
      for(const row of s.list('row')){const database=s.get('database',row.database_id)??{},fields=(get(database,'properties',[]) as Entity[]).filter(prop=>prop.type==='files');require(!fields.some(prop=>{const value=get(get(row,'properties',{}),prop.id,[]);return (Array.isArray(value)||typeof value==='string')&&value.includes(id);}),'Attachment is still referenced by a database row',409);}
      const physical=file.storage_id??id,chunks=clone(file.cloud_chunks??[]);
      // A legacy source remains on disk/inline backups; this only retires cloud
      // references after an explicit authorized DELETE, never during migration.
      if(chunks.length)s.put('upload_gc',{id:physical,owner_id:original.owner_id,page_id:original.page_id??null,reserved_bytes:original.size,cloud_chunks:chunks,reason:'attachment_deleted'});
      s.delete('attachment',id);s.delete('attachment_cloud',id);s.delete('upload_migration',id);
      const upload=s.get('upload',physical);if(upload)s.delete('upload',physical);
      return {deleted:true,gc:chunks.length?physical:null};
    })).value;
    let cleanup_pending=false;if(result.gc){try{cleanup_pending=!(await garbageCollect(initial,result.gc)).removed;}catch(error){if(error instanceof AuthError||error instanceof APIError&&[401,403].includes(error.status))throw error;cleanup_pending=true;}}
    return {deleted:true,...(cleanup_pending?{cleanup_pending:true}:{})};
  }
  async function cleanup(initial:AuthContext):Promise<Entity>{
    const cursorKey='upload_gc_cursor:'+await hash(new TextEncoder().encode(initial.profile.member.id));
    const position=(item:Entity)=>({created_at:item.created_at as string,id:item.id as string});
    const compare=(a:{created_at:string;id:string},b:{created_at:string;id:string})=>a.created_at===b.created_at?(a.id===b.id?0:a.id<b.id?-1:1):a.created_at<b.created_at?-1:1;
    const validPosition=(value:unknown)=>is_object(value)&&Object.keys(value).length===2&&typeof value.created_at==='string'&&value.created_at.length<=64&&Number.isFinite(Date.parse(value.created_at))&&valid_id(value.id);
    const result=(await execute(initial,s=>{
      const a=new Access(s,s.principal);a.require_admin(true);let removed=0;
      for(const item of s.list('upload'))if(!Number.isFinite(Date.parse(item.expires_at))||Date.parse(item.expires_at)<=now()){if(!item.completed)retire(s,item);else s.delete('upload',item.id);removed++;}
      const queue=s.list('upload_gc').sort((a,b)=>compare(position(a),position(b))),cursor=s.meta(cursorKey,null);
      require(cursor===null||is_object(cursor)&&Object.keys(cursor).length===2&&validPosition(cursor.after)&&validPosition(cursor.through)&&compare(cursor.after,cursor.through)<=0,'Invalid upload cleanup cursor',409);
      // Fix a round's upper bound so newly appended records cannot indefinitely
      // postpone revisiting old unknown attempts. Removed cursor rows are safe:
      // ordering uses the persisted position, never a mutable numeric index.
      let through=cursor?.through??(queue.length?position(queue[queue.length-1]):null),eligible=cursor?queue.filter(item=>compare(position(item),cursor.after)>0&&compare(position(item),through)<=0):queue;
      if(!eligible.length&&queue.length){through=position(queue[queue.length-1]);eligible=queue;}
      const batch=eligible.slice(0,4),next=batch.length&&eligible.length>batch.length?{after:position(batch[batch.length-1]),through}:null;
      if(cursor!==null||next!==null)s.set_meta(cursorKey,next);
      // Reserve/advance the batch in this acknowledged CAS before object I/O.
      // Failed or uncertain attempts retain all their private state and quota.
      return {removed,pending:batch.map(item=>item.id)};
    })).value;
    let cleanup_pending=0;for(const id of result.pending){try{if(!(await garbageCollect(initial,id)).removed)cleanup_pending++;}catch(error){if(error instanceof AuthError||error instanceof APIError&&[401,403].includes(error.status))throw error;cleanup_pending++;}}
    return {removed:result.removed,cleanup_pending};
  }
  function resolve(s:CloudStore,a:Access,id:string):Entity {
    const original=new Authorization(a).attachment(id),overlay=s.get('attachment_cloud',id);
    if(overlay){require(overlay.source_fingerprint===sourceFingerprint(original),'Original attachment changed after migration',409);return overlay;}return original;
  }
  async function metadata(initial:AuthContext,id:string):Promise<Entity>{return view(initial,(s,a)=>{const file=resolve(s,a,id);require(integer(file.size)&&file.size<=MAX_FILE_SIZE,'Attachment metadata is invalid',409);const result:Entity={id:file.id,name:fileName(file.name),size:file.size,mime:file.mime??'application/octet-stream',storage:file.storage??'inline',status:'complete'};require(typeof result.mime==='string'&&result.mime.length>0&&result.mime.length<=255&&['inline','chunks'].includes(result.storage),'Attachment metadata is invalid',409);if(file.sha256){require(HASH.test(file.sha256),'Attachment metadata is invalid',409);result.sha256=file.sha256;}return result;});}
  async function download(initial:AuthContext,id:string,request:Request):Promise<Response>{
    const file=await view(initial,(s,a)=>resolve(s,a,id)),pinned=canonicalJSON([file.id,file.size,file.sha256??null,file.cloud_chunks??null]);
    const access=currentGate(initial,(s,a)=>{const current=resolve(s,a,id);require(canonicalJSON([current.id,current.size,current.sha256??null,current.cloud_chunks??null])===pinned,'Attachment changed during download',409);});
    return config.storage.download(manifest(file),access,{method:request.method==='HEAD'?'HEAD':'GET',range:request.headers.get('Range'),ifRange:request.headers.get('If-Range'),signal:request.signal});
  }
  /** Root-owned one-time migrator only; never expose a source path/bytes setter
   * over HTTP. Keep the legacy attachment row and original bytes untouched. */
  async function migrate(initial:AuthContext,id:string,source:Uint8Array|AsyncIterable<Uint8Array>):Promise<Entity>{
    const item=(await execute(initial,s=>{
      const a=new Access(s,s.principal);a.require_admin(true);const original=new Authorization(a).attachment(id);require(integer(original.size)&&original.size<=MAX_FILE_SIZE,'Invalid legacy attachment size',409);checkQuota(0,quotaState(s));
      const overlay=s.get('attachment_cloud',id);if(overlay){require(overlay.source_fingerprint===sourceFingerprint(original),'Existing migration source changed',409);return {done:publicAttachment(overlay),upload:null};}
      const claim=s.get('upload_migration',id),current=claim?s.get('upload',claim.upload_id):null;if(current){require(current.migration&&current.source_fingerprint===sourceFingerprint(original),'Migration source changed',409);return {done:null,upload:current};}
      const transfer=s.allocate_id('upload'),upload={id:transfer,owner_id:a.member_id,page_id:original.page_id??null,name:fileName(original.name),size:original.size,offset:0,chunk_size:CHUNK_SIZE,expires_at:new Date(now()+TTL).toISOString(),completed:false,cloud_chunks:[],pending:null,verify_checkpoint:null,migration:true,migration_target:id,source_fingerprint:sourceFingerprint(original)};
      const saved=s.put('upload',upload);s.put('upload_migration',{id,upload_id:transfer,source_fingerprint:upload.source_fingerprint});return {done:null,upload:saved};
    })).value;if(item.done)return item.done;
    const transfer=item.upload!.id;let offset=0,used=0,buffer=new Uint8Array(CHUNK_SIZE);const iterator=source instanceof Uint8Array?(async function*(){for(let i=0;i<source.length;i+=CHUNK_SIZE)yield source.subarray(i,i+CHUNK_SIZE);})():source;
    for await(const piece of iterator){require(piece instanceof Uint8Array&&piece.length<=CHUNK_SIZE,'Migration producer must yield bounded bytes',413);require(offset+used+piece.length<=item.upload!.size,'Migration contains extra bytes',409);let first=0;while(first<piece.length){const count=Math.min(CHUNK_SIZE-used,piece.length-first);buffer.set(piece.subarray(first,first+count),used);used+=count;first+=count;if(used===CHUNK_SIZE){await append(initial,transfer,offset,buffer);offset+=used;used=0;buffer=new Uint8Array(CHUNK_SIZE);}}}
    require(offset+used===item.upload!.size,'Migration bytes are incomplete',409);if(used)await append(initial,transfer,offset,buffer.subarray(0,used));
    let result:Entity;do{result=await complete(initial,transfer);}while(result.verification_pending===true);return result;
  }
  async function handle(request:Request,encodedPath:string,initial:AuthContext):Promise<Response|null>{
    let path:string;try{path=decodeURIComponent(encodedPath);}catch{throw new APIError(400,'Invalid file path');}const parts=path.replace(/^\/+|\/+$/g,'').split('/'),method=request.method==='HEAD'?'GET':request.method;
    if(parts[0]!=='api'||!['uploads','attachments'].includes(parts[1]))return null;
    if(path==='/api/uploads'&&method==='POST')return jsonResponse(await begin(initial,await readJSON(request)),201);
    if(path==='/api/uploads/cleanup'&&method==='POST'){await readJSON(request);return jsonResponse(await cleanup(initial));}
    if(parts[1]==='uploads'&&parts.length===3){if(method==='GET')return jsonResponse(await status(initial,parts[2]));if(method==='DELETE'){await readJSON(request);return jsonResponse(await cancel(initial,parts[2]));}}
    if(parts[1]==='uploads'&&parts.length===4&&parts[3]==='chunks'&&method==='PUT'){
      const query=new URL(request.url).searchParams,values=query.getAll('offset');require([...query.keys()].every(k=>k==='offset')&&values.length===1&&/^\d{1,20}$/.test(values[0]),'A single byte offset is required');const offset=Number(values[0]),length=request.headers.get('Content-Length');require(length!==null&&/^\d+$/.test(length),'A single Content-Length is required',411);require(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()==='application/octet-stream','Expected application/octet-stream',415);
      const current=await status(initial,parts[2]);require(!current.completed,'Upload is already complete',409);require(integer(offset)&&offset<=current.offset&&offset%CHUNK_SIZE===0&&offset<current.size&&Number(length)===Math.min(CHUNK_SIZE,current.size-offset),'Incorrect chunk boundary or length');
      return jsonResponse(await append(initial,parts[2],offset,await readBytes(request,CHUNK_SIZE)));
    }
    if(parts[1]==='uploads'&&parts.length===4&&parts[3]==='complete'&&method==='POST'){await readJSON(request);const value=await complete(initial,parts[2]);return jsonResponse(value,value.verification_pending?202:201);}
    if(path==='/api/attachments'&&method==='POST'){
      const body=await readJSON(request),bytes=inlineBytes(body.data);
      const upload=await begin(initial,{name:body.name,size:bytes.length,page_id:body.page_id??null},true);for(let offset=0;offset<bytes.length;offset+=CHUNK_SIZE)await append(initial,upload.id,offset,bytes.subarray(offset,offset+CHUNK_SIZE));return jsonResponse(await complete(initial,upload.id),201);
    }
    if(parts[1]==='attachments'&&parts.length===3&&method==='DELETE'){await readJSON(request);return jsonResponse(await remove(initial,parts[2]));}
    if(parts[1]==='attachments'&&parts.length===3&&method==='GET')return jsonResponse(await view(initial,(s,a)=>publicAttachment(resolve(s,a,parts[2]))));
    if(parts[1]==='attachments'&&parts.length===4&&parts[3]==='metadata'&&method==='GET')return jsonResponse(await metadata(initial,parts[2]));
    if(parts[1]==='attachments'&&parts.length===4&&parts[3]==='download'&&method==='GET')return download(initial,parts[2],request);
    throw new APIError(404,'File route not found');
  }
  return Object.freeze({begin,status,append,complete,cancel,cleanup,garbageCollect,metadata,download,migrate,remove,handle});
}
