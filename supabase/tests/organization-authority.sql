-- PostgreSQL integration over synthetic rollback-only Auth/session rows.
-- Execute within BEGIN/ROLLBACK. This does not claim a GoTrue login or UI proof.
CREATE FUNCTION pg_temp.organization_expect_error(statement text, expected text)
RETURNS void LANGUAGE plpgsql AS $test$
DECLARE actual text;
BEGIN
 BEGIN EXECUTE statement;
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;END;
 IF actual IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'Expected SQLSTATE %, got %: %',expected,COALESCE(actual,'success'),left(statement,100);
 END IF;
END $test$;

DO $organization_test$
DECLARE
 uid uuid:=gen_random_uuid();second_uid uuid:=gen_random_uuid();outsider_uid uuid:=gen_random_uuid();
 sid uuid:=gen_random_uuid();second_sid uuid:=gen_random_uuid();outsider_sid uuid:=gen_random_uuid();
 org uuid:=gen_random_uuid();other_org uuid:=gen_random_uuid();cmd uuid:=gen_random_uuid();
 bootstrap_cmd uuid:=gen_random_uuid();grant_cmd uuid:=gen_random_uuid();revoke_cmd uuid:=gen_random_uuid();
 identity jsonb;second_identity jsonb;outsider_identity jsonb;answer jsonb;replayed jsonb;
 nonce text:=repeat('a',64);digest text:=encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex');
 first_grant uuid;second_grant uuid;new_grant uuid;rev bigint;events bigint;receipt_count bigint;
 item record;fresh_uuid uuid;fresh_session uuid;
