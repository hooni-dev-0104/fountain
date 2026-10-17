-- Private retention foundation only. No data migration, public RPC, automatic
-- archival or purge. Full trusted backup v3 must be provisioned before activation.
CREATE TABLE fountain_private.retention_records (
 workspace_id text NOT NULL,
 "id" text NOT NULL,
 "data" text NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL,
 PRIMARY KEY("workspace_id","id")
);
ALTER TABLE fountain_private.retention_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.retention_records FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.retention_records FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.retention_records TO fountain_backend;
CREATE POLICY retention_records_workspace ON fountain_private.retention_records FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
CREATE TABLE fountain_private.retention_entities (
 workspace_id text NOT NULL,
 "record_id" text NOT NULL,
 "kind" text NOT NULL,
 "id" text NOT NULL,
 "data" text NOT NULL,
 "created_at" text NOT NULL,
 "updated_at" text NOT NULL,
 "generation" text,
 "ownership" text NOT NULL,
 PRIMARY KEY("workspace_id","record_id","kind","id")
);
ALTER TABLE fountain_private.retention_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.retention_entities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.retention_entities FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.retention_entities TO fountain_backend;
CREATE POLICY retention_entities_workspace ON fountain_private.retention_entities FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.retention_entities ADD FOREIGN KEY(workspace_id,record_id) REFERENCES fountain_private.retention_records(workspace_id,id) ON DELETE CASCADE;
CREATE TABLE fountain_private.retention_provenance (
 workspace_id text NOT NULL,
 "record_id" text NOT NULL,
 "kind" text NOT NULL,
 "id" text NOT NULL,
 "generation" text NOT NULL,
 "creator_id" text,
 "creator_cause" text NOT NULL,
 "editor_id" text,
 "edited_at" text,
 "editor_cause" text NOT NULL,
 "manager_id" text,
 "manager_at" text,
 PRIMARY KEY("workspace_id","record_id","kind","id")
);
ALTER TABLE fountain_private.retention_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.retention_provenance FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.retention_provenance FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.retention_provenance TO fountain_backend;
CREATE POLICY retention_provenance_workspace ON fountain_private.retention_provenance FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.retention_provenance ADD FOREIGN KEY(workspace_id,record_id) REFERENCES fountain_private.retention_records(workspace_id,id) ON DELETE CASCADE;
CREATE TABLE fountain_private.retention_attachment_refs (
 workspace_id text NOT NULL,
 "record_id" text NOT NULL,
 "attachment_id" text NOT NULL,
 "storage_kind" text NOT NULL,
 "physical_id" text NOT NULL,
 "offset" bigint NOT NULL,
 "size" bigint NOT NULL,
 "sha256" text NOT NULL,
 PRIMARY KEY("workspace_id","record_id","attachment_id","storage_kind","physical_id","offset")
);
ALTER TABLE fountain_private.retention_attachment_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.retention_attachment_refs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.retention_attachment_refs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.retention_attachment_refs TO fountain_backend;
CREATE POLICY retention_attachment_refs_workspace ON fountain_private.retention_attachment_refs FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.retention_attachment_refs ADD FOREIGN KEY(workspace_id,record_id) REFERENCES fountain_private.retention_records(workspace_id,id) ON DELETE CASCADE;
CREATE TABLE fountain_private.retention_identity_reservations (
 workspace_id text NOT NULL,
 "kind" text NOT NULL,
 "id" text NOT NULL,
 "record_id" text NOT NULL,
 "generation" text NOT NULL,
 PRIMARY KEY("workspace_id","kind","id")
);
ALTER TABLE fountain_private.retention_identity_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.retention_identity_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.retention_identity_reservations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.retention_identity_reservations TO fountain_backend;
CREATE POLICY retention_identity_reservations_workspace ON fountain_private.retention_identity_reservations FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.retention_identity_reservations ADD FOREIGN KEY(workspace_id,record_id) REFERENCES fountain_private.retention_records(workspace_id,id) ON DELETE CASCADE;
CREATE TABLE fountain_private.retention_links (
 workspace_id text NOT NULL,
 "record_id" text NOT NULL,
 "kind" text NOT NULL,
 "id" text NOT NULL,
 "data" text NOT NULL,
 PRIMARY KEY("workspace_id","record_id","kind","id")
);
ALTER TABLE fountain_private.retention_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.retention_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.retention_links FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON fountain_private.retention_links TO fountain_backend;
CREATE POLICY retention_links_workspace ON fountain_private.retention_links FOR ALL TO fountain_backend
 USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true)))
 WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.retention_links ADD FOREIGN KEY(workspace_id,record_id) REFERENCES fountain_private.retention_records(workspace_id,id) ON DELETE CASCADE;
CREATE INDEX retention_physical_pin ON fountain_private.retention_attachment_refs(workspace_id,storage_kind,physical_id);
CREATE INDEX retention_logical_pin ON fountain_private.retention_attachment_refs(workspace_id,attachment_id);

GRANT USAGE ON SCHEMA fountain_cloud TO fountain_backend;

CREATE FUNCTION fountain_private.retention_id(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT p_value IS NOT NULL AND length(p_value) BETWEEN 1 AND 160 AND btrim(p_value)<>''
$$;
CREATE FUNCTION fountain_private.retention_stamp(p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE d timestamptz;
BEGIN
 IF p_value IS NULL OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  OR substring(p_value,1,4)='0000' OR substring(p_value,12,2)::integer>23 OR substring(p_value,15,2)::integer>59 OR substring(p_value,18,2)::integer>59 THEN RAISE EXCEPTION 'Invalid retention time' USING ERRCODE='22023';END IF;
 BEGIN d:=p_value::timestamptz;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid retention time' USING ERRCODE='22023';END;
 IF extract(year FROM d AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999 THEN RAISE EXCEPTION 'Invalid retention time' USING ERRCODE='22023';END IF;
 RETURN to_char(d AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00';
END $$;
-- Reference extraction is typed for row properties. Other owned document
-- records may carry nested CRDT block attachment references, including tombstones.
CREATE FUNCTION fountain_private.retention_references(p_kind text,p_data jsonb,p_database jsonb DEFAULT NULL) RETURNS SETOF text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v jsonb;p jsonb;
BEGIN
 IF p_kind='row' THEN
  FOR p IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_database->'properties')='array' THEN p_database->'properties' ELSE '[]'::jsonb END) LOOP
   IF p->>'type'='files' THEN
    v:=p_data->'properties'->(p->>'id');
    IF v IS NULL OR v='null'::jsonb THEN CONTINUE;END IF;
    IF jsonb_typeof(v)<>'array' THEN RAISE EXCEPTION 'Invalid retained file property' USING ERRCODE='PT409';END IF;
    FOR v IN SELECT value FROM jsonb_array_elements(v) LOOP
     IF jsonb_typeof(v)<>'string' OR NOT fountain_private.retention_id(v#>>'{}') THEN RAISE EXCEPTION 'Invalid retained attachment identity' USING ERRCODE='PT409';END IF;
     RETURN NEXT v#>>'{}';
    END LOOP;
   END IF;
  END LOOP;
 ELSIF p_kind IN('page','version','collaboration') THEN
  FOR v IN SELECT value FROM (
   SELECT x.value FROM jsonb_path_query(p_data,'$.blocks[*].attachment_id') x(value) WHERE p_kind IN('page','version')
   UNION ALL SELECT x.value FROM jsonb_path_query(p_data,'$.state.blocks.*.fields.attachment_id.value') x(value) WHERE p_kind='collaboration'
   UNION ALL SELECT x.value FROM jsonb_path_query(p_data,'$.state.history.baseline.blocks.*.fields.attachment_id.value') x(value) WHERE p_kind='collaboration'
   UNION ALL SELECT x.value FROM jsonb_path_query(p_data,'$.state.history.ops.* ? (@.type == "block.set" && @.field == "attachment_id").value') x(value) WHERE p_kind='collaboration'
  ) refs LOOP
   IF v='null'::jsonb THEN CONTINUE;END IF;
   IF jsonb_typeof(v)<>'string' OR NOT fountain_private.retention_id(v#>>'{}') THEN RAISE EXCEPTION 'Invalid retained attachment identity' USING ERRCODE='PT409';END IF;
   RETURN NEXT v#>>'{}';
  END LOOP;
 END IF;
END $$;

-- These INVOKER guards distinguish the narrowly scoped postgres-owned kernel
-- from a raw backend caller forging a custom setting. JSON/meta never authorize
-- transitions. Empty vault reads are indexed and preserve all existing writes.
CREATE FUNCTION fountain_private.retention_entity_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE ws text; k text;i text;d jsonb;reserved boolean;
BEGIN
 ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.kind,NEW.id) IS DISTINCT FROM (OLD.workspace_id,OLD.kind,OLD.id) THEN RAISE EXCEPTION 'Immutable entity identity' USING ERRCODE='PT409';END IF;
 IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||ws,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN RAISE EXCEPTION 'Retention source is busy' USING ERRCODE='PT409';END IF;
 IF current_user='postgres' AND current_setting('fountain.retention_transition',true)=ws THEN
  IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;
 k:=CASE WHEN TG_OP='DELETE' THEN OLD.kind ELSE NEW.kind END;i:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 SELECT EXISTS(SELECT 1 FROM fountain_private.retention_identity_reservations r WHERE r.workspace_id=ws AND r.kind=k AND r.id=i) INTO reserved;
 IF reserved THEN RAISE EXCEPTION 'Identity is retained' USING ERRCODE='PT409';END IF;
 IF k IN('attachment','attachment_cloud','attachment_chunk') AND EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.kind=k AND e.id=i) THEN
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM fountain_private.entities live WHERE live.workspace_id=ws AND live.kind=k AND live.id=i AND (live.data,live.created_at,live.updated_at)=(NEW.data,NEW.created_at,NEW.updated_at)) OR TG_OP='DELETE' OR TG_OP='UPDATE' AND (NEW.data,NEW.created_at,NEW.updated_at) IS DISTINCT FROM (OLD.data,OLD.created_at,OLD.updated_at) THEN RAISE EXCEPTION 'Attachment is retained' USING ERRCODE='PT409';END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  d:=NEW.data;
  IF EXISTS(SELECT 1 FROM fountain_private.retention_identity_reservations r WHERE r.workspace_id=ws AND (
    r.kind='page' AND ((k='page' AND d->>'parent_id'=r.id) OR (k IN('database','version','comment','collaboration','wiki_page','site','transcript','upload','attachment') AND (d->>'page_id'=r.id OR k IN('collaboration','wiki_page') AND i=r.id)) OR k='database' AND d->>'parent_id'=r.id)
    OR r.kind='database' AND k IN('row','form','automation') AND d->>'database_id'=r.id
    OR r.kind='row' AND k IN('row','automation') AND (d->>'parent_row_id'=r.id OR d->>'row_id'=r.id)
   )) THEN RAISE EXCEPTION 'Parent identity is retained' USING ERRCODE='PT409';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER fountain_retention_entity BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.entities FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_entity_guard();
CREATE FUNCTION fountain_private.retention_chunk_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE ws text;aid text;off bigint;
BEGIN
 ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 aid:=CASE WHEN TG_OP='DELETE' THEN OLD.attachment_id ELSE NEW.attachment_id END;off:=CASE WHEN TG_OP='DELETE' THEN OLD."offset" ELSE NEW."offset" END;
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.attachment_id,NEW."offset") IS DISTINCT FROM (OLD.workspace_id,OLD.attachment_id,OLD."offset") THEN RAISE EXCEPTION 'Immutable chunk identity' USING ERRCODE='PT409';END IF;
 IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||ws,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN RAISE EXCEPTION 'Retention bytes are busy' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.kind='attachment' AND e.id=aid) THEN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND NEW.data IS DISTINCT FROM OLD.data THEN RAISE EXCEPTION 'Attachment bytes are retained' USING ERRCODE='PT409';END IF;
  IF TG_OP='INSERT' AND (NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=ws AND r.attachment_id=aid AND r."offset"=off) OR EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=ws AND r.attachment_id=aid AND r."offset"=off AND (r.size<>octet_length(NEW.data) OR r.sha256<>encode(sha256(NEW.data),'hex')))) THEN RAISE EXCEPTION 'Attachment bytes differ from retained pin' USING ERRCODE='PT409';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER fountain_retention_chunk BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.attachment_chunks FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_chunk_guard();

