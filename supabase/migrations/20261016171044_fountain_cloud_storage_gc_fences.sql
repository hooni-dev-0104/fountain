-- DRAFT ONLY. Requires backup manifest batches (20261016140754) and current
-- Auth/Store. No backfill, registration, physical I/O or existing data mutation.
CREATE TABLE fountain_cloud.storage_gc_tombstones(
 workspace_id text NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 160),
 storage_id text NOT NULL CHECK(length(storage_id) BETWEEN 1 AND 160),
 retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,storage_id)
);
ALTER TABLE fountain_cloud.storage_gc_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.storage_gc_tombstones FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.storage_gc_tombstones FROM PUBLIC,anon,authenticated,service_role;
-- These scalar predicates/expressions intentionally match storage_gc_fence.
-- Uploads already have (workspace_id,kind,id). Legacy SQL-backed attachments
-- without cloud_chunks are not Supabase references.
CREATE INDEX storage_pin_attachment ON fountain_private.entities(workspace_id,(COALESCE(data->>'storage_id',id))) WHERE kind='attachment' AND data ? 'cloud_chunks';
CREATE INDEX storage_pin_overlay ON fountain_private.entities(workspace_id,(COALESCE(data->>'storage_id',id))) WHERE kind='attachment_cloud';
CREATE INDEX storage_pin_source_extra ON fountain_cloud.backup_job_source(workspace_id,(COALESCE(extra->>'storage_id',extra->>'id',descriptor->>'id'))) WHERE extra ? 'cloud_chunks';
CREATE INDEX storage_pin_source_cloud ON fountain_cloud.backup_job_source(workspace_id,((cloud->>'attachmentId'))) WHERE cloud IS NOT NULL;
CREATE INDEX storage_pin_artifact ON fountain_cloud.backup_job_parts(workspace_id,((manifest->>'attachmentId'))) WHERE state IN('pending','published');

