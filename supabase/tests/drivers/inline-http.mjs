/** Explicit isolated REAL Supabase HTTP proof. No service key or original owner.
 * Input: a fresh root-owned 0600 JSON fixture containing sealed QA credentials.
 * Output: booleans/counts/hashes only. The private input also retains QA cookies
 * between phases; Root must remove it after scoped cleanup and gate retirement. */
import {open,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const project='https://ehnovtfadpkwtubmwltl.supabase.co',wire=project+'/functions/v1/fountain-verify/wire';
const sha=value=>createHash('sha256').update(value).digest('hex');
const check=(value,label)=>{if(!value)throw Error(label);};
const phase=process.argv[3];let file;
try{
 check(process.argv.length===4&&['prepare','small','large','logout','retired'].includes(phase),'EXPLICIT_QA_PHASE_REQUIRED');
 file=await open(process.argv[2],constants.O_RDWR|constants.O_NOFOLLOW);const stat=await file.stat();
 check(stat.isFile()&&(stat.mode&0o777)===0o600&&stat.uid===process.getuid()&&stat.size<=16384,'PRIVATE_FIXTURE_REQUIRED');
 const c=JSON.parse(await file.readFile('utf8'));
 check(/^fountain-qa-cloud-inline-[a-f0-9]{16}$/.test(c.workspaceId),'EXACT_INLINE_NAMESPACE_REQUIRED');
 const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)&&Buffer.from(value,'base64url').toString('base64url')===value;
 check(token(c.wireNonce)&&sha(c.wireNonce)===c.challengeHash&&token(c.bootstrapNonce)&&sha(c.bootstrapNonce)===c.nonceHash,'FIXTURE_PROOFS_INVALID');
 check(Array.isArray(c.emails)&&c.emails.length===2&&new Set(c.emails).size===2&&c.emails.every(value=>/^[a-z0-9-]+@fountain\.invalid$/.test(value)),'QA_EMAILS_REQUIRED');
 check(Array.isArray(c.passwords)&&c.passwords.length===2&&c.passwords.every(value=>typeof value==='string'&&value.length>=16&&value.length<=1024),'QA_PASSWORDS_REQUIRED');
 c.state??={};
 const save=async()=>{const data=Buffer.from(JSON.stringify(c));check(data.length<=16384,'PRIVATE_STATE_LIMIT');await file.truncate(0);let offset=0;while(offset<data.length){const result=await file.write(data,offset,data.length-offset,offset);check(result.bytesWritten>0,'PRIVATE_STATE_WRITE');offset+=result.bytesWritten;}await file.sync();};
 async function request(path,{actor,method='GET',body,headers={}}={}){
  check(path==='/api/session'||path==='/api/accounts'||/^\/api\/attachments\/qa-inline-[a-z-]+\/(download|metadata)$/.test(path),'QA_PATH_SCOPE');
  const cookie=actor?c.state[actor+'Cookie']:null;if(cookie)check(/^fountain_session=[A-Za-z0-9_-]{43}$/.test(cookie),'QA_COOKIE_INVALID');
  let response;
  try{response=await fetch(wire,{method,redirect:'error',signal:AbortSignal.timeout(150000),headers:{'X-Fountain-Request':'1','X-Fountain-Verify':c.wireNonce,'X-Fountain-Test-Path':path,...cookie?{Cookie:cookie}:{},...body===undefined?{}:{'Content-Type':'application/json'},...headers},...body===undefined?{}:{body:JSON.stringify(body)}});}catch{throw Error('QA_TRANSPORT_FAILED');}
  if(actor)for(const raw of response.headers.getSetCookie())if(raw.startsWith('fountain_session=')){
   const match=/^fountain_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(raw);
   if(match){check(token(match[1])&&/;\s*HttpOnly(?:;|$)/i.test(raw)&&/;\s*Secure(?:;|$)/i.test(raw)&&/;\s*SameSite=Strict(?:;|$)/i.test(raw),'REAL_PRIVATE_COOKIE_FLAGS');c.state[actor+'Cookie']='fountain_session='+match[1];}
   else{check(/^fountain_session=;/.test(raw)&&/Max-Age=0/.test(raw),'QA_CLEAR_COOKIE');delete c.state[actor+'Cookie'];}
   await save();
  }
  return response;
 }
 async function json(path,options,status=200){const response=await request(path,options);check(response.status===status,'QA_JSON_STATUS_'+status+'_GOT_'+response.status);let body;try{body=await response.json();}catch{throw Error('QA_JSON_INVALID');}return body;}
 const proof={phase,workspaceSHA256:sha(c.workspaceId),actualSupabaseHTTP:true,actualStorageIO:false,checks:[]};
 if(phase==='prepare'){
  const before=await json('/api/session');check(before.authenticated===false&&before.setup_supported===true,'ANONYMOUS_SETUP_BOUNDARY');
  if(!c.state.ownerCookie){const session=await json('/api/session',{actor:'owner',method:'POST',body:{email:c.emails[0],password:c.passwords[0],setup_nonce:c.bootstrapNonce,create_account:true}});check(session.authenticated===true&&session.member?.id==='local'&&session.member?.role==='owner'&&session.workspace_id===c.workspaceId,'ACTUAL_OWNER_BOOTSTRAP');}
  if(!c.state.accountCreated){const account=await json('/api/accounts',{actor:'owner',method:'POST',body:{member_id:'bob',password:c.passwords[1]}},201);check(account.member_id==='bob'||account.member?.id==='bob'||account.id==='bob','ACTUAL_MEMBER_ACCOUNT');c.state.accountCreated=true;await save();}
  const second=await json('/api/session',{actor:'member',method:'POST',body:{email:c.emails[1],password:c.passwords[1]}});check(second.authenticated===true&&second.member?.id==='bob'&&second.member?.role==='member'&&second.workspace_id===c.workspaceId,'ACTUAL_SECOND_LOGIN');
  proof.checks.push('real_bootstrap_owner_and_second_member_auth','private_secure_httponly_strict_cookies');
 }else if(phase==='small'){
  const path='/api/attachments/qa-inline-small/download',bytes=Buffer.alloc(80,0x53),expectedSHA=sha(bytes);
  const anonymous=await request(path);check(anonymous.status===401,'ANONYMOUS_FILE_DENIED');await anonymous.body?.cancel();
  for(const actor of ['owner','member']){const response=await request(path,{actor});check(response.status===200,'AUTHENTICATED_INLINE_DOWNLOAD');check(response.headers.get('ETag')==='"'+expectedSHA+'"'&&response.headers.get('Content-Type')==='application/octet-stream'&&response.headers.get('Content-Length')==='80'&&response.headers.get('Cache-Control')==='no-store','REAL_DOWNLOAD_HEADERS');check(Buffer.from(await response.arrayBuffer()).equals(bytes),'REAL_ORIGINAL_INLINE_BYTES');}
  const metadata=await json('/api/attachments/qa-inline-small/metadata',{actor:'member'});check(metadata.id==='qa-inline-small'&&metadata.size===80&&metadata.storage==='inline','REAL_INLINE_METADATA');for(const key of ['data','bytesBase64','sourceDigest','cloud_chunks','storage_id'])check(!Object.hasOwn(metadata,key),'METADATA_BYTES_PRIVATE');
  const head=await request(path,{actor:'owner',method:'HEAD',headers:{Range:'bytes=5-9'}});check(head.status===200&&head.headers.get('Content-Length')==='80'&&(await head.arrayBuffer()).byteLength===0,'REAL_HEAD_NO_BODY');
  for(const [range,ifRange,status,length] of [['bytes=5-9',null,206,5],['bytes=-7',null,206,7],['bytes=5-9','"old"',200,80]]){const response=await request(path,{actor:'member',headers:{Range:range,...ifRange?{'If-Range':ifRange}:{}}});check(response.status===status,'REAL_RANGE_STATUS');check((await response.arrayBuffer()).byteLength===length,'REAL_RANGE_LENGTH');}
  const invalid=await request(path,{actor:'owner',headers:{Range:'bytes=80-'}});check(invalid.status===416&&invalid.headers.get('Content-Range')==='bytes */80','REAL_416');await invalid.body?.cancel();
  for(const id of ['bad-suffix','bad-size','bad-sha']){const response=await request('/api/attachments/qa-inline-'+id+'/download',{actor:'owner',headers:{Range:'bytes=0-0'}});check(response.status===409,'WHOLE_INVALID_SOURCE_REJECTED');const text=await response.text();check(!text.includes('YWJj')&&!text.includes('sourceDigest')&&!text.includes(c.wireNonce),'INVALID_SOURCE_REDACTED');}
  const denied=await request('/api/attachments/qa-inline-padbits/download',{actor:'member'});check(denied.status===404,'UNSHARED_FILE_DENIED');await denied.body?.cancel();
  const padbits=await request('/api/attachments/qa-inline-padbits/download',{actor:'owner'});check(padbits.status===200&&Buffer.from(await padbits.arrayBuffer()).equals(Buffer.from([0])),'LEGACY_PAD_BITS_COMPATIBLE');
  const empty=await request('/api/attachments/qa-inline-empty/download',{actor:'member'});check(empty.status===200&&(await empty.arrayBuffer()).byteLength===0&&empty.headers.get('ETag')==='"'+sha(Buffer.alloc(0))+'"','REAL_EMPTY_INLINE');
  proof.checks.push('real_owner_and_shared_member_byte_equal_80_byte_download','private_metadata_head_range_suffix_if_range_416','whole_invalid_source_denied_before_range','legacy_pad_bits_zero_bytes_and_unshared_member_denial');proof.smallSHA256=expectedSHA;
 }else if(phase==='large'){
  const response=await request('/api/attachments/qa-inline-large/download',{actor:'member'});check(response.status===200&&response.headers.get('Content-Length')==='5000000','REAL_MAXIMUM_INLINE_HEADERS');
  const reader=response.body.getReader(),hash=createHash('sha256');let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=5000000,'REAL_INLINE_RESPONSE_BOUND');hash.update(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const expected=sha(Buffer.alloc(5000000,0x4c)),actual=hash.digest('hex');check(size===5000000&&actual===expected&&response.headers.get('ETag')==='"'+expected+'"','REAL_MAXIMUM_INLINE_SHA');
  const partial=await request('/api/attachments/qa-inline-large/download',{actor:'owner',headers:{Range:'bytes=65530-65547'}});check(partial.status===206&&partial.headers.get('Content-Range')==='bytes 65530-65547/5000000'&&Buffer.from(await partial.arrayBuffer()).equals(Buffer.alloc(18,0x4c)),'REAL_UNALIGNED_RANGE');
  proof.checks.push('actual_five_million_byte_DB_download_full_independent_SHA','actual_unaligned_range_across_64KiB_position');proof.bytes=size;proof.sha256=actual;
 }else if(phase==='logout'){
  for(const actor of ['owner','member']){const response=await request('/api/session',{actor,method:'DELETE',body:{}});check(response.status===200,'REAL_LOGOUT');await response.body?.cancel();check(!c.state[actor+'Cookie'],'PRIVATE_COOKIE_CLEARED');}
  proof.checks.push('both_actual_sessions_logged_out');
 }else{
  for(const action of ['wire','cleanup-check','cleanup']){
   const response=await fetch(project+'/functions/v1/fountain-verify/'+action,{method:action==='wire'?'GET':'POST',headers:{'X-Fountain-Verify':c.wireNonce,'X-Fountain-Request':'1',...action==='wire'?{'X-Fountain-Test-Path':'/api/session'}:{'Content-Type':'application/json'}},...action==='wire'?{}:{body:'{}'},redirect:'error',signal:AbortSignal.timeout(15000)});
   check(response.status===404,'OLD_SEALED_GATE_REJECTED');await response.body?.cancel();
  }
  proof.checks.push('retired_wire_and_both_cleanup_paths_reject_old_nonce');
 }
 await save();console.log(JSON.stringify({...proof,passed:true}));
}catch(error){console.error(JSON.stringify({phase,passed:false,error:/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'PRIVATE_QA_FAILED'}));process.exitCode=1;}
finally{await file?.close();}
