/** Supabase-only application composition. Shared services contain no actor;
 * every domain handler captures this request's cookie and reauthorizes it.
 * Health stays migration_in_progress until the full route cutover is verified.
 */
import {createAuth} from './auth.ts';
import {createSessionVault} from './vault.ts';
import {createStoreProvider} from './store.ts';
import {createStorage,CHUNK_SIZE} from './storage.ts';
import {createOnboarding} from './onboarding.ts';
import {createBackend} from './backend.ts';
import {createDomain} from './domain.ts';
import {createAdvancedExtension} from './advanced.ts';
import {createFiles} from './files.ts';
import {createUploadGarbageFence} from './gc-fence.ts';
import {createActivity} from './activity.ts';
import {createRealtime} from './realtime.ts';
import {createAI} from './ai.ts';
import {createAccounts} from './accounts.ts';
import {createGrantAdmin} from './grant-admin.ts';
import {createScimHTTP} from './scim-http.ts';
import {createBackup,createBackupProvider} from './backup.ts';
import {createBackupJobs,createBackupJobProvider,createBackupSourceRangeReader,collectBackupJobGarbage} from './backup-jobs.ts';
import {HttpError,jsonResponse,readJSON} from './http.ts';
type Config={supabaseUrl:string;publishableKey:string;serviceKey:string;cryptoKeys:Array<{id:string;secret:string|Uint8Array}>;workspaceId:string;origins:string[];publicWebOrigin?:string|null;fetch?:typeof fetch;env?:Record<string,string|undefined>;setupEnabled?:boolean};
export function createApplication(config:Config):(request:Request)=>Promise<Response>{
  const connection={supabaseUrl:config.supabaseUrl,serviceKey:config.serviceKey,workspaceId:config.workspaceId,fetch:config.fetch};
  const onboarding=createOnboarding({...connection,publishableKey:config.publishableKey});
  const auth=createAuth({...connection,publishableKey:config.publishableKey,cryptoKeys:config.cryptoKeys,vault:createSessionVault(connection),...(config.setupEnabled?{setupClaim:onboarding.claim}:{})});
  const provider=createStoreProvider(connection),storage=createStorage({...connection,bucket:'fountain-files',maxObjectBytes:CHUNK_SIZE}),backupProvider=createBackupProvider(connection);
  const backupJobProvider=createBackupJobProvider(connection),readSourceRange=createBackupSourceRangeReader({...connection,bucket:'fountain-files'});
  const env={...config.env};
  // The local process-wide SCIM secret is not a cloud credential. Cloud SCIM
  // resolves an explicitly issued grant through its own bearer-only boundary.
  delete env.FOUNTAIN_SCIM_TOKEN;
  const scim=createScimHTTP(connection);
  return async request=>createBackend({
    origins:config.origins,publicWebOrigin:config.publicWebOrigin,auth:async()=>auth,setupEnabled:config.setupEnabled,scim,
    setupCreate:(body,cookie)=>onboarding.bootstrapCreate(body,input=>auth.setup(input,cookie)),
    domain:async(current,path,context)=>{
      const authorize=()=>auth.authorize(current.headers.get('Cookie'));
      if(path==='/api/session/renew-local')throw new HttpError(400,'클라우드에서는 계정으로 다시 로그인해주세요.','LOCAL_SESSION_UNSUPPORTED');
      if(path==='/api/accounts/invite'&&current.method==='POST'){
        if(!config.setupEnabled)throw new HttpError(503,'계정 연결 설정이 아직 준비되지 않았습니다.','SETUP_UNAVAILABLE');
        const body=await readJSON(current);
        return jsonResponse(await onboarding.invite(context,body),201);
      }
      const accounts=createAccounts({...connection,authorize}),accountResponse=await accounts.handle(current,path,context);
      if(accountResponse)return accountResponse;
      const grantResponse=await createGrantAdmin({...connection,authorize,origins:config.origins}).handle(current,path,context);
      if(grantResponse)return grantResponse;
      const jobConfig={provider:backupJobProvider,storage,authorize,readSourceRange};
      if(path==='/api/backup/jobs'&&current.method==='POST')await collectBackupJobGarbage(jobConfig,context,1);
      const jobResponse=await createBackupJobs(jobConfig).handle(current,path,context);
      if(jobResponse)return jobResponse;
      const backup=createBackup({provider:backupProvider,storage,authorize}),backupResponse=await backup.handle(current,path,context);
      if(backupResponse)return backupResponse;
      const base={...connection,provider,authorize},files=createFiles({...base,storage,fenceGarbage:createUploadGarbageFence({...connection,authorize})});
      const events=createActivity({...base,...(config.serviceKey.startsWith('sb_secret_')?{realtime:()=>createRealtime({url:config.supabaseUrl,workspaceId:config.workspaceId,serverKey:config.serviceKey})}:{})});
      return createDomain({...base,extensions:[createAdvancedExtension({cloud:true,env})],ai:createAI({...base,env}),files:files.handle,events})(current,path,context);
    },
  })(request);
}
