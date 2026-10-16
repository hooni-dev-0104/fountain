/** Authorized document presence and bounded SSE. Realtime only wakes a fresh
 * canonical read; a change notification never supplies document data or access. */
import {Access,APIError} from './access.ts';
import type {AuthContext} from './auth.ts';
import type {CloudStore,StoreProvider} from './store.ts';
import {Workspace} from './core.ts';
import {Collaboration} from './collaboration.ts';
import {Authorization} from './authorization.ts';
import {createPresenceAdapter,createPublisherProofProvider} from './presence.ts';
import {createTransactions} from './transaction.ts';
import {createPageEvents} from './events.ts';
import {jsonResponse,readJSON} from './http.ts';
type Wake={wait:(signal:AbortSignal,timeoutMs:number)=>Promise<void>;close:()=>void};
type Config={supabaseUrl:string;serviceKey:string;provider:StoreProvider;authorize:()=>Promise<AuthContext>;fetch?:typeof fetch;realtime?:()=>Wake};
export function createActivity(config:Config){
  const presence=createPresenceAdapter({execute:createTransactions(config),proofProvider:createPublisherProofProvider(config)});
  const snapshot=(s:CloudStore,id:string)=>{const access=new Access(s,s.principal);return new Authorization(access).project('/api/pages/'+id+'/collaboration',new Collaboration(s,new Workspace(s)).snapshot(id,access));};
  return async(request:Request,path:string,context:AuthContext):Promise<Response|null>=>{
    const match=/^\/api\/pages\/([^/]+)\/(presence|events)$/.exec(decodeURIComponent(path));if(!match)return null;
    const id=match[1],method=request.method==='HEAD'?'GET':request.method;
    if(match[2]==='presence'){
      if(method==='GET')return jsonResponse(await presence.snapshot(context,id));
      if(method==='PUT')return jsonResponse(await presence.update(context,id,await readJSON(request)));
      if(method==='DELETE')return jsonResponse(await presence.leave(context,id,await readJSON(request)));
      throw new APIError(405,'Unsupported presence method');
    }
    if(method!=='GET')throw new APIError(405,'Unsupported event method');
    // HEAD verifies the resource but never leaves an unread streaming worker.
    if(request.method==='HEAD'){
      await presence.snapshotWithDocument(context,id,s=>snapshot(s,id));
      return new Response(null,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
    }
    let wake:Wake|undefined;
    try{
      wake=config.realtime?.();
      return await createPageEvents(request,{
        pollMs:5000,
        resolve:async signal=>{
          if(signal.aborted)throw new DOMException('Stream closed','AbortError');
          const value=await presence.snapshotWithDocument(context,id,s=>snapshot(s,id));
          if(signal.aborted)throw new DOMException('Stream closed','AbortError');
          return {snapshot:value.snapshot!,presence:value.presence};
        },
        ...(wake?{wait:wake.wait,onClose:wake.close}:{}),
      });
    }catch(error){wake?.close();throw error;}
  };
}
