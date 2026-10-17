-- Two retained records may not independently overwrite one inbound task journal.
DO $vault_links$
DECLARE ws text:='qa_retention_links_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00+00:00';a text:=repeat('a',32);b text:=repeat('b',32);v jsonb;hash text:=encode(sha256(decode('616263','hex')),'hex');
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 INSERT INTO fountain_private.entities VALUES(ws,'page','A','{"id":"A","title":"A","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','B','{"id":"B","title":"B","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','X','{"id":"X","title":"X","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'database','A-db','{"id":"A-db","page_id":"A","properties":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'database','B-db','{"id":"B-db","page_id":"B","properties":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'database','X-db','{"id":"X-db","page_id":"X","properties":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','A-row','{"id":"A-row","database_id":"A-db","properties":{}}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','B-row','{"id":"B-row","database_id":"B-db","properties":{}}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','X-row','{"id":"X-row","database_id":"X-db","properties":{},"depends_on":["A-row","B-row"]}'::jsonb,stamp,stamp);
 PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,30,NULL,a,NULL,'manual');
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'B',stamp,30,NULL,b,NULL,'manual');RAISE EXCEPTION 'Cross-record inbound journal conflict accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN PERFORM fountain_cloud.retention_archive_page(ws,'X',stamp,30,NULL,b,NULL,'manual');RAISE EXCEPTION 'Archiving journal source accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 IF EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws AND id=b) OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND id='B-row') OR (SELECT data->'depends_on' FROM fountain_private.entities WHERE workspace_id=ws AND kind='row' AND id='X-row')<>'["B-row"]'::jsonb THEN RAISE EXCEPTION 'Conflicting archive changed live or vault state';END IF;
 PERFORM fountain_cloud.retention_restore_to_trash(ws,a);
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{depends_on}','[]') WHERE workspace_id=ws AND kind='row' AND id='X-row';
 -- History-only attachment on a LIVE B must keep A's attachment shared.
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{blocks}','[{"attachment_id":"old"}]') WHERE workspace_id=ws AND kind='page' AND id='A';
 INSERT INTO fountain_private.entities VALUES(ws,'collaboration','B','{"id":"B","state":{"blocks":{},"history":{"baseline":{"blocks":{}},"ops":{"old-set":{"type":"block.set","field":"attachment_id","value":"old"},"current-set":{"type":"block.set","field":"attachment_id","value":null}}}}}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','old',jsonb_build_object('id','old','storage','chunks','size',3,'sha256',hash),stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'old',0,decode('616263','hex'));
 PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,30,NULL,a,NULL,'manual');
 IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='old') OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=a AND kind='attachment' AND id='old' AND ownership='shared') THEN RAISE EXCEPTION 'History-only live reference failed to keep shared attachment';END IF;
 -- Remove unrelated dependency fixture so B may be archived independently.
 PERFORM fountain_cloud.retention_archive_page(ws,'B',stamp,30,NULL,b,NULL,'manual');
 IF NOT EXISTS(SELECT 1 FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=b AND kind='attachment' AND id='old') THEN RAISE EXCEPTION 'History-only source was omitted from retained snapshot';END IF;
 PERFORM fountain_cloud.retention_restore_to_trash(ws,a);PERFORM fountain_cloud.retention_restore_to_trash(ws,b);
 IF (SELECT data#>>'{state,history,ops,old-set,value}' FROM fountain_private.entities WHERE workspace_id=ws AND kind='collaboration' AND id='B')<>'old' OR (SELECT encode(data,'hex') FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='old')<>'616263' THEN RAISE EXCEPTION 'Latent history snapshot or immutable bytes changed';END IF;
END $vault_links$;
