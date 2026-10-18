/** Supabase-only application composition. Shared services contain no actor;
 * every domain handler captures this request's cookie and reauthorizes it.
 * Health stays migration_in_progress until the full route cutover is verified.
 */
import {createAuth} from './auth.ts';
import type {AuthContext} from './auth.ts';
import {createAccountAuth} from './account-auth.ts';
import {createAccountSessionVault} from './account-vault.ts';
import {createAccountDirectory} from './account-directory.ts';
import {workspaceRoute,workspaceSession} from './workspace-account.ts';
import {createSessionVault} from './vault.ts';
import {createOrganizationAuth} from './organization-auth.ts';
import {createOrganizationSessionVault} from './organization-vault.ts';
import {createOrganizationPortal} from './organization-portal.ts';
import {createStoreProvider} from './store.ts';
import {createStorage,CHUNK_SIZE} from './storage.ts';
import {createOnboarding} from './onboarding.ts';
import {createBackend} from './backend.ts';
import {createDomain} from './domain.ts';
import {createAdminContent} from './admin-content.ts';
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
import {createInlineAttachmentSource} from './inline-attachments.ts';
type Config={supabaseUrl:string;publishableKey:string;serviceKey:string;cryptoKeys:Array<{id:string;secret:string|Uint8Array}>;workspaceId:string;origins:string[];publicWebOrigin?:string|null;fetch?:typeof fetch;env?:Record<string,string|undefined>;setupEnabled?:boolean;background?:(task:Promise<unknown>)=>void};
export function createApplication(config:Config):(request:Request)=>Promise<Response>{
  const connection={supabaseUrl:config.supabaseUrl,serviceKey:config.serviceKey,workspaceId:config.workspaceId,fetch:config.fetch};
  const onboarding=createOnboarding({...connection,publishableKey:config.publishableKey});
  const auth=createAuth({...connection,publishableKey:config.publishableKey,cryptoKeys:config.cryptoKeys,vault:createSessionVault(connection),...(config.setupEnabled?{setupClaim:onboarding.claim}:{})});
  const accountVault=createAccountSessionVault(connection);
  const accountConfig={...connection,publishableKey:config.publishableKey,cryptoKeys:config.cryptoKeys,vault:accountVault};
  const accountAuth=createAccountAuth(accountConfig);
  const accountDirectory=createAccountDirectory({...connection,auth:accountAuth,publicWebOrigin:config.publicWebOrigin,setupEnabled:config.setupEnabled,setup:async(body,cookie,workspaceId)=>{
    const target=createOnboarding({...connection,workspaceId:workspaceId??config.workspaceId,publishableKey:config.publishableKey});
    const setupAuth=createAccountAuth({...accountConfig,setupClaim:target.claim});
    const credentials={email:body.email,password:body.password,nonce:body.setup_nonce};
    return body.create_account?target.bootstrapCreate(credentials,input=>setupAuth.setup(input,cookie)):setupAuth.setup(credentials,cookie);
  }});
  const organizationAuth=createOrganizationAuth({...connection,publishableKey:config.publishableKey,cryptoKeys:config.cryptoKeys,vault:createOrganizationSessionVault(connection)});
  const organization=createOrganizationPortal({...connection,auth:organizationAuth,workspaceAuthorize:cookie=>auth.authorize(cookie),scopedWorkspaceAuthorize:(cookie,workspaceId,binding)=>accountDirectory.authorizeWorkspace(cookie??null,workspaceId,binding)});
  const env={...config.env};
  // The local process-wide SCIM secret is not a cloud credential. Cloud SCIM
  // resolves an explicitly issued grant through its own bearer-only boundary.
  delete env.FOUNTAIN_SCIM_TOKEN;
  const scim=createScimHTTP(connection);
  async function domain(current:Request,path:string,context:AuthContext,target:string,authorize:()=>Promise<AuthContext>){
      const connection={supabaseUrl:config.supabaseUrl,serviceKey:config.serviceKey,workspaceId:target,fetch:config.fetch};
      const onboarding=createOnboarding({...connection,publishableKey:config.publishableKey});
      const provider=createStoreProvider(connection),storage=createStorage({...connection,bucket:'fountain-files',maxObjectBytes:CHUNK_SIZE}),backupProvider=createBackupProvider(connection),inlineSource=createInlineAttachmentSource(connection);
      const backupJobProvider=createBackupJobProvider(connection),readSourceRange=createBackupSourceRangeReader({...connection,bucket:'fountain-files'});
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
      const contentResponse=await createAdminContent({...connection,provider,authorize}).handle(current,path,context);
      if(contentResponse)return contentResponse;
      const base={...connection,provider,authorize},files=createFiles({...base,storage,inlineSource,fenceGarbage:createUploadGarbageFence({...connection,authorize})});
      const events=createActivity({...base,...(config.serviceKey.startsWith('sb_secret_')?{realtime:()=>createRealtime({url:config.supabaseUrl,workspaceId:target,serverKey:config.serviceKey})}:{})});
      return createDomain({...base,extensions:[createAdvancedExtension({cloud:true,env,...('accountBinding' in context?{publicWorkspaceScope:{workspaceId:target,memberId:context.profile.member.id,binding:context.cacheBinding,accountBinding:(context as import('./workspace-account.ts').AccountWorkspaceContext).accountBinding,expiresAt:context.expiresAt}}:{})})],ai:createAI({...base,env}),files:files.handle,events})(current,path,context);
  }
  return async request=>createBackend({
    origins:config.origins,publicWebOrigin:config.publicWebOrigin,auth:async()=>auth,setupEnabled:config.setupEnabled,scim,
    account:async(current,path)=>{
      const response=await accountDirectory.handle(current,path);
      if(response){if(config.background){const task=accountAuth.maintain(2).catch(()=>undefined);try{config.background(task);}catch{}}return response;}
      const route=workspaceRoute(path);if(!route)return null;
      const cookie=current.headers.get('Cookie'),authorize=()=>accountDirectory.authorizeWorkspace(cookie,route.workspaceId,route.binding);
      const context=await authorize();
      if(route.path==='/api/session'){
        if(!['GET','HEAD'].includes(current.method))throw new HttpError(405,'작업공간 선택은 계정 화면에서 변경해주세요.');
        if(new URL(current.url).search)throw new HttpError(400,'Invalid workspace session query');
        return jsonResponse({...workspaceSession(context),...(config.publicWebOrigin?{public_web_origin:config.publicWebOrigin}:{})});
      }
      let result:Response;
      try{result=await domain(current,route.path,context,route.workspaceId,authorize);}
      catch(error){
        // Legacy domain adapters collapse SQL 403 into 401. Recheck the captured
        // parent before classifying a child race, so one workspace cannot log
        // out every active/parked workspace belonging to a valid account.
        if(error&&typeof error==='object'&&'status' in error&&error.status===401){
          const parent=await accountAuth.authorize(cookie);
          if(parent.hash!==context.parentHash||parent.cacheBinding!==context.accountBinding)throw new HttpError(409,'계정 로그인이 변경되었습니다.','ACCOUNT_SESSION_CHANGED');
          throw new HttpError(403,'작업공간 권한을 확인해주세요.','WORKSPACE_ACCESS_REQUIRED');
        }
        throw error;
      }
      try{await authorize();}catch(error){await result.body?.cancel().catch(()=>{});throw error;}
      return result;
    },
    organization:async(current,path)=>{
      const response=await organization.handle(current,path);
      // Provider retries run outside database locks and never delay a response.
      if(response&&config.background){const task=organizationAuth.maintain(2).catch(()=>undefined);try{config.background(task);}catch{/* A rejected background scheduler cannot replace an acknowledged response. */}}
      return response;
    },
    setupCreate:(body,cookie)=>onboarding.bootstrapCreate(body,input=>auth.setup(input,cookie)),
    domain:(current,path,context)=>domain(current,path,context,config.workspaceId,()=>auth.authorize(current.headers.get('Cookie'))),
  })(request);
}