CREATE FUNCTION fountain_cloud.storage_gc_id(p_id text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT p_id IS NOT NULL AND length(p_id) BETWEEN 1 AND 160 AND p_id NOT IN('.','..') AND position('/' in p_id)=0 AND position(chr(92) in p_id)=0 AND p_id!~'[[:cntrl:]]'
$$;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_id(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.storage_gc_manifest(p_manifest jsonb,p_id text,p_offset bigint DEFAULT NULL,p_size bigint DEFAULT NULL,p_max integer DEFAULT 4194304) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_offset numeric;v_size numeric;
BEGIN
 IF p_max IS NULL OR p_max NOT BETWEEN 1 AND 4194304 OR NOT fountain_cloud.storage_gc_id(p_id) OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR octet_length(p_manifest::text)>2048
  OR NOT(p_manifest ?& ARRAY['version','attachmentId','offset','size','sha256']) OR p_manifest-ARRAY['version','attachmentId','offset','size','sha256']<>'{}'::jsonb
  OR p_manifest->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_manifest->'attachmentId') IS DISTINCT FROM 'string' OR p_manifest->>'attachmentId' IS DISTINCT FROM p_id
  OR jsonb_typeof(p_manifest->'offset') IS DISTINCT FROM 'number' OR jsonb_typeof(p_manifest->'size') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_manifest->'sha256') IS DISTINCT FROM 'string' OR (p_manifest->>'sha256')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid Storage reference' USING ERRCODE='PT409';END IF;
 v_offset:=(p_manifest->>'offset')::numeric;v_size:=(p_manifest->>'size')::numeric;
 IF v_offset<0 OR v_offset>=5000000000 OR v_offset<>trunc(v_offset) OR mod(v_offset,4194304)<>0
  OR v_size<=0 OR v_size>p_max OR v_size<>trunc(v_size) OR v_offset+v_size>5000000000
  OR(p_offset IS NOT NULL AND v_offset<>p_offset) OR(p_size IS NOT NULL AND v_size<>p_size) THEN RAISE EXCEPTION 'Invalid Storage reference' USING ERRCODE='PT409';END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_manifest(jsonb,text,bigint,bigint,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.storage_gc_layout(p_data jsonb,p_id text,p_partial boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_id text;v_total numeric;v_size bigint;v_count integer;v_index integer;v_end bigint:=0;v_offset numeric;
BEGIN
 IF p_partial IS NULL OR jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>16777216 OR jsonb_typeof(p_data->'id') IS DISTINCT FROM 'string' OR p_data->>'id' IS DISTINCT FROM p_id
  OR(p_data ? 'storage_id' AND p_data->'storage_id'<>'null'::jsonb AND jsonb_typeof(p_data->'storage_id') IS DISTINCT FROM 'string')
  OR jsonb_typeof(p_data->'size') IS DISTINCT FROM 'number' OR jsonb_typeof(p_data->'cloud_chunks') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid Storage layout' USING ERRCODE='PT409';END IF;
 v_id:=COALESCE(p_data->>'storage_id',p_id);IF NOT fountain_cloud.storage_gc_id(v_id) OR(p_partial AND v_id IS DISTINCT FROM p_id) THEN RAISE EXCEPTION 'Invalid Storage layout' USING ERRCODE='PT409';END IF;
 v_total:=(p_data->>'size')::numeric;IF v_total<0 OR v_total>5000000000 OR v_total<>trunc(v_total) THEN RAISE EXCEPTION 'Invalid Storage layout' USING ERRCODE='PT409';END IF;v_size:=v_total::bigint;
 v_count:=jsonb_array_length(p_data->'cloud_chunks');IF v_count>1193 OR v_count>ceil(v_size::numeric/4194304) OR(NOT p_partial AND v_count<>ceil(v_size::numeric/4194304)) THEN RAISE EXCEPTION 'Invalid Storage layout' USING ERRCODE='PT409';END IF;
 IF v_count>0 THEN FOR v_index IN 0..v_count-1 LOOP
  PERFORM fountain_cloud.storage_gc_manifest(p_data->'cloud_chunks'->v_index,v_id,v_index::bigint*4194304,least(4194304,v_size-v_index::bigint*4194304));
  v_end:=least(v_size,(v_index::bigint+1)*4194304);
 END LOOP;END IF;
 IF p_partial THEN
  IF jsonb_typeof(p_data->'offset') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid Storage layout' USING ERRCODE='PT409';END IF;
  v_offset:=(p_data->>'offset')::numeric;IF v_offset<>v_end THEN RAISE EXCEPTION 'Invalid Storage layout' USING ERRCODE='PT409';END IF;
 END IF;
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_layout(jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.storage_gc_reference(p_workspace_id text,p_storage_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR NOT fountain_cloud.storage_gc_id(p_storage_id) THEN RAISE EXCEPTION 'Invalid Storage reference' USING ERRCODE='PT409';END IF;
 -- Identical key to store_lock. BEFORE row triggers must NEVER block waiting
 -- for workspace ownership: an external writer can already hold a row lock.
 IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||p_workspace_id,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN RAISE EXCEPTION 'Storage reference is busy' USING ERRCODE='PT409';END IF;
 -- Do not set_config(fountain.workspace_id) here: changing a caller's RLS
 -- namespace from NEW.workspace_id could turn this definer trigger into a bypass.
 IF EXISTS(SELECT 1 FROM fountain_cloud.storage_gc_tombstones t WHERE t.workspace_id=p_workspace_id AND t.storage_id=p_storage_id) THEN RAISE EXCEPTION 'Storage identity is retired' USING ERRCODE='PT409';END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_reference(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.storage_gc_entity_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_id text;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'entities' THEN RAISE EXCEPTION 'Invalid Storage trigger' USING ERRCODE='PT409';END IF;
 IF NEW.kind='upload' THEN
  IF jsonb_typeof(NEW.data) IS DISTINCT FROM 'object' OR octet_length(NEW.data::text)>16777216 OR jsonb_typeof(NEW.data->'id') IS DISTINCT FROM 'string' OR NEW.data->>'id' IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Invalid Storage upload' USING ERRCODE='PT409';END IF;
  IF NEW.data ? 'storage_id' AND NEW.data->'storage_id'<>'null'::jsonb AND(jsonb_typeof(NEW.data->'storage_id') IS DISTINCT FROM 'string' OR NEW.data->>'storage_id' IS DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'Invalid Storage upload identity' USING ERRCODE='PT409';END IF;
  -- Legacy SQL uploads remain conservative pins but have no cloud layout.
  IF NEW.data ? 'cloud_chunks' THEN v_id:=fountain_cloud.storage_gc_layout(NEW.data,NEW.id,true);ELSE v_id:=NEW.id;END IF;
 ELSIF NEW.kind='attachment_cloud' OR(NEW.kind='attachment' AND NEW.data ? 'cloud_chunks') THEN v_id:=fountain_cloud.storage_gc_layout(NEW.data,NEW.id,false);
 ELSE RETURN NEW;END IF;
 PERFORM fountain_cloud.storage_gc_reference(NEW.workspace_id,v_id);RETURN NEW;
END $$;
ALTER FUNCTION fountain_cloud.storage_gc_entity_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_entity_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fountain_storage_gc_entity BEFORE INSERT OR UPDATE ON fountain_private.entities FOR EACH ROW EXECUTE FUNCTION fountain_cloud.storage_gc_entity_event();

CREATE FUNCTION fountain_cloud.storage_gc_source_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_id text;v_value numeric;v_offset bigint;v_size bigint;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_cloud' OR TG_TABLE_NAME<>'backup_job_source' THEN RAISE EXCEPTION 'Invalid Storage trigger' USING ERRCODE='PT409';END IF;
 IF NEW.extra ? 'cloud_chunks' THEN
  IF NEW.table_name<>'entities' OR jsonb_typeof(NEW.descriptor->'id') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid backup Storage source' USING ERRCODE='PT409';END IF;
  v_id:=fountain_cloud.storage_gc_layout(NEW.extra,NEW.descriptor->>'id',false);PERFORM fountain_cloud.storage_gc_reference(NEW.workspace_id,v_id);
 END IF;
 IF NEW.cloud IS NOT NULL AND NEW.cloud<>'null'::jsonb THEN
  IF NEW.table_name<>'attachment_chunks' OR jsonb_typeof(NEW.descriptor->'offset') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.descriptor->'data'->'size') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid backup Storage source' USING ERRCODE='PT409';END IF;
  v_value:=(NEW.descriptor->>'offset')::numeric;IF v_value<0 OR v_value>=5000000000 OR v_value<>trunc(v_value) THEN RAISE EXCEPTION 'Invalid backup Storage source' USING ERRCODE='PT409';END IF;v_offset:=v_value::bigint;
  v_value:=(NEW.descriptor->'data'->>'size')::numeric;IF v_value<=0 OR v_value>4194304 OR v_value<>trunc(v_value) THEN RAISE EXCEPTION 'Invalid backup Storage source' USING ERRCODE='PT409';END IF;v_size:=v_value::bigint;
  v_id:=NEW.cloud->>'attachmentId';PERFORM fountain_cloud.storage_gc_manifest(NEW.cloud,v_id,v_offset,v_size);PERFORM fountain_cloud.storage_gc_reference(NEW.workspace_id,v_id);
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION fountain_cloud.storage_gc_source_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_source_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fountain_storage_gc_source BEFORE INSERT OR UPDATE ON fountain_cloud.backup_job_source FOR EACH ROW EXECUTE FUNCTION fountain_cloud.storage_gc_source_event();

CREATE FUNCTION fountain_cloud.storage_gc_part_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_id text;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_cloud' OR TG_TABLE_NAME<>'backup_job_parts' THEN RAISE EXCEPTION 'Invalid Storage trigger' USING ERRCODE='PT409';END IF;
 -- gc/removed release their references and must work after the ID was retired.
 IF NEW.state NOT IN('pending','published') THEN RETURN NEW;END IF;
 v_id:=NEW.manifest->>'attachmentId';PERFORM fountain_cloud.storage_gc_manifest(NEW.manifest,v_id,0,NULL,262144);
 IF v_id IS DISTINCT FROM 'backup-'||NEW.job_id||'-'||NEW.id THEN RAISE EXCEPTION 'Invalid backup Storage identity' USING ERRCODE='PT409';END IF;
 IF mod(((NEW.manifest->>'size')::numeric)::bigint,4096)<>0 THEN RAISE EXCEPTION 'Invalid backup Storage part' USING ERRCODE='PT409';END IF;
 PERFORM fountain_cloud.storage_gc_reference(NEW.workspace_id,v_id);RETURN NEW;
END $$;
ALTER FUNCTION fountain_cloud.storage_gc_part_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_part_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fountain_storage_gc_part BEFORE INSERT OR UPDATE ON fountain_cloud.backup_job_parts FOR EACH ROW EXECUTE FUNCTION fountain_cloud.storage_gc_part_event();

-- Read-only helpers do not establish authority or acquire locks. Only a private
-- caller already holding current human/maintenance authority + store_lock may
-- use delete_allowed as its current physical-delete proof.
CREATE FUNCTION fountain_cloud.storage_gc_pinned(p_workspace_id text,p_storage_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR NOT fountain_cloud.storage_gc_id(p_storage_id) THEN RAISE EXCEPTION 'Invalid Storage identity' USING ERRCODE='PT409';END IF;
 -- Never expand a chunk array here. Consistent IDs are validated on writes.
 RETURN EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='upload' AND e.id=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='attachment' AND e.data ? 'cloud_chunks' AND COALESCE(e.data->>'storage_id',e.id)=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='attachment_cloud' AND COALESCE(e.data->>'storage_id',e.id)=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=p_workspace_id AND s.extra ? 'cloud_chunks' AND COALESCE(s.extra->>'storage_id',s.extra->>'id',s.descriptor->>'id')=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=p_workspace_id AND s.cloud IS NOT NULL AND s.cloud->>'attachmentId'=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_parts p WHERE p.workspace_id=p_workspace_id AND p.state IN('pending','published') AND p.manifest->>'attachmentId'=p_storage_id);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_pinned(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.storage_gc_delete_allowed(p_workspace_id text,p_storage_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR NOT fountain_cloud.storage_gc_id(p_storage_id) THEN RAISE EXCEPTION 'Invalid Storage identity' USING ERRCODE='PT409';END IF;
 RETURN EXISTS(SELECT 1 FROM fountain_cloud.storage_gc_tombstones t WHERE t.workspace_id=p_workspace_id AND t.storage_id=p_storage_id)
  AND NOT fountain_cloud.storage_gc_pinned(p_workspace_id,p_storage_id);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_delete_allowed(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.storage_gc_fence(p_workspace_id text,p_storage_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR NOT fountain_cloud.storage_gc_id(p_storage_id) THEN RAISE EXCEPTION 'Invalid Storage identity' USING ERRCODE='PT409';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);
 -- Even an already-retired ID must reject any surviving current reference.
 IF fountain_cloud.storage_gc_pinned(p_workspace_id,p_storage_id) THEN RAISE EXCEPTION 'Storage identity is referenced' USING ERRCODE='PT409';END IF;
 INSERT INTO fountain_cloud.storage_gc_tombstones(workspace_id,storage_id) VALUES(p_workspace_id,p_storage_id) ON CONFLICT(workspace_id,storage_id) DO NOTHING;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.storage_gc_fence(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.upload_gc_fence(p_context jsonb,p_id text,p_manifests jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_actor jsonb;v_ws text;v_gc jsonb;v_count integer;v_total integer;v_index integer;v_previous bigint:=-1;v_offset bigint;
BEGIN
 v_actor:=fountain_cloud.store_context(p_context);v_ws:=p_context->>'workspaceId';
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF NOT fountain_cloud.storage_gc_id(p_id) THEN RAISE EXCEPTION 'Invalid cleanup batch' USING ERRCODE='PT409';END IF;
 SELECT e.data INTO v_gc FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='upload_gc' AND e.id=p_id FOR UPDATE;
 IF NOT FOUND OR(v_actor->>'role' IS DISTINCT FROM 'owner' AND(jsonb_typeof(v_gc->'owner_id') IS DISTINCT FROM 'string' OR v_gc->'owner_id' IS DISTINCT FROM to_jsonb(v_actor->>'id'))) THEN RAISE EXCEPTION 'Cleanup not found' USING ERRCODE='PT404';END IF;
 IF jsonb_typeof(v_gc) IS DISTINCT FROM 'object' OR jsonb_typeof(v_gc->'id') IS DISTINCT FROM 'string' OR v_gc->>'id' IS DISTINCT FROM p_id OR octet_length(v_gc::text)>16777216 OR COALESCE(v_gc->'pending','null'::jsonb)<>'null'::jsonb
  OR jsonb_typeof(v_gc->'cloud_chunks') IS DISTINCT FROM 'array' OR jsonb_typeof(p_manifests) IS DISTINCT FROM 'array' OR octet_length(p_manifests::text)>131072 THEN RAISE EXCEPTION 'Cleanup publication is unresolved' USING ERRCODE='PT409';END IF;
 v_total:=jsonb_array_length(v_gc->'cloud_chunks');v_count:=jsonb_array_length(p_manifests);
 IF v_total NOT BETWEEN 1 AND 1193 OR v_count<>least(100,v_total) THEN RAISE EXCEPTION 'Cleanup batch changed' USING ERRCODE='PT409';END IF;
 FOR v_index IN 0..v_count-1 LOOP
  IF p_manifests->v_index IS DISTINCT FROM v_gc->'cloud_chunks'->v_index THEN RAISE EXCEPTION 'Cleanup batch changed' USING ERRCODE='PT409';END IF;
  PERFORM fountain_cloud.storage_gc_manifest(p_manifests->v_index,p_id);
  v_offset:=((p_manifests->v_index->>'offset')::numeric)::bigint;IF v_offset<=v_previous THEN RAISE EXCEPTION 'Invalid cleanup order' USING ERRCODE='PT409';END IF;v_previous:=v_offset;
 END LOOP;
 PERFORM fountain_cloud.storage_gc_fence(v_ws,p_id);
 RETURN jsonb_build_object('allowed',true);
END $$;
ALTER FUNCTION fountain_cloud.upload_gc_fence(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.upload_gc_fence(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fountain_cloud_upload_gc_fence(p_context jsonb,p_id text,p_manifests jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.upload_gc_fence(p_context,p_id,p_manifests) $$;
ALTER FUNCTION public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_upload_gc_fence(jsonb,text,jsonb) TO service_role;
