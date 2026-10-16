-- OPERATOR-ONLY rollback proofs after migration 19. Root substitutes the single
-- __QA_WORKSPACE__ marker and executes; source creation is NOT execution evidence.
-- Requires existing real local owner + child mappings, confirmed/unbanned Auth
-- users, child's actual DONE account intent and at least one live child vault.
-- Synthetic pending rows below are copies of that actual completed intent and
-- represent operator SQL fixtures, NOT an issued/pending remote Admin request.
-- Invite hashes/unlink evidence are scoped operator fixtures using real UUIDs.
-- Run in isolation from other QA HTTP calls so full vault/hash baselines are stable.
-- No Auth user/session DML, credentials, fake SID, DDL or persistent fixture.
DO $qa$
#variable_conflict error
DECLARE v_ws constant text:='__QA_WORKSPACE__';v_foreign text;v_spaces text[];
 v_child fountain_private.entities;v_done fountain_cloud.account_intents;v_owner uuid;v_user uuid;
 v_provider_email text;v_marker jsonb;v_phase integer;v_op integer;v_failure integer;v_table text;v_pending text;
 v_rows jsonb;v_hashes jsonb;v_baseline jsonb;v_digest text;v_changes jsonb;v_delete jsonb;v_inactive jsonb;
 v_before jsonb;v_after jsonb;v_reply bigint;v_revision bigint;v_claim_count bigint;v_denied boolean;v_message text;
 v_used text;v_unused text;v_now timestamptz;v_stamp text;
