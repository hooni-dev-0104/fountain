-- Run as postgres inside this rollback-only regression. No Auth is stubbed.
BEGIN;
DO $grants$ BEGIN
 IF NOT has_function_privilege('service_role','fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb)','EXECUTE')
  OR has_function_privilege('anon','fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'Store commit service/client execution boundary changed';
 END IF;
END $grants$;
SET LOCAL ROLE service_role;
DO $call_chain$
DECLARE reached_auth boolean:=false;
BEGIN
 BEGIN
  PERFORM public.fountain_cloud_store_commit(
   jsonb_build_object('workspaceId','fountain-qa-callchain-missing','memberId','missing',
    'userId','00000000-0000-4000-8000-000000000001','authSessionId','00000000-0000-4000-8000-000000000002',
    'sessionHash',repeat('a',64),'cacheBinding',repeat('b',32)),
   0,'00000000-0000-4000-8000-000000000003'::uuid,repeat('a',64),'{}','[]'::jsonb);
 EXCEPTION WHEN SQLSTATE 'PT401' THEN reached_auth:=true;
 END;
 IF NOT reached_auth THEN RAISE EXCEPTION 'Public wrapper did not reach live authorization';END IF;
END $call_chain$;
SELECT current_user='service_role' AS actual_service_role, true AS public_wrapper_reached_auth_denial;
ROLLBACK;
