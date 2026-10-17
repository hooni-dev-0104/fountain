-- Private SQL component only: no real Auth/session/Edge verification and no
-- authentication stub. Apply the pending migration in the same transaction as
-- this file, then ALWAYS ROLLBACK (including on failure).
SELECT set_config('fountain.location_test_workspace','fountain-qa-trash-location-'||replace(gen_random_uuid()::text,'-',''),true);
SELECT set_config('fountain.location_test_cases','0',true);
CREATE FUNCTION pg_temp.location_fixtures() RETURNS void LANGUAGE plpgsql AS $f$
#variable_conflict use_column
DECLARE ws text:=current_setting('fountain.location_test_workspace');id text;data jsonb;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);
 FOREACH id IN ARRAY ARRAY['grand','parent','leaf','unrelated','active'] LOOP
  data:=jsonb_build_object('id',id,'title',id,'blocks','[]'::jsonb,'revision',1,'archived',id='leaf','deleted',id='leaf','deleted_at',CASE WHEN id='leaf' THEN '2026-01-02T00:00:00Z' END,'parent_id',CASE WHEN id IN('leaf','active') THEN 'parent' WHEN id='parent' THEN 'grand' END,'teamspace_id','team','created_at','2026-01-01T00:00:00Z','updated_at','2026-01-01T00:00:00Z');
  INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES(ws,'page',id,data,data->>'created_at',data->>'updated_at') ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data;
 END LOOP;
 data:='{"id":"team","name":"Team","active":true,"archived":false,"deleted":false,"deleted_at":null,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}';
 INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES(ws,'teamspace','team',data,data->>'created_at',data->>'updated_at') ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data;
