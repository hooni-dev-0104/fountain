/* Native-only adapter. Authentication bytes remain inside FountainNative. */
(function (root) {
  'use strict';
  const REQUEST_LIMIT=10_000_000,RESPONSE_LIMIT=16*1024*1024,EXPORT_LIMIT=8*1024*1024,CHUNK_SIZE=4*1024*1024;
  const requestHeaders=new Set(['content-type','accept','range','if-none-match']);
  const responseHeaders=new Set(['content-type','content-length','content-range','accept-ranges','etag','content-disposition']);
  const methods=new Set(['GET','POST','PUT','PATCH','DELETE']);
  const invalid=()=>{throw new TypeError('허용되지 않는 연결 경로 또는 요청입니다.');};
  const abortError=()=>new DOMException('연결 범위가 변경되었거나 요청이 취소되었습니다.','AbortError');
  function nativeFailure(error) {
    const code=error?.code;
    if(code==='ACCOUNT_AUTH_REQUIRED')return Object.assign(new Error('계정에 다시 로그인해 주세요.'),{code,status:401});
    if(code==='NATIVE_SESSION_CONFLICT')return Object.assign(new Error('로그인 계정이 변경되었습니다. 현재 화면을 다시 확인해 주세요.'),{code,status:409});
    if(code==='NATIVE_SESSION_REQUIRED')return Object.assign(new Error('현재 로그인을 서버에서 다시 확인한 뒤 종료해 주세요.'),{code,status:503});
    if(code==='NATIVE_SESSION_INVALID')return Object.assign(new Error('로그아웃 요청의 로그인 범위를 확인해 주세요.'),{code,status:400});
    if(code==='OUTBOX_ACCESS_REQUIRED')return Object.assign(new Error('보관된 내용의 접근 권한을 다시 확인해야 합니다. 미전송 내용은 유지했습니다.'),{code,status:503});
    if(['NETWORK_ERROR','NATIVE_NETWORK','NATIVE_NETWORK_UNREACHABLE'].includes(code))return Object.assign(new TypeError('서버에 연결하지 못했습니다.'),{code});
    if(['TIMEOUT','NATIVE_TIMEOUT'].includes(code))return new DOMException('요청 시간이 초과되었습니다.','TimeoutError');
    if(['CANCELLED','SESSION_CHANGED','NATIVE_CANCELLED','NATIVE_STALE'].includes(code))return abortError();
    if(typeof code==='string'){
      const failure=new Error(['SESSION_REVOCATION_PENDING','NATIVE_REVOKE'].includes(code)?'이전 로그인을 종료한 뒤 다시 로그인해 주세요.':'앱 연결 또는 보안 저장소를 확인해 주세요.');
      failure.code=code;failure.status=['SESSION_REVOCATION_PENDING','NATIVE_REVOKE'].includes(code)?401:['INVALID_REQUEST','NATIVE_INVALID'].includes(code)?400:503;return failure;
    }
    return error;
  }
  function validateOrigin(value) {
    if(typeof value!=='string'||!/^https:\/\/[^/?#]+\/?$/i.test(value)||/[\\\u0000-\u0020\u007f]/.test(value))invalid();
    let url;try{url=new URL(value);}catch{invalid();}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)invalid();
    return url.origin;
  }
  function primaryFrontend(value) {
    if(value===undefined||value===null)return null;
    const origin=validateOrigin(value);if(origin!==value)invalid();return origin;
  }
  function path(value,kind='api') {
    if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020\u007f#]/.test(value))invalid();
    const pathname=value.split('?')[0];if(/%(?![0-9a-f]{2})/i.test(pathname))invalid();let decoded=pathname;
    for(let depth=0;depth<8;depth++) {
      if(/[\\\u0000-\u001f\u007f]/.test(decoded)||decoded.includes('//')||decoded.split('/').some(part=>part==='.'||part==='..'))invalid();
      if(!/%[0-9a-f]{2}/i.test(decoded))break;
      let next;try{next=decodeURIComponent(decoded);}catch{invalid();}
      if(next===decoded)break;decoded=next;if(depth===7)invalid();
    }
    if(kind==='api'&&!pathname.startsWith('/api/'))invalid();
    if(kind==='public'&&!/^\/(forms|sites)\/[^/]+$/.test(pathname))invalid();
    if(kind==='download'&&!/^\/api\/(?:backup(?:\?job_id=[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})?|attachments\/[^/?]+\/download)$/.test(value))invalid();
    return value;
  }
  function filename(value) {
    if(typeof value!=='string'||!value||Array.from(value).length>240||/[\\/\u0000-\u001f\u007f]/.test(value)||value==='.'||value==='..')invalid();
    return value;
  }
  function base64(bytes) {
    let binary='';for(let index=0;index<bytes.length;index+=32768)binary+=String.fromCharCode(...bytes.subarray(index,index+32768));
    return btoa(binary);
  }
  function decode(value,limit) {
    if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4||value.length%4!==0)invalid();
    const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,end=value.length-padding;
    // Scan once: repeated regex groups exhaust V8's stack on valid large responses.
    for(let index=0;index<end;index++){
      const code=value.charCodeAt(index);
      if(!(code>=65&&code<=90||code>=97&&code<=122||code>=48&&code<=57||code===43||code===47))invalid();
    }
    const length=value.length/4*3-padding;if(length>limit)throw new RangeError('서버 응답이 허용된 크기를 넘었습니다.');
    const binary=atob(value),result=new Uint8Array(length);
    for(let index=0;index<length;index++)result[index]=binary.charCodeAt(index);
    return result;
  }
  async function bytes(body,limit) {
    if(body==null)return new Uint8Array();
    if(body instanceof Blob){if(body.size>limit)throw new RangeError('데이터가 허용된 크기를 넘었습니다.');return new Uint8Array(await body.arrayBuffer());}
    if(body instanceof URLSearchParams)body=body.toString();
    if(typeof body==='string'){if(body.length>limit)throw new RangeError('데이터가 허용된 크기를 넘었습니다.');body=new TextEncoder().encode(body);}
    else if(body instanceof ArrayBuffer)body=new Uint8Array(body);
    else if(ArrayBuffer.isView(body))body=new Uint8Array(body.buffer,body.byteOffset,body.byteLength);
    else invalid();
    if(body.byteLength>limit)throw new RangeError('데이터가 허용된 크기를 넘었습니다.');return body;
  }
  function create(bridge,{pollInterval=1000}={}) {
    let workspace=null,workspaceHint=null,workspaceHints=[],workspaceSerial=0,workspaceTail=Promise.resolve(),legacyMode=false,scopedUsed=false;
    const helper=()=>{if(!root.FountainWorkspaceScope)invalid();return root.FountainWorkspaceScope;};
    let configuration={origin:null,generation:0,workspaceVersion:0,outboxVersion:0,outboxEnabled:false,recoveryVersion:0,recoveryEnabled:false},authGeneration=0,configurationFence=0,publicScopeEpoch=0,authTail=Promise.resolve(),serial=0;
    const calls=new Map(),sources=new Set(),sourceWake=new WeakMap(),downloadLinks=new Map();let outboxPaused=false,pauseGate=Promise.resolve(),releaseGate=null;
    const id=()=>`mobile_${Date.now().toString(36)}_${++serial}`;
    function configured(){if(!configuration.origin)throw new Error('먼저 HTTPS 서버 주소를 설정해 주세요.');}
    function announceScope(reason){publicScopeEpoch++;root.dispatchEvent(new CustomEvent('fountain-native-scope-changed',{detail:{scopeEpoch:publicScopeEpoch,reason}}));}
    const hintKeys=['workspaceId','memberId','binding','accountBinding','expiresAt'];
    const sameHint=(a,b)=>!!a&&!!b&&hintKeys.every(key=>a[key]===b[key]);
    function readWorkspaceHints(value){
      workspaceHint=null;workspaceHints=[];if(!root.FountainWorkspaceScope)return;
      const epoch=Number.isSafeInteger(value.workspaceEpoch)?value.workspaceEpoch:0;
      let last=null;try{if(value.workspace)last=helper().validate({...value.workspace,workspaceEpoch:epoch});}catch{/* Older bridges expose only a last-selection hint. */}
      if(!Object.hasOwn(value,'retainedWorkspaceScopes')){if(last){workspaceHint=last;workspaceHints=[last];}return;}
      try{
        if(!Array.isArray(value.retainedWorkspaceScopes)||value.retainedWorkspaceScopes.length>100)invalid();
        const found=new Map();let parent=null;
        for(const raw of value.retainedWorkspaceScopes){
          if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!==[...hintKeys].sort().join(','))invalid();
          const hint=helper().validate({...raw,workspaceEpoch:epoch});if(hint.expiresAt>Date.now()+604801000||parent!==null&&hint.accountBinding!==parent)invalid();parent=hint.accountBinding;
          const previous=found.get(hint.workspaceId);if(previous&&!sameHint(previous,hint))invalid();found.set(hint.workspaceId,hint);
        }
        workspaceHints=[...found.values()];workspaceHint=workspaceHints.find(hint=>sameHint(hint,last))||workspaceHints[0]||null;
      }catch{/* Malformed, mixed-parent or conflicting hints never fall back to the last workspace. */workspaceHint=null;workspaceHints=[];}
    }
    function setConfiguration(value) {
      if(!value||!Number.isSafeInteger(value.generation)||value.generation<configuration.generation)invalid();
      const previous=configuration;if(previous.origin!==null&&value.generation===previous.generation&&value.origin!==previous.origin)invalid();readWorkspaceHints(value);
      configuration={origin:value.origin===null?null:validateOrigin(value.origin),generation:value.generation,
        workspaceVersion:value.workspaceVersion===1?1:0,workspaceEpoch:Number.isSafeInteger(value.workspaceEpoch)?value.workspaceEpoch:0,
        outboxVersion:value.outboxVersion===1?1:0,outboxEnabled:value.outboxVersion===1&&value.outboxEnabled===true,
        recoveryVersion:value.recoveryVersion===1?1:0,recoveryEnabled:value.recoveryVersion===1&&value.recoveryEnabled===true};
      if(previous.origin!==configuration.origin||previous.generation!==configuration.generation){workspace=null;legacyMode=false;scopedUsed=false;workspaceSerial++;cancelCalls();root.FountainNativeStorage?.close?.();root.FountainNativeStorage=null;}
      if(previous.origin!==configuration.origin||previous.generation!==configuration.generation
          ||previous.recoveryVersion!==configuration.recoveryVersion||previous.recoveryEnabled!==configuration.recoveryEnabled)announceScope('configuration');
      return {...configuration};
    }
    function cancelCalls() {
      for(const call of calls.values())call.abort();for(const source of [...sources])source.close();downloadLinks.clear();
    }
    function scope(){return {generation:configuration.generation,auth:authGeneration,fence:configurationFence,origin:configuration.origin,workspaceSerial,workspace};}
    function current(expected){return expected.generation===configuration.generation&&expected.auth===authGeneration&&expected.fence===configurationFence&&expected.origin===configuration.origin&&expected.workspaceSerial===workspaceSerial&&expected.workspace===workspace&&(!expected.workspace||expected.workspace.expiresAt>Date.now());}
    function rejectAccountScope(expected,parent){
      if(!current(expected)||! /^[a-f0-9]{32}$/.test(parent))throw abortError();
      // Only invoke's current native RPC rejection reaches this transition. The OS
      // already revoked the parent; do not issue a stale workspace park RPC.
      authGeneration++;workspaceSerial++;workspace=null;legacyMode=false;
      workspaceHints=workspaceHints.filter(hint=>hint.accountBinding!==parent);if(workspaceHint?.accountBinding===parent)workspaceHint=null;
      cancelCalls();const storage=root.FountainNativeStorage;root.FountainNativeStorage=null;try{storage?.close?.();}catch{/* The OS parent fence remains authoritative; retained input cannot reopen admission. */}
      announceScope('unauthenticated');root.dispatchEvent(new CustomEvent('fountain-workspace-auth-required',{detail:{accountBinding:parent}}));
    }
    async function invoke(method,payload,expected,signal,timeoutMs=null) {
      if(!current(expected)||signal?.aborted)throw abortError();
      const callId=payload.id||id();let rejectAbort,timer,finished=false;
      const abort=()=>{if(finished)return;finished=true;bridge.cancel({id:callId}).catch(()=>{});rejectAbort(abortError());};
      const interrupted=new Promise((_,reject)=>{rejectAbort=reject;});calls.set(callId,{abort});
      signal?.addEventListener('abort',abort,{once:true});
      if(timeoutMs!==null)timer=setTimeout(()=>{if(finished)return;finished=true;bridge.cancel({id:callId}).catch(()=>{});rejectAbort(new DOMException('요청 시간이 초과되었습니다.','TimeoutError'));},timeoutMs);
      try {
        const result=await Promise.race([Promise.resolve().then(()=>{if(finished||!current(expected))throw abortError();return bridge[method]({...payload,id:callId,generation:expected.generation});}),interrupted]);
        if(finished||!current(expected)||result?.generation!==expected.generation)throw abortError();
        return result;
      }catch(error){
        if(error?.code==='ACCOUNT_AUTH_REQUIRED'){if(!current(expected)||signal?.aborted)throw abortError();const parent=expected.workspace?.accountBinding||payload.account_binding;if(parent)rejectAccountScope(expected,parent);}
        throw nativeFailure(error);
      }
      finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);calls.delete(callId);}
    }
    async function initialize(){const fence=configurationFence,result=await bridge.getConfiguration();if(fence!==configurationFence)throw abortError();return setConfiguration(result);}
    async function configure(input) {
      const origin=validateOrigin(input?.origin),fence=++configurationFence;workspace=null;workspaceHint=null;workspaceHints=[];legacyMode=false;scopedUsed=false;workspaceSerial++;authGeneration++;cancelCalls();announceScope('configuration');
      const result=await bridge.configure({origin});if(fence!==configurationFence)throw abortError();return setConfiguration(result);
    }
    function routed(value,captured=workspace){path(value);if(/^\/api\/(?:account|organization)(?:\/|$)/.test(value))invalid();if(configuration.workspaceVersion===1&&!captured&&!legacyMode||captured&&captured.expiresAt<=Date.now())throw abortError();return captured?helper().wire(value,captured):value;}
    function apiURL(value){configured();return new URL(routed(value),configuration.origin).href;}
    function request(value,options={}) {return exchange(value,options,false);}
    function anonymousSession(value){
      const fields=['authenticated','required','enabled','mode','member','identity','cache_binding','workspace_id','expires_at','setup_supported','public_web_origin'];
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key))||value.authenticated!==false||typeof value.required!=='boolean'||['member','identity','cache_binding','expires_at'].some(key=>value[key]!=null)||value.mode!==undefined&&!['accounts','family','local'].includes(value.mode)||['enabled','setup_supported'].some(key=>value[key]!==undefined&&typeof value[key]!=='boolean')||value.workspace_id!=null&&(typeof value.workspace_id!=='string'||value.workspace_id.length>1000))return null;
      if(value.public_web_origin!=null)try{if(primaryFrontend(value.public_web_origin)!==value.public_web_origin)return null;}catch{return null;}
      return Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
    }
    function exchange(value,options={},internal=false) {
      path(value);configured();const capturedWorkspace=workspace,wirePath=routed(value,capturedWorkspace);if(capturedWorkspace?.offline)throw new TypeError('인터넷 연결 후 작업공간을 다시 확인해 주세요.');const method=String(options.method||'GET').toUpperCase();if(!methods.has(method))invalid();
      if(options.redirect&&options.redirect!=='error')invalid();
      const headers=Object.create(null);for(const [key,val] of new Headers(options.headers)){if(!requestHeaders.has(key))invalid();headers[key]=val;}
      const timeoutMs=options.timeoutMs??45000;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)invalid();
      if(method==='GET'&&options.body!=null)invalid();
      const transition=value==='/api/session'&&['POST','DELETE'].includes(method);
      if(transition){authGeneration++;cancelCalls();announceScope('authentication');}
      const expected=scope(),expectedEpoch=publicScopeEpoch,priorAuth=authTail;
      const perform=async body=>{
        if(!current(expected)||options.signal?.aborted)throw abortError();
        const result=await invoke('request',{path:wirePath,method,headers,bodyBase64:base64(body),timeoutMs,...(capturedWorkspace?{workspaceEpoch:capturedWorkspace.workspaceEpoch}:{})},expected,options.signal,timeoutMs);
        if(capturedWorkspace&&result.workspaceEpoch!==capturedWorkspace.workspaceEpoch)throw abortError();
        if(!Number.isInteger(result.status)||result.status<200||result.status>599||result.status>=300&&result.status<400&&result.status!==304)throw new TypeError('리디렉션 또는 잘못된 서버 응답을 거부했습니다.');
        const safe=new Headers();for(const [key,val] of Object.entries(result.headers||{}))if(responseHeaders.has(key.toLowerCase()))safe.set(key,String(val));
        const decoded=decode(result.bodyBase64,RESPONSE_LIMIT);
        if(result.status===401&&!transition){announceScope('unauthenticated');if(capturedWorkspace)root.dispatchEvent(new CustomEvent('fountain-workspace-auth-required',{detail:{accountBinding:capturedWorkspace.accountBinding}}));}
        return new Response([204,205,304].includes(result.status)?null:decoded,{status:result.status,headers:safe});
      };
      const wire=async()=>{
        const body=(await bytes(options.body,REQUEST_LIMIT)).slice();if(!current(expected)||options.signal?.aborted)throw abortError();
        if(!internal&&value!=='/api/session'&&outboxPaused){let rejectAbort;const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(abortError());});options.signal?.addEventListener('abort',rejectAbort,{once:true});try{if(options.signal?.aborted)throw abortError();await Promise.race([pauseGate,cancelled]);}finally{options.signal?.removeEventListener('abort',rejectAbort);}if(!current(expected)||options.signal?.aborted)throw abortError();}
        if(!internal&&configuration.outboxEnabled&&value!=='/api/session'&&root.FountainNativeStorage&&!root.FountainNativeRecovery?.active)await root.FountainNativeStorage.refreshAuth();
        return priorAuth.catch(()=>{}).then(()=>perform(body));
      };
      // Authentication serialization covers the private wire exchange only. Its storage barrier
      // may itself issue authenticated canonical GETs through the same serialization queue.
      const result=wire();if(transition)authTail=result.then(()=>{},()=>{});
      return result.then(async response=>{
        // A rejected binding is an authoritative negative HTTP result, never a
        // reason to read a cache that this logout has already revoked.
        const bindingConflict=value==='/api/session'&&method==='DELETE'&&response.status===409;
        if(!internal&&!bindingConflict&&root.FountainNativeStorage&&!root.FountainNativeRecovery?.active&&(value==='/api/session'||configuration.outboxEnabled&&response.ok&&(value==='/api/workspace'||/^\/api\/pages\/[^/?]+\/(collaboration|operations)$/.test(value)||/^\/api\/databases\/[^/?]+$/.test(value)))){
          let anonymous=null;if(value==='/api/session'&&['GET','DELETE'].includes(method)&&response.status===200)try{anonymous=anonymousSession(await response.clone().json());}catch{/* Invalid session bodies cannot bypass the storage error. */}
          try{await root.FountainNativeStorage.refreshAuth();}
          catch(error){
            if(!current(expected))throw abortError();
            if(anonymous&&publicScopeEpoch===expectedEpoch&&error?.code==='OUTBOX_IDENTITY_REQUIRED'&&root.FountainNativeStorage.ready===false&&['unknown','blocked'].includes(root.FountainNativeStorage.identityState)){
              // Deliver the real anonymous response first. No verified grant or
              // cache readiness is manufactured; the UI finishes only this scope.
              setTimeout(()=>{if(current(expected)&&publicScopeEpoch===expectedEpoch&&!options.signal?.aborted&&root.FountainNativeStorage?.ready===false&&['unknown','blocked'].includes(root.FountainNativeStorage.identityState))root.dispatchEvent(new CustomEvent('fountain-native-anonymous-session',{detail:{origin:expected.origin,generation:expected.generation,scopeEpoch:expectedEpoch,session:anonymous}}));},0);
            }else if(value!=='/api/session'||error?.code!=='OUTBOX_ACCESS_REQUIRED')throw error;
            // Resource recovery blocks cached business data, never the actual session response.
            else root.dispatchEvent(new CustomEvent('fountain-native-error',{detail:{message:'미전송 내용을 보관했습니다. 기기 저장을 다시 사용하기 전에 접근 권한을 확인해 주세요.'}}));
          }
          if(!current(expected))throw abortError();
        }
        if(!current(expected)||options.signal?.aborted)throw abortError();return response;
      });
    }
    function outboxDriver(){
      return Object.freeze({
        scope:()=>({...scope(),scopeEpoch:publicScopeEpoch}),current:expected=>current(expected)&&expected.scopeEpoch===publicScopeEpoch,
        pause(){if(!outboxPaused)pauseGate=new Promise(resolve=>releaseGate=resolve);outboxPaused=true;},resume(){outboxPaused=false;releaseGate?.();releaseGate=null;for(const source of sources)sourceWake.get(source)?.();},
        session:signal=>exchange('/api/session',{signal},true),
        async canonical(descriptor,signal){
          if(!descriptor||Object.keys(descriptor).sort().join(',')!=='id,kind'||typeof descriptor.id!=='string'||!descriptor.id||Array.from(descriptor.id).length>160)invalid();
          const encoded=encodeURIComponent(descriptor.id);let route;
          if(descriptor.kind==='workspace'&&descriptor.id==='workspace')route='/api/workspace';
          else if(descriptor.kind==='page')route='/api/pages/'+encoded+'/collaboration';
          else if(descriptor.kind==='database')route='/api/databases/'+encoded;
          else if(descriptor.kind==='attachment')route='/api/attachments/'+encoded+'/metadata';else invalid();
          const response=await exchange(route,{signal},true);
          if(![200,403,404].includes(response.status)){const error=new Error('현재 문서 권한을 확인하지 못했습니다.');error.status=response.status;throw error;}
          // Consume the protected native pipeline response, never forward its body as authority.
          await response.json();return response.status;
        }
      });
    }
    function events(value) {
      path(value);configured();if(workspace?.offline)throw new TypeError('인터넷 연결 후 작업공간을 다시 확인해 주세요.');const match=value.match(/^\/api\/pages\/([^/?]+)\/events$/);if(!match)invalid();
      const target=new EventTarget(),expected=scope();let closed=false,running=false,timer,abort,paused=false;
      const visible=()=>!closed&&!paused&&!outboxPaused&&root.document.visibilityState==='visible'&&root.navigator.onLine&&current(expected);
      const emit=(type,data)=>{if(visible())target.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));};
      const failure=()=>{if(visible()){const event=new Event('error');target.dispatchEvent(event);if(typeof target.onerror==='function')target.onerror(event);}};
      async function poll() {
        clearTimeout(timer);if(!visible()||running)return;running=true;abort=new AbortController();
        try {
          for(const [suffix,type] of [['collaboration','snapshot'],['presence','presence']]) {
            const response=await request('/api/pages/'+match[1]+'/'+suffix,{signal:abort.signal});if(!visible())return;
            const data=await response.json();if(!visible())return;
            if([401,403,404].includes(response.status)){emit('denied',{status:response.status,error:typeof data.error==='string'?data.error:'문서에 접근할 수 없습니다.'});target.close();return;}
            if(!response.ok)throw new Error('문서를 확인하지 못했습니다.');emit(type,data);
          }
        }catch(error){if(error.name!=='AbortError')failure();}
        finally{running=false;abort=null;if(visible())timer=setTimeout(poll,Math.max(250,pollInterval));}
      }
      function visibility(){if(!visible()){clearTimeout(timer);abort?.abort();}else poll();}
      const hide=()=>{paused=true;visibility();},show=()=>{paused=false;visibility();};
      target.close=()=>{if(closed)return;closed=true;clearTimeout(timer);abort?.abort();sources.delete(target);root.document.removeEventListener('visibilitychange',visibility);root.removeEventListener('online',visibility);root.removeEventListener('offline',visibility);root.removeEventListener('pagehide',hide);root.removeEventListener('pageshow',show);};
      Object.defineProperty(target,'readyState',{get:()=>closed?2:running?1:0});
      root.document.addEventListener('visibilitychange',visibility);for(const name of ['online','offline'])root.addEventListener(name,visibility);root.addEventListener('pagehide',hide);root.addEventListener('pageshow',show);sources.add(target);sourceWake.set(target,visibility);queueMicrotask(poll);return target;
    }
    function xhr(method,value) {
      path(value);configured();if(workspace?.offline)throw new TypeError('인터넷 연결 후 작업공간을 다시 확인해 주세요.');const expected=scope();if(method!=='PUT'||!/^\/api\/uploads\/[^/?]+\/chunks\?offset=(?:0|[1-9][0-9]*)$/.test(value))invalid();
      let sent=false,closed=false,controller;const headers=new Headers();
      const connection={status:0,responseText:'',timeout:45000,upload:{},
        setRequestHeader(key,val){if(sent)throw new DOMException('요청이 이미 시작되었습니다.','InvalidStateError');if(!requestHeaders.has(key.toLowerCase()))invalid();headers.set(key,val);},
        abort(){if(closed)return;closed=true;controller?.abort();connection.onabort?.(new Event('abort'));connection.onloadend?.(new Event('loadend'));},
        send(blob){
          if(sent)throw new DOMException('요청이 이미 시작되었습니다.','InvalidStateError');if(closed)return;if(!current(expected))throw abortError();sent=true;
          if(!(blob instanceof Blob)||blob.size===0||blob.size>CHUNK_SIZE||headers.get('content-type')?.toLowerCase()!=='application/octet-stream')invalid();
          controller=new AbortController();request(value,{method:'PUT',body:blob,headers,signal:controller.signal,timeoutMs:connection.timeout}).then(async response=>{
            const text=await response.text();if(closed)return;if(!current(expected)){connection.abort();return;}connection.status=response.status;connection.responseText=text;
            // Native acknowledges a complete chunk; this is not socket byte progress.
            if(response.ok)connection.upload.onprogress?.({lengthComputable:true,loaded:blob.size,total:blob.size,acknowledged:true});
            if(closed)return;closed=true;connection.onload?.(new Event('load'));connection.onloadend?.(new Event('loadend'));
          }).catch(error=>{if(closed)return;closed=true;if(error.name==='TimeoutError')connection.ontimeout?.(new Event('timeout'));else if(error.name==='AbortError')connection.onabort?.(new Event('abort'));else connection.onerror?.(new Event('error'));connection.onloadend?.(new Event('loadend'));});
        }
      };return connection;
    }
    async function download(value,name='fountain-download',options={}) {
      path(value,'download');configured();if(workspace?.offline)throw new TypeError('인터넷 연결 후 작업공간을 다시 확인해 주세요.');filename(name);const expected=scope(),capturedWorkspace=workspace,wirePath=routed(value,capturedWorkspace);const result=await invoke('download',{path:wirePath,filename:name,...(capturedWorkspace?{workspaceEpoch:capturedWorkspace.workspaceEpoch}:{})},expected,options.signal);
      if(capturedWorkspace&&result.workspaceEpoch!==capturedWorkspace.workspaceEpoch)throw abortError();if(result.saved!==true)throw new Error('파일 내보내기를 완료하지 않았습니다.');return result;
    }
    async function saveData(name,content,mime='text/plain') {
      configured();filename(name);const expected=scope(),body=await bytes(content,EXPORT_LIMIT);if(!current(expected))throw abortError();
      const result=await invoke('saveData',{filename:name,bodyBase64:base64(body),...(expected.workspace?{workspaceEpoch:expected.workspace.workspaceEpoch}:{})},expected);if(expected.workspace&&result.workspaceEpoch!==expected.workspace.workspaceEpoch)throw abortError();if(result.saved!==true)throw new Error('파일 내보내기를 완료하지 않았습니다.');return result;
    }
    function downloadURL(value){path(value,'download');configured();const token=id();downloadLinks.set(token,{path:value,scope:scope()});while(downloadLinks.size>4096)downloadLinks.delete(downloadLinks.keys().next().value);const url=new URL(root.location.href);url.hash='fountain-download/'+token;return url.href;}
    function shareOrigin(primaryOrigin){
      const primary=primaryFrontend(primaryOrigin);if(primary!==null)return primary;
      const backend=new URL(configuration.origin);
      return !backend.port&&/^[a-z0-9]{20}\.supabase\.co$/.test(backend.hostname)?null:configuration.origin;
    }
    function publicURL(value,primaryOrigin){
      const validated=path(value,'public');configured();
      // The OS browser has its own parent cookie. It must open this workspace
      // through its own grant, rather than receiving the native child binding.
      if(workspace){const match=/^\/(forms|sites)\/([A-Za-z0-9_-]{1,160})$/.exec(validated);if(!match)invalid();const route=helper().navigation((match[1]==='forms'?'form/':'site/')+match[2],workspace),origin=shareOrigin(primaryOrigin);return origin===null?null:origin+'/#'+route;}
      const origin=shareOrigin(primaryOrigin);return origin===null?null:new URL(validated,origin).href;
    }
    function publicShareURL(value,primaryOrigin){return publicURL(value,primaryOrigin);}
    function appURL(route='home') {
      configured();if(typeof route!=='string'||! /^(home|page\/[^/]+|database\/[^/]+)$/.test(route)||/[\\\u0000-\u0020\u007f#?]/.test(route))invalid();path('/'+route,'app');return configuration.origin+'/#'+(workspace?helper().navigation(route,workspace):route);
    }
    function shareURL(route='home',primaryOrigin) {
      appURL(route);const origin=shareOrigin(primaryOrigin);
      return origin===null?null:origin+'/#'+(workspace?helper().navigation(route,workspace):route);
    }
    function workspaceScope(){return workspace;}
    function previousWorkspaceScopes(){return Object.freeze(workspaceHints.flatMap(hint=>{try{return[helper().validate(hint)];}catch{return[];}}));}
    function previousWorkspaceScope(workspaceId){if(workspaceId!==undefined)return previousWorkspaceScopes().find(hint=>hint.workspaceId===workspaceId)||null;if(!workspaceHint)return null;try{return helper().validate(workspaceHint);}catch{return null;}}
    function fenceWorkspace(){workspaceSerial++;cancelCalls();announceScope('workspace');}
    function parkWorkspace(){
      const old=workspace;fenceWorkspace();workspace=null;
      const prior=workspaceTail;
      const result=prior.catch(()=>{}).then(async()=>{
        await root.FountainNativeStorage?.park?.();root.FountainNativeStorage=null;
        if(configuration.workspaceVersion===1&&old)await bridge.parkWorkspace({generation:configuration.generation,workspaceEpoch:old.workspaceEpoch});
      });workspaceTail=result.catch(()=>{});return result;
    }
    async function useLegacyWorkspace(input){
      if(!input||Object.keys(input).join(',')!=='accountDirectoryAbsent'||input.accountDirectoryAbsent!==true||workspace||scopedUsed)invalid();
      if(configuration.workspaceVersion!==1)return null;
      await parkWorkspace();legacyMode=true;
      try{const response=await exchange('/api/session',{},true);if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('작업공간 로그인 상태를 확인하지 못했습니다.'),{status:response.status});}}
      catch(error){if(!isNetworkUnavailable(error))throw error;}
      // Unreachable HTTP cannot invent a session. Existing native storage below
      // still validates its private retained grant before cached data is opened.
      if(configuration.outboxEnabled&&root.FountainNativeOutbox){const storage=root.FountainNativeOutbox.create(bridge,{origin:configuration.origin,generation:configuration.generation,driver:outboxDriver(),confirm:summary=>root.FountainNativeRecovery?.confirmReconciliation(summary)??Promise.resolve(false)});root.FountainNativeStorage=storage;try{await storage.initialize();}catch(error){if(error?.code!=='OUTBOX_IDENTITY_REQUIRED')throw error;}}
      return null;
    }
    function setWorkspace(input){return activateWorkspace(input,false);}
    function setWorkspaceOffline(input){return activateWorkspace(input,true);}
    function isNetworkUnavailable(error){return error?.code==='NATIVE_NETWORK_UNREACHABLE';}
    function activateWorkspace(input,offline){
      const requested=helper().validate(input),ticket=workspaceSerial+1;legacyMode=false;scopedUsed=true;
      const parked=parkWorkspace();
      const result=parked.then(async()=>{
        if(ticket!==workspaceSerial)throw abortError();if(configuration.workspaceVersion!==1)throw new Error('여러 작업공간을 지원하는 앱 업데이트가 필요합니다.');
        const expectedGeneration=configuration.generation,reply=offline?await Promise.resolve().then(()=>bridge.resumeWorkspaceOffline({generation:expectedGeneration,workspace_id:requested.workspaceId,member_id:requested.memberId,session_binding:requested.binding,account_binding:requested.accountBinding,expires_at_ms:requested.expiresAt})).catch(error=>{throw nativeFailure(error);}):await invoke('activateWorkspace',{workspace_id:requested.workspaceId,session_binding:requested.binding,account_binding:requested.accountBinding,timeoutMs:45000},scope(),null,45000);
        if(offline&&reply?.offline!==true)throw abortError();
        if(ticket!==workspaceSerial||configuration.generation!==expectedGeneration||reply?.generation!==expectedGeneration||!Number.isSafeInteger(reply.workspaceEpoch))throw abortError();
        const verified=helper().validate({...reply.workspace,workspaceEpoch:reply.workspaceEpoch});
        if(verified.workspaceId!==requested.workspaceId||verified.memberId!==requested.memberId||verified.binding!==requested.binding||verified.accountBinding!==requested.accountBinding||verified.expiresAt!==requested.expiresAt)throw abortError();
        const checked=helper().fromSession(reply.workspace.session,reply.workspaceEpoch);if(!helper().same(verified,checked))throw abortError();workspace=Object.freeze({...verified,...(offline?{offline:true}:{})});workspaceHint=verified;workspaceHints=[...workspaceHints.filter(hint=>hint.accountBinding===verified.accountBinding&&hint.workspaceId!==verified.workspaceId),verified].slice(-100);
        if(configuration.outboxEnabled&&root.FountainNativeOutbox){const storage=root.FountainNativeOutbox.create(bridge,{origin:configuration.origin,generation:configuration.generation,workspaceEpoch:workspace.workspaceEpoch,driver:outboxDriver(),confirm:summary=>root.FountainNativeRecovery?.confirmReconciliation(summary)??Promise.resolve(false)});root.FountainNativeStorage=storage;await storage.initialize();}
        if(ticket!==workspaceSerial)throw abortError();return workspace;
      });workspaceTail=result.catch(()=>{});return result;
    }
    function capture(){const expected=scope();const check=()=>{if(!current(expected))throw abortError();};const api={};for(const name of ['request','events','xhr','apiURL','downloadURL','appURL','shareURL','publicURL','publicShareURL','download','saveData']){const fn={request,events,xhr,apiURL,downloadURL,appURL,shareURL,publicURL,publicShareURL,download,saveData}[name];api[name]=(...args)=>{check();return fn(...args);};}return Object.freeze({...api,native:true,origin:expected.origin,generation:expected.generation,scopeEpoch:publicScopeEpoch,outboxEnabled:configuration.outboxEnabled,workspaceScope:()=>expected.workspace,current:()=>current(expected),recoveryRequest(method,payload){
      check();if(!['recoveryInventory','recoveryExport'].includes(method)||!payload||payload.generation!==expected.generation||expected.workspace&&payload.workspaceEpoch!==expected.workspace.workspaceEpoch)invalid();
      return invoke(method,payload,expected,null,45000);
    }});}
    root.addEventListener('fountain-account-scope-changed',()=>{authGeneration++;void parkWorkspace().catch(()=>{});});
    root.document.addEventListener('click',event=>{
      const anchor=event.target.closest?.('a');if(!anchor)return;
      let url;try{url=new URL(anchor.href);}catch{return;}
      if(url.origin!==root.location.origin||url.pathname!==root.location.pathname||!url.hash.startsWith('#fountain-download/'))return;
      event.preventDefault();event.stopImmediatePropagation();const entry=downloadLinks.get(url.hash.slice('#fountain-download/'.length));if(!entry||!current(entry.scope))return;
      download(entry.path,anchor.download||'fountain-download').catch(error=>{if(error.name!=='AbortError')root.dispatchEvent(new CustomEvent('fountain-native-error',{detail:{message:error.message}}));});
    },true);
    return Object.freeze({native:true,get origin(){return configuration.origin;},get generation(){return configuration.generation;},get outboxVersion(){return configuration.outboxVersion;},get outboxEnabled(){return configuration.outboxEnabled;},get recoveryVersion(){return configuration.recoveryVersion;},get recoveryEnabled(){return configuration.recoveryEnabled;},get scopeEpoch(){return publicScopeEpoch;},get workspaceVersion(){return configuration.workspaceVersion;},workspaceScope,previousWorkspaceScope,previousWorkspaceScopes,setWorkspace,setWorkspaceOffline,isNetworkUnavailable,useLegacyWorkspace,parkWorkspace,capture,initialize,configure,apiURL,request,outboxDriver,events,xhr,download,saveData,downloadURL,publicURL,publicShareURL,appURL,shareURL});
  }
  root.FountainNativeTransport=Object.freeze({create,validateOrigin});
})(globalThis);
