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
    if(code==='OUTBOX_ACCESS_REQUIRED')return Object.assign(new Error('보관된 내용의 접근 권한을 다시 확인해야 합니다. 미전송 내용은 유지했습니다.'),{code,status:503});
    if(['NETWORK_ERROR','NATIVE_NETWORK'].includes(code))return Object.assign(new TypeError('서버에 연결하지 못했습니다.'),{code});
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
    let configuration={origin:null,generation:0,outboxVersion:0,outboxEnabled:false,recoveryVersion:0,recoveryEnabled:false},authGeneration=0,configurationFence=0,publicScopeEpoch=0,authTail=Promise.resolve(),serial=0;
    const calls=new Map(),sources=new Set(),downloadLinks=new Map();
    const id=()=>`mobile_${Date.now().toString(36)}_${++serial}`;
    function configured(){if(!configuration.origin)throw new Error('먼저 HTTPS 서버 주소를 설정해 주세요.');}
    function announceScope(reason){publicScopeEpoch++;root.dispatchEvent(new CustomEvent('fountain-native-scope-changed',{detail:{scopeEpoch:publicScopeEpoch,reason}}));}
    function setConfiguration(value) {
      if(!value||!Number.isSafeInteger(value.generation)||value.generation<configuration.generation)invalid();
      const previous=configuration;
      configuration={origin:value.origin===null?null:validateOrigin(value.origin),generation:value.generation,
        outboxVersion:value.outboxVersion===1?1:0,outboxEnabled:value.outboxVersion===1&&value.outboxEnabled===true,
        recoveryVersion:value.recoveryVersion===1?1:0,recoveryEnabled:value.recoveryVersion===1&&value.recoveryEnabled===true};
      if(previous.origin!==configuration.origin||previous.generation!==configuration.generation
          ||previous.recoveryVersion!==configuration.recoveryVersion||previous.recoveryEnabled!==configuration.recoveryEnabled)announceScope('configuration');
      return {...configuration};
    }
    function cancelCalls() {
      for(const call of calls.values())call.abort();for(const source of [...sources])source.close();downloadLinks.clear();
    }
    function scope(){return {generation:configuration.generation,auth:authGeneration,fence:configurationFence,origin:configuration.origin};}
    function current(expected){return expected.generation===configuration.generation&&expected.auth===authGeneration&&expected.fence===configurationFence&&expected.origin===configuration.origin;}
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
      }catch(error){throw nativeFailure(error);}
      finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);calls.delete(callId);}
    }
    async function initialize(){const fence=configurationFence,result=await bridge.getConfiguration();if(fence!==configurationFence)throw abortError();return setConfiguration(result);}
    async function configure(input) {
      const origin=validateOrigin(input?.origin),fence=++configurationFence;authGeneration++;cancelCalls();announceScope('configuration');
      const result=await bridge.configure({origin});if(fence!==configurationFence)throw abortError();return setConfiguration(result);
    }
    function apiURL(value){configured();return new URL(path(value),configuration.origin).href;}
    function request(value,options={}) {
      path(value);configured();const method=String(options.method||'GET').toUpperCase();if(!methods.has(method))invalid();
      if(options.redirect&&options.redirect!=='error')invalid();
      const headers=Object.create(null);for(const [key,val] of new Headers(options.headers)){if(!requestHeaders.has(key))invalid();headers[key]=val;}
      const timeoutMs=options.timeoutMs??45000;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)invalid();
      if(method==='GET'&&options.body!=null)invalid();
      const transition=value==='/api/session'&&['POST','DELETE'].includes(method);
      if(transition){authGeneration++;cancelCalls();announceScope('authentication');}
      const expected=scope();
      const perform=async()=>{
        if(!current(expected)||options.signal?.aborted)throw abortError();
        const body=await bytes(options.body,REQUEST_LIMIT);if(!current(expected)||options.signal?.aborted)throw abortError();
        const result=await invoke('request',{path:value,method,headers,bodyBase64:base64(body),timeoutMs},expected,options.signal,timeoutMs);
        if(!Number.isInteger(result.status)||result.status<200||result.status>599||result.status>=300&&result.status<400&&result.status!==304)throw new TypeError('리디렉션 또는 잘못된 서버 응답을 거부했습니다.');
        const safe=new Headers();for(const [key,val] of Object.entries(result.headers||{}))if(responseHeaders.has(key.toLowerCase()))safe.set(key,String(val));
        const decoded=decode(result.bodyBase64,RESPONSE_LIMIT);
        if(result.status===401&&!transition)announceScope('unauthenticated');
        if(value==='/api/session'&&['GET','POST','DELETE'].includes(method)&&root.FountainNativeStorage){
          try{await root.FountainNativeStorage.refreshAuth();}
          catch(error){
            if(!current(expected))throw abortError();
            if(error?.code!=='OUTBOX_ACCESS_REQUIRED')throw error;
            // Resource recovery blocks cached business data, never the actual session response.
            root.dispatchEvent(new CustomEvent('fountain-native-error',{detail:{message:'미전송 내용을 보관했습니다. 기기 저장을 다시 사용하기 전에 접근 권한을 확인해 주세요.'}}));
          }
          if(!current(expected))throw abortError();
        }
        return new Response([204,205,304].includes(result.status)?null:decoded,{status:result.status,headers:safe});
      };
      const result=authTail.catch(()=>{}).then(perform);
      if(transition)authTail=result.then(()=>{},()=>{});
      return result;
    }
    function events(value) {
      path(value);configured();const match=value.match(/^\/api\/pages\/([^/?]+)\/events$/);if(!match)invalid();
      const target=new EventTarget(),expected=scope();let closed=false,running=false,timer,abort,paused=false;
      const visible=()=>!closed&&!paused&&root.document.visibilityState==='visible'&&root.navigator.onLine&&current(expected);
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
      root.document.addEventListener('visibilitychange',visibility);for(const name of ['online','offline'])root.addEventListener(name,visibility);root.addEventListener('pagehide',hide);root.addEventListener('pageshow',show);sources.add(target);queueMicrotask(poll);return target;
    }
    function xhr(method,value) {
      path(value);configured();const expected=scope();if(method!=='PUT'||!/^\/api\/uploads\/[^/?]+\/chunks\?offset=(?:0|[1-9][0-9]*)$/.test(value))invalid();
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
      path(value,'download');configured();filename(name);const expected=scope();const result=await invoke('download',{path:value,filename:name},expected,options.signal);
      if(result.saved!==true)throw new Error('파일 내보내기를 완료하지 않았습니다.');return result;
    }
    async function saveData(name,content,mime='text/plain') {
      configured();filename(name);const expected=scope(),body=await bytes(content,EXPORT_LIMIT);if(!current(expected))throw abortError();
      const result=await invoke('saveData',{filename:name,bodyBase64:base64(body)},expected);if(result.saved!==true)throw new Error('파일 내보내기를 완료하지 않았습니다.');return result;
    }
    function downloadURL(value){path(value,'download');configured();const token=id();downloadLinks.set(token,{path:value,scope:scope()});while(downloadLinks.size>4096)downloadLinks.delete(downloadLinks.keys().next().value);const url=new URL(root.location.href);url.hash='fountain-download/'+token;return url.href;}
    function publicURL(value){configured();return new URL(path(value,'public'),configuration.origin).href;}
    function appURL(route='home') {
      configured();if(typeof route!=='string'||! /^(home|page\/[^/]+|database\/[^/]+)$/.test(route)||/[\\\u0000-\u0020\u007f#?]/.test(route))invalid();path('/'+route,'app');return configuration.origin+'/#'+route;
    }
    function shareURL(route='home') {
      const value=appURL(route),backend=new URL(configuration.origin);
      return !backend.port&&/^[a-z0-9]{20}\.supabase\.co$/.test(backend.hostname)?null:value;
    }
    root.document.addEventListener('click',event=>{
      const anchor=event.target.closest?.('a');if(!anchor)return;
      let url;try{url=new URL(anchor.href);}catch{return;}
      if(url.origin!==root.location.origin||url.pathname!==root.location.pathname||!url.hash.startsWith('#fountain-download/'))return;
      event.preventDefault();event.stopImmediatePropagation();const entry=downloadLinks.get(url.hash.slice('#fountain-download/'.length));if(!entry||!current(entry.scope))return;
      download(entry.path,anchor.download||'fountain-download').catch(error=>{if(error.name!=='AbortError')root.dispatchEvent(new CustomEvent('fountain-native-error',{detail:{message:error.message}}));});
    },true);
    return Object.freeze({native:true,get origin(){return configuration.origin;},get generation(){return configuration.generation;},get outboxVersion(){return configuration.outboxVersion;},get outboxEnabled(){return configuration.outboxEnabled;},get recoveryVersion(){return configuration.recoveryVersion;},get recoveryEnabled(){return configuration.recoveryEnabled;},get scopeEpoch(){return publicScopeEpoch;},initialize,configure,apiURL,request,events,xhr,download,saveData,downloadURL,publicURL,appURL,shareURL});
  }
  root.FountainNativeTransport=Object.freeze({create,validateOrigin});
})(globalThis);
