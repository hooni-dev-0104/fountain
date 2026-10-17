-- Run after the pending restore migration in ONE transaction and ALWAYS
-- ROLLBACK. This component suite deliberately stubs storage authentication;
-- it does not prove real Auth/session/capability enforcement in Edge.
SELECT set_config('fountain.restore_test_workspace','fountain-qa-restore-'||replace(gen_random_uuid()::text,'-',''),true);
SELECT set_config('fountain.restore_test_authenticated','true',true);
SELECT set_config('fountain.restore_test_rejections','0',true);
CREATE OR REPLACE FUNCTION fountain_cloud.store_context(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_context->>'workspaceId' IS DISTINCT FROM current_setting('fountain.restore_test_workspace')
  OR current_setting('fountain.restore_test_authenticated')<>'true' THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 PERFORM fountain_cloud.store_lock(p_context->>'workspaceId');
 PERFORM set_config('fountain.workspace_id',p_context->>'workspaceId',true);
 RETURN jsonb_build_object('id',p_context->>'memberId','role','owner','active',true);
END $f$;
CREATE FUNCTION pg_temp.restore_context() RETURNS jsonb LANGUAGE sql AS $f$
 SELECT jsonb_build_object('workspaceId',current_setting('fountain.restore_test_workspace'),'memberId','actor','userId','00000000-0000-4000-8000-000000000001','authSessionId','00000000-0000-4000-8000-000000000002','sessionHash',repeat('a',64),'cacheBinding',repeat('b',32))
$f$;
CREATE FUNCTION pg_temp.restore_put(p_id text,p_patch jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql AS $f$
DECLARE ws text:=current_setting('fountain.restore_test_workspace');data jsonb;
BEGIN
 data:=jsonb_build_object('id',p_id,'title',p_id,'archived',true,'deleted',true,'deleted_at','2026-01-02T00:00:00Z','revision',4,'owner_id','owner','parent_id','parent','teamspace_id','team','permissions','{"default":"workspace","inherit":true,"members":{"guest":"view"},"groups":{}}'::jsonb,'blocks','[{"id":"b","type":"paragraph","text":"preserved body"}]'::jsonb,'collaboration','{"epoch":"same","ops":[1,2]}'::jsonb,'version_ids','["v1"]'::jsonb,'attachment_ids','["a1"]'::jsonb,'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-02T00:00:00Z')||p_patch;
 INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES(ws,'page',p_id,data,data->>'created_at',data->>'updated_at') ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at;
END $f$;
CREATE FUNCTION pg_temp.restore_call(p_id text,p_operation text,p_value jsonb DEFAULT '{}',p_request uuid DEFAULT gen_random_uuid()) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE ctx jsonb:=pg_temp.restore_context();ws text:=ctx->>'workspaceId';rev bigint;review text;canonical text;
BEGIN
 rev:=fountain_cloud.store_revision(ws,'_entity_revision');review:=fountain_private.content_review_revision(ws,'page',p_id);
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id',p_id,'reviewRevision',review,'operation',p_operation,'value',p_value)::text;
 RETURN public.fountain_cloud_content_change(ctx,rev,p_request,encode(sha256(convert_to(canonical,'UTF8')),'hex'),canonical,'page',p_id,review,p_operation,p_value);
END $f$;
CREATE FUNCTION pg_temp.restore_fingerprint() RETURNS text LANGUAGE sql AS $f$
 SELECT md5(jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY kind,id) FROM fountain_private.entities e WHERE workspace_id=current_setting('fountain.restore_test_workspace')),
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY key) FROM fountain_private.meta m WHERE workspace_id=current_setting('fountain.restore_test_workspace')),
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY kind,id) FROM fountain_private.content_provenance p WHERE workspace_id=current_setting('fountain.restore_test_workspace')),
  (SELECT jsonb_agg(to_jsonb(s)) FROM fountain_private.content_search_state s WHERE workspace_id=current_setting('fountain.restore_test_workspace')),
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM fountain_cloud.content_change_receipts r WHERE workspace_id=current_setting('fountain.restore_test_workspace'))
 )::text)
