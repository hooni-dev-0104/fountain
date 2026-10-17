-- Header-only ACL and audience projection for the private administrator search.
-- These functions never select page/database/row source bodies and never write.
CREATE FUNCTION fountain_private.content_acl(p_acl jsonb,p_member_id text,p_groups text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE v_default text;v_members jsonb;v_groups jsonb;v_level integer;v_levels constant jsonb:='{"none":0,"view":1,"comment":2,"edit":3,"full":4}';
BEGIN
 IF jsonb_typeof(p_acl) IS DISTINCT FROM 'object' THEN RETURN NULL;END IF;
 v_default:=COALESCE(p_acl->>'default','workspace');
 IF (p_acl ? 'default' AND jsonb_typeof(p_acl->'default')<>'string') OR v_default NOT IN('workspace','private')
  OR (p_acl ? 'inherit' AND jsonb_typeof(p_acl->'inherit')<>'boolean') THEN RETURN NULL;END IF;
 v_members:=COALESCE(p_acl->'members','{}');v_groups:=COALESCE(p_acl->'groups','{}');
 IF jsonb_typeof(v_members)<>'object' OR jsonb_typeof(v_groups)<>'object' THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(v_members) e WHERE jsonb_typeof(e.value)<>'string' OR NOT(v_levels ? (e.value#>>'{}')))
  OR EXISTS(SELECT 1 FROM jsonb_each(v_groups) e WHERE jsonb_typeof(e.value)<>'string' OR NOT(v_levels ? (e.value#>>'{}'))) THEN RETURN NULL;END IF;
 IF v_members ? p_member_id THEN RETURN jsonb_build_object('level',(v_levels->>(v_members->>p_member_id))::integer,'via','direct','default',v_default);END IF;
 SELECT max((v_levels->>(e.value#>>'{}'))::integer) INTO v_level FROM jsonb_each(v_groups) e WHERE e.key=ANY(p_groups);
 RETURN jsonb_build_object('level',v_level,'via',CASE WHEN v_level IS NULL THEN NULL ELSE 'group' END,'default',v_default);
END $f$;
CREATE FUNCTION fountain_private.content_access_internal(p_ws text,p_kind text,p_id text,p_member jsonb,p_include_owner boolean,p_trail text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_id text:=p_member->>'id';v_role text:=p_member->>'role';v_doc fountain_private.content_search_documents;
 v_header jsonb;v_acl jsonb;v_result jsonb;v_database fountain_private.content_search_documents;v_policy jsonb;v_groups text[];v_team jsonb;
 v_default text:='workspace';v_level integer;v_base integer;v_assigned boolean;v_token text:=p_kind||':'||p_id;
BEGIN
 IF jsonb_typeof(p_member->'id') IS DISTINCT FROM 'string' OR v_id='' OR v_role IS NULL OR v_role NOT IN('owner','admin','member','guest')
  OR COALESCE(p_member->'active','true'::jsonb)<>'true'::jsonb THEN RETURN jsonb_build_object('level',0,'via','inactive','can_revoke',false);END IF;
 SELECT * INTO v_doc FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind=p_kind AND id=p_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 IF p_include_owner AND v_role='owner' THEN RETURN jsonb_build_object('level',4,'via','workspace_admin','can_revoke',false);END IF;
 IF v_token=ANY(p_trail) OR cardinality(p_trail)>=64 OR NOT v_doc.validity THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 p_trail:=array_append(p_trail,v_token);v_header:=v_doc.header;
 SELECT COALESCE(array_agg(e.id),'{}') INTO v_groups FROM fountain_private.entities e WHERE e.workspace_id=p_ws AND e.kind='group'
  AND jsonb_typeof(e.data->'members')='array' AND e.data->'members' @> jsonb_build_array(v_id);
 IF p_kind='row' THEN
  IF jsonb_typeof(v_header->'database_id') IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
  SELECT * INTO v_database FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind='database' AND id=v_header->>'database_id';
  IF NOT FOUND THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
  v_result:=fountain_private.content_access_internal(p_ws,'database',v_database.id,p_member,p_include_owner,p_trail);v_base:=(v_result->>'level')::integer;
  IF v_base IS NULL OR v_base=0 THEN RETURN v_result;END IF;
  IF COALESCE(v_database.header->'owner_id','"local"'::jsonb)=to_jsonb(v_id) THEN RETURN jsonb_build_object('level',4,'via','resource_owner','can_revoke',false);END IF;
  v_policy:=COALESCE(v_database.header->'row_permissions','{}'::jsonb);
  IF jsonb_typeof(v_policy)<>'object' OR COALESCE(v_policy->>'mode','all') NOT IN('all','assigned')
   OR (v_policy ? 'mode' AND jsonb_typeof(v_policy->'mode')<>'string')
   OR (v_policy ? 'edit_assigned' AND jsonb_typeof(v_policy->'edit_assigned')<>'boolean')
   OR (v_policy ? 'allow_create' AND jsonb_typeof(v_policy->'allow_create')<>'boolean') THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
  IF v_policy->>'mode'='assigned' AND (jsonb_typeof(v_policy->'property_id') IS DISTINCT FROM 'string' OR v_policy->>'property_id'=''
   OR jsonb_typeof(v_database.header->'properties') IS DISTINCT FROM 'array') THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
  IF v_policy->>'mode'='assigned' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_database.header->'properties') p WHERE p->>'id'=v_policy->>'property_id' AND p->>'type' IN('owner','verification')) THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
  v_level:=v_base;
  IF v_base<4 AND v_policy->>'mode'='assigned' THEN
   IF jsonb_typeof(v_header->'assignment_values') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
   SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_header->'assignment_values') a WHERE jsonb_typeof(a)='string' AND
    (a#>>'{}'=v_id OR (jsonb_typeof(p_member->'email')='string' AND p_member->>'email'<>'' AND fountain_private.content_casefold(a#>>'{}')=fountain_private.content_casefold(p_member->>'email')))) INTO v_assigned;
   IF NOT v_assigned THEN RETURN jsonb_build_object('level',0,'via','assignment','can_revoke',false);END IF;
   v_level:=least(v_base,CASE WHEN v_policy->'edit_assigned'='true'::jsonb THEN 3 ELSE 1 END);v_result:=jsonb_build_object('via','assignment');
  END IF;
  IF v_header->'permissions' IS NOT NULL AND v_header->'permissions'<>'null'::jsonb THEN
   v_acl:=fountain_private.content_acl(v_header->'permissions',v_id,v_groups);
   IF v_acl IS NULL THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
   IF v_acl->>'level' IS NOT NULL AND (v_acl->>'level')::integer<=v_level THEN v_result:=jsonb_build_object('via',v_acl->>'via');END IF;
   v_level:=least(v_level,COALESCE((v_acl->>'level')::integer,CASE WHEN v_acl->>'default'='workspace' THEN v_base ELSE 0 END));
  END IF;
  RETURN jsonb_build_object('level',v_level,'via',COALESCE(v_result->>'via','workspace'),'can_revoke',v_level>0);
 END IF;
 IF p_kind NOT IN('page','database') THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 IF COALESCE(v_header->'owner_id','"local"'::jsonb)=to_jsonb(v_id) THEN RETURN jsonb_build_object('level',4,'via','resource_owner','can_revoke',false);END IF;
 IF v_header->'permissions' IS NOT NULL AND v_header->'permissions'<>'null'::jsonb THEN
  v_acl:=fountain_private.content_acl(v_header->'permissions',v_id,v_groups);
  IF v_acl IS NULL THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
  IF v_acl->>'level' IS NOT NULL THEN v_level:=(v_acl->>'level')::integer;RETURN jsonb_build_object('level',v_level,'via',v_acl->>'via','can_revoke',v_level>0);END IF;
  v_default:=v_acl->>'default';
 END IF;
 IF fountain_private.content_truth(v_header->'parent_id') AND (v_header->'permissions' IS NULL OR v_header->'permissions'='null'::jsonb OR v_header->'permissions'->'inherit'='true'::jsonb) THEN
  IF jsonb_typeof(v_header->'parent_id')<>'string' THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
  v_result:=fountain_private.content_access_internal(p_ws,'page',v_header->>'parent_id',p_member,p_include_owner,p_trail);
  RETURN v_result||jsonb_build_object('via',CASE WHEN v_result->>'level' IS NULL THEN 'unknown' ELSE 'inherited' END,'can_revoke',COALESCE((v_result->>'level')::integer>0,false));
 END IF;
 IF v_default<>'workspace' OR v_role='guest' THEN RETURN jsonb_build_object('level',0,'via','private','can_revoke',false);END IF;
 IF NOT fountain_private.content_truth(v_header->'teamspace_id') THEN RETURN jsonb_build_object('level',3,'via','workspace','can_revoke',true);END IF;
 IF jsonb_typeof(v_header->'teamspace_id')<>'string' THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 SELECT data INTO v_team FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='teamspace' AND id=v_header->>'teamspace_id';
 IF v_team IS NULL OR jsonb_typeof(v_team) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 IF COALESCE(v_team->'owner_id','"local"'::jsonb)=to_jsonb(v_id) THEN RETURN jsonb_build_object('level',3,'via','workspace','can_revoke',true);END IF;
 IF jsonb_typeof(COALESCE(v_team->'members','[]'))<>'array' OR jsonb_typeof(COALESCE(v_team->'groups','[]'))<>'array' THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_team->'groups','[]')) a WHERE jsonb_typeof(a)<>'string') THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 IF v_team ? 'visibility' AND (jsonb_typeof(v_team->'visibility')<>'string' OR v_team->>'visibility' NOT IN('open','closed','private')) THEN RETURN jsonb_build_object('level',NULL,'via','unknown','can_revoke',false);END IF;
 v_level:=CASE WHEN COALESCE(v_team->'members','[]') @> jsonb_build_array(v_id) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(v_team->'groups','[]')) g WHERE g=ANY(v_groups)) OR (CASE WHEN NOT(v_team ? 'visibility') THEN 'open' ELSE v_team->>'visibility' END)='open' THEN 3 ELSE 0 END;
 RETURN jsonb_build_object('level',v_level,'via','workspace','can_revoke',v_level>0);
END $f$;
CREATE FUNCTION fountain_private.content_access_reason(p_ws text,p_kind text,p_id text,p_member_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT fountain_private.content_access_internal(p_ws,p_kind,p_id,COALESCE((SELECT data FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='member' AND id=p_member_id),'{}'),true)
$f$;
CREATE FUNCTION fountain_private.content_access_level(p_ws text,p_kind text,p_id text,p_member_id text,p_include_workspace_owner boolean DEFAULT true) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT (fountain_private.content_access_internal(p_ws,p_kind,p_id,COALESCE((SELECT data FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='member' AND id=p_member_id),'{}'),p_include_workspace_owner)->>'level')::integer
$f$;
-- Canonical structural containers, closest first. A broken root chain makes
-- every location unknown rather than accepting a stale leaf teamspace label.
CREATE FUNCTION fountain_private.content_locations(p_ws text,p_kind text,p_id text,p_include_trash boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_doc fountain_private.content_search_documents;v_next fountain_private.content_search_documents;v_team jsonb;v_seen text[]:='{}';v_links integer:=0;v_kind text:=p_kind;v_id text:=p_id;v_token text;v_result jsonb:='[]';v_next_kind text;v_next_id text;
BEGIN
 LOOP
  v_token:=v_kind||':'||v_id;
  IF v_token=ANY(v_seen) THEN RETURN NULL;END IF;v_seen:=array_append(v_seen,v_token);
  SELECT * INTO v_doc FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind=v_kind AND id=v_id;
  IF NOT FOUND OR NOT v_doc.validity OR (NOT p_include_trash AND (fountain_private.content_truth(v_doc.header->'archived') OR fountain_private.content_truth(v_doc.header->'deleted') OR fountain_private.content_truth(v_doc.header->'deleted_at'))) THEN RETURN NULL;END IF;
  IF v_kind='row' THEN
   IF jsonb_typeof(v_doc.header->'database_id') IS DISTINCT FROM 'string' OR v_doc.header->>'database_id'='' THEN RETURN NULL;END IF;
   v_next_id:=v_doc.header->>'database_id';v_next_kind:='database';
  ELSIF v_doc.header->'parent_id' IS NOT NULL AND v_doc.header->'parent_id'<>'null'::jsonb THEN
   IF v_links>=64 OR jsonb_typeof(v_doc.header->'parent_id')<>'string' OR v_doc.header->>'parent_id'='' THEN RETURN NULL;END IF;
   v_next_id:=v_doc.header->>'parent_id';v_next_kind:='page';v_links:=v_links+1;
  ELSE
   IF v_doc.header->'teamspace_id' IS NULL OR v_doc.header->'teamspace_id'='null'::jsonb THEN RETURN v_result;END IF;
   IF jsonb_typeof(v_doc.header->'teamspace_id')<>'string' OR v_doc.header->>'teamspace_id'='' THEN RETURN NULL;END IF;
   SELECT data INTO v_team FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='teamspace' AND id=v_doc.header->>'teamspace_id';
   IF v_team IS NULL OR jsonb_typeof(v_team) IS DISTINCT FROM 'object' THEN RETURN NULL;END IF;
   RETURN v_result||jsonb_build_array(jsonb_build_object('kind','teamspace','id',v_doc.header->>'teamspace_id','title',CASE WHEN jsonb_typeof(v_team->'name')='string' THEN v_team->>'name' ELSE '' END));
  END IF;
  SELECT * INTO v_next FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind=v_next_kind AND id=v_next_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  v_result:=v_result||jsonb_build_array(jsonb_build_object('kind',v_next_kind,'id',v_next_id,'title',v_next.title));
  v_kind:=v_next_kind;v_id:=v_next_id;
 END LOOP;
END $f$;
CREATE FUNCTION fountain_private.content_location(p_ws text,p_kind text,p_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT fountain_private.content_locations(p_ws,p_kind,p_id)->0
$f$;
CREATE FUNCTION fountain_private.content_root_teamspace(p_ws text,p_kind text,p_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT x.value FROM jsonb_array_elements(fountain_private.content_locations(p_ws,p_kind,p_id)) x WHERE x.value->>'kind'='teamspace'
$f$;
CREATE FUNCTION fountain_private.content_in_location(p_ws text,p_kind text,p_id text,p_location_kind text,p_location_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(fountain_private.content_locations(p_ws,p_kind,p_id)) x WHERE x.value->>'kind'=p_location_kind AND x.value->>'id'=p_location_id)
$f$;
CREATE FUNCTION fountain_private.content_review_revision(p_ws text,p_kind text,p_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT encode(sha256(convert_to(jsonb_build_array(1,p_ws,p_kind,p_id,d.generation,s.content_revision)::text,'UTF8')),'hex')
 FROM fountain_private.content_search_documents d JOIN fountain_private.content_search_state s USING(workspace_id)
 WHERE d.workspace_id=p_ws AND d.kind=p_kind AND d.id=p_id AND s.ready AND s.index_version=1
$f$;
CREATE FUNCTION fountain_private.content_audience(p_ws text,p_kind text,p_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE v_doc fountain_private.content_search_documents;v_owner text;v_member record;v_reason jsonb;v_level integer;v_internal integer:=0;v_external integer:=0;v_sample jsonb:='[]';v_unknown boolean:=false;v_sites integer:=0;v_forms integer:=0;v_disabled boolean:=false;v_publication text;v_probe text:='__content_audience_probe__';
BEGIN
 SELECT * INTO v_doc FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind=p_kind AND id=p_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF p_kind='row' THEN SELECT CASE WHEN NOT(header ? 'owner_id') THEN 'local' WHEN jsonb_typeof(header->'owner_id')='string' THEN header->>'owner_id' ELSE NULL END INTO v_owner FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind='database' AND id=v_doc.header->>'database_id';
 ELSE v_owner:=CASE WHEN NOT(v_doc.header ? 'owner_id') THEN 'local' WHEN jsonb_typeof(v_doc.header->'owner_id')='string' THEN v_doc.header->>'owner_id' ELSE NULL END;END IF;
 -- Probe topology independently of current membership; no synthetic access is returned.
 WHILE EXISTS(SELECT 1 FROM fountain_private.content_search_documents d WHERE d.workspace_id=p_ws AND (COALESCE(d.header->'owner_id','"local"'::jsonb)=to_jsonb(v_probe) OR d.header->'permissions'->'members' ? v_probe))
  OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_ws AND ((e.kind='member' AND e.id=v_probe) OR (e.kind='group' AND jsonb_typeof(e.data->'members')='array' AND e.data->'members' @> jsonb_build_array(v_probe)))) LOOP
  v_probe:=v_probe||'_';
 END LOOP;
 v_reason:=fountain_private.content_access_internal(p_ws,p_kind,p_id,jsonb_build_object('id',v_probe,'role','member'),false);
 v_unknown:=v_reason->>'level' IS NULL OR fountain_private.content_locations(p_ws,p_kind,p_id,true) IS NULL;
 FOR v_member IN SELECT id,data FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='member' ORDER BY id COLLATE "C" LOOP
  IF COALESCE(v_member.data->'active','true')<>'true'::jsonb OR v_member.data->>'role' IS NULL OR v_member.data->>'role' NOT IN('member','admin','guest','owner') THEN CONTINUE;END IF;
  v_reason:=fountain_private.content_access_internal(p_ws,p_kind,p_id,v_member.data,false);v_level:=(v_reason->>'level')::integer;
  IF v_level IS NULL THEN v_unknown:=true;CONTINUE;END IF;
  IF v_member.id=v_owner OR v_member.data->>'role'='owner' OR v_level<1 THEN CONTINUE;END IF;
  IF v_member.data->>'role'='guest' THEN v_external:=v_external+1;ELSE v_internal:=v_internal+1;END IF;
  IF jsonb_array_length(v_sample)<10 THEN v_sample:=v_sample||jsonb_build_array(jsonb_build_object('id',v_member.id,'name',CASE WHEN jsonb_typeof(v_member.data->'name')='string' THEN v_member.data->>'name' ELSE NULL END,'role',v_member.data->>'role','level',v_level));END IF;
 END LOOP;
 SELECT count(*)::integer INTO v_sites FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='site' AND p_kind='page' AND data->>'page_id'=p_id AND fountain_private.content_truth(data->'published');
 SELECT count(*)::integer INTO v_forms FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='form' AND p_kind='database' AND data->>'database_id'=p_id AND fountain_private.content_truth(data->'published');
 SELECT fountain_private.content_truth(data->'disable_public_sharing') INTO v_disabled FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='settings' AND id='workspace';
 v_publication:=CASE WHEN (v_sites+v_forms)>0 AND (COALESCE(v_disabled,false) OR v_unknown OR fountain_private.content_truth(v_doc.header->'archived') OR fountain_private.content_truth(v_doc.header->'deleted') OR fountain_private.content_truth(v_doc.header->'deleted_at')) THEN 'disabled' WHEN v_sites>0 THEN 'authenticated' ELSE 'none' END;
 RETURN jsonb_build_object('audience',CASE WHEN v_unknown THEN 'unknown' WHEN v_external>0 THEN 'external' WHEN v_internal>0 THEN 'internal' ELSE 'private' END,
  'access_summary',jsonb_build_object('internal_count',v_internal,'external_count',v_external,'implicit_owner_id',v_owner,'workspace_owner_override',true,'sample',v_sample,'has_more',v_internal+v_external>10),
  'publication',jsonb_build_object('state',v_publication,'site_count',v_sites,'form_count',v_forms));
END $f$;
-- Definer RPCs call these by schema-qualified name. No REST or caller-role API.
DO $revoke$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_private' AND p.proname IN('content_acl','content_access_internal','content_access_reason','content_access_level','content_locations','content_location','content_root_teamspace','content_in_location','content_review_revision','content_audience') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM fountain_backend',f.signature);
 END LOOP;
END $revoke$;
