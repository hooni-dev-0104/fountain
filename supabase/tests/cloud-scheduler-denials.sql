-- Actual catalog and rejected-RPC checks; no workspace/ticket is registered.
DO $verify$
DECLARE t text;r text;f regprocedure;n integer:=0;
BEGIN
 FOREACH t IN ARRAY ARRAY['scheduler_registry','scheduler_due','scheduler_jobs','scheduler_attempts','scheduler_prepare_receipts','scheduler_owner_dirty'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='fountain_cloud' AND c.relname=t AND c.relrowsecurity AND c.relforcerowsecurity) THEN RAISE EXCEPTION 'Queue RLS unavailable';END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(r,'fountain_cloud.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Private queue exposed';END IF;
  END LOOP;
  n:=n+1;
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='fountain_cloud' AND p.proname LIKE 'scheduler_%' LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'Private scheduler helper exposed';END IF;
  END LOOP;
  n:=n+1;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.fountain_cloud_scheduler_open(text,uuid)'::regprocedure,'public.fountain_cloud_scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb)'::regprocedure] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'Scheduler wrapper grants invalid';END IF;
  n:=n+1;
 END LOOP;
 BEGIN
  PERFORM public.fountain_cloud_scheduler_open(repeat('0',64),gen_random_uuid());RAISE EXCEPTION 'Unknown ticket accepted';
 EXCEPTION WHEN SQLSTATE 'PT404' THEN n:=n+1;END;
 BEGIN
  PERFORM public.fountain_cloud_scheduler_prepare(repeat('0',64),gen_random_uuid(),0,gen_random_uuid(),repeat('0',64),'{}','{}');RAISE EXCEPTION 'Unknown prepare accepted';
 EXCEPTION WHEN SQLSTATE 'PT404' THEN n:=n+1;END;
 IF n<30 THEN RAISE EXCEPTION 'Incomplete scheduler catalog';END IF;
END $verify$;
SELECT jsonb_build_object('forcedPrivateQueueTables',6,'privateHelpers',(SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='fountain_cloud' AND p.proname LIKE 'scheduler_%'),'serverOnlyWrappers',2,'unknownTicketDenials',2) AS result;
