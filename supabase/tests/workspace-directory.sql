-- Roll back together with the draft migrations. These are synthetic Auth rows,
-- not GoTrue/login/browser/concurrency evidence.
CREATE OR REPLACE FUNCTION pg_temp.workspace_expect(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $t$
DECLARE actual text;
BEGIN BEGIN EXECUTE statement;EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;END;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Expected %, received %: %',expected,COALESCE(actual,'success'),left(statement,100);END IF;
END $t$;
DO $test$
DECLARE uid uuid:=gen_random_uuid();sid uuid:=gen_random_uuid();uid2 uuid:=gen_random_uuid();sid2 uuid:=gen_random_uuid();uid3 uuid:=gen_random_uuid();sid3 uuid:=gen_random_uuid();
 ws text:='qa-dir-a-'||replace(gen_random_uuid()::text,'-','');ws2 text:='qa-dir-b-'||replace(gen_random_uuid()::text,'-','');
 h text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');h2 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');h3 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
 binding text:=replace(gen_random_uuid()::text,'-','');binding2 text:=replace(gen_random_uuid()::text,'-','');binding3 text:=replace(gen_random_uuid()::text,'-','');
 stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;cipher jsonb:='{"version":1,"keyId":"qa","iv":"AAAAAAAAAAAAAAAA","data":"AAAAAAAAAAAAAAAAAAAAAA"}';
 ctx jsonb;ctx2 jsonb;ctx3 jsonb;answer jsonb;a jsonb;b jsonb;again jsonb;private_ctx jsonb;store_ctx jsonb;invite jsonb;inv2 jsonb;
 command uuid:=gen_random_uuid();command2 uuid:=gen_random_uuid();invite_command uuid:=gen_random_uuid();accept_command uuid:=gen_random_uuid();
 code text:=repeat('c',64);expires_ms bigint:=stamp+600000;member2 text;target_email text;sel jsonb:='{"kinds":["member","settings","teamspace"],"ids":{},"metaKeys":["workspace_id"],"pageSize":100}';
 rel record;backup jsonb;rev bigint;canonical text;changes jsonb;
