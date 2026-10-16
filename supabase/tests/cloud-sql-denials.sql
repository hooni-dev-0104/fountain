-- Operator-run actual Postgres regression after the account/backup migrations.
-- No production namespace, Auth identities or persistent writes are required.
DO $qa$
DECLARE c jsonb:='{"workspaceId":"fountain-qa-cloud-denial","memberId":"local","userId":"11111111-1111-4111-8111-111111111111","authSessionId":"22222222-2222-4222-8222-222222222222","sessionHash":"0000000000000000000000000000000000000000000000000000000000000000","cacheBinding":"00000000000000000000000000000000"}'::jsonb; found integer;
BEGIN
 SELECT count(*) INTO found FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('fountain_cloud_bootstrap_begin','fountain_cloud_accounts','fountain_cloud_account_revoke_attempt','fountain_cloud_backup_authorize','fountain_cloud_backup_export','fountain_cloud_backup_jobs')
 AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE');
 IF found<>6 THEN RAISE EXCEPTION 'Cloud RPC grants changed';END IF;
 SELECT count(*) INTO found FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
 WHERE n.nspname='fountain_cloud' AND t.relname IN('backup_jobs','backup_job_source','backup_job_plan','backup_job_output','backup_job_parts','backup_job_receipts')
 AND t.relrowsecurity AND t.relforcerowsecurity
 AND NOT has_table_privilege('anon',t.oid,'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('authenticated',t.oid,'SELECT,INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('service_role',t.oid,'SELECT,INSERT,UPDATE,DELETE');
 IF found<>6 THEN RAISE EXCEPTION 'Private backup table protections changed';END IF;
 BEGIN PERFORM public.fountain_cloud_backup_jobs(c,'gate','{}');RAISE EXCEPTION 'Unlinked job export gate accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_backup_jobs(c,'gate_cleanup','{}');RAISE EXCEPTION 'Unlinked job cleanup gate accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_backup_jobs(c,'gc_next','{}');RAISE EXCEPTION 'Unlinked job maintenance accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_accounts(c,'list');RAISE EXCEPTION 'Unlinked accounts context accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_backup_authorize(c);RAISE EXCEPTION 'Unlinked backup context accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_backup_export(c);RAISE EXCEPTION 'Unlinked backup export accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_bootstrap_begin(c->>'workspaceId',repeat('0',64));RAISE EXCEPTION 'Missing bootstrap accepted';EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_account_revoke_attempt(c,'local','33333333-3333-4333-8333-333333333333',repeat('0',64));RAISE EXCEPTION 'Missing account intent accepted';EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;END;
END $qa$;
SELECT jsonb_build_object('checks',10,'real_postgres',true,'persistent_writes',false,'unlinked_contexts_rejected',true,'public_role_execution_denied',true) AS result;