BEGIN
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous)
 VALUES(uid,'authenticated','authenticated','org-owner-'||uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false),
 (second_uid,'authenticated','authenticated','org-second-'||second_uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false),
 (outsider_uid,'authenticated','authenticated','org-outsider-'||outsider_uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false);
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after)
 VALUES(sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),
 (second_sid,second_uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),
 (outsider_sid,outsider_uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 identity:=jsonb_build_object('userId',uid,'authSessionId',sid);
 second_identity:=jsonb_build_object('userId',second_uid,'authSessionId',second_sid);
 outsider_identity:=jsonb_build_object('userId',outsider_uid,'authSessionId',outsider_sid);

 -- Preparing a targeted claim never infers ownership from an Auth identity.
 PERFORM fountain_private.organization_bootstrap_prepare(org,'가족 조직',uid,digest,clock_timestamp()+interval '1 hour');
 answer:=public.fountain_cloud_organization_rpc(identity,NULL,'list',NULL,NULL,'{}');
 IF answer->'organizations' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Pending bootstrap inferred an organization owner';END IF;
 PERFORM pg_temp.organization_expect_error(format('SELECT fountain_private.organization_bootstrap_prepare(%L::uuid,''Invalid expiry'',%L::uuid,%L,clock_timestamp()+interval ''25 hours'')',gen_random_uuid(),uid,digest),'22023');
 PERFORM fountain_private.organization_bootstrap_prepare(other_org,'Expired claim',uid,digest,clock_timestamp()+interval '50 milliseconds');
 PERFORM pg_sleep(0.06);
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_bootstrap_accept(%L::jsonb,%L::uuid,%L,%L::uuid)',identity,other_org,nonce,gen_random_uuid()),'PT403');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',identity,org),'PT403');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_bootstrap_accept(%L::jsonb,%L::uuid,%L,%L::uuid)',second_identity,org,nonce,bootstrap_cmd),'PT403');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_bootstrap_accept(%L::jsonb,%L::uuid,%L,%L::uuid)',identity,org,repeat('b',64),bootstrap_cmd),'PT403');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_bootstrap_accept(%L::jsonb,%L::uuid,%L,%L::uuid)',jsonb_build_object('userId',uid,'authSessionId',outsider_sid),org,nonce,bootstrap_cmd),'PT401');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_bootstrap_accept(%L::jsonb,%L::uuid,%L,%L::uuid)',identity||'{"role":"owner"}',org,nonce,bootstrap_cmd),'22023');
 answer:=public.fountain_cloud_organization_bootstrap_accept(identity,org,nonce,bootstrap_cmd);
 IF answer->>'organizationId' IS DISTINCT FROM org::text OR (answer->>'revision')::bigint<>1 THEN RAISE EXCEPTION 'Bootstrap did not create revision one';END IF;
 replayed:=public.fountain_cloud_organization_bootstrap_accept(identity,org,nonce,bootstrap_cmd);
 IF replayed IS DISTINCT FROM answer THEN RAISE EXCEPTION 'Bootstrap retry changed its ACK';END IF;
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_bootstrap_accept(%L::jsonb,%L::uuid,%L,%L::uuid)',identity,org,nonce,gen_random_uuid()),'PT409');
 SELECT id INTO first_grant FROM fountain_private.organization_owner_grants WHERE organization_id=org AND user_id=uid AND closed_at IS NULL;
 IF first_grant IS NULL THEN RAISE EXCEPTION 'First owner grant missing';END IF;
 answer:=public.fountain_cloud_organization_rpc(identity,NULL,'list',NULL,NULL,'{}');
 IF jsonb_array_length(answer->'organizations')<>1 OR answer->'organizations'->0->>'organizationId' IS DISTINCT FROM org::text THEN RAISE EXCEPTION 'Owner list leaked pending or foreign organization';END IF;

 -- No workspace mapping or local member is required by the global authority.
 IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE auth_user_id=uid) THEN RAISE EXCEPTION 'Fixture unexpectedly enrolled a workspace account';END IF;
 PERFORM public.fountain_cloud_organization_rpc(identity,org,'read',NULL,NULL,'{}');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',outsider_identity,org),'PT403');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',identity,gen_random_uuid()),'PT404');

 -- The last usable owner cannot revoke itself. Rejected changes are atomic.
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''owner_revoke'',1,%L::uuid,%L::jsonb)',identity,org,gen_random_uuid(),jsonb_build_object('grantId',first_grant)),'PT409');
 IF (SELECT revision FROM fountain_private.organization_registry WHERE id=org)<>1 THEN RAISE EXCEPTION 'Rejected revoke changed revision';END IF;

 -- A meaningful command publishes one revision/event and an exact receipt.
 answer:=public.fountain_cloud_organization_rpc(identity,org,'owner_grant',1,grant_cmd,jsonb_build_object('userId',second_uid));
 SELECT id INTO second_grant FROM fountain_private.organization_owner_grants WHERE organization_id=org AND user_id=second_uid AND closed_at IS NULL;
 IF second_grant IS NULL OR (answer->>'revision')::bigint<>2 THEN RAISE EXCEPTION 'Second owner not granted';END IF;
 BEGIN
  UPDATE auth.users SET banned_until=clock_timestamp()+interval '1 hour' WHERE id=second_uid;
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''owner_revoke'',2,%L::uuid,%L::jsonb)',identity,org,gen_random_uuid(),jsonb_build_object('grantId',first_grant)),'PT409');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback unusable surviving owner';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 replayed:=public.fountain_cloud_organization_rpc(identity,org,'owner_grant',1,grant_cmd,jsonb_build_object('userId',second_uid));
 IF replayed IS DISTINCT FROM answer THEN RAISE EXCEPTION 'Grant ACK changed';END IF;
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''owner_grant'',1,%L::uuid,%L::jsonb)',identity,org,grant_cmd,jsonb_build_object('userId',outsider_uid)),'PT409');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''owner_grant'',1,%L::uuid,%L::jsonb)',second_identity,org,grant_cmd,jsonb_build_object('userId',second_uid)),'PT409');

 SELECT count(*) INTO events FROM fountain_private.organization_events WHERE organization_id=org;
 answer:=public.fountain_cloud_organization_rpc(identity,org,'rename',2,cmd,jsonb_build_object('name','가족 조직'));
 IF (answer->>'revision')::bigint<>2 OR answer->'changed' IS DISTINCT FROM 'false'::jsonb OR (SELECT count(*) FROM fountain_private.organization_events WHERE organization_id=org)<>events THEN RAISE EXCEPTION 'No-op fabricated an event';END IF;
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''rename'',1,%L::uuid,%L::jsonb)',identity,org,gen_random_uuid(),jsonb_build_object('name','다른 이름')),'PT409');
 answer:=public.fountain_cloud_organization_rpc(identity,org,'rename',2,gen_random_uuid(),jsonb_build_object('name','우리 가족'));
 IF (answer->>'revision')::bigint<>3 THEN RAISE EXCEPTION 'Rename missing revision';END IF;

 -- Ban and session expiry reject even already acknowledged commands.
 BEGIN
  UPDATE auth.users SET banned_until=clock_timestamp()+interval '1 hour' WHERE id=uid;
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''owner_grant'',1,%L::uuid,%L::jsonb)',identity,org,grant_cmd,jsonb_build_object('userId',second_uid)),'PT401');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback synthetic ban';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 BEGIN
  UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id=sid;
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',identity,org),'PT401');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback synthetic expiry';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;

 -- Revoke is independent of workspace grants; old receipts/claims cannot revive it.
 answer:=public.fountain_cloud_organization_rpc(second_identity,org,'owner_revoke',3,revoke_cmd,jsonb_build_object('grantId',first_grant));
 IF (answer->>'revision')::bigint<>4 THEN RAISE EXCEPTION 'Owner revoke missing revision';END IF;
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''owner_grant'',1,%L::uuid,%L::jsonb)',identity,org,grant_cmd,jsonb_build_object('userId',second_uid)),'PT403');
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_bootstrap_accept(%L::jsonb,%L::uuid,%L,%L::uuid)',identity,org,nonce,bootstrap_cmd),'PT403');
 PERFORM public.fountain_cloud_organization_rpc(second_identity,org,'owner_grant',4,gen_random_uuid(),jsonb_build_object('userId',uid));
 SELECT id INTO new_grant FROM fountain_private.organization_owner_grants WHERE organization_id=org AND user_id=uid AND closed_at IS NULL;
 IF new_grant IS NULL OR new_grant=first_grant THEN RAISE EXCEPTION 'Regrant resurrected an old owner grant';END IF;
 PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''owner_grant'',1,%L::uuid,%L::jsonb)',identity,org,grant_cmd,jsonb_build_object('userId',second_uid)),'PT409');

 -- Auth security revocation may leave zero usable owners: fail closed, no takeover.
 BEGIN
  UPDATE auth.users SET deleted_at=clock_timestamp() WHERE id IN(uid,second_uid);
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',identity,org),'PT401');
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',second_identity,org),'PT401');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback synthetic deletion';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
 -- Reusing another account's confirmed email never changes its Auth UUID binding.
 BEGIN
  UPDATE auth.users SET email='removed-'||uid||'@example.invalid' WHERE id=uid;
  UPDATE auth.users SET email='org-owner-'||uid||'@example.invalid',raw_user_meta_data='{"role":"owner","organization_owner":true}' WHERE id=outsider_uid;
  PERFORM pg_temp.organization_expect_error(format('SELECT public.fountain_cloud_organization_rpc(%L::jsonb,%L::uuid,''read'',NULL,NULL,''{}'')',outsider_identity,org),'PT403');
  RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback synthetic email';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;

 -- Guards, direct DML/execute ACLs and default-deny RLS are part of the boundary.
 PERFORM set_config('fountain.organization_write',org::text,true);
 PERFORM pg_temp.organization_expect_error(format('UPDATE fountain_private.organization_events SET action=''forged'' WHERE organization_id=%L::uuid',org),'PT403');
 FOR item IN SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fountain_private' AND c.relname LIKE 'organization_%' AND c.relkind='r' LOOP
  IF NOT item.relrowsecurity OR NOT item.relforcerowsecurity OR has_table_privilege('anon',item.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated',item.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('service_role',item.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('fountain_backend',item.oid,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Organization private ACL failed for %',item.relname;END IF;
 END LOOP;
 IF has_function_privilege('service_role','fountain_private.organization_bootstrap_prepare(uuid,text,uuid,text,timestamp with time zone)','EXECUTE') OR has_function_privilege('authenticated','public.fountain_cloud_organization_rpc(jsonb,uuid,text,bigint,uuid,jsonb)','EXECUTE') OR NOT has_function_privilege('service_role','public.fountain_cloud_organization_rpc(jsonb,uuid,text,bigint,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Organization RPC privilege boundary failed';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.organization_receipts WHERE organization_id=org AND position(nonce in result::text)>0) THEN RAISE EXCEPTION 'Raw bootstrap nonce entered a receipt';END IF;
END $organization_test$;
