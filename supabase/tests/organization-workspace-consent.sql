-- Actual private Store/Auth joins over synthetic rollback-only fixtures.
-- No GoTrue login or user-facing organization control plane is claimed here.
DO $organization_consent$
DECLARE
 org_user uuid:=gen_random_uuid();workspace_user uuid:=gen_random_uuid();
 org_session uuid:=gen_random_uuid();workspace_session uuid:=gen_random_uuid();
 org uuid:=gen_random_uuid();other_org uuid:=gen_random_uuid();
 identity jsonb;workspace_identity jsonb;ctx jsonb;wrong_ctx jsonb;answer jsonb;accepted jsonb;
 request_id uuid;link_id uuid;command_id uuid:=gen_random_uuid();
 ws text:='qa_org_consent_'||replace(gen_random_uuid()::text,'-','');
 stamp text:=fountain_private.activity_now();ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 nonce text:=repeat('c',64);nonce_hash text:=encode(sha256(convert_to(repeat('c',64),'UTF8')),'hex');
BEGIN
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous)
 VALUES(org_user,'authenticated','authenticated','qa-org-'||org_user||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false),
 (workspace_user,'authenticated','authenticated','qa-workspace-'||workspace_user||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false);
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after)
 VALUES(org_session,org_user,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),
 (workspace_session,workspace_user,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 identity:=jsonb_build_object('userId',org_user,'authSessionId',org_session);
 workspace_identity:=jsonb_build_object('userId',workspace_user,'authSessionId',workspace_session);
 PERFORM fountain_private.organization_bootstrap_prepare(org,'First organization',org_user,nonce_hash,clock_timestamp()+interval '1 hour');
 PERFORM public.fountain_cloud_organization_bootstrap_accept(identity,org,nonce,gen_random_uuid());
 PERFORM fountain_private.organization_bootstrap_prepare(other_org,'Other organization',org_user,nonce_hash,clock_timestamp()+interval '1 hour');
 PERFORM public.fountain_cloud_organization_bootstrap_accept(identity,other_org,nonce,gen_random_uuid());

 PERFORM fountain_cloud.store_lock(ws);PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO fountain_private.entities VALUES(ws,'member','owner',jsonb_build_object('id','owner','role','owner','name','Workspace owner','email','workspace@example.invalid','active',true),stamp,stamp);
 INSERT INTO fountain_private.identity_mapping VALUES(ws,workspace_user,'owner',clock_timestamp());
 INSERT INTO fountain_cloud.session_vault(workspace_id,hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,token_ciphertext)
 VALUES(ws,repeat('c',64),workspace_user,workspace_session,repeat('d',32),ms,ms+604800000,jsonb_build_object('version',1,'keyId','qa','iv',repeat('A',16),'data',repeat('A',22)));
 ctx:=jsonb_build_object('workspaceId',ws,'memberId','owner','userId',workspace_user,'authSessionId',workspace_session,'sessionHash',repeat('c',64),'cacheBinding',repeat('d',32));

 -- A workspace owner and a forged ordinary organization entity grant no global authority.
 INSERT INTO fountain_private.entities VALUES(ws,'organization',org::text,jsonb_build_object('id',org,'owner_id','owner','role','owner'),stamp,stamp);
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',workspace_identity,org),'PT403');
 answer:=public.fountain_cloud_organization_rpc(identity,org,'link_request',1,gen_random_uuid(),jsonb_build_object('workspaceId',ws,'nonceHash',nonce_hash,'expiresAtMs',ms+600000));
 request_id:=(answer->>'requestId')::uuid;
 IF request_id IS NULL OR (answer->>'revision')::bigint<>2 OR EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE workspace_id=ws AND detached_at IS NULL) THEN RAISE EXCEPTION 'A request attached a workspace without consent';END IF;
 wrong_ctx:=ctx||jsonb_build_object('userId',org_user,'authSessionId',org_session);
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,2,%L,%L::uuid)',wrong_ctx,org,request_id,nonce,gen_random_uuid()),'PT401');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,2,%L,%L::uuid)',ctx,org,request_id,repeat('d',64),gen_random_uuid()),'PT403');
 BEGIN
  UPDATE fountain_private.entities SET data=data||'{"role":"member"}' WHERE workspace_id=ws AND kind='member' AND id='owner';
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,2,%L,%L::uuid)',ctx,org,request_id,nonce,gen_random_uuid()),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback synthetic demotion';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;

 -- Any organization change invalidates the prepared acceptance revision.
 PERFORM public.fountain_cloud_organization_rpc(identity,org,'rename',2,gen_random_uuid(),'{"name":"Renamed organization"}');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,2,%L,%L::uuid)',ctx,org,request_id,nonce,gen_random_uuid()),'PT409');
 answer:=public.fountain_cloud_organization_rpc(identity,org,'link_request',3,gen_random_uuid(),jsonb_build_object('workspaceId',ws,'nonceHash',nonce_hash,'expiresAtMs',ms+600000));
 request_id:=(answer->>'requestId')::uuid;
 accepted:=public.fountain_cloud_organization_link_accept(ctx,org,request_id,4,nonce,command_id);
 link_id:=(accepted->>'linkId')::uuid;
 IF link_id IS NULL OR (accepted->>'revision')::bigint<>5 OR NOT EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE id=link_id AND organization_id=org AND workspace_id=ws AND detached_at IS NULL) THEN RAISE EXCEPTION 'Explicit two-sided workspace consent not linked';END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.organization_events e WHERE e.organization_id=org AND e.action='link_accept' AND e.actor_user_id=workspace_user AND e.actor_grant_id IS NULL AND to_jsonb(e)->>'actor_kind'='workspace_consent' AND e.details ? 'initiatorGrantId') THEN RAISE EXCEPTION 'Workspace consent actor was falsely attributed to the organization owner';END IF;
 IF public.fountain_cloud_organization_link_accept(ctx,org,request_id,4,nonce,command_id) IS DISTINCT FROM accepted THEN RAISE EXCEPTION 'Consent receipt changed on retry';END IF;
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,4,%L,%L::uuid)',ctx,org,request_id,nonce,gen_random_uuid()),'PT409');

 -- A different organization may prepare a request but cannot double-attach.
 BEGIN
  PERFORM public.fountain_cloud_organization_rpc(identity,other_org,'owner_grant',1,gen_random_uuid(),jsonb_build_object('userId',workspace_user));
  answer:=public.fountain_cloud_organization_rpc(identity,other_org,'link_request',2,gen_random_uuid(),jsonb_build_object('workspaceId',ws,'nonceHash',nonce_hash,'expiresAtMs',ms+600000));
  request_id:=(answer->>'requestId')::uuid;
  PERFORM public.fountain_cloud_organization_rpc(workspace_identity,other_org,'owner_revoke',3,gen_random_uuid(),jsonb_build_object('grantId',(SELECT id FROM fountain_private.organization_owner_grants WHERE organization_id=other_org AND user_id=org_user AND closed_at IS NULL)));
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,3,%L,%L::uuid)',ctx,other_org,request_id,nonce,gen_random_uuid()),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback revoked organization initiator';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 answer:=public.fountain_cloud_organization_rpc(identity,other_org,'link_request',1,gen_random_uuid(),jsonb_build_object('workspaceId',ws,'nonceHash',nonce_hash,'expiresAtMs',ms+600000));
 request_id:=(answer->>'requestId')::uuid;
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,2,%L,%L::uuid)',ctx,other_org,request_id,nonce,gen_random_uuid()),'PT409');
 IF (SELECT count(*) FROM fountain_private.organization_workspace_links WHERE workspace_id=ws AND detached_at IS NULL)<>1 THEN RAISE EXCEPTION 'Workspace has ambiguous organization authority';END IF;

 -- Detach preserves the old immutable link identity; consent remains necessary.
 PERFORM public.fountain_cloud_organization_rpc(identity,org,'link_detach',5,gen_random_uuid(),jsonb_build_object('linkId',link_id));
 IF NOT EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE id=link_id AND detached_at IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND id='owner') THEN RAISE EXCEPTION 'Detach lost history or workspace data';END IF;
 answer:=public.fountain_cloud_organization_link_accept(ctx,other_org,request_id,2,nonce,gen_random_uuid());
 IF NOT EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE organization_id=other_org AND workspace_id=ws AND detached_at IS NULL) THEN RAISE EXCEPTION 'Reattachment with explicit consent failed';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.organization_receipts WHERE organization_id IN(org,other_org) AND position(nonce in result::text)>0) THEN RAISE EXCEPTION 'Link nonce entered portable receipt';END IF;

 -- A workspace unlink cannot revoke independent organization authority.
 DELETE FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=workspace_user;
 PERFORM public.fountain_cloud_organization_rpc(identity,org,'read',NULL,NULL,'{}');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_link_accept(%L::jsonb,%L::uuid,%L::uuid,2,%L,%L::uuid)',ctx,other_org,request_id,nonce,gen_random_uuid()),'PT401');
END $organization_consent$;
