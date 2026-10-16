/** Cloud entry boundary. Domain routes are installed only after their parity tests pass. */
import {HttpError,canonicalOrigin,checkRequest,errorResponse,jsonResponse,preflight,readJSON,requestPath} from './http.ts';
import type {AuthResult,AuthContext} from './auth.ts';
export type AuthBoundary={login(body:unknown,cookie?:string|null):Promise<AuthResult>;session(cookie?:string|null):Promise<AuthResult>;logout(cookie?:string|null,options?:{expectedBinding?:string}):Promise<AuthResult>;authorize?:(cookie?:string|null)=>Promise<AuthContext>};
type Config={origins:string[];auth:()=>Promise<AuthBoundary>;domain?:(request:Request,path:string,context:AuthContext)=>Promise<Response>};
export function createBackend(config:Config):(request:Request)=>Promise<Response> {
  const origins=new Set(config.origins.map(canonicalOrigin));
  async function serve(request:Request):Promise<Response>{
    const path=requestPath(request);checkRequest(request,origins);
    if(request.method==='OPTIONS')return preflight(request,origins);
    if(path==='/health'&&['GET','HEAD'].includes(request.method))return jsonResponse({service:'fountain',backend:'supabase',status:'migration_in_progress',ready:false});
    const auth=await config.auth(),cookie=request.headers.get('Cookie');
    if(path==='/api/session'){
      let result:AuthResult;
      if(['GET','HEAD'].includes(request.method))result=await auth.session(cookie);
      else if(request.method==='POST')result=await auth.login(await readJSON(request),cookie);
      else if(request.method==='DELETE'){
        const body=await readJSON(request);
        if(Object.keys(body).some(key=>key!=='cache_binding')||Object.hasOwn(body,'cache_binding')&&(typeof body.cache_binding!=='string'||!body.cache_binding||body.cache_binding.length>1000))throw new HttpError(400,'Invalid logout binding');
        result=await auth.logout(cookie,body.cache_binding?{expectedBinding:body.cache_binding as string}:undefined);
      }else throw new HttpError(405,'Unsupported session method');
      return jsonResponse(result.body,result.status,result.setCookie?{'Set-Cookie':result.setCookie}:{});
    }
    // Keep the unlinked, unauthenticated candidate closed during migration.
    // A health/auth deployment does not mean that the legacy domain is migrated.
    if(config.domain){if(!auth.authorize)throw new HttpError(503,'Backend authorization is unavailable.','AUTH_UNAVAILABLE');return config.domain(request,path,await auth.authorize(cookie));}
    const result=await auth.session(cookie);
    if(result.body.authenticated!==true)throw new HttpError(401,'로그인이 필요합니다.','AUTH_REQUIRED');
    throw new HttpError(503,'백엔드 전환 검증을 진행하고 있습니다. 기존 앱에서 계속 사용해 주세요.','BACKEND_MIGRATION_IN_PROGRESS');
  }
  return async request=>{
    let response:Response;try{response=await serve(request);}catch(error){response=errorResponse(error);}
    if(request.method==='HEAD')return new Response(null,{status:response.status,headers:response.headers});
    return response;
  };
}
