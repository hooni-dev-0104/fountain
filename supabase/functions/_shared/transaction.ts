/** Execute a pure domain action over a fresh, authorized cloud snapshot.
 * Handlers may stage database changes only. Network calls and publication must
 * use a separate receipt/intent after this boundary acknowledges its commit.
 */
import {AuthError} from './auth.ts';
import type {AuthContext} from './auth.ts';
import {CloudStore,MissingSelection,StoreError,canonicalJSON,mergeSelection,normalizeSelection} from './store.ts';
import type {Selection,StoreContext,StoreProvider} from './store.ts';

export function storeContext(auth:AuthContext):StoreContext {
  return {workspaceId:auth.profile.workspaceId,memberId:auth.profile.member.id,userId:auth.userId,authSessionId:auth.authSessionId,sessionHash:auth.hash,cacheBinding:auth.cacheBinding};
}
type Config={provider:StoreProvider;authorize:()=>Promise<AuthContext>;clock?:()=>number;maxSelectionRounds?:number;maxConflicts?:number};
export function createTransactions(config:Config){
  const rounds=config.maxSelectionRounds??64,conflicts=config.maxConflicts??3;
  if(!Number.isInteger(rounds)||rounds<1||rounds>128||!Number.isInteger(conflicts)||conflicts<1||conflicts>5)throw new Error('Invalid cloud transaction configuration');
  return async function execute<T>(initial:AuthContext,action:(store:CloudStore)=>T,selection:Selection={}):Promise<{value:T;revision:number}>{
    const original=canonicalJSON(storeContext(initial)),clockValue=(config.clock??Date.now)();
    let selected=mergeSelection({kinds:['group']},selection),collisions=0;
    for(let count=0;count<rounds;count++){
      // A replay never inherits a cached role or a newly logged-in account.
      const current=await config.authorize(),context=storeContext(current);
      if(canonicalJSON(context)!==original)throw new AuthError(401,'AUTH_REQUIRED','로그인 세션이 변경되었습니다. 다시 시도해 주세요.');
      let store:CloudStore;
      try{store=await CloudStore.open(config.provider,context,selected,{clock:()=>clockValue});}
      catch(error){if(error instanceof StoreError&&error.code==='REVISION_CONFLICT'&&++collisions<conflicts)continue;throw error;}
      let value:T;
      try{value=store.transaction(()=>action(store));}
      catch(error){
        if(!(error instanceof MissingSelection))throw error;
        const expanded=mergeSelection(selected,error.selection);
        if(canonicalJSON(expanded)===canonicalJSON(normalizeSelection(selected)))throw new StoreError(503,'SELECTION_STALLED','Workspace selection could not be completed');
        selected=expanded;continue;
      }
      try{
        let committed:{revision:number};
        try{committed=await store.commit();}
        catch(error){
          // An unknown acknowledgement may already have committed. Retry the
          // SAME transaction id/digest; never rerun the action in this state.
          if(store.state!=='uncertain')throw error;
          committed=await store.commit();
        }
        return {value,revision:committed.revision};
      }catch(error){
        if(error instanceof StoreError&&error.code==='REVISION_CONFLICT'&&++collisions<conflicts)continue;
        throw error;
      }
    }
    throw new StoreError(503,'SELECTION_LIMIT','Workspace selection needs too many reads');
  };
}
