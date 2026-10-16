-- Atomic cloud store; deployed through Supabase MCP.
-- Trusted Edge service-role RPC, NOT per-user RLS. No legacy table grants change.
-- Every public wrapper is revoked from clients in the same DDL transaction.

CREATE TABLE fountain_cloud.store_commit_receipts (
 workspace_id text NOT NULL,
 member_id text NOT NULL,
 session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
 transaction_id uuid NOT NULL,
 digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 expected_revision bigint NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740991),
 result_revision bigint NOT NULL CHECK (result_revision BETWEEN expected_revision AND 9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,member_id,session_hash,transaction_id)
);
ALTER TABLE fountain_cloud.store_commit_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.store_commit_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.store_commit_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX store_commit_receipts_created_idx ON fountain_cloud.store_commit_receipts(created_at);

-- Match PostgresStore's signed first 8 bytes of SHA256, so old and new writers
-- serialize during migration. No caller-controlled lock namespace or dynamic SQL.
CREATE FUNCTION fountain_cloud.store_lock(p_workspace_id text) RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||p_workspace_id,'UTF8')),'hex'),1,16))::bit(64)::bigint)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.store_lock(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.store_context(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE profile jsonb; ws text; actor_id text;
BEGIN
 IF jsonb_typeof(p_context) IS DISTINCT FROM 'object'
  OR NOT (p_context ?& ARRAY['workspaceId','memberId','userId','authSessionId','sessionHash','cacheBinding'])
  OR p_context - ARRAY['workspaceId','memberId','userId','authSessionId','sessionHash','cacheBinding'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'Invalid storage context' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_context) e WHERE jsonb_typeof(e.value) <> 'string')
  OR length(p_context->>'workspaceId') NOT BETWEEN 1 AND 160 OR length(p_context->>'memberId') NOT BETWEEN 1 AND 160
  OR (p_context->>'userId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR (p_context->>'authSessionId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR (p_context->>'sessionHash') !~ '^[a-f0-9]{64}$' OR (p_context->>'cacheBinding') !~ '^[a-f0-9]{32}$' THEN
  RAISE EXCEPTION 'Invalid storage context' USING ERRCODE='22023';
 END IF;
 ws:=p_context->>'workspaceId';actor_id:=p_context->>'memberId';
 PERFORM fountain_cloud.store_lock(ws);
 PERFORM set_config('fountain.workspace_id',ws,true);
 -- Lock the live identities through this RPC: logout/ban/unlink cannot slip
 -- between authorization and mutation. The public RPC itself is service-only.
 PERFORM 1 FROM fountain_cloud.session_vault v
  JOIN auth.sessions s ON s.id=v.auth_session_id AND s.user_id=v.user_id
  JOIN auth.users u ON u.id=s.user_id
  JOIN fountain_private.identity_mapping m ON m.workspace_id=v.workspace_id AND m.auth_user_id=v.user_id
  JOIN fountain_private.entities e ON e.workspace_id=m.workspace_id AND e.kind='member' AND e.id=m.member_id
 WHERE v.workspace_id=ws AND v.hash=p_context->>'sessionHash'
  AND v.user_id=(p_context->>'userId')::uuid AND v.auth_session_id=(p_context->>'authSessionId')::uuid
  AND v.cache_binding=p_context->>'cacheBinding' AND v.revoked_at_ms IS NULL AND NOT v.logout_pending
  AND v.expires_at_ms > floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  AND m.member_id=actor_id
  AND u.deleted_at IS NULL AND NOT u.is_anonymous AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
  AND (s.not_after IS NULL OR s.not_after > clock_timestamp())
 FOR SHARE OF v,s,u,m,e;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401'; END IF;
 -- Reuse the authoritative member shape and live Auth validation, not JWT role,
 -- email matching or user-editable user_metadata.
 profile:=fountain_cloud.resolve_profile(ws,(p_context->>'userId')::uuid,(p_context->>'authSessionId')::uuid);
 IF profile IS NULL OR profile->'authSessionActive' IS DISTINCT FROM 'true'::jsonb
  OR profile->'member'->'active' IS DISTINCT FROM 'true'::jsonb OR profile->'member'->>'id' IS DISTINCT FROM actor_id THEN
  RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';
 END IF;
 RETURN profile->'member';
END $$;
ALTER FUNCTION fountain_cloud.store_context(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.store_context(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.store_revision(p_workspace_id text,p_key text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE value text; revision bigint;
BEGIN
 SELECT data #>> '{}' INTO value FROM fountain_private.meta WHERE workspace_id=p_workspace_id AND key=p_key;
 IF NOT FOUND THEN RETURN 0; END IF;
 IF value IS NULL OR value !~ '^[0-9]+$' OR length(value)>16 THEN
  RAISE EXCEPTION 'Workspace revision is invalid' USING ERRCODE='PT503';
 END IF;
 revision:=value::bigint;
 IF revision>9007199254740991 THEN RAISE EXCEPTION 'Workspace revision limit reached' USING ERRCODE='PT503'; END IF;
 RETURN revision;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.store_revision(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.store_selection(p_selection jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE item jsonb; entry record; count bigint;
BEGIN
 IF jsonb_typeof(p_selection) IS DISTINCT FROM 'object'
  OR NOT(p_selection ?& ARRAY['kinds','ids','metaKeys','pageSize'])
  OR p_selection - ARRAY['kinds','ids','metaKeys','pageSize'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023';
 END IF;
 IF jsonb_typeof(p_selection->'kinds') IS DISTINCT FROM 'array' OR jsonb_typeof(p_selection->'ids') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_selection->'metaKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(p_selection->'pageSize') IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023';
 END IF;
 IF (p_selection->>'pageSize') !~ '^[0-9]+$' OR (p_selection->>'pageSize')::numeric NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023';
 END IF;
 count:=jsonb_array_length(p_selection->'kinds')+jsonb_array_length(p_selection->'metaKeys');
 FOR item IN SELECT value FROM jsonb_array_elements(p_selection->'kinds') LOOP
  IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ '^[a-z][a-z0-9_]{0,63}$' OR (item #>> '{}') IN ('credential','session') THEN
   RAISE EXCEPTION 'Selection forbidden' USING ERRCODE='22023';
  END IF;
 END LOOP;
 FOR entry IN SELECT key,value FROM jsonb_each(p_selection->'ids') LOOP
  IF entry.key !~ '^[a-z][a-z0-9_]{0,63}$' OR entry.key IN ('credential','session') OR jsonb_typeof(entry.value) <> 'array' THEN
   RAISE EXCEPTION 'Selection forbidden' USING ERRCODE='22023';
  END IF;
  count:=count+jsonb_array_length(entry.value);
  FOR item IN SELECT value FROM jsonb_array_elements(entry.value) LOOP
   IF jsonb_typeof(item) <> 'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Invalid selection' USING ERRCODE='22023';
   END IF;
  END LOOP;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_selection->'metaKeys') LOOP
  IF jsonb_typeof(item) <> 'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 160
   OR (item #>> '{}') IN ('local_cache_binding','attachment_file_root','attachment_file_gc_cursor') THEN
   RAISE EXCEPTION 'Selection forbidden' USING ERRCODE='22023';
  END IF;
 END LOOP;
 IF count>1000 THEN RAISE EXCEPTION 'Selection limit exceeded' USING ERRCODE='PT413'; END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.store_selection(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.store_snapshot(p_context jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal jsonb; ws text; revision bigint; access_revision bigint; scope text; item record;
 result jsonb; records jsonb[]:=ARRAY[]::jsonb[]; metas jsonb; dto jsonb; following jsonb:=NULL;
 last_kind text;last_created text;last_id text;count integer:=0;total_bytes bigint;page_size integer;
BEGIN
 principal:=fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 PERFORM fountain_cloud.store_selection(p_selection);
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');access_revision:=fountain_cloud.store_revision(ws,'access_revision');
 IF p_expected_revision IS NOT NULL AND (p_expected_revision<0 OR p_expected_revision<>revision) THEN
  RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 page_size:=(p_selection->>'pageSize')::integer;
 scope:=encode(sha256(convert_to(jsonb_build_array(p_context,p_selection,revision)::text,'UTF8')),'hex');
 IF p_cursor IS NOT NULL THEN
  IF p_expected_revision IS NULL OR jsonb_typeof(p_cursor) IS DISTINCT FROM 'object'
   OR NOT(p_cursor ?& ARRAY['kind','createdAt','id','scope']) OR p_cursor-ARRAY['kind','createdAt','id','scope'] <> '{}'::jsonb
   OR p_cursor->>'scope' IS DISTINCT FROM scope
   OR EXISTS(SELECT 1 FROM jsonb_each(p_cursor) e WHERE jsonb_typeof(e.value)<>'string') THEN
   RAISE EXCEPTION 'Invalid snapshot cursor' USING ERRCODE='22023';
  END IF;
 END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('key',keys.key,'value',m.data,'present',m.key IS NOT NULL) ORDER BY keys.key COLLATE "C"),'[]'::jsonb)
 INTO metas FROM (SELECT DISTINCT value #>> '{}' AS key FROM jsonb_array_elements(p_selection->'metaKeys')) keys
 LEFT JOIN fountain_private.meta m ON m.workspace_id=ws AND m.key=keys.key;
 total_bytes:=octet_length(metas::text)+octet_length(principal::text)+4096;
 IF total_bytes>16777216 THEN RAISE EXCEPTION 'Snapshot limit exceeded' USING ERRCODE='PT413'; END IF;
 FOR item IN
  SELECT e.kind,e.id,e.data,e.created_at,e.updated_at FROM fountain_private.entities e
  WHERE e.workspace_id=ws
   AND ((p_selection->'kinds') ? e.kind OR COALESCE((p_selection->'ids'->e.kind) ? e.id,false))
   AND (p_cursor IS NULL OR (e.kind COLLATE "C",e.created_at COLLATE "C",e.id COLLATE "C") >
    ((p_cursor->>'kind') COLLATE "C",(p_cursor->>'createdAt') COLLATE "C",(p_cursor->>'id') COLLATE "C"))
  ORDER BY e.kind COLLATE "C",e.created_at COLLATE "C",e.id COLLATE "C" LIMIT page_size+1
 LOOP
  IF count=page_size THEN following:=jsonb_build_object('kind',last_kind,'createdAt',last_created,'id',last_id,'scope',scope);EXIT; END IF;
  dto:=jsonb_build_object('kind',item.kind,'id',item.id,'data',CASE WHEN item.kind='attachment' THEN item.data-'data' ELSE item.data END,'createdAt',item.created_at,'updatedAt',item.updated_at);
  IF total_bytes+octet_length(dto::text)>16777216 THEN
   IF count=0 THEN RAISE EXCEPTION 'Snapshot record limit exceeded' USING ERRCODE='PT413'; END IF;
   following:=jsonb_build_object('kind',last_kind,'createdAt',last_created,'id',last_id,'scope',scope);EXIT;
  END IF;
  records:=array_append(records,dto);total_bytes:=total_bytes+octet_length(dto::text);count:=count+1;
  last_kind:=item.kind;last_created:=item.created_at;last_id:=item.id;
 END LOOP;
 result:=jsonb_build_object('workspaceId',ws,'memberId',p_context->>'memberId','revision',revision,'accessRevision',access_revision,
  'principal',principal,'entities',to_jsonb(records),'meta',metas,'nextCursor',following);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'Snapshot limit exceeded' USING ERRCODE='PT413'; END IF;
 RETURN result;
END $$;
ALTER FUNCTION fountain_cloud.store_snapshot(jsonb,jsonb,jsonb,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.store_snapshot(jsonb,jsonb,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.store_snapshot(jsonb,jsonb,jsonb,bigint) TO service_role;

CREATE FUNCTION fountain_cloud.store_commit(p_context jsonb,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ws text;actor_id text;revision bigint;recorded fountain_cloud.store_commit_receipts;change jsonb;
 previous fountain_private.entities;found_previous boolean;affected bigint;data jsonb;change_kind text;change_id text;meta_key text;steps bigint:=0;
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
    OR meta_key IN ('_entity_revision','local_cache_binding','attachment_file_root','attachment_file_gc_cursor')
    OR meta_key='workspace_id' AND change->'value' IS DISTINCT FROM to_jsonb(ws) THEN RAISE EXCEPTION 'Invalid metadata change' USING ERRCODE='22023'; END IF;
   INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(ws,meta_key,change->'value')
   ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
   steps:=steps+1;
  ELSE RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF revision+steps>9007199254740991 THEN RAISE EXCEPTION 'Revision limit exceeded' USING ERRCODE='PT413'; END IF;
 revision:=revision+steps;
 IF steps>0 THEN
  INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(ws,'_entity_revision',to_jsonb(revision))
  ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 END IF;
 INSERT INTO fountain_cloud.store_commit_receipts(workspace_id,member_id,session_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(ws,actor_id,p_context->>'sessionHash',p_transaction_id,p_digest,p_expected_revision,revision);
 RETURN jsonb_build_object('revision',revision);
END $$;
ALTER FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb) TO service_role;

CREATE FUNCTION public.fountain_cloud_store_snapshot(p_context jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.store_snapshot(p_context,p_selection,p_cursor,p_expected_revision) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_store_snapshot(jsonb,jsonb,jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_store_snapshot(jsonb,jsonb,jsonb,bigint) TO service_role;
CREATE FUNCTION public.fountain_cloud_store_commit(p_context jsonb,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_changes jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.store_commit(p_context,p_expected_revision,p_transaction_id,p_digest,p_canonical,p_changes) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_store_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_store_commit(jsonb,bigint,uuid,text,text,jsonb) TO service_role;

