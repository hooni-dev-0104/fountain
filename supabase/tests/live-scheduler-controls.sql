-- Read-only assertions over Root's sealed five-control fixture after delivery.
-- The missing author and prior run are deliberate legacy-data fixtures; no
-- human SID, fake principal or permission-bearing mapping is manufactured.
DO $verify$
DECLARE ws constant text:='__QA_WORKSPACE__'; item record; expected text; run_count integer; observed integer:=0; observed_ids text[]:=ARRAY[]::text[];
BEGIN
 IF ws!~'^fountain-qa-cloud-scheduler-[a-f0-9]{16}$' THEN RAISE EXCEPTION 'Disposable scope required';END IF;
 FOR item IN SELECT j.*,a.grant_id,r.status_code FROM fountain_cloud.scheduler_jobs j JOIN fountain_cloud.scheduler_attempts a ON a.workspace_id=j.workspace_id AND a.job_id=j.id AND a.generation=j.generation
  LEFT JOIN net._http_response r ON r.id=a.net_request_id WHERE j.workspace_id=ws AND j.automation_id IN('qa-scheduler-invalid','qa-scheduler-missing-author','qa-scheduler-completed','qa-scheduler-future','qa-scheduler-duplicate') LOOP
  observed:=observed+1;
  observed_ids:=array_append(observed_ids,item.automation_id);
  expected:=CASE item.automation_id WHEN 'qa-scheduler-invalid' THEN 'invalid' WHEN 'qa-scheduler-missing-author' THEN 'author_unavailable' WHEN 'qa-scheduler-completed' THEN 'complete' WHEN 'qa-scheduler-future' THEN 'defer' ELSE 'deduplicated' END;
  IF item.state IS DISTINCT FROM 'done' OR item.outcome IS DISTINCT FROM expected OR item.status_code IS DISTINCT FROM 200 OR item.grant_id IS NOT NULL OR item.generation<>1 THEN RAISE EXCEPTION 'Control outcome or no-data authority failed';END IF;
  SELECT count(*) INTO run_count FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='automation_run' AND e.data->>'automation_id'=item.automation_id;
  IF run_count<>(CASE WHEN expected IN('complete','defer') THEN 0 ELSE 1 END) THEN RAISE EXCEPTION 'Control run count failed';END IF;
  IF expected IN('invalid','author_unavailable') AND NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='automation_run' AND e.id=item.run_id
   AND e.data->>'status'='failed' AND e.created_at=fountain_cloud.scheduler_store_stamp(item.fixed_now) AND e.updated_at=e.created_at
   AND e.data->>'started_at'=fountain_cloud.scheduler_stamp(item.fixed_now) AND e.data->>'finished_at'=e.data->>'started_at') THEN RAISE EXCEPTION 'Control failure timestamps failed';END IF;
  IF expected='invalid' AND NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='automation' AND e.id=item.automation_id AND e.data->'enabled'='false'::jsonb AND e.data->'next_run_at'='null'::jsonb) THEN RAISE EXCEPTION 'Invalid source not disabled';END IF;
  IF expected='complete' AND NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='automation' AND e.id=item.automation_id AND e.data->'enabled'='false'::jsonb AND e.data->>'schedule_status'='completed') THEN RAISE EXCEPTION 'Past-end source not completed';END IF;
 END LOOP;
 IF observed<>5 OR (SELECT count(DISTINCT id) FROM unnest(observed_ids) AS ids(id))<>5 OR (SELECT count(*) FROM fountain_cloud.scheduler_jobs WHERE workspace_id=ws AND automation_id LIKE 'qa-scheduler-%')<>5 THEN RAISE EXCEPTION 'Five distinct delivered controls required';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='page' AND e.data->>'title' LIKE 'DO_NOT_CREATE_%')
  OR EXISTS(SELECT 1 FROM fountain_cloud.service_grants g WHERE g.workspace_id=ws AND g.resource_id='qa-scheduler-missing-author') THEN RAISE EXCEPTION 'Control manufactured data authority or action';END IF;
END $verify$;
SELECT jsonb_build_object('actualControlOutcomes',5,'noControlDataLeases',true,'unexpectedPageActions',0,'failureTimestampParity',true,'sourceEntityRevision',data) AS result
 FROM fountain_private.meta WHERE workspace_id='__QA_WORKSPACE__' AND key='_entity_revision';