$f$;
CREATE FUNCTION pg_temp.restore_expect(p_id text,p_operation text,p_code text,p_value jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql AS $f$
DECLARE before text:=pg_temp.restore_fingerprint();code text;
BEGIN
 BEGIN PERFORM pg_temp.restore_call(p_id,p_operation,p_value);EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;
 IF code IS DISTINCT FROM p_code THEN RAISE EXCEPTION 'Expected %, received % on %',p_code,code,p_operation;END IF;
 IF before IS DISTINCT FROM pg_temp.restore_fingerprint() THEN RAISE EXCEPTION 'Rejected restore partially mutated state';END IF;
 PERFORM set_config('fountain.restore_test_rejections',(current_setting('fountain.restore_test_rejections')::integer+1)::text,true);
END $f$;
DO $fixtures$
DECLARE ws text:=current_setting('fountain.restore_test_workspace');
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);
 PERFORM set_config('fountain.content_actor',jsonb_build_object('workspace_id',ws,'member_id','author','cause','human')::text,true);
 INSERT INTO fountain_private.entities SELECT ws,'member',id,jsonb_build_object('id',id,'name',id,'role',CASE WHEN id='owner' THEN 'owner' ELSE 'member' END,'active',true,'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM unnest(ARRAY['owner','actor','author','guest']) id;
 INSERT INTO fountain_private.entities VALUES(ws,'teamspace','team','{"id":"team","name":"Team","active":true,"archived":false,"deleted":false,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
 PERFORM pg_temp.restore_put('parent','{"archived":false,"deleted":false,"deleted_at":null,"parent_id":null}');
 UPDATE fountain_private.content_search_state SET ready=true WHERE workspace_id=ws;
END $fixtures$;
DO $success$
#variable_conflict use_column
<<success>>
DECLARE ws text:=current_setting('fountain.restore_test_workspace');ctx jsonb:=pg_temp.restore_context();before_data jsonb;after_data jsonb;history jsonb;after_history jsonb;descendant jsonb;access_before bigint;review jsonb;mode text;id text;rev bigint;
BEGIN
 FOREACH mode IN ARRAY ARRAY['restore_original','restore_private'] LOOP
  id:='문서/'||mode;PERFORM pg_temp.restore_put(id);
  PERFORM pg_temp.restore_put('child-'||mode,jsonb_build_object('archived',false,'deleted',false,'deleted_at',NULL,'parent_id',id));
  SELECT data INTO descendant FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id='child-'||mode;
  INSERT INTO fountain_private.entities SELECT ws,'site','site-'||mode||n,jsonb_build_object('id','site-'||mode||n,'page_id',id,'published',true,'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM generate_series(1,1005) n;
  INSERT INTO fountain_private.entities VALUES(ws,'comment','comment-'||mode,jsonb_build_object('id','comment-'||mode,'page_id',id,'body','unchanged'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
  SELECT data INTO before_data FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND fountain_private.entities.id=success.id;
  SELECT to_jsonb(p)-ARRAY['manager_id','manager_at'] INTO history FROM fountain_private.content_provenance p WHERE workspace_id=ws AND kind='page' AND p.id=success.id;
  access_before:=fountain_cloud.store_revision(ws,'access_revision');rev:=fountain_cloud.store_revision(ws,'_entity_revision');
  review:=public.fountain_cloud_content_restore_review(ctx,rev,'page',id);
  IF review IS DISTINCT FROM public.fountain_cloud_content_permissions(ctx,rev,'page',id) OR review-ARRAY['kind','id','permissions','source_invalid','review_revision']<>'{}' THEN RAISE EXCEPTION 'Review shape diverged';END IF;
  IF pg_temp.restore_call(id,mode)<>'{"applied":true}' THEN RAISE EXCEPTION 'Restore did not acknowledge';END IF;
  SELECT data INTO after_data FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND fountain_private.entities.id=success.id;
  IF after_data->'archived'<>'false' OR after_data->'deleted'<>'false' OR after_data ? 'deleted_at' OR after_data->'revision'<>'5' OR after_data->>'updated_at'=before_data->>'updated_at' THEN RAISE EXCEPTION 'Lifecycle flags/revision invalid';END IF;
  IF (before_data-ARRAY['archived','deleted','deleted_at','revision','updated_at','owner_id','parent_id','teamspace_id','permissions']) IS DISTINCT FROM (after_data-ARRAY['archived','deleted','deleted_at','revision','updated_at','owner_id','parent_id','teamspace_id','permissions']) THEN RAISE EXCEPTION 'Content/collaboration/version reference changed';END IF;
  IF mode='restore_original' AND (before_data-ARRAY['archived','deleted','deleted_at','revision','updated_at']) IS DISTINCT FROM (after_data-ARRAY['archived','deleted','deleted_at','revision','updated_at']) THEN RAISE EXCEPTION 'Original placement/sharing changed';END IF;
  IF mode='restore_private' AND (after_data->>'owner_id'<>'actor' OR after_data->'parent_id'<>'null' OR after_data->'teamspace_id'<>'null' OR after_data->'permissions'<>'{"default":"private","inherit":false,"members":{},"groups":{}}') THEN RAISE EXCEPTION 'Private placement/sharing not isolated';END IF;
  SELECT to_jsonb(p)-ARRAY['manager_id','manager_at'] INTO after_history FROM fountain_private.content_provenance p WHERE workspace_id=ws AND kind='page' AND p.id=success.id;
  IF history IS DISTINCT FROM after_history OR NOT EXISTS(SELECT 1 FROM fountain_private.content_provenance p WHERE workspace_id=ws AND kind='page' AND p.id=success.id AND manager_id='actor' AND manager_at IS NOT NULL) THEN RAISE EXCEPTION 'Authored history changed or management actor absent';END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE workspace_id=ws AND kind='site' AND data->>'page_id'=success.id AND data->'published'<>'false') OR (SELECT count(*) FROM fountain_private.entities e WHERE workspace_id=ws AND kind='site' AND data->>'page_id'=success.id)<>1005 THEN RAISE EXCEPTION 'Publication truncation';END IF;
  IF descendant IS DISTINCT FROM (SELECT data FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND fountain_private.entities.id='child-'||mode) OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='comment' AND data->>'body'='unchanged' AND data->>'page_id'=success.id) THEN RAISE EXCEPTION 'Descendant/comments changed';END IF;
  IF fountain_cloud.store_revision(ws,'access_revision')<>access_before+1 OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='audit' AND data->>'action'='content.admin.'||mode) THEN RAISE EXCEPTION 'Access revision/audit absent';END IF;
 END LOOP;
END $success$;
DO $rejections$
#variable_conflict use_column
DECLARE ws text:=current_setting('fountain.restore_test_workspace');patch jsonb;key text;marker jsonb;code text;ctx jsonb:=pg_temp.restore_context();i integer;
BEGIN
 FOREACH patch IN ARRAY ARRAY['{"archived":false}'::jsonb,'{"archived":"true"}','{"archived":null}','{"revision":null}','{"revision":"4"}','{"revision":-1}','{"revision":1.5}','{"revision":1.0}','{"revision":1.00}','{"revision":9007199254740991}','{"revision":9007199254740992}','{"active":false}','{"active":"true"}','{"active":null}','{"deleted":"true"}','{"deleted":null}','{"locked":"false"}','{"locked":null}','{"is_wiki":"true"}','{"is_wiki":null}'] LOOP
  PERFORM pg_temp.restore_put('reject',patch);PERFORM pg_temp.restore_expect('reject','restore_private','PT409');
 END LOOP;
 PERFORM pg_temp.restore_put('reject','{"locked":true}');PERFORM pg_temp.restore_expect('reject','restore_original','PT423');
 PERFORM pg_temp.restore_put('reject');PERFORM pg_temp.restore_expect('reject','restore_original','22023','{"unexpected":1}');
 FOREACH patch IN ARRAY ARRAY['{"parent_id":"missing"}'::jsonb,'{"parent_id":"reject"}','{"parent_id":false}','{"parent_id":""}','{"teamspace_id":[]}','{"teamspace_id":"missing"}','{"is_wiki":true}'] LOOP
  PERFORM pg_temp.restore_put('reject',patch);PERFORM pg_temp.restore_expect('reject','restore_original','PT409');
 END LOOP;
 -- Every present status marker is validated as a boolean, including JSON null.
 FOREACH key IN ARRAY ARRAY['archived','deleted','active'] LOOP
  FOREACH marker IN ARRAY ARRAY['"false"'::jsonb,'null','0','{}','[]',CASE WHEN key='active' THEN 'false'::jsonb ELSE 'true'::jsonb END] LOOP
   PERFORM pg_temp.restore_put('parent',jsonb_build_object('archived',false,'deleted',false,'deleted_at',NULL,'parent_id',NULL,key,marker));
   PERFORM pg_temp.restore_put('reject');PERFORM pg_temp.restore_expect('reject','restore_original','PT409');
   PERFORM pg_temp.restore_put('parent','{"archived":false,"deleted":false,"deleted_at":null,"parent_id":null}');
   UPDATE fountain_private.entities SET data=(data-ARRAY['active','archived','deleted'])||jsonb_build_object('active',true,'archived',false,'deleted',false,key,marker) WHERE workspace_id=ws AND kind='teamspace' AND id='team';
   PERFORM pg_temp.restore_expect('reject','restore_original','PT409');
   UPDATE fountain_private.entities SET data=(data-ARRAY['active','archived','deleted'])||'{"active":true,"archived":false,"deleted":false}' WHERE workspace_id=ws AND kind='teamspace' AND id='team';
  END LOOP;
 END LOOP;
 FOREACH patch IN ARRAY ARRAY['{"is_wiki":"true"}'::jsonb,'{"is_wiki":null}','{"is_wiki":true,"parent_id":"deep-missing"}','{"locked":null}','{"locked":"false"}','{"deleted_at":"bad"}'] LOOP
  PERFORM pg_temp.restore_put('parent','{"archived":false,"deleted":false,"deleted_at":null,"parent_id":null}'::jsonb||patch);
  PERFORM pg_temp.restore_put('reject');PERFORM pg_temp.restore_expect('reject','restore_original','PT409');
 END LOOP;
 PERFORM pg_temp.restore_put('parent','{"archived":false,"deleted":false,"deleted_at":null,"parent_id":"cycle"}');
 PERFORM pg_temp.restore_put('cycle','{"archived":false,"deleted":false,"deleted_at":null,"parent_id":"parent"}');
 PERFORM pg_temp.restore_expect('reject','restore_original','PT409');
 -- A valid chain deeper than the generic ACL helper's depth64 is accepted in full.
 FOR i IN REVERSE 100..1 LOOP PERFORM pg_temp.restore_put('deep-'||i,jsonb_build_object('archived',false,'deleted',false,'deleted_at',NULL,'parent_id',CASE WHEN i=100 THEN NULL ELSE 'deep-'||(i+1) END));END LOOP;
 PERFORM pg_temp.restore_put('deep-target','{"parent_id":"deep-1"}');PERFORM pg_temp.restore_call('deep-target','restore_original');
 PERFORM pg_temp.restore_put('reject');
 INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(ws,'access_revision','9007199254740991') ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 PERFORM pg_temp.restore_expect('reject','restore_private','PT503');
 UPDATE fountain_private.meta SET data='2' WHERE workspace_id=ws AND key='access_revision';
 INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(ws,'_entity_revision','9007199254740990') ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 PERFORM pg_temp.restore_expect('reject','restore_private','PT413');
 UPDATE fountain_private.meta SET data='30' WHERE workspace_id=ws AND key='_entity_revision';
END $rejections$;
DO $receipt_and_grants$
#variable_conflict use_column
DECLARE ws text:=current_setting('fountain.restore_test_workspace');ctx jsonb:=pg_temp.restore_context();rev bigint;review text;canonical text;digest text;request uuid:=gen_random_uuid();before text;code text;kind text;
BEGIN
 PERFORM pg_temp.restore_put('receipt','{"parent_id":null,"teamspace_id":null}');
 rev:=fountain_cloud.store_revision(ws,'_entity_revision');review:=fountain_private.content_review_revision(ws,'page','receipt');
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','receipt','reviewRevision',review,'operation','restore_private','value','{}'::jsonb)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 PERFORM public.fountain_cloud_content_change(ctx,rev,request,digest,canonical,'page','receipt',review,'restore_private','{}');before:=pg_temp.restore_fingerprint();
 PERFORM public.fountain_cloud_content_change(ctx,rev,request,digest,canonical,'page','receipt',review,'restore_private','{}');
 IF before IS DISTINCT FROM pg_temp.restore_fingerprint() THEN RAISE EXCEPTION 'Replay duplicated effects';END IF;
 PERFORM set_config('fountain.restore_test_authenticated','false',true);code:=NULL;
 BEGIN PERFORM public.fountain_cloud_content_change(ctx,rev,request,digest,canonical,'page','receipt',review,'restore_private','{}');EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;
 IF code IS DISTINCT FROM 'PT401' THEN RAISE EXCEPTION 'Receipt bypassed authentication';END IF;
 PERFORM set_config('fountain.restore_test_authenticated','true',true);
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','receipt','reviewRevision',review,'operation','restore_original','value','{}'::jsonb)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');code:=NULL;
 BEGIN PERFORM public.fountain_cloud_content_change(ctx,rev,request,digest,canonical,'page','receipt',review,'restore_original','{}');EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;
 IF code IS DISTINCT FROM 'PT409' OR before IS DISTINCT FROM pg_temp.restore_fingerprint() THEN RAISE EXCEPTION 'Receipt digest reuse accepted';END IF;
 FOREACH kind IN ARRAY ARRAY['database','row','page/receipt',''] LOOP
  code:=NULL;BEGIN PERFORM public.fountain_cloud_content_restore_review(ctx,fountain_cloud.store_revision(ws,'_entity_revision'),kind,'receipt');EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;
  IF code IS DISTINCT FROM '22023' THEN RAISE EXCEPTION 'Review accepted invalid kind';END IF;
 END LOOP;
 code:=NULL;BEGIN PERFORM public.fountain_cloud_content_restore_review(ctx,fountain_cloud.store_revision(ws,'_entity_revision'),'page','missing');EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;IF code IS DISTINCT FROM 'PT404' THEN RAISE EXCEPTION 'Missing review not404';END IF;
 code:=NULL;BEGIN PERFORM public.fountain_cloud_content_restore_review(ctx,fountain_cloud.store_revision(ws,'_entity_revision'),'page','receipt');EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;IF code IS DISTINCT FROM 'PT409' THEN RAISE EXCEPTION 'Active review accepted';END IF;
 IF NOT has_function_privilege('service_role','public.fountain_cloud_content_restore_review(jsonb,bigint,text,text)','EXECUTE') OR has_function_privilege('anon','public.fountain_cloud_content_restore_review(jsonb,bigint,text,text)','EXECUTE') OR has_function_privilege('authenticated','public.fountain_cloud_content_restore_review(jsonb,bigint,text,text)','EXECUTE') OR has_function_privilege('fountain_backend','public.fountain_cloud_content_restore_review(jsonb,bigint,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Restore review grant wrong';END IF;
END $receipt_and_grants$;
DO $trashed_location$
DECLARE ws text:=current_setting('fountain.restore_test_workspace');location jsonb;
BEGIN
 PERFORM pg_temp.restore_put('parent','{"archived":false,"deleted":false,"deleted_at":null,"parent_id":null}');
 PERFORM pg_temp.restore_put('location');location:=fountain_private.content_location(ws,'page','location');
 IF location IS DISTINCT FROM jsonb_build_object('kind','page','id','parent','title','parent') THEN RAISE EXCEPTION 'Trashed selected leaf lost original location';END IF;
 PERFORM pg_temp.restore_put('parent');
 IF fountain_private.content_location(ws,'page','location') IS NOT NULL THEN RAISE EXCEPTION 'Trashed ancestor exposed as active location';END IF;
 PERFORM pg_temp.restore_put('location','{"parent_id":"missing"}');
 IF fountain_private.content_location(ws,'page','location') IS NOT NULL THEN RAISE EXCEPTION 'Missing ancestor exposed as active location';END IF;
 PERFORM pg_temp.restore_put('location','{"parent_id":null}');
 UPDATE fountain_private.entities SET data=data||'{"archived":true}' WHERE workspace_id=ws AND kind='teamspace' AND id='team';
 IF fountain_private.content_location(ws,'page','location') IS NOT NULL THEN RAISE EXCEPTION 'Archived teamspace exposed as active location';END IF;
 UPDATE fountain_private.entities SET data=data||'{"archived":false}' WHERE workspace_id=ws AND kind='teamspace' AND id='team';
END $trashed_location$;
DO $old_operations_and_cas$
#variable_conflict use_column
DECLARE ctx jsonb:=pg_temp.restore_context();ws text:=ctx->>'workspaceId';op text;value jsonb;rev bigint;review text;canonical text;digest text;code text;before text;
BEGIN
 PERFORM pg_temp.restore_put('operations');
 INSERT INTO fountain_private.entities VALUES(ws,'group','group','{"id":"group","members":["guest"]}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
 FOREACH op IN ARRAY ARRAY['replace_permissions','remove_group','revoke_member','set_private','unpublish'] LOOP
  value:=CASE op WHEN 'replace_permissions' THEN '{"permissions":{"default":"private","inherit":false,"members":{"guest":"view"},"groups":{"group":"edit"}}}' WHEN 'remove_group' THEN '{"group_id":"group"}' WHEN 'revoke_member' THEN '{"member_id":"guest"}' ELSE '{}' END;
  IF pg_temp.restore_call('operations',op,value)<>'{"applied":true}' THEN RAISE EXCEPTION 'Existing operation regressed';END IF;
 END LOOP;
 PERFORM pg_temp.restore_put('cas');rev:=fountain_cloud.store_revision(ws,'_entity_revision');review:=fountain_private.content_review_revision(ws,'page','cas');
 -- A separate source-management change invalidates the old corpus review even
 -- when it has not changed the generic entity revision.
 PERFORM pg_temp.restore_put('unrelated');
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','cas','reviewRevision',review,'operation','restore_private','value','{}'::jsonb)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');before:=pg_temp.restore_fingerprint();code:=NULL;
 BEGIN PERFORM public.fountain_cloud_content_change(ctx,rev,gen_random_uuid(),digest,canonical,'page','cas',review,'restore_private','{}');EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;
 IF code IS DISTINCT FROM 'PT409' OR before IS DISTINCT FROM pg_temp.restore_fingerprint() THEN RAISE EXCEPTION 'Stale corpus review accepted';END IF;
 review:=fountain_private.content_review_revision(ws,'page','cas');rev:=rev-1;canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','cas','reviewRevision',review,'operation','restore_private','value','{}'::jsonb)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');code:=NULL;
 BEGIN PERFORM public.fountain_cloud_content_change(ctx,rev,gen_random_uuid(),digest,canonical,'page','cas',review,'restore_private','{}');EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;END;
 IF code IS DISTINCT FROM 'PT409' OR before IS DISTINCT FROM pg_temp.restore_fingerprint() THEN RAISE EXCEPTION 'Stale entity revision accepted';END IF;
 IF NOT has_function_privilege('service_role','public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb)','EXECUTE') OR has_function_privilege('anon','public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb)','EXECUTE') OR has_function_privilege('fountain_backend','public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Existing change grants altered';END IF;
END $old_operations_and_cas$;
SELECT jsonb_build_object('passed',true,'auth_stub',true,'groups',6,'rejected_without_mutation',current_setting('fountain.restore_test_rejections')::integer,'published_sites_per_restore',1005,'complete_parent_depth',100,'fixture_entities',(SELECT count(*) FROM fountain_private.entities WHERE workspace_id=current_setting('fountain.restore_test_workspace'))) AS restore_component_proof;
