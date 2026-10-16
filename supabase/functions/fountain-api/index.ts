import {createApplication} from '../_shared/application.ts';
import {errorResponse} from '../_shared/http.ts';
import {deployment} from './deployment.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):unknown};
function keys(name:string,fallback:string):string[]{
  const value=Deno.env.get(name);
  if(value){const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Invalid backend configuration');const values=Object.values(parsed);if(values.some(key=>typeof key!=='string'||!key))throw Error('Invalid backend configuration');return [...new Set([parsed.default,...values].filter(key=>typeof key==='string'))] as string[];}
  const legacy=Deno.env.get(fallback);if(!legacy)throw Error('Backend configuration is unavailable');return [legacy];
}
let loading:Promise<ReturnType<typeof createApplication>>|undefined;
async function application(){
  if(!loading)loading=(async()=>{
    const supabaseUrl=Deno.env.get('SUPABASE_URL');if(!supabaseUrl)throw Error('Backend configuration is unavailable');
    const publishableKey=keys('SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY')[0],secretKeys=keys('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY');
    const cryptoKeys=await Promise.all(secretKeys.map(async secret=>({secret,id:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)))).map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,24)})));
    const env:Record<string,string>={};
    for(const name of ['FOUNTAIN_AI_PROVIDER','FOUNTAIN_AI_URL','FOUNTAIN_AI_MODEL','FOUNTAIN_AI_KEY']){
      const value=Deno.env.get(name);if(value!==undefined)env[name]=value;
    }
    return createApplication({supabaseUrl,publishableKey,serviceKey:secretKeys[0],cryptoKeys,workspaceId:deployment.workspaceId,origins:deployment.webOrigins,setupEnabled:deployment.setupEnabled,env});
  })().catch(error=>{loading=undefined;throw error;});
  return loading;
}
Deno.serve(async request=>{try{return await (await application())(request);}catch(error){return errorResponse(error);}});
