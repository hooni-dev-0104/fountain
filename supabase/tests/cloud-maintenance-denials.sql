-- OPERATOR QA after the reviewed broker + resource-hook migrations. This file
-- issues no grant/lease/ticket, installs no Cron, and performs no persistent DML.
-- Catalog/negative checks do NOT establish positive lifecycle/concurrency QA.
DO $qa$
#variable_conflict error
DECLARE v_table text;v_role text;v_function regprocedure;v_count integer:=0;v_case jsonb;v_context jsonb;v_body text;v_digest text;v_rejected boolean;
 v_manifest jsonb:=jsonb_build_object('version',1,'attachmentId','qa-object','offset',0,'size',1,'sha256',repeat('0',64));
 v_claim jsonb;v_invocation uuid:=gen_random_uuid();v_transaction uuid:=gen_random_uuid();
BEGIN
 FOREACH v_table IN ARRAY ARRAY['maintenance_registry','maintenance_attempts','maintenance_receipts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fountain_cloud' AND c.relname=v_table AND c.relpersistence='p' AND c.relrowsecurity AND c.relforcerowsecurity) THEN RAISE EXCEPTION 'Private LOGGED maintenance table missing';END IF;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(v_role,'fountain_cloud.'||v_table,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Private maintenance table exposed';END IF;
  END LOOP;v_count:=v_count+1;
 END LOOP;
 FOR v_function IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_cloud' AND p.proname LIKE 'maintenance_%' LOOP
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(v_role,v_function,'EXECUTE') THEN RAISE EXCEPTION 'Private maintenance helper exposed';END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_function::oid AND p.proconfig @> ARRAY['search_path=pg_catalog']) THEN RAISE EXCEPTION 'Private helper search path changed';END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_cloud' AND p.proname IN('maintenance_context','maintenance_ticket','maintenance_open','maintenance_claim_valid','maintenance_resource_check','maintenance_step','maintenance_owned','maintenance_cleanup','maintenance_dispatch','maintenance_rotate','maintenance_install','maintenance_remove'))<>12 THEN RAISE EXCEPTION 'Broker helper missing';END IF;v_count:=v_count+1;
 FOREACH v_function IN ARRAY ARRAY['public.fountain_cloud_maintenance_open(text,uuid)'::regprocedure,'public.fountain_cloud_maintenance_step(jsonb,uuid,uuid,text,text,text,jsonb)'::regprocedure] LOOP
  IF NOT has_function_privilege('service_role',v_function,'EXECUTE') OR has_function_privilege('anon',v_function,'EXECUTE') OR has_function_privilege('authenticated',v_function,'EXECUTE') THEN RAISE EXCEPTION 'Maintenance server RPC grants invalid';END IF;v_count:=v_count+1;
 END LOOP;
 SELECT pg_get_functiondef('fountain_cloud.maintenance_step(jsonb,uuid,uuid,text,text,text,jsonb)'::regprocedure) INTO v_body;
 IF strpos(v_body,'v_attempt.state NOT IN(''observe'',''delete'')')=0
  OR strpos(v_body,'maintenance_resource_check(v_attempt.workspace_id,v_attempt.purpose,v_attempt.claim)')=0
  OR strpos(v_body,'maintenance_resource_check(v_attempt.workspace_id,v_attempt.purpose,v_attempt.claim)')>strpos(v_body,'INTO v_receipt') THEN RAISE EXCEPTION 'Observe/delete checks must revalidate before receipt replay';END IF;v_count:=v_count+1;
 -- The namespace is never registered; valid-looking context is only a negative
 -- input, not fabricated authority, and does not touch Auth users/sessions.
 v_context:=jsonb_build_object('kind','maintenance','workspaceId','fountain-qa-cloud-maintenance-denial','purpose','upload-gc','grantId','11111111-1111-4111-8111-111111111111','grantVersion',1,'leaseId','22222222-2222-4222-8222-222222222222','generation',1,'ticketHash',repeat('0',64));
 IF EXISTS(SELECT 1 FROM fountain_cloud.maintenance_registry r WHERE r.workspace_id=v_context->>'workspaceId') OR EXISTS(SELECT 1 FROM fountain_cloud.maintenance_attempts a WHERE a.ticket_hash=repeat('0',64)) THEN RAISE EXCEPTION 'Denial namespace/hash must be empty';END IF;
 FOREACH v_body IN ARRAY ARRAY[NULL::text,'bad',repeat('A',64),repeat('0',64)] LOOP
  v_rejected:=false;BEGIN PERFORM public.fountain_cloud_maintenance_open(v_body,v_invocation);EXCEPTION WHEN SQLSTATE 'PT404' THEN v_rejected:=true;END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Invalid/unknown ticket accepted';END IF;v_count:=v_count+1;
 END LOOP;
 v_body:=jsonb_build_object('context',v_context,'invocationId',v_invocation,'action','claim','payload','{}'::jsonb)::text;v_digest:=encode(sha256(convert_to(v_body,'UTF8')),'hex');
 v_rejected:=false;BEGIN PERFORM public.fountain_cloud_maintenance_step(v_context,v_invocation,v_transaction,v_digest,v_body,'claim','{}');EXCEPTION WHEN SQLSTATE 'PT404' THEN v_rejected:=true;END;
 IF NOT v_rejected THEN RAISE EXCEPTION 'Unknown step accepted';END IF;v_count:=v_count+1;
 FOR v_case IN SELECT j.value FROM jsonb_array_elements('[{"kind":"automation"},null,[],{"kind":"maintenance","ticketHash":"bad"}]'::jsonb) j LOOP
  v_rejected:=false;
  BEGIN
   PERFORM public.fountain_cloud_maintenance_step(v_case,v_invocation,v_transaction,repeat('0',64),'{}','claim','{}');
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected:=true;END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Invalid step shape/digest accepted';END IF;v_count:=v_count+1;
 END LOOP;
 v_rejected:=false;BEGIN PERFORM public.fountain_cloud_maintenance_step(v_context,v_invocation,v_transaction,v_digest,v_body,'claim','{"id":"client-selected"}');EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected:=true;END;
 IF NOT v_rejected THEN RAISE EXCEPTION 'Client-selected resource accepted';END IF;v_count:=v_count+1;
 PERFORM fountain_cloud.maintenance_claim_valid('{"mode":"none"}');
 v_claim:=jsonb_build_object('mode','observe','resourceId','qa-resource','fingerprint',repeat('a',64),'manifests',jsonb_build_array(v_manifest));PERFORM fountain_cloud.maintenance_claim_valid(v_claim);
 PERFORM fountain_cloud.maintenance_claim_valid(v_claim||jsonb_build_object('mode','delete'));
 -- Numeric JSON scale is not a different integer. Match the common manifest
 -- validator and reject semantically duplicate offsets across representations.
 PERFORM fountain_cloud.maintenance_claim_valid(v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"offset":0.0,"size":4.0}')));v_count:=v_count+1;
 FOR v_case IN SELECT * FROM(VALUES
  ('null'::jsonb),('{}'::jsonb),(v_claim||'{"mode":null}'),(v_claim||'{"mode":"none"}'),
  (v_claim||'{"manifests":[]}'),(v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest,v_manifest))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"offset":1}'))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"size":4194305}'))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"attachmentId":"../other"}'))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"attachmentId":"x\\y"}'))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"offset":false}'))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"size":0}'))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"sha256":"secret"}'))),
  (v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"path":"private"}')))
  ,(v_claim||jsonb_build_object('manifests',jsonb_build_array(v_manifest||'{"size":4.5}')))
  ,(v_claim||jsonb_build_object('mode','delete','manifests',jsonb_build_array(v_manifest,v_manifest||'{"offset":0.0,"size":4.0}')))
 ) x(claim) LOOP
  v_rejected:=false;BEGIN PERFORM fountain_cloud.maintenance_claim_valid(v_case);EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected:=true;END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Invalid private claim accepted';END IF;v_count:=v_count+1;
 END LOOP;
 IF v_count<>34 THEN RAISE EXCEPTION 'Incomplete maintenance negative QA: %',v_count;END IF;
END $qa$;
SELECT jsonb_build_object('checks',34,'persistentWrites',false,'credentialsIssued',false,'positiveLifecycleExecuted',false) AS proof;
