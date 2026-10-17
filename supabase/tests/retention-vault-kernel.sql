-- Explicit rollback-only component proof. This exercises actual PostgreSQL
-- tables/triggers/kernels as backend; it is not real Auth or Edge evidence.
DO $vault_test$
DECLARE ws text:='qa_retention_vault_'||replace(gen_random_uuid()::text,'-','');other text:=ws||'_other';stamp text:='2026-10-17T12:00:00.000000+00:00';rid text:=repeat('a',32);rid2 text:=repeat('b',32);rid3 text:=repeat('c',32);answer jsonb;gen text;root_data jsonb;proof jsonb;expect integer;hash text:=encode(sha256(decode('616263','hex')),'hex');r record;before_rev bigint;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 -- Existing behavior with no vault state, then full nested graph with >4MiB
 -- source text. No whole-closure frame is materialized by the kernel.
 INSERT INTO fountain_private.entities VALUES(ws,'database','outside-db','{"id":"outside-db","properties":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','outside-row','{"id":"outside-row","database_id":"outside-db","properties":{},"depends_on":["owned-row","keep"]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','root',jsonb_build_object('id','root','title','Secret retained title','archived',true,'deleted_at',stamp,'blocks',jsonb_build_array(jsonb_build_object('text',repeat('x',4194304)||'tail','attachment_id','blob'))),stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','child','{"id":"child","title":"Child","parent_id":"root","blocks":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','grandchild','{"id":"grandchild","title":"Grandchild","parent_id":"child","blocks":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'database','owned-db','{"id":"owned-db","page_id":"child","properties":[{"id":"files","type":"files"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','owned-row','{"id":"owned-row","database_id":"owned-db","properties":{"files":["blob"]},"depends_on":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'version','version','{"id":"version","page_id":"root","blocks":[{"attachment_id":"blob"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'comment','comment','{"id":"comment","page_id":"child","text":"Comment secret"}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'collaboration','root','{"id":"root","epoch":"preserve-exact","state":{}}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'wiki_page','wiki','{"id":"wiki","page_id":"child"}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'site','site','{"id":"site","page_id":"root","published":true}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'form','form','{"id":"form","database_id":"owned-db","published":true}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'automation','automation','{"id":"automation","database_id":"owned-db","enabled":true}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'transcript','transcript','{"id":"transcript","page_id":"grandchild","text":"Transcript"}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','blob',jsonb_build_object('id','blob','page_id','root','storage','chunks','size',3,'sha256',hash),stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'blob',0,decode('616263','hex'));
 SELECT data INTO root_data FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id='root';
 SELECT generation INTO gen FROM fountain_private.content_provenance WHERE workspace_id=ws AND kind='page' AND id='root';
 SELECT to_jsonb(p)-'workspace_id' INTO proof FROM fountain_private.content_provenance p WHERE workspace_id=ws AND kind='page' AND id='root';
 -- Stale source and pending upload fail without a partial record.
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'root',stamp,30,999,rid,NULL,'manual');RAISE EXCEPTION 'Expected source revision conflict';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 INSERT INTO fountain_private.entities VALUES(ws,'upload','pending','{"id":"pending","page_id":"child","completed":false}'::jsonb,stamp,stamp);
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');RAISE EXCEPTION 'Expected pending upload conflict';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 IF EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws) THEN RAISE EXCEPTION 'Failed archive left partial records';END IF;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='upload';
 EXECUTE 'SET LOCAL ROLE fountain_backend';
 answer:=fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');
 IF answer->'counts'->>'entities'<>'14' OR answer->'counts'->>'provenance'<>'5' OR answer->'counts'->>'refs'<>'1' OR answer->'counts'->>'reservations'<>'14' OR answer->'counts'->>'links'<>'1' THEN RAISE EXCEPTION 'Full closure counts mismatch: %',answer->'counts';END IF;
 before_rev:=(SELECT (data#>>'{}')::bigint FROM fountain_private.meta WHERE workspace_id=ws AND key='_entity_revision');
 IF fountain_cloud.retention_archive_page(ws,'root',stamp,30,(answer->>'source_revision')::bigint,rid,NULL,'manual') IS DISTINCT FROM answer OR (SELECT (data#>>'{}')::bigint FROM fountain_private.meta WHERE workspace_id=ws AND key='_entity_revision')<>before_rev THEN RAISE EXCEPTION 'Archive retry was not idempotent';END IF;
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'root',stamp,31,NULL,rid,NULL,'manual');RAISE EXCEPTION 'Mismatched archive retry accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 IF answer->'header' ? 'blocks' OR answer->'header' ? 'title' OR answer ? 'entities' THEN RAISE EXCEPTION 'Metadata response leaked raw source';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND id IN('root','child','grandchild','owned-db','owned-row','blob')) OR (SELECT data->'depends_on' FROM fountain_private.entities WHERE workspace_id=ws AND id='outside-row')<>'["keep"]'::jsonb THEN RAISE EXCEPTION 'Live source or inbound dependency remained';END IF;
 -- Raw backend SQL cannot forge kernel authority or reserved descendants.
 PERFORM set_config('fountain.retention_transition',ws,true);
 BEGIN INSERT INTO fountain_private.entities VALUES(ws,'page','root',root_data,stamp,stamp);RAISE EXCEPTION 'Reserved identity bypass';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN INSERT INTO fountain_private.entities VALUES(ws,'comment','new-comment','{"id":"new-comment","page_id":"root"}'::jsonb,stamp,stamp);RAISE EXCEPTION 'Retained parent bypass';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN INSERT INTO fountain_private.entities VALUES(ws,'wiki_page','root','{"id":"root"}'::jsonb,stamp,stamp);RAISE EXCEPTION 'Retained id-only wiki parent bypass';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN DELETE FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='blob';RAISE EXCEPTION 'Retained byte delete bypass';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN UPDATE fountain_private.attachment_chunks SET data=decode('646566','hex') WHERE workspace_id=ws AND attachment_id='blob';RAISE EXCEPTION 'Retained byte overwrite bypass';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 PERFORM set_config('fountain.retention_transition','',true);
 -- Private namespace and absent client grants protect raw retained bodies.
 PERFORM set_config('fountain.workspace_id',other,true);
 IF EXISTS(SELECT 1 FROM fountain_private.retention_entities) OR EXISTS(SELECT 1 FROM fountain_private.retention_records) THEN RAISE EXCEPTION 'Cross-workspace retention leaked';END IF;
 BEGIN PERFORM fountain_cloud.retention_restore_to_trash(ws,rid);RAISE EXCEPTION 'Restore namespace bypass';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 PERFORM set_config('fountain.workspace_id',ws,true);
 -- Concurrent external edits cannot be overwritten on restore.
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{depends_on}','["changed"]') WHERE workspace_id=ws AND id='outside-row';
 BEGIN PERFORM fountain_cloud.retention_restore_to_trash(ws,rid);RAISE EXCEPTION 'External dependency conflict ignored';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{depends_on}','["keep"]') WHERE workspace_id=ws AND id='outside-row';
 answer:=fountain_cloud.retention_restore_to_trash(ws,rid);
 IF (SELECT data FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id='root') IS DISTINCT FROM root_data OR (SELECT data->>'epoch' FROM fountain_private.entities WHERE workspace_id=ws AND kind='collaboration' AND id='root')<>'preserve-exact' THEN RAISE EXCEPTION 'Exact raw source restoration failed';END IF;
 IF (SELECT to_jsonb(p)-'workspace_id' FROM fountain_private.content_provenance p WHERE workspace_id=ws AND kind='page' AND id='root') IS DISTINCT FROM proof OR (SELECT generation FROM fountain_private.content_search_documents WHERE workspace_id=ws AND kind='page' AND id='root')<>gen THEN RAISE EXCEPTION 'Historical provenance or generation changed';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind IN('site','form') AND data->'published'<>'false'::jsonb) OR EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='automation' AND data->'enabled'<>'false'::jsonb) THEN RAISE EXCEPTION 'Restoration republished content or enabled automation';END IF;
 IF (SELECT data->'depends_on' FROM fountain_private.entities WHERE workspace_id=ws AND id='outside-row')<>'["owned-row","keep"]'::jsonb OR EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws) THEN RAISE EXCEPTION 'Restored dependencies or private cleanup failed';END IF;
 EXECUTE 'RESET ROLE';
 SELECT count(*) INTO expect FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fountain_private' AND c.relname LIKE 'retention_%' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND NOT has_table_privilege('anon',c.oid,'SELECT') AND NOT has_table_privilege('authenticated',c.oid,'SELECT') AND NOT has_table_privilege('service_role',c.oid,'SELECT');
 IF expect<>6 THEN RAISE EXCEPTION 'Private retention grants/RLS failed';END IF;
 -- Shared attachment both restore orders, including a third rearchive episode.
 INSERT INTO fountain_private.entities VALUES(ws,'page','A','{"id":"A","title":"A","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[{"attachment_id":"shared"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','B','{"id":"B","title":"B","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[{"attachment_id":"shared"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','shared',jsonb_build_object('id','shared','storage','chunks','size',3,'sha256',hash),stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'shared',0,decode('616263','hex'));
 FOR expect IN 1..2 LOOP
  PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,30,NULL,rid,NULL,'manual');
  IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='shared') THEN RAISE EXCEPTION 'Shared live attachment was moved';END IF;
  BEGIN DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='shared';RAISE EXCEPTION 'Pinned shared metadata deletion bypass';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
  PERFORM fountain_cloud.retention_archive_page(ws,'B',stamp,30,NULL,rid2,NULL,'manual');
  IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='shared') THEN RAISE EXCEPTION 'Exclusive retained attachment remained live';END IF;
  IF expect=1 THEN
   PERFORM fountain_cloud.retention_restore_to_trash(ws,rid);
   -- Re-archiving A must not take B's reservation or unpin its bytes.
   PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,30,NULL,rid3,NULL,'manual');
   IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='shared') OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_identity_reservations WHERE workspace_id=ws AND kind='attachment' AND id='shared' AND record_id=rid2) THEN RAISE EXCEPTION 'Shared rearchive leaked metadata or stole reservation';END IF;
   PERFORM fountain_cloud.retention_restore_to_trash(ws,rid2);
   PERFORM fountain_cloud.retention_restore_to_trash(ws,rid3);
  ELSE
   PERFORM fountain_cloud.retention_restore_to_trash(ws,rid2);
   PERFORM fountain_cloud.retention_restore_to_trash(ws,rid);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='shared') OR EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws) THEN RAISE EXCEPTION 'Shared restore order failed';END IF;
 END LOOP;
 -- Cycle fails instead of truncating; retention day/date bounds are strict.
 INSERT INTO fountain_private.entities VALUES(ws,'page','cycle','{"id":"cycle","title":"Cycle","parent_id":"cycle","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[]}'::jsonb,stamp,stamp);
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'cycle',stamp,30,NULL,rid,NULL,'manual');RAISE EXCEPTION 'Cycle accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'A','2026-10-17T24:00:00+00:00',30,NULL,rid,NULL,'manual');RAISE EXCEPTION 'Invalid time accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,0,NULL,rid,NULL,'manual');RAISE EXCEPTION 'Invalid period accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
END $vault_test$;
