DO $vault_integrity$
DECLARE ws text:='qa_retention_integrity_'||replace(gen_random_uuid()::text,'-','');target text:=ws||'_import';rid text:=repeat('e',32);stamp text:='2026-10-17T12:00:00+00:00';t text;v jsonb;row_item record;bad jsonb;hash text:=encode(sha256(decode('616263','hex')),'hex');count_before bigint;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 INSERT INTO fountain_private.entities VALUES(ws,'page','root','{"id":"root","title":"Legacy trash","archived":true,"blocks":[{"attachment_id":"file"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'database','db','{"id":"db","page_id":"root","properties":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','row','{"id":"row","database_id":"db","properties":{}}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'database','outside-db','{"id":"outside-db","properties":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','outside','{"id":"outside","database_id":"outside-db","properties":{},"depends_on":["row"]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','file',jsonb_build_object('id','file','storage','chunks','size',3,'sha256',hash),stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'file',0,decode('616263','hex'));
 v:=fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');
 IF v->>'deleted_at'<>'2026-10-17T12:00:00.000000+00:00' THEN RAISE EXCEPTION 'Legacy trash deleted_at fallback mismatch';END IF;
 EXECUTE 'SET LOCAL ROLE fountain_backend';PERFORM set_config('fountain.retention_transition',ws,true);
 FOREACH t IN ARRAY ARRAY['retention_records','retention_entities','retention_provenance','retention_attachment_refs','retention_identity_reservations','retention_links'] LOOP
  BEGIN EXECUTE format('DELETE FROM fountain_private.%I WHERE workspace_id=$1',t) USING ws;RAISE EXCEPTION 'Raw private delete accepted: %',t;EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;END;
  BEGIN EXECUTE format('UPDATE fountain_private.%I SET workspace_id=workspace_id WHERE workspace_id=$1',t) USING ws;RAISE EXCEPTION 'Raw private update accepted: %',t;EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;END;
 END LOOP;
 BEGIN INSERT INTO fountain_private.retention_records VALUES(ws,repeat('f',32),'{}',stamp,stamp);RAISE EXCEPTION 'Raw private insert accepted';EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;END;
 PERFORM set_config('fountain.retention_transition','',true);EXECUTE 'RESET ROLE';
 -- Deleting both attachment snapshot and its pins/reservation, then changing
 -- counts cannot hide an omitted document attachment in a forged v3 image.
 BEGIN
  PERFORM set_config('fountain.retention_transition',ws,true);
  DELETE FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=rid AND kind='attachment';
  DELETE FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND record_id=rid;
  DELETE FROM fountain_private.retention_identity_reservations WHERE workspace_id=ws AND record_id=rid AND kind='attachment';
  UPDATE fountain_private.retention_records SET data=jsonb_set(data::jsonb,'{counts}',((data::jsonb->'counts')||'{"entities":3,"refs":0,"reservations":3}'::jsonb))::text WHERE workspace_id=ws AND id=rid;
  PERFORM fountain_private.retention_validate_record(ws,rid,false);RAISE EXCEPTION 'Reverse attachment omission accepted';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 PERFORM fountain_private.retention_validate_record(ws,rid,true);
 -- Nested import fails explicitly: a source record inserted in this
 -- rollback harness's subtransaction cannot be appended as a top-level import.
 PERFORM set_config('fountain.workspace_id',target,true);EXECUTE 'SET LOCAL ROLE fountain_backend';
 BEGIN
  EXECUTE 'RESET ROLE';SELECT to_jsonb(r)-'workspace_id' INTO v FROM fountain_private.retention_records r WHERE workspace_id=ws AND id=rid;EXECUTE 'SET LOCAL ROLE fountain_backend';
  PERFORM fountain_cloud.retention_import_row(target,'retention_records',v);
  EXECUTE 'RESET ROLE';SELECT to_jsonb(r)-'workspace_id' INTO v FROM fountain_private.retention_entities r WHERE workspace_id=ws AND record_id=rid LIMIT 1;EXECUTE 'SET LOCAL ROLE fountain_backend';
  PERFORM fountain_cloud.retention_import_row(target,'retention_entities',v);RAISE EXCEPTION 'Nested private import accepted';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 EXECUTE 'RESET ROLE';
 IF EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=target) THEN RAISE EXCEPTION 'Rejected nested import left partial record';END IF;
 PERFORM set_config('fountain.workspace_id',ws,true);
 -- Zero-sized retained attachments pin metadata and reject new physical bytes.
 INSERT INTO fountain_private.entities VALUES(ws,'page','zero','{"id":"zero","title":"Zero","archived":true,"blocks":[{"attachment_id":"zero-file"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','zero-other','{"id":"zero-other","title":"Other","blocks":[{"attachment_id":"zero-file"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','zero-file','{"id":"zero-file","size":0,"storage":"chunks"}'::jsonb,stamp,stamp);
 PERFORM fountain_cloud.retention_archive_page(ws,'zero',stamp,30,NULL,repeat('f',32),NULL,'manual');
 EXECUTE 'SET LOCAL ROLE fountain_backend';
 BEGIN UPDATE fountain_private.entities SET data=data||'{"name":"changed"}'::jsonb WHERE workspace_id=ws AND kind='attachment' AND id='zero-file';RAISE EXCEPTION 'Zero-sized pinned metadata overwrite accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN INSERT INTO fountain_private.attachment_chunks VALUES(ws,'zero-file',0,decode('61','hex'));RAISE EXCEPTION 'Zero-sized retained attachment grew bytes';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 EXECUTE 'RESET ROLE';
END $vault_integrity$;
