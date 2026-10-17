-- Transactional SQL component tests. Runner applies pending index/access/RPC
-- migrations in ONE transaction, executes this file, and always ROLLBACKs.
-- The temporary context stub isolates query/mutation behavior; it does NOT
-- establish production Auth correctness (covered separately by real Edge QA).
CREATE OR REPLACE FUNCTION fountain_cloud.store_context(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_context->>'workspaceId'<>'rpc-component-qa' THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 PERFORM fountain_cloud.store_lock(p_context->>'workspaceId');PERFORM set_config('fountain.workspace_id',p_context->>'workspaceId',true);
 RETURN jsonb_build_object('id',p_context->>'memberId','role','owner','active',true);
END $f$;
DO $test$
DECLARE ctx jsonb:='{"workspaceId":"rpc-component-qa","memberId":"owner","userId":"00000000-0000-4000-8000-000000000001","authSessionId":"00000000-0000-4000-8000-000000000002","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';
 q jsonb:='{"version":1,"q":"","terms":[],"field":"all","kind":"all","status":"all","audience":"all","creator_id":null,"creator_unknown":false,"editor_id":null,"editor_unknown":false,"created_after":null,"created_before":null,"edited_after":null,"edited_before":null,"location_kind":"all","location_id":null,"shared_with_id":null,"sort":"title","direction":"asc","limit":1}';
 result jsonb;next_page jsonb;rev bigint;review text;canonical text;digest text;request_id uuid:=gen_random_uuid();value jsonb:='{}';caught boolean;before_body text;after_body text;state_rev bigint;
BEGIN
 PERFORM set_config('fountain.workspace_id','rpc-component-qa',true);
 INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES
 ('rpc-component-qa','member','owner','{"id":"owner","name":"Owner","email":"owner@example.invalid","role":"owner","active":true,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('rpc-component-qa','member','guest','{"id":"guest","name":"Guest","email":"guest@example.invalid","role":"guest","active":true,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
 INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at)
 SELECT 'rpc-component-qa','page',id,jsonb_build_object('id',id,'title',title,'owner_id','owner','blocks',jsonb_build_array(jsonb_build_object('type','paragraph','text',body)),'permissions',jsonb_build_object('default','private','members',jsonb_build_object('guest','view')),'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'
 FROM(VALUES('문서/one','Alpha',repeat('x',3590)||' Straße crossboundary '||repeat('z',9000)||' farneedle'),('two','Beta','second body')) v(id,title,body);
 UPDATE fountain_private.content_search_state SET ready=true WHERE workspace_id='rpc-component-qa';
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');
 result:=public.fountain_cloud_content_search(ctx,rev,q,NULL);
 IF jsonb_array_length(result->'items')<>1 OR result->'items'->0->>'id'<>'문서/one' OR result->'next_cursor'='null' THEN RAISE EXCEPTION 'first page failed';END IF;
 next_page:=public.fountain_cloud_content_search(ctx,rev,q,result->'next_cursor');
 IF next_page->'items'->0->>'id'<>'two' OR next_page->'next_cursor'<>'null' THEN RAISE EXCEPTION 'next page failed';END IF;
 caught:=false;BEGIN PERFORM public.fountain_cloud_content_search(ctx,rev,q,jsonb_set(result->'next_cursor','{signature}',to_jsonb(repeat('0',64))));EXCEPTION WHEN invalid_parameter_value THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'cursor tamper accepted';END IF;
 result:=public.fountain_cloud_content_search(ctx,rev,q||'{"q":"strasse farneedle","terms":["strasse","farneedle"],"field":"body"}',NULL);
 IF jsonb_array_length(result->'items')<>1 OR length(result->'items'->0->>'snippet')>180 OR position('Straße' IN(result->'items'->0->>'snippet'))=0 THEN RAISE EXCEPTION 'full body AND/fullfold snippet failed';END IF;
 result:=public.fountain_cloud_content_search(ctx,rev,q||'{"q":"crossboundary","terms":["crossboundary"],"field":"body"}',NULL);
 IF jsonb_array_length(result->'items')<>1 THEN RAISE EXCEPTION 'boundary phrase failed';END IF;
 result:=public.fountain_cloud_content_access(ctx,rev,'page','문서/one',1,NULL);
 IF jsonb_array_length(result->'items')<>1 OR result->'items'->0->>'id'<>'guest' OR result->'next_cursor'='null' THEN RAISE EXCEPTION 'access page failed';END IF;
 next_page:=public.fountain_cloud_content_access(ctx,rev,'page','문서/one',1,result->'next_cursor');
 IF next_page->'items'->0->>'id'<>'owner' OR next_page->'items'->0->'can_revoke'<>'false' THEN RAISE EXCEPTION 'implicit owner access failed';END IF;
 review:=fountain_private.content_review_revision('rpc-component-qa','page','문서/one');
 SELECT data->'blocks'::text INTO before_body FROM fountain_private.entities WHERE workspace_id='rpc-component-qa' AND kind='page' AND id='문서/one';
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','문서/one','reviewRevision',review,'operation','set_private','value',value)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 result:=public.fountain_cloud_content_change(ctx,rev,request_id,digest,canonical,'page','문서/one',review,'set_private',value);
 IF result<>'{"applied":true}'::jsonb OR fountain_private.content_access_level('rpc-component-qa','page','문서/one','guest')<>0 THEN RAISE EXCEPTION 'private change failed';END IF;
 SELECT data->'blocks'::text INTO after_body FROM fountain_private.entities WHERE workspace_id='rpc-component-qa' AND kind='page' AND id='문서/one';
 IF before_body IS DISTINCT FROM after_body THEN RAISE EXCEPTION 'body overwritten';END IF;
 result:=public.fountain_cloud_content_change(ctx,rev,request_id,digest,canonical,'page','문서/one',review,'set_private',value);
 IF (SELECT count(*) FROM fountain_private.entities WHERE workspace_id='rpc-component-qa' AND kind='audit')<>1 THEN RAISE EXCEPTION 'replay duplicated audit';END IF;
 caught:=false;BEGIN PERFORM public.fountain_cloud_content_search(ctx,rev,q,NULL);EXCEPTION WHEN SQLSTATE 'PT409' THEN caught:=true;END;IF NOT caught THEN RAISE EXCEPTION 'stale authority revision accepted';END IF;
 IF has_function_privilege('anon','public.fountain_cloud_content_search(jsonb,bigint,jsonb,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb)','EXECUTE') OR has_function_privilege('fountain_backend','fountain_private.content_cursor(text,jsonb,text,jsonb,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'client/private execution grant';END IF;
END $test$;
DO $mutation_tests$
DECLARE ctx jsonb:='{"workspaceId":"rpc-component-qa","memberId":"owner","userId":"00000000-0000-4000-8000-000000000001","authSessionId":"00000000-0000-4000-8000-000000000002","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';
 op text;value jsonb;rev bigint;review text;canonical text;digest text;request_id uuid;response jsonb;caught boolean;before_rev bigint;
BEGIN
 INSERT INTO fountain_private.entities VALUES('rpc-component-qa','group','g','{"id":"g","members":["guest"],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
 FOREACH op IN ARRAY ARRAY['replace_permissions','remove_group','revoke_member'] LOOP
  value:=CASE op WHEN 'replace_permissions' THEN '{"permissions":{"default":"private","inherit":false,"members":{"guest":"view"},"groups":{"g":"edit"}}}' WHEN 'remove_group' THEN '{"group_id":"g"}' ELSE '{"member_id":"guest"}' END;
  rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');review:=fountain_private.content_review_revision('rpc-component-qa','page','문서/one');request_id:=gen_random_uuid();
  canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','문서/one','reviewRevision',review,'operation',op,'value',value)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  response:=public.fountain_cloud_content_change(ctx,rev,request_id,digest,canonical,'page','문서/one',review,op,value);
  IF response<>'{"applied":true}' THEN RAISE EXCEPTION 'operation failed %',op;END IF;
  IF op='remove_group' AND fountain_private.content_access_level('rpc-component-qa','page','문서/one','guest')<>1 THEN RAISE EXCEPTION 'group removal silently revoked independent member grant';END IF;
 END LOOP;
 IF fountain_private.content_access_level('rpc-component-qa','page','문서/one','guest')<>0 THEN RAISE EXCEPTION 'member revocation ineffective';END IF;
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');review:=fountain_private.content_review_revision('rpc-component-qa','page','문서/one');value:='{"member_id":"owner"}';
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','문서/one','reviewRevision',review,'operation','revoke_member','value',value)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 caught:=false;BEGIN PERFORM public.fountain_cloud_content_change(ctx,rev,gen_random_uuid(),digest,canonical,'page','문서/one',review,'revoke_member',value);EXCEPTION WHEN SQLSTATE 'PT409' THEN caught:=true;END;IF NOT caught THEN RAISE EXCEPTION 'implicit owner revoked';END IF;
 INSERT INTO fountain_private.entities SELECT 'rpc-component-qa','site',id,jsonb_build_object('id',id,'page_id','문서/one','published',true,'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM(SELECT 's'||n::text AS id FROM generate_series(1,1001) n) publications;
 review:=fountain_private.content_review_revision('rpc-component-qa','page','문서/one');value:='{}';request_id:=gen_random_uuid();
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','문서/one','reviewRevision',review,'operation','unpublish','value',value)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 PERFORM public.fountain_cloud_content_change(ctx,rev,request_id,digest,canonical,'page','문서/one',review,'unpublish',value);
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id='rpc-component-qa' AND kind='site' AND data->'published'='true') THEN RAISE EXCEPTION 'not all sites unpublished';END IF;
 caught:=false;BEGIN PERFORM public.fountain_cloud_content_change(ctx,rev,request_id,repeat('0',64),canonical,'page','문서/one',review,'unpublish',value);EXCEPTION WHEN invalid_parameter_value THEN caught:=true;END;IF NOT caught THEN RAISE EXCEPTION 'invalid replay digest accepted';END IF;
 response:=public.fountain_cloud_content_permissions(ctx,fountain_cloud.store_revision('rpc-component-qa','_entity_revision'),'page','문서/one');
 IF response->'permissions'->'members'->>'guest'<>'none' OR response->'source_invalid'<>'false' THEN RAISE EXCEPTION 'permissions config projection failed';END IF;
END $mutation_tests$;

DO $instant_tests$
BEGIN
 IF fountain_private.content_instant('2026-01-01T00:00:00.000001Z')-fountain_private.content_instant('2026-01-01T00:00:00.000000Z')<>0.000001 THEN RAISE EXCEPTION 'Microsecond source instant lost';END IF;
 IF fountain_private.content_instant('2026-02-30T00:00:00.000000Z') IS NOT NULL OR fountain_private.content_instant('2026-01-01') IS NOT NULL THEN RAISE EXCEPTION 'Invalid source instant accepted';END IF;
 IF NOT fountain_private.content_after(NULL,'page','b',to_jsonb('a'::text),'page','a',true) OR fountain_private.content_after(to_jsonb('a'::text),'page','a',NULL,'page','b',false) THEN RAISE EXCEPTION 'NULL-last cursor ordering failed';END IF;
END $instant_tests$;
DO $scope_tests$
DECLARE ctx jsonb:='{"workspaceId":"rpc-component-qa","memberId":"owner","userId":"00000000-0000-4000-8000-000000000001","authSessionId":"00000000-0000-4000-8000-000000000002","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';q jsonb:='{"version":1,"q":"","terms":[],"field":"all","kind":"all","status":"all","audience":"all","creator_id":null,"creator_unknown":false,"editor_id":null,"editor_unknown":false,"created_after":null,"created_before":null,"edited_after":null,"edited_before":null,"location_kind":"all","location_id":null,"shared_with_id":null,"sort":"title","direction":"asc","limit":1}';
 rev bigint;response jsonb;bad boolean;fingerprint text;fingerprint_after text;cursor jsonb;before_state bigint;
BEGIN
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');
 SELECT md5(string_agg(data::text,'|' ORDER BY kind,id)) INTO fingerprint FROM fountain_private.entities WHERE workspace_id='rpc-component-qa';
 SELECT content_revision INTO before_state FROM fountain_private.content_search_state WHERE workspace_id='rpc-component-qa';
 response:=public.fountain_cloud_content_search(ctx,rev,q,NULL);cursor:=response->'next_cursor';
 IF (response->'items'->0)-ARRAY['kind','id','title','icon','status','location','creator','created_at','last_editor','edited_at','audience','access_summary','publication','snippet','review_revision','can_manage_permissions','can_unpublish']<>'{}' THEN RAISE EXCEPTION 'unexpected source DTO field';END IF;
 bad:=false;BEGIN PERFORM public.fountain_cloud_content_search(ctx||'{"cacheBinding":"cccccccccccccccccccccccccccccccc"}',rev,q,cursor);EXCEPTION WHEN SQLSTATE 'PT409' THEN bad:=true;END;IF NOT bad THEN RAISE EXCEPTION 'cursor actor binding missing';END IF;
 bad:=false;BEGIN PERFORM public.fountain_cloud_content_search(ctx,rev,q||'{"direction":"desc"}',cursor);EXCEPTION WHEN SQLSTATE 'PT409' THEN bad:=true;END;IF NOT bad THEN RAISE EXCEPTION 'cursor query binding missing';END IF;
 bad:=false;BEGIN PERFORM public.fountain_cloud_content_access(ctx,rev,'page','two',1,cursor);EXCEPTION WHEN SQLSTATE 'PT409' THEN bad:=true;END;IF NOT bad THEN RAISE EXCEPTION 'cursor purpose binding missing';END IF;
 SELECT md5(string_agg(data::text,'|' ORDER BY kind,id)) INTO fingerprint_after FROM fountain_private.entities WHERE workspace_id='rpc-component-qa';
 IF fingerprint_after<>fingerprint OR before_state<>(SELECT content_revision FROM fountain_private.content_search_state WHERE workspace_id='rpc-component-qa') THEN RAISE EXCEPTION 'read mutated content/source state';END IF;
 UPDATE fountain_private.content_search_state SET ready=false WHERE workspace_id='rpc-component-qa';
 bad:=false;BEGIN PERFORM public.fountain_cloud_content_search(ctx,rev,q,NULL);EXCEPTION WHEN SQLSTATE 'PT503' THEN bad:=true;END;IF NOT bad THEN RAISE EXCEPTION 'unready index returned success';END IF;
 UPDATE fountain_private.content_search_state SET ready=true WHERE workspace_id='rpc-component-qa';
END $scope_tests$;
DO $options_tests$
DECLARE ctx jsonb:='{"workspaceId":"rpc-component-qa","memberId":"owner","userId":"00000000-0000-4000-8000-000000000001","authSessionId":"00000000-0000-4000-8000-000000000002","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';response jsonb;next_page jsonb;rev bigint;
BEGIN
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');
 response:=public.fountain_cloud_content_options(ctx,rev,'{"kind":"member","q":"","limit":1}',NULL);
 IF jsonb_array_length(response->'items')<>1 OR response->'items'->0->>'label'<>'Guest' OR response->'items'->0->>'email'<>'guest@example.invalid' OR response->'next_cursor'='null' THEN RAISE EXCEPTION 'member option projection/paging';END IF;
 next_page:=public.fountain_cloud_content_options(ctx,rev,'{"kind":"member","q":"","limit":1}',response->'next_cursor');
 IF next_page->'items'->0->>'label'<>'Owner' OR next_page->'next_cursor'<>'null' THEN RAISE EXCEPTION 'member option keyset';END IF;
 response:=public.fountain_cloud_content_options(ctx,rev,'{"kind":"page","q":"alpha","limit":50}',NULL);
 IF jsonb_array_length(response->'items')<>1 OR response->'items'->0->>'id'<>'문서/one' OR response->'items'->0->'email'<>'null' OR response->'items'->0->'role'<>'null' THEN RAISE EXCEPTION 'page options body-free DTO';END IF;
END $options_tests$;
DO $unicode_cursor_tests$
DECLARE ctx jsonb:='{"workspaceId":"rpc-component-qa","memberId":"owner","userId":"00000000-0000-4000-8000-000000000001","authSessionId":"00000000-0000-4000-8000-000000000002","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';q jsonb;cur jsonb;response jsonb;next_page jsonb;rev bigint;needle text:=repeat('😀',512);identifier text:=repeat('🦄',159);
BEGIN
 INSERT INTO fountain_private.entities SELECT 'rpc-component-qa','page',identifier||suffix,jsonb_build_object('id',identifier||suffix,'title',needle,'blocks',jsonb_build_array(jsonb_build_object('text',needle)),'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM unnest(ARRAY['a','b']) suffix;
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');
 q:=jsonb_build_object('version',1,'q',needle,'terms',jsonb_build_array(needle),'field','all','kind','all','status','all','audience','all','creator_id',NULL,'creator_unknown',false,'editor_id',NULL,'editor_unknown',false,'created_after',NULL,'created_before',NULL,'edited_after',NULL,'edited_before',NULL,'location_kind','all','location_id',NULL,'shared_with_id',NULL,'sort','title','direction','asc','limit',1);
 response:=public.fountain_cloud_content_search(ctx,rev,q,NULL);cur:=response->'next_cursor';
 IF cur='null' OR length(replace(encode(convert_to(cur::text,'UTF8'),'base64'),E'\n',''))>4096 THEN RAISE EXCEPTION 'legal nonBMP query cursor exceeds wire bound';END IF;
 next_page:=public.fountain_cloud_content_search(ctx,rev,q,cur);
 IF next_page->'items'->0->>'id'<>identifier||'b' OR next_page->'next_cursor'<>'null' THEN RAISE EXCEPTION 'legal nonBMP query pagination failed';END IF;
 q:=q||jsonb_build_object('creator_id',repeat('🦄',160),'editor_id',repeat('😀',160),'shared_with_id',repeat('🌟',160),'location_kind','page','location_id',repeat('🚀',160));
 cur:=fountain_private.content_cursor('rpc-component-qa',ctx,'search',q,jsonb_build_object('kind','page','id',identifier||'a'));
 IF length(replace(encode(convert_to(cur::text,'UTF8'),'base64'),E'\n',''))>4096 OR fountain_private.content_cursor_read('rpc-component-qa',ctx,'search',q,cur)->>'id'<>identifier||'a' THEN RAISE EXCEPTION 'nonBMP query and maximal filters cursor bound';END IF;
END $unicode_cursor_tests$;
DO $acl_validation_tests$
DECLARE ctx jsonb:='{"workspaceId":"rpc-component-qa","memberId":"owner","userId":"00000000-0000-4000-8000-000000000001","authSessionId":"00000000-0000-4000-8000-000000000002","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';permissions jsonb;value jsonb;rev bigint;review text;canonical text;digest text;bad boolean;grants jsonb;group_grants jsonb;case_value jsonb;before_actor text;
BEGIN
 INSERT INTO fountain_private.entities SELECT 'rpc-component-qa','member','budget-'||n,jsonb_build_object('id','budget-'||n,'name','Budget Member '||n,'role','member','active',false,'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM generate_series(1,1000) n;
 INSERT INTO fountain_private.entities VALUES('rpc-component-qa','member','corrupt-role','{"id":"corrupt-role","name":"Bad role","role":"superuser","active":false,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
 INSERT INTO fountain_private.entities SELECT 'rpc-component-qa','group','budget-group-'||n,jsonb_build_object('id','budget-group-'||n,'name','Budget Group '||n,'members','[]'::jsonb,'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM generate_series(1,1001) n;
 SELECT jsonb_object_agg('budget-group-'||n,'view') INTO group_grants FROM generate_series(1,1000) n;
 SELECT jsonb_object_agg('budget-'||n,'view') INTO grants FROM generate_series(1,1000) n;
 permissions:=jsonb_build_object('default','private','members',grants,'groups',group_grants);value:=jsonb_build_object('permissions',permissions);
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');review:=fountain_private.content_review_revision('rpc-component-qa','page','two');
 canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','two','reviewRevision',review,'operation','replace_permissions','value',value)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 before_actor:=current_setting('fountain.content_actor',true);
 PERFORM public.fountain_cloud_content_change(ctx,rev,gen_random_uuid(),digest,canonical,'page','two',review,'replace_permissions',value);
 IF current_setting('fountain.content_actor',true) IS DISTINCT FROM before_actor OR NOT EXISTS(SELECT 1 FROM fountain_private.content_provenance WHERE workspace_id='rpc-component-qa' AND kind='page' AND id='two' AND manager_id='owner') THEN RAISE EXCEPTION 'verified management actor missing/not restored';END IF;
 IF (SELECT count(*) FROM jsonb_each((SELECT header->'permissions'->'members' FROM fountain_private.content_search_documents WHERE workspace_id='rpc-component-qa' AND kind='page' AND id='two')))<>1000 THEN RAISE EXCEPTION '1000-member ACL incorrectly limited';END IF;
 FOREACH case_value IN ARRAY ARRAY[jsonb_build_object('members',grants||'{"guest":"view"}'::jsonb),jsonb_build_object('groups',group_grants||'{"budget-group-1001":"view"}'::jsonb),'{"groups":{"unknown":"view"}}'::jsonb,'{"members":{"corrupt-role":"view"}}'::jsonb,'{"members":{"":"view"}}'::jsonb,jsonb_build_object('members',jsonb_build_object(repeat('x',161),'view'))] LOOP
  value:=jsonb_build_object('permissions',case_value);rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');review:=fountain_private.content_review_revision('rpc-component-qa','page','two');
  canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','two','reviewRevision',review,'operation','replace_permissions','value',value)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  bad:=false;BEGIN PERFORM public.fountain_cloud_content_change(ctx,rev,gen_random_uuid(),digest,canonical,'page','two',review,'replace_permissions',value);EXCEPTION WHEN invalid_parameter_value THEN bad:=true;END;
  IF NOT bad THEN RAISE EXCEPTION 'Invalid ACL accepted';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.content_provenance WHERE workspace_id='rpc-component-qa' AND kind='page' AND id='문서/one' AND manager_id='owner') THEN RAISE EXCEPTION 'unpublish management actor missing';END IF;
END $acl_validation_tests$;
DO $inheritance_and_dates_tests$
DECLARE ctx jsonb:='{"workspaceId":"rpc-component-qa","memberId":"owner","userId":"00000000-0000-4000-8000-000000000001","authSessionId":"00000000-0000-4000-8000-000000000002","sessionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cacheBinding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';rev bigint;review text;value jsonb:='{"member_id":"guest"}';canonical text;digest text;result jsonb;
 q jsonb:='{"version":1,"q":"invalid-source-time","terms":["invalid-source-time"],"field":"id","kind":"all","status":"all","audience":"all","creator_id":null,"creator_unknown":false,"editor_id":null,"editor_unknown":false,"created_after":null,"created_before":null,"edited_after":null,"edited_before":null,"location_kind":"all","location_id":null,"shared_with_id":null,"sort":"title","direction":"asc","limit":50}';
BEGIN
 INSERT INTO fountain_private.entities VALUES('rpc-component-qa','member','regular','{"id":"regular","name":"Regular","role":"member","active":true,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
 INSERT INTO fountain_private.entities SELECT 'rpc-component-qa','page',id,jsonb_build_object('id',id,'title',id,'owner_id','owner','blocks','[]'::jsonb,'created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z')||extra,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM(VALUES('parent-inherit','{"permissions":{"default":"private","members":{"guest":"view"}}}'::jsonb),('child-inherit','{"parent_id":"parent-inherit"}'::jsonb)) v(id,extra);
 IF fountain_private.content_access_level('rpc-component-qa','page','child-inherit','regular')<>0 OR fountain_private.content_access_level('rpc-component-qa','page','child-inherit','guest')<>1 THEN RAISE EXCEPTION 'inherit fixture invalid';END IF;
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');review:=fountain_private.content_review_revision('rpc-component-qa','page','child-inherit');canonical:=jsonb_build_object('context',ctx,'expectedRevision',rev,'kind','page','id','child-inherit','reviewRevision',review,'operation','revoke_member','value',value)::text;digest:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
 PERFORM public.fountain_cloud_content_change(ctx,rev,gen_random_uuid(),digest,canonical,'page','child-inherit',review,'revoke_member',value);
 IF fountain_private.content_access_level('rpc-component-qa','page','child-inherit','regular')<>0 OR fountain_private.content_access_level('rpc-component-qa','page','child-inherit','guest')<>0 THEN RAISE EXCEPTION 'member revoke widened inherited ACL';END IF;
 INSERT INTO fountain_private.entities VALUES('rpc-component-qa','page','invalid-source-time','{"id":"invalid-source-time","title":"Invalid source timestamp","blocks":[]}','malformed','2026-01-01T00:00:00Z');
 UPDATE fountain_private.content_provenance SET edited_at='2026-01-01T00:00:00+99:00' WHERE workspace_id='rpc-component-qa' AND kind='page' AND id='invalid-source-time';
 rev:=fountain_cloud.store_revision('rpc-component-qa','_entity_revision');result:=public.fountain_cloud_content_search(ctx,rev,q,NULL);
 IF jsonb_array_length(result->'items')<>1 OR result->'items'->0->'created_at'<>'null' OR result->'items'->0->'edited_at'<>'null' THEN RAISE EXCEPTION 'malformed source timestamp leaked';END IF;
 IF fountain_private.content_instant('2026-01-01T00:00:00.000001+09:00')<>fountain_private.content_instant('2025-12-31T15:00:00.000001Z') THEN RAISE EXCEPTION 'aware offset instant normalization differs';END IF;
END $inheritance_and_dates_tests$;