CREATE FUNCTION fountain_private.retention_bump(p_ws text,p_steps bigint,p_action text,p_id text,p_actor text,p_at text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE rev bigint;access_rev bigint;audit_id text:=replace(gen_random_uuid()::text,'-','');
BEGIN
 rev:=fountain_cloud.store_revision(p_ws,'_entity_revision');access_rev:=fountain_cloud.store_revision(p_ws,'access_revision');
 IF p_steps<1 OR rev+p_steps+2>9007199254740991 OR access_rev>=9007199254740991 THEN RAISE EXCEPTION 'Retention revision limit exceeded' USING ERRCODE='PT413';END IF;
 INSERT INTO fountain_private.meta VALUES(p_ws,'_entity_revision',to_jsonb(rev+p_steps+2)) ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 INSERT INTO fountain_private.meta VALUES(p_ws,'access_revision',to_jsonb(access_rev+1)) ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 INSERT INTO fountain_private.entities VALUES(p_ws,'audit',audit_id,jsonb_build_object('id',audit_id,'actor',p_actor,'action',p_action,'details',jsonb_build_object('record_id',p_id),'created_at',p_at,'updated_at',p_at),p_at,p_at);
 PERFORM fountain_private.content_touch(p_ws);
END $$;

CREATE FUNCTION fountain_cloud.retention_archive_page(p_workspace text,p_page text,p_at text,p_days integer,p_expected_revision bigint,p_record_id text,p_actor text,p_cause text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE ws text:=p_workspace;rid text:=COALESCE(p_record_id,replace(gen_random_uuid()::text,'-',''));stamp text;deleted_stamp text;purge_stamp text;root fountain_private.entities;
 source_rev bigint;metadata jsonb;g text;rec record;att record;source fountain_private.entities;raw text;owned boolean;position bigint;wanted bigint;m jsonb;physical text;size_value numeric;
 previous_transition text;counts jsonb;step_count bigint;old_deps jsonb;new_deps jsonb;revision bigint;
BEGIN
 IF NOT fountain_private.retention_id(ws) OR current_setting('fountain.workspace_id',true) IS DISTINCT FROM ws OR NOT fountain_private.retention_id(p_page)
  OR p_expected_revision IS NOT NULL AND p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR rid!~'^[a-f0-9]{32}$' OR p_days IS NULL OR p_days NOT BETWEEN 1 AND 3650 OR p_cause IS NULL OR p_cause NOT IN('manual','policy') OR p_actor IS NOT NULL AND NOT fountain_private.retention_id(p_actor) THEN RAISE EXCEPTION 'Invalid retention request' USING ERRCODE='22023';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Retention requires read committed isolation' USING ERRCODE='PT409';END IF;
 stamp:=fountain_private.retention_stamp(COALESCE(p_at,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00'));
 purge_stamp:=fountain_private.retention_stamp(to_char((stamp::timestamptz+make_interval(days=>p_days)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00');
 PERFORM fountain_cloud.store_lock(ws);source_rev:=fountain_cloud.store_revision(ws,'_entity_revision');
 SELECT data::jsonb INTO metadata FROM fountain_private.retention_records WHERE workspace_id=ws AND id=rid;
 IF FOUND THEN
  IF metadata->>'root_id' IS DISTINCT FROM p_page OR (metadata->>'retention_days')::integer IS DISTINCT FROM p_days OR metadata->>'cause' IS DISTINCT FROM p_cause OR p_expected_revision IS NOT NULL AND (metadata->>'source_revision')::bigint IS DISTINCT FROM p_expected_revision OR p_at IS NOT NULL AND metadata->>'retained_at' IS DISTINCT FROM stamp THEN RAISE EXCEPTION 'Retention retry differs' USING ERRCODE='PT409';END IF;
  RETURN metadata||jsonb_build_object('id',rid);
 END IF;
 IF p_expected_revision IS NOT NULL AND source_rev IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 SELECT * INTO root FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id=p_page;
 IF NOT FOUND THEN RAISE EXCEPTION 'Page not found' USING ERRCODE='PT404';END IF;
 IF root.data->'archived' IS DISTINCT FROM 'true'::jsonb OR root.data->>'id' IS DISTINCT FROM p_page THEN RAISE EXCEPTION 'Page must be in trash' USING ERRCODE='PT409';END IF;
 IF root.data->>'deleted_at' IS NOT NULL THEN deleted_stamp:=fountain_private.retention_stamp(root.data->>'deleted_at');ELSE
  BEGIN deleted_stamp:=fountain_private.retention_stamp(root.updated_at);EXCEPTION WHEN invalid_parameter_value THEN deleted_stamp:=stamp;END;
 END IF;
 SELECT generation INTO g FROM fountain_private.content_provenance WHERE workspace_id=ws AND kind='page' AND id=p_page;
 IF g IS NULL OR g!~'^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Missing content provenance' USING ERRCODE='PT409';END IF;
 metadata:=jsonb_build_object('version',1,'root_kind','page','root_id',p_page,'generation',g,'state','retained','deleted_at',deleted_stamp,'retained_at',stamp,'purge_after',purge_stamp,'retention_days',p_days,'source_revision',source_rev,'record_revision',1,'actor_id',p_actor,'cause',p_cause,'header',fountain_private.content_header('page',root.data),'counts','{}'::jsonb);
 previous_transition:=current_setting('fountain.retention_transition',true);PERFORM set_config('fountain.retention_transition',ws,true);
 INSERT INTO fountain_private.retention_records VALUES(ws,rid,metadata::text,stamp,stamp);
 -- Recursive UNION has no arbitrary depth limit and terminates on malformed
 -- cycles; the explicit root-parent check below rejects reachable cycles.
 WITH RECURSIVE pages(id) AS (
  SELECT p_page UNION SELECT e.id FROM fountain_private.entities e JOIN pages p ON e.data->>'parent_id'=p.id WHERE e.workspace_id=ws AND e.kind='page'
 ) INSERT INTO fountain_private.retention_entities
 SELECT ws,rid,e.kind,e.id,e.data::text,e.created_at,e.updated_at,d.generation,'owned' FROM fountain_private.entities e JOIN pages p ON p.id=e.id LEFT JOIN fountain_private.content_search_documents d ON d.workspace_id=e.workspace_id AND d.kind=e.kind AND d.id=e.id WHERE e.workspace_id=ws AND e.kind='page';
 IF EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=rid AND e.kind='page' AND e.id=root.data->>'parent_id') THEN RAISE EXCEPTION 'Cyclic page ownership' USING ERRCODE='PT409';END IF;
 INSERT INTO fountain_private.retention_entities
 SELECT ws,rid,e.kind,e.id,e.data::text,e.created_at,e.updated_at,d.generation,'owned' FROM fountain_private.entities e LEFT JOIN fountain_private.content_search_documents d ON d.workspace_id=e.workspace_id AND d.kind=e.kind AND d.id=e.id
 WHERE e.workspace_id=ws AND e.kind='database' AND EXISTS(SELECT 1 FROM fountain_private.retention_entities p WHERE p.workspace_id=ws AND p.record_id=rid AND p.kind='page' AND p.id IN(e.data->>'page_id',e.data->>'parent_id'));
 INSERT INTO fountain_private.retention_entities
 SELECT ws,rid,e.kind,e.id,e.data::text,e.created_at,e.updated_at,d.generation,'owned' FROM fountain_private.entities e LEFT JOIN fountain_private.content_search_documents d ON d.workspace_id=e.workspace_id AND d.kind=e.kind AND d.id=e.id
 WHERE e.workspace_id=ws AND e.kind='row' AND EXISTS(SELECT 1 FROM fountain_private.retention_entities p WHERE p.workspace_id=ws AND p.record_id=rid AND p.kind='database' AND p.id=e.data->>'database_id');
 INSERT INTO fountain_private.retention_entities
 SELECT ws,rid,e.kind,e.id,e.data::text,e.created_at,e.updated_at,NULL,'owned' FROM fountain_private.entities e
 WHERE e.workspace_id=ws AND ((e.kind IN('version','comment','wiki_page','site','transcript') AND EXISTS(SELECT 1 FROM fountain_private.retention_entities p WHERE p.workspace_id=ws AND p.record_id=rid AND p.kind='page' AND p.id=e.data->>'page_id'))
 OR(e.kind='collaboration' AND EXISTS(SELECT 1 FROM fountain_private.retention_entities p WHERE p.workspace_id=ws AND p.record_id=rid AND p.kind='page' AND p.id=e.id))
 OR(e.kind IN('form','automation') AND EXISTS(SELECT 1 FROM fountain_private.retention_entities p WHERE p.workspace_id=ws AND p.record_id=rid AND p.kind='database' AND p.id=e.data->>'database_id')));
 IF EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=rid AND (e.data::jsonb->>'id' IS DISTINCT FROM e.id OR NOT fountain_private.retention_id(e.id) OR e.kind IN('page','database','row') AND e.generation IS NULL)) THEN RAISE EXCEPTION 'Malformed retained entity' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='upload' AND e.data->'completed' IS DISTINCT FROM 'true'::jsonb AND EXISTS(SELECT 1 FROM fountain_private.retention_entities p WHERE p.workspace_id=ws AND p.record_id=rid AND p.kind='page' AND p.id=e.data->>'page_id')) THEN RAISE EXCEPTION 'Finish or cancel pending uploads before retention' USING ERRCODE='PT409';END IF;
 -- Process each logical attachment separately, never JSON-aggregate the graph.
 FOR att IN
  SELECT r.attachment_id FROM (
   SELECT x AS attachment_id FROM fountain_private.retention_entities e LEFT JOIN fountain_private.entities db ON db.workspace_id=ws AND db.kind='database' AND db.id=e.data::jsonb->>'database_id' CROSS JOIN LATERAL fountain_private.retention_references(e.kind,e.data::jsonb,db.data) x WHERE e.workspace_id=ws AND e.record_id=rid
   UNION SELECT e.id FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='attachment' AND EXISTS(SELECT 1 FROM fountain_private.retention_entities p WHERE p.workspace_id=ws AND p.record_id=rid AND p.kind='page' AND p.id=e.data->>'page_id')
  ) r ORDER BY r.attachment_id COLLATE "C"
 LOOP
  SELECT * INTO source FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='attachment' AND e.id=att.attachment_id;
  IF NOT FOUND THEN
   SELECT ws,'attachment',e.id,e.data::jsonb,e.created_at,e.updated_at INTO source FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.kind='attachment' AND e.id=att.attachment_id ORDER BY e.record_id LIMIT 1;
  END IF;
  IF source.id IS NULL OR source.data->>'id' IS DISTINCT FROM att.attachment_id THEN RAISE EXCEPTION 'Referenced attachment is missing' USING ERRCODE='PT409';END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.kind='attachment' AND e.id=source.id AND e.data::jsonb IS DISTINCT FROM source.data) THEN RAISE EXCEPTION 'Conflicting retained attachment metadata' USING ERRCODE='PT409';END IF;
  SELECT NOT EXISTS(SELECT 1 FROM fountain_private.entities e LEFT JOIN fountain_private.entities db ON db.workspace_id=ws AND db.kind='database' AND db.id=e.data->>'database_id' WHERE e.workspace_id=ws AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities c WHERE c.workspace_id=ws AND c.record_id=rid AND c.kind=e.kind AND c.id=e.id) AND (EXISTS(SELECT 1 FROM fountain_private.retention_references(e.kind,e.data,db.data) x WHERE x=source.id) OR e.kind='page' AND e.id=source.data->>'page_id')) INTO owned;
  IF EXISTS(SELECT 1 FROM fountain_private.retention_identity_reservations r WHERE r.workspace_id=ws AND r.kind='attachment' AND r.id=source.id) THEN owned:=false;END IF;
  INSERT INTO fountain_private.retention_entities VALUES(ws,rid,'attachment',source.id,source.data::text,source.created_at,source.updated_at,NULL,CASE WHEN owned THEN 'owned' ELSE 'shared' END);
  -- An overlay is an immutable source fingerprint tied to the attachment.
  SELECT * INTO source FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='attachment_cloud' AND e.id=att.attachment_id;
  IF NOT FOUND THEN SELECT ws,'attachment_cloud',e.id,e.data::jsonb,e.created_at,e.updated_at INTO source FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.kind='attachment_cloud' AND e.id=att.attachment_id ORDER BY e.record_id LIMIT 1;END IF;
  IF source.id IS NOT NULL THEN
   INSERT INTO fountain_private.retention_entities VALUES(ws,rid,source.kind,source.id,source.data::text,source.created_at,source.updated_at,NULL,CASE WHEN owned THEN 'owned' ELSE 'shared' END);
  END IF;
  SELECT e.data::jsonb INTO m FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=rid AND e.kind='attachment_cloud' AND e.id=att.attachment_id;
  IF NOT FOUND THEN SELECT e.data::jsonb INTO m FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=rid AND e.kind='attachment' AND e.id=att.attachment_id;END IF;
  IF jsonb_typeof(m->'size') IS DISTINCT FROM 'number' OR (m->>'size')::numeric<0 OR (m->>'size')::numeric>5000000000 OR trunc((m->>'size')::numeric)<>(m->>'size')::numeric THEN RAISE EXCEPTION 'Invalid retained attachment size' USING ERRCODE='PT409';END IF;
  wanted:=(m->>'size')::bigint;position:=0;
  IF m ? 'cloud_chunks' THEN
   physical:=fountain_cloud.storage_gc_layout(m,att.attachment_id,false);PERFORM fountain_cloud.storage_gc_reference(ws,physical);
   INSERT INTO fountain_private.retention_attachment_refs SELECT ws,rid,att.attachment_id,'cloud',physical,(x->>'offset')::bigint,(x->>'size')::bigint,x->>'sha256' FROM jsonb_array_elements(m->'cloud_chunks') x;
  ELSIF m->>'storage'='chunks' THEN
   -- Resolve each offset independently. A migrated attachment can have BYTEA
   -- prefix chunks and file-backed tail chunks, or identical staged BYTEA and
   -- historical file manifests at the same offset. Never omit either tail.
   FOR rec IN
    WITH files AS (
     SELECT DISTINCT ON(q.id) q.* FROM (
      SELECT e.id,e.data AS value,e.created_at,e.updated_at FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='attachment_chunk' AND e.data->>'attachment_id'=att.attachment_id
      UNION ALL SELECT e.id,e.data::jsonb,e.created_at,e.updated_at FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.kind='attachment_chunk' AND e.data::jsonb->>'attachment_id'=att.attachment_id AND NOT EXISTS(SELECT 1 FROM fountain_private.entities l WHERE l.workspace_id=ws AND l.kind='attachment_chunk' AND l.id=e.id)
     ) q ORDER BY q.id
    ), sources AS (
     SELECT c."offset",octet_length(c.data)::bigint AS size,encode(sha256(c.data),'hex') AS hash,'blob'::text AS storage_kind,NULL::text AS id,NULL::jsonb AS value,NULL::text AS created_at,NULL::text AS updated_at FROM fountain_private.attachment_chunks c WHERE c.workspace_id=ws AND c.attachment_id=att.attachment_id
     UNION ALL SELECT (f.value->>'offset')::bigint,(f.value->>'size')::bigint,f.value->>'sha256','file',f.id,f.value,f.created_at,f.updated_at FROM files f
    ) SELECT DISTINCT ON(x."offset") x.*,(SELECT count(DISTINCT(z.size,z.hash))>1 FROM sources z WHERE z."offset"=x."offset") AS conflicting FROM sources x ORDER BY x."offset",CASE x.storage_kind WHEN 'blob' THEN 0 ELSE 1 END
   LOOP
    IF rec.conflicting OR rec."offset" IS DISTINCT FROM position OR rec.size IS DISTINCT FROM least(4194304,wanted-position) OR rec.size<=0 OR rec.hash IS NULL OR rec.hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid retained mixed chunk layout' USING ERRCODE='PT409';END IF;
    IF rec.storage_kind='file' THEN
     IF rec.id IS DISTINCT FROM encode(sha256(convert_to('['||to_json(att.attachment_id)::text||','||rec."offset"::text||']','UTF8')),'hex') THEN RAISE EXCEPTION 'Invalid retained file manifest' USING ERRCODE='PT409';END IF;
     INSERT INTO fountain_private.retention_entities VALUES(ws,rid,'attachment_chunk',rec.id,rec.value::text,rec.created_at,rec.updated_at,NULL,CASE WHEN owned THEN 'owned' ELSE 'shared' END) ON CONFLICT DO NOTHING;
    END IF;
    INSERT INTO fountain_private.retention_attachment_refs VALUES(ws,rid,att.attachment_id,rec.storage_kind,CASE rec.storage_kind WHEN 'blob' THEN att.attachment_id ELSE rec.hash END,rec."offset",rec.size,rec.hash);
    position:=position+rec.size;
   END LOOP;
   IF position<>wanted THEN RAISE EXCEPTION 'Retained attachment bytes are incomplete' USING ERRCODE='PT409';END IF;
  ELSIF m ? 'data' THEN
   BEGIN IF octet_length(decode(m->>'data','base64'))<>wanted THEN RAISE EXCEPTION 'Invalid inline retained bytes' USING ERRCODE='PT409';END IF;EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RAISE EXCEPTION 'Invalid inline retained bytes' USING ERRCODE='PT409';END;
  ELSIF wanted<>0 THEN RAISE EXCEPTION 'Retained attachment storage is unknown' USING ERRCODE='PT409';END IF;
 END LOOP;
 INSERT INTO fountain_private.retention_provenance SELECT ws,rid,p.kind,p.id,p.generation,p.creator_id,p.creator_cause,p.editor_id,p.edited_at,p.editor_cause,p.manager_id,p.manager_at FROM fountain_private.content_provenance p JOIN fountain_private.retention_entities e ON e.workspace_id=p.workspace_id AND e.record_id=rid AND e.kind=p.kind AND e.id=p.id WHERE p.workspace_id=ws;
 IF EXISTS(SELECT 1 FROM fountain_private.retention_entities e LEFT JOIN fountain_private.retention_provenance p ON p.workspace_id=e.workspace_id AND p.record_id=e.record_id AND p.kind=e.kind AND p.id=e.id WHERE e.workspace_id=ws AND e.record_id=rid AND e.kind IN('page','database','row') AND p.generation IS DISTINCT FROM e.generation) THEN RAISE EXCEPTION 'Content incarnation history is inconsistent' USING ERRCODE='PT409';END IF;
 INSERT INTO fountain_private.retention_identity_reservations SELECT ws,e.kind,e.id,rid,COALESCE(e.generation,replace(gen_random_uuid()::text,'-','')) FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=rid AND e.ownership='owned';
 -- External task edges remain live. Journal exactly the removed dependencies
 -- and the current row incarnation; restoration refuses concurrent edits.
 FOR rec IN SELECT e.id,e.data,p.generation FROM fountain_private.entities e JOIN fountain_private.content_provenance p ON p.workspace_id=e.workspace_id AND p.kind=e.kind AND p.id=e.id WHERE e.workspace_id=ws AND e.kind='row' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities c WHERE c.workspace_id=ws AND c.record_id=rid AND c.kind='row' AND c.id=e.id) LOOP
  old_deps:=COALESCE(rec.data->'depends_on','[]'::jsonb);
  IF jsonb_typeof(old_deps)<>'array' THEN RAISE EXCEPTION 'Malformed external task dependencies' USING ERRCODE='PT409';END IF;
  SELECT COALESCE(jsonb_agg(x.value ORDER BY x.ordinal),'[]'::jsonb) INTO new_deps FROM jsonb_array_elements(old_deps) WITH ORDINALITY x(value,ordinal) WHERE NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities c WHERE c.workspace_id=ws AND c.record_id=rid AND c.kind='row' AND to_jsonb(c.id)=x.value);
  IF new_deps IS DISTINCT FROM old_deps THEN
   IF EXISTS(SELECT 1 FROM fountain_private.retention_links l WHERE l.workspace_id=ws AND l.kind='row' AND l.id=rec.id AND l.record_id<>rid) THEN RAISE EXCEPTION 'External dependencies already belong to a retention journal' USING ERRCODE='PT409';END IF;
   INSERT INTO fountain_private.retention_links VALUES(ws,rid,'row',rec.id,jsonb_build_object('generation',rec.generation,'before',old_deps,'after',new_deps)::text);END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM fountain_private.retention_links l JOIN fountain_private.retention_entities e ON e.workspace_id=l.workspace_id AND e.kind=l.kind AND e.id=l.id WHERE l.workspace_id=ws AND l.record_id<>rid AND e.record_id=rid) THEN RAISE EXCEPTION 'Live resource belongs to another retention dependency journal' USING ERRCODE='PT409';END IF;
 PERFORM set_config('fountain.retention_transition',ws,true);
 BEGIN
  UPDATE fountain_private.entities e SET data=jsonb_set(e.data,'{depends_on}',l.data::jsonb->'after') FROM fountain_private.retention_links l WHERE l.workspace_id=ws AND l.record_id=rid AND e.workspace_id=ws AND e.kind=l.kind AND e.id=l.id;
  DELETE FROM fountain_private.entities e USING fountain_private.retention_entities c WHERE e.workspace_id=ws AND c.workspace_id=ws AND c.record_id=rid AND c.kind=e.kind AND c.id=e.id AND c.ownership='owned';
  -- An earlier retained record may own an attachment reservation while this
  -- record holds a shared snapshot. Reservation ownership does not make the
  -- attachment public/live after its last actual live reference is moved.
  FOR att IN SELECT e.id,e.data::jsonb AS value FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=rid AND e.kind='attachment' AND e.ownership='shared' LOOP
   IF NOT EXISTS(SELECT 1 FROM fountain_private.entities e LEFT JOIN fountain_private.entities db ON db.workspace_id=ws AND db.kind='database' AND db.id=e.data->>'database_id' WHERE e.workspace_id=ws AND (EXISTS(SELECT 1 FROM fountain_private.retention_references(e.kind,e.data,db.data) x WHERE x=att.id) OR e.kind='page' AND e.id=att.value->>'page_id')) THEN
    DELETE FROM fountain_private.entities e USING fountain_private.retention_entities c WHERE e.workspace_id=ws AND c.workspace_id=ws AND c.record_id=rid AND c.kind=e.kind AND c.id=e.id AND (c.kind IN('attachment','attachment_cloud') AND c.id=att.id OR c.kind='attachment_chunk' AND c.data::jsonb->>'attachment_id'=att.id);
   END IF;
  END LOOP;
  SELECT jsonb_build_object('entities',(SELECT count(*) FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=rid),'provenance',(SELECT count(*) FROM fountain_private.retention_provenance WHERE workspace_id=ws AND record_id=rid),'refs',(SELECT count(*) FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND record_id=rid),'reservations',(SELECT count(*) FROM fountain_private.retention_identity_reservations WHERE workspace_id=ws AND record_id=rid),'links',(SELECT count(*) FROM fountain_private.retention_links WHERE workspace_id=ws AND record_id=rid)) INTO counts;
  metadata:=jsonb_set(metadata,'{counts}',counts);UPDATE fountain_private.retention_records SET data=metadata::text WHERE workspace_id=ws AND id=rid;
  PERFORM fountain_private.retention_validate_record(ws,rid,false);
  step_count:=(counts->>'entities')::bigint+(counts->>'links')::bigint;
  PERFORM fountain_private.retention_bump(ws,step_count,'retention.archived',rid,p_actor,stamp);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.retention_transition',COALESCE(previous_transition,''),true);RAISE;END;
 PERFORM set_config('fountain.retention_transition',COALESCE(previous_transition,''),true);
 RETURN metadata||jsonb_build_object('id',rid);
