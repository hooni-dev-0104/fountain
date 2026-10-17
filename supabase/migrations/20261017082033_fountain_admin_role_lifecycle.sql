-- Lifecycle fences for explicitly assigned workspace administration roles.
-- No assignments, member backfill, Auth identities, or public RPCs are created.
-- Apply only after source review and isolated PostgreSQL verification.

CREATE FUNCTION fountain_private.admin_generation_rotate(p_workspace_id text,p_member_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_changed bigint;
BEGIN
 -- A nonblocking workspace lock prevents Auth DELETE -> mapping cascade from
 -- reversing the human writer's workspace -> Auth SHARE lock order. Retry the
 -- caller on conflict; never leave a successfully unlinked grant reusable.
 IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||p_workspace_id,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN
  RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';
 END IF;
 UPDATE fountain_private.meta AS m
 SET data=to_jsonb(replace(gen_random_uuid()::text,'-',''))
 WHERE m.workspace_id=p_workspace_id
  AND m.key='_admin_member_generation_v1:'||encode(sha256(convert_to(p_member_id,'UTF8')),'hex')
  AND m.data IS DISTINCT FROM 'null'::jsonb;
 GET DIAGNOSTICS v_changed=ROW_COUNT;
 RETURN v_changed>0;
END $$;
ALTER FUNCTION fountain_private.admin_generation_rotate(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.admin_generation_rotate(text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;

CREATE FUNCTION fountain_private.admin_member_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_old_email text;v_new_email text;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'entities' OR TG_OP NOT IN('UPDATE','DELETE') THEN
  RAISE EXCEPTION 'Invalid admin member trigger' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.kind='member' THEN PERFORM fountain_private.admin_generation_rotate(OLD.workspace_id,OLD.id);END IF;
  RETURN OLD;
 END IF;
 IF OLD.kind='member' THEN
  v_old_email:=CASE WHEN jsonb_typeof(OLD.data->'email')='string' THEN OLD.data->>'email' END;
  v_new_email:=CASE WHEN jsonb_typeof(NEW.data->'email')='string' THEN NEW.data->>'email' END;
  -- Domain member writes normalize email. Internal string changes revoke
  -- conservatively, including case/whitespace-only changes, identically to Python.
  IF NEW.kind<>'member' OR NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id
   OR COALESCE(NEW.data->'active','true'::jsonb) IS DISTINCT FROM 'true'::jsonb
   OR COALESCE(NEW.data->>'role','') NOT IN('member','admin')
   OR v_old_email IS DISTINCT FROM v_new_email THEN
   PERFORM fountain_private.admin_generation_rotate(OLD.workspace_id,OLD.id);
  END IF;
 END IF;
 IF NEW.kind='member' AND(OLD.kind<>'member' OR NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id) THEN
  PERFORM fountain_private.admin_generation_rotate(NEW.workspace_id,NEW.id);
 END IF;
 -- No hidden entity deletes or revision increments: the staged kernel counts
 -- only the explicit member/meta changes in its acknowledgment.
 RETURN NEW;
END $$;
ALTER FUNCTION fountain_private.admin_member_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.admin_member_event() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE TRIGGER fountain_admin_member_update AFTER UPDATE ON fountain_private.entities
 FOR EACH ROW WHEN(OLD.kind='member' OR NEW.kind='member') EXECUTE FUNCTION fountain_private.admin_member_event();
CREATE TRIGGER fountain_admin_member_delete AFTER DELETE ON fountain_private.entities
 FOR EACH ROW WHEN(OLD.kind='member') EXECUTE FUNCTION fountain_private.admin_member_event();

CREATE FUNCTION fountain_private.admin_mapping_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_target record;v_revision bigint;v_access bigint;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'identity_mapping' THEN
  RAISE EXCEPTION 'Invalid admin identity trigger' USING ERRCODE='22023';
 END IF;
 -- AFTER runs after the existing BEFORE account mapping guard. Process every
 -- affected member once, including old/new namespaces on trusted mapping moves.
 FOR v_target IN
  SELECT DISTINCT x.workspace_id COLLATE "C" AS workspace_id,x.member_id COLLATE "C" AS member_id FROM(
   SELECT OLD.workspace_id AS workspace_id,OLD.member_id AS member_id WHERE TG_OP IN('UPDATE','DELETE')
   UNION ALL SELECT NEW.workspace_id,NEW.member_id WHERE TG_OP IN('INSERT','UPDATE')) x
  ORDER BY workspace_id,member_id
 LOOP
  IF fountain_private.admin_generation_rotate(v_target.workspace_id,v_target.member_id)
   AND current_setting('fountain.admin_mapping_staged',true) IS DISTINCT FROM v_target.workspace_id THEN
   -- Account RPCs read these current counters later in account_touch. External
   -- GoTrue Auth cascades have no touch, so they must publish their own fence.
   v_revision:=fountain_cloud.store_revision(v_target.workspace_id,'_entity_revision');
   v_access:=fountain_cloud.store_revision(v_target.workspace_id,'access_revision');
   IF v_revision>=9007199254740991 OR v_access>=9007199254740991 THEN
    RAISE EXCEPTION 'Revision limit exceeded' USING ERRCODE='PT413';
   END IF;
   INSERT INTO fountain_private.meta(workspace_id,key,data)
   VALUES(v_target.workspace_id,'access_revision',to_jsonb(v_access+1)),
         (v_target.workspace_id,'_entity_revision',to_jsonb(v_revision+1))
   ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
ALTER FUNCTION fountain_private.admin_mapping_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.admin_mapping_event() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE TRIGGER fountain_admin_mapping AFTER INSERT OR UPDATE OR DELETE ON fountain_private.identity_mapping
 FOR EACH ROW EXECUTE FUNCTION fountain_private.admin_mapping_event();

CREATE OR REPLACE FUNCTION fountain_cloud.member_deprovision_preflight(p_workspace_id text,p_changes jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_targets jsonb;v_ids text[];v_delete_ids text[];v_users uuid[];v_mapped_users uuid[];v_current_users uuid[];v_user uuid;v_target record;v_admin_suppress text;
BEGIN
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'deleted',x.deleted) ORDER BY x.id COLLATE "C"),'[]'::jsonb),COALESCE(array_agg(x.id ORDER BY x.id COLLATE "C"),ARRAY[]::text[]) INTO v_targets,v_ids
 FROM(SELECT c.value->>'id' AS id,bool_or(c.value->>'op'='delete') AS deleted FROM jsonb_array_elements(p_changes) c
  WHERE c.value->>'kind'='member' AND jsonb_typeof(c.value->'id')='string' AND length(c.value->>'id') BETWEEN 1 AND 160
   AND(c.value->>'op'='delete' OR(c.value->>'op'='put' AND c.value->'data'->'active'='false'::jsonb)) GROUP BY c.value->>'id') x;
 IF cardinality(v_ids)=0 THEN RETURN;END IF;
 SELECT COALESCE(array_agg(j.value->>'id' ORDER BY (j.value->>'id') COLLATE "C"),ARRAY[]::text[]) INTO v_delete_ids FROM jsonb_array_elements(v_targets) j WHERE j.value->'deleted'='true'::jsonb;
 -- Preserve unknown local creates as well as password/relink operations. Do not
 -- cancel/forget an Admin request which can still publish after this transaction.
 IF EXISTS(SELECT 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=ANY(v_ids) AND i.state IN('prepared','attempted')) THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 SELECT COALESCE(array_agg(m.auth_user_id ORDER BY m.auth_user_id),ARRAY[]::uuid[]) INTO v_mapped_users FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids);
 SELECT COALESCE(array_agg(x.user_id ORDER BY x.user_id),ARRAY[]::uuid[]) INTO v_users FROM(
  SELECT m.auth_user_id AS user_id FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids)
  UNION SELECT i.target_user_id FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=ANY(v_ids)
  UNION SELECT u.auth_user_id FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=p_workspace_id AND u.member_id=ANY(v_ids)) x;
 PERFORM 1 FROM auth.users u WHERE u.id=ANY(v_users) ORDER BY u.id FOR SHARE OF u NOWAIT;
 FOREACH v_user IN ARRAY v_users LOOP
  IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:auth-account:'||v_user::text,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 END LOOP;
 -- Same key namespace as account_user_lock, without waiting on cross-ws issuers.
 -- Mapping DELETE's trigger reacquires our held global key reentrantly.
 PERFORM 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids) ORDER BY m.auth_user_id FOR UPDATE OF m NOWAIT;
 SELECT COALESCE(array_agg(m.auth_user_id ORDER BY m.auth_user_id),ARRAY[]::uuid[]) INTO v_current_users FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids);
 IF v_current_users IS DISTINCT FROM v_mapped_users THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 PERFORM 1 FROM fountain_cloud.session_vault v WHERE v.workspace_id=p_workspace_id AND v.user_id=ANY(v_mapped_users) AND v.revoked_at_ms IS NULL ORDER BY v.hash FOR UPDATE OF v NOWAIT;
 -- No foreign workspace is changed; its pending intent nevertheless remains a
 -- global fence for the shared Auth UUID, regardless of kind/create/relink.
 PERFORM 1 FROM fountain_cloud.account_intents i WHERE i.target_user_id=ANY(v_users) AND i.state IN('prepared','attempted') ORDER BY i.target_user_id,i.workspace_id,i.member_id FOR SHARE OF i NOWAIT;
 IF FOUND THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 PERFORM 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=ANY(v_ids) ORDER BY i.member_id FOR UPDATE OF i NOWAIT;
 PERFORM 1 FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=p_workspace_id AND u.member_id=ANY(v_ids) ORDER BY u.member_id FOR UPDATE OF u NOWAIT;
 -- Used AND unused setup claims must not re-authorize a recreated member ID.
 PERFORM 1 FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=p_workspace_id AND c.member_id=ANY(v_delete_ids) ORDER BY c.member_id,c.nonce_hash FOR UPDATE OF c NOWAIT;
 -- Historical unlink/terminal UUIDs are locks/fences only. If such a UUID now
 -- belongs to another member, do NOT revoke that other member's current sessions.
 FOREACH v_user IN ARRAY v_mapped_users LOOP PERFORM fountain_cloud.account_revoke(p_workspace_id,v_user);END LOOP;
 FOR v_target IN SELECT j.value FROM jsonb_array_elements(v_targets) j LOOP
  IF v_target.value->'deleted'='true'::jsonb THEN
   -- The staged kernel owns its exact revision count. Suppress only this
   -- mapping deletion's extra counter/signal; generation rotation still occurs.
   v_admin_suppress:=current_setting('fountain.admin_mapping_staged',true);
   PERFORM set_config('fountain.admin_mapping_staged',p_workspace_id,true);
   BEGIN
    DELETE FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=v_target.value->>'id';
   EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('fountain.admin_mapping_staged',COALESCE(v_admin_suppress,''),true);
    RAISE;
   END;
   PERFORM set_config('fountain.admin_mapping_staged',COALESCE(v_admin_suppress,''),true);
   DELETE FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=v_target.value->>'id' AND i.state NOT IN('prepared','attempted');
   DELETE FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=p_workspace_id AND u.member_id=v_target.value->>'id';
   DELETE FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=p_workspace_id AND c.member_id=v_target.value->>'id';
  END IF;
 END LOOP;
 -- The unchanged kernel checks FINAL usable mapped owners after these removals.
 -- Every later validation/last-owner/revision error rolls back revocation,
 -- mapping epochs, terminal cleanup and entity writes together.
 -- active:false keeps mapping but old vault sessions stay revoked on reactivation.
 -- DELETE+same-ID recreation cannot recover old terminal receipts/unlink proof.
 -- Re-provision explicitly; never adopt an existing Auth identity by email/ID.
 -- Auth users/sessions and other workspaces are never mutated by this helper.
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';
END $$;
ALTER FUNCTION fountain_cloud.member_deprovision_preflight(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.member_deprovision_preflight(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;


-- Bounded server-only generation index, avoiding one discovery round/member.
-- Unchanged snapshot kernel, budgets and former projection branches otherwise.
CREATE OR REPLACE FUNCTION fountain_cloud.store_snapshot_locked(p_context jsonb,p_principal jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
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
 SELECT COALESCE(jsonb_agg(jsonb_build_object('key',keys.key,'value',
  CASE WHEN keys.key='admin_member_generations_v1' THEN (
   SELECT COALESCE(jsonb_object_agg(g.key,g.data),'{}'::jsonb)
   FROM fountain_private.meta g WHERE g.workspace_id=ws AND g.key ~ '^_admin_member_generation_v1:[a-f0-9]{64}$'
  ) WHEN keys.key='wiki_page_headers_v1' THEN (
   SELECT COALESCE(jsonb_agg(CASE WHEN e.data->'id' IS DISTINCT FROM to_jsonb(e.id) THEN 'null'::jsonb ELSE (
    SELECT COALESCE(jsonb_object_agg(field.key,field.value),'{}'::jsonb)
    FROM jsonb_each(e.data) field WHERE field.key=ANY(ARRAY['id','title','icon','parent_id','teamspace_id','owner_id','permissions','archived','deleted','deleted_at','locked','revision','is_wiki','verification','created_at','updated_at'])
   ) END ORDER BY e.id COLLATE "C"),'[]'::jsonb)
   FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='page'
  ) WHEN keys.key='database_verification_rows_v1' THEN (
   WITH database_source AS (
    SELECT e.id,e.data,CASE WHEN jsonb_typeof(e.data->'properties')='array' THEN e.data->'properties' ELSE '[]'::jsonb END AS properties
    FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='database'
   ), database_projection AS (
    SELECT d.id,CASE WHEN d.data->'id' IS DISTINCT FROM to_jsonb(d.id)
     OR jsonb_typeof(d.data->'properties') IS DISTINCT FROM 'array'
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.properties) p WHERE jsonb_typeof(p) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR length(p->>'id') NOT BETWEEN 1 AND 160 OR jsonb_typeof(p->'type') IS DISTINCT FROM 'string')
     OR (SELECT count(*) FROM jsonb_array_elements(d.properties))<>(SELECT count(DISTINCT p->>'id') FROM jsonb_array_elements(d.properties) p)
     OR (SELECT count(*) FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='owner')>1
     OR (SELECT count(*) FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='verification')>1
     THEN 'null'::jsonb
     WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='owner')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='verification') THEN
      (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(d.data) f
       WHERE f.key=ANY(ARRAY['id','name','title','icon','parent_id','owner_id','teamspace_id','permissions','row_permissions','archived','deleted','deleted_at','created_at','updated_at']))
      ||jsonb_build_object('properties',(
       SELECT jsonb_agg((SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(p.value) f
        WHERE f.key=ANY(ARRAY['id','name','type','generation','initial_default','limit','default','owner_property_id'])) ORDER BY p.ordinality)
       FROM jsonb_array_elements(d.properties) WITH ORDINALITY p(value,ordinality)
       WHERE p.value->>'type' IN ('owner','verification')
        OR p.ordinality=(SELECT min(t.ordinality) FROM jsonb_array_elements(d.properties) WITH ORDINALITY t(value,ordinality) WHERE t.value->>'type'='title')
        OR (d.data->'row_permissions'->>'mode'='assigned' AND p.value->'id'=d.data->'row_permissions'->'property_id')
      )) ELSE NULL END AS data
    FROM database_source d
   ), selected_databases AS (
    SELECT * FROM database_projection WHERE data IS NOT NULL
   ), selected_rows AS (
    SELECT e.id,CASE WHEN e.data->'id' IS DISTINCT FROM to_jsonb(e.id)
     OR jsonb_typeof(e.data->'properties') IS DISTINCT FROM 'object' THEN 'null'::jsonb ELSE
     (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data) f
      WHERE f.key=ANY(ARRAY['id','database_id','owner_id','permissions','archived','deleted','deleted_at','created_at','updated_at','verification_cycle']))
     ||jsonb_build_object('properties',(
      SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data->'properties') f
      WHERE f.key IN (SELECT p->>'id' FROM jsonb_array_elements(d.data->'properties') p WHERE p->>'type' IN ('owner','title'))
       OR (d.data->'row_permissions'->>'mode'='assigned' AND to_jsonb(f.key)=d.data->'row_permissions'->'property_id')
     ),'verification',CASE WHEN jsonb_typeof(e.data->'verification')='object' THEN
      (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data->'verification') f WHERE f.key=ANY(ARRAY['generation','verified_by','verified_at','expires_at']))
      ELSE e.data->'verification' END)
     ||CASE WHEN e.data ? '_owner_generations' THEN jsonb_build_object('_owner_generations',
       CASE WHEN jsonb_typeof(e.data->'_owner_generations')='object' THEN
        (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data->'_owner_generations') f
         WHERE f.key IN (SELECT p->>'id' FROM jsonb_array_elements(d.data->'properties') p WHERE p->>'type'='owner'))
       ELSE e.data->'_owner_generations' END) ELSE '{}'::jsonb END END AS data
    FROM fountain_private.entities e JOIN selected_databases d ON d.data<>'null'::jsonb AND e.data->'database_id'=d.data->'id'
    WHERE e.workspace_id=ws AND e.kind='row' AND e.data ? 'verification'
   )
   SELECT jsonb_build_object('databases',(SELECT COALESCE(jsonb_agg(d.data ORDER BY d.id COLLATE "C"),'[]'::jsonb) FROM selected_databases d),
    'rows',(SELECT COALESCE(jsonb_agg(r.data ORDER BY r.id COLLATE "C"),'[]'::jsonb) FROM selected_rows r))
  ) ELSE m.data END,'present',CASE WHEN keys.key IN ('wiki_page_headers_v1','database_verification_rows_v1','admin_member_generations_v1') THEN true ELSE m.key IS NOT NULL END)
  ORDER BY keys.key COLLATE "C"),'[]'::jsonb)
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
