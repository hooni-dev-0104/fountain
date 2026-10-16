-- Operator-run actual PostgreSQL boundaries; no identities or grants are issued.
DO $qa$
DECLARE c jsonb:='{"kind":"automation","workspaceId":"fountain-qa-cloud-service-denial","memberId":"child","grantId":"11111111-1111-4111-8111-111111111111","grantVersion":1,"resourceId":"missing","runId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","leaseId":"22222222-2222-4222-8222-222222222222","generation":1,"ticketHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb;
 h jsonb:='{"workspaceId":"fountain-qa-cloud-service-denial","memberId":"local","userId":"11111111-1111-4111-8111-111111111111","authSessionId":"22222222-2222-4222-8222-222222222222","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb;
 selection jsonb:='{"kinds":[],"ids":{},"metaKeys":[],"pageSize":2}'::jsonb; found integer;
BEGIN
 IF EXISTS(SELECT 1 FROM fountain_cloud.service_grants WHERE workspace_id=c->>'workspaceId') THEN RAISE EXCEPTION 'Denial fixture namespace must be empty';END IF;
 SELECT count(*) INTO found FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN('fountain_cloud_service_snapshot','fountain_cloud_service_commit')
 AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE');
 IF found<>2 THEN RAISE EXCEPTION 'Service RPC grants changed';END IF;
 SELECT count(*) INTO found FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
 WHERE n.nspname='fountain_cloud' AND t.relname IN('service_grants','service_leases','service_commit_receipts')
 AND t.relrowsecurity AND t.relforcerowsecurity
 AND NOT has_table_privilege('anon',t.oid,'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('authenticated',t.oid,'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('service_role',t.oid,'SELECT,INSERT,UPDATE,DELETE');
 IF found<>3 THEN RAISE EXCEPTION 'Private service table protections changed';END IF;
 SELECT count(*) INTO found FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='fountain_cloud' AND p.proname IN('store_apply_changes_locked','store_snapshot_locked','service_context','service_data_ready','service_changes','service_snapshot','service_commit')
 AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE');
 IF found<>7 THEN RAISE EXCEPTION 'Private service kernel became directly callable';END IF;
 BEGIN PERFORM public.fountain_cloud_service_snapshot(c,selection);RAISE EXCEPTION 'Missing grant accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_service_commit(c,0,gen_random_uuid(),repeat('0',64),'{}','[]');RAISE EXCEPTION 'Missing grant commit accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_store_snapshot(c,selection);RAISE EXCEPTION 'Human RPC accepted service context';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_service_snapshot(h,selection);RAISE EXCEPTION 'Service RPC accepted human context';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_service_snapshot(jsonb_set(c,'{grantId}',jsonb_build_array(c->>'grantId')),selection);RAISE EXCEPTION 'Service UUID array accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
END $qa$;
SELECT jsonb_build_object('checks',8,'actual_postgres',true,'persistent_writes',false,'human_service_contracts_separate',true,'private_kernel_and_public_roles_denied',true) AS result;