END $f$;
CREATE FUNCTION pg_temp.location_rejects(p_kind text,p_id text,p_patch jsonb,p_remove boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $f$
#variable_conflict use_column
DECLARE ws text:=current_setting('fountain.location_test_workspace');
BEGIN
 PERFORM pg_temp.location_fixtures();
 IF p_remove THEN DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind=p_kind AND id=p_id;
 ELSE UPDATE fountain_private.entities SET data=data||p_patch WHERE workspace_id=ws AND kind=p_kind AND id=p_id;END IF;
 IF fountain_private.content_location(ws,'page','leaf') IS NOT NULL OR fountain_private.content_in_location(ws,'page','leaf','page','parent') OR fountain_private.content_in_location(ws,'page','leaf','page','grand') OR fountain_private.content_in_location(ws,'page','leaf','teamspace','team') THEN RAISE EXCEPTION 'Invalid original location accepted: %, %, %',p_kind,p_id,p_patch;END IF;
 PERFORM set_config('fountain.location_test_cases',(current_setting('fountain.location_test_cases')::integer+1)::text,true);
END $f$;
DO $location_filter$
#variable_conflict use_column
DECLARE ws text:=current_setting('fountain.location_test_workspace');target_kind text;target_id text;key text;marker jsonb;location jsonb;expected boolean;kind text;id text;role text;data jsonb;
BEGIN
 PERFORM pg_temp.location_fixtures();
 location:=fountain_private.content_location(ws,'page','leaf');
 IF location IS DISTINCT FROM '{"kind":"page","id":"parent","title":"parent"}'::jsonb THEN RAISE EXCEPTION 'Trashed leaf lost original metadata';END IF;
 IF NOT fountain_private.content_in_location(ws,'page','leaf','page','parent') OR NOT fountain_private.content_in_location(ws,'page','leaf','page','grand') OR NOT fountain_private.content_in_location(ws,'page','leaf','teamspace','team') OR fountain_private.content_in_location(ws,'page','leaf','page','unrelated') OR fountain_private.content_in_location(ws,'page','leaf','page','leaf') OR fountain_private.content_in_location(ws,'page','leaf','database','parent') THEN RAISE EXCEPTION 'Direct/ancestor membership incorrect';END IF;
 -- Only an actual archived=true selected page receives the new path.
 FOREACH marker IN ARRAY ARRAY['false'::jsonb,'"true"','null','0'] LOOP
  PERFORM pg_temp.location_fixtures();
  UPDATE fountain_private.entities e SET data=e.data||jsonb_build_object('archived',marker) WHERE e.workspace_id=ws AND e.kind='page' AND e.id='leaf';
  expected:=EXISTS(SELECT 1 FROM jsonb_array_elements(fountain_private.content_locations(ws,'page','leaf')) x WHERE x.value->>'kind'='page' AND x.value->>'id'='parent');
  IF fountain_private.content_in_location(ws,'page','leaf','page','parent') IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Non-archived path changed';END IF;
 END LOOP;
 FOREACH target_kind IN ARRAY ARRAY['page','teamspace'] LOOP
  target_id:=CASE target_kind WHEN 'page' THEN 'parent' ELSE 'team' END;
  FOREACH key IN ARRAY ARRAY['archived','deleted','active'] LOOP
   FOREACH marker IN ARRAY ARRAY['"false"'::jsonb,'null','0','{}','[]',CASE WHEN key='active' THEN 'false'::jsonb ELSE 'true'::jsonb END] LOOP
    PERFORM pg_temp.location_rejects(target_kind,target_id,jsonb_build_object(key,marker));
   END LOOP;
  END LOOP;
  PERFORM pg_temp.location_rejects(target_kind,target_id,'{"deleted_at":"2026-01-02T00:00:00Z"}');
  PERFORM pg_temp.location_rejects(target_kind,target_id,'{}',true);
 END LOOP;
 PERFORM pg_temp.location_rejects('page','grand','{"archived":true}');
 PERFORM pg_temp.location_rejects('page','grand','{"parent_id":"missing"}');
 PERFORM pg_temp.location_rejects('page','grand','{"parent_id":"leaf"}');
 PERFORM pg_temp.location_rejects('page','parent','{"parent_id":false}');
 PERFORM pg_temp.location_rejects('page','parent','{"parent_id":""}');
 PERFORM pg_temp.location_fixtures();
 UPDATE fountain_private.entities e SET data=e.data||'{"parent_id":null,"teamspace_id":null}' WHERE e.workspace_id=ws AND e.kind='page' AND e.id='leaf';
 IF fountain_private.content_location(ws,'page','leaf') IS NOT NULL OR fountain_private.content_in_location(ws,'page','leaf','page','parent') OR fountain_private.content_in_location(ws,'page','leaf','teamspace','team') THEN RAISE EXCEPTION 'Rootless page matched location';END IF;
 PERFORM pg_temp.location_fixtures();
 UPDATE fountain_private.entities e SET data=e.data||'{"parent_id":null}' WHERE e.workspace_id=ws AND e.kind='page' AND e.id='leaf';
 IF fountain_private.content_location(ws,'page','leaf') IS DISTINCT FROM '{"kind":"teamspace","id":"team","title":"Team"}'::jsonb OR NOT fountain_private.content_in_location(ws,'page','leaf','teamspace','team') OR fountain_private.content_in_location(ws,'page','leaf','page','parent') THEN RAISE EXCEPTION 'Direct teamspace membership incorrect';END IF;
 PERFORM pg_temp.location_fixtures();
 -- Active pages and databases keep the prior exact membership expression.
 data:='{"id":"database","name":"Database","properties":[],"parent_id":"parent","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}';
 INSERT INTO fountain_private.entities VALUES(ws,'database','database',data,data->>'created_at',data->>'updated_at');
 data:='{"id":"row","database_id":"database","properties":{},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}';
 INSERT INTO fountain_private.entities VALUES(ws,'row','row',data,data->>'created_at',data->>'updated_at');
 FOREACH kind IN ARRAY ARRAY['page','database','row'] LOOP
  id:=CASE kind WHEN 'page' THEN 'active' ELSE kind END;
  FOREACH target_kind IN ARRAY ARRAY['page','teamspace','database'] LOOP
   FOREACH target_id IN ARRAY ARRAY['parent','grand','team','unrelated'] LOOP
    expected:=EXISTS(SELECT 1 FROM jsonb_array_elements(fountain_private.content_locations(ws,kind,id)) x WHERE x.value->>'kind'=target_kind AND x.value->>'id'=target_id);
    IF fountain_private.content_in_location(ws,kind,id,target_kind,target_id) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Existing active/non-page behavior changed';END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 FOREACH role IN ARRAY ARRAY['anon','authenticated','service_role','fountain_backend'] LOOP
  IF has_function_privilege(role,'fountain_private.content_in_location(text,text,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Private location helper exposed to %',role;END IF;
 END LOOP;
END $location_filter$;
SELECT jsonb_build_object('passed',true,'groups',5,'invalid_location_cases',current_setting('fountain.location_test_cases')::integer,'active_nonpage_parity_cases',36,'auth_stub',false,'real_auth_verified',false,'fixture_entities',(SELECT count(*) FROM fountain_private.entities WHERE workspace_id=current_setting('fountain.location_test_workspace'))) AS location_filter_proof;
