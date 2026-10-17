-- Trusted full-workspace backups preserve verified history separately from
-- disposable search indexes. No history enters ordinary JSON import.
ALTER TABLE fountain_cloud.backup_jobs ADD COLUMN content_revision bigint CHECK(content_revision IS NULL OR content_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE fountain_cloud.backup_jobs ADD COLUMN format_version integer NOT NULL DEFAULT 1 CHECK(format_version IN(1,2));
ALTER TABLE fountain_cloud.backup_jobs ALTER COLUMN format_version SET DEFAULT 2;
ALTER TABLE fountain_cloud.backup_jobs ALTER COLUMN source_counts SET DEFAULT ARRAY[0,0,0,0]::bigint[];
ALTER TABLE fountain_cloud.backup_job_source DROP CONSTRAINT backup_job_source_table_name_check;
ALTER TABLE fountain_cloud.backup_job_source ADD CONSTRAINT backup_job_source_table_name_check CHECK(table_name IN('entities','meta','attachment_chunks','content_provenance'));
CREATE FUNCTION fountain_cloud.backup_provenance_value(p_row fountain_private.content_provenance) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE v_id text;v_stamp text;
BEGIN
 IF p_row.kind NOT IN('page','database','row') OR p_row.id IS NULL OR length(p_row.id) NOT BETWEEN 1 AND 160
  OR p_row.generation IS NULL OR p_row.generation !~ '^[a-f0-9]{32}$'
  OR p_row.creator_cause IS NULL OR p_row.creator_cause NOT IN('human','automation','import','public_form','system','unknown')
  OR p_row.editor_cause IS NULL OR p_row.editor_cause NOT IN('human','automation','import','public_form','system','unknown')
  OR(p_row.editor_id IS NULL AND p_row.edited_at IS NOT NULL) OR((p_row.manager_id IS NULL)<>(p_row.manager_at IS NULL))
  OR NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_row.workspace_id AND e.kind=p_row.kind AND e.id=p_row.id AND e.data->>'id'=e.id)
  OR NOT EXISTS(SELECT 1 FROM fountain_private.content_search_documents d WHERE d.workspace_id=p_row.workspace_id AND d.kind=p_row.kind AND d.id=p_row.id AND d.generation=p_row.generation) THEN RAISE EXCEPTION 'Invalid backup provenance' USING ERRCODE='PT503';END IF;
 FOREACH v_id IN ARRAY ARRAY[p_row.creator_id,p_row.editor_id,p_row.manager_id] LOOP
  IF v_id IS NOT NULL AND length(v_id) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid historical actor' USING ERRCODE='PT503';END IF;
 END LOOP;
 FOREACH v_stamp IN ARRAY ARRAY[p_row.edited_at,p_row.manager_at] LOOP
  IF v_stamp IS NOT NULL AND(v_stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' OR fountain_private.content_date_atom(v_stamp) IS NULL) THEN RAISE EXCEPTION 'Invalid historical time' USING ERRCODE='PT503';END IF;
 END LOOP;
 RETURN jsonb_build_object('kind',p_row.kind,'id',p_row.id,'generation',p_row.generation,'creator_id',p_row.creator_id,'creator_cause',p_row.creator_cause,'editor_id',p_row.editor_id,'edited_at',p_row.edited_at,'editor_cause',p_row.editor_cause,'manager_id',p_row.manager_id,'manager_at',p_row.manager_at);
END $f$;
ALTER FUNCTION fountain_cloud.backup_provenance_value(fountain_private.content_provenance) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.backup_provenance_value(fountain_private.content_provenance) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE OR REPLACE FUNCTION fountain_cloud.backup_export(p_context jsonb, p_expected_revision bigint DEFAULT NULL::bigint, p_cursor jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE authority jsonb;ws text;revision bigint;content_revision bigint;history fountain_private.content_provenance;scope text;phase integer:=0;
 last_kind text:='';last_id text:='';last_offset bigint:=0;last_part integer:=0;
 item record;raw text;parts integer;part integer;first_part integer;dto jsonb;
 items jsonb[]:=ARRAY[]::jsonb[];used bigint:=4096;following jsonb:=NULL;result jsonb;
BEGIN
 authority:=fountain_cloud.backup_authorize(p_context);ws:=p_context->>'workspaceId';revision:=(authority->>'revision')::bigint;
 content_revision:=COALESCE((SELECT s.content_revision FROM fountain_private.content_search_state s WHERE s.workspace_id=ws),0);
 IF p_cursor IS NOT NULL AND p_cursor->>'contentRevision' IS DISTINCT FROM content_revision::text THEN RAISE EXCEPTION 'CONTENT_REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF p_expected_revision IS NOT NULL AND (p_expected_revision<0 OR p_expected_revision<>revision) THEN
  RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 scope:=encode(sha256(convert_to(jsonb_build_array(p_context,revision,content_revision)::text,'UTF8')),'hex');
 IF p_cursor IS NOT NULL THEN
  IF p_expected_revision IS NULL OR jsonb_typeof(p_cursor) IS DISTINCT FROM 'object'
   OR NOT(p_cursor ?& ARRAY['phase','kind','id','offset','part','scope','contentRevision'])
   OR p_cursor-ARRAY['phase','kind','id','offset','part','scope','contentRevision']<>'{}'::jsonb
   OR jsonb_typeof(p_cursor->'contentRevision') IS DISTINCT FROM 'number' OR (p_cursor->>'contentRevision') !~ '^[0-9]{1,16}$' OR (p_cursor->>'contentRevision')::numeric>9007199254740991
   OR jsonb_typeof(p_cursor->'scope') IS DISTINCT FROM 'string' OR p_cursor->>'scope' IS DISTINCT FROM scope
   OR jsonb_typeof(p_cursor->'phase') IS DISTINCT FROM 'number' OR (p_cursor->>'phase') !~ '^[0-3]$'
   OR jsonb_typeof(p_cursor->'kind') IS DISTINCT FROM 'string' OR length(p_cursor->>'kind')>64
   OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string' OR length(p_cursor->>'id') NOT BETWEEN 1 AND 160
   OR jsonb_typeof(p_cursor->'offset') IS DISTINCT FROM 'number' OR (p_cursor->>'offset') !~ '^[0-9]{1,10}$'
   OR (p_cursor->>'offset')::bigint>5000000000
   OR jsonb_typeof(p_cursor->'part') IS DISTINCT FROM 'number' OR (p_cursor->>'part') !~ '^[0-9]{1,3}$'
   OR (p_cursor->>'part')::integer>128 THEN
   RAISE EXCEPTION 'Invalid backup cursor' USING ERRCODE='22023';
  END IF;
  phase:=(p_cursor->>'phase')::integer;last_kind:=p_cursor->>'kind';last_id:=p_cursor->>'id';last_offset:=(p_cursor->>'offset')::bigint;last_part:=(p_cursor->>'part')::integer;
  IF (phase IN(0,3) AND (last_kind !~ '^[a-z][a-z0-9_]{0,63}$' OR last_offset<>0))
   OR (phase IN(1,2) AND last_kind<>'') OR (phase=1 AND last_offset<>0) OR (phase IN(2,3) AND last_part<>0) THEN
   RAISE EXCEPTION 'Invalid backup cursor' USING ERRCODE='22023';
  END IF;
 END IF;
 IF phase=0 THEN
  FOR item IN SELECT e.kind,e.id,e.data,e.created_at,e.updated_at FROM fountain_private.entities e
   WHERE e.workspace_id=ws
    AND e.kind NOT IN ('session','clipboard','upload','presence','attachment_chunk','cloud_chunk','upload_gc','upload_migration')
    AND (e.kind COLLATE "C",e.id COLLATE "C") >= (last_kind COLLATE "C",last_id COLLATE "C")
   ORDER BY e.kind COLLATE "C",e.id COLLATE "C"
  LOOP
   raw:=item.data::text;
   IF octet_length(raw)>16777216 THEN RAISE EXCEPTION 'Backup entity exceeds valid bounds' USING ERRCODE='PT413';END IF;
   IF length(item.id) NOT BETWEEN 1 AND 160 OR item.kind !~ '^[a-z][a-z0-9_]{0,63}$'
    OR length(item.created_at) NOT BETWEEN 1 AND 64 OR length(item.updated_at) NOT BETWEEN 1 AND 64
    OR jsonb_typeof(item.data) IS DISTINCT FROM 'object' OR jsonb_typeof(item.data->'id') IS DISTINCT FROM 'string'
    OR item.data->>'id' IS DISTINCT FROM item.id THEN
    RAISE EXCEPTION 'Backup entity is invalid' USING ERRCODE='PT503';
   END IF;
   parts:=greatest(1,(length(raw)+262143)/262144);first_part:=CASE WHEN item.kind=last_kind AND item.id=last_id THEN last_part+1 ELSE 0 END;
   FOR part IN first_part..parts-1 LOOP
    dto:=jsonb_build_object('type','entity','kind',item.kind,'id',item.id,'createdAt',item.created_at,'updatedAt',item.updated_at,'part',part,'parts',parts,'dataPart',substr(raw,part*262144+1,262144));
    IF used+octet_length(dto::text)+2>8388608 OR cardinality(items)>=256 THEN
     RETURN jsonb_build_object('context',p_context,'revision',revision,'contentRevision',content_revision,'items',to_jsonb(items),'nextCursor',following);
    END IF;
    items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',0,'kind',item.kind,'id',item.id,'offset',0,'part',part,'scope',scope,'contentRevision',content_revision);
   END LOOP;
  END LOOP;
  phase:=1;last_id:='';last_part:=-1;last_kind:='';
 END IF;
 IF phase=1 THEN
  FOR item IN SELECT m.key,m.data FROM fountain_private.meta m WHERE m.workspace_id=ws
   AND m.key NOT IN ('local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved')
   AND m.key COLLATE "C">=last_id COLLATE "C" ORDER BY m.key COLLATE "C"
  LOOP
   raw:=item.data::text;
   IF octet_length(raw)>16777216 OR length(item.key) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Backup metadata exceeds valid bounds' USING ERRCODE='PT413';
   END IF;
   parts:=greatest(1,(length(raw)+262143)/262144);first_part:=CASE WHEN item.key=last_id THEN last_part+1 ELSE 0 END;
   FOR part IN first_part..parts-1 LOOP
    dto:=jsonb_build_object('type','meta','key',item.key,'part',part,'parts',parts,'dataPart',substr(raw,part*262144+1,262144));
    IF used+octet_length(dto::text)+2>8388608 OR cardinality(items)>=256 THEN
     RETURN jsonb_build_object('context',p_context,'revision',revision,'contentRevision',content_revision,'items',to_jsonb(items),'nextCursor',following);
    END IF;
    items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',1,'kind','','id',item.key,'offset',0,'part',part,'scope',scope,'contentRevision',content_revision);
   END LOOP;
  END LOOP;
  phase:=2;last_id:='';last_offset:=0;
 END IF;
 IF phase=2 THEN
  FOR item IN SELECT c.attachment_id,c."offset",c.data FROM fountain_private.attachment_chunks c
   JOIN fountain_private.entities e ON e.workspace_id=c.workspace_id AND e.kind='attachment' AND e.id=c.attachment_id
   WHERE c.workspace_id=ws AND e.data->>'storage'='chunks' AND NOT(e.data ? 'cloud_chunks')
    AND NOT EXISTS(SELECT 1 FROM fountain_private.entities o WHERE o.workspace_id=ws AND o.kind='attachment_cloud' AND o.id=e.id)
    AND (c.attachment_id COLLATE "C",c."offset")>(last_id COLLATE "C",last_offset)
   ORDER BY c.attachment_id COLLATE "C",c."offset"
  LOOP
   IF octet_length(item.data)>4194304 OR length(item.attachment_id) NOT BETWEEN 1 AND 160 OR item."offset"<0 OR item."offset">5000000000 THEN
    RAISE EXCEPTION 'Legacy attachment bytes exceed valid bounds' USING ERRCODE='PT503';
   END IF;
   dto:=jsonb_build_object('type','chunk','attachmentId',item.attachment_id,'offset',item."offset",'size',octet_length(item.data),'base64',replace(encode(item.data,'base64'),E'\n',''));
   IF used+octet_length(dto::text)+2>8388608 OR cardinality(items)>=256 THEN
    RETURN jsonb_build_object('context',p_context,'revision',revision,'contentRevision',content_revision,'items',to_jsonb(items),'nextCursor',following);
   END IF;
   items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',2,'kind','','id',item.attachment_id,'offset',item."offset",'part',0,'scope',scope,'contentRevision',content_revision);
  END LOOP;
 END IF;
 IF phase=2 THEN phase:=3;last_kind:='';last_id:='';END IF;
 IF phase=3 THEN
  FOR history IN SELECT p.* FROM fountain_private.content_provenance p WHERE p.workspace_id=ws
   AND(p.kind COLLATE "C",p.id COLLATE "C")>(last_kind COLLATE "C",last_id COLLATE "C") ORDER BY p.kind COLLATE "C",p.id COLLATE "C"
  LOOP
   dto:=jsonb_build_object('type','provenance','value',fountain_cloud.backup_provenance_value(history));
   IF used+octet_length(dto::text)+2>8388608 OR cardinality(items)>=256 THEN RETURN jsonb_build_object('context',p_context,'revision',revision,'contentRevision',content_revision,'items',to_jsonb(items),'nextCursor',following);END IF;
   items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',3,'kind',history.kind,'id',history.id,'offset',0,'part',0,'scope',scope,'contentRevision',content_revision);
  END LOOP;
 END IF;
 result:=jsonb_build_object('context',p_context,'revision',revision,'contentRevision',content_revision,'items',to_jsonb(items),'nextCursor',NULL);
 IF octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'Backup page limit exceeded' USING ERRCODE='PT413';END IF;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION fountain_cloud.backup_job_view(p_job fountain_cloud.backup_jobs) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p_job.id,'phase',p_job.phase,'version',p_job.version,'revision',p_job.revision,'format_version',p_job.format_version,
 'expires_at',p_job.expires_at,'checkpoint',p_job.checkpoint,'output_bytes',p_job.output_bytes,
 'source_rows',p_job.source_counts[1]+p_job.source_counts[2]+p_job.source_counts[3]+COALESCE(p_job.source_counts[4],0),
 'size',p_job.size,'sha256',p_job.sha256,'lease_id',p_job.lease_id,'cleanup_pending',p_job.cleanup_pending)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.backup_job_view(fountain_cloud.backup_jobs) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION fountain_cloud.backup_jobs_rpc(p_context jsonb,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_authz jsonb;v_ws text;v_now_ms bigint;v_identity text;v_j fountain_cloud.backup_jobs;v_receipt record;
 v_item record;v_value jsonb;v_original jsonb;v_file jsonb;v_overlay jsonb;v_fingerprint jsonb;v_raw bytea;v_descriptor jsonb;
 v_table_no integer;v_table_name text;v_last_kind text;v_last_id text;v_chunk_no integer;v_ordinal bigint;v_table_count integer;v_history fountain_private.content_provenance;v_copied bigint:=0;v_counted integer:=0;v_scanned integer:=0;v_kind text;v_item_id text;
 v_descriptions jsonb:='[]';v_plan_values jsonb:='[]';v_byte_values jsonb:='[]';v_reference_values jsonb:='[]';v_q jsonb;v_key text;v_first_index bigint;v_n integer;v_limit_count integer;v_ref text;v_off bigint;v_wanted integer;
 v_part_record fountain_cloud.backup_job_parts;v_part_bytes bytea;v_part_size integer;v_part_id text;v_manifest jsonb;v_result jsonb;v_reserved bigint;v_reservation_delta bigint:=0;
BEGIN
 -- Cleanup is a server-selected denial-only capability: live Auth/mapping/
 -- active OWNER still required, but disable_export cannot strand private quota.
 -- No source/read/claim/generation/artifact action uses this branch.
 IF p_action IN('cancel','gc_next','gc_claim','gc_check','gc_done','gc_observed','gate_cleanup','status_cleanup') THEN
  v_authz:=fountain_cloud.store_context(p_context);
  IF v_authz->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Cleanup requires owner' USING ERRCODE='PT403';END IF;
 ELSE v_authz:=fountain_cloud.backup_authorize(p_context);END IF;
 v_ws:=p_context->>'workspaceId';v_now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>4194304 THEN
  RAISE EXCEPTION 'Invalid backup request' USING ERRCODE='PT413';END IF;
 IF p_action IN('gate','gate_cleanup') THEN RETURN '{}'::jsonb;END IF;
 IF p_action='gc_next' THEN
  IF jsonb_typeof(p_payload->'limit') IS DISTINCT FROM 'number' OR (p_payload->>'limit')!~'^[1-4]$' THEN RAISE EXCEPTION 'Invalid cleanup limit' USING ERRCODE='22023';END IF;
  SELECT COALESCE(max(bj.gc_sequence),0)+1 INTO v_reserved FROM fountain_cloud.backup_jobs bj WHERE bj.workspace_id=v_ws;
  IF v_reserved>9007199254740991 THEN RAISE EXCEPTION 'Cleanup sequence exhausted' USING ERRCODE='PT409';END IF;
  SELECT COALESCE(jsonb_agg(x.id),'[]'::jsonb) INTO v_value FROM(SELECT bj.id FROM fountain_cloud.backup_jobs bj WHERE bj.workspace_id=v_ws AND bj.cleanup_pending AND (bj.phase IN('cancelled','expired') OR bj.expires_at<=v_now_ms) ORDER BY bj.gc_sequence,bj.expires_at,bj.id LIMIT (p_payload->>'limit')::integer)x;
  UPDATE fountain_cloud.backup_jobs bj SET gc_sequence=v_reserved WHERE bj.workspace_id=v_ws AND bj.id IN(SELECT jsonb_array_elements_text(v_value));
  RETURN jsonb_build_object('ids',v_value);
 END IF;
 v_identity:=p_payload->>'id';
 IF v_identity IS NULL OR v_identity!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
  RAISE EXCEPTION 'Invalid backup id' USING ERRCODE='22023';END IF;
 SELECT * INTO v_j FROM fountain_cloud.backup_jobs bj WHERE bj.workspace_id=v_ws AND bj.id=v_identity FOR UPDATE;
 IF p_action='create' AND NOT FOUND THEN
  IF (p_payload->>'quota_bytes')!~'^[0-9]{1,16}$' OR (p_payload->>'quota_bytes')::numeric NOT BETWEEN 1 AND 9007199254740991 THEN
   RAISE EXCEPTION 'Invalid quota' USING ERRCODE='22023';END IF;
  IF (SELECT count(*) FROM fountain_cloud.backup_jobs bj WHERE bj.workspace_id=v_ws AND bj.expires_at>v_now_ms AND bj.phase NOT IN('cancelled','expired','failed'))>=4 THEN
   RAISE EXCEPTION 'Too many backups' USING ERRCODE='PT429';END IF;
  INSERT INTO fountain_cloud.backup_jobs(workspace_id,id,context,revision,expires_at,quota_bytes,content_revision)
   VALUES(v_ws,v_identity,p_context,(v_authz->>'revision')::bigint,v_now_ms+86400000,(p_payload->>'quota_bytes')::bigint,COALESCE((SELECT s.content_revision FROM fountain_private.content_search_state s WHERE s.workspace_id=v_ws),0)) RETURNING * INTO v_j;
 ELSIF v_j.id IS NULL OR v_j.context IS DISTINCT FROM p_context AND NOT(p_action IN('gc_claim','gc_check','gc_done','gc_observed') AND COALESCE(p_payload->'maintenance'='true'::jsonb,false)) THEN
  RAISE EXCEPTION 'Backup not found' USING ERRCODE='PT404';
 END IF;
 IF v_j.format_version=2 AND v_j.phase='snapshot' AND p_action IN('claim','snapshot') AND v_j.content_revision IS DISTINCT FROM COALESCE((SELECT s.content_revision FROM fountain_private.content_search_state s WHERE s.workspace_id=v_ws),0) THEN RAISE EXCEPTION 'CONTENT_REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF p_action='status_cleanup' THEN IF v_j.phase NOT IN('cancelled','expired') THEN RAISE EXCEPTION 'Active backup metadata requires export' USING ERRCODE='PT403';END IF;RETURN fountain_cloud.backup_job_view(v_j);END IF;
 IF p_action IN('create','status') THEN IF v_j.expires_at<=v_now_ms THEN v_j.phase:='expired';END IF;RETURN fountain_cloud.backup_job_view(v_j);END IF;
 IF p_action='cancel' THEN
  -- Never release quota here. A pending external POST can still publish later.
  UPDATE fountain_cloud.backup_jobs bj SET phase='cancelled',version=bj.version+1,lease_id=NULL,lease_until=NULL WHERE bj.workspace_id=v_ws AND bj.id=v_identity RETURNING * INTO v_j;
  RETURN fountain_cloud.backup_job_view(v_j);
 END IF;
 IF v_j.expires_at<=v_now_ms AND p_action NOT IN('gc_claim','gc_check','gc_done','gc_observed') THEN RAISE EXCEPTION 'Backup expired' USING ERRCODE='PT410';END IF;
 IF p_action IN('gc_claim','gc_check','gc_done','gc_observed') THEN
  RETURN fountain_cloud.backup_gc_locked(v_ws,v_identity,p_action,p_payload,v_now_ms);
 END IF;
 IF p_action='artifact' THEN
  IF v_j.phase<>'ready' THEN RAISE EXCEPTION 'Backup not ready' USING ERRCODE='PT409';END IF;
  v_off:=(p_payload->>'offset')::bigint;v_wanted:=(p_payload->>'length')::integer;
  IF v_off<0 OR v_wanted NOT BETWEEN 1 AND 65536 OR v_off+v_wanted>v_j.size THEN RAISE EXCEPTION 'Invalid range' USING ERRCODE='22023';END IF;
  SELECT * INTO v_part_record FROM fountain_cloud.backup_job_parts bpt WHERE bpt.workspace_id=v_ws AND bpt.job_id=v_identity AND bpt.state='published' AND bpt.start_bytes<=v_off AND bpt.start_bytes+(bpt.manifest->>'size')::bigint>v_off ORDER BY bpt.start_bytes DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing backup bytes' USING ERRCODE='PT503';END IF;
  RETURN jsonb_build_object('manifest',v_part_record.manifest,'relative',v_off-v_part_record.start_bytes);
 END IF;
 IF p_action='claim' THEN
  IF (p_payload->>'transaction_id')!~'^[a-f0-9-]{36}$' OR (p_payload->>'digest')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid transaction' USING ERRCODE='22023';END IF;
  SELECT * INTO v_receipt FROM fountain_cloud.backup_job_receipts br WHERE br.workspace_id=v_ws AND br.job_id=v_identity AND br.transaction_id=p_payload->>'transaction_id';
  IF FOUND THEN
   IF v_receipt.digest IS DISTINCT FROM p_payload->>'digest' THEN RAISE EXCEPTION 'Receipt collision' USING ERRCODE='PT409';END IF;
   RETURN jsonb_build_object('receipt',v_receipt.result);
  END IF;
  IF v_j.phase='snapshot' AND v_j.revision IS DISTINCT FROM (v_authz->>'revision')::bigint THEN RAISE EXCEPTION 'Snapshot revision changed' USING ERRCODE='PT409';END IF;
  IF v_j.phase IN('ready','cancelled','failed','expired') THEN RETURN fountain_cloud.backup_job_view(v_j);END IF;
  IF v_j.lease_id IS NOT NULL AND v_j.lease_until>v_now_ms AND v_j.lease_tx IS DISTINCT FROM p_payload->>'transaction_id' THEN RAISE EXCEPTION 'Backup busy' USING ERRCODE='PT409';END IF;
  IF v_j.lease_id IS NULL OR v_j.lease_until<=v_now_ms THEN v_j.lease_id:=gen_random_uuid()::text;END IF;
  IF v_j.lease_tx=p_payload->>'transaction_id' AND v_j.lease_digest IS DISTINCT FROM p_payload->>'digest' THEN RAISE EXCEPTION 'Claim collision' USING ERRCODE='PT409';END IF;
  UPDATE fountain_cloud.backup_jobs bj SET lease_id=v_j.lease_id,lease_tx=p_payload->>'transaction_id',lease_digest=p_payload->>'digest',lease_until=v_now_ms+60000 WHERE bj.workspace_id=v_ws AND bj.id=v_identity RETURNING * INTO v_j;
  RETURN fountain_cloud.backup_job_view(v_j);
 END IF;
 IF v_j.phase NOT IN('snapshot','building') OR v_j.lease_until<=v_now_ms OR v_j.lease_id IS DISTINCT FROM p_payload->>'lease_id'
  OR v_j.version IS DISTINCT FROM (p_payload->>'version')::bigint OR v_j.lease_tx IS DISTINCT FROM p_payload->>'transaction_id' OR v_j.lease_digest IS DISTINCT FROM p_payload->>'digest' THEN
  RAISE EXCEPTION 'Backup lease changed' USING ERRCODE='PT409';END IF;
 IF p_action='lease' THEN RETURN '{}'::jsonb;END IF;
 IF p_action='snapshot' THEN
  IF v_j.phase<>'snapshot' OR v_j.revision IS DISTINCT FROM (v_authz->>'revision')::bigint THEN RAISE EXCEPTION 'Snapshot revision changed' USING ERRCODE='PT409';END IF;
  v_table_no:=(v_j.source_cursor->>'table')::integer;v_last_kind:=v_j.source_cursor->>'kind';v_last_id:=v_j.source_cursor->>'id';v_chunk_no:=(v_j.source_cursor->>'chunk')::integer;
  v_table_count:=CASE WHEN v_j.format_version=2 THEN 4 ELSE 3 END;
  WHILE v_table_no<v_table_count AND v_scanned<128 AND v_counted<128 AND v_copied<262144 LOOP
   v_scanned:=v_scanned+1;
   IF v_table_no=0 THEN
    SELECT e.* INTO v_item FROM fountain_private.entities e WHERE e.workspace_id=v_ws
     AND e.kind NOT IN('session','clipboard','upload','presence','attachment_chunk','cloud_chunk','upload_gc','upload_migration','attachment_cloud')
     AND (e.kind COLLATE "C",e.id COLLATE "C")>(v_last_kind COLLATE "C",v_last_id COLLATE "C") ORDER BY e.kind COLLATE "C",e.id COLLATE "C" LIMIT 1;
    IF NOT FOUND THEN IF EXISTS(SELECT 1 FROM fountain_private.entities o WHERE o.workspace_id=v_ws AND o.kind='attachment_cloud' AND NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='attachment' AND e.id=o.id)) THEN RAISE EXCEPTION 'Orphan overlay' USING ERRCODE='PT503';END IF;v_table_no:=1;v_last_id:='';v_last_kind:='';CONTINUE;END IF;
    v_original:=v_item.data;v_kind:=v_item.kind;v_item_id:=v_item.id;v_file:=NULL;v_overlay:=NULL;
    IF jsonb_typeof(v_original) IS DISTINCT FROM 'object' OR jsonb_typeof(v_original->'id') IS DISTINCT FROM 'string' OR v_original->>'id' IS DISTINCT FROM v_item_id OR length(v_item_id) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid source identity' USING ERRCODE='PT503';END IF;
    IF v_kind='attachment' THEN
     IF jsonb_typeof(v_original->'size') IS DISTINCT FROM 'number' OR (v_original->>'size')!~'^[0-9]{1,10}$' OR (v_original->>'size')::bigint>5000000000 OR jsonb_typeof(v_original->'name') IS DISTINCT FROM 'string' OR length(v_original->>'name') NOT BETWEEN 1 AND 255 OR v_original->>'name' IN('.','..') OR position('/' in v_original->>'name')>0 OR position(chr(92) in v_original->>'name')>0 OR (v_original->>'name')~'[[:cntrl:]]' OR v_original ? 'mime' AND (jsonb_typeof(v_original->'mime') IS DISTINCT FROM 'string' OR length(v_original->>'mime') NOT BETWEEN 1 AND 255) THEN RAISE EXCEPTION 'Invalid attachment' USING ERRCODE='PT503';END IF;
     SELECT e.data INTO v_overlay FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='attachment_cloud' AND e.id=v_item_id;
     v_file:=COALESCE(v_overlay,v_original);
     IF v_overlay IS NOT NULL THEN
      IF v_overlay-ARRAY['id','owner_id','page_id','name','size','mime','storage','sha256','created_at','updated_at','storage_id','cloud_chunks','source_fingerprint']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid overlay' USING ERRCODE='PT503';END IF;
      SELECT jsonb_object_agg(k,COALESCE(v_original->k,'null'::jsonb)) INTO v_fingerprint FROM unnest(ARRAY['id','owner_id','page_id','name','size','mime','storage','sha256','created_at','updated_at']) k;
      IF (v_overlay->>'source_fingerprint')::jsonb IS DISTINCT FROM v_fingerprint OR EXISTS(SELECT 1 FROM unnest(ARRAY['id','owner_id','page_id','name','size','mime']) k WHERE COALESCE(v_overlay->k,'null'::jsonb) IS DISTINCT FROM COALESCE(v_original->k,'null'::jsonb)) OR v_overlay->>'storage'<>'chunks' THEN RAISE EXCEPTION 'Stale overlay' USING ERRCODE='PT409';END IF;
      IF v_original ? 'sha256' AND v_original->>'sha256' IS DISTINCT FROM v_overlay->>'sha256' THEN RAISE EXCEPTION 'Overlay hash changed' USING ERRCODE='PT409';END IF;
      IF COALESCE(v_original->>'storage','inline')='inline' AND encode(sha256(decode(v_original->>'data','base64')),'hex') IS DISTINCT FROM v_overlay->>'sha256' THEN RAISE EXCEPTION 'Inline migration changed' USING ERRCODE='PT409';END IF;
     END IF;
     IF v_file->>'storage'='chunks' THEN
      IF jsonb_typeof(v_file->'sha256') IS DISTINCT FROM 'string' OR (v_file->>'sha256')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Missing attachment hash' USING ERRCODE='PT503';END IF;
      v_original:=(v_original-ARRAY['cloud_chunks','storage_id','source_fingerprint','data'])||jsonb_build_object('storage','chunks','sha256',v_file->>'sha256');
     ELSIF COALESCE(v_original->>'storage','inline')='inline' THEN
      IF jsonb_typeof(v_original->'data') IS DISTINCT FROM 'string' OR (v_original->>'size')::bigint>5000000 OR octet_length(decode(v_original->>'data','base64'))<>(v_original->>'size')::bigint THEN RAISE EXCEPTION 'Inline bytes unavailable' USING ERRCODE='PT503';END IF;
     IF v_original ? 'sha256' AND (jsonb_typeof(v_original->'sha256') IS DISTINCT FROM 'string' OR (v_original->>'sha256')!~'^[a-f0-9]{64}$' OR encode(sha256(decode(v_original->>'data','base64')),'hex') IS DISTINCT FROM v_original->>'sha256') THEN RAISE EXCEPTION 'Inline hash changed' USING ERRCODE='PT503';END IF;
     ELSE RAISE EXCEPTION 'Attachment needs migration' USING ERRCODE='PT503';END IF;
    END IF;
    v_raw:=convert_to(v_original::text,'UTF8');IF octet_length(v_raw)>16777216 THEN RAISE EXCEPTION 'Source row exceeds bounds' USING ERRCODE='PT413';END IF;
    v_ordinal:=v_j.source_counts[1];v_descriptor:=jsonb_build_object('kind',v_kind,'id',v_item_id,'created_at',v_item.created_at,'updated_at',v_item.updated_at,'data',jsonb_build_object('ref','entities:'||v_ordinal,'size',octet_length(v_raw),'type','text'));
    IF v_file->>'storage'='chunks' THEN v_descriptor:=v_descriptor||jsonb_build_object('attachment',jsonb_build_object('size',(v_file->>'size')::bigint,'sha256',v_file->>'sha256'));END IF;
    INSERT INTO fountain_cloud.backup_job_source VALUES(v_ws,v_identity,'entities',v_ordinal,v_descriptor,v_raw,NULL,CASE WHEN v_kind='attachment' AND v_file->>'storage'='chunks' THEN v_file ELSE NULL END,CASE WHEN v_kind='attachment' AND v_file->>'storage'='chunks' THEN v_j.source_file_count ELSE NULL END);
    IF v_kind='attachment' AND v_file->>'storage'='chunks' THEN v_j.source_file_count:=v_j.source_file_count+1;END IF;
    v_j.source_counts[1]:=v_ordinal+1;v_last_kind:=v_kind;v_last_id:=v_item_id;v_copied:=v_copied+octet_length(v_raw);v_counted:=v_counted+1;
   ELSIF v_table_no=1 THEN
    SELECT m.* INTO v_item FROM fountain_private.meta m WHERE m.workspace_id=v_ws AND m.key NOT IN('local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved') AND m.key COLLATE "C">v_last_id COLLATE "C" ORDER BY m.key COLLATE "C" LIMIT 1;
    IF NOT FOUND THEN v_table_no:=2;v_last_id:='';v_chunk_no:=0;CONTINUE;END IF;
    v_raw:=convert_to(v_item.data::text,'UTF8');IF octet_length(v_raw)>16777216 OR length(v_item.key) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Metadata exceeds bounds' USING ERRCODE='PT413';END IF;
    v_ordinal:=v_j.source_counts[2];v_descriptor:=jsonb_build_object('key',v_item.key,'data',jsonb_build_object('ref','meta:'||v_ordinal,'size',octet_length(v_raw),'type','text'));
    INSERT INTO fountain_cloud.backup_job_source VALUES(v_ws,v_identity,'meta',v_ordinal,v_descriptor,v_raw,NULL,NULL,NULL);v_j.source_counts[2]:=v_ordinal+1;v_last_id:=v_item.key;v_copied:=v_copied+octet_length(v_raw);v_counted:=v_counted+1;
   ELSIF v_table_no=2 THEN
    SELECT s.* INTO v_item FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=v_ws AND s.job_id=v_identity AND s.table_name='entities' AND s.extra IS NOT NULL AND (s.descriptor->>'id') COLLATE "C">=v_last_id COLLATE "C" ORDER BY (s.descriptor->>'id') COLLATE "C" LIMIT 1;
    IF NOT FOUND THEN v_table_no:=3;v_last_kind:='';v_last_id:='';CONTINUE;END IF;
    v_file:=v_item.extra;v_item_id:=v_item.descriptor->>'id';IF v_item_id<>v_last_id THEN v_chunk_no:=0;END IF;
    v_off:=v_chunk_no::bigint*4194304;
    IF v_off>=(v_file->>'size')::bigint THEN v_last_id:=v_item_id||chr(1);v_chunk_no:=0;CONTINUE;END IF;
    v_wanted:=least(4194304,(v_file->>'size')::bigint-v_off)::integer;v_manifest:=NULL;v_raw:=NULL;
    IF v_file ? 'cloud_chunks' THEN
     IF jsonb_typeof(v_file->'cloud_chunks') IS DISTINCT FROM 'array' OR jsonb_array_length(v_file->'cloud_chunks')<>ceil((v_file->>'size')::numeric/4194304)::integer THEN RAISE EXCEPTION 'Invalid cloud layout' USING ERRCODE='PT503';END IF;
     v_manifest:=v_file->'cloud_chunks'->v_chunk_no;
     IF jsonb_typeof(v_manifest) IS DISTINCT FROM 'object' OR NOT(v_manifest ?& ARRAY['version','attachmentId','offset','size','sha256']) OR v_manifest-ARRAY['version','attachmentId','offset','size','sha256']<>'{}'::jsonb OR v_manifest->>'version'<>'1' OR v_manifest->>'attachmentId' IS DISTINCT FROM COALESCE(v_file->>'storage_id',v_file->>'id') OR v_manifest->>'offset' IS DISTINCT FROM v_off::text OR v_manifest->>'size' IS DISTINCT FROM v_wanted::text OR jsonb_typeof(v_manifest->'sha256') IS DISTINCT FROM 'string' OR (v_manifest->>'sha256')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid cloud chunk' USING ERRCODE='PT503';END IF;
    ELSE
     SELECT c.data INTO v_raw FROM fountain_private.attachment_chunks c WHERE c.workspace_id=v_ws AND c.attachment_id=v_item_id AND c."offset"=v_off;
     IF NOT FOUND OR octet_length(v_raw)<>v_wanted THEN RAISE EXCEPTION 'Legacy chunk unavailable' USING ERRCODE='PT503';END IF;
    END IF;
    v_ordinal:=v_j.source_counts[3];v_descriptor:=jsonb_build_object('attachment_id',v_item_id,'offset',v_off,'data',jsonb_build_object('ref','attachment_chunks:'||v_ordinal,'size',v_wanted,'type','blob'));
    INSERT INTO fountain_cloud.backup_job_source VALUES(v_ws,v_identity,'attachment_chunks',v_ordinal,v_descriptor,v_raw,v_manifest,NULL,NULL);v_j.source_counts[3]:=v_ordinal+1;v_last_id:=v_item_id;v_chunk_no:=v_chunk_no+1;v_copied:=v_copied+COALESCE(octet_length(v_raw),256);v_counted:=v_counted+1;
   ELSE
    SELECT p.* INTO v_history FROM fountain_private.content_provenance p WHERE p.workspace_id=v_ws
     AND(p.kind COLLATE "C",p.id COLLATE "C")>(v_last_kind COLLATE "C",v_last_id COLLATE "C") ORDER BY p.kind COLLATE "C",p.id COLLATE "C" LIMIT 1;
    IF NOT FOUND THEN v_table_no:=4;CONTINUE;END IF;
    v_descriptor:=fountain_cloud.backup_provenance_value(v_history);v_ordinal:=v_j.source_counts[4];
    INSERT INTO fountain_cloud.backup_job_source VALUES(v_ws,v_identity,'content_provenance',v_ordinal,v_descriptor,NULL,NULL,NULL,NULL);
    v_j.source_counts[4]:=v_ordinal+1;v_last_kind:=v_history.kind;v_last_id:=v_history.id;v_copied:=v_copied+octet_length(v_descriptor::text);v_counted:=v_counted+1;
   END IF;
  END LOOP;
  v_j.source_cursor:=jsonb_build_object('table',v_table_no,'kind',v_last_kind,'id',v_last_id,'chunk',v_chunk_no);v_j.source_bytes:=v_j.source_bytes+v_copied;IF v_table_no=v_table_count THEN v_j.phase:='building';END IF;
  UPDATE fountain_cloud.backup_jobs bj SET source_cursor=v_j.source_cursor,source_file_count=v_j.source_file_count,source_counts=v_j.source_counts,source_bytes=v_j.source_bytes,phase=v_j.phase WHERE bj.workspace_id=v_ws AND bj.id=v_identity;
 ELSIF p_action='read' THEN
  IF v_j.phase<>'building' THEN RAISE EXCEPTION 'Source not ready' USING ERRCODE='PT409';END IF;
  IF p_payload ? 'describe' THEN
   v_q:=p_payload->'describe';v_table_name:=v_q->>'table';v_first_index:=(v_q->>'start')::bigint;v_limit_count:=(v_q->>'count')::integer;
   IF v_table_name NOT IN('entities','meta','attachment_chunks','content_provenance') OR v_first_index<0 OR v_limit_count NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'Invalid read window' USING ERRCODE='22023';END IF;
   FOR v_n IN 0..v_limit_count-1 LOOP
    SELECT * INTO v_item FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=v_ws AND s.job_id=v_identity AND s.table_name=v_table_name AND s.ordinal=v_first_index+v_n;
    IF NOT FOUND THEN v_descriptions:=v_descriptions||jsonb_build_array(jsonb_build_object('table',v_table_name,'index',v_first_index+v_n,'value',NULL));EXIT;END IF;
    v_descriptions:=v_descriptions||jsonb_build_array(jsonb_build_object('table',v_table_name,'index',v_first_index+v_n,'value',v_item.descriptor));
    IF v_item.raw IS NOT NULL AND v_copied<262144 THEN v_raw:=substr(v_item.raw,1,least(65536,262144-v_copied)::integer);v_byte_values:=v_byte_values||jsonb_build_array(jsonb_build_object('ref',v_table_name||':'||(v_first_index+v_n),'offset',0,'base64',replace(encode(v_raw,'base64'),E'\n','')));v_copied:=v_copied+octet_length(v_raw);END IF;
   END LOOP;
  END IF;
  IF p_payload ? 'plan_window' THEN
   v_q:=p_payload->'plan_window';v_first_index:=(v_q->>'start')::bigint;v_limit_count:=(v_q->>'count')::integer;IF length(v_q->>'prefix')>1000 OR v_first_index<0 OR v_limit_count NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'Invalid plan window' USING ERRCODE='22023';END IF;
   FOR v_item IN SELECT p.key,p.data FROM fountain_cloud.backup_job_plan p WHERE p.workspace_id=v_ws AND p.job_id=v_identity AND p.key IN(SELECT (v_q->>'prefix')||g FROM generate_series(v_first_index,v_first_index+v_limit_count-1) g) LOOP v_plan_values:=v_plan_values||jsonb_build_array(jsonb_build_object('key',v_item.key,'value',v_item.data));END LOOP;
   IF v_q->>'prefix'='manifest-id/' THEN
    -- Derive the batch from immutable source ordinals, never by trusting or
    -- unwrapping an unchecked plan envelope. The writer verifies every get.
    FOR v_item IN SELECT k.key,p.data FROM fountain_cloud.backup_job_source s
     CROSS JOIN LATERAL(VALUES('manifest/1/'||(s.descriptor->>'id')),('manifest/2/'||(s.descriptor->>'id'))) k(key)
     LEFT JOIN fountain_cloud.backup_job_plan p ON p.workspace_id=v_ws AND p.job_id=v_identity AND p.key=k.key
     WHERE s.workspace_id=v_ws AND s.job_id=v_identity AND s.file_ordinal>=v_first_index AND s.file_ordinal<v_first_index+v_limit_count
     ORDER BY s.file_ordinal,k.key
    LOOP v_plan_values:=v_plan_values||jsonb_build_array(jsonb_build_object('key',v_item.key,'value',v_item.data));END LOOP;
   END IF;
  END IF;
  IF p_payload ? 'plan_keys' THEN
   IF jsonb_typeof(p_payload->'plan_keys')<>'array' OR jsonb_array_length(p_payload->'plan_keys')>128 THEN RAISE EXCEPTION 'Invalid keys' USING ERRCODE='22023';END IF;
   FOR v_key IN SELECT jsonb_array_elements_text(p_payload->'plan_keys') LOOP SELECT p.data INTO v_value FROM fountain_cloud.backup_job_plan p WHERE p.workspace_id=v_ws AND p.job_id=v_identity AND p.key=v_key;v_plan_values:=v_plan_values||jsonb_build_array(jsonb_build_object('key',v_key,'value',v_value));END LOOP;
  END IF;
  IF p_payload ? 'source' THEN
   v_q:=p_payload->'source';v_ref:=v_q->>'ref';v_off:=(v_q->>'offset')::bigint;v_wanted:=(v_q->>'length')::integer;
   IF v_off<0 OR v_wanted NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Invalid byte range' USING ERRCODE='22023';END IF;
   v_table_name:=split_part(v_ref,':',1);
   IF v_table_name NOT IN('entities','meta','attachment_chunks','content_provenance') OR split_part(v_ref,':',2)!~'^[0-9]{1,16}$' OR v_ref IS DISTINCT FROM v_table_name||':'||((split_part(v_ref,':',2))::bigint)::text THEN RAISE EXCEPTION 'Invalid private source ref' USING ERRCODE='22023';END IF;
   SELECT * INTO v_item FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=v_ws AND s.job_id=v_identity AND s.table_name=v_table_name AND s.ordinal=(split_part(v_ref,':',2))::bigint;
   IF NOT FOUND THEN RAISE EXCEPTION 'Source reference unavailable' USING ERRCODE='PT503';END IF;
   IF v_item.cloud IS NOT NULL THEN v_reference_values:=jsonb_build_array(jsonb_build_object('ref',v_ref,'kind','cloud','size',(v_item.descriptor->'data'->>'size')::bigint,'manifest',v_item.cloud));
   ELSE v_raw:=substr(v_item.raw,v_off+1,v_wanted);v_byte_values:=v_byte_values||jsonb_build_array(jsonb_build_object('ref',v_ref,'offset',v_off,'base64',replace(encode(v_raw,'base64'),E'\n','')));END IF;
  END IF;
  v_result:=jsonb_build_object('descriptors',v_descriptions,'plans',v_plan_values,'bytes',v_byte_values,'references',v_reference_values);IF octet_length(v_result::text)>4194304 THEN RAISE EXCEPTION 'Read window exceeds bounds' USING ERRCODE='PT413';END IF;RETURN v_result;
 ELSIF p_action='output' THEN
  v_off:=(p_payload->>'offset')::bigint;v_wanted:=(p_payload->>'length')::integer;IF v_off<0 OR v_wanted NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Invalid output range' USING ERRCODE='22023';END IF;
  SELECT * INTO v_part_record FROM fountain_cloud.backup_job_parts bpt WHERE bpt.workspace_id=v_ws AND bpt.job_id=v_identity AND bpt.state='published' AND bpt.start_bytes<=v_off AND bpt.start_bytes+(bpt.manifest->>'size')::bigint>=v_off+v_wanted ORDER BY bpt.start_bytes DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unpublished output cannot be verified' USING ERRCODE='PT409';END IF;
  RETURN jsonb_build_object('manifest',v_part_record.manifest,'relative',v_off-v_part_record.start_bytes);
 ELSIF p_action='publication' THEN
  SELECT * INTO v_part_record FROM fountain_cloud.backup_job_parts bpt WHERE bpt.workspace_id=v_ws AND bpt.job_id=v_identity AND bpt.state='pending' ORDER BY bpt.start_bytes LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('part',jsonb_build_object('id',v_part_record.id,'manifest',v_part_record.manifest,'start',v_part_record.start_bytes,'publisher',false));END IF;
  SELECT count(*),min(bo.offset_bytes) INTO v_counted,v_off FROM fountain_cloud.backup_job_output bo WHERE bo.workspace_id=v_ws AND bo.job_id=v_identity;
  IF v_counted=0 OR v_counted<64 AND COALESCE(v_j.checkpoint->>'phase','') NOT IN('verify','done') THEN RETURN '{}'::jsonb;END IF;
  v_part_size:=least(v_counted,64)*4096;
  SELECT string_agg(x.data,''::bytea ORDER BY x.offset_bytes) INTO v_part_bytes FROM(SELECT o.data,o.offset_bytes FROM fountain_cloud.backup_job_output o WHERE o.workspace_id=v_ws AND o.job_id=v_identity ORDER BY o.offset_bytes LIMIT 64)x;
  IF octet_length(v_part_bytes)<>v_part_size THEN RAISE EXCEPTION 'Output missing' USING ERRCODE='PT503';END IF;
  v_part_id:=gen_random_uuid()::text;v_manifest:=jsonb_build_object('version',1,'attachmentId','backup-'||v_identity||'-'||v_part_id,'offset',0,'size',v_part_size,'sha256',encode(sha256(v_part_bytes),'hex'));
  INSERT INTO fountain_cloud.backup_job_parts VALUES(v_ws,v_identity,v_part_id,v_off,v_manifest,'pending',NULL);
  RETURN jsonb_build_object('part',jsonb_build_object('id',v_part_id,'manifest',v_manifest,'start',v_off,'publisher',true,'base64',replace(encode(v_part_bytes,'base64'),E'\n','')));
 ELSIF p_action='published' THEN
  SELECT * INTO v_part_record FROM fountain_cloud.backup_job_parts bpt WHERE bpt.workspace_id=v_ws AND bpt.job_id=v_identity AND bpt.id=p_payload->>'part_id' AND bpt.state='pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication changed' USING ERRCODE='PT409';END IF;
  UPDATE fountain_cloud.backup_job_parts bpt SET state='published' WHERE bpt.workspace_id=v_ws AND bpt.job_id=v_identity AND bpt.id=v_part_record.id;
  DELETE FROM fountain_cloud.backup_job_output bo WHERE bo.workspace_id=v_ws AND bo.job_id=v_identity AND bo.offset_bytes>=v_part_record.start_bytes AND bo.offset_bytes<v_part_record.start_bytes+(v_part_record.manifest->>'size')::bigint;
 ELSIF p_action='commit' THEN
  IF p_payload->'checkpoint'->>'version' IS DISTINCT FROM v_j.format_version::text THEN RAISE EXCEPTION 'Checkpoint format changed' USING ERRCODE='PT409';END IF;
  IF v_j.phase<>'building' OR jsonb_typeof(p_payload->'checkpoint')<>'object' OR p_payload->'checkpoint'->>'snapshotId' IS DISTINCT FROM v_identity OR (p_payload->'checkpoint'->>'sequence')::bigint<>COALESCE((v_j.checkpoint->>'sequence')::bigint,0)+1 THEN RAISE EXCEPTION 'Checkpoint changed' USING ERRCODE='PT409';END IF;
  IF jsonb_array_length(p_payload->'plans')>4096 OR jsonb_array_length(p_payload->'outputs')>64 THEN RAISE EXCEPTION 'Step exceeds bounds' USING ERRCODE='PT413';END IF;
  FOR v_q IN SELECT jsonb_array_elements(p_payload->'plans') LOOP
   IF length(v_q->>'key')>1024 OR octet_length((v_q->'data')::text)>32768 THEN RAISE EXCEPTION 'Plan exceeds bounds' USING ERRCODE='PT413';END IF;
   INSERT INTO fountain_cloud.backup_job_plan VALUES(v_ws,v_identity,v_q->>'key',v_q->'data') ON CONFLICT(workspace_id,job_id,"key") DO UPDATE SET data=EXCLUDED.data;
  END LOOP;
  FOR v_q IN SELECT jsonb_array_elements(p_payload->'outputs') LOOP
   v_off:=(v_q->>'offset')::bigint;v_raw:=decode(v_q->>'base64','base64');IF v_off<>v_j.output_bytes OR octet_length(v_raw)<>4096 OR v_q->>'sha256' IS DISTINCT FROM encode(sha256(v_raw),'hex') THEN RAISE EXCEPTION 'Output changed' USING ERRCODE='PT409';END IF;
   INSERT INTO fountain_cloud.backup_job_output VALUES(v_ws,v_identity,v_off,v_raw,v_q->>'sha256');v_j.output_bytes:=v_j.output_bytes+4096;v_reservation_delta:=v_reservation_delta+4096;
  END LOOP;
  -- Quota is durable before any Storage POST and remains charged through cancel.
  PERFORM fountain_cloud.backup_job_reserve(v_ws,v_reservation_delta,v_j.quota_bytes);
  v_j.checkpoint:=p_payload->'checkpoint';
  IF p_payload->'completed'='true'::jsonb THEN
   IF v_j.checkpoint->>'phase'<>'done' OR (p_payload->>'sha256')!~'^[a-f0-9]{64}$' OR (p_payload->'summary'->>'byteLength')::bigint<>v_j.output_bytes OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_output bo WHERE bo.workspace_id=v_ws AND bo.job_id=v_identity) OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_parts bpt WHERE bpt.workspace_id=v_ws AND bpt.job_id=v_identity AND bpt.state<>'published') THEN RAISE EXCEPTION 'Backup not published and verified' USING ERRCODE='PT409';END IF;
   v_j.phase:='ready';v_j.size:=v_j.output_bytes;v_j.sha256:=p_payload->>'sha256';
  END IF;
  UPDATE fountain_cloud.backup_jobs bj SET checkpoint=v_j.checkpoint,output_bytes=v_j.output_bytes,reserved_bytes=v_j.output_bytes,phase=v_j.phase,size=v_j.size,sha256=v_j.sha256 WHERE bj.workspace_id=v_ws AND bj.id=v_identity;
 ELSE RAISE EXCEPTION 'Unknown backup action' USING ERRCODE='22023';
 END IF;
 UPDATE fountain_cloud.backup_jobs bj SET version=bj.version+1,lease_id=NULL,lease_until=NULL WHERE bj.workspace_id=v_ws AND bj.id=v_identity RETURNING * INTO v_j;
 v_result:=fountain_cloud.backup_job_view(v_j);
 INSERT INTO fountain_cloud.backup_job_receipts VALUES(v_ws,v_identity,p_payload->>'transaction_id',p_payload->>'digest',(v_result-ARRAY['checkpoint','lease_id'])||jsonb_build_object('checkpoint',CASE WHEN v_j.checkpoint IS NULL THEN NULL ELSE jsonb_build_object('phase',v_j.checkpoint->>'phase') END));
 RETURN v_result;
END $$;
