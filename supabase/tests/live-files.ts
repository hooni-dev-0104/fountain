/** Split root-only REAL Storage QA, one invocation per bounded phase/chunk.
 * No files/buckets/users are created outside the configured disposable namespace.
 * The private wrapper derives passwords; this module never emits them or bytes.
 */
import {createLiveRuntime,liveScope,qaPasswords,qaCheck,LiveQAError} from './live-domain.ts';
import type {LiveConfig} from './live-domain.ts';
import {createFiles} from '../functions/_shared/files.ts';
import {createStorage,CHUNK_SIZE,IncrementalSHA256} from '../functions/_shared/storage.ts';

export const LIVE_FILE_SIZE=9*1024*1024+123;
const META='qa_live_upload_id';
export type LiveFileAction='begin'|'chunk'|'complete'|'check'|'cleanup';
export type LiveFileInput={offset?:number;data?:Uint8Array};
export type LiveFileResult={checks:string[];uploadId?:string;offset?:number;objectsRemoved?:number};
/** Same index-addressed bytes in the root driver; no 9MiB request JSON/base64. */
export function liveFilePattern(offset:number,length:number):Uint8Array{
  qaCheck(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(length)&&length>=0&&length<=CHUNK_SIZE&&offset+length<=LIVE_FILE_SIZE,'QA_PATTERN_RANGE');
  const bytes=new Uint8Array(length);
  for(let i=0;i<length;i++){const p=offset+i;bytes[i]=(p*31+Math.floor(p/65536)*17+Math.floor(p/CHUNK_SIZE)*53)&255;}
  return bytes;
}
export function liveFileSHA256():string{
  const hash=new IncrementalSHA256();for(let offset=0;offset<LIVE_FILE_SIZE;offset+=CHUNK_SIZE)hash.update(liveFilePattern(offset,Math.min(CHUNK_SIZE,LIVE_FILE_SIZE-offset)));return hash.hex();
}
export async function runFiles(config:LiveConfig,passwords:[string,string],action:LiveFileAction,input:LiveFileInput={},guardedFetch:typeof fetch):Promise<LiveFileResult>{
  const scope=liveScope(config);qaPasswords(passwords);
  qaCheck(['begin','chunk','complete','check','cleanup'].includes(action)&&input!==null&&typeof input==='object'&&!Array.isArray(input),'QA_FILE_ACTION');
  qaCheck(Object.keys(input).every(key=>action==='chunk'&&['offset','data'].includes(key)),'QA_FILE_INPUT');
  let deletedObjects=0;
  const observedFetch:typeof fetch=async(url,init)=>{
    const response=await guardedFetch(url,init),path=new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url).pathname;
    if(init?.method==='DELETE'&&path==='/storage/v1/object/fountain-files'&&response.ok&&typeof init.body==='string'){
      try{const body=JSON.parse(init.body);if(Array.isArray(body.prefixes))deletedObjects+=body.prefixes.length;}catch{/* Never expose provider diagnostics. */}
    }
    return response;
  };
  const storage=createStorage({supabaseUrl:scope.supabaseUrl,serviceKey:scope.serviceKey,bucket:'fountain-files',workspaceId:scope.workspaceId,maxObjectBytes:CHUNK_SIZE,fetch:observedFetch});
  const runtime=createLiveRuntime(scope,observedFetch,base=>createFiles({...base,storage,verifyChunks:4})),checks:string[]=[];
  try{
    const a=await runtime.login(0,passwords[0]);
    const call=(method:string,path:string,body?:unknown,status=200)=>runtime.json(a,method,path,body,status);
    const context=await runtime.auth.authorize(a),execute=runtime.transactions(a);
    const stored=(await execute(context,s=>s.meta(META,null),{metaKeys:[META]})).value;
    if(action==='begin'){
      qaCheck(stored===null,'QA_FILE_ALREADY_EXISTS');
      const upload=await call('POST','/api/uploads',{name:'QA deterministic 9MiB.bin',size:LIVE_FILE_SIZE},201);
      qaCheck(typeof upload.id==='string'&&upload.size===LIVE_FILE_SIZE&&upload.offset===0&&upload.chunk_size===CHUNK_SIZE,'QA_FILE_BEGIN');
      await execute(context,s=>{qaCheck(s.meta(META,null)===null,'QA_FILE_ALREADY_EXISTS');s.set_meta(META,{id:upload.id,size:LIVE_FILE_SIZE});},{metaKeys:[META]});
      return {checks:['actual_sql_upload_reservation_and_durable_qa_id'],uploadId:upload.id,offset:0};
    }
    if(action==='cleanup'&&stored===null)return {checks:['qa_file_cleanup_already_finished'],objectsRemoved:0};
    qaCheck(stored&&typeof stored.id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(stored.id)&&stored.size===LIVE_FILE_SIZE,'QA_FILE_ID');const id=stored.id;
    if(action==='chunk'){
      const {offset,data}=input;
      qaCheck(typeof offset==='number'&&Number.isSafeInteger(offset)&&offset>=0&&offset%CHUNK_SIZE===0&&offset<LIVE_FILE_SIZE&&data instanceof Uint8Array&&data.length===Math.min(CHUNK_SIZE,LIVE_FILE_SIZE-offset),'QA_FILE_CHUNK');
      const expected=liveFilePattern(offset,data.length);let difference=0;for(let i=0;i<expected.length;i++)difference|=expected[i]^data[i];qaCheck(difference===0,'QA_FILE_PATTERN');
      const response=await runtime.request(a,'PUT',`/api/uploads/${id}/chunks?offset=${offset}`,data,{'Content-Type':'application/octet-stream','Content-Length':String(data!.length)});
      qaCheck(response.status===200,'QA_FILE_CHUNK_HTTP');const value=await response.json();
      qaCheck(value.id===id&&value.offset>=offset+data.length&&value.offset<=LIVE_FILE_SIZE,'QA_FILE_OFFSET');
      return {checks:['actual_private_storage_chunk_and_acknowledged_sql_manifest'],uploadId:id,offset:value.offset};
    }
    if(action==='complete'){
      const done=await call('POST',`/api/uploads/${id}/complete`,{},201),expected=liveFileSHA256();
      qaCheck(done.id===id&&done.size===LIVE_FILE_SIZE&&done.sha256===expected&&done.storage==='chunks','QA_FILE_COMPLETE_SHA');
      checks.push('three_real_private_storage_chunks_full_sha256_verified_and_published');return {checks,uploadId:id,offset:LIVE_FILE_SIZE};
    }
    if(action==='check'){
      const metadata=await call('GET',`/api/attachments/${id}/metadata`),expected=liveFileSHA256();
      qaCheck(metadata.id===id&&metadata.size===LIVE_FILE_SIZE&&metadata.sha256===expected&&metadata.status==='complete','QA_FILE_METADATA');
      const serialized=JSON.stringify(metadata);for(const forbidden of [scope.serviceKey,...passwords,'cloud_chunks','storage_id','pending','checkpoint','/storage/v1/'])qaCheck(!serialized.includes(forbidden),'QA_FILE_SECRET_PROJECTION');
      checks.push('actual_metadata_full_sha256_and_no_private_manifest_or_credentials');
      // Each response traverses the real backend -> files -> private Storage
      // stream with current SQL permission gates, never a preassembled buffer.
      for(const offset of [0,CHUNK_SIZE-32768,2*CHUNK_SIZE-32768,LIVE_FILE_SIZE-65536]){
        const length=65536,response=await runtime.request(a,'GET',`/api/attachments/${id}/download`,undefined,{Range:`bytes=${offset}-${offset+length-1}`});
        qaCheck(response.status===206&&response.headers.get('Content-Range')===`bytes ${offset}-${offset+length-1}/${LIVE_FILE_SIZE}`,'QA_FILE_RANGE');
        const data=new Uint8Array(await response.arrayBuffer()),pattern=liveFilePattern(offset,length);qaCheck(data.length===length,'QA_FILE_RANGE_LENGTH');let difference=0;for(let i=0;i<length;i++)difference|=data[i]^pattern[i];qaCheck(difference===0,'QA_FILE_RANGE_BYTES');
      }
      const head=await runtime.request(a,'HEAD',`/api/attachments/${id}/download`);qaCheck(head.status===200&&head.headers.get('Content-Length')===String(LIVE_FILE_SIZE)&&(await head.arrayBuffer()).byteLength===0,'QA_FILE_HEAD');
      const invalid=await runtime.request(a,'GET',`/api/attachments/${id}/download`,undefined,{Range:`bytes=${LIVE_FILE_SIZE}-`});qaCheck(invalid.status===416,'QA_FILE_UNSATISFIABLE');await invalid.body?.cancel();
      const b=await runtime.login(1,passwords[1]),session=await runtime.json(b,'GET','/api/session');qaCheck(session.member.role==='member','QA_FILE_BOB_ROLE');
      for(const suffix of ['metadata','download']){const denied=await runtime.request(b,'GET',`/api/attachments/${id}/${suffix}`);qaCheck([403,404].includes(denied.status),'QA_FILE_PRIVATE_BOB');await denied.body?.cancel();}
      checks.push('real_stream_cross_chunk_ranges_head_416_and_other_member_denial');return {checks,uploadId:id};
    }
    const before=(await execute(context,s=>{const file=s.get('attachment',id),upload=s.get('upload',id),gc=s.get('upload_gc',id);return {complete:file!==null,pending:upload!==null,count:((file??upload??gc)?.cloud_chunks?.length??0)+(!file&&upload?.pending?1:0)};},{ids:{attachment:[id],upload:[id],upload_gc:[id]}})).value;
    if(before.complete||before.pending){
      const removed=await call('DELETE',before.complete?`/api/attachments/${id}`:`/api/uploads/${id}`,{});
      qaCheck((before.complete?removed.deleted:removed.cancelled)===true&&!removed.cleanup_pending,'QA_FILE_PHYSICAL_CLEANUP');
    }else{
      // A prior delete can have committed before its physical-GC ACK was lost.
      const files=createFiles({provider:runtime.provider,storage,authorize:()=>runtime.auth.authorize(a)});
      qaCheck((await files.garbageCollect(context,id)).removed===true,'QA_FILE_PHYSICAL_CLEANUP');
    }
    const after=(await execute(context,s=>({file:s.get('attachment',id),upload:s.get('upload',id),gc:s.get('upload_gc',id)}),{ids:{attachment:[id],upload:[id],upload_gc:[id]}})).value;
    qaCheck(after.file===null&&after.upload===null&&after.gc===null&&deletedObjects===before.count,'QA_FILE_GC');
    await execute(context,s=>s.set_meta(META,null),{metaKeys:[META]});
    return {checks:['explicit_attachment_delete_and_real_storage_object_gc_acknowledged'],objectsRemoved:deletedObjects};
  }catch(error){if(error instanceof LiveQAError)throw new LiveQAError('FILES_'+action.toUpperCase()+'_'+error.code,error.status);throw new LiveQAError('FILES_'+action.toUpperCase()+'_FAILED',503);}
  finally{await runtime.close();}
}
