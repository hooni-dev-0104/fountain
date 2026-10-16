-- OPERATOR QA ONLY. This file is NOT a migration and creates no public helper.
-- Root replaces ONLY __QA_WORKSPACE__ with its disposable scheduler namespace.
-- Both context/claim pairs must come from actual open -> TS plan -> prepare RPCs
-- and be stored at private meta _qa_scheduler_prepared. No tickets/Auth IDs are
-- generated here. gen_random_uuid() below creates transaction receipt IDs only.
-- Run the whole script as one transaction/batch, while the 90s ready leases live.
-- Initial registry+owned Cron are enabled; Root removes these two job deliveries
-- from pg_net during dispatch. Workspace advisory locking serializes Cron here.
-- After a real identity commit, scheduler_install(...,false) performs owned pause.
-- DELETE/re-INSERT of the exact QA mapping is an OPERATOR event fixture, NOT an
-- assertion that this script exercised the application unlink/relink API.
-- No script execution, Postgres proof or cloud mutation is implied by this source.

DO $qa$
#variable_conflict error
DECLARE
 v_ws constant text:='__QA_WORKSPACE__';
 v_prepared jsonb;v_case jsonb;v_label text;v_context jsonb;v_claim jsonb;
 v_registry fountain_cloud.scheduler_registry;v_job fountain_cloud.scheduler_jobs;
 v_attempt fountain_cloud.scheduler_attempts;v_grant fountain_cloud.service_grants;
 v_auto fountain_private.entities;v_source fountain_private.entities;
 v_mapping fountain_private.identity_mapping;
 v_revision bigint;v_before_revision bigint;v_after_revision bigint;v_entity_count bigint;
 v_signal jsonb;v_job_before jsonb;v_due_before jsonb;v_lease_before jsonb;v_grant_before jsonb;v_source_before jsonb;
 v_auto_data jsonb;v_page_data jsonb;v_run_data jsonb;v_changes jsonb;v_request jsonb;
 v_tx uuid;v_canonical text;v_digest text;v_scope text;v_page_id text;v_title text;
 v_stamp text;v_created_stamp text;v_reply jsonb;v_denied boolean;v_state text;v_message text;v_failure_context text;
 v_identity_context jsonb;v_identity_claim jsonb;v_identity_request jsonb;v_identity_scope text;v_identity_tx uuid;
 v_identity_page jsonb;v_identity_auto jsonb;v_identity_job jsonb;v_identity_signal jsonb;
 v_epoch bigint;v_new_epoch bigint;v_affected bigint;v_author text;
 v_selection jsonb;
