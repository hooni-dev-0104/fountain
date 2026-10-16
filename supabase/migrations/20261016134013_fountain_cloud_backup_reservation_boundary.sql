-- Private backup reservations are readable for quota checks, never generic writes or portable export.
CREATE OR REPLACE FUNCTION fountain_cloud.store_commit(p_context jsonb, p_expected_revision bigint, p_transaction_id uuid, p_digest text, p_canonical text, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE ws text;actor_id text;revision bigint;recorded fountain_cloud.store_commit_receipts;change jsonb;
 previous fountain_private.entities;found_previous boolean;affected bigint;data jsonb;change_kind text;change_id text;meta_key text;steps bigint:=0;owner_mutated boolean:=false;
BEGIN
 -- Always authenticate BEFORE replay ACK, including a previously committed tx.
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';actor_id:=p_context->>'memberId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_transaction_id IS NULL
  OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>16777216
  OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid commit' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_changes)>1000 OR octet_length(p_changes::text)>16777216 THEN
  RAISE EXCEPTION 'Commit limit exceeded' USING ERRCODE='PT413';
 END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest
  OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes) THEN
  RAISE EXCEPTION 'Invalid commit digest' USING ERRCODE='22023';
 END IF;
 SELECT * INTO recorded FROM fountain_cloud.store_commit_receipts r
 WHERE r.workspace_id=ws AND r.member_id=actor_id AND r.session_hash=p_context->>'sessionHash' AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF recorded.digest<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('revision',recorded.result_revision);
 END IF;
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');
 IF revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409'; END IF;
 FOR change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  IF jsonb_typeof(change) IS DISTINCT FROM 'object' OR jsonb_typeof(change->'op') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023';
  END IF;
  IF change->>'op' IN ('put','delete') THEN
   change_kind:=change->>'kind';change_id:=change->>'id';
   IF jsonb_typeof(change->'kind') IS DISTINCT FROM 'string' OR change_kind !~ '^[a-z][a-z0-9_]{0,63}$' OR change_kind IN ('credential','session')
    OR jsonb_typeof(change->'id') IS DISTINCT FROM 'string' OR length(change_id) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023';
   END IF;
   IF change_kind='member' AND EXISTS(SELECT 1 FROM fountain_private.entities e
     WHERE e.workspace_id=ws AND e.kind='member' AND e.id=change_id AND e.data->>'role'='owner') THEN
    owner_mutated:=true;
   END IF;
   IF change->>'op'='put' THEN
    IF NOT(change ?& ARRAY['op','kind','id','data','previousCreatedAt']) OR change-ARRAY['op','kind','id','data','previousCreatedAt']<>'{}'::jsonb
     OR jsonb_typeof(change->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    data:=change->'data';
    IF btrim(change_id)='' OR data->>'id' IS DISTINCT FROM change_id OR jsonb_typeof(data->'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(data->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(data->'updated_at') IS DISTINCT FROM 'string'
     OR length(data->>'created_at') NOT BETWEEN 1 AND 64 OR length(data->>'updated_at') NOT BETWEEN 1 AND 64
     OR change_kind='attachment' AND data ? 'data' THEN RAISE EXCEPTION 'Invalid entity data' USING ERRCODE='22023'; END IF;
    SELECT * INTO previous FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind=change_kind AND e.id=change_id;
    found_previous:=FOUND;
    IF (found_previous AND (change->'previousCreatedAt' IS DISTINCT FROM to_jsonb(previous.created_at) OR data->>'created_at' IS DISTINCT FROM previous.created_at))
     OR (NOT found_previous AND change->'previousCreatedAt' IS DISTINCT FROM 'null'::jsonb) THEN
     RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
    END IF;
    INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at)
    VALUES(ws,change_kind,change_id,data,data->>'created_at',data->>'updated_at')
    ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at;
    steps:=steps+1;
   ELSE
    IF NOT(change ?& ARRAY['op','kind','id']) OR change-ARRAY['op','kind','id']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    DELETE FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind=change_kind AND e.id=change_id;
    GET DIAGNOSTICS affected=ROW_COUNT;steps:=steps+affected;
   END IF;
  ELSIF change->>'op'='meta' THEN
   meta_key:=change->>'key';
   IF NOT(change ?& ARRAY['op','key','value']) OR change-ARRAY['op','key','value']<>'{}'::jsonb
    OR jsonb_typeof(change->'key') IS DISTINCT FROM 'string' OR length(meta_key) NOT BETWEEN 1 AND 160
    OR meta_key IN ('_entity_revision','local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved')
    OR meta_key='workspace_id' AND change->'value' IS DISTINCT FROM to_jsonb(ws) THEN RAISE EXCEPTION 'Invalid metadata change' USING ERRCODE='22023'; END IF;
   INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(ws,meta_key,change->'value')
   ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
   steps:=steps+1;
  ELSE RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Evaluate the final transaction state, including multi-member changes.
 -- Legacy password hashes never prove that a Supabase owner can log in.
 IF owner_mutated THEN
  PERFORM 1 FROM fountain_private.entities e
   JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id
   JOIN auth.users u ON u.id=m.auth_user_id
   WHERE e.workspace_id=ws AND e.kind='member' AND e.data->>'id'=e.id AND e.data->>'role'='owner'
    AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
    AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
    AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
    AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
    AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   ORDER BY u.id FOR SHARE OF e,m,u;
  IF NOT FOUND THEN RAISE EXCEPTION 'LAST_OWNER_ACCOUNT' USING ERRCODE='PT409'; END IF;
 END IF;
 IF revision+steps>9007199254740991 THEN RAISE EXCEPTION 'Revision limit exceeded' USING ERRCODE='PT413'; END IF;
 revision:=revision+steps;
 IF steps>0 THEN
  INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(ws,'_entity_revision',to_jsonb(revision))
  ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 END IF;
 INSERT INTO fountain_cloud.store_commit_receipts(workspace_id,member_id,session_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(ws,actor_id,p_context->>'sessionHash',p_transaction_id,p_digest,p_expected_revision,revision);
 RETURN jsonb_build_object('revision',revision);
END $function$;

CREATE OR REPLACE FUNCTION fountain_cloud.backup_export(p_context jsonb, p_expected_revision bigint DEFAULT NULL::bigint, p_cursor jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE authority jsonb;ws text;revision bigint;scope text;phase integer:=0;
 last_kind text:='';last_id text:='';last_offset bigint:=0;last_part integer:=0;
 item record;raw text;parts integer;part integer;first_part integer;dto jsonb;
 items jsonb[]:=ARRAY[]::jsonb[];used bigint:=4096;following jsonb:=NULL;result jsonb;
BEGIN
 authority:=fountain_cloud.backup_authorize(p_context);ws:=p_context->>'workspaceId';revision:=(authority->>'revision')::bigint;
 IF p_expected_revision IS NOT NULL AND (p_expected_revision<0 OR p_expected_revision<>revision) THEN
  RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 scope:=encode(sha256(convert_to(jsonb_build_array(p_context,revision)::text,'UTF8')),'hex');
 IF p_cursor IS NOT NULL THEN
  IF p_expected_revision IS NULL OR jsonb_typeof(p_cursor) IS DISTINCT FROM 'object'
   OR NOT(p_cursor ?& ARRAY['phase','kind','id','offset','part','scope'])
   OR p_cursor-ARRAY['phase','kind','id','offset','part','scope']<>'{}'::jsonb
   OR jsonb_typeof(p_cursor->'scope') IS DISTINCT FROM 'string' OR p_cursor->>'scope' IS DISTINCT FROM scope
   OR jsonb_typeof(p_cursor->'phase') IS DISTINCT FROM 'number' OR (p_cursor->>'phase') !~ '^[0-2]$'
   OR jsonb_typeof(p_cursor->'kind') IS DISTINCT FROM 'string' OR length(p_cursor->>'kind')>64
   OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string' OR length(p_cursor->>'id') NOT BETWEEN 1 AND 160
   OR jsonb_typeof(p_cursor->'offset') IS DISTINCT FROM 'number' OR (p_cursor->>'offset') !~ '^[0-9]{1,10}$'
   OR (p_cursor->>'offset')::bigint>5000000000
   OR jsonb_typeof(p_cursor->'part') IS DISTINCT FROM 'number' OR (p_cursor->>'part') !~ '^[0-9]{1,3}$'
   OR (p_cursor->>'part')::integer>128 THEN
   RAISE EXCEPTION 'Invalid backup cursor' USING ERRCODE='22023';
  END IF;
  phase:=(p_cursor->>'phase')::integer;last_kind:=p_cursor->>'kind';last_id:=p_cursor->>'id';last_offset:=(p_cursor->>'offset')::bigint;last_part:=(p_cursor->>'part')::integer;
  IF (phase=0 AND (last_kind !~ '^[a-z][a-z0-9_]{0,63}$' OR last_offset<>0))
   OR (phase>0 AND last_kind<>'') OR (phase=1 AND last_offset<>0) OR (phase=2 AND last_part<>0) THEN
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
     RETURN jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',following);
    END IF;
    items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',0,'kind',item.kind,'id',item.id,'offset',0,'part',part,'scope',scope);
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
     RETURN jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',following);
    END IF;
    items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',1,'kind','','id',item.key,'offset',0,'part',part,'scope',scope);
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
    RETURN jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',following);
   END IF;
   items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',2,'kind','','id',item.attachment_id,'offset',item."offset",'part',0,'scope',scope);
  END LOOP;
 END IF;
 result:=jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',NULL);
 IF octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'Backup page limit exceeded' USING ERRCODE='PT413';END IF;
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb),fountain_cloud.backup_export(jsonb,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb),fountain_cloud.backup_export(jsonb,bigint,jsonb) TO service_role;
