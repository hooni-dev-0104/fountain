-- OPERATOR negative QA only, after reviewed cloud-scim-bearer migration.
-- No credentials, sessions, fake owner/SID, fixtures or member rows are created.
-- Missing token/workspace calls must have identical PT401 and safe fixed text.
-- Deprovision positive/race/rollback tests require Root's real isolated accounts;
-- these metadata/negative checks do NOT claim that lifecycle was executed here.
DO $qa$
#variable_conflict error
DECLARE v_ws text:='fountain-qa-cloud-scim-bearer-denial';v_hash text:=repeat('0',64);
 v_count bigint;v_message text;v_item record;v_denied boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_ws) THEN RAISE EXCEPTION 'Denial namespace must have no grants';END IF;
 SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fountain_cloud_scim_authorize' AND pg_get_function_identity_arguments(p.oid)='p_workspace_id text, p_token_hash text'
  AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE') AND p.prosecdef;
 IF v_count<>1 THEN RAISE EXCEPTION 'SCIM public RPC role boundary changed';END IF;
 SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='fountain_cloud' AND p.proname IN('scim_authorize','member_deprovision_preflight','store_apply_changes_locked')
  AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE');
 IF v_count<>3 THEN RAISE EXCEPTION 'SCIM private helper became directly callable';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_cloud' AND p.proname='vault_create' AND NOT p.prosecdef
  AND has_function_privilege('service_role',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'Existing vault invoker privileges changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='fountain_cloud' AND c.relname='service_grants_scim_token_unique' AND i.indisunique AND i.indisvalid) THEN RAISE EXCEPTION 'SCIM token uniqueness index missing';END IF;
 FOR v_item IN SELECT * FROM(VALUES(v_ws,v_hash),(v_ws,NULL::text),(v_ws,'bad'),(v_ws,repeat('A',64)),(NULL::text,v_hash),(''::text,v_hash),(repeat('x',161),v_hash),('fountain-qa-cloud-scim-wrong-workspace',v_hash)) x(workspace_id,token_hash) LOOP
  v_denied:=false;
  BEGIN
   PERFORM public.fountain_cloud_scim_authorize(v_item.workspace_id,v_item.token_hash);
  EXCEPTION WHEN SQLSTATE 'PT401' THEN
   GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
   IF v_message IS DISTINCT FROM 'SCIM authentication required' THEN RAISE EXCEPTION 'SCIM token denial exposed different diagnostics';END IF;v_denied:=true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Invalid SCIM bearer was accepted';END IF;
 END LOOP;
END $qa$;
SELECT jsonb_build_object('metadataChecks',4,'uniformTokenDenials',8,'credentialsIssued',false,'persistentWrites',false,'deprovisionLifecycleExecuted',false) AS proof;