BEGIN
 target_email:='qa-dir-'||uid2||'@example.invalid';
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous) VALUES
 (uid,'authenticated','authenticated','qa-dir-'||uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false),
 (uid2,'authenticated','authenticated',target_email,clock_timestamp(),clock_timestamp(),clock_timestamp(),false),
 (uid3,'authenticated','authenticated','qa-dir-'||uid3||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false);
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after) VALUES(sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),(sid2,uid2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),(sid3,uid3,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 PERFORM public.fountain_cloud_account_session_vault('create',jsonb_build_object('row',jsonb_build_object('hash',h,'userId',uid,'authSessionId',sid,'cacheBinding',binding,'createdAt',stamp,'expiresAt',stamp+604800000,'version',0,'tokens',cipher,'revokedAt',NULL,'logoutPending',false)));
 PERFORM public.fountain_cloud_account_session_vault('create',jsonb_build_object('row',jsonb_build_object('hash',h2,'userId',uid2,'authSessionId',sid2,'cacheBinding',binding2,'createdAt',stamp,'expiresAt',stamp+604800000,'version',0,'tokens',cipher,'revokedAt',NULL,'logoutPending',false)));
 PERFORM public.fountain_cloud_account_session_vault('create',jsonb_build_object('row',jsonb_build_object('hash',h3,'userId',uid3,'authSessionId',sid3,'cacheBinding',binding3,'createdAt',stamp,'expiresAt',stamp+604800000,'version',0,'tokens',cipher,'revokedAt',NULL,'logoutPending',false)));
 ctx:=jsonb_build_object('sessionHash',h,'cacheBinding',binding,'userId',uid,'authSessionId',sid);ctx2:=jsonb_build_object('sessionHash',h2,'cacheBinding',binding2,'userId',uid2,'authSessionId',sid2);ctx3:=jsonb_build_object('sessionHash',h3,'cacheBinding',binding3,'userId',uid3,'authSessionId',sid3);
 answer:=public.fountain_cloud_account_directory(ctx,'list',NULL,NULL,NULL,'{"after":null,"limit":1}');IF answer->'workspaces'<>'[]'::jsonb OR answer->>'accountBinding'<>binding THEN RAISE EXCEPTION 'Unmapped account cannot use directory';END IF;
 a:=public.fountain_cloud_account_directory(ctx,'create',ws,NULL,command,'{"name":"첫 작업공간"}');
 b:=public.fountain_cloud_account_directory(ctx,'create',ws2,NULL,command2,'{"name":"둘째 작업공간"}');
 IF a->'session'->>'workspace_id'<>ws OR a->'session'->'member'->>'id'<>'local' OR a->'session'->'member'->>'role'<>'owner' OR a->'session'->>'account_binding'<>binding THEN RAISE EXCEPTION 'Created workspace DTO changed';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id IN(ws,ws2) AND kind='page') OR(SELECT count(*) FROM fountain_private.entities WHERE workspace_id=ws)<>3 THEN RAISE EXCEPTION 'Workspace seeded sample content';END IF;
 IF public.fountain_cloud_account_directory(ctx,'create',ws,NULL,command,'{"name":"첫 작업공간"}') IS DISTINCT FROM a THEN RAISE EXCEPTION 'Create unknown ACK not stable';END IF;
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''create'',%L,NULL,%L,''{"name":"덮어쓰기"}'')',ctx,ws,gen_random_uuid()),'PT409');
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''create'',%L,NULL,%L,''{"name":"다른 이름"}'')',ctx,ws,command),'PT409');
 again:=public.fountain_cloud_account_directory(ctx,'open',ws,NULL,gen_random_uuid(),'{"expectedBinding":null}');
 IF again IS DISTINCT FROM a THEN RAISE EXCEPTION 'A B A changed child binding';END IF;
 again:=public.fountain_cloud_account_directory(ctx,'open',ws,NULL,gen_random_uuid(),jsonb_build_object('expectedBinding',a->'session'->'cache_binding'));IF again IS DISTINCT FROM a THEN RAISE EXCEPTION 'Same-grant resume failed';END IF;
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''open'',%L,NULL,%L,''{"expectedBinding":"%s"}'')',ctx,ws,gen_random_uuid(),repeat('f',32)),'PT409');
 answer:=public.fountain_cloud_account_directory(ctx,'list',NULL,NULL,NULL,'{"after":null,"limit":1}');
 IF jsonb_array_length(answer->'workspaces')<>1 OR answer->>'nextCursor' IS NULL THEN RAISE EXCEPTION 'Directory pagination absent';END IF;
 again:=public.fountain_cloud_account_directory(ctx,'list',NULL,NULL,NULL,jsonb_build_object('after',answer->'nextCursor','limit',1));
 IF jsonb_array_length(again->'workspaces')<>1 OR again->'nextCursor'<>'null'::jsonb OR again->'workspaces'->0->>'workspaceId'=answer->'workspaces'->0->>'workspaceId' THEN RAISE EXCEPTION 'Directory pagination repeats or truncates';END IF;
 private_ctx:=public.fountain_cloud_account_directory(ctx,'context',ws,a->'session'->>'cache_binding',NULL,'{}');
 IF private_ctx->>'parentHash'<>h OR private_ctx->>'accountBinding'<>binding OR private_ctx->'profile'->>'workspaceId'<>ws OR(private_ctx->>'expiresAt')::bigint<>stamp+604800000 THEN RAISE EXCEPTION 'Private context changed';END IF;
 store_ctx:=jsonb_build_object('workspaceId',ws,'memberId','local','userId',uid,'authSessionId',sid,'sessionHash',private_ctx->'hash','cacheBinding',private_ctx->'cacheBinding');
 PERFORM public.fountain_cloud_store_snapshot(store_ctx,sel,NULL,NULL);
 PERFORM public.fountain_cloud_accounts(store_ctx,'list');
 backup:=public.fountain_cloud_backup_export(store_ctx,NULL,NULL);
 IF backup::text ~ 'workspace_children|account_session_vault|workspace_registry|workspace_invitations|mapping_grant_id' THEN RAISE EXCEPTION 'Runtime authority leaked into backup';END IF;
 IF jsonb_array_length(public.fountain_cloud_presence_publishers(store_ctx,ARRAY[private_ctx->>'hash']))<>1 THEN RAISE EXCEPTION 'Child absent from presence';END IF;
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''context'',%L,%L,NULL,''{}'')',ctx2,ws,a->'session'->>'cache_binding'),'PT403');
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''open'',%L,NULL,%L,''{"expectedBinding":null}'')',ctx2,ws,gen_random_uuid()),'PT403');
 -- Last real owner protection applies equally to tokenless children.
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_accounts(%L,''unlink'',''local'')',store_ctx),'PT409');
 invite:=public.fountain_cloud_account_directory(ctx,'invite',ws,a->'session'->>'cache_binding',invite_command,jsonb_build_object('email',target_email,'role','member','nonceHash',encode(sha256(convert_to(code,'UTF8')),'hex'),'expiresAtMs',expires_ms));
 IF public.fountain_cloud_account_directory(ctx,'invite',ws,a->'session'->>'cache_binding',invite_command,jsonb_build_object('email',target_email,'role','member','nonceHash',encode(sha256(convert_to(code,'UTF8')),'hex'),'expiresAtMs',expires_ms)) IS DISTINCT FROM invite THEN RAISE EXCEPTION 'Invitation unknown ACK changed';END IF;
 -- SSO can legitimately duplicate an ordinary account address. Reject the
 -- ambiguous bounded candidate set rather than choosing the first UUID.
 BEGIN
  INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user) VALUES(gen_random_uuid(),'authenticated','authenticated',target_email,clock_timestamp(),clock_timestamp(),clock_timestamp(),false,true);
  PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invite'',%L,%L,%L,%L)',ctx,ws,a->'session'->>'cache_binding',gen_random_uuid(),jsonb_build_object('email',target_email,'role','member','nonceHash',repeat('d',64),'expiresAtMs',expires_ms)),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback ambiguous SSO email';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 BEGIN
  UPDATE auth.users SET email='qa-dir-moved-'||uid2||'@example.invalid' WHERE id=uid2;
  UPDATE auth.users SET email=target_email WHERE id=uid3;
  PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invite'',%L,%L,%L,%L)',ctx,ws,a->'session'->>'cache_binding',invite_command,jsonb_build_object('email',target_email,'role','member','nonceHash',encode(sha256(convert_to(code,'UTF8')),'hex'),'expiresAtMs',expires_ms)),'PT409');
  PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invitation_preview'',%L,NULL,NULL,%L)',ctx3,ws,jsonb_build_object('invitationId',invite->'invitationId','code',code)),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback target reassignment';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 BEGIN
  UPDATE fountain_private.entities SET data=jsonb_set(data,'{active}','false') WHERE workspace_id=ws AND kind='member' AND id='local';
  PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invitation_preview'',%L,NULL,NULL,%L)',ctx2,ws,jsonb_build_object('invitationId',invite->'invitationId','code',code)),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback issuer deactivation';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invitation_preview'',%L,NULL,NULL,%L)',ctx2,ws,jsonb_build_object('invitationId',invite->'invitationId','code',repeat('f',64))),'PT403');
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invitation_preview'',%L,NULL,NULL,%L)',ctx3,ws,jsonb_build_object('invitationId',invite->'invitationId','code',code)),'PT403');
 answer:=public.fountain_cloud_account_directory(ctx2,'invitation_preview',ws,NULL,NULL,jsonb_build_object('invitationId',invite->'invitationId','code',code));
 IF answer->>'workspaceId'<>ws OR answer->>'name'<>'첫 작업공간' OR answer->>'role'<>'member' THEN RAISE EXCEPTION 'Preview did not use real workspace';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=uid2) THEN RAISE EXCEPTION 'Preview consumed invitation';END IF;
 -- The Auth-row/global-key mutation preflight must never substitute for
 -- the exact parent SID check or publish a grant after provider logout.
 BEGIN
  DELETE FROM auth.sessions WHERE id=sid2;
  PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invitation_accept'',%L,NULL,%L,%L)',ctx2,ws,accept_command,jsonb_build_object('invitationId',invite->'invitationId','code',code)),'PT401');
  IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=uid2) OR EXISTS(SELECT 1 FROM fountain_private.workspace_invitations WHERE workspace_id=ws AND id=(invite->>'invitationId')::uuid AND consumed_at IS NOT NULL) THEN RAISE EXCEPTION 'Missing parent SID published invitation';END IF;
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback provider logout';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 BEGIN
  DELETE FROM auth.sessions WHERE id=sid3;
  PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''create'',%L,NULL,%L,''{"name":"허용되지 않은 생성"}'')',ctx3,ws||'-no-parent',gen_random_uuid()),'PT401');
  IF EXISTS(SELECT 1 FROM fountain_private.workspace_registry WHERE workspace_id=ws||'-no-parent') OR EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws||'-no-parent') THEN RAISE EXCEPTION 'Missing parent SID published workspace';END IF;
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback provider logout';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 answer:=public.fountain_cloud_account_directory(ctx2,'invitation_accept',ws,NULL,accept_command,jsonb_build_object('invitationId',invite->'invitationId','code',code));
 IF answer->'session'->'member'->>'role'<>'member' OR answer->'session'->'member'->>'id'='local' THEN RAISE EXCEPTION 'Invitation linked existing owner';END IF;member2:=answer->'session'->'member'->>'id';
 IF public.fountain_cloud_account_directory(ctx2,'invitation_accept',ws,NULL,accept_command,jsonb_build_object('invitationId',invite->'invitationId','code',code)) IS DISTINCT FROM answer THEN RAISE EXCEPTION 'Accept unknown ACK changed';END IF;
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invitation_accept'',%L,NULL,%L,%L)',ctx2,ws,gen_random_uuid(),jsonb_build_object('invitationId',invite->'invitationId','code',code)),'PT409');
 IF(SELECT count(*) FROM fountain_private.identity_mapping WHERE auth_user_id=uid)<>2 THEN RAISE EXCEPTION 'Account did not retain both memberships';END IF;
 -- Local workspace unlink does not revoke the recipient global parent.
 PERFORM public.fountain_cloud_accounts(store_ctx,'unlink',member2);
 IF fountain_private.account_session_context(ctx2)<>uid2 THEN RAISE EXCEPTION 'Workspace unlink revoked global account';END IF;
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''invitation_accept'',%L,NULL,%L,%L)',ctx2,ws,accept_command,jsonb_build_object('invitationId',invite->'invitationId','code',code)),'PT403');
 -- A shared UUID cannot have its password reset through a workspace owner.
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_accounts(%L,''begin'',''local'',''password'',%L,%L,%L,%L)',store_ctx,repeat('d',64),gen_random_uuid(),repeat('e',32),uid),'PT409');
 -- Expired/locally revoked parent blocks every child and even prior receipts.
 PERFORM public.fountain_cloud_account_session_vault('revoke',jsonb_build_object('hash',h,'now',stamp,'expectedVersion',NULL,'leaseId',NULL));
 PERFORM pg_temp.workspace_expect(format('SELECT fountain_cloud.store_context(%L)',store_ctx),'PT401');
 PERFORM pg_temp.workspace_expect(format('SELECT public.fountain_cloud_account_directory(%L,''create'',%L,NULL,%L,''{"name":"첫 작업공간"}'')',ctx,ws,command),'PT401');
 FOR rel IN SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fountain_private' AND c.relname IN('workspace_registry','workspace_children','workspace_directory_receipts','workspace_invitations') LOOP
 IF NOT rel.relrowsecurity OR NOT rel.relforcerowsecurity OR has_table_privilege('fountain_backend',rel.oid,'SELECT') OR has_table_privilege('service_role',rel.oid,'UPDATE') THEN RAISE EXCEPTION 'Directory table privilege leaked %',rel.relname;END IF;END LOOP;
 IF has_function_privilege('anon','public.fountain_cloud_account_directory(jsonb,text,text,text,uuid,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.fountain_cloud_account_directory(jsonb,text,text,text,uuid,jsonb)','EXECUTE') OR has_function_privilege('fountain_backend','public.fountain_cloud_account_directory(jsonb,text,text,text,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Directory RPC privilege leaked';END IF;
END $test$;