BEGIN
 IF v_ws!~'^fountain-qa-cloud-scheduler-[a-f0-9]{16}$' THEN RAISE EXCEPTION 'A disposable scheduler QA namespace is required';END IF;
 PERFORM fountain_cloud.store_lock(v_ws);PERFORM set_config('fountain.workspace_id',v_ws,true);
 SELECT r.* INTO v_registry FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=v_ws FOR UPDATE;
 IF NOT FOUND OR NOT v_registry.enabled THEN RAISE EXCEPTION 'QA registry must be initially enabled';END IF;
 PERFORM fountain_cloud.scheduler_owned(v_registry);
 IF NOT EXISTS(SELECT 1 FROM cron.job c WHERE c.jobid=v_registry.cron_id AND c.active) THEN RAISE EXCEPTION 'QA owned Cron must be initially active';END IF;
 SELECT m.data INTO v_prepared FROM fountain_private.meta m WHERE m.workspace_id=v_ws AND m.key='_qa_scheduler_prepared';
 IF jsonb_typeof(v_prepared) IS DISTINCT FROM 'object' OR NOT(v_prepared ?& ARRAY['rollback','identity']) OR v_prepared-ARRAY['rollback','identity']<>'{}'::jsonb THEN RAISE EXCEPTION 'Actual prepared QA contexts are required';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.meta m WHERE m.workspace_id=v_ws AND m.key='_qa_scheduler_identity_request') THEN RAISE EXCEPTION 'QA request evidence already exists; do not blind-repeat this script';END IF;
 IF v_prepared->'rollback'->'context'->>'resourceId'=v_prepared->'identity'->'context'->>'resourceId'
  OR v_prepared->'rollback'->'claim'->>'jobId'=v_prepared->'identity'->'claim'->>'jobId' THEN RAISE EXCEPTION 'Two independent actual QA jobs are required';END IF;

 FOREACH v_label IN ARRAY ARRAY['rollback','identity'] LOOP
  v_case:=v_prepared->v_label;
  IF jsonb_typeof(v_case) IS DISTINCT FROM 'object' OR NOT(v_case ?& ARRAY['context','claim']) OR v_case-ARRAY['context','claim']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid prepared QA case';END IF;
  v_context:=v_case->'context';v_claim:=v_case->'claim';
  IF v_context->>'kind' IS DISTINCT FROM 'automation' OR v_context->>'workspaceId' IS DISTINCT FROM v_ws OR v_context->>'memberId' IS DISTINCT FROM 'local'
   OR v_claim->>'workspaceId' IS DISTINCT FROM v_ws OR v_claim->>'automationId' IS DISTINCT FROM v_context->>'resourceId' OR v_claim->>'runId' IS DISTINCT FROM v_context->>'runId' THEN RAISE EXCEPTION 'QA claim affinity mismatch';END IF;
  -- Real live service validation, not an invented owner/SID/principal.
  PERFORM fountain_cloud.service_context(v_context);PERFORM fountain_cloud.scheduler_identity_guard(v_context);
  v_job:=fountain_cloud.scheduler_service_ready(v_context);
  IF v_job.id::text IS DISTINCT FROM v_claim->>'jobId' OR v_job.workspace_id IS DISTINCT FROM v_ws
   OR to_jsonb(v_job.definition_version) IS DISTINCT FROM v_claim->'definitionVersion' OR v_job.definition_hash IS DISTINCT FROM v_claim->>'definitionHash'
   OR v_job.due_hash IS DISTINCT FROM v_claim->>'dueHash' OR fountain_cloud.scheduler_stamp(v_job.fixed_now) IS DISTINCT FROM v_claim->>'fixedNow'
   OR v_job.scheduled_at IS DISTINCT FROM v_claim->>'scheduledAt' OR COALESCE(to_jsonb(v_job.next_at),'null'::jsonb) IS DISTINCT FROM v_claim->'nextRunAt' THEN RAISE EXCEPTION 'QA metadata does not match the actual bound job';END IF;
  SELECT a.* INTO v_attempt FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=v_ws AND a.job_id=v_job.id
   AND a.generation=v_job.generation AND a.grant_id=(v_context->>'grantId')::uuid AND a.lease_id=(v_context->>'leaseId')::uuid
   AND a.ticket_hash=v_context->>'ticketHash' AND a.invocation_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR v_attempt.work_until<=clock_timestamp()+interval '3 seconds' THEN RAISE EXCEPTION 'Actual QA ready lease is missing or too old';END IF;
  SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_ws AND g.id=v_attempt.grant_id FOR SHARE;
  IF NOT FOUND OR to_jsonb(v_grant.version) IS DISTINCT FROM v_context->'grantVersion' OR v_grant.member_id IS DISTINCT FROM 'local' OR NOT v_grant.enabled OR v_grant.resource_id IS DISTINCT FROM v_job.automation_id THEN RAISE EXCEPTION 'Actual QA delegation mismatch';END IF;
  IF NOT EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=v_ws AND m.member_id=v_grant.member_id AND m.auth_user_id=v_grant.auth_user_id) THEN RAISE EXCEPTION 'Actual QA Auth mapping is missing';END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation_run' AND e.id=v_job.run_id) THEN RAISE EXCEPTION 'QA run has already committed';END IF;
  v_scope:=encode(sha256(convert_to(v_context::text,'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=v_grant.id AND r.authority_hash=v_scope) THEN RAISE EXCEPTION 'QA authority already has an accepted receipt';END IF;

  SELECT e.* INTO v_auto FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation' AND e.id=v_job.automation_id FOR SHARE;
  IF NOT FOUND OR v_auto.data->>'name' IS DISTINCT FROM 'qa-proof-'||v_label THEN RAISE EXCEPTION 'Unexpected QA automation source';END IF;
  SELECT e.* INTO v_source FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='page' AND e.data->>'owner_id'='local' ORDER BY e.created_at COLLATE "C",e.id COLLATE "C" LIMIT 1 FOR SHARE;
  IF NOT FOUND OR jsonb_typeof(v_source.data->'title') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'An existing local QA source page is required';END IF;
  v_source_before:=to_jsonb(v_source);
  v_page_id:=CASE WHEN v_label='rollback' THEN 'qa-rollback-page' ELSE 'qa-identity-test-page' END;
  v_title:=CASE WHEN v_label='rollback' THEN 'DO_NOT_CREATE_ROLLBACK' ELSE 'QA identity original commit' END;
  IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='page' AND e.id=v_page_id) THEN RAISE EXCEPTION 'QA proof page already exists';END IF;
  v_stamp:=fountain_cloud.scheduler_stamp(v_job.fixed_now);v_created_stamp:=fountain_cloud.scheduler_store_stamp(v_job.fixed_now);
  v_page_data:=v_source.data||jsonb_build_object('id',v_page_id,'title',v_title,'owner_id',v_grant.member_id,'created_at',v_created_stamp,'updated_at',v_created_stamp);
  v_run_data:=jsonb_build_object('id',v_job.run_id,'automation_id',v_job.automation_id,'scheduled_at',v_job.scheduled_at,'started_at',v_stamp,'finished_at',v_stamp,'status','succeeded','result',jsonb_build_object('fixture','operator-valid-commit'),'next_run_at',v_job.next_at,'created_at',v_created_stamp,'updated_at',v_created_stamp);
  v_auto_data:=v_auto.data||jsonb_build_object('next_run_at',v_job.next_at,'last_run_at',v_stamp,'last_run_status','succeeded','last_error',NULL,'updated_at',v_created_stamp);
  IF v_job.next_at IS NULL THEN v_auto_data:=v_auto_data||jsonb_build_object('enabled',false,'schedule_status','completed');END IF;
  v_changes:=jsonb_build_array(
   jsonb_build_object('op','put','kind','page','id',v_page_id,'data',v_page_data,'previousCreatedAt',NULL),
   jsonb_build_object('op','put','kind','automation_run','id',v_job.run_id,'data',v_run_data,'previousCreatedAt',NULL),
   jsonb_build_object('op','put','kind','automation','id',v_job.automation_id,'data',v_auto_data,'previousCreatedAt',v_auto.created_at));
  -- These operator requests use JSONB text + its exact digest. This is a SQL
  -- transaction proof, NOT evidence about JavaScript canonical serialization.
  v_tx:=gen_random_uuid();v_before_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
  SELECT to_jsonb(s) INTO v_signal FROM fountain_cloud.workspace_signals s WHERE s.workspace_id=v_ws;
  SELECT to_jsonb(j) INTO v_job_before FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.id=v_job.id;
  SELECT to_jsonb(d) INTO v_due_before FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=v_ws AND d.automation_id=v_job.automation_id;
  SELECT to_jsonb(l) INTO v_lease_before FROM fountain_cloud.service_leases l WHERE l.workspace_id=v_ws AND l.grant_id=v_grant.id AND l.id=v_attempt.lease_id;
  SELECT to_jsonb(g) INTO v_grant_before FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_ws AND g.id=v_grant.id;
  SELECT count(*) INTO v_entity_count FROM fountain_private.entities e WHERE e.workspace_id=v_ws;
  IF v_label='rollback' THEN
   v_denied:=false;
   BEGIN
    -- Only this workspace's scalar counter changes in this savepoint. Its signal
    -- and all provisional done/source actions must roll back on the late PT413.
    UPDATE fountain_private.meta m SET data=to_jsonb(9007199254740991::bigint) WHERE m.workspace_id=v_ws AND m.key='_entity_revision';
    GET DIAGNOSTICS v_affected=ROW_COUNT;IF v_affected<>1 THEN RAISE EXCEPTION 'QA counter row is missing';END IF;
    v_canonical:=jsonb_build_object('context',v_context,'expectedRevision',9007199254740991::bigint,'changes',v_changes)::text;
    v_digest:=encode(sha256(convert_to(v_canonical,'UTF8')),'hex');
    PERFORM public.fountain_cloud_service_commit(v_context,9007199254740991::bigint,v_tx,v_digest,v_canonical,v_changes);
    RAISE EXCEPTION 'Late locked apply unexpectedly committed';
   EXCEPTION WHEN SQLSTATE 'PT413' THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
    IF v_message IS DISTINCT FROM 'Revision limit exceeded' THEN RAISE EXCEPTION 'Unexpected early PT413 failure';END IF;v_denied:=true;
   END;
   IF NOT v_denied OR fountain_cloud.store_revision(v_ws,'_entity_revision')<>v_before_revision THEN RAISE EXCEPTION 'QA counter rollback failed';END IF;
   IF (SELECT to_jsonb(s) FROM fountain_cloud.workspace_signals s WHERE s.workspace_id=v_ws) IS DISTINCT FROM v_signal
    OR (SELECT to_jsonb(j) FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.id=v_job.id) IS DISTINCT FROM v_job_before
    OR (SELECT to_jsonb(d) FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=v_ws AND d.automation_id=v_job.automation_id) IS DISTINCT FROM v_due_before
    OR (SELECT to_jsonb(l) FROM fountain_cloud.service_leases l WHERE l.workspace_id=v_ws AND l.grant_id=v_grant.id AND l.id=v_attempt.lease_id) IS DISTINCT FROM v_lease_before
    OR (SELECT to_jsonb(g) FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_ws AND g.id=v_grant.id) IS DISTINCT FROM v_grant_before
    OR (SELECT to_jsonb(e) FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation' AND e.id=v_job.automation_id) IS DISTINCT FROM to_jsonb(v_auto)
    OR (SELECT to_jsonb(e) FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='page' AND e.id=v_source.id) IS DISTINCT FROM v_source_before
    OR (SELECT count(*) FROM fountain_private.entities e WHERE e.workspace_id=v_ws)<>v_entity_count THEN RAISE EXCEPTION 'QA provisional/source rollback failed';END IF;
   IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND((e.kind='page' AND e.id=v_page_id) OR(e.kind='automation_run' AND e.id=v_job.run_id)))
    OR EXISTS(SELECT 1 FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=v_grant.id AND r.authority_hash=v_scope) THEN RAISE EXCEPTION 'QA rollback left a page, run or receipt';END IF;
   PERFORM fountain_cloud.scheduler_service_ready(v_context);
  ELSE
   v_canonical:=jsonb_build_object('context',v_context,'expectedRevision',v_before_revision,'changes',v_changes)::text;
   v_digest:=encode(sha256(convert_to(v_canonical,'UTF8')),'hex');
   v_reply:=public.fountain_cloud_service_commit(v_context,v_before_revision,v_tx,v_digest,v_canonical,v_changes);
   IF v_reply IS DISTINCT FROM jsonb_build_object('revision',v_before_revision+3) THEN RAISE EXCEPTION 'QA identity commit revision mismatch';END IF;
   IF (SELECT count(*) FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=v_grant.id AND r.authority_hash=v_scope AND r.transaction_id=v_tx AND r.digest=v_digest)<>1
    OR (SELECT j.state FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.id=v_job.id) IS DISTINCT FROM 'done'
    OR (SELECT e.data->>'title' FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='page' AND e.id=v_page_id) IS DISTINCT FROM v_title THEN RAISE EXCEPTION 'QA accepted commit is incomplete';END IF;
   v_identity_context:=v_context;v_identity_claim:=v_claim;v_identity_scope:=v_scope;v_identity_tx:=v_tx;
   v_identity_request:=jsonb_build_object('context',v_context,'expectedRevision',v_before_revision,'transactionId',v_tx,'digest',v_digest,'canonical',v_canonical,'changes',v_changes);
   INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,'_qa_scheduler_identity_request',v_identity_request);
   -- Still enabled: broker.done blocks NEW work, while the accepted exact ACK
   -- bypasses only the new-work gate. No rejected request may mint a receipt.
   v_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
   v_selection:=jsonb_build_object('kinds','[]'::jsonb,'ids',jsonb_build_object('page',jsonb_build_array(v_page_id)),'metaKeys','[]'::jsonb,'pageSize',1);
   v_denied:=false;
   BEGIN
    PERFORM public.fountain_cloud_service_snapshot(v_context,v_selection,NULL,NULL);
   EXCEPTION WHEN SQLSTATE 'PT409' OR SQLSTATE 'PT403' THEN
    GET STACKED DIAGNOSTICS v_failure_context=PG_EXCEPTION_CONTEXT;
    IF strpos(v_failure_context,'scheduler_service_ready')=0 THEN RAISE EXCEPTION 'New snapshot failed outside the done-job guard';END IF;v_denied:=true;
   END;
   IF NOT v_denied THEN RAISE EXCEPTION 'Completed broker allowed a new snapshot';END IF;
   v_tx:=gen_random_uuid();v_canonical:=jsonb_build_object('context',v_context,'expectedRevision',v_revision,'changes','[]'::jsonb)::text;v_digest:=encode(sha256(convert_to(v_canonical,'UTF8')),'hex');
   v_denied:=false;
   BEGIN
    PERFORM public.fountain_cloud_service_commit(v_context,v_revision,v_tx,v_digest,v_canonical,'[]'::jsonb);
   EXCEPTION WHEN SQLSTATE 'PT409' OR SQLSTATE 'PT403' THEN
    GET STACKED DIAGNOSTICS v_failure_context=PG_EXCEPTION_CONTEXT;
    IF strpos(v_failure_context,'scheduler_service_ready')=0 THEN RAISE EXCEPTION 'New commit failed outside the done-job guard';END IF;v_denied:=true;
   END;
   IF NOT v_denied OR fountain_cloud.store_revision(v_ws,'_entity_revision')<>v_revision
    OR (SELECT count(*) FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=v_grant.id AND r.authority_hash=v_scope)<>1 THEN RAISE EXCEPTION 'New done-job work changed accepted state';END IF;
   v_reply:=public.fountain_cloud_service_commit(v_identity_context,(v_identity_request->>'expectedRevision')::bigint,v_identity_tx,v_identity_request->>'digest',v_identity_request->>'canonical',v_identity_request->'changes');
   IF v_reply IS DISTINCT FROM jsonb_build_object('revision',v_revision) OR fountain_cloud.store_revision(v_ws,'_entity_revision')<>v_revision
    OR (SELECT count(*) FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=v_grant.id AND r.authority_hash=v_scope)<>1 THEN RAISE EXCEPTION 'Exact accepted ACK failed while done/new-work was denied';END IF;
  END IF;
 END LOOP;

 -- Owned pause only: registry false + actual Cron inactive, without revoking
 -- grants/leases. Mapping events must still fence old proof during this pause.
 v_reply:=fountain_cloud.scheduler_install(v_ws,v_registry.worker_url,false);
 IF v_reply->'enabled' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'QA owned pause failed';END IF;
 SELECT r.* INTO v_registry FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=v_ws;
 PERFORM fountain_cloud.scheduler_owned(v_registry);
 IF v_registry.enabled OR EXISTS(SELECT 1 FROM cron.job c WHERE c.jobid=v_registry.cron_id AND c.active) THEN RAISE EXCEPTION 'QA scheduler is not paused';END IF;
 PERFORM fountain_cloud.service_context(v_identity_context);PERFORM fountain_cloud.scheduler_identity_guard(v_identity_context);
 -- Exact accepted ACK is valid despite pause/done, BEFORE the mapping epoch.
 v_reply:=public.fountain_cloud_service_commit(v_identity_context,(v_identity_request->>'expectedRevision')::bigint,v_identity_tx,v_identity_request->>'digest',v_identity_request->>'canonical',v_identity_request->'changes');
 v_after_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
 IF v_reply IS DISTINCT FROM jsonb_build_object('revision',v_after_revision) THEN RAISE EXCEPTION 'QA accepted receipt was not replayable before the epoch';END IF;
 v_author:=v_identity_context->>'memberId';
 SELECT m.* INTO v_mapping FROM fountain_private.identity_mapping m WHERE m.workspace_id=v_ws AND m.member_id=v_author FOR UPDATE;
 SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_ws AND g.id=(v_identity_context->>'grantId')::uuid;
 IF v_mapping.member_id IS DISTINCT FROM 'local' OR v_mapping.auth_user_id IS DISTINCT FROM v_grant.auth_user_id THEN RAISE EXCEPTION 'QA real local mapping mismatch';END IF;
 SELECT COALESCE((SELECT q.identity_epoch FROM fountain_cloud.scheduler_owner_dirty q WHERE q.workspace_id=v_ws AND q.member_id=v_author),0) INTO v_epoch;
 SELECT e.data INTO v_identity_page FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='page' AND e.id='qa-identity-test-page';
 SELECT e.data INTO v_identity_auto FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation' AND e.id=v_identity_context->>'resourceId';
 SELECT to_jsonb(j) INTO v_identity_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.id=(v_identity_claim->>'jobId')::uuid;
 SELECT to_jsonb(s) INTO v_identity_signal FROM fountain_cloud.workspace_signals s WHERE s.workspace_id=v_ws;
 SELECT count(*) INTO v_entity_count FROM fountain_private.entities e WHERE e.workspace_id=v_ws;
 DELETE FROM fountain_private.identity_mapping m WHERE m.workspace_id=v_ws AND m.auth_user_id=v_mapping.auth_user_id AND m.member_id=v_mapping.member_id AND m.linked_at=v_mapping.linked_at;
 GET DIAGNOSTICS v_affected=ROW_COUNT;IF v_affected<>1 THEN RAISE EXCEPTION 'QA mapping delete mismatch';END IF;
 INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id,linked_at) VALUES(v_ws,v_mapping.auth_user_id,v_mapping.member_id,v_mapping.linked_at);
 IF (SELECT to_jsonb(m) FROM fountain_private.identity_mapping m WHERE m.workspace_id=v_ws AND m.member_id=v_author) IS DISTINCT FROM to_jsonb(v_mapping) THEN RAISE EXCEPTION 'QA mapping UUID/member/linkedAt changed';END IF;
 SELECT q.identity_epoch INTO v_new_epoch FROM fountain_cloud.scheduler_owner_dirty q WHERE q.workspace_id=v_ws AND q.member_id=v_author;
 IF v_new_epoch IS DISTINCT FROM v_epoch+2 THEN RAISE EXCEPTION 'Paused same-UUID mapping events did not advance the sticky epoch';END IF;
 -- Distinguish the epoch denial from a stale/closed/revoked synthetic context:
 -- the actual live member/Auth mapping/grant/lease STILL passes service_context.
 PERFORM fountain_cloud.service_context(v_identity_context);
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.service_leases l WHERE l.workspace_id=v_ws AND l.grant_id=v_grant.id AND l.id=(v_identity_context->>'leaseId')::uuid AND NOT l.closed AND l.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'QA actual lease expired during the proof';END IF;
 v_denied:=false;
 BEGIN
  PERFORM public.fountain_cloud_service_commit(v_identity_context,(v_identity_request->>'expectedRevision')::bigint,v_identity_tx,v_identity_request->>'digest',v_identity_request->>'canonical',v_identity_request->'changes');
 EXCEPTION WHEN SQLSTATE 'PT401' THEN GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;IF v_message IS DISTINCT FROM 'Scheduler authority changed' THEN RAISE EXCEPTION 'QA replay denial was not the epoch guard';END IF;v_denied:=true;END;
 IF NOT v_denied THEN RAISE EXCEPTION 'Accepted old receipt survived the same-UUID epoch';END IF;
 v_selection:=jsonb_build_object('kinds','[]'::jsonb,'ids',jsonb_build_object('page',jsonb_build_array('qa-identity-test-page')),'metaKeys','[]'::jsonb,'pageSize',1);
 v_denied:=false;
 BEGIN
  PERFORM public.fountain_cloud_service_snapshot(v_identity_context,v_selection,NULL,NULL);
 EXCEPTION WHEN SQLSTATE 'PT401' THEN GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;IF v_message IS DISTINCT FROM 'Scheduler authority changed' THEN RAISE EXCEPTION 'QA snapshot denial was not the epoch guard';END IF;v_denied:=true;END;
 IF NOT v_denied THEN RAISE EXCEPTION 'New snapshot survived the same-UUID epoch';END IF;
 IF fountain_cloud.store_revision(v_ws,'_entity_revision')<>v_after_revision
  OR (SELECT e.data FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='page' AND e.id='qa-identity-test-page') IS DISTINCT FROM v_identity_page
  OR (SELECT e.data FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation' AND e.id=v_identity_context->>'resourceId') IS DISTINCT FROM v_identity_auto
  OR (SELECT to_jsonb(j) FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.id=(v_identity_claim->>'jobId')::uuid) IS DISTINCT FROM v_identity_job
  OR (SELECT to_jsonb(s) FROM fountain_cloud.workspace_signals s WHERE s.workspace_id=v_ws) IS DISTINCT FROM v_identity_signal
  OR (SELECT count(*) FROM fountain_private.entities e WHERE e.workspace_id=v_ws)<>v_entity_count
  OR (SELECT count(*) FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=v_grant.id AND r.authority_hash=v_identity_scope AND r.transaction_id=v_identity_tx)<>1 THEN RAISE EXCEPTION 'Denied old proof changed accepted state';END IF;
END $qa$;
SELECT jsonb_build_object('atomicRollback',true,'doneNewSnapshotDenied',true,'doneNewCommitDenied',true,'exactACKGraceVerified',true,'sameUUIDPausedEpochFence',true,'acceptedReceiptDenied',true,'newSnapshotDenied',true,'liveGrantAndLeaseStillValid',true,'sourcePreservedOnDenial',true,'operatorMappingEventOnly',true,'manufacturedAuthSession',false) AS proof;
