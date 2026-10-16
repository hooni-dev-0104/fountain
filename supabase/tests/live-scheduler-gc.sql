-- Operator age injection, not evidence that two days elapsed. Root first runs
-- two distinct actual worker slots on ONE still-enabled grant in this namespace.
-- Only the older accepted attempt is aged; user entities/history stay intact.
DO $verify$
#variable_conflict error
DECLARE v_ws constant text:='__QA_WORKSPACE__';v_registry fountain_cloud.scheduler_registry;
 v_old fountain_cloud.scheduler_jobs;v_fresh fountain_cloud.scheduler_jobs;
 v_attempt fountain_cloud.scheduler_attempts;v_fresh_attempt fountain_cloud.scheduler_attempts;
 v_fresh_lease jsonb;v_grant uuid;v_before text;v_after text;v_age timestamptz:=clock_timestamp()-interval '2 days';
BEGIN
 IF v_ws!~'^fountain-qa-cloud-scheduler-[a-f0-9]{16}$' THEN RAISE EXCEPTION 'Disposable scope required';END IF;
 PERFORM fountain_cloud.store_lock(v_ws);PERFORM set_config('fountain.workspace_id',v_ws,true);
 SELECT r.* INTO STRICT v_registry FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=v_ws AND r.enabled;
 PERFORM fountain_cloud.scheduler_owned(v_registry);
 IF (SELECT count(*) FROM fountain_cloud.scheduler_jobs WHERE workspace_id=v_ws AND automation_id='qa-gc-busy')<>2
  OR EXISTS(SELECT 1 FROM fountain_cloud.scheduler_jobs WHERE workspace_id=v_ws AND automation_id='qa-gc-busy' AND (state<>'done' OR outcome<>'data_succeeded')) THEN RAISE EXCEPTION 'Two actual accepted worker slots required';END IF;
 SELECT j.* INTO STRICT v_old FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.automation_id='qa-gc-busy' ORDER BY j.fixed_now,j.id LIMIT 1;
 SELECT j.* INTO STRICT v_fresh FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.automation_id='qa-gc-busy' AND j.id<>v_old.id;
 SELECT a.* INTO STRICT v_attempt FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=v_ws AND a.job_id=v_old.id AND a.generation=v_old.generation;
 SELECT a.* INTO STRICT v_fresh_attempt FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=v_ws AND a.job_id=v_fresh.id AND a.generation=v_fresh.generation;
 v_grant:=v_attempt.grant_id;
 IF v_grant IS NULL OR v_fresh_attempt.grant_id IS DISTINCT FROM v_grant
  OR NOT EXISTS(SELECT 1 FROM fountain_cloud.service_grants WHERE workspace_id=v_ws AND id=v_grant AND enabled AND version=1)
  OR (SELECT count(*) FROM fountain_cloud.service_commit_receipts WHERE workspace_id=v_ws AND grant_id=v_grant)<>2 THEN RAISE EXCEPTION 'One busy grant and two real receipts required';END IF;
 SELECT to_jsonb(l) INTO STRICT v_fresh_lease FROM fountain_cloud.service_leases l WHERE l.workspace_id=v_ws AND l.grant_id=v_grant AND l.id=v_fresh_attempt.lease_id;
 SELECT encode(sha256(convert_to(jsonb_agg(e.data ORDER BY e.kind,e.id)::text,'UTF8')),'hex') INTO v_before FROM fountain_private.entities e WHERE e.workspace_id=v_ws;
 UPDATE fountain_cloud.scheduler_attempts a SET work_until=v_age,ack_until=v_age+interval '60 seconds' WHERE a.workspace_id=v_ws AND a.id=v_attempt.id;
 UPDATE fountain_cloud.service_leases l SET expires_at=v_age+interval '60 seconds' WHERE l.workspace_id=v_ws AND l.grant_id=v_grant AND l.id=v_attempt.lease_id;
 UPDATE fountain_cloud.scheduler_jobs j SET finished_at=v_age WHERE j.workspace_id=v_ws AND j.id=v_old.id;
 PERFORM fountain_cloud.scheduler_cleanup(v_registry);
 IF EXISTS(SELECT 1 FROM fountain_cloud.scheduler_attempts WHERE workspace_id=v_ws AND id=v_attempt.id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.scheduler_jobs WHERE workspace_id=v_ws AND id=v_old.id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.service_leases WHERE workspace_id=v_ws AND grant_id=v_grant AND id=v_attempt.lease_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.service_commit_receipts WHERE workspace_id=v_ws AND grant_id=v_grant AND authority_hash=v_attempt.authority_hash)
  OR EXISTS(SELECT 1 FROM fountain_cloud.scheduler_prepare_receipts WHERE workspace_id=v_ws AND attempt_id=v_attempt.id) THEN RAISE EXCEPTION 'Expired authority cleanup made no progress';END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.service_grants WHERE workspace_id=v_ws AND id=v_grant AND enabled AND version=1)
  OR NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=v_ws AND a.id=v_fresh_attempt.id AND to_jsonb(a)=to_jsonb(v_fresh_attempt))
  OR NOT EXISTS(SELECT 1 FROM fountain_cloud.service_leases l WHERE l.workspace_id=v_ws AND l.grant_id=v_grant AND l.id=v_fresh_attempt.lease_id AND to_jsonb(l)=v_fresh_lease)
  OR (SELECT count(*) FROM fountain_cloud.service_commit_receipts WHERE workspace_id=v_ws AND grant_id=v_grant)<>1 THEN RAISE EXCEPTION 'Fresh busy authority was altered';END IF;
 SELECT encode(sha256(convert_to(jsonb_agg(e.data ORDER BY e.kind,e.id)::text,'UTF8')),'hex') INTO v_after FROM fountain_private.entities e WHERE e.workspace_id=v_ws;
 IF v_before IS DISTINCT FROM v_after OR (SELECT count(*) FROM fountain_private.entities WHERE workspace_id=v_ws AND kind='automation_run' AND data->>'automation_id'='qa-gc-busy')<>2 THEN RAISE EXCEPTION 'Business/history changed during internal GC';END IF;
 INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,'_qa_scheduler_gc',jsonb_build_object('twoActualSlotsSameGrant',true,'expiredAttemptReceiptLeaseJobRemoved',true,'freshAttemptLeaseReceiptPreserved',true,'grantStillEnabled',true,'allBusinessEntitiesSHAUnchanged',true,'userRunHistoryPreserved',2,'operatorAgeInjection',true));
END $verify$;
SELECT data AS proof FROM fountain_private.meta WHERE workspace_id='__QA_WORKSPACE__' AND key='_qa_scheduler_gc';
