-- Restore is a distinct administrator capability in the Edge service. This
-- service-only RPC revalidates the locked live Auth/storage context before
-- returning the existing body-free sharing review DTO.
CREATE FUNCTION public.fountain_cloud_content_restore_review(p_context jsonb,p_expected_revision bigint,p_kind text,p_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;archived jsonb;
BEGIN
 ws:=fountain_private.content_rpc_guard(p_context,p_expected_revision);
 IF p_kind IS DISTINCT FROM 'page' OR p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid restore review' USING ERRCODE='22023';END IF;
 SELECT data->'archived' INTO archived FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Content not found' USING ERRCODE='PT404';END IF;
 IF archived IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Page is not in trash' USING ERRCODE='PT409';END IF;
 RETURN public.fountain_cloud_content_permissions(p_context,p_expected_revision,p_kind,p_id);
END $f$;

-- Expose a trashed selected page's original placement without treating any
-- trashed ancestor as an active destination. The existing complete structural
-- validator still supplies the same public location metadata shape.
CREATE OR REPLACE FUNCTION fountain_private.content_location(p_ws text,p_kind text,p_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE archived jsonb;locations jsonb;item jsonb;status jsonb;
BEGIN
 SELECT header->'archived' INTO archived FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind=p_kind AND id=p_id;
 IF p_kind<>'page' OR archived IS DISTINCT FROM 'true'::jsonb THEN RETURN fountain_private.content_locations(p_ws,p_kind,p_id)->0;END IF;
 locations:=fountain_private.content_locations(p_ws,p_kind,p_id,true);
 IF locations IS NULL THEN RETURN NULL;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(locations) LOOP
  SELECT jsonb_build_object('id',data->'id','active',COALESCE(data->'active','true'::jsonb),'archived',COALESCE(data->'archived','false'::jsonb),'deleted',COALESCE(data->'deleted','false'::jsonb),'deleted_at',COALESCE(data->'deleted_at','null'::jsonb)) INTO status
  FROM fountain_private.entities WHERE workspace_id=p_ws AND kind=item->>'kind' AND id=item->>'id';
  IF NOT FOUND OR status->'id' IS DISTINCT FROM item->'id' OR status->'active' IS DISTINCT FROM 'true'::jsonb OR status->'archived' IS DISTINCT FROM 'false'::jsonb OR status->'deleted' IS DISTINCT FROM 'false'::jsonb OR status->'deleted_at' IS DISTINCT FROM 'null'::jsonb THEN RETURN NULL;END IF;
 END LOOP;
 RETURN locations->0;
END $f$;

CREATE OR REPLACE FUNCTION public.fountain_cloud_content_change(p_context jsonb,p_expected_revision bigint,p_request_id uuid,p_digest text,p_canonical text,p_kind text,p_id text,p_review_revision text,p_operation text,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;actor text;recorded text;source fountain_private.entities;pub record;permissions jsonb;changed jsonb;changes jsonb:='[]';stamp text;audit_id text;previous_actor text;access_rev bigint;target text;reason jsonb;revision bigint;before_provenance fountain_private.content_provenance;page_revision numeric;container jsonb;parent_id text;seen text[];team_id text;team jsonb;
BEGIN
 -- Authentication precedes receipt ACK. Replay deliberately ignores old entity
 -- revision after proving this exact authenticated request already committed.
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';actor:=p_context->>'memberId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_request_id IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>1048576 OR p_kind IS NULL OR p_kind NOT IN('page','database','row') OR p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 160 OR p_review_revision IS NULL OR p_review_revision !~ '^[a-f0-9]{64}$' OR p_operation IS NULL OR p_operation NOT IN('set_private','revoke_member','remove_group','replace_permissions','unpublish','restore_original','restore_private') OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid content change' USING ERRCODE='22023';END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'kind',p_kind,'id',p_id,'reviewRevision',p_review_revision,'operation',p_operation,'value',p_value) THEN RAISE EXCEPTION 'Invalid change digest' USING ERRCODE='22023';END IF;
 SELECT digest INTO recorded FROM fountain_cloud.content_change_receipts WHERE workspace_id=ws AND member_id=actor AND session_hash=p_context->>'sessionHash' AND request_id=p_request_id;
 IF FOUND THEN IF recorded<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('applied',true);END IF;
 PERFORM fountain_private.content_rpc_guard(p_context,p_expected_revision);
 IF fountain_private.content_review_revision(ws,p_kind,p_id) IS DISTINCT FROM p_review_revision THEN RAISE EXCEPTION 'CONTENT_REVIEW_CHANGED' USING ERRCODE='PT409';END IF;
 SELECT * INTO source FROM fountain_private.entities WHERE workspace_id=ws AND kind=p_kind AND id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Content not found' USING ERRCODE='PT404';END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00';
 IF p_operation IN('restore_original','restore_private') THEN
  IF p_kind<>'page' OR p_value<>'{}' THEN RAISE EXCEPTION 'Invalid restore change' USING ERRCODE='22023';END IF;
  IF source.data->'archived' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Page is not in trash' USING ERRCODE='PT409';END IF;
  IF source.data->'id' IS DISTINCT FROM to_jsonb(p_id) OR COALESCE(source.data->'active','true'::jsonb) IS DISTINCT FROM 'true'::jsonb
   OR EXISTS(SELECT 1 FROM jsonb_each(source.data) f WHERE f.key IN('deleted','locked','is_wiki') AND jsonb_typeof(f.value)<>'boolean') THEN RAISE EXCEPTION 'Invalid trashed page' USING ERRCODE='PT409';END IF;
  IF fountain_private.content_truth(source.data->'locked') THEN RAISE EXCEPTION 'Page is locked' USING ERRCODE='PT423';END IF;
  IF jsonb_typeof(source.data->'revision') IS DISTINCT FROM 'number' OR source.data->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'Invalid page revision' USING ERRCODE='PT409';END IF;
  page_revision:=(source.data->>'revision')::numeric;
  IF page_revision<0 OR page_revision>=9007199254740991 OR trunc(page_revision)<>page_revision THEN RAISE EXCEPTION 'Invalid page revision' USING ERRCODE='PT409';END IF;
  SELECT * INTO before_provenance FROM fountain_private.content_provenance WHERE workspace_id=ws AND kind='page' AND id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Content history unavailable' USING ERRCODE='PT409';END IF;
  IF p_operation='restore_original' THEN
   -- Validate the complete chain, without treating a depth limit as success.
   -- The workspace advisory lock held by store_context serializes all writers.
   container:=source.data;seen:=ARRAY[p_id];
   LOOP
    IF (container ? 'is_wiki' AND jsonb_typeof(container->'is_wiki')<>'boolean') OR (container->'is_wiki'='true'::jsonb AND container->'parent_id' IS NOT NULL AND container->'parent_id'<>'null'::jsonb) THEN RAISE EXCEPTION 'Invalid original wiki placement' USING ERRCODE='PT409';END IF;
    IF container->'teamspace_id' IS NOT NULL AND container->'teamspace_id'<>'null'::jsonb THEN
     team_id:=container->>'teamspace_id';
     IF jsonb_typeof(container->'teamspace_id')<>'string' OR length(team_id) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid original teamspace' USING ERRCODE='PT409';END IF;
     SELECT data INTO team FROM fountain_private.entities WHERE workspace_id=ws AND kind='teamspace' AND id=team_id;
     IF NOT FOUND OR team->'id' IS DISTINCT FROM to_jsonb(team_id)
      OR COALESCE(team->'active','true'::jsonb) IS DISTINCT FROM 'true'::jsonb
      OR COALESCE(team->'archived','false'::jsonb) IS DISTINCT FROM 'false'::jsonb
      OR COALESCE(team->'deleted','false'::jsonb) IS DISTINCT FROM 'false'::jsonb
      OR COALESCE(team->'deleted_at','null'::jsonb)<>'null'::jsonb
      OR(team ? 'locked' AND jsonb_typeof(team->'locked')<>'boolean') THEN RAISE EXCEPTION 'Original teamspace unavailable' USING ERRCODE='PT409';END IF;
    END IF;
    IF container->'parent_id' IS NULL OR container->'parent_id'='null'::jsonb THEN EXIT;END IF;
    parent_id:=container->>'parent_id';
    IF jsonb_typeof(container->'parent_id')<>'string' OR length(parent_id) NOT BETWEEN 1 AND 160 OR parent_id=ANY(seen) THEN RAISE EXCEPTION 'Invalid original parent chain' USING ERRCODE='PT409';END IF;
    seen:=array_append(seen,parent_id);
    SELECT data INTO container FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id=parent_id;
    IF NOT FOUND OR container->'id' IS DISTINCT FROM to_jsonb(parent_id)
     OR COALESCE(container->'active','true'::jsonb) IS DISTINCT FROM 'true'::jsonb
     OR COALESCE(container->'archived','false'::jsonb) IS DISTINCT FROM 'false'::jsonb
     OR COALESCE(container->'deleted','false'::jsonb) IS DISTINCT FROM 'false'::jsonb
     OR COALESCE(container->'deleted_at','null'::jsonb)<>'null'::jsonb
     OR(container ? 'locked' AND jsonb_typeof(container->'locked')<>'boolean') THEN RAISE EXCEPTION 'Original parent unavailable' USING ERRCODE='PT409';END IF;
   END LOOP;
  END IF;
  changed:=(source.data-'deleted'-'deleted_at')||jsonb_build_object('archived',false,'deleted',false,'revision',page_revision+1,'updated_at',stamp);
  IF p_operation='restore_private' THEN changed:=changed||jsonb_build_object('owner_id',actor,'parent_id',NULL,'teamspace_id',NULL,'permissions',jsonb_build_object('default','private','inherit',false,'members','{}'::jsonb,'groups','{}'::jsonb));END IF;
  changes:=jsonb_build_array(jsonb_build_object('op','put','kind','page','id',p_id,'previousCreatedAt',source.created_at,'data',changed));
  -- The shared locked kernel accepts arbitrary validated internal change counts;
  -- its public request limit does not truncate this complete publication set.
  FOR pub IN SELECT * FROM fountain_private.entities WHERE workspace_id=ws AND kind='site' AND data->>'page_id'=p_id AND fountain_private.content_truth(data->'published') ORDER BY id COLLATE "C" LOOP
   changed:=pub.data||jsonb_build_object('published',false,'updated_at',stamp);
   changes:=changes||jsonb_build_array(jsonb_build_object('op','put','kind','site','id',pub.id,'previousCreatedAt',pub.created_at,'data',changed));
  END LOOP;
 ELSIF p_operation='unpublish' THEN
  IF p_value<>'{}' OR p_kind='row' THEN RAISE EXCEPTION 'Unsupported publication change' USING ERRCODE='22023';END IF;
  FOR pub IN SELECT * FROM fountain_private.entities WHERE workspace_id=ws AND((p_kind='page' AND kind='site' AND data->>'page_id'=p_id) OR(p_kind='database' AND kind='form' AND data->>'database_id'=p_id)) AND fountain_private.content_truth(data->'published') ORDER BY kind COLLATE "C",id COLLATE "C" LOOP
   changed:=pub.data||jsonb_build_object('published',false,'updated_at',stamp);
   changes:=changes||jsonb_build_array(jsonb_build_object('op','put','kind',pub.kind,'id',pub.id,'previousCreatedAt',pub.created_at,'data',changed));
  END LOOP;
 ELSE
  permissions:=CASE WHEN source.data->'permissions' IS NULL OR source.data->'permissions'='null'::jsonb THEN '{"default":"workspace","inherit":true,"members":{},"groups":{}}'::jsonb ELSE source.data->'permissions' END;
  IF p_operation='set_private' THEN
   IF p_value<>'{}' THEN RAISE EXCEPTION 'Invalid private change' USING ERRCODE='22023';END IF;
   permissions:='{"default":"private","inherit":false,"members":{},"groups":{}}';
  ELSIF p_operation='revoke_member' THEN
   IF p_value-ARRAY['member_id']<>'{}' OR jsonb_typeof(p_value->'member_id') IS DISTINCT FROM 'string' OR length(p_value->>'member_id') NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid member change' USING ERRCODE='22023';END IF;
   target:=p_value->>'member_id';reason:=fountain_private.content_access_reason(ws,p_kind,p_id,target);
   IF reason->>'via' IN('resource_owner','workspace_admin') THEN RAISE EXCEPTION 'Implicit owner access cannot be revoked' USING ERRCODE='PT409';END IF;
   IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND id=target) THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='22023';END IF;
   IF fountain_private.content_acl(permissions,target,'{}') IS NULL THEN RAISE EXCEPTION 'Invalid existing permissions' USING ERRCODE='PT409';END IF;
   permissions:=permissions||jsonb_build_object('members',COALESCE(permissions->'members','{}')||jsonb_build_object(target,'none'));
  ELSIF p_operation='remove_group' THEN
   IF p_value-ARRAY['group_id']<>'{}' OR jsonb_typeof(p_value->'group_id') IS DISTINCT FROM 'string' OR length(p_value->>'group_id') NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid group change' USING ERRCODE='22023';END IF;
   target:=p_value->>'group_id';
   IF fountain_private.content_acl(permissions,'','{}') IS NULL OR COALESCE(permissions->'groups'->>target,'none') NOT IN('view','comment','edit','full') THEN RAISE EXCEPTION 'Direct group grant not found' USING ERRCODE='PT409';END IF;
   permissions:=permissions||jsonb_build_object('groups',(permissions->'groups')-target);
  ELSE
   IF p_value-ARRAY['permissions']<>'{}' OR jsonb_typeof(p_value->'permissions') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid permissions' USING ERRCODE='22023';END IF;
   permissions:=p_value->'permissions';
  END IF;
  IF permissions-ARRAY['default','inherit','members','groups']<>'{}' OR fountain_private.content_acl(permissions,'','{}') IS NULL
   OR (SELECT count(*) FROM jsonb_each(COALESCE(permissions->'members','{}')))>1000 OR (SELECT count(*) FROM jsonb_each(COALESCE(permissions->'groups','{}')))>1000
   OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(permissions->'members','{}')) m WHERE length(m.key) NOT BETWEEN 1 AND 160 OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND id=m.key AND data->>'role' IN('owner','admin','member','guest')))
   OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(permissions->'groups','{}')) g WHERE length(g.key) NOT BETWEEN 1 AND 160 OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='group' AND id=g.key)) THEN RAISE EXCEPTION 'Invalid permissions reference' USING ERRCODE='22023';END IF;
  permissions:=jsonb_build_object('default',COALESCE(permissions->>'default','workspace'),'inherit',COALESCE(permissions->'inherit','false'::jsonb),'members',COALESCE(permissions->'members','{}'::jsonb),'groups',COALESCE(permissions->'groups','{}'::jsonb));
  changed:=source.data||jsonb_build_object('permissions',permissions,'updated_at',stamp);
  changes:=jsonb_build_array(jsonb_build_object('op','put','kind',p_kind,'id',p_id,'previousCreatedAt',source.created_at,'data',changed));
 END IF;
 access_rev:=fountain_cloud.store_revision(ws,'access_revision');IF access_rev>=9007199254740991 THEN RAISE EXCEPTION 'Access revision limit reached' USING ERRCODE='PT503';END IF;
 audit_id:=gen_random_uuid()::text;
 changes:=changes||jsonb_build_array(jsonb_build_object('op','meta','key','access_revision','value',access_rev+1),jsonb_build_object('op','put','kind','audit','id',audit_id,'previousCreatedAt',NULL,'data',jsonb_build_object('id',audit_id,'actor',actor,'action','content.admin.'||p_operation,'details',jsonb_build_object('kind',p_kind,'id',p_id,'member_id',p_value->>'member_id','group_id',p_value->>'group_id'),'created_at',stamp,'updated_at',stamp)));
 previous_actor:=current_setting('fountain.content_actor',true);
 PERFORM set_config('fountain.content_actor',jsonb_build_object('workspace_id',ws,'member_id',actor,'cause','human')::text,true);
 BEGIN
  revision:=fountain_cloud.store_apply_changes_locked(ws,p_expected_revision,changes);
  IF p_operation IN('restore_original','restore_private') THEN
   -- Restoring location is administration, not an authored content edit. Normal
   -- page moves keep their existing trigger behavior. Retain the trusted history
   -- exactly and attribute this restore only as management.
   UPDATE fountain_private.content_provenance SET
    creator_id=before_provenance.creator_id,creator_cause=before_provenance.creator_cause,
    editor_id=before_provenance.editor_id,edited_at=before_provenance.edited_at,editor_cause=before_provenance.editor_cause
   WHERE workspace_id=ws AND kind='page' AND id=p_id AND generation=before_provenance.generation;
   IF NOT FOUND THEN RAISE EXCEPTION 'Content history changed' USING ERRCODE='PT409';END IF;
   PERFORM fountain_private.content_manage_target(ws,'page',p_id);
  END IF;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.content_actor',COALESCE(previous_actor,''),true);RAISE;END;
 PERFORM set_config('fountain.content_actor',COALESCE(previous_actor,''),true);
 INSERT INTO fountain_cloud.content_change_receipts(workspace_id,member_id,session_hash,request_id,digest) VALUES(ws,actor,p_context->>'sessionHash',p_request_id,p_digest);
 RETURN jsonb_build_object('applied',true);
END $f$;

REVOKE ALL ON FUNCTION public.fountain_cloud_content_restore_review(jsonb,bigint,text,text) FROM PUBLIC,anon,authenticated,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_content_restore_review(jsonb,bigint,text,text) TO service_role;
