-- Run with index + access migrations inside a transaction and ROLLBACK.
DO $test$
DECLARE ws text:='qa_content_access_'||replace(gen_random_uuid()::text,'-','');r jsonb;a text;b text;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO fountain_private.entities VALUES
 (ws,'member','owner','{"id":"owner","role":"owner"}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'member','writer','{"id":"writer","role":"member","name":"가족"}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'member','guest','{"id":"guest","role":"guest"}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'teamspace','root-space','{"id":"root-space","name":"Root","visibility":"private"}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'teamspace','stale-space','{"id":"stale-space","name":"Stale"}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'page','root','{"id":"root","owner_id":"writer","teamspace_id":"root-space","title":"Root","permissions":{"default":"private"}}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'page','private','{"id":"private","owner_id":"writer","parent_id":"root","teamspace_id":"stale-space","title":"Private","permissions":{"default":"private"}}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'page','shared','{"id":"shared","owner_id":"writer","title":"Shared","permissions":{"default":"private","members":{"guest":"view"}}}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'page','bad','{"id":"bad","owner_id":"writer","title":"Bad","permissions":{"members":{"guest":"INVALID"}}}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'page','orphan-private','{"id":"orphan-private","owner_id":"writer","parent_id":"missing","permissions":{"default":"private","inherit":false}}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'site','published','{"id":"published","page_id":"private","published":true}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'database','db','{"id":"db","title":"DB","owner_id":"writer","permissions":{"default":"private"},"properties":[]}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'row','r','{"id":"r","database_id":"db","owner_id":"guest","properties":{}}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z'),
 (ws,'form','published-form','{"id":"published-form","database_id":"db","published":true}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z');
 r:=fountain_private.content_audience(ws,'page','private');
 IF r->>'audience'<>'private' OR r#>>'{publication,state}'<>'authenticated' OR r#>>'{access_summary,internal_count}'<>'0' THEN RAISE EXCEPTION 'Private page misclassified %',r;END IF;
 IF fountain_private.content_access_level(ws,'page','private','owner')<>4 OR fountain_private.content_access_level(ws,'page','private','owner',false)<>0 THEN RAISE EXCEPTION 'Owner override leaked';END IF;
 r:=fountain_private.content_location(ws,'page','private');IF r->>'id'<>'root' OR r->>'kind'<>'page' THEN RAISE EXCEPTION 'Closest parent location missing %',r;END IF;
 IF fountain_private.content_root_teamspace(ws,'page','private')->>'id'<>'root-space' OR NOT fountain_private.content_in_location(ws,'page','private','teamspace','root-space') OR fountain_private.content_in_location(ws,'page','private','teamspace','stale-space') THEN RAISE EXCEPTION 'Stale leaf location used';END IF;
 IF fountain_private.content_audience(ws,'page','shared')->>'audience'<>'external' THEN RAISE EXCEPTION 'Guest access missed';END IF;
 IF fountain_private.content_audience(ws,'page','bad')->>'audience'<>'unknown' THEN RAISE EXCEPTION 'Malformed ACL assumed private';END IF;
 IF fountain_private.content_audience(ws,'page','orphan-private')->>'audience'<>'unknown' THEN RAISE EXCEPTION 'Private ACL hid malformed structural parent';END IF;
 IF fountain_private.content_location(ws,'row','r')->>'id'<>'db' OR NOT fountain_private.content_in_location(ws,'row','r','database','db') THEN RAISE EXCEPTION 'Row database location lost';END IF;
 IF fountain_private.content_access_level(ws,'row','r','guest')<>0 OR fountain_private.content_access_reason(ws,'row','r','writer')->>'can_revoke'<>'false' THEN RAISE EXCEPTION 'Row owner or DB owner semantics changed';END IF;
 IF fountain_private.content_audience(ws,'database','db')#>>'{publication,state}'<>'none' OR fountain_private.content_audience(ws,'database','db')->>'audience'<>'private' THEN RAISE EXCEPTION 'Form exposes DB classification';END IF;
 UPDATE fountain_private.entities SET data=data||'{"archived":true}' WHERE workspace_id=ws AND kind='page' AND id='private';
 IF fountain_private.content_audience(ws,'page','private')#>>'{publication,state}'<>'disabled' OR fountain_private.content_audience(ws,'page','private')#>>'{publication,site_count}'<>'1' THEN RAISE EXCEPTION 'Trash publication unavailable state lost';END IF;
 UPDATE fountain_private.entities SET data=data-'archived' WHERE workspace_id=ws AND kind='page' AND id='private';
 a:=fountain_private.content_review_revision(ws,'page','private');IF a !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Missing review proof';END IF;
 UPDATE fountain_private.entities SET data=data||'{"name":"Renamed"}' WHERE workspace_id=ws AND kind='member' AND id='guest';
 b:=fountain_private.content_review_revision(ws,'page','private');IF a=b THEN RAISE EXCEPTION 'Membership change retained review proof';END IF;
 IF fountain_private.content_access_level(ws||'_other','page','private','owner')<>0 THEN RAISE EXCEPTION 'Cross workspace leaked';END IF;
 INSERT INTO fountain_private.entities VALUES(ws,'settings','workspace','{"id":"workspace","disable_public_sharing":true}','2026-10-17T00:00:00Z','2026-10-17T00:00:00Z');
 IF fountain_private.content_audience(ws,'page','private')#>>'{publication,state}'<>'disabled' THEN RAISE EXCEPTION 'Sharing disable ignored';END IF;
 IF fountain_private.content_casefold('Ａ')<>'ａ' OR fountain_private.content_casefold('StraßeΣ')<>'strasseσ' OR fountain_private.content_casefold(' É ')<>' é ' THEN RAISE EXCEPTION 'Assignment email casefold normalized or trimmed';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_private' AND p.proname IN('content_access_level','content_access_reason','content_access_internal','content_audience','content_locations','content_location','content_root_teamspace','content_in_location','content_review_revision') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE') OR has_function_privilege('fountain_backend',p.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'Private helper executable externally';END IF;
END $test$;
