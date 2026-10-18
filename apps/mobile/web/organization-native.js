/* Organization-only native entry. Cookies and workspace admission stay in the OS bridge. */
(function (root) {
  'use strict';
  const REQUEST_LIMIT=64*1024,RESPONSE_LIMIT=2*1024*1024;
  const invalid=()=>{throw new TypeError('허용되지 않는 조직 연결 요청입니다.');};
  const aborted=()=>new DOMException('조직 로그인 또는 연결 범위가 변경되었습니다.','AbortError');
  function origin(value){
    if(value===null)return null;
    if(typeof value!=='string'||!/^https:\/\/[^/?#]+\/?$/i.test(value)||/[\\\u0000-\u0020\u007f]/.test(value))invalid();
    let url;try{url=new URL(value);}catch{invalid();}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)invalid();return url.origin;
  }
  function path(value){
    if(typeof value!=='string'||value.length>16384||!value.startsWith('/api/organization/')||/[\\\u0000-\u0020\u007f#]/.test(value))invalid();
    const parts=value.split('?'),raw=parts.shift();
    for(const [index,part]of [raw,parts.join('?')].entries()){
      let decoded=part;
      for(let depth=0;depth<8;depth++){
        if(/[\\\u0000-\u001f\u007f]/.test(decoded))invalid();
        if(index===0&&(decoded.includes('//')||decoded.split('/').some(piece=>piece==='.'||piece==='..')||decoded.includes('?')||decoded.includes('#')))invalid();
        if(!/%[0-9a-f]{2}/i.test(decoded)){if(/%(?![0-9a-f]{2})/i.test(decoded)&&depth===0)invalid();break;}
        let next;try{next=decodeURIComponent(decoded);}catch{invalid();}
        if(index===0&&next.split('/').length!==decoded.split('/').length)invalid();
        decoded=next;if(depth===7)invalid();
      }
    }
    return value;
  }
  function encode(bytes){let binary='';for(let n=0;n<bytes.length;n+=32768)binary+=String.fromCharCode(...bytes.subarray(n,n+32768));return btoa(binary);}
  function decode(value){
    if(typeof value!=='string'||value.length%4!==0||value.length>Math.ceil(RESPONSE_LIMIT/3)*4)invalid();
    const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,end=value.length-padding;
    for(let i=0;i<end;i++){const c=value.charCodeAt(i);if(!(c>=65&&c<=90||c>=97&&c<=122||c>=48&&c<=57||c===43||c===47))invalid();}
    const size=value.length/4*3-padding;if(size>RESPONSE_LIMIT)invalid();
    let binary;try{binary=atob(value);}catch{invalid();}if(binary.length!==size)invalid();
    const result=Uint8Array.from(binary,c=>c.charCodeAt(0));if(encode(result)!==value)invalid();return result;
  }
  async function bodyBytes(body){
    if(body==null)return new Uint8Array();
    if(body instanceof Blob){if(body.size>REQUEST_LIMIT)throw new RangeError('조직 요청이 허용된 크기를 넘었습니다.');body=await body.arrayBuffer();}
    if(typeof body==='string'){if(body.length>REQUEST_LIMIT)throw new RangeError('조직 요청이 허용된 크기를 넘었습니다.');body=new TextEncoder().encode(body);}
    else if(body instanceof ArrayBuffer)body=new Uint8Array(body);
    else if(ArrayBuffer.isView(body))body=new Uint8Array(body.buffer,body.byteOffset,body.byteLength);else invalid();
    if(body.byteLength>REQUEST_LIMIT)throw new RangeError('조직 요청이 허용된 크기를 넘었습니다.');return body.slice();
  }
  function failure(error){
    const code=error?.code;
    if(['CANCELLED','SESSION_CHANGED','NATIVE_CANCELLED','NATIVE_STALE'].includes(code)||error?.name==='AbortError')return aborted();
    if(['TIMEOUT','NATIVE_TIMEOUT'].includes(code))return new DOMException('조직 요청 시간이 초과되었습니다.','TimeoutError');
    if(['NETWORK_ERROR','NATIVE_NETWORK','NATIVE_NETWORK_UNREACHABLE'].includes(code))return Object.assign(new TypeError('조직 서버에 연결하지 못했습니다.'),{code});
    return Object.assign(new Error('조직 연결 또는 보안 저장소를 확인해 주세요.'),{status:code==='NATIVE_SESSION_CONFLICT'?409:['INVALID_REQUEST','NATIVE_INVALID','NATIVE_SESSION_INVALID'].includes(code)?400:503});
  }
  function create(bridge){
    let configuration={origin:null,generation:0},epoch=0,serial=0,authTail=Promise.resolve(),initializing=null,initialized=false;
    const calls=new Map(),waiting=new Set();
    function cancel(){for(const stop of [...waiting])stop();for(const call of [...calls.values()])call();}
    function scope(){return {epoch,generation:configuration.generation,origin:configuration.origin};}
    function current(expected){return expected.epoch===epoch&&expected.generation===configuration.generation&&expected.origin===configuration.origin;}
    async function initialize(){
      if(initializing)return initializing;
      initializing=(async()=>{
        let value;try{value=await bridge.getConfiguration();}catch(error){throw failure(error);}
        if(!value||!Number.isSafeInteger(value.generation)||value.generation<configuration.generation)throw aborted();
        const next={origin:origin(value.origin),generation:value.generation};
        if(next.generation===configuration.generation&&configuration.origin!==null&&next.origin!==configuration.origin)throw aborted();
        if(next.generation!==configuration.generation||next.origin!==configuration.origin){if(initialized){epoch++;cancel();}configuration=next;}initialized=true;
        return {...configuration};
      })();try{return await initializing;}finally{initializing=null;}
    }
    function request(value,options={}){
      path(value);if(!options||typeof options!=='object'||Object.keys(options).some(key=>!['method','headers','body','signal','timeoutMs','redirect','credentials','cache'].includes(key)))invalid();
      if(options.credentials!==undefined&&options.credentials!=='same-origin'||options.cache!==undefined&&options.cache!=='no-store')invalid();
      const method=String(options.method||'GET').toUpperCase();if(!['GET','POST','PATCH','DELETE'].includes(method)||method==='GET'&&options.body!=null||options.redirect&&options.redirect!=='error')invalid();
      const headers=Object.create(null);for(const [name,value]of new Headers(options.headers)){
        if(!['content-type','x-fountain-request'].includes(name)||value.length>1024||/[\u0000-\u001f\u007f]/.test(value)||name==='x-fountain-request'&&value!=='1')invalid();if(name!=='x-fountain-request')headers[name]=value;
      }
      const timeoutMs=options.timeoutMs??45000;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)invalid();
      const transition=value==='/api/organization/session'&&['POST','DELETE'].includes(method);
      // Fence at invocation, including a prior request still waiting for configuration/body bytes.
      if(transition){epoch++;cancel();}
      const cross=/^\/api\/organization\/(?:setup-eligibility(?:\?|$)|organizations$|workspace-preview$|workspace-accept$)/.test(value);
      const crossEpoch=root.FountainTransport?.scopeEpoch;
      const crossCurrent=()=>!cross||crossEpoch===root.FountainTransport?.scopeEpoch;
      const requestedEpoch=epoch,prior=authTail;let stopped=false,rejectWaiting,abortWire;
      const interrupted=new Promise((_,reject)=>rejectWaiting=reject);
      const stop=(timeout=false)=>{if(stopped)return;stopped=true;abortWire?.();rejectWaiting(timeout?new DOMException('조직 요청 시간이 초과되었습니다.','TimeoutError'):aborted());};
      const onCancel=()=>stop(),deadline=setTimeout(()=>stop(true),timeoutMs);
      waiting.add(onCancel);options.signal?.addEventListener('abort',onCancel,{once:true});if(options.signal?.aborted)stop();
      const run=async()=>{
        await initialize();if(stopped||options.signal?.aborted||requestedEpoch!==epoch||!crossCurrent())throw aborted();
        const expected=scope(),body=await bodyBytes(options.body);if(stopped||!current(expected)||!crossCurrent()||options.signal?.aborted)throw aborted();
        await prior.catch(()=>{});if(stopped||!current(expected)||!crossCurrent()||options.signal?.aborted)throw aborted();
        if(!configuration.origin)throw Object.assign(new Error('워크스페이스로 돌아가 HTTPS 서버 주소를 먼저 설정해 주세요.'),{status:503});
        const id='organization_'+Date.now().toString(36)+'_'+(++serial);let finished=false,rejectAbort,timer;
        const interrupted=new Promise((_,reject)=>rejectAbort=reject);
        const stop=(timeout=false)=>{if(finished)return;finished=true;Promise.resolve().then(()=>bridge.organizationCancel({id,generation:expected.generation})).catch(()=>{});rejectAbort(timeout?new DOMException('조직 요청 시간이 초과되었습니다.','TimeoutError'):aborted());};
        const onAbort=()=>stop();abortWire=onAbort;calls.set(id,onAbort);options.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>stop(true),timeoutMs);
        try{
          const result=await Promise.race([Promise.resolve().then(()=>{if(finished||!current(expected))throw aborted();return bridge.organizationRequest({id,generation:expected.generation,path:value,method,headers,bodyBase64:encode(body),timeoutMs});}).catch(error=>{throw failure(error);}),interrupted]);
          if(finished||!current(expected)||!crossCurrent()||result?.generation!==expected.generation)throw aborted();
          if(!Number.isInteger(result.status)||result.status<200||result.status>599||result.status>=300&&result.status<400)invalid();
          if(!result.headers||typeof result.headers!=='object'||Array.isArray(result.headers))invalid();
          const safe=new Headers();for(const [name,value]of Object.entries(result.headers))if(['content-type','content-length'].includes(name.toLowerCase())){
            if(typeof value!=='string'||value.length>8192||/[\u0000-\u001f\u007f]/.test(value))invalid();safe.set(name,value);
          }
          const decoded=decode(result.bodyBase64),length=safe.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)!==decoded.length))invalid();
          if([204,205].includes(result.status)&&decoded.length)invalid();
          // This epoch belongs only to organization calls. No workspace scope event is emitted.
          if(result.status===401&&!transition){calls.delete(id);waiting.delete(onCancel);epoch++;cancel();}
          return new Response([204,205].includes(result.status)?null:decoded,{status:result.status,headers:safe});
        }finally{finished=true;clearTimeout(timer);calls.delete(id);options.signal?.removeEventListener('abort',onAbort);}
      };
      const result=Promise.race([run(),interrupted]).finally(()=>{waiting.delete(onCancel);clearTimeout(deadline);options.signal?.removeEventListener('abort',onCancel);});
      if(transition)authTail=result.then(()=>{},()=>{});return result;
    }
    return Object.freeze({native:true,request,initialize,get generation(){return configuration.generation;},get origin(){return configuration.origin;}});
  }
  root.FountainOrganizationNative=Object.freeze({create});
  const bridge=root.Capacitor?.registerPlugin?.('FountainNative')||root.Capacitor?.Plugins?.FountainNative;
  root.FountainOrganizationTransport=create(bridge||{getConfiguration:async()=>({origin:null,generation:0})});
})(globalThis);
