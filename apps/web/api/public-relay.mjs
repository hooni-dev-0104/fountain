/** Presentation-only Node relay. No keys, database access or business rules.
 * Supabase Edge changes HTML's media type; only its explicit render marker may
 * restore it. Ordinary /api uploads and SSE bypass this function entirely.
 */
export const UPSTREAM='https://ehnovtfadpkwtubmwltl.supabase.co/functions/v1/fountain-api';
export const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const SLUG=/^[A-Za-z0-9_-]{1,160}$/,LIMIT=16*1024*1024;
const security=()=>new Headers({'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store','Vercel-CDN-Cache-Control':'no-store','x-vercel-enable-rewrite-caching':'0','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':CSP,'Cross-Origin-Resource-Policy':'same-origin','Vary':'Cookie, Origin, Accept, Sec-Fetch-Dest, Sec-Fetch-Mode'});
function failure(status){const headers=security();headers.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify({error:status===405?'Method not allowed':status===404?'Not found':'Public page is unavailable'}),{status,headers});}
function documentNavigation(request){
  if(request.method!=='GET')return false;
  const destination=request.headers.get('Sec-Fetch-Dest'),mode=request.headers.get('Sec-Fetch-Mode'),accept=request.headers.get('Accept');
  if(destination!==null&&destination!=='document'||mode!==null&&mode!=='navigate'||!accept||accept.length>8192)return false;
  // Explicit HTML only; wildcards, duplicate ranges and malformed/zero quality
  // never turn API/fetch error responses into a document login transition.
  const html=accept.split(',').map(value=>value.trim()).filter(value=>value.split(';',1)[0].trim().toLowerCase()==='text/html');
  if(html.length!==1)return false;
  const range=/^text\/html(?:\s*;\s*q\s*=\s*(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/i.exec(html[0]);
  return !!range&&(range[1]===undefined||Number(range[1])>0);
}
function target(request){
  const url=new URL(request.url);if(url.username||url.password||url.hash||url.pathname.length>1024||url.search.length>1024)return null;
  const direct=/^\/(sites|forms)\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname);
  if(direct&&!url.search)return '/'+direct[1]+'/'+direct[2];
  // Rewrites attach only these routing values; a caller cannot supply a URL,
  // alternate origin, nested path, query to the upstream, or duplicate values.
  if(url.pathname!=='/api/public-relay'&&!direct)return null;
  const values=url.searchParams,kind=values.get('kind'),slug=values.get('slug');
  if([...values.keys()].some(key=>!['kind','slug'].includes(key))||values.getAll('kind').length!==1||values.getAll('slug').length!==1||!['sites','forms'].includes(kind)||!SLUG.test(slug??''))return null;
  if(direct&&(direct[1]!==kind||direct[2]!==slug))return null;
  return '/'+kind+'/'+slug;
}
function forwarded(request){
  const headers=new Headers({'Accept':'text/html, application/json;q=0.9, text/plain;q=0.8','Accept-Encoding':'identity'});
  const cookie=request.headers.get('Cookie');
  if(cookie!==null){
    if(cookie.length>16384||/[^\x20-\x7e]/.test(cookie))throw Error();
    const session=cookie.split(';').map(value=>value.trim()).filter(value=>value.startsWith('fountain_session='));
    if(session.length>1||session.length===1&&!/^fountain_session=[A-Za-z0-9_-]{43}$/.test(session[0]))throw Error();
    if(session.length)headers.set('Cookie',session[0]);
  }
  const origin=request.headers.get('Origin');
  if(origin!==null){
    if(origin.length>1024)throw Error();const parsed=new URL(origin);
    if(parsed.origin!==origin||parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error();
    headers.set('Origin',origin);
  }
  return headers;
}
/** Constructor injection is for isolated tests only; no request/env upstream
 * override exists. Even injected transports receive this exact HTTPS URL.
 */
export function createPublicRelay({fetch:request=globalThis.fetch,timeoutMs=15000,maxBytes=LIMIT}={}){
  if(typeof request!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT)throw Error('Invalid relay configuration');
  return async function relay(incoming){
    if(!['GET','HEAD'].includes(incoming.method))return failure(405);
    const path=target(incoming);if(!path)return failure(404);
    let headers;try{headers=forwarded(incoming);}catch{return failure(400);}
    const abort=new AbortController(),signal=AbortSignal.any([incoming.signal,abort.signal]);
    let reader,finished=false;
    const timer=setTimeout(()=>abort.abort(),timeoutMs);
    function finish(){if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);}
    function cancel(){void reader?.cancel().catch(()=>{});finish();}
    signal.addEventListener('abort',cancel,{once:true});
    let upstream;
    try{upstream=await request(UPSTREAM+path,{method:incoming.method,headers,redirect:'manual',signal});}
    catch{finish();return failure(502);}
    if(signal.aborted||upstream.redirected||upstream.status>=300&&upstream.status<400||upstream.status!==200&&upstream.status<400){await upstream.body?.cancel().catch(()=>{});finish();return failure(502);}
    if(upstream.status===401&&documentNavigation(incoming)){
      await upstream.body?.cancel().catch(()=>{});finish();
      const headers=security();headers.set('Location','/#open-public='+encodeURIComponent(path));
      return new Response(null,{status:303,headers});
    }
    const resultHeaders=security(),mime=(upstream.headers.get('Content-Type')??'').split(';')[0].trim().toLowerCase();
    const html=upstream.status===200&&upstream.headers.get('X-Fountain-Format')==='html'&&['text/plain','text/html'].includes(mime);
    resultHeaders.set('Content-Type',html?'text/html; charset=utf-8':mime==='application/json'?'application/json; charset=utf-8':'text/plain; charset=utf-8');
    // No Set-Cookie/Location/provider CORS/cache headers are forwarded. The relay
    // never forwards an upstream redirect or grants access on a server's behalf.
    const length=upstream.headers.get('Content-Length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){await upstream.body?.cancel().catch(()=>{});finish();return failure(502);}
    if(incoming.method==='HEAD'||!upstream.body){await upstream.body?.cancel().catch(()=>{});finish();return new Response(null,{status:upstream.status,headers:resultHeaders});}
    reader=upstream.body.getReader();let consumed=0;
    const body=new ReadableStream({
      async pull(controller){
        try{
          if(signal.aborted)throw Error();const next=await reader.read();if(signal.aborted)throw Error();
          if(next.done){finish();reader.releaseLock();controller.close();return;}
          consumed+=next.value.byteLength;if(consumed>maxBytes)throw Error();controller.enqueue(next.value);
        }catch{await reader.cancel().catch(()=>{});finish();reader.releaseLock();controller.error(new Error('Public page stream interrupted'));}
      },
      async cancel(){abort.abort();await reader.cancel().catch(()=>{});finish();reader.releaseLock();}
    },{highWaterMark:0});
    return new Response(body,{status:upstream.status,headers:resultHeaders});
  };
}
export default {fetch:createPublicRelay()};
