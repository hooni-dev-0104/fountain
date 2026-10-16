-- OPERATOR negative QA only, after the reviewed storage-gc-fences migration.
-- No real Auth context, namespace, object, grant or positive tombstone is made.
-- These catalog/rejected-call probes are NOT positive Storage or race evidence.
DO $qa$
#variable_conflict error
DECLARE v_ws text:='fountain-qa-storage-fence-negative';v_role text;v_count integer;v_denied boolean;v_item jsonb;v_func regprocedure;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fountain_cloud' AND c.relname='storage_gc_tombstones' AND c.relrowsecurity AND c.relforcerowsecurity) THEN RAISE EXCEPTION 'Permanent Storage fences lack forced RLS';END IF;
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(v_role,'fountain_cloud.storage_gc_tombstones','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Permanent Storage fences exposed';END IF;
 END LOOP;
 SELECT count(*) INTO v_count FROM pg_indexes WHERE indexname IN('storage_pin_attachment','storage_pin_overlay','storage_pin_source_extra','storage_pin_source_cloud','storage_pin_artifact');
 IF v_count<>5 THEN RAISE EXCEPTION 'Scalar Storage pin indexes unavailable';END IF;
 FOR v_func IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_cloud' AND(p.proname LIKE 'storage_gc_%' OR p.proname='upload_gc_fence') LOOP
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(v_role,v_func,'EXECUTE') THEN RAISE EXCEPTION 'Private Storage helper exposed';END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb)','EXECUTE') OR has_function_privilege('anon','public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Real-person Storage fence wrapper grants invalid';END IF;
 SELECT count(*) INTO v_count FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT t.tgisinternal AND t.tgname IN('fountain_storage_gc_entity','fountain_storage_gc_source','fountain_storage_gc_part') AND (t.tgtype & 2)=2;
 IF v_count<>3 THEN RAISE EXCEPTION 'BEFORE reference guards missing';END IF;
 v_denied:=false;
 BEGIN PERFORM fountain_cloud.storage_gc_fence(v_ws,NULL);EXCEPTION WHEN SQLSTATE 'PT409' THEN v_denied:=true;END;
 IF NOT v_denied THEN RAISE EXCEPTION 'Invalid identity retired';END IF;
 FOR v_item IN SELECT x.value FROM(VALUES('{}'::jsonb),('{"version":1,"attachmentId":"qa","offset":0,"size":0,"sha256":"bad"}'::jsonb),('{"version":1,"attachmentId":"other","offset":0,"size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb)) x(value) LOOP
  v_denied:=false;
  BEGIN PERFORM fountain_cloud.storage_gc_manifest(v_item,'qa');EXCEPTION WHEN SQLSTATE 'PT409' THEN v_denied:=true;END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Malformed Storage manifest accepted';END IF;
 END LOOP;
 v_denied:=false;
 BEGIN PERFORM public.fountain_cloud_upload_gc_fence('{}'::jsonb,'qa','[]'::jsonb);EXCEPTION WHEN invalid_parameter_value OR SQLSTATE 'PT401' THEN v_denied:=true;END;
 IF NOT v_denied THEN RAISE EXCEPTION 'Unauthenticated cleanup accepted';END IF;
 IF EXISTS(SELECT 1 FROM fountain_cloud.storage_gc_tombstones t WHERE t.workspace_id=v_ws) THEN RAISE EXCEPTION 'Negative checks created a tombstone';END IF;
END $qa$;
SELECT jsonb_build_object('privateTombstoneTable',true,'scalarPinIndexes',5,'beforeReferenceGuards',3,'rejectedManifestCalls',3,'realAuthOrPhysicalIO',false,'persistentWrites',false) AS proof;
