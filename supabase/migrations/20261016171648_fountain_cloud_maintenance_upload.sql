-- DRAFT ONLY. Requires maintenance broker + storage-gc-fences. Private hooks
-- are called only under the broker's current MaintenanceContext/workspace lock.
-- No registration/backfill, Auth principal, physical I/O or quota reset occurs.
CREATE INDEX maintenance_upload_keyset ON fountain_private.entities(workspace_id,kind,created_at COLLATE "C",id COLLATE "C") WHERE kind IN('upload','upload_gc');

CREATE FUNCTION fountain_cloud.maintenance_upload_valid(p_data jsonb,p_id text,p_gc boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_size numeric;v_offset numeric;v_last bigint:=-1;v_end bigint:=0;v_item jsonb;v_pending jsonb;v_count integer;
BEGIN
 IF p_gc IS NULL OR NOT fountain_cloud.storage_gc_id(p_id) OR jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>1126400
  OR jsonb_typeof(p_data->'id') IS DISTINCT FROM 'string' OR p_data->>'id' IS DISTINCT FROM p_id
  OR jsonb_typeof(p_data->'created_at') IS DISTINCT FROM 'string' OR length(p_data->>'created_at') NOT BETWEEN 1 AND 64
  OR jsonb_typeof(p_data->'updated_at') IS DISTINCT FROM 'string' OR length(p_data->>'updated_at') NOT BETWEEN 1 AND 64
  OR jsonb_typeof(p_data->'owner_id') IS DISTINCT FROM 'string' OR length(p_data->>'owner_id') NOT BETWEEN 1 AND 160
  OR(p_data ? 'page_id' AND p_data->'page_id'<>'null'::jsonb AND(jsonb_typeof(p_data->'page_id') IS DISTINCT FROM 'string' OR length(p_data->>'page_id') NOT BETWEEN 1 AND 160)) THEN RETURN false;END IF;
 v_item:=p_data->CASE WHEN p_gc THEN 'reserved_bytes' ELSE 'size' END;
 IF jsonb_typeof(v_item) IS DISTINCT FROM 'number' THEN RETURN false;END IF;
 v_size:=(v_item#>>'{}')::numeric;IF v_size<0 OR v_size>5000000000 OR v_size<>trunc(v_size) THEN RETURN false;END IF;
 v_pending:=COALESCE(p_data->'pending','null'::jsonb);
 IF NOT p_gc THEN
  IF jsonb_typeof(p_data->'completed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_data->'offset') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  v_offset:=(p_data->>'offset')::numeric;IF v_offset<0 OR v_offset>v_size OR v_offset<>trunc(v_offset) THEN RETURN false;END IF;
  IF p_data->'completed'='true'::jsonb AND(v_offset<>v_size OR v_pending<>'null'::jsonb) THEN RETURN false;END IF;
  -- Completed legacy receipts can lack cloud manifests; remove only metadata.
  IF p_data->'completed'='true'::jsonb AND NOT(p_data ? 'cloud_chunks') THEN RETURN true;END IF;
  PERFORM fountain_cloud.storage_gc_layout(p_data,p_id,true);v_end:=v_offset::bigint;
 END IF;
 IF jsonb_typeof(p_data->'cloud_chunks') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 v_count:=jsonb_array_length(p_data->'cloud_chunks');IF v_count>1193 THEN RETURN false;END IF;
 -- GC arrays may have an already-deleted prefix. Validate monotonic remaining
 -- offsets without expanding arrays in any live-reference lookup.
 IF p_gc THEN FOR v_item IN SELECT j.value FROM jsonb_array_elements(p_data->'cloud_chunks') j LOOP
  PERFORM fountain_cloud.storage_gc_manifest(v_item,p_id);
  v_offset:=(v_item->>'offset')::numeric;
  IF v_offset<=v_last OR v_offset<v_end OR v_offset+(v_item->>'size')::numeric>v_size THEN RETURN false;END IF;
  v_last:=v_offset::bigint;v_end:=v_last+(v_item->>'size')::numeric::bigint;
 END LOOP;END IF;
 IF v_pending<>'null'::jsonb THEN
  IF jsonb_typeof(v_pending) IS DISTINCT FROM 'object' OR NOT(v_pending ?& ARRAY['offset','size','sha256','attempt_id']) OR v_pending-ARRAY['offset','size','sha256','attempt_id']<>'{}'::jsonb
   OR jsonb_typeof(v_pending->'attempt_id') IS DISTINCT FROM 'string' OR(v_pending->>'attempt_id')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(v_pending->'offset') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  v_offset:=(v_pending->>'offset')::numeric;
  IF v_offset<v_end OR(NOT p_gc AND v_offset<>(p_data->>'offset')::numeric) OR v_offset>=v_size OR v_offset<>trunc(v_offset) THEN RETURN false;END IF;
  PERFORM fountain_cloud.storage_gc_manifest(jsonb_build_object('version',1,'attachmentId',p_id,'offset',v_pending->'offset','size',v_pending->'size','sha256',v_pending->'sha256'),p_id,v_offset::bigint,least(4194304,v_size::bigint-v_offset::bigint));
 END IF;
 RETURN true;
EXCEPTION WHEN data_exception OR SQLSTATE 'PT409' THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_upload_valid(jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_upload_claim(p_workspace_id text,p_now_ms bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_cursors jsonb;v_cursor jsonb;v_through jsonb;v_after jsonb;v_position jsonb;v_before jsonb;v_row record;v_data jsonb;v_gc jsonb;
 v_kind text;v_key text;v_order text[];v_limit integer;v_seen integer;v_budget integer:=1126400;v_bytes integer;v_expiry timestamptz;
 v_changes jsonb;v_stamp text;v_manifests jsonb;v_pending jsonb;v_claim jsonb;v_mode text;
BEGIN
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR p_now_ms IS NULL OR p_now_ms NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Invalid maintenance request' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);PERFORM set_config('fountain.workspace_id',p_workspace_id,true);
 SELECT r.cursors INTO v_cursors FROM fountain_cloud.maintenance_registry r WHERE r.workspace_id=p_workspace_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Maintenance authorization required' USING ERRCODE='PT401';END IF;
 -- Alternation gives a maximal legal GC row the whole byte budget at least
 -- every other call; a perpetual stream of expiry rows cannot starve it.
 IF v_cursors->>'upload_turn'='gc' THEN v_order:=ARRAY['upload_gc','upload'];v_cursors:=jsonb_set(v_cursors,'{upload_turn}','"expiry"');
 ELSE v_order:=ARRAY['upload','upload_gc'];v_cursors:=jsonb_set(v_cursors,'{upload_turn}','"gc"');END IF;
 FOREACH v_kind IN ARRAY v_order LOOP
  v_key:=CASE WHEN v_kind='upload' THEN 'upload_expiry' ELSE 'upload_gc' END;v_limit:=CASE WHEN v_kind='upload' THEN 32 ELSE 1 END;v_seen:=0;v_gc:=NULL;
  v_cursor:=v_cursors->v_key;v_after:=v_cursor->'after';v_through:=v_cursor->'through';
  IF jsonb_typeof(v_after) IS DISTINCT FROM 'object' OR jsonb_typeof(v_through) IS DISTINCT FROM 'object'
   OR jsonb_typeof(v_after->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v_after->'id') IS DISTINCT FROM 'string'
   OR jsonb_typeof(v_through->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v_through->'id') IS DISTINCT FROM 'string'
   OR length(v_after->>'created_at') NOT BETWEEN 1 AND 64 OR length(v_after->>'id') NOT BETWEEN 1 AND 160
   OR length(v_through->>'created_at') NOT BETWEEN 1 AND 64 OR length(v_through->>'id') NOT BETWEEN 1 AND 160
   OR(v_after->>'created_at' COLLATE "C",v_after->>'id' COLLATE "C")>(v_through->>'created_at' COLLATE "C",v_through->>'id' COLLATE "C") THEN
   v_after:=NULL;
   SELECT jsonb_build_object('created_at',e.created_at,'id',e.id) INTO v_through FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind=v_kind AND e.kind IN('upload','upload_gc') ORDER BY e.created_at COLLATE "C" DESC,e.id COLLATE "C" DESC LIMIT 1;
  END IF;
  FOR v_row IN SELECT e.id,e.created_at,e.updated_at
   FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind=v_kind AND e.kind IN('upload','upload_gc') AND v_through IS NOT NULL
    AND(e.created_at COLLATE "C",e.id COLLATE "C")<=(v_through->>'created_at' COLLATE "C",v_through->>'id' COLLATE "C")
    AND(v_after IS NULL OR(e.created_at COLLATE "C",e.id COLLATE "C")>(v_after->>'created_at' COLLATE "C",v_after->>'id' COLLATE "C"))
   ORDER BY e.created_at COLLATE "C",e.id COLLATE "C" LIMIT v_limit LOOP
   v_seen:=v_seen+1;v_position:=jsonb_build_object('created_at',v_row.created_at,'id',v_row.id);
   v_before:=COALESCE(v_cursors->v_key,'null'::jsonb);
   -- Do NOT put this probe in the FOR query: SPI may prefetch all 32 targetlist
   -- expressions before the loop can stop. A compressed oversized legacy row
   -- can require one full logical-size probe (up to the legacy 16MiB row bound),
   -- separately from the 1.1MiB normal processing budget. Stop at the FIRST one.
   v_cursors:=jsonb_set(v_cursors,ARRAY[v_key],jsonb_build_object('after',v_position,'through',v_through));
   SELECT CASE WHEN pg_column_size(e.data)>1126400 THEN 1126401 ELSE octet_length(e.data::text) END INTO v_bytes FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind=v_kind AND e.id=v_row.id;
   IF v_bytes>1126400 THEN
    UPDATE fountain_cloud.maintenance_registry r SET cursors=v_cursors WHERE r.workspace_id=p_workspace_id;
    RETURN jsonb_build_object('mode','none');
   ELSIF v_bytes>v_budget THEN
    -- A legal candidate gets a fresh full budget next time. Advancing here can
    -- permanently starve it behind repeatedly scanned small unexpired rows.
    v_cursors:=jsonb_set(v_cursors,ARRAY[v_key],v_before);
    UPDATE fountain_cloud.maintenance_registry r SET cursors=v_cursors WHERE r.workspace_id=p_workspace_id;
    RETURN jsonb_build_object('mode','none');
   END IF;v_budget:=v_budget-v_bytes;
   SELECT e.data INTO v_data FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind=v_kind AND e.id=v_row.id;
   IF v_data->>'created_at' IS DISTINCT FROM v_row.created_at OR v_data->>'updated_at' IS DISTINCT FROM v_row.updated_at OR NOT fountain_cloud.maintenance_upload_valid(v_data,v_row.id,v_kind='upload_gc') THEN CONTINUE;END IF;
   IF v_kind='upload_gc' THEN v_gc:=v_data;CONTINUE;END IF;
   IF jsonb_typeof(v_data->'expires_at') IS DISTINCT FROM 'string' OR length(v_data->>'expires_at') NOT BETWEEN 1 AND 64 OR(v_data->>'expires_at')!~'(Z|[+-][0-9]{2}:[0-9]{2})$' THEN CONTINUE;END IF;
   BEGIN v_expiry:=(v_data->>'expires_at')::timestamptz;EXCEPTION WHEN data_exception THEN CONTINUE;END;
   IF NOT isfinite(v_expiry) OR extract(epoch FROM v_expiry)*1000>p_now_ms THEN CONTINUE;END IF;
   v_changes:='[]';
   IF v_data->'completed'='false'::jsonb AND(jsonb_array_length(v_data->'cloud_chunks')>0 OR COALESCE(v_data->'pending','null'::jsonb)<>'null'::jsonb) THEN
    -- Never overwrite another quarantine/receipt at this physical ID.
    IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='upload_gc' AND e.id=v_row.id) THEN CONTINUE;END IF;
    v_stamp:=to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS')||'000+00:00';
    v_gc:=jsonb_build_object('id',v_row.id,'owner_id',v_data->'owner_id','page_id',COALESCE(v_data->'page_id','null'::jsonb),'reserved_bytes',v_data->'size','cloud_chunks',v_data->'cloud_chunks','pending',COALESCE(v_data->'pending','null'::jsonb),'reason','upload_expired','created_at',v_stamp,'updated_at',v_stamp);
    v_changes:=jsonb_build_array(jsonb_build_object('op','put','kind','upload_gc','id',v_row.id,'data',v_gc,'previousCreatedAt','null'::jsonb));v_gc:=NULL;
   END IF;
   v_changes:=v_changes||jsonb_build_array(jsonb_build_object('op','delete','kind','upload','id',v_row.id));
   PERFORM fountain_cloud.store_apply_changes_locked(p_workspace_id,fountain_cloud.store_revision(p_workspace_id,'_entity_revision'),v_changes);
  END LOOP;
  IF v_seen<v_limit OR v_position=v_through THEN v_cursors:=jsonb_set(v_cursors,ARRAY[v_key],'null');END IF;
  UPDATE fountain_cloud.maintenance_registry r SET cursors=v_cursors WHERE r.workspace_id=p_workspace_id;
  IF v_kind='upload_gc' AND v_gc IS NOT NULL THEN
   IF fountain_cloud.storage_gc_pinned(p_workspace_id,v_gc->>'id') THEN RETURN jsonb_build_object('mode','none');END IF;
   v_pending:=COALESCE(v_gc->'pending','null'::jsonb);
   IF v_pending<>'null'::jsonb THEN
    v_mode:='observe';v_manifests:=jsonb_build_array(jsonb_build_object('version',1,'attachmentId',v_gc->>'id','offset',(v_pending->>'offset')::numeric::bigint,'size',(v_pending->>'size')::numeric::bigint,'sha256',v_pending->'sha256'));
   ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('version',1,'attachmentId',j.value->>'attachmentId','offset',(j.value->>'offset')::numeric::bigint,'size',(j.value->>'size')::numeric::bigint,'sha256',j.value->'sha256') ORDER BY j.ordinality),'[]'::jsonb) INTO v_manifests FROM jsonb_array_elements(v_gc->'cloud_chunks') WITH ORDINALITY j WHERE j.ordinality<=16;
    IF jsonb_array_length(v_manifests)=0 THEN RETURN jsonb_build_object('mode','none');END IF;
    BEGIN PERFORM fountain_cloud.storage_gc_fence(p_workspace_id,v_gc->>'id');EXCEPTION WHEN SQLSTATE 'PT409' THEN RETURN jsonb_build_object('mode','none');END;
    v_mode:='delete';
   END IF;
   v_claim:=jsonb_build_object('mode',v_mode,'resourceId',v_gc->>'id','fingerprint',encode(sha256(convert_to(v_gc::text,'UTF8')),'hex'),'manifests',v_manifests);
   IF v_mode='observe' THEN v_claim:=v_claim||jsonb_build_object('pendingAttempt',v_pending->'attempt_id');END IF;
   RETURN v_claim;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('mode','none');
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_upload_claim(text,bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_upload_check(p_workspace_id text,p_claim jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_gc jsonb;v_pending jsonb;v_prefix jsonb;v_total integer;
BEGIN
 IF jsonb_typeof(p_claim) IS DISTINCT FROM 'object' OR octet_length(p_claim::text)>32768 OR jsonb_typeof(p_claim->'mode') IS DISTINCT FROM 'string' OR p_claim->>'mode' NOT IN('observe','delete')
  OR jsonb_typeof(p_claim->'fingerprint') IS DISTINCT FROM 'string' OR(p_claim->>'fingerprint')!~'^[a-f0-9]{64}$'
  OR NOT fountain_cloud.storage_gc_id(p_claim->>'resourceId') OR jsonb_typeof(p_claim->'manifests') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p_claim->'manifests') NOT BETWEEN 1 AND 16 THEN RETURN false;END IF;
 SELECT e.data INTO v_gc FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='upload_gc' AND e.id=p_claim->>'resourceId';
 IF NOT FOUND OR octet_length(v_gc::text)>1126400 OR encode(sha256(convert_to(v_gc::text,'UTF8')),'hex') IS DISTINCT FROM p_claim->>'fingerprint' THEN RETURN false;END IF;
 -- Shape was checked at claim creation; an identical full hash pins every field.
 v_pending:=COALESCE(v_gc->'pending','null'::jsonb);
 IF p_claim->>'mode'='observe' THEN
  RETURN COALESCE(v_pending<>'null'::jsonb AND v_pending->'attempt_id'=p_claim->'pendingAttempt' AND NOT fountain_cloud.storage_gc_pinned(p_workspace_id,p_claim->>'resourceId')
   AND p_claim->'manifests'=jsonb_build_array(jsonb_build_object('version',1,'attachmentId',p_claim->>'resourceId','offset',v_pending->'offset','size',v_pending->'size','sha256',v_pending->'sha256')),false);
 END IF;
 IF v_pending<>'null'::jsonb OR NOT fountain_cloud.storage_gc_delete_allowed(p_workspace_id,p_claim->>'resourceId') THEN RETURN false;END IF;
 v_total:=jsonb_array_length(v_gc->'cloud_chunks');
 SELECT COALESCE(jsonb_agg(j.value ORDER BY j.ordinality),'[]'::jsonb) INTO v_prefix FROM jsonb_array_elements(v_gc->'cloud_chunks') WITH ORDINALITY j WHERE j.ordinality<=16;
 RETURN v_total>0 AND p_claim->'manifests'=v_prefix;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_upload_check(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_upload_observed(p_workspace_id text,p_claim jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_gc jsonb;v_created text;
BEGIN
 PERFORM fountain_cloud.store_lock(p_workspace_id);
 IF p_claim->>'mode' IS DISTINCT FROM 'observe' OR fountain_cloud.maintenance_upload_check(p_workspace_id,p_claim) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MAINTENANCE_RESOURCE_CHANGED' USING ERRCODE='PT409';END IF;
 SELECT e.data,e.created_at INTO v_gc,v_created FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='upload_gc' AND e.id=p_claim->>'resourceId';
 v_gc:=v_gc||jsonb_build_object('cloud_chunks',(v_gc->'cloud_chunks')||(p_claim->'manifests'),'pending','null'::jsonb,'updated_at',to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS')||'000+00:00');
 PERFORM fountain_cloud.store_apply_changes_locked(p_workspace_id,fountain_cloud.store_revision(p_workspace_id,'_entity_revision'),jsonb_build_array(jsonb_build_object('op','put','kind','upload_gc','id',p_claim->>'resourceId','data',v_gc,'previousCreatedAt',v_created)));
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_upload_observed(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_upload_done(p_workspace_id text,p_claim jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_gc jsonb;v_created text;v_remaining jsonb;v_change jsonb;
BEGIN
 PERFORM fountain_cloud.store_lock(p_workspace_id);
 IF p_claim->>'mode' IS DISTINCT FROM 'delete' OR fountain_cloud.maintenance_upload_check(p_workspace_id,p_claim) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MAINTENANCE_RESOURCE_CHANGED' USING ERRCODE='PT409';END IF;
 SELECT e.data,e.created_at INTO v_gc,v_created FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='upload_gc' AND e.id=p_claim->>'resourceId';
 SELECT COALESCE(jsonb_agg(j.value ORDER BY j.ordinality),'[]'::jsonb) INTO v_remaining FROM jsonb_array_elements(v_gc->'cloud_chunks') WITH ORDINALITY j WHERE j.ordinality>jsonb_array_length(p_claim->'manifests');
 IF jsonb_array_length(v_remaining)=0 THEN v_change:=jsonb_build_object('op','delete','kind','upload_gc','id',p_claim->>'resourceId');
 ELSE
  v_gc:=v_gc||jsonb_build_object('cloud_chunks',v_remaining,'updated_at',to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS')||'000+00:00');
  v_change:=jsonb_build_object('op','put','kind','upload_gc','id',p_claim->>'resourceId','data',v_gc,'previousCreatedAt',v_created);
 END IF;
 -- Only final confirmed metadata deletion releases its reserved_bytes. Unknown
 -- publishers have pending!=NULL and cannot reach this branch.
 PERFORM fountain_cloud.store_apply_changes_locked(p_workspace_id,fountain_cloud.store_revision(p_workspace_id,'_entity_revision'),jsonb_build_array(v_change));
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_upload_done(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION fountain_cloud.maintenance_upload_valid(jsonb,text,boolean) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_upload_claim(text,bigint) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_upload_check(text,jsonb) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_upload_observed(text,jsonb) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_upload_done(text,jsonb) OWNER TO postgres;
