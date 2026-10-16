/** Explicit isolated REAL Supabase advanced-search HTTP proof. No service key or original owner.
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
 check(process.argv.length===4&&['prepare','search','logout','retired'].includes(phase),'EXPLICIT_QA_PHASE_REQUIRED');
 file=await open(process.argv[2],constants.O_RDWR|constants.O_NOFOLLOW);const stat=await file.stat();
 check(stat.isFile()&&(stat.mode&0o777)===0o600&&stat.uid===process.getuid()&&stat.size<=16384,'PRIVATE_FIXTURE_REQUIRED');
 const c=JSON.parse(await file.readFile('utf8'));
 check(/^fountain-qa-cloud-search-[a-f0-9]{16}$/.test(c.workspaceId),'EXACT_SEARCH_NAMESPACE_REQUIRED');
 const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)&&Buffer.from(value,'base64url').toString('base64url')===value;
 check(token(c.wireNonce)&&sha(c.wireNonce)===c.challengeHash&&token(c.bootstrapNonce)&&sha(c.bootstrapNonce)===c.nonceHash,'FIXTURE_PROOFS_INVALID');
 check(Array.isArray(c.emails)&&c.emails.length===2&&new Set(c.emails).size===2&&c.emails.every(value=>/^[a-z0-9-]+@fountain\.invalid$/.test(value)),'QA_EMAILS_REQUIRED');
 check(Array.isArray(c.passwords)&&c.passwords.length===2&&c.passwords.every(value=>typeof value==='string'&&value.length>=16&&value.length<=1024),'QA_PASSWORDS_REQUIRED');
 c.state??={};
 const save=async()=>{const data=Buffer.from(JSON.stringify(c));check(data.length<=16384,'PRIVATE_STATE_LIMIT');await file.truncate(0);let offset=0;while(offset<data.length){const result=await file.write(data,offset,data.length-offset,offset);check(result.bytesWritten>0,'PRIVATE_STATE_WRITE');offset+=result.bytesWritten;}await file.sync();};
 async function request(path,{actor,method='GET',body,headers={}}={}){
  check(path==='/api/session'||path==='/api/accounts'||path==='/api/capabilities'||path==='/api/workspace'||path.startsWith('/api/search')||path==='/api/members/bob'||path==='/api/pages/qa-search-public/permissions'||path==='/api/databases/qa-search-db/rows/qa-search-row','QA_PATH_SCOPE');
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
 const proof={phase,workspaceSHA256:sha(c.workspaceId),actualSupabaseHTTP:true,actualStorageIO:false,semanticAI:false,checks:[]};
 if(phase==='prepare'){
  const before=await json('/api/session');check(before.authenticated===false&&before.setup_supported===true,'ANONYMOUS_SETUP_BOUNDARY');
  if(!c.state.ownerCookie){const session=await json('/api/session',{actor:'owner',method:'POST',body:{email:c.emails[0],password:c.passwords[0],setup_nonce:c.bootstrapNonce,create_account:true}});check(session.authenticated===true&&session.member?.id==='local'&&session.member?.role==='owner'&&session.workspace_id===c.workspaceId,'ACTUAL_OWNER_BOOTSTRAP');}
  if(!c.state.accountCreated){const account=await json('/api/accounts',{actor:'owner',method:'POST',body:{member_id:'bob',password:c.passwords[1]}},201);check(account.member_id==='bob'||account.member?.id==='bob'||account.id==='bob','ACTUAL_MEMBER_ACCOUNT');c.state.accountCreated=true;await save();}
  const second=await json('/api/session',{actor:'member',method:'POST',body:{email:c.emails[1],password:c.passwords[1]}});check(second.authenticated===true&&second.member?.id==='bob'&&second.member?.role==='member'&&second.workspace_id===c.workspaceId,'ACTUAL_SECOND_LOGIN');
  proof.checks.push('real_bootstrap_owner_and_second_member_auth','private_secure_httponly_strict_cookies');

 }else if(phase==='search'){
  const search=async(query='',actor='member',status=200)=>json('/api/search/advanced'+(query?'?'+query:''),{actor},status);
  const unauth=await request('/api/search/advanced');check(unauth.status===401,'ANONYMOUS_SEARCH_DENIED');await unauth.body?.cancel();
  const capabilities=await json('/api/capabilities',{actor:'member'});check(capabilities.search_advanced===true,'REAL_ADVANCED_CAPABILITY');
  const visible=await search(),owner=await search('','owner');check(visible.total===6&&owner.total>visible.total,'REAL_ACL_BEFORE_COUNT');
  const serialized=JSON.stringify(visible);for(const hidden of ['hidden-search-token','person-secret-token','file-secret-token','relation-secret-token','formula-secret-token','unknown-secret-token','attachment-secret-token'])check(!serialized.includes(hidden),'PRIVATE_VALUE_NOT_IN_DTO');
  check(visible.results.some(v=>v.type==='page')&&visible.results.some(v=>v.type==='database')&&visible.results.some(v=>v.type==='row'),'REAL_THREE_TYPES');
  for(const term of ['hidden-search-token','person-secret-token','file-secret-token','relation-secret-token','formula-secret-token','unknown-secret-token','attachment-secret-token','archived-search-token'])check((await search(new URLSearchParams({q:term}).toString())).total===0,'HIDDEN_TERM_HAS_NO_COUNT');
  const korean=await search(new URLSearchParams({q:'서울'}).toString());check(korean.results.some(v=>v.type==='page')&&korean.results.some(v=>v.type==='row'),'REAL_KOREAN_BODY_SEARCH');
  const phrase=await search(new URLSearchParams({q:'"가족 여행"',title_only:'1'}).toString());check(phrase.total===2,'REAL_PHRASE_TITLE_ONLY');
  const rows=await search('types=row');check(rows.total===2&&rows.results.every(v=>v.type==='row')&&rows.results.some(v=>v.id==='qa-search-assigned-bob')&&!rows.results.some(v=>v.id==='qa-search-assigned-other'),'REAL_ASSIGNED_ROWS');
  const inside=await search('in=qa-search-public');check(inside.total===4,'REAL_SUBTREE_PAGE_DB_ROW');
  await search('in=qa-search-private','member',404);await search('in=missing','member',404);
  for(const sort of ['relevance','updated_desc','updated_asc','created_desc','created_asc','title'])check((await search('sort='+sort)).total===6,'REAL_SORTS');
  check((await search('owner=bob')).total===0,'REAL_OWNER_FILTER');
  const first=await search('limit=2'),second=await search('limit=2&offset=2&result_set='+first.result_set);check(first.has_more&&second.offset===2&&first.result_set===second.result_set&&first.results.every(a=>second.results.every(b=>a.id!==b.id||a.type!==b.type)),'REAL_PAGINATION_ACROSS_AUDIT');
  const head=await request('/api/search/advanced?limit=2',{actor:'member',method:'HEAD'});check(head.status===200&&(await head.arrayBuffer()).byteLength===0,'REAL_HEAD_SEARCH');
  for(const query of ['q=x&q=y','types=unknown','offset=1','limit=01','unknown=1'])await search(query,'member',400);
  check((await json('/api/search?q='+encodeURIComponent('가족'),{actor:'member'})).results.every(v=>!Object.hasOwn(v,'type')),'REAL_LEGACY_ROUTE_UNCHANGED');
  await json('/api/members/bob',{actor:'owner',method:'PATCH',body:{role:'admin'}});check((await search()).total===6,'REAL_ADMIN_DOES_NOT_INHERIT_PRIVATE');
  await json('/api/members/bob',{actor:'owner',method:'PATCH',body:{role:'guest'}});check((await search()).total===0,'REAL_CURRENT_GUEST_AUTHORITY');
  await json('/api/members/bob',{actor:'owner',method:'PATCH',body:{role:'member'}});check((await search()).total===6,'REAL_CURRENT_MEMBER_RESTORED');
  await json('/api/pages/qa-search-public/permissions',{actor:'owner',method:'PATCH',body:{permissions:{default:'private',inherit:false,members:{},groups:{}}}});
  check((await search()).total===5,'REAL_PERMISSION_REVOKED_NEXT_REQUEST');await search('limit=2&offset=2&result_set='+first.result_set,'member',409);
  const fresh=await search('limit=2');await json('/api/databases/qa-search-db/rows/qa-search-row',{actor:'owner',method:'DELETE',body:{}});check((await search()).total===4,'REAL_DELETED_ROW_REMOVED');await search('limit=2&offset=2&result_set='+fresh.result_set,'member',409);
  proof.checks.push('actual_auth_owner_member_admin_guest_search','korean_phrase_title_type_owner_subtree_and_six_sorts','hidden_source_and_person_file_relation_formula_values_excluded','assigned_row_policy_before_count','pagination_marker_stable_across_audit_and_rejected_after_acl_and_delete','malformed_query_400_and_head_and_legacy_contract');proof.visibleBefore=6;proof.visibleAfter=4;
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