END $$;

CREATE FUNCTION fountain_cloud.retention_restore_to_trash(p_workspace text,p_record_id text,p_expected_record_revision bigint DEFAULT 1,p_target_storage text DEFAULT 'native') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE ws text:=p_workspace;metadata jsonb;rec record;live fountain_private.entities;refs record;previous_transition text;steps bigint:=0;restored_count bigint:=0;inserted bigint;stamp text;value jsonb;snapshot jsonb;
BEGIN
 IF p_target_storage IS NULL OR p_target_storage NOT IN('native','blob') OR NOT fountain_private.retention_id(ws) OR current_setting('fountain.workspace_id',true) IS DISTINCT FROM ws OR p_record_id IS NULL OR p_record_id!~'^[a-f0-9]{32}$' OR p_expected_record_revision IS NULL OR p_expected_record_revision<1 THEN RAISE EXCEPTION 'Invalid retention restore request' USING ERRCODE='22023';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Retention requires read committed isolation' USING ERRCODE='PT409';END IF;
 PERFORM fountain_cloud.store_lock(ws);
 SELECT data::jsonb INTO metadata FROM fountain_private.retention_records WHERE workspace_id=ws AND id=p_record_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Retained record not found' USING ERRCODE='PT404';END IF;
 PERFORM fountain_private.retention_validate_record(ws,p_record_id,p_target_storage='blob');
 IF metadata->>'state'<>'retained' OR (metadata->>'record_revision')::bigint<>p_expected_record_revision THEN RAISE EXCEPTION 'Retained record changed' USING ERRCODE='PT409';END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=p_record_id AND e.kind='page' AND e.id=metadata->>'root_id' AND e.generation=metadata->>'generation' AND e.data::jsonb->'archived'='true'::jsonb) THEN RAISE EXCEPTION 'Invalid retained root' USING ERRCODE='PT409';END IF;
 FOR rec IN SELECT * FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=p_record_id LOOP
  IF rec.data::jsonb->>'id' IS DISTINCT FROM rec.id OR rec.ownership NOT IN('owned','shared') OR rec.ownership='shared' AND rec.kind NOT IN('attachment','attachment_cloud','attachment_chunk') THEN RAISE EXCEPTION 'Invalid retained snapshot' USING ERRCODE='PT409';END IF;
  IF p_target_storage='blob' AND rec.kind IN('attachment_cloud','attachment_chunk') OR rec.kind='attachment_chunk' AND EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs pin WHERE pin.workspace_id=ws AND pin.record_id=p_record_id AND pin.storage_kind='file' AND pin.attachment_id=rec.data::jsonb->>'attachment_id') THEN CONTINUE;END IF;
  snapshot:=rec.data::jsonb;
  IF rec.kind='attachment' AND NOT snapshot ? 'data' AND (p_target_storage='blob' OR EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs pin WHERE pin.workspace_id=ws AND pin.record_id=p_record_id AND pin.storage_kind='file' AND pin.attachment_id=rec.id)) THEN snapshot:=(snapshot-ARRAY['cloud_chunks','storage_id'])||'{"storage":"chunks"}'::jsonb;END IF;
  SELECT * INTO live FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind=rec.kind AND e.id=rec.id;
  IF FOUND AND (rec.kind NOT IN('attachment','attachment_cloud','attachment_chunk') OR (live.data,live.created_at,live.updated_at) IS DISTINCT FROM (snapshot,rec.created_at,rec.updated_at)) THEN RAISE EXCEPTION 'A newer live identity conflicts with retention' USING ERRCODE='PT409';END IF;
  IF rec.kind NOT IN('attachment','attachment_cloud','attachment_chunk') AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_identity_reservations r WHERE r.workspace_id=ws AND r.record_id=p_record_id AND r.kind=rec.kind AND r.id=rec.id AND (rec.generation IS NULL OR rec.generation=r.generation)) THEN RAISE EXCEPTION 'Retained identity reservation is missing' USING ERRCODE='PT409';END IF;
  -- A shared attachment may have been exclusively moved by another record.
  -- Every archived metadata copy must agree before its reserved ID is rebuilt.
  IF rec.kind IN('attachment','attachment_cloud','attachment_chunk') AND EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id<>p_record_id AND e.kind=rec.kind AND e.id=rec.id AND (e.data::jsonb,e.created_at,e.updated_at) IS DISTINCT FROM (rec.data::jsonb,rec.created_at,rec.updated_at)) THEN RAISE EXCEPTION 'Conflicting shared attachment snapshots' USING ERRCODE='PT409';END IF;
 END LOOP;
 -- Revalidate immutable byte pins and shared pins before any source is copied.
 FOR refs IN SELECT * FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=ws AND r.record_id=p_record_id LOOP
  IF refs.size<=0 OR refs.sha256!~'^[a-f0-9]{64}$' OR refs."offset"<0 OR mod(refs."offset",4194304)<>0 OR refs.size>4194304 THEN RAISE EXCEPTION 'Invalid retained byte pin' USING ERRCODE='PT409';END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=ws AND r.record_id<>p_record_id AND r.attachment_id=refs.attachment_id AND r."offset"=refs."offset" AND (r.size,r.sha256) IS DISTINCT FROM (refs.size,refs.sha256)) THEN RAISE EXCEPTION 'Conflicting shared byte pins' USING ERRCODE='PT409';END IF;
  IF refs.storage_kind='blob' OR p_target_storage='blob' THEN
   IF NOT EXISTS(SELECT 1 FROM fountain_private.attachment_chunks c WHERE c.workspace_id=ws AND c.attachment_id=refs.attachment_id AND c."offset"=refs."offset" AND octet_length(c.data)=refs.size AND encode(sha256(c.data),'hex')=refs.sha256) THEN RAISE EXCEPTION 'Retained blob bytes changed' USING ERRCODE='PT409';END IF;
  ELSIF refs.storage_kind='file' THEN
   IF refs.physical_id<>refs.sha256 OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=p_record_id AND e.kind='attachment_chunk' AND e.data::jsonb->>'attachment_id'=refs.attachment_id AND e.data::jsonb->>'sha256'=refs.sha256 AND (e.data::jsonb->>'offset')::bigint=refs."offset" AND (e.data::jsonb->>'size')::bigint=refs.size) THEN RAISE EXCEPTION 'Retained file manifest changed' USING ERRCODE='PT409';END IF;
   IF NOT EXISTS(SELECT 1 FROM fountain_private.attachment_chunks c WHERE c.workspace_id=ws AND c.attachment_id=refs.attachment_id AND c."offset"=refs."offset" AND octet_length(c.data)=refs.size AND encode(sha256(c.data),'hex')=refs.sha256) THEN RAISE EXCEPTION 'MIGRATION_REQUIRED: materialize file-backed retained bytes as portable blobs' USING ERRCODE='PT503';END IF;
   IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='attachment_chunk' AND e.data->>'attachment_id'=refs.attachment_id AND (e.data->>'offset')::bigint=refs."offset" AND ((e.data->>'size')::bigint IS DISTINCT FROM refs.size OR e.data->>'sha256' IS DISTINCT FROM refs.sha256)) THEN RAISE EXCEPTION 'Current live file transport differs from retained bytes' USING ERRCODE='PT409';END IF;
  ELSIF refs.storage_kind='cloud' THEN
   IF EXISTS(SELECT 1 FROM fountain_cloud.storage_gc_tombstones t WHERE t.workspace_id=ws AND t.storage_id=refs.physical_id) OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data::jsonb->'cloud_chunks')='array' THEN e.data::jsonb->'cloud_chunks' ELSE '[]'::jsonb END) m WHERE e.workspace_id=ws AND e.record_id=p_record_id AND e.kind IN('attachment','attachment_cloud') AND e.id=refs.attachment_id AND m->>'attachmentId'=refs.physical_id AND (m->>'offset')::bigint=refs."offset" AND (m->>'size')::bigint=refs.size AND m->>'sha256'=refs.sha256) THEN RAISE EXCEPTION 'Retained cloud manifest changed' USING ERRCODE='PT409';END IF;
   -- Metadata proves canonical immutable object presence only; SQL does not
   -- claim to read or hash provider bytes. The later public wrapper must do so.
   IF NOT EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE b.id='fountain-files' AND NOT b.public AND o.name='v1/'||encode(sha256(convert_to(ws,'UTF8')),'hex')||'/'||encode(sha256(convert_to(refs.physical_id,'UTF8')),'hex')||'/'||refs."offset"::text||'-'||refs.sha256 AND CASE WHEN o.metadata->>'size' ~ '^[0-9]{1,16}$' THEN (o.metadata->>'size')::bigint=refs.size ELSE false END) THEN RAISE EXCEPTION 'MIGRATION_REQUIRED: retained cloud object is unavailable' USING ERRCODE='PT503';END IF;
  ELSE RAISE EXCEPTION 'Unknown retained byte storage' USING ERRCODE='PT409';END IF;
 END LOOP;
 IF p_target_storage='blob' THEN
  FOR rec IN SELECT e.id,e.data::jsonb AS value FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=p_record_id AND e.kind='attachment' AND NOT e.data::jsonb ? 'data' LOOP
   IF (SELECT COALESCE(sum(octet_length(c.data)),0) FROM fountain_private.attachment_chunks c WHERE c.workspace_id=ws AND c.attachment_id=rec.id)<>(rec.value->>'size')::bigint
    OR EXISTS(SELECT 1 FROM fountain_private.attachment_chunks c WHERE c.workspace_id=ws AND c.attachment_id=rec.id AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=ws AND r.record_id=p_record_id AND r.attachment_id=rec.id AND r."offset"=c."offset" AND r.size=octet_length(c.data) AND r.sha256=encode(sha256(c.data),'hex'))) THEN RAISE EXCEPTION 'Portable retained blob layout is incomplete' USING ERRCODE='PT409';END IF;
  END LOOP;
 END IF;
 FOR rec IN SELECT l.*,p.generation,e.data AS live_data FROM fountain_private.retention_links l LEFT JOIN fountain_private.content_provenance p ON p.workspace_id=l.workspace_id AND p.kind=l.kind AND p.id=l.id LEFT JOIN fountain_private.entities e ON e.workspace_id=l.workspace_id AND e.kind=l.kind AND e.id=l.id WHERE l.workspace_id=ws AND l.record_id=p_record_id LOOP
  IF rec.kind<>'row' OR rec.generation IS DISTINCT FROM rec.data::jsonb->>'generation' OR rec.live_data->'depends_on' IS DISTINCT FROM rec.data::jsonb->'after' THEN RAISE EXCEPTION 'External task dependencies changed' USING ERRCODE='PT409';END IF;
 END LOOP;
 previous_transition:=current_setting('fountain.retention_transition',true);PERFORM set_config('fountain.retention_transition',ws,true);
 BEGIN
  -- Staging a verified file chunk as BYTEA replaces only its matching live
  -- technical transport manifest. Otherwise releasing the last pin would leave
  -- two runtime sources at one offset. Authored attachment metadata is untouched.
  DELETE FROM fountain_private.entities e USING fountain_private.retention_attachment_refs r,fountain_private.attachment_chunks c
  WHERE e.workspace_id=ws AND e.kind='attachment_chunk' AND r.workspace_id=ws AND r.record_id=p_record_id AND r.storage_kind='file'
   AND e.data->>'attachment_id'=r.attachment_id AND (e.data->>'offset')::bigint=r."offset" AND (e.data->>'size')::bigint=r.size AND e.data->>'sha256'=r.sha256
   AND e.id=encode(sha256(convert_to('['||to_json(r.attachment_id)::text||','||r."offset"::text||']','UTF8')),'hex')
   AND c.workspace_id=ws AND c.attachment_id=r.attachment_id AND c."offset"=r."offset" AND octet_length(c.data)=r.size AND encode(sha256(c.data),'hex')=r.sha256;
  FOR rec IN SELECT * FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=p_record_id ORDER BY CASE e.kind WHEN 'page' THEN 0 WHEN 'database' THEN 1 WHEN 'row' THEN 2 ELSE 3 END,e.kind COLLATE "C",e.id COLLATE "C" LOOP
   IF p_target_storage='blob' AND rec.kind IN('attachment_cloud','attachment_chunk') OR rec.kind='attachment_chunk' AND EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs pin WHERE pin.workspace_id=ws AND pin.record_id=p_record_id AND pin.storage_kind='file' AND pin.attachment_id=rec.data::jsonb->>'attachment_id') THEN CONTINUE;END IF;
   value:=rec.data::jsonb;
   IF rec.kind='attachment' AND NOT value ? 'data' AND (p_target_storage='blob' OR EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs pin WHERE pin.workspace_id=ws AND pin.record_id=p_record_id AND pin.storage_kind='file' AND pin.attachment_id=rec.id)) THEN value:=(value-ARRAY['cloud_chunks','storage_id'])||'{"storage":"chunks"}'::jsonb;END IF;
   IF rec.kind IN('site','form') THEN value:=value||'{"published":false}'::jsonb;END IF;
   IF rec.kind='automation' THEN value:=value||'{"enabled":false}'::jsonb;END IF;
   INSERT INTO fountain_private.entities VALUES(ws,rec.kind,rec.id,value,rec.created_at,rec.updated_at) ON CONFLICT(workspace_id,kind,id) DO NOTHING;
   GET DIAGNOSTICS inserted=ROW_COUNT;restored_count:=restored_count+inserted;
   steps:=steps+1;
  END LOOP;
  -- Entity triggers build derivative documents. Replace only their incarnation
  -- and exact historical provenance after all publication projections finish.
  UPDATE fountain_private.content_search_documents d SET generation=e.generation FROM fountain_private.retention_entities e WHERE e.workspace_id=ws AND e.record_id=p_record_id AND e.kind=d.kind AND e.id=d.id AND d.workspace_id=ws AND e.generation IS NOT NULL;
  INSERT INTO fountain_private.content_provenance SELECT ws,p.kind,p.id,p.generation,p.creator_id,p.creator_cause,p.editor_id,p.edited_at,p.editor_cause,p.manager_id,p.manager_at FROM fountain_private.retention_provenance p WHERE p.workspace_id=ws AND p.record_id=p_record_id
  ON CONFLICT(workspace_id,kind,id) DO UPDATE SET generation=EXCLUDED.generation,creator_id=EXCLUDED.creator_id,creator_cause=EXCLUDED.creator_cause,editor_id=EXCLUDED.editor_id,edited_at=EXCLUDED.edited_at,editor_cause=EXCLUDED.editor_cause,manager_id=EXCLUDED.manager_id,manager_at=EXCLUDED.manager_at;
  UPDATE fountain_private.entities e SET data=jsonb_set(e.data,'{depends_on}',l.data::jsonb->'before') FROM fountain_private.retention_links l WHERE l.workspace_id=ws AND l.record_id=p_record_id AND e.workspace_id=ws AND e.kind=l.kind AND e.id=l.id;
  GET DIAGNOSTICS steps=ROW_COUNT;
  steps:=steps+(metadata->'counts'->>'entities')::bigint;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00';
  PERFORM fountain_private.retention_bump(ws,steps,'retention.restored_to_trash',p_record_id,NULL,stamp);
  -- Only this record releases pins; any other record's pins/reservations survive.
  DELETE FROM fountain_private.retention_records WHERE workspace_id=ws AND id=p_record_id;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.retention_transition',COALESCE(previous_transition,''),true);RAISE;END;
 PERFORM set_config('fountain.retention_transition',COALESCE(previous_transition,''),true);
 RETURN metadata||jsonb_build_object('id',p_record_id,'restored',restored_count);
