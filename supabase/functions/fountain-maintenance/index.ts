import {createMaintenanceTransport,maintenanceErrorResponse} from '../_shared/maintenance-transport.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):unknown};
let loaded:ReturnType<typeof createMaintenanceTransport>|undefined;
Deno.serve(async request=>{
 try{
  if(!loaded){
   const supabaseUrl=Deno.env.get('SUPABASE_URL'),raw=Deno.env.get('SUPABASE_SECRET_KEYS');let serviceKey:string|undefined;
   if(raw){const values=JSON.parse(raw);if(values&&typeof values==='object'&&!Array.isArray(values))serviceKey=typeof values.default==='string'?values.default:Object.values(values).find(value=>typeof value==='string') as string|undefined;}
   else serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
   if(!supabaseUrl||!serviceKey)throw Error('Maintenance configuration unavailable');loaded=createMaintenanceTransport({supabaseUrl,serviceKey});
  }
  return await loaded(request);
 }catch(error){return maintenanceErrorResponse(error);}
});
