-- Rollback-only real joins and immutable kernel transactions. Auth rows here are
-- synthetic; actual password login / cookie / renderer proof is separate.
CREATE OR REPLACE FUNCTION pg_temp.organization_portal_expect(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $t$
DECLARE actual text;
BEGIN BEGIN EXECUTE statement;EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;END;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Expected %, received % for %',expected,COALESCE(actual,'success'),left(statement,100);END IF;
END $t$;
DO $test$
DECLARE uid uuid:=gen_random_uuid();sid uuid:=gen_random_uuid();ws_sid uuid:=gen_random_uuid();uid2 uuid:=gen_random_uuid();sid2 uuid:=gen_random_uuid();
 org uuid:=gen_random_uuid();other_org uuid:=gen_random_uuid();cmd uuid:=gen_random_uuid();grant_cmd uuid:=gen_random_uuid();h text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');h2 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
 binding text:=repeat('e',32);ws text:='qa_org_portal_'||replace(gen_random_uuid()::text,'-','');stamp text:=fountain_private.activity_now();ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 ctx jsonb;session jsonb;session2 jsonb;value jsonb;answer jsonb;created jsonb;detail jsonb;gid uuid;gid2 uuid;link uuid;request uuid;revision bigint;email2 text:='qa-org-other-'||uid2||'@example.invalid';
 nonce text:=repeat('a',64);cipher jsonb:='{"version":1,"keyId":"qa","iv":"AAAAAAAAAAAAAAAA","data":"AAAAAAAAAAAAAAAAAAAAAA"}';
BEGIN
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous,raw_user_meta_data)
 VALUES(uid,'authenticated','authenticated','qa-org-portal-'||uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false,'{"name":"Portal owner","role":"owner","organization_id":"forged"}'),
 (uid2,'authenticated','authenticated',email2,clock_timestamp(),clock_timestamp(),clock_timestamp(),false,'{"name":"Other identity"}');
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after) VALUES(sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),(ws_sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),(sid2,uid2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 value:=jsonb_build_object('hash',h,'userId',uid,'authSessionId',sid,'cacheBinding',binding,'createdAt',ms,'expiresAt',ms+604800000,'version',0,'tokens',cipher,'revokedAt',NULL,'logoutPending',false);
 PERFORM public.fountain_cloud_organization_session_vault('create',jsonb_build_object('row',value));
 PERFORM public.fountain_cloud_organization_session_vault('create',jsonb_build_object('row',value||jsonb_build_object('hash',h2,'userId',uid2,'authSessionId',sid2)));
 session:=jsonb_build_object('sessionHash',h,'cacheBinding',binding,'userId',uid,'authSessionId',sid);
 session2:=jsonb_build_object('sessionHash',h2,'cacheBinding',binding,'userId',uid2,'authSessionId',sid2);
 answer:=public.fountain_cloud_organization_portal(session,'list',NULL,NULL,NULL,'{}');
 IF answer->'organizations'<>'[]'::jsonb THEN RAISE EXCEPTION 'Metadata fabricated authority';END IF;
 PERFORM fountain_cloud.store_lock(ws);PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO fountain_private.entities VALUES(ws,'member','owner',jsonb_build_object('id','owner','role','owner','name','Workspace owner','email','workspace@example.invalid','active',true),stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'settings','workspace','{"name":"Actual family workspace"}',stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'organization',org::text,jsonb_build_object('id',org,'owner_id','owner','role','owner'),stamp,stamp);
 INSERT INTO fountain_private.identity_mapping VALUES(ws,uid,'owner',clock_timestamp());
 INSERT INTO fountain_cloud.session_vault(workspace_id,hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,token_ciphertext) VALUES(ws,repeat('c',64),uid,ws_sid,repeat('d',32),ms,ms+604800000,cipher);
 ctx:=jsonb_build_object('workspaceId',ws,'memberId','owner','userId',uid,'authSessionId',ws_sid,'sessionHash',repeat('c',64),'cacheBinding',repeat('d',32));
 answer:=public.fountain_cloud_organization_portal(session,'setup_eligibility',NULL,NULL,NULL,'{}',ctx);
 IF answer->'eligible'<>'true'::jsonb OR answer->>'workspaceName'<>'Actual family workspace' THEN RAISE EXCEPTION 'Owner eligibility missing';END IF;
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''setup_eligibility'',NULL,NULL,NULL,''{}'',%L::jsonb)',session2,ctx),'PT403');
 value:=jsonb_build_object('name','우리 가족','confirm_owner',true,'attach_workspace',true,'workspace_binding',repeat('d',32));
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''create_from_workspace'',%L::uuid,NULL,%L::uuid,%L::jsonb,%L::jsonb)',session,org,cmd,value||'{"confirm_owner":false}',ctx),'22023');
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''create_from_workspace'',%L::uuid,NULL,%L::uuid,%L::jsonb,%L::jsonb)',session,org,cmd,value||jsonb_build_object('workspace_binding',repeat('e',32)),ctx),'PT409');
 created:=public.fountain_cloud_organization_portal(session,'create_from_workspace',org,NULL,cmd,value,ctx);
 gid:=(created->>'grantId')::uuid;link:=(created->>'linkId')::uuid;
 IF created->>'revision'<>'3' OR gid IS NULL OR link IS NULL THEN RAISE EXCEPTION 'Explicit setup missing atomic owner/link/events';END IF;
 IF(SELECT count(*) FROM fountain_private.organization_events WHERE organization_id=org)<>3 OR(SELECT count(*) FROM fountain_private.organization_receipts WHERE organization_id=org)<>4 THEN RAISE EXCEPTION 'Setup history incomplete';END IF;
 IF public.fountain_cloud_organization_portal(session,'create_from_workspace',org,NULL,cmd,value,ctx) IS DISTINCT FROM created THEN RAISE EXCEPTION 'Setup ACK changed';END IF;
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''create_from_workspace'',%L::uuid,NULL,%L::uuid,%L::jsonb,%L::jsonb)',session,org,gen_random_uuid(),value,ctx),'PT409');
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''create_from_workspace'',%L::uuid,NULL,%L::uuid,%L::jsonb,%L::jsonb)',session,other_org,gen_random_uuid(),value,ctx),'PT409');
 IF EXISTS(SELECT 1 FROM fountain_private.organization_registry WHERE id=other_org) THEN RAISE EXCEPTION 'Rejected setup left an unowned organization';END IF;
 detail:=public.fountain_cloud_organization_portal(session,'read',org,NULL,NULL,'{}');
 IF detail->'owners'->0 ? 'userId' OR detail->'owners'->0 ? 'authSessionId' OR detail->'events'->2->'details' ? 'memberId' OR detail->'workspaces'->0->>'name'<>'Actual family workspace' OR detail->'owners'->0->'self'<>'true'::jsonb THEN RAISE EXCEPTION 'Read DTO leaked identity or lost names';END IF;
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''read'',%L::uuid,NULL,NULL,''{}'')',session2,org),'PT403');
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''owner_revoke'',%L::uuid,3,%L::uuid,%L::jsonb)',session,org,gen_random_uuid(),jsonb_build_object('grantId',gid)),'PT409');
 answer:=public.fountain_cloud_organization_portal(session,'owner_grant_email',org,3,grant_cmd,jsonb_build_object('email',email2));
 gid2:=(answer->>'grantId')::uuid;
 IF gid2 IS NULL OR answer->>'revision'<>'4' THEN RAISE EXCEPTION 'Email target not explicitly granted';END IF;
 IF public.fountain_cloud_organization_portal(session,'owner_grant_email',org,3,grant_cmd,jsonb_build_object('email',upper(email2))) IS DISTINCT FROM answer THEN RAISE EXCEPTION 'Resolved-target ACK changed';END IF;
 -- SSO identities may share an email with an ordinary identity. The server
 -- must reject ambiguity in the same statement that locks the resolved rows.
 BEGIN
  INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
  VALUES(gen_random_uuid(),'authenticated','authenticated',email2,clock_timestamp(),clock_timestamp(),clock_timestamp(),false,true);
  PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''owner_grant_email'',%L::uuid,4,%L::uuid,%L::jsonb)',session,org,gen_random_uuid(),jsonb_build_object('email',email2)),'PT403');
  IF(SELECT r.revision FROM fountain_private.organization_registry r WHERE r.id=org)<>4 THEN RAISE EXCEPTION 'Ambiguous email published a grant';END IF;
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback ambiguous SSO email';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 -- Binding targets by UUID prevents a reassigned address ACK granting another account.
 BEGIN
  UPDATE auth.users SET email='qa-org-moved-'||uid2||'@example.invalid' WHERE id=uid2;
  UPDATE auth.users SET email=email2 WHERE id=uid;
  PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''owner_grant_email'',%L::uuid,3,%L::uuid,%L::jsonb)',session,org,grant_cmd,jsonb_build_object('email',email2)),'PT409');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback email reassignment';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 -- A locally revoked org cookie fails before a still-valid mutation receipt.
 BEGIN
  PERFORM public.fountain_cloud_organization_session_vault('revoke',jsonb_build_object('hash',h,'now',ms,'expectedVersion',NULL,'leaseId',NULL));
  PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''owner_grant_email'',%L::uuid,3,%L::uuid,%L::jsonb)',session,org,grant_cmd,jsonb_build_object('email',email2)),'PT401');
  PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''setup_eligibility'',NULL,NULL,NULL,''{}'',%L::jsonb)',session,ctx),'PT401');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback org revoke';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 -- A workspace-only logout must not be mistaken for an organization 401.
 BEGIN
  UPDATE fountain_cloud.session_vault SET revoked_at_ms=ms,version=version+1,logout_pending=true WHERE workspace_id=ws AND hash=repeat('c',64);
  PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''setup_eligibility'',NULL,NULL,NULL,''{}'',%L::jsonb)',session,ctx),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback workspace revoke';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 -- Workspace membership removal does not close the independent org login/grant.
 BEGIN
  DELETE FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=uid;
  PERFORM public.fountain_cloud_organization_portal(session,'read',org,NULL,NULL,'{}');
  PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''setup_eligibility'',NULL,NULL,NULL,''{}'',%L::jsonb)',session,ctx),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback workspace unlink';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 PERFORM public.fountain_cloud_organization_portal(session,'link_detach',org,4,gen_random_uuid(),jsonb_build_object('linkId',link));
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''create_from_workspace'',%L::uuid,NULL,%L::uuid,%L::jsonb,%L::jsonb)',session,org,cmd,value,ctx),'PT403');
 answer:=public.fountain_cloud_organization_portal(session,'link_request',org,5,gen_random_uuid(),jsonb_build_object('workspaceId',ws,'nonceHash',encode(sha256(convert_to(nonce,'UTF8')),'hex'),'expiresAtMs',ms+600000));request:=(answer->>'requestId')::uuid;
 value:=jsonb_build_object('requestId',request,'code',nonce,'workspace_binding',repeat('d',32));
 answer:=public.fountain_cloud_organization_portal(session,'link_preview',org,6,NULL,value,ctx);
 IF answer->>'name'<>'우리 가족' OR answer->>'workspaceName'<>'Actual family workspace' OR EXISTS(SELECT 1 FROM fountain_private.organization_link_requests WHERE id=request AND consumed_at IS NOT NULL) THEN RAISE EXCEPTION 'Preview consumed request or trusted forged metadata';END IF;
 PERFORM pg_temp.organization_portal_expect(format('SELECT public.fountain_cloud_organization_portal(%L::jsonb,''link_preview'',%L::uuid,6,NULL,%L::jsonb,%L::jsonb)',session,org,value||jsonb_build_object('code',repeat('b',64)),ctx),'PT403');
 answer:=public.fountain_cloud_organization_portal(session,'link_accept',org,6,gen_random_uuid(),value,ctx);
 IF answer->>'revision'<>'7' THEN RAISE EXCEPTION 'Explicit preview acceptance failed';END IF;
END $test$;
