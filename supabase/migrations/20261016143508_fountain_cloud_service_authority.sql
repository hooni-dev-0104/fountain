-- Service authority primitives; no grants/tickets or Cron/SCIM entry are installed.
-- Requires the current Auth/atomic-store/accounts/reservation migrations.
-- Server-role wrappers authorize real service grants. This is NOT client RLS.
-- Review/apply as a NEW migration; never modify an applied snapshot.

CREATE TABLE fountain_cloud.service_grants (
 workspace_id text NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 160),
 id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('automation','scim','backup-gc','upload-gc')),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 enabled boolean NOT NULL DEFAULT true,
 member_id text,
 -- Keep the immutable user ID without a foreign key: an existing Admin user
 -- deletion must not be blocked by historical service grants/receipts. Live joins deny it.
 auth_user_id uuid,
 resource_id text,
 token_hash text CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 CHECK((purpose='scim' AND member_id IS NOT NULL AND auth_user_id IS NOT NULL AND resource_id IS NULL AND token_hash IS NOT NULL)
  OR(purpose='automation' AND member_id IS NOT NULL AND auth_user_id IS NOT NULL AND resource_id IS NOT NULL AND token_hash IS NULL)
  OR(purpose IN('backup-gc','upload-gc') AND member_id IS NULL AND auth_user_id IS NULL AND resource_id IS NULL AND token_hash IS NULL)),
 CHECK(member_id IS NULL OR length(member_id) BETWEEN 1 AND 160),
 CHECK(resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 160)
);
CREATE TABLE fountain_cloud.service_leases (
 workspace_id text NOT NULL,
 grant_id uuid NOT NULL,
 id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 ticket_hash text NOT NULL CHECK(ticket_hash ~ '^[a-f0-9]{64}$'),
 run_id text CHECK(run_id ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 closed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,grant_id,id),
 FOREIGN KEY(workspace_id,grant_id) REFERENCES fountain_cloud.service_grants(workspace_id,id),
 UNIQUE(ticket_hash)
);
CREATE TABLE fountain_cloud.service_commit_receipts (
 workspace_id text NOT NULL,
 grant_id uuid NOT NULL,
 authority_hash text NOT NULL CHECK(authority_hash ~ '^[a-f0-9]{64}$'),
 transaction_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 0 AND 9007199254740991),
 result_revision bigint NOT NULL CHECK(result_revision BETWEEN expected_revision AND 9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,grant_id,authority_hash,transaction_id),
 FOREIGN KEY(workspace_id,grant_id) REFERENCES fountain_cloud.service_grants(workspace_id,id)
);
ALTER TABLE fountain_cloud.service_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.service_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.service_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.service_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.service_commit_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.service_commit_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.service_grants,fountain_cloud.service_leases,fountain_cloud.service_commit_receipts FROM PUBLIC,anon,authenticated,service_role;

