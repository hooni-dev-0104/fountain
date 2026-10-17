-- Run after the lifecycle migration inside a transaction which is ROLLED BACK.
-- Fixture namespaces and Auth identities below are random; no original data is used.
DO $admin_lifecycle_test$
DECLARE
 v_ws text:='qa_admin_lifecycle_'||replace(gen_random_uuid()::text,'-','');
 v_id text:='family';v_user uuid:=gen_random_uuid();v_other uuid:=gen_random_uuid();
 v_key text;v_member jsonb;v_assignment jsonb;v_before jsonb;v_after jsonb;
 v_changes jsonb;v_result bigint;v_count bigint;v_case jsonb;v_snapshot jsonb;v_generations jsonb;
BEGIN
 PERFORM fountain_cloud.store_lock(v_ws);
 PERFORM set_config('fountain.workspace_id',v_ws,true);
 v_key:='_admin_member_generation_v1:'||encode(sha256(convert_to(v_id,'UTF8')),'hex');
 v_member:=jsonb_build_object('id',v_id,'name','Family','email','family@example.test','role','member','active',true,'created_at','2026-10-17T00:00:00+00:00','updated_at','2026-10-17T00:00:00+00:00');
 INSERT INTO fountain_private.entities VALUES(v_ws,'member',v_id,v_member,v_member->>'created_at',v_member->>'updated_at');
 UPDATE fountain_private.entities SET data=data||'{"name":"Renamed"}'::jsonb WHERE workspace_id=v_ws AND kind='member' AND id=v_id;
 IF EXISTS(SELECT 1 FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key) THEN RAISE EXCEPTION 'Ordinary member enrolled';END IF;

 -- Mapping events before an explicit role assignment remain inert.
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at)
 VALUES(v_user,'authenticated','authenticated',v_user::text||'@example.test',clock_timestamp(),clock_timestamp(),clock_timestamp()),
       (v_other,'authenticated','authenticated',v_other::text||'@example.test',clock_timestamp(),clock_timestamp(),clock_timestamp());
 INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id) VALUES(v_ws,v_user,v_id);
 IF EXISTS(SELECT 1 FROM fountain_private.meta WHERE workspace_id=v_ws AND key IN(v_key,'access_revision','_entity_revision')) THEN RAISE EXCEPTION 'Ordinary mapping wrote grant metadata';END IF;
 INSERT INTO fountain_private.meta VALUES(v_ws,v_key,to_jsonb(repeat('a',32))), (v_ws,'access_revision','7'::jsonb),(v_ws,'_entity_revision','100'::jsonb);
 v_assignment:=jsonb_build_object('id',v_id,'member_id',v_id,'role_ids',jsonb_build_array('audit-role'),'generation',repeat('a',32),'created_at',v_member->>'created_at','updated_at',v_member->>'updated_at');
 INSERT INTO fountain_private.entities VALUES(v_ws,'admin_assignment',v_id,v_assignment,v_member->>'created_at',v_member->>'updated_at');

 SELECT data INTO v_before FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
 UPDATE fountain_private.entities SET data=v_member||'{"name":"Again","role":"admin"}'::jsonb WHERE workspace_id=v_ws AND kind='member' AND id=v_id;
 UPDATE fountain_private.entities SET data=v_member WHERE workspace_id=v_ws AND kind='member' AND id=v_id;
 SELECT data INTO v_after FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
 IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'Name/member-admin update revoked grant';END IF;

 FOR v_case IN SELECT value FROM jsonb_array_elements('[{"active":false},{"active":null},{"active":1},{"role":"guest"},{"role":"owner"},{"email":"other@example.test"},{"email":" FAMILY@example.test "},{"email":"FAMILY@example.test"},{"email":null}]'::jsonb) LOOP
  SELECT data INTO v_before FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
  UPDATE fountain_private.entities SET data=v_member||v_case WHERE workspace_id=v_ws AND kind='member' AND id=v_id;
  SELECT data INTO v_after FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
  IF v_before IS NOT DISTINCT FROM v_after OR v_after#>>'{}' !~ '^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Member lifecycle did not rotate generation';END IF;
  UPDATE fountain_private.entities SET data=v_member WHERE workspace_id=v_ws AND kind='member' AND id=v_id;
  IF NOT(v_case ? 'email') AND (SELECT data FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key) IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'Reactivation rewrote generation';END IF;
 END LOOP;
 IF fountain_cloud.store_revision(v_ws,'_entity_revision')<>100 OR fountain_cloud.store_revision(v_ws,'access_revision')<>7 THEN RAISE EXCEPTION 'Member trigger changed staged counters';END IF;
 IF (SELECT data FROM fountain_private.entities WHERE workspace_id=v_ws AND kind='admin_assignment' AND id=v_id) IS DISTINCT FROM v_assignment THEN RAISE EXCEPTION 'Member trigger mutated assignment entity';END IF;

 -- DELETE + same-ID/same-created_at recreation is an exact three-step commit.
 v_changes:=jsonb_build_array(jsonb_build_object('op','delete','kind','member','id',v_id),jsonb_build_object('op','put','kind','member','id',v_id,'data',v_member,'previousCreatedAt',NULL),jsonb_build_object('op','meta','key','access_revision','value',8));
 SELECT data INTO v_before FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
 v_result:=fountain_cloud.store_apply_changes_locked(v_ws,100,v_changes);
 IF v_result<>103 OR fountain_cloud.store_revision(v_ws,'_entity_revision')<>103 OR fountain_cloud.store_revision(v_ws,'access_revision')<>8 THEN RAISE EXCEPTION 'Staged commit acknowledgment changed';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=v_ws AND member_id=v_id) THEN RAISE EXCEPTION 'Deprovision mapping retained';END IF;
 IF current_setting('fountain.admin_mapping_staged',true) IS NOT DISTINCT FROM v_ws THEN RAISE EXCEPTION 'Suppression flag leaked';END IF;
 IF (SELECT data FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key) IS NOT DISTINCT FROM v_before THEN RAISE EXCEPTION 'Same-clock recreation reused generation';END IF;
 IF (SELECT data FROM fountain_private.entities WHERE workspace_id=v_ws AND kind='admin_assignment' AND id=v_id) IS DISTINCT FROM v_assignment THEN RAISE EXCEPTION 'Staged deletion hid assignment mutation';END IF;

 -- Normal account RPCs read the bumped counters in account_touch afterward.
 SELECT data INTO v_before FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
 INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id) VALUES(v_ws,v_user,v_id);
 IF fountain_cloud.store_revision(v_ws,'_entity_revision')<>104 OR fountain_cloud.store_revision(v_ws,'access_revision')<>9 THEN RAISE EXCEPTION 'Relink did not publish revisions';END IF;
 IF (SELECT data FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key) IS NOT DISTINCT FROM v_before THEN RAISE EXCEPTION 'Relink reused generation';END IF;
 PERFORM fountain_cloud.account_touch(v_ws,'qa',v_id,'account.created');
 IF fountain_cloud.store_revision(v_ws,'_entity_revision')<>106 OR fountain_cloud.store_revision(v_ws,'access_revision')<>10 THEN RAISE EXCEPTION 'Account touch overwrote mapping revision';END IF;
 UPDATE fountain_private.identity_mapping SET auth_user_id=v_other WHERE workspace_id=v_ws AND member_id=v_id;
 IF fountain_cloud.store_revision(v_ws,'_entity_revision')<>107 OR fountain_cloud.store_revision(v_ws,'access_revision')<>11 THEN RAISE EXCEPTION 'Identity replacement did not publish revisions';END IF;

 -- External GoTrue deletion has no account_touch; AFTER cascade publishes it.
 SELECT data INTO v_before FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
 DELETE FROM auth.users WHERE id=v_other;
 IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=v_ws AND member_id=v_id) THEN RAISE EXCEPTION 'Auth cascade mapping remained';END IF;
 IF fountain_cloud.store_revision(v_ws,'_entity_revision')<>108 OR fountain_cloud.store_revision(v_ws,'access_revision')<>12 THEN RAISE EXCEPTION 'Auth cascade did not publish revisions';END IF;
 IF (SELECT data FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key) IS NOT DISTINCT FROM v_before THEN RAISE EXCEPTION 'Auth cascade reused generation';END IF;

 -- Failed preflight/kernel validation rolls back revocation and restores flags.
 INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id) VALUES(v_ws,v_user,v_id);
 SELECT data INTO v_before FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key;
 BEGIN
  v_result:=fountain_cloud.store_apply_changes_locked(v_ws,109,jsonb_build_array(jsonb_build_object('op','delete','kind','member','id',v_id),jsonb_build_object('op','invalid')));
  RAISE EXCEPTION 'Invalid kernel change accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
 END;
 IF (SELECT data FROM fountain_private.meta WHERE workspace_id=v_ws AND key=v_key) IS DISTINCT FROM v_before
  OR NOT EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=v_ws AND member_id=v_id)
  OR fountain_cloud.store_revision(v_ws,'_entity_revision')<>109 THEN RAISE EXCEPTION 'Failed staged transaction leaked changes';END IF;
 IF current_setting('fountain.admin_mapping_staged',true) IS NOT DISTINCT FROM v_ws THEN RAISE EXCEPTION 'Failed staged transaction leaked suppression';END IF;

 -- One virtual snapshot selection returns every private generation, without
 -- fetching member bodies or consuming one discovery round per member.
 INSERT INTO fountain_private.meta(workspace_id,key,data)
 SELECT v_ws,'_admin_member_generation_v1:'||encode(sha256(convert_to('large-family-'||s::text,'UTF8')),'hex'),to_jsonb(repeat('b',32))
 FROM generate_series(1,1000) s;
 INSERT INTO fountain_private.meta VALUES(v_ws,'_admin_member_generation_v1:malformed','"excluded"'::jsonb),
 (v_ws||'_foreign',v_key,'"foreign"'::jsonb);
 v_snapshot:=fountain_cloud.store_snapshot_locked(jsonb_build_object('workspaceId',v_ws,'memberId',v_id),v_member,
  '{"kinds":[],"ids":{},"metaKeys":["admin_member_generations_v1","wiki_page_headers_v1","database_verification_rows_v1"],"pageSize":500}'::jsonb,NULL,109);
 SELECT value->'value' INTO v_generations FROM jsonb_array_elements(v_snapshot->'meta') WHERE value->>'key'='admin_member_generations_v1' AND value->'present'='true'::jsonb;
 IF v_generations IS NULL OR (SELECT count(*) FROM jsonb_object_keys(v_generations))<>1001
  OR v_generations->v_key IS DISTINCT FROM v_before
  OR v_generations ? '_admin_member_generation_v1:malformed'
  OR v_generations::text LIKE '%foreign%'
  OR v_snapshot->'entities'<>'[]'::jsonb OR v_snapshot->'nextCursor'<>'null'::jsonb THEN RAISE EXCEPTION 'Private generation index projection failed';END IF;
 IF (SELECT value->'value' FROM jsonb_array_elements(v_snapshot->'meta') WHERE value->>'key'='wiki_page_headers_v1')<>'[]'::jsonb
  OR (SELECT value->'value' FROM jsonb_array_elements(v_snapshot->'meta') WHERE value->>'key'='database_verification_rows_v1')<>'{"databases":[],"rows":[]}'::jsonb THEN RAISE EXCEPTION 'Existing snapshot projections changed';END IF;

 SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='fountain_private' AND p.proname IN('admin_generation_rotate','admin_member_event','admin_mapping_event')
  AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
  AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
  AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
  AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  AND NOT has_function_privilege('fountain_backend',p.oid,'EXECUTE');
 IF v_count<>3 THEN RAISE EXCEPTION 'Private lifecycle function grants/search path unsafe';END IF;
END;
$admin_lifecycle_test$;
