-- Actual unmodified Auth/member/session joins over synthetic rollback-only rows.
-- This is not an actual GoTrue login, worker delivery or browser proof.
CREATE FUNCTION pg_temp.activity_test_commit(ctx jsonb,revision bigint,tx uuid,changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE canonical text:=jsonb_build_object('context',ctx,'expectedRevision',revision,'changes',changes)::text;
BEGIN RETURN fountain_cloud.store_commit(ctx,revision,tx,encode(sha256(convert_to(canonical,'UTF8')),'hex'),canonical,changes);END $f$;
DO $activity_cloud$
DECLARE ws text:='qa_activity_cloud_'||replace(gen_random_uuid()::text,'-','');stamp text:=fountain_private.activity_now();uid uuid:=gen_random_uuid();sid uuid:=gen_random_uuid();ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;ctx jsonb;changes jsonb;data jsonb;answer jsonb;revision bigint;seq bigint;membership text;account text;tx uuid:=gen_random_uuid();view_command text:=repeat('b',32);generation text;fence jsonb;scope_record jsonb;
BEGIN
 PERFORM fountain_cloud.store_lock(ws);PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at) VALUES(uid,'authenticated','authenticated','qa-'||uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp());
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after) VALUES(sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 INSERT INTO fountain_private.entities VALUES(ws,'member','member','{"id":"member","name":"Actor","email":"qa@example.invalid","role":"member","active":true}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'credential','member','{"id":"member","hash":"private-runtime-only"}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.identity_mapping VALUES(ws,uid,'member',clock_timestamp());
 INSERT INTO fountain_cloud.session_vault(workspace_id,hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,token_ciphertext) VALUES(ws,repeat('a',64),uid,sid,repeat('b',32),ms,ms+604800000,jsonb_build_object('version',1,'keyId','qa','iv',repeat('A',16),'data',repeat('A',22)));
 ctx:=jsonb_build_object('workspaceId',ws,'memberId','member','userId',uid,'authSessionId',sid,'sessionHash',repeat('a',64),'cacheBinding',repeat('b',32));revision:=fountain_cloud.store_revision(ws,'_entity_revision');
 data:=jsonb_build_object('id','page','owner_id','member','title','Created','blocks','[]'::jsonb,'created_at',stamp,'updated_at',stamp,'actor_member_id','forged-other','big',9007199254740993::numeric);
 changes:=jsonb_build_array(jsonb_build_object('op','put','kind','page','id','page','data',data,'previousCreatedAt',NULL));
 answer:=pg_temp.activity_test_commit(ctx,revision,tx,changes);
 SELECT membership_id INTO membership FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member';SELECT account_id INTO account FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='supabase';
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=ws AND action='created' AND actor_member_id='member' AND membership_id=membership AND account_id=account AND origin='human' AND command_id=replace(tx::text,'-','')) OR (SELECT count(*) FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member')<>2 THEN RAISE EXCEPTION 'Canonical cloud actor/account coexistence failed';END IF;
 seq:=(SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws);fence:=fountain_private.activity_backup_fence(ws);
 IF pg_temp.activity_test_commit(ctx,revision,tx,changes) IS DISTINCT FROM answer OR (SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>seq OR fountain_private.activity_backup_fence(ws) IS DISTINCT FROM fence THEN RAISE EXCEPTION 'Accepted commit retry duplicated events';END IF;
 BEGIN
  UPDATE fountain_cloud.session_vault SET token_ciphertext=NULL,revoked_at_ms=ms+1 WHERE workspace_id=ws;
  BEGIN PERFORM pg_temp.activity_test_commit(ctx,revision,tx,changes);RAISE EXCEPTION 'Revoked session replay was accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
  RAISE EXCEPTION USING ERRCODE='Z0002',MESSAGE='rollback synthetic session';
 EXCEPTION WHEN SQLSTATE 'Z0002' THEN NULL;END;
 revision:=(answer->>'revision')::bigint;
 changes:=jsonb_build_array(jsonb_build_object('op','activity_view','kind','page','id','page','commandId',view_command));
 answer:=pg_temp.activity_test_commit(ctx,revision,gen_random_uuid(),changes);
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=ws AND action='viewed' AND command_id=view_command AND command_ordinal=0 AND account_id=account) THEN RAISE EXCEPTION 'Canonical explicit view was not captured';END IF;
 seq:=(SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws);revision:=(answer->>'revision')::bigint;
 answer:=pg_temp.activity_test_commit(ctx,revision,gen_random_uuid(),changes);
 IF (SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>seq THEN RAISE EXCEPTION 'View command retry duplicated event';END IF;
 -- Source change followed by reuse of the same accepted open command conflicts.
 revision:=(answer->>'revision')::bigint;data:=data||'{"title":"Changed after view"}'::jsonb;
 changes:=jsonb_build_array(jsonb_build_object('op','put','kind','page','id','page','data',data,'previousCreatedAt',stamp));answer:=pg_temp.activity_test_commit(ctx,revision,gen_random_uuid(),changes);revision:=(answer->>'revision')::bigint;
 BEGIN PERFORM pg_temp.activity_test_commit(ctx,revision,gen_random_uuid(),jsonb_build_array(jsonb_build_object('op','activity_view','kind','page','id','page','commandId',view_command)));RAISE EXCEPTION 'Stale open command was accepted for another source';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 -- Private page owned by another principal cannot be claimed as viewed.
 data:=jsonb_build_object('id','private','owner_id','someone-else','title','Private','permissions',jsonb_build_object('default','private','inherit',false,'members','{}'::jsonb),'blocks','[]'::jsonb,'created_at',stamp,'updated_at',stamp);
 answer:=pg_temp.activity_test_commit(ctx,revision,gen_random_uuid(),jsonb_build_array(jsonb_build_object('op','put','kind','page','id','private','data',data,'previousCreatedAt',NULL)));revision:=(answer->>'revision')::bigint;
 BEGIN PERFORM pg_temp.activity_test_commit(ctx,revision,gen_random_uuid(),jsonb_build_array(jsonb_build_object('op','activity_view','kind','page','id','private','commandId',repeat('c',32))));RAISE EXCEPTION 'SQL view ACL was bypassed';EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;END;
 -- Service mode never accepts an activity_view staged operation.
 BEGIN PERFORM fountain_cloud.store_apply_changes_locked(ws,revision,jsonb_build_array(jsonb_build_object('op','activity_view','kind','page','id','page','commandId',repeat('d',32))),jsonb_build_object('member_id','member','auth_kind','service'),repeat('e',32),false);RAISE EXCEPTION 'Service apply accepted an explicit human view';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 -- Current account changes close only that transport; password remains open.
 UPDATE fountain_private.identity_mapping SET linked_at=clock_timestamp() WHERE workspace_id=ws AND auth_user_id=uid;
 IF (SELECT account_id FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='supabase')<>account THEN RAISE EXCEPTION 'Mapping metadata reset account episode';END IF;
 DELETE FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=uid;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=ws AND id=account AND close_reason='identity_changed') OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='password') OR (SELECT membership_id FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member')<>membership THEN RAISE EXCEPTION 'Unlink closed membership or another account';END IF;
 INSERT INTO fountain_private.identity_mapping VALUES(ws,uid,'member',clock_timestamp());
 IF (SELECT account_id FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='supabase')=account THEN RAISE EXCEPTION 'Relink reused closed account episode';END IF;
 -- Canonical administrator RPC captures source management only, preserving
 -- its existing creator/editor/generation and exact receipt replay behavior.
 UPDATE fountain_private.entities e SET data=e.data||'{"role":"owner"}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');tx:=gen_random_uuid();
 SELECT p.generation INTO generation FROM fountain_private.content_provenance p WHERE p.workspace_id=ws AND kind='page' AND id='page';
 scope_record:=jsonb_build_object('context',ctx,'expectedRevision',revision,'kind','page','id','page','reviewRevision',fountain_private.content_review_revision(ws,'page','page'),'operation','set_private','value','{}'::jsonb);
 answer:=public.fountain_cloud_content_change(ctx,revision,tx,encode(sha256(convert_to(scope_record::text,'UTF8')),'hex'),scope_record::text,'page','page',scope_record->>'reviewRevision','set_private','{}');
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=ws AND command_id=replace(tx::text,'-','') AND command_ordinal=0 AND action='managed' AND actor_member_id='member' AND resource_generation=generation) THEN RAISE EXCEPTION 'Administrator sharing management was not captured';END IF;
 seq:=(SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws);fence:=fountain_private.activity_backup_fence(ws);
 PERFORM public.fountain_cloud_content_change(ctx,revision,tx,encode(sha256(convert_to(scope_record::text,'UTF8')),'hex'),scope_record::text,'page','page',scope_record->>'reviewRevision','set_private','{}');
 IF (SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>seq OR fountain_private.activity_backup_fence(ws) IS DISTINCT FROM fence THEN RAISE EXCEPTION 'Administrator receipt replay duplicated activity';END IF;
 -- A receipt predating the ledger must remain an ACK, never a retrospective view.
 tx:=gen_random_uuid();INSERT INTO fountain_cloud.content_change_receipts VALUES(ws,'member',repeat('a',64),tx,encode(sha256(convert_to(scope_record::text,'UTF8')),'hex'),clock_timestamp());
 PERFORM public.fountain_cloud_content_change(ctx,revision,tx,encode(sha256(convert_to(scope_record::text,'UTF8')),'hex'),scope_record::text,'page','page',scope_record->>'reviewRevision','set_private','{}');
 IF EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=ws AND command_id=replace(tx::text,'-','')) THEN RAISE EXCEPTION 'Legacy administrator receipt fabricated history';END IF;
 UPDATE fountain_private.entities e SET data=e.data||jsonb_build_object('archived',true,'deleted',true,'deleted_at',stamp,'revision',1,'locked',false) WHERE workspace_id=ws AND kind='page' AND id='page';
 SELECT to_jsonb(p)-ARRAY['workspace_id','manager_id','manager_at'] INTO fence FROM fountain_private.content_provenance p WHERE workspace_id=ws AND kind='page' AND id='page';
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');tx:=gen_random_uuid();scope_record:=jsonb_build_object('context',ctx,'expectedRevision',revision,'kind','page','id','page','reviewRevision',fountain_private.content_review_revision(ws,'page','page'),'operation','restore_private','value','{}'::jsonb);
 PERFORM public.fountain_cloud_content_change(ctx,revision,tx,encode(sha256(convert_to(scope_record::text,'UTF8')),'hex'),scope_record::text,'page','page',scope_record->>'reviewRevision','restore_private','{}');
 IF (SELECT to_jsonb(p)-ARRAY['workspace_id','manager_id','manager_at'] FROM fountain_private.content_provenance p WHERE workspace_id=ws AND kind='page' AND id='page') IS DISTINCT FROM fence OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=ws AND command_id=replace(tx::text,'-','') AND action='managed' AND resource_generation=generation) THEN RAISE EXCEPTION 'Administrator trash restore invented creation or changed original history';END IF;
 -- An authenticated canonical batch cannot attribute a later resource write
 -- after it has disabled its actor. Every source/event/receipt rolls back.
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');SELECT e.data INTO data FROM fountain_private.entities e WHERE e.workspace_id=ws AND kind='member' AND id='member';
 changes:=jsonb_build_array(jsonb_build_object('op','put','kind','member','id','member','data',data||jsonb_build_object('active',false,'created_at',stamp,'updated_at',stamp),'previousCreatedAt',stamp),jsonb_build_object('op','put','kind','page','id','after-inactive','data',jsonb_build_object('id','after-inactive','title','Must rollback','blocks','[]'::jsonb,'created_at',stamp,'updated_at',stamp),'previousCreatedAt',NULL));
 BEGIN PERFORM pg_temp.activity_test_commit(ctx,revision,gen_random_uuid(),changes);RAISE EXCEPTION 'Inactive batch actor was attributed';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id='after-inactive') OR (SELECT e.data->'active' FROM fountain_private.entities e WHERE e.workspace_id=ws AND kind='member' AND id='member')<>'true'::jsonb THEN RAISE EXCEPTION 'Failed inactive batch left partial data';END IF;
 PERFORM fountain_private.activity_validate_workspace(ws);
END $activity_cloud$;