BEGIN
 IF v_ws!~'^fountain-qa-cloud-scim-[a-f0-9]{16}$' THEN RAISE EXCEPTION 'A disposable SCIM QA namespace is required';END IF;
 v_foreign:=v_ws||'-foreign';v_spaces:=ARRAY[v_ws,v_foreign];
 PERFORM fountain_cloud.store_lock(v_ws);PERFORM fountain_cloud.store_lock(v_foreign);PERFORM set_config('fountain.workspace_id',v_ws,true);
 SELECT m.auth_user_id INTO v_owner FROM fountain_private.entities e JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id JOIN auth.users u ON u.id=m.auth_user_id
 WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id='local' AND e.data->>'id'=e.id AND e.data->>'role'='owner' AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) FOR SHARE OF e,m,u;
 IF NOT FOUND THEN RAISE EXCEPTION 'Real mapped active QA owner required';END IF;
 SELECT e.* INTO v_child FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id='child' AND e.data->>'role'='member' AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb FOR SHARE OF e;
 IF NOT FOUND THEN RAISE EXCEPTION 'Existing active QA child required';END IF;
 SELECT m.auth_user_id,u.email,jsonb_build_object('account',u.raw_app_meta_data->'fountain_account_intent','password',u.raw_app_meta_data->'fountain_password_intent') INTO v_user,v_provider_email,v_marker FROM fountain_private.identity_mapping m JOIN auth.users u ON u.id=m.auth_user_id
 WHERE m.workspace_id=v_ws AND m.member_id='child' AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) FOR SHARE OF m,u;
 IF NOT FOUND OR v_user=v_owner THEN RAISE EXCEPTION 'Distinct real confirmed child Auth mapping required';END IF;
 SELECT i.* INTO v_done FROM fountain_cloud.account_intents i WHERE i.workspace_id=v_ws AND i.member_id='child' AND i.state='done' AND i.target_user_id=v_user FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Actual completed child account intent required';END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.session_vault v WHERE v.workspace_id=v_ws AND v.user_id=v_user AND v.revoked_at_ms IS NULL) THEN RAISE EXCEPTION 'At least one live real child vault is required';END IF;
 IF EXISTS(SELECT 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=v_foreign) OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_foreign) OR EXISTS(SELECT 1 FROM fountain_private.meta m WHERE m.workspace_id=v_foreign) THEN RAISE EXCEPTION 'Derived foreign namespace must be empty';END IF;
 v_delete:=jsonb_build_array(jsonb_build_object('op','delete','kind','member','id','child'));
 v_inactive:=jsonb_build_array(jsonb_build_object('op','put','kind','member','id','child','previousCreatedAt',v_child.created_at,'data',v_child.data||jsonb_build_object('active',false)));
 FOR v_phase IN 0..4 LOOP
  IF v_phase>0 THEN
   BEGIN
    IF v_phase=1 THEN
     FOREACH v_pending IN ARRAY ARRAY['prepared','attempted'] LOOP
      UPDATE fountain_cloud.account_intents i SET state=v_pending WHERE i.workspace_id=v_ws AND i.member_id='child';
      FOR v_op IN 1..2 LOOP
       v_denied:=false;BEGIN PERFORM fountain_cloud.store_apply_changes_locked(v_ws,fountain_cloud.store_revision(v_ws,'_entity_revision'),CASE WHEN v_op=1 THEN v_delete ELSE v_inactive END);
       EXCEPTION WHEN SQLSTATE 'PT409' THEN GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;IF v_message<>'ACCOUNT_OPERATION_PENDING' THEN RAISE EXCEPTION 'Unexpected local pending denial';END IF;v_denied:=true;END;
       IF NOT v_denied OR(SELECT i.state FROM fountain_cloud.account_intents i WHERE i.workspace_id=v_ws AND i.member_id='child') IS DISTINCT FROM v_pending OR(SELECT e.data FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id='child') IS DISTINCT FROM v_child.data THEN RAISE EXCEPTION 'Local pending guard changed source';END IF;
      END LOOP;
     END LOOP;
    ELSIF v_phase=2 THEN
     INSERT INTO fountain_cloud.account_intents(workspace_id,member_id,id,actor_id,actor_user_id,kind,state,request_digest,nonce,target_user_id,relink,provider_email,prior_marker,target_snapshot,created_at)
     VALUES(v_foreign,v_done.member_id,v_done.id,v_done.actor_id,v_done.actor_user_id,v_done.kind,'attempted',v_done.request_digest,v_done.nonce,v_user,v_done.relink,v_done.provider_email,v_done.prior_marker,v_done.target_snapshot,v_done.created_at);
     FOR v_op IN 1..2 LOOP
      v_denied:=false;BEGIN PERFORM fountain_cloud.store_apply_changes_locked(v_ws,fountain_cloud.store_revision(v_ws,'_entity_revision'),CASE WHEN v_op=1 THEN v_delete ELSE v_inactive END);
      EXCEPTION WHEN SQLSTATE 'PT409' THEN GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;IF v_message<>'ACCOUNT_OPERATION_PENDING' THEN RAISE EXCEPTION 'Unexpected foreign pending denial';END IF;v_denied:=true;END;
      IF NOT v_denied OR(SELECT i.state FROM fountain_cloud.account_intents i WHERE i.workspace_id=v_foreign AND i.member_id='child') IS DISTINCT FROM 'attempted' THEN RAISE EXCEPTION 'Foreign pending guard lost its fence';END IF;
     END LOOP;
    ELSE
     v_now:=clock_timestamp();v_used:=encode(sha256(convert_to(v_ws||':used:'||gen_random_uuid()::text,'UTF8')),'hex');v_unused:=encode(sha256(convert_to(v_ws||':unused:'||gen_random_uuid()::text,'UTF8')),'hex');
     INSERT INTO fountain_cloud.onboarding_claims(workspace_id,nonce_hash,member_id,purpose,issuer_user_id,issuer_member_id,created_at,expires_at,used_auth_user_id,used_at)
     VALUES(v_ws,v_used,'child','invite',v_owner,'local',v_now,v_now+interval '15 minutes',v_user,v_now),(v_ws,v_unused,'child','invite',v_owner,'local',v_now,v_now+interval '15 minutes',NULL,NULL);
     INSERT INTO fountain_cloud.account_unlinks(workspace_id,member_id,auth_user_id,member_created_at,member_email,provider_email,prior_marker) VALUES(v_ws,'child',v_user,v_child.created_at,v_child.data->>'email',v_provider_email,v_marker) ON CONFLICT(workspace_id,member_id) DO NOTHING;
     IF NOT EXISTS(SELECT 1 FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=v_ws AND u.member_id='child' AND u.auth_user_id=v_user) THEN RAISE EXCEPTION 'Unexpected unlink fixture identity';END IF;
     SELECT count(*) INTO v_claim_count FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=v_ws AND c.member_id='child';
     IF v_phase=3 THEN
      v_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');PERFORM fountain_cloud.store_apply_changes_locked(v_ws,v_revision,v_delete);
      IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=v_ws AND m.member_id='child') OR EXISTS(SELECT 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=v_ws AND i.member_id='child') OR EXISTS(SELECT 1 FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=v_ws AND u.member_id='child') OR EXISTS(SELECT 1 FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=v_ws AND c.member_id='child') OR EXISTS(SELECT 1 FROM fountain_cloud.session_vault v WHERE v.workspace_id=v_ws AND v.user_id=v_user AND v.revoked_at_ms IS NULL) THEN RAISE EXCEPTION 'Deletion left a mapping, claim, intent, unlink or live vault';END IF;
      IF NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=v_user) THEN RAISE EXCEPTION 'Deprovision deleted the global Auth user';END IF;
      v_stamp:=fountain_cloud.scheduler_store_stamp(clock_timestamp());PERFORM fountain_cloud.store_apply_changes_locked(v_ws,fountain_cloud.store_revision(v_ws,'_entity_revision'),jsonb_build_array(jsonb_build_object('op','put','kind','member','id','child','previousCreatedAt',NULL,'data',v_child.data||jsonb_build_object('created_at',v_stamp,'updated_at',v_stamp))));
      IF NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id='child') OR EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=v_ws AND m.member_id='child') OR EXISTS(SELECT 1 FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=v_ws AND c.member_id='child') THEN RAISE EXCEPTION 'Same-ID recreation recovered old authority';END IF;
     ELSE
      FOR v_failure IN 1..2 LOOP
       v_before:=jsonb_build_object(
        'entities',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.kind,t.id) FROM fountain_private.entities t WHERE t.workspace_id=v_ws),
        'meta',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.key) FROM fountain_private.meta t WHERE t.workspace_id=v_ws),
        'mapping',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_private.identity_mapping t WHERE t.workspace_id=v_ws),
        'claims',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.nonce_hash) FROM fountain_cloud.onboarding_claims t WHERE t.workspace_id=v_ws),
        'intents',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_cloud.account_intents t WHERE t.workspace_id=v_ws),
        'unlinks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_cloud.account_unlinks t WHERE t.workspace_id=v_ws),
        'vault',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.hash) FROM fountain_cloud.session_vault t WHERE t.workspace_id=v_ws),
        'signals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id) FROM fountain_cloud.workspace_signals t WHERE t.workspace_id=v_ws),
        'dirty',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_cloud.scheduler_owner_dirty t WHERE t.workspace_id=v_ws));
       v_denied:=false;
       BEGIN
        IF v_failure=1 THEN
         v_changes:=v_delete||jsonb_build_array(jsonb_build_object('op','put','kind','page','id','qa-invalid-after-delete','previousCreatedAt',NULL,'data','{}'::jsonb));PERFORM fountain_cloud.store_apply_changes_locked(v_ws,fountain_cloud.store_revision(v_ws,'_entity_revision'),v_changes);
        ELSE
         UPDATE fountain_private.meta m SET data=to_jsonb(9007199254740991::bigint) WHERE m.workspace_id=v_ws AND m.key='_entity_revision';IF NOT FOUND THEN RAISE EXCEPTION 'QA revision row missing';END IF;
         PERFORM fountain_cloud.store_apply_changes_locked(v_ws,9007199254740991::bigint,v_delete);
        END IF;
       EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'PT413' THEN
        GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;IF(v_failure=1 AND v_message<>'Invalid entity data') OR(v_failure=2 AND v_message<>'Revision limit exceeded') THEN RAISE EXCEPTION 'Unexpected late rollback failure';END IF;v_denied:=true;
       END;
       v_after:=jsonb_build_object(
        'entities',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.kind,t.id) FROM fountain_private.entities t WHERE t.workspace_id=v_ws),
        'meta',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.key) FROM fountain_private.meta t WHERE t.workspace_id=v_ws),
        'mapping',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_private.identity_mapping t WHERE t.workspace_id=v_ws),
        'claims',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.nonce_hash) FROM fountain_cloud.onboarding_claims t WHERE t.workspace_id=v_ws),
        'intents',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_cloud.account_intents t WHERE t.workspace_id=v_ws),
        'unlinks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_cloud.account_unlinks t WHERE t.workspace_id=v_ws),
        'vault',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.hash) FROM fountain_cloud.session_vault t WHERE t.workspace_id=v_ws),
        'signals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id) FROM fountain_cloud.workspace_signals t WHERE t.workspace_id=v_ws),
        'dirty',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.member_id) FROM fountain_cloud.scheduler_owner_dirty t WHERE t.workspace_id=v_ws));
       IF NOT v_denied OR v_before IS DISTINCT FROM v_after OR(SELECT count(*) FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=v_ws AND c.member_id='child')<>v_claim_count OR NOT EXISTS(SELECT 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=v_ws AND i.member_id='child' AND i.state='done') OR NOT EXISTS(SELECT 1 FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=v_ws AND u.member_id='child') THEN RAISE EXCEPTION 'Late failure did not restore deprovisioned state';END IF;
      END LOOP;
     END IF;
    END IF;
    RAISE EXCEPTION USING ERRCODE='ZQ001',MESSAGE='rollback operator fixture';
   EXCEPTION WHEN SQLSTATE 'ZQ001' THEN NULL;END;
  END IF;
  -- One shared full-state hash pass after every fixture rollback. All private
  -- payloads remain in SQL variables; the final output contains booleans only.
  v_hashes:='{}'::jsonb;
  FOREACH v_table IN ARRAY ARRAY['entities','meta','mapping','claims','intents','unlinks','vault','signals','dirty'] LOOP
   CASE v_table
    WHEN 'entities' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.kind,t.id) INTO v_rows FROM fountain_private.entities t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'meta' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.key) INTO v_rows FROM fountain_private.meta t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'mapping' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.member_id) INTO v_rows FROM fountain_private.identity_mapping t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'claims' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.nonce_hash) INTO v_rows FROM fountain_cloud.onboarding_claims t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'intents' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.member_id) INTO v_rows FROM fountain_cloud.account_intents t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'unlinks' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.member_id) INTO v_rows FROM fountain_cloud.account_unlinks t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'vault' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.hash) INTO v_rows FROM fountain_cloud.session_vault t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'signals' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id) INTO v_rows FROM fountain_cloud.workspace_signals t WHERE t.workspace_id=ANY(v_spaces);
    WHEN 'dirty' THEN SELECT jsonb_agg(to_jsonb(t) ORDER BY t.workspace_id,t.member_id) INTO v_rows FROM fountain_cloud.scheduler_owner_dirty t WHERE t.workspace_id=ANY(v_spaces);
   END CASE;
   v_digest:=encode(sha256(convert_to(COALESCE(v_rows,'[]'::jsonb)::text,'UTF8')),'hex');v_hashes:=v_hashes||jsonb_build_object(v_table,v_digest);
  END LOOP;
  IF v_phase=0 THEN v_baseline:=v_hashes;ELSIF v_hashes IS DISTINCT FROM v_baseline THEN RAISE EXCEPTION 'Operator fixture leaked a state change';END IF;
  IF EXISTS(SELECT 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=v_foreign) THEN RAISE EXCEPTION 'Foreign pending fixture survived rollback';END IF;
 END LOOP;
END $qa$;
SELECT jsonb_build_object('localPendingDenials',4,'foreignPendingDenials',2,'usedAndUnusedClaimsPurged',true,'sameIdDoesNotRelink',true,'globalAuthPreserved',true,'lateInvalidPutRollback',true,'lateRevisionLimitRollback',true,'allNineStateHashesRestored',true,'operatorFixturesOnly',true,'persistentWrites',false) AS proof;