-- No human SID/session hash/cache binding exists in this contract. Locks survive
-- the RPC; later revocation/demotion/unlink cannot race an already authorized write.
CREATE FUNCTION fountain_cloud.service_context(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_keys text[];v_kind text;v_ws text;v_now timestamptz:=clock_timestamp();
 v_grant fountain_cloud.service_grants;v_lease fountain_cloud.service_leases;v_member jsonb;
BEGIN
 IF jsonb_typeof(p_context) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid service context' USING ERRCODE='22023';END IF;
 v_kind:=p_context->>'kind';
 IF v_kind='scim' THEN v_keys:=ARRAY['kind','workspaceId','grantId','grantVersion','memberId','tokenHash'];
 ELSIF v_kind='automation' THEN v_keys:=ARRAY['kind','workspaceId','grantId','grantVersion','memberId','resourceId','runId','leaseId','generation','ticketHash'];
 ELSIF v_kind='maintenance' THEN v_keys:=ARRAY['kind','workspaceId','grantId','grantVersion','purpose','leaseId','generation','ticketHash'];
 ELSE RAISE EXCEPTION 'Invalid service context' USING ERRCODE='22023';END IF;
 IF NOT(p_context ?& v_keys) OR p_context-v_keys<>'{}'::jsonb
  OR EXISTS(SELECT 1 FROM jsonb_each(p_context) j WHERE j.key NOT IN('grantVersion','generation') AND jsonb_typeof(j.value) IS DISTINCT FROM 'string')
  OR length(p_context->>'workspaceId') NOT BETWEEN 1 AND 160
  OR (p_context->>'grantId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_context->'grantVersion') IS DISTINCT FROM 'number' OR (p_context->>'grantVersion')!~'^[1-9][0-9]{0,15}$'
  OR (p_context->>'grantVersion')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Invalid service context' USING ERRCODE='22023';END IF;
 IF v_kind='scim' THEN
  IF length(p_context->>'memberId') NOT BETWEEN 1 AND 160 OR (p_context->>'tokenHash')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid service context' USING ERRCODE='22023';END IF;
 ELSE
  IF (p_context->>'leaseId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(p_context->'generation') IS DISTINCT FROM 'number' OR (p_context->>'generation')!~'^[1-9][0-9]{0,15}$'
   OR (p_context->>'generation')::numeric>9007199254740991 OR (p_context->>'ticketHash')!~'^[a-f0-9]{64}$'
   OR v_kind='automation' AND(length(p_context->>'memberId') NOT BETWEEN 1 AND 160 OR length(p_context->>'resourceId') NOT BETWEEN 1 AND 160 OR (p_context->>'runId')!~'^[a-f0-9]{64}$')
   OR v_kind='maintenance' AND (p_context->>'purpose') NOT IN('backup-gc','upload-gc') THEN RAISE EXCEPTION 'Invalid service context' USING ERRCODE='22023';END IF;
 END IF;
 v_ws:=p_context->>'workspaceId';PERFORM fountain_cloud.store_lock(v_ws);PERFORM set_config('fountain.workspace_id',v_ws,true);v_now:=clock_timestamp();
 SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g
 WHERE g.workspace_id=v_ws AND g.id=(p_context->>'grantId')::uuid AND g.version=(p_context->>'grantVersion')::bigint
  AND g.enabled AND(g.expires_at IS NULL OR g.expires_at>v_now)
  AND g.purpose=CASE WHEN v_kind='maintenance' THEN p_context->>'purpose' ELSE v_kind END
 FOR SHARE OF g;
 IF NOT FOUND THEN RAISE EXCEPTION 'Service authorization required' USING ERRCODE='PT401';END IF;
 IF v_kind='scim' THEN
  IF v_grant.token_hash IS DISTINCT FROM p_context->>'tokenHash' THEN RAISE EXCEPTION 'Service authorization required' USING ERRCODE='PT401';END IF;
 ELSE
  SELECT l.* INTO v_lease FROM fountain_cloud.service_leases l
  WHERE l.workspace_id=v_ws AND l.grant_id=v_grant.id AND l.id=(p_context->>'leaseId')::uuid
   AND l.generation=(p_context->>'generation')::bigint AND l.ticket_hash=p_context->>'ticketHash'
   AND NOT l.closed AND l.expires_at>v_now FOR SHARE OF l;
  IF NOT FOUND OR v_kind='automation' AND v_lease.run_id IS DISTINCT FROM p_context->>'runId'
   OR v_kind='maintenance' AND v_lease.run_id IS NOT NULL THEN RAISE EXCEPTION 'Service authorization required' USING ERRCODE='PT401';END IF;
 END IF;
 -- Maintenance deliberately has no principal and cannot use data snapshot/commit.
 IF v_kind='maintenance' THEN RETURN NULL;END IF;
 IF v_grant.member_id IS DISTINCT FROM p_context->>'memberId'
  OR v_kind='automation' AND v_grant.resource_id IS DISTINCT FROM p_context->>'resourceId' THEN RAISE EXCEPTION 'Service authorization required' USING ERRCODE='PT401';END IF;
 SELECT e.data INTO v_member FROM fountain_private.entities e
 JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id
 JOIN auth.users u ON u.id=m.auth_user_id
 WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id=v_grant.member_id AND e.data->>'id'=e.id
  AND jsonb_typeof(e.data->'id')='string' AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
  AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
  AND e.data->>'role' IN('owner','admin','member','guest') AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
  AND u.id=v_grant.auth_user_id AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
  AND(u.banned_until IS NULL OR u.banned_until<=v_now)
 FOR SHARE OF e,m,u;
 IF NOT FOUND OR v_kind='scim' AND v_member->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Service authorization required' USING ERRCODE='PT401';END IF;
 IF v_kind='automation' THEN
  PERFORM 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation' AND e.id=v_grant.resource_id
   AND jsonb_typeof(e.data->'id')='string' AND e.data->>'id'=e.id
   AND jsonb_typeof(e.data->'owner_id')='string' AND e.data->>'owner_id'=v_grant.member_id FOR SHARE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service authorization required' USING ERRCODE='PT401';END IF;
 END IF;
 RETURN jsonb_build_object('id',v_member->>'id','name',v_member->>'name','email',v_member->>'email','role',v_member->>'role','active',true);
END $$;
ALTER FUNCTION fountain_cloud.service_context(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.service_context(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Both callers must hold store_lock and authorize BEFORE calling these private
-- helpers. No public/client role can invoke the locked kernels independently.
CREATE FUNCTION fountain_cloud.store_apply_changes_locked(p_workspace_id text,p_expected_revision bigint,p_changes jsonb) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text:=p_workspace_id;v_revision bigint;v_change jsonb;v_previous fountain_private.entities;
 v_found_previous boolean;v_affected bigint;v_data jsonb;v_change_kind text;v_change_id text;v_meta_key text;v_steps bigint:=0;v_owner_mutated boolean:=false;
BEGIN
 v_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
 IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 FOR v_change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  IF jsonb_typeof(v_change) IS DISTINCT FROM 'object' OR jsonb_typeof(v_change->'op') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023';
  END IF;
  IF v_change->>'op' IN ('put','delete') THEN
   v_change_kind:=v_change->>'kind';v_change_id:=v_change->>'id';
   IF jsonb_typeof(v_change->'kind') IS DISTINCT FROM 'string' OR v_change_kind !~ '^[a-z][a-z0-9_]{0,63}$' OR v_change_kind IN ('credential','session')
    OR jsonb_typeof(v_change->'id') IS DISTINCT FROM 'string' OR length(v_change_id) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023';
   END IF;
   IF v_change_kind='member' AND EXISTS(SELECT 1 FROM fountain_private.entities e
     WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id=v_change_id AND e.data->>'role'='owner') THEN
    v_owner_mutated:=true;
   END IF;
   IF v_change->>'op'='put' THEN
    IF NOT(v_change ?& ARRAY['op','kind','id','data','previousCreatedAt']) OR v_change-ARRAY['op','kind','id','data','previousCreatedAt']<>'{}'::jsonb
     OR jsonb_typeof(v_change->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    v_data:=v_change->'data';
    IF btrim(v_change_id)='' OR v_data->>'id' IS DISTINCT FROM v_change_id OR jsonb_typeof(v_data->'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_data->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v_data->'updated_at') IS DISTINCT FROM 'string'
     OR length(v_data->>'created_at') NOT BETWEEN 1 AND 64 OR length(v_data->>'updated_at') NOT BETWEEN 1 AND 64
     OR v_change_kind='attachment' AND v_data ? 'data' THEN RAISE EXCEPTION 'Invalid entity data' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_previous FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    v_found_previous:=FOUND;
    IF (v_found_previous AND (v_change->'previousCreatedAt' IS DISTINCT FROM to_jsonb(v_previous.created_at) OR v_data->>'created_at' IS DISTINCT FROM v_previous.created_at))
     OR (NOT v_found_previous AND v_change->'previousCreatedAt' IS DISTINCT FROM 'null'::jsonb) THEN
     RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
    END IF;
    INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at)
    VALUES(v_ws,v_change_kind,v_change_id,v_data,v_data->>'created_at',v_data->>'updated_at')
    ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at;
    v_steps:=v_steps+1;
   ELSE
    IF NOT(v_change ?& ARRAY['op','kind','id']) OR v_change-ARRAY['op','kind','id']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    DELETE FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    GET DIAGNOSTICS v_affected=ROW_COUNT;v_steps:=v_steps+v_affected;
   END IF;
  ELSIF v_change->>'op'='meta' THEN
   v_meta_key:=v_change->>'key';
   IF NOT(v_change ?& ARRAY['op','key','value']) OR v_change-ARRAY['op','key','value']<>'{}'::jsonb
    OR jsonb_typeof(v_change->'key') IS DISTINCT FROM 'string' OR length(v_meta_key) NOT BETWEEN 1 AND 160
    OR v_meta_key IN ('_entity_revision','local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved')
    OR v_meta_key='workspace_id' AND v_change->'value' IS DISTINCT FROM to_jsonb(v_ws) THEN RAISE EXCEPTION 'Invalid metadata change' USING ERRCODE='22023'; END IF;
   INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,v_meta_key,v_change->'value')
   ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
   v_steps:=v_steps+1;
  ELSE RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Evaluate the final transaction state, including multi-member changes.
 -- Legacy password hashes never prove that a Supabase owner can log in.
 IF v_owner_mutated THEN
  PERFORM 1 FROM fountain_private.entities e
   JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id
   JOIN auth.users u ON u.id=m.auth_user_id
   WHERE e.workspace_id=v_ws AND e.kind='member' AND e.data->>'id'=e.id AND e.data->>'role'='owner'
    AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
    AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
    AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
    AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
    AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   ORDER BY u.id FOR SHARE OF e,m,u;
  IF NOT FOUND THEN RAISE EXCEPTION 'LAST_OWNER_ACCOUNT' USING ERRCODE='PT409'; END IF;
 END IF;
 IF v_revision+v_steps>9007199254740991 THEN RAISE EXCEPTION 'Revision limit exceeded' USING ERRCODE='PT413'; END IF;
 v_revision:=v_revision+v_steps;
 IF v_steps>0 THEN
  INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,'_entity_revision',to_jsonb(v_revision))
  ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 END IF;
 RETURN v_revision;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.store_apply_changes_locked(text,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION fountain_cloud.store_commit(p_context jsonb, p_expected_revision bigint, p_transaction_id uuid, p_digest text, p_canonical text, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE ws text;actor_id text;revision bigint;recorded fountain_cloud.store_commit_receipts;
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
 revision:=fountain_cloud.store_apply_changes_locked(ws,p_expected_revision,p_changes);
 INSERT INTO fountain_cloud.store_commit_receipts(workspace_id,member_id,session_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(ws,actor_id,p_context->>'sessionHash',p_transaction_id,p_digest,p_expected_revision,revision);
 RETURN jsonb_build_object('revision',revision);
END $function$;

CREATE FUNCTION fountain_cloud.store_snapshot_locked(p_context jsonb,p_principal jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal jsonb; ws text; revision bigint; access_revision bigint; scope text; item record;
 result jsonb; records jsonb[]:=ARRAY[]::jsonb[]; metas jsonb; dto jsonb; following jsonb:=NULL;
 last_kind text;last_created text;last_id text;count integer:=0;total_bytes bigint;page_size integer;
BEGIN
 principal:=p_principal;ws:=p_context->>'workspaceId';
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
REVOKE ALL ON FUNCTION fountain_cloud.store_snapshot_locked(jsonb,jsonb,jsonb,jsonb,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION fountain_cloud.store_snapshot(p_context jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_principal jsonb;
BEGIN
 v_principal:=fountain_cloud.store_context(p_context);
 RETURN fountain_cloud.store_snapshot_locked(p_context,v_principal,p_selection,p_cursor,p_expected_revision);
END $$;

-- Business readiness gates NEW work, not a previously committed exact ACK:
-- a successful scheduled run may disable itself before its response is received.
CREATE FUNCTION fountain_cloud.service_data_ready(p_context jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF p_context->>'kind'='automation' THEN
  PERFORM 1 FROM fountain_private.entities e WHERE e.workspace_id=p_context->>'workspaceId' AND e.kind='automation' AND e.id=p_context->>'resourceId'
   AND e.data->>'trigger'='scheduled' AND COALESCE(e.data->'enabled','true'::jsonb)='true'::jsonb FOR SHARE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.service_data_ready(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Purpose checks are defense in depth around trusted pure handlers. They do NOT
-- replace current Access/Authorization and SCIM deprovision/revocation workflows.
CREATE FUNCTION fountain_cloud.service_changes(p_context jsonb,p_changes jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_change jsonb;v_old jsonb;v_kind text:=p_context->>'kind';
BEGIN
 FOR v_change IN SELECT x.value FROM jsonb_array_elements(p_changes) x LOOP
  IF v_change->>'op'='meta' THEN
   IF v_kind<>'scim' OR v_change->>'key'<>'access_revision' THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
  ELSIF v_kind='automation' THEN
   IF v_change->>'kind' NOT IN('page','row','version','collaboration','automation','automation_run','audit') THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
   IF v_change->>'kind'='automation' THEN
    SELECT e.data INTO v_old FROM fountain_private.entities e WHERE e.workspace_id=p_context->>'workspaceId' AND e.kind='automation' AND e.id=p_context->>'resourceId';
    IF v_change->>'op'<>'put' OR v_change->>'id' IS DISTINCT FROM p_context->>'resourceId'
     OR (v_change->'data')-ARRAY['updated_at','next_run_at','last_run_at','last_run_status','last_error','schedule_status','enabled'] IS DISTINCT FROM
       v_old-ARRAY['updated_at','next_run_at','last_run_at','last_run_status','last_error','schedule_status','enabled']
     OR (v_change->'data'->'enabled') NOT IN('true'::jsonb,'false'::jsonb) THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
   ELSIF v_change->>'kind'='automation_run' THEN
    IF v_change->>'op'<>'put' OR v_change->>'id' IS DISTINCT FROM p_context->>'runId'
     OR v_change->'data'->>'automation_id' IS DISTINCT FROM p_context->>'resourceId' THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
   END IF;
  ELSIF v_kind='scim' THEN
   IF v_change->>'kind' NOT IN('member','group','teamspace','page','database','row','audit') THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
  ELSE RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.service_changes(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.service_snapshot(p_context jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_principal jsonb;
BEGIN
 v_principal:=fountain_cloud.service_context(p_context);
 IF v_principal IS NULL THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
 PERFORM fountain_cloud.service_data_ready(p_context);
 RETURN fountain_cloud.store_snapshot_locked(p_context,v_principal,p_selection,p_cursor,p_expected_revision);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.service_snapshot(jsonb,jsonb,jsonb,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.service_commit(p_context jsonb,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_principal jsonb;v_ws text;v_scope text;v_recorded fountain_cloud.service_commit_receipts;v_revision bigint;
BEGIN
 -- Revoke/expiry/current member/current lease checks precede even exact replay.
 v_principal:=fountain_cloud.service_context(p_context);
 IF v_principal IS NULL THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
 v_ws:=p_context->>'workspaceId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_transaction_id IS NULL
  OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>16777216
  OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid commit' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_changes)>1000 OR octet_length(p_changes::text)>16777216 THEN RAISE EXCEPTION 'Commit limit exceeded' USING ERRCODE='PT413';END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest
  OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes) THEN RAISE EXCEPTION 'Invalid commit digest' USING ERRCODE='22023';END IF;
 v_scope:=encode(sha256(convert_to(p_context::text,'UTF8')),'hex');
 SELECT r.* INTO v_recorded FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=(p_context->>'grantId')::uuid
  AND r.authority_hash=v_scope AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF v_recorded.digest<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409';END IF;
  RETURN jsonb_build_object('revision',v_recorded.result_revision);
 END IF;
 PERFORM fountain_cloud.service_data_ready(p_context);
 PERFORM fountain_cloud.service_changes(p_context,p_changes);
 v_revision:=fountain_cloud.store_apply_changes_locked(v_ws,p_expected_revision,p_changes);
 INSERT INTO fountain_cloud.service_commit_receipts(workspace_id,grant_id,authority_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(v_ws,(p_context->>'grantId')::uuid,v_scope,p_transaction_id,p_digest,p_expected_revision,v_revision);
 RETURN jsonb_build_object('revision',v_revision);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.service_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fountain_cloud_service_snapshot(p_context jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.service_snapshot(p_context,p_selection,p_cursor,p_expected_revision) $$;
CREATE FUNCTION public.fountain_cloud_service_commit(p_context jsonb,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_changes jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.service_commit(p_context,p_expected_revision,p_transaction_id,p_digest,p_canonical,p_changes) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_service_snapshot(jsonb,jsonb,jsonb,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fountain_cloud_service_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_service_snapshot(jsonb,jsonb,jsonb,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_service_commit(jsonb,bigint,uuid,text,text,jsonb) TO service_role;

