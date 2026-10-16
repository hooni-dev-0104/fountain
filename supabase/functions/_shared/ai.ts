/** Inference never holds a database transaction or stale login permission. */
import {Access,clone} from './access.ts';
import type {Entity} from './access.ts';
import type {AuthContext} from './auth.ts';
import {Authorization} from './authorization.ts';
import {Advanced,infer_ai} from './advanced.ts';
import {Workspace} from './core.ts';
import {createTransactions} from './transaction.ts';
import type {StoreProvider} from './store.ts';
type Config={provider:StoreProvider;authorize:()=>Promise<AuthContext>;env:Record<string,string|undefined>;fetch?:typeof fetch;clock?:()=>number};
export function createAI(config:Config){
  const execute=createTransactions(config);
  return async(body:Entity,context:AuthContext):Promise<Entity>=>{
    const prepared=await execute(context,store=>{
      const access=new Access(store,store.principal),authority=new Authorization(access,{ownerAccounts:'cloud-commit'});
      authority.prepare('POST','/api/ai',clone(body));
      return new Advanced(store,new Workspace(store,{access}),{access,env:config.env,cloud:true}).prepare_ai(clone(body));
    });
    // PreparedAI and provider credentials are server-only. Only the exact source
    // authorized above reaches the provider; later pages are never fetched here.
    const output=await infer_ai(prepared.value,config.fetch);
    const published=await execute(context,store=>{
      const access=new Access(store,store.principal),authority=new Authorization(access,{ownerAccounts:'cloud-commit'});
      authority.prepare('POST','/api/ai',{page_id:prepared.value.page_id});
      const result=new Advanced(store,new Workspace(store,{access}),{access,env:config.env,cloud:true}).finish_ai(prepared.value,output);
      return authority.project('/api/ai',result);
    });
    return published.value;
  };
}