END $$;

-- Keep the current GC checks and grants intact, adding a fresh private vault
-- pin query. Physical GC must never retire an attachment while a record owns it.
CREATE OR REPLACE FUNCTION fountain_cloud.storage_gc_pinned(p_workspace_id text,p_storage_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR NOT fountain_cloud.storage_gc_id(p_storage_id) THEN RAISE EXCEPTION 'Invalid Storage identity' USING ERRCODE='PT409';END IF;
 RETURN EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='upload' AND e.id=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='attachment' AND e.data ? 'cloud_chunks' AND COALESCE(e.data->>'storage_id',e.id)=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='attachment_cloud' AND COALESCE(e.data->>'storage_id',e.id)=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=p_workspace_id AND s.extra ? 'cloud_chunks' AND COALESCE(s.extra->>'storage_id',s.extra->>'id',s.descriptor->>'id')=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=p_workspace_id AND s.cloud IS NOT NULL AND s.cloud->>'attachmentId'=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_parts p WHERE p.workspace_id=p_workspace_id AND p.state IN('pending','published') AND p.manifest->>'attachmentId'=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=p_workspace_id AND r.storage_kind='cloud' AND r.physical_id=p_storage_id);
END $$;

ALTER FUNCTION fountain_private.retention_id(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_id(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.retention_stamp(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_stamp(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.retention_references(text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_references(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.retention_entity_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_entity_guard() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.retention_chunk_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_chunk_guard() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.retention_bump(text,bigint,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_bump(text,bigint,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_cloud.retention_archive_page(text,text,text,integer,bigint,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.retention_archive_page(text,text,text,integer,bigint,text,text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_cloud.retention_archive_page(text,text,text,integer,bigint,text,text,text) TO fountain_backend;
ALTER FUNCTION fountain_cloud.retention_restore_to_trash(text,text,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.retention_restore_to_trash(text,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_cloud.retention_restore_to_trash(text,text,bigint,text) TO fountain_backend;

-- Shared read-only structural validator for trusted snapshot/restore/export.
-- It validates each source row separately; bodies never share a JSON frame.
CREATE FUNCTION fountain_private.retention_validate_record(p_ws text,p_record text,p_portable boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE m jsonb;root jsonb;rec record;d jsonb;actual jsonb;column_name text;value text;byte_pin record;position bigint;size_total bigint;expected_size bigint;manifest jsonb;record_created text;record_updated text;
BEGIN
 IF p_portable IS NULL OR NOT fountain_private.retention_id(p_ws) OR p_record IS NULL OR p_record!~'^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Invalid retained record identity' USING ERRCODE='PT409';END IF;
 SELECT data::jsonb,created_at,updated_at INTO m,record_created,record_updated FROM fountain_private.retention_records WHERE workspace_id=p_ws AND id=p_record;
 IF NOT FOUND OR jsonb_typeof(m) IS DISTINCT FROM 'object' OR NOT(m ?& ARRAY['version','root_kind','root_id','generation','state','deleted_at','retained_at','purge_after','retention_days','source_revision','record_revision','actor_id','cause','header','counts']) OR m-ARRAY['version','root_kind','root_id','generation','state','deleted_at','retained_at','purge_after','retention_days','source_revision','record_revision','actor_id','cause','header','counts']<>'{}'::jsonb
  OR m->'version' IS DISTINCT FROM '1'::jsonb OR m->>'root_kind' IS DISTINCT FROM 'page' OR m->>'state' IS DISTINCT FROM 'retained'
  OR NOT fountain_private.retention_id(m->>'root_id') OR m->>'generation'!~'^[a-f0-9]{32}$' OR m->>'cause' NOT IN('manual','policy') OR m->>'cause' IS NULL
  OR m->'actor_id'<>'null'::jsonb AND (jsonb_typeof(m->'actor_id')<>'string' OR NOT fountain_private.retention_id(m->>'actor_id')) THEN RAISE EXCEPTION 'Malformed retained metadata' USING ERRCODE='PT409';END IF;
 FOREACH column_name IN ARRAY ARRAY['root_kind','root_id','generation','state','cause'] LOOP
  IF jsonb_typeof(m->column_name) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid retained metadata type' USING ERRCODE='PT409';END IF;
 END LOOP;
 FOREACH column_name IN ARRAY ARRAY['retention_days','source_revision','record_revision'] LOOP
  IF jsonb_typeof(m->column_name) IS DISTINCT FROM 'number' OR m->>column_name !~'^[0-9]{1,16}$' OR (m->>column_name)::bigint>9007199254740991 THEN RAISE EXCEPTION 'Invalid retained revision/period' USING ERRCODE='PT409';END IF;
 END LOOP;
 IF (m->>'retention_days')::bigint NOT BETWEEN 1 AND 3650 OR (m->>'record_revision')::bigint<1 THEN RAISE EXCEPTION 'Invalid retained revision/period' USING ERRCODE='PT409';END IF;
 FOREACH column_name IN ARRAY ARRAY['deleted_at','retained_at','purge_after'] LOOP
  IF jsonb_typeof(m->column_name) IS DISTINCT FROM 'string' OR (m->>column_name)!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}(Z|\+00:00)$' OR fountain_private.retention_stamp(m->>column_name) IS DISTINCT FROM replace(m->>column_name,'Z','+00:00') THEN RAISE EXCEPTION 'Invalid normalized retention timestamp' USING ERRCODE='PT409';END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[record_created,record_updated] LOOP
  IF value!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}(Z|\+00:00)$' OR fountain_private.retention_stamp(value) IS DISTINCT FROM replace(value,'Z','+00:00') THEN RAISE EXCEPTION 'Invalid retained record timestamp' USING ERRCODE='PT409';END IF;
 END LOOP;
 IF (m->>'purge_after')::timestamptz IS DISTINCT FROM (m->>'retained_at')::timestamptz+make_interval(days=>(m->>'retention_days')::integer) THEN RAISE EXCEPTION 'Retained expiry is not anchored to move time' USING ERRCODE='PT409';END IF;
 SELECT data::jsonb INTO root FROM fountain_private.retention_entities WHERE workspace_id=p_ws AND record_id=p_record AND kind='page' AND id=m->>'root_id' AND generation=m->>'generation' AND ownership='owned';
 IF NOT FOUND OR root->'archived' IS DISTINCT FROM 'true'::jsonb OR m->'header' IS DISTINCT FROM fountain_private.content_header('page',root) THEN RAISE EXCEPTION 'Retained root/header changed' USING ERRCODE='PT409';END IF;
 IF EXISTS(WITH RECURSIVE reachable(id) AS (SELECT m->>'root_id' UNION SELECT e.id FROM fountain_private.retention_entities e JOIN reachable p ON e.data::jsonb->>'parent_id'=p.id WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='page') SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='page' AND NOT EXISTS(SELECT 1 FROM reachable r WHERE r.id=e.id)) OR EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='page' AND e.id=root->>'parent_id') THEN RAISE EXCEPTION 'Retained page graph is cyclic or disconnected' USING ERRCODE='PT409';END IF;
 SELECT jsonb_build_object('entities',(SELECT count(*) FROM fountain_private.retention_entities WHERE workspace_id=p_ws AND record_id=p_record),'provenance',(SELECT count(*) FROM fountain_private.retention_provenance WHERE workspace_id=p_ws AND record_id=p_record),'refs',(SELECT count(*) FROM fountain_private.retention_attachment_refs WHERE workspace_id=p_ws AND record_id=p_record),'reservations',(SELECT count(*) FROM fountain_private.retention_identity_reservations WHERE workspace_id=p_ws AND record_id=p_record),'links',(SELECT count(*) FROM fountain_private.retention_links WHERE workspace_id=p_ws AND record_id=p_record)) INTO actual;
 IF m->'counts' IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Retained row counts do not match metadata' USING ERRCODE='PT409';END IF;
 FOR rec IN SELECT * FROM fountain_private.retention_entities WHERE workspace_id=p_ws AND record_id=p_record LOOP
  d:=rec.data::jsonb;
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->>'id' IS DISTINCT FROM rec.id OR jsonb_typeof(d->'id') IS DISTINCT FROM 'string' OR NOT fountain_private.retention_id(rec.id) OR rec.kind NOT IN('page','database','row','version','comment','collaboration','wiki_page','site','form','automation','transcript','attachment','attachment_cloud','attachment_chunk')
   OR rec.ownership NOT IN('owned','shared') OR rec.ownership='shared' AND rec.kind NOT IN('attachment','attachment_cloud','attachment_chunk') OR rec.kind IN('page','database','row') AND (rec.generation IS NULL OR rec.generation!~'^[a-f0-9]{32}$') OR rec.kind NOT IN('page','database','row') AND rec.generation IS NOT NULL THEN RAISE EXCEPTION 'Malformed retained snapshot row' USING ERRCODE='PT409';END IF;
  IF rec.kind='page' AND rec.id<>m->>'root_id' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='page' AND e.id=d->>'parent_id')
   OR rec.kind='database' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='page' AND e.id IN(d->>'page_id',d->>'parent_id'))
   OR rec.kind='row' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='database' AND e.id=d->>'database_id')
   OR rec.kind IN('version','comment','wiki_page','site','transcript') AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='page' AND e.id=d->>'page_id')
   OR rec.kind='collaboration' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='page' AND e.id=rec.id)
   OR rec.kind IN('form','automation') AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='database' AND e.id=d->>'database_id') THEN RAISE EXCEPTION 'Retained ownership edge is missing' USING ERRCODE='PT409';END IF;
  IF rec.ownership='owned' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_identity_reservations r WHERE r.workspace_id=p_ws AND r.record_id=p_record AND r.kind=rec.kind AND r.id=rec.id AND (rec.generation IS NULL OR rec.generation=r.generation)) THEN RAISE EXCEPTION 'Retained reservation is missing' USING ERRCODE='PT409';END IF;
  IF rec.kind IN('page','database','row') AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_provenance p WHERE p.workspace_id=p_ws AND p.record_id=p_record AND p.kind=rec.kind AND p.id=rec.id AND p.generation=rec.generation) THEN RAISE EXCEPTION 'Retained provenance is missing' USING ERRCODE='PT409';END IF;
  IF rec.kind IN('page','version','row','collaboration') THEN
   manifest:=NULL;
   IF rec.kind='row' THEN SELECT e.data::jsonb INTO manifest FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='database' AND e.id=d->>'database_id';END IF;
   IF EXISTS(SELECT 1 FROM fountain_private.retention_references(rec.kind,d,manifest) x WHERE NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='attachment' AND e.id=x)) THEN RAISE EXCEPTION 'Retained document references an omitted attachment snapshot' USING ERRCODE='PT409';END IF;
  END IF;
  IF rec.kind='attachment_chunk' AND rec.id IS DISTINCT FROM encode(sha256(convert_to('['||to_json(d->>'attachment_id')::text||','||(d->>'offset')||']','UTF8')),'hex') THEN RAISE EXCEPTION 'Retained file manifest identity is invalid' USING ERRCODE='PT409';END IF;
  IF rec.kind='attachment' THEN
   IF jsonb_typeof(d->'size') IS DISTINCT FROM 'number' OR d->>'size'!~'^[0-9]{1,10}$' OR (d->>'size')::bigint>5000000000 THEN RAISE EXCEPTION 'Invalid retained attachment size' USING ERRCODE='PT409';END IF;
   expected_size:=(d->>'size')::bigint;position:=0;
   SELECT e.data::jsonb INTO manifest FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='attachment_cloud' AND e.id=rec.id;
   IF FOUND THEN
    PERFORM fountain_cloud.storage_gc_layout(manifest,rec.id,false);
    IF (manifest->>'size')::bigint IS DISTINCT FROM expected_size OR d ? 'sha256' AND manifest ? 'sha256' AND d->>'sha256' IS DISTINCT FROM manifest->>'sha256' THEN RAISE EXCEPTION 'Retained cloud overlay differs from original metadata' USING ERRCODE='PT409';END IF;
   END IF;
   IF d ? 'data' THEN
    IF jsonb_typeof(d->'data') IS DISTINCT FROM 'string' OR octet_length(decode(d->>'data','base64'))<>expected_size OR d ? 'sha256' AND (d->>'sha256'!~'^[a-f0-9]{64}$' OR encode(sha256(decode(d->>'data','base64')),'hex') IS DISTINCT FROM d->>'sha256') OR manifest ? 'sha256' AND encode(sha256(decode(d->>'data','base64')),'hex') IS DISTINCT FROM manifest->>'sha256' THEN RAISE EXCEPTION 'Invalid retained inline bytes' USING ERRCODE='PT409';END IF;
    IF manifest IS NULL AND EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=p_ws AND r.record_id=p_record AND r.attachment_id=rec.id) THEN RAISE EXCEPTION 'Inline retained pins require a matching cloud overlay' USING ERRCODE='PT409';END IF;
   END IF;
   IF NOT d ? 'data' OR manifest IS NOT NULL THEN
    FOR byte_pin IN SELECT * FROM fountain_private.retention_attachment_refs x WHERE x.workspace_id=p_ws AND x.record_id=p_record AND x.attachment_id=rec.id ORDER BY x."offset" LOOP
     IF byte_pin."offset"<>position OR byte_pin.size<>least(4194304,expected_size-position) OR byte_pin.size<=0 OR byte_pin.sha256!~'^[a-f0-9]{64}$' OR byte_pin.storage_kind NOT IN('blob','file','cloud') THEN RAISE EXCEPTION 'Invalid retained immutable byte layout' USING ERRCODE='PT409';END IF;
     IF byte_pin.storage_kind='blob' AND byte_pin.physical_id<>rec.id OR byte_pin.storage_kind='file' AND byte_pin.physical_id<>byte_pin.sha256 THEN RAISE EXCEPTION 'Invalid retained physical identity' USING ERRCODE='PT409';END IF;
     IF byte_pin.storage_kind='file' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='attachment_chunk' AND e.data::jsonb->>'attachment_id'=rec.id AND (e.data::jsonb->>'offset')::bigint=byte_pin."offset" AND (e.data::jsonb->>'size')::bigint=byte_pin.size AND e.data::jsonb->>'sha256'=byte_pin.sha256) THEN RAISE EXCEPTION 'Retained file pin has no manifest' USING ERRCODE='PT409';END IF;
     IF byte_pin.storage_kind='cloud' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data::jsonb->'cloud_chunks')='array' THEN e.data::jsonb->'cloud_chunks' ELSE '[]'::jsonb END) x WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.id=rec.id AND e.kind IN('attachment','attachment_cloud') AND x->>'attachmentId'=byte_pin.physical_id AND (x->>'offset')::bigint=byte_pin."offset" AND (x->>'size')::bigint=byte_pin.size AND x->>'sha256'=byte_pin.sha256) THEN RAISE EXCEPTION 'Retained cloud pin has no manifest' USING ERRCODE='PT409';END IF;
     IF (p_portable OR byte_pin.storage_kind='blob') AND NOT EXISTS(SELECT 1 FROM fountain_private.attachment_chunks c WHERE c.workspace_id=p_ws AND c.attachment_id=rec.id AND c."offset"=byte_pin."offset" AND octet_length(c.data)=byte_pin.size AND encode(sha256(c.data),'hex')=byte_pin.sha256) THEN RAISE EXCEPTION 'Retained portable bytes do not match pin' USING ERRCODE='PT409';END IF;
     position:=position+byte_pin.size;
    END LOOP;
    IF position<>expected_size THEN RAISE EXCEPTION 'Retained byte layout is incomplete' USING ERRCODE='PT409';END IF;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM fountain_private.retention_identity_reservations r WHERE r.workspace_id=p_ws AND r.record_id=p_record AND (r.generation!~'^[a-f0-9]{32}$' OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind=r.kind AND e.id=r.id AND e.ownership='owned')))
  OR EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=p_ws AND r.record_id=p_record AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='attachment' AND e.id=r.attachment_id)) THEN RAISE EXCEPTION 'Orphan retained reservation/pin' USING ERRCODE='PT409';END IF;
 FOR rec IN SELECT * FROM fountain_private.retention_provenance WHERE workspace_id=p_ws AND record_id=p_record LOOP
  IF rec.generation!~'^[a-f0-9]{32}$' OR rec.kind NOT IN('page','database','row') OR rec.creator_cause NOT IN('human','automation','import','public_form','system','unknown') OR rec.editor_cause NOT IN('human','automation','import','public_form','system','unknown') OR rec.editor_id IS NULL AND rec.edited_at IS NOT NULL OR (rec.manager_id IS NULL) IS DISTINCT FROM (rec.manager_at IS NULL) OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind=rec.kind AND e.id=rec.id AND e.generation=rec.generation) THEN RAISE EXCEPTION 'Invalid retained provenance' USING ERRCODE='PT409';END IF;
 END LOOP;
 FOR rec IN SELECT * FROM fountain_private.retention_links WHERE workspace_id=p_ws AND record_id=p_record LOOP
  d:=rec.data::jsonb;
  IF rec.kind<>'row' OR jsonb_typeof(d)<>'object' OR NOT(d ?& ARRAY['generation','before','after']) OR d-ARRAY['generation','before','after']<>'{}'::jsonb OR d->>'generation'!~'^[a-f0-9]{32}$' OR jsonb_typeof(d->'before')<>'array' OR jsonb_typeof(d->'after')<>'array' THEN RAISE EXCEPTION 'Invalid retained dependency journal' USING ERRCODE='PT409';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements((d->'before')||(d->'after')) x WHERE jsonb_typeof(x)<>'string' OR NOT fountain_private.retention_id(x#>>'{}')) OR (SELECT COALESCE(jsonb_agg(x.value ORDER BY x.ordinal),'[]'::jsonb) FROM jsonb_array_elements(d->'before') WITH ORDINALITY x(value,ordinal) WHERE NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities e WHERE e.workspace_id=p_ws AND e.record_id=p_record AND e.kind='row' AND to_jsonb(e.id)=x.value)) IS DISTINCT FROM d->'after' THEN RAISE EXCEPTION 'Retained dependency journal removes unrelated IDs' USING ERRCODE='PT409';END IF;
 END LOOP;
END $$;
ALTER FUNCTION fountain_private.retention_validate_record(text,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_validate_record(text,text,boolean) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

-- The Python backend verifies local file safety/hash with bounded reads before
-- staging one chunk. This private helper independently verifies the retained pin.
CREATE FUNCTION fountain_cloud.retention_stage_blob(p_workspace text,p_record text,p_attachment text,p_offset bigint,p_bytes bytea) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_bytes bytea;
BEGIN
 IF current_setting('fountain.workspace_id',true) IS DISTINCT FROM p_workspace OR NOT fountain_private.retention_id(p_workspace) OR p_record IS NULL OR p_record!~'^[a-f0-9]{32}$' OR NOT fountain_private.retention_id(p_attachment) OR p_offset IS NULL OR p_offset<0 OR p_bytes IS NULL OR octet_length(p_bytes) NOT BETWEEN 1 AND 4194304 THEN RAISE EXCEPTION 'Invalid retained blob materialization' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace);
 IF NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs r WHERE r.workspace_id=p_workspace AND r.record_id=p_record AND r.storage_kind='file' AND r.attachment_id=p_attachment AND r."offset"=p_offset AND r.size=octet_length(p_bytes) AND r.sha256=encode(sha256(p_bytes),'hex')) THEN RAISE EXCEPTION 'Materialized bytes differ from retained file pin' USING ERRCODE='PT409';END IF;
 SELECT data INTO old_bytes FROM fountain_private.attachment_chunks c WHERE c.workspace_id=p_workspace AND c.attachment_id=p_attachment AND c."offset"=p_offset;
 IF FOUND THEN IF old_bytes IS DISTINCT FROM p_bytes THEN RAISE EXCEPTION 'Existing retained blob differs' USING ERRCODE='PT409';END IF;RETURN;END IF;
 INSERT INTO fountain_private.attachment_chunks VALUES(p_workspace,p_attachment,p_offset,p_bytes);
END $$;
ALTER FUNCTION fountain_cloud.retention_stage_blob(text,text,text,bigint,bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.retention_stage_blob(text,text,text,bigint,bytea) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_cloud.retention_stage_blob(text,text,text,bigint,bytea) TO fountain_backend;

-- Six-table private mutation boundary. A backend SQL client cannot erase pins,
-- mutate a snapshot, or invent a reservation by forging ordinary settings.
CREATE FUNCTION fountain_private.retention_vault_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE ws text;
BEGIN
 ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF current_user<>'postgres' OR current_setting('fountain.retention_transition',true) IS DISTINCT FROM ws OR TG_OP='UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN RAISE EXCEPTION 'Private retention transition required' USING ERRCODE='PT403';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
ALTER FUNCTION fountain_private.retention_vault_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_vault_guard() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE TRIGGER retention_records_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.retention_records FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_vault_guard();
CREATE TRIGGER retention_entities_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.retention_entities FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_vault_guard();
CREATE TRIGGER retention_provenance_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.retention_provenance FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_vault_guard();
CREATE TRIGGER retention_attachment_refs_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.retention_attachment_refs FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_vault_guard();
CREATE TRIGGER retention_identity_reservations_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.retention_identity_reservations FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_vault_guard();
CREATE TRIGGER retention_links_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.retention_links FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_vault_guard();

-- Append-only import for an already checked empty target in one writer
-- transaction. Each call handles one portable row, never the whole closure.
CREATE FUNCTION fountain_cloud.retention_import_row(p_workspace text,p_table text,p_row jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_transition text;required text[];nullable text[];numeric_cols text[];column_name text;v jsonb;rid text;
BEGIN
 IF NOT fountain_private.retention_id(p_workspace) OR current_setting('fountain.workspace_id',true) IS DISTINCT FROM p_workspace OR jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid private retention import' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace);
 CASE p_table
 WHEN 'retention_records' THEN required:=ARRAY['id','data','created_at','updated_at']::text[];nullable:=ARRAY[]::text[];numeric_cols:=ARRAY[]::text[];
 WHEN 'retention_entities' THEN required:=ARRAY['record_id','kind','id','data','created_at','updated_at','generation','ownership']::text[];nullable:=ARRAY['generation']::text[];numeric_cols:=ARRAY[]::text[];
 WHEN 'retention_provenance' THEN required:=ARRAY['record_id','kind','id','generation','creator_id','creator_cause','editor_id','edited_at','editor_cause','manager_id','manager_at']::text[];nullable:=ARRAY['creator_id','editor_id','edited_at','manager_id','manager_at']::text[];numeric_cols:=ARRAY[]::text[];
 WHEN 'retention_attachment_refs' THEN required:=ARRAY['record_id','attachment_id','storage_kind','physical_id','offset','size','sha256']::text[];nullable:=ARRAY[]::text[];numeric_cols:=ARRAY['offset','size']::text[];
 WHEN 'retention_identity_reservations' THEN required:=ARRAY['kind','id','record_id','generation']::text[];nullable:=ARRAY[]::text[];numeric_cols:=ARRAY[]::text[];
 WHEN 'retention_links' THEN required:=ARRAY['record_id','kind','id','data']::text[];nullable:=ARRAY[]::text[];numeric_cols:=ARRAY[]::text[];
 ELSE RAISE EXCEPTION 'Unknown private retention table' USING ERRCODE='22023';END CASE;
 IF NOT(p_row ?& required) OR p_row-required<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid private retention columns' USING ERRCODE='22023';END IF;
 FOREACH column_name IN ARRAY required LOOP
  v:=p_row->column_name;
  IF v='null'::jsonb AND column_name=ANY(nullable) THEN CONTINUE;END IF;
  IF column_name=ANY(numeric_cols) THEN
   IF jsonb_typeof(v)<>'number' OR v#>>'{}' !~'^[0-9]{1,16}$' OR (v#>>'{}')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Invalid private retention numeric field' USING ERRCODE='22023';END IF;
  ELSIF jsonb_typeof(v)<>'string' THEN RAISE EXCEPTION 'Invalid private retention text field' USING ERRCODE='22023';END IF;
 END LOOP;
 rid:=CASE WHEN p_table='retention_records' THEN p_row->>'id' ELSE p_row->>'record_id' END;
 IF rid!~'^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Invalid retained import identity' USING ERRCODE='22023';END IF;
 IF p_table='retention_records' AND EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=p_workspace AND id=rid) THEN RAISE EXCEPTION 'Retained record already exists' USING ERRCODE='PT409';END IF;
 IF p_table<>'retention_records' AND NOT EXISTS(SELECT 1 FROM fountain_private.retention_records r WHERE r.workspace_id=p_workspace AND r.id=rid AND r.xmin=mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid) THEN RAISE EXCEPTION 'Private import requires a new record in the top-level writer transaction' USING ERRCODE='PT409';END IF;
 previous_transition:=current_setting('fountain.retention_transition',true);PERFORM set_config('fountain.retention_transition',p_workspace,true);
 CASE p_table
  WHEN 'retention_records' THEN INSERT INTO fountain_private.retention_records SELECT (jsonb_populate_record(NULL::fountain_private.retention_records,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
  WHEN 'retention_entities' THEN INSERT INTO fountain_private.retention_entities SELECT (jsonb_populate_record(NULL::fountain_private.retention_entities,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
  WHEN 'retention_provenance' THEN INSERT INTO fountain_private.retention_provenance SELECT (jsonb_populate_record(NULL::fountain_private.retention_provenance,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
  WHEN 'retention_attachment_refs' THEN INSERT INTO fountain_private.retention_attachment_refs SELECT (jsonb_populate_record(NULL::fountain_private.retention_attachment_refs,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
  WHEN 'retention_identity_reservations' THEN INSERT INTO fountain_private.retention_identity_reservations SELECT (jsonb_populate_record(NULL::fountain_private.retention_identity_reservations,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
  WHEN 'retention_links' THEN INSERT INTO fountain_private.retention_links SELECT (jsonb_populate_record(NULL::fountain_private.retention_links,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
  ELSE RAISE EXCEPTION 'Unknown private retention table' USING ERRCODE='22023';END CASE;
 IF NOT FOUND THEN PERFORM set_config('fountain.retention_transition',COALESCE(previous_transition,''),true);RAISE EXCEPTION 'Private retained row already exists' USING ERRCODE='PT409';END IF;
 PERFORM set_config('fountain.retention_transition',COALESCE(previous_transition,''),true);
END $$;
ALTER FUNCTION fountain_cloud.retention_import_row(text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.retention_import_row(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_cloud.retention_import_row(text,text,jsonb) TO fountain_backend;
CREATE FUNCTION fountain_cloud.retention_import_finish(p_workspace text,p_record text,p_portable boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('fountain.workspace_id',true) IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Invalid private retention namespace' USING ERRCODE='22023';END IF;
 IF p_portable IS NULL THEN RAISE EXCEPTION 'Invalid retained import byte mode' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace);PERFORM fountain_private.retention_validate_record(p_workspace,p_record,p_portable);
END $$;
ALTER FUNCTION fountain_cloud.retention_import_finish(text,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.retention_import_finish(text,text,boolean) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_cloud.retention_import_finish(text,text,boolean) TO fountain_backend;
-- A caller cannot commit an incomplete append-only record. Ordinary archive
-- and restore finish validation immediately; this also protects staged imports.
CREATE FUNCTION fountain_private.retention_deferred_integrity() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ws text;rid text;
BEGIN
 ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF TG_TABLE_NAME='retention_records' THEN rid:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;ELSE rid:=CASE WHEN TG_OP='DELETE' THEN OLD.record_id ELSE NEW.record_id END;END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws AND id=rid) THEN PERFORM fountain_private.retention_validate_record(ws,rid,false);END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION fountain_private.retention_deferred_integrity() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.retention_deferred_integrity() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE CONSTRAINT TRIGGER retention_records_integrity AFTER INSERT OR UPDATE OR DELETE ON fountain_private.retention_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fountain_private.retention_deferred_integrity();
