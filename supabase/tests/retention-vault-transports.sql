-- Actual kernel regressions for mixed storage and repeated shared restoration.
DO $vault_mixed$
DECLARE ws text:='qa_retention_mixed_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00+00:00';rid text:=repeat('7',32);tail_hash text:=encode(sha256(decode('616263','hex')),'hex');key_id text:=encode(sha256(convert_to('["mixed",4194304]','UTF8')),'hex');answer jsonb;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 INSERT INTO fountain_private.entities VALUES(ws,'page','root','{"id":"root","archived":true,"blocks":[{"attachment_id":"mixed"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','mixed','{"id":"mixed","storage":"chunks","size":4194307}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'mixed',0,convert_to(repeat('a',4194304),'UTF8'));
 INSERT INTO fountain_private.entities VALUES(ws,'attachment_chunk',key_id,jsonb_build_object('id',key_id,'attachment_id','mixed','offset',4194304,'size',3,'sha256',tail_hash),stamp,stamp);
 answer:=fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');
 IF answer->'counts'->>'refs'<>'2' OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND record_id=rid AND storage_kind='blob' AND "offset"=0) OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND record_id=rid AND storage_kind='file' AND "offset"=4194304) THEN RAISE EXCEPTION 'Mixed storage offsets were omitted';END IF;
 PERFORM fountain_cloud.retention_stage_blob(ws,rid,'mixed',4194304,decode('616263','hex'));
 PERFORM fountain_cloud.retention_restore_to_trash(ws,rid);
 IF (SELECT sum(octet_length(data)) FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='mixed')<>4194307 OR EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment_chunk' AND id=key_id) THEN RAISE EXCEPTION 'Mixed native restore lost bytes or kept duplicate transport';END IF;
END $vault_mixed$;

DO $vault_shared_transport$
DECLARE ws text:='qa_retention_shared_transport_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00+00:00';a text:=repeat('a',32);b text:=repeat('b',32);c text:=repeat('c',32);hash text:=encode(sha256(decode('616263','hex')),'hex');key_id text:=encode(sha256(convert_to('["file",0]','UTF8')),'hex');n integer;file_data jsonb;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 file_data:=jsonb_build_object('id',key_id,'attachment_id','file','offset',0,'size',3,'sha256',hash);
 FOR n IN 1..2 LOOP
  INSERT INTO fountain_private.entities VALUES(ws,'page','A','{"id":"A","archived":true,"blocks":[{"attachment_id":"file"}]}'::jsonb,stamp,stamp);
  INSERT INTO fountain_private.entities VALUES(ws,'page','B','{"id":"B","archived":true,"blocks":[{"attachment_id":"file"}]}'::jsonb,stamp,stamp);
  INSERT INTO fountain_private.entities VALUES(ws,'attachment','file','{"id":"file","storage":"chunks","size":3}'::jsonb,stamp,stamp);
  INSERT INTO fountain_private.entities VALUES(ws,'attachment_chunk',key_id,file_data,stamp,stamp);
  PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,30,NULL,a,NULL,'manual');
  PERFORM fountain_cloud.retention_archive_page(ws,'B',stamp,30,NULL,b,NULL,'manual');
  PERFORM fountain_cloud.retention_stage_blob(ws,a,'file',0,decode('616263','hex'));
  PERFORM fountain_cloud.retention_restore_to_trash(ws,a);
  PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,30,NULL,c,NULL,'manual');
  IF NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND record_id=c AND storage_kind='blob') OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND record_id=b AND storage_kind='file') THEN RAISE EXCEPTION 'Expected cross-transport private pins';END IF;
  IF n=1 THEN PERFORM fountain_cloud.retention_restore_to_trash(ws,b);PERFORM fountain_cloud.retention_restore_to_trash(ws,c);ELSE PERFORM fountain_cloud.retention_restore_to_trash(ws,c);PERFORM fountain_cloud.retention_restore_to_trash(ws,b);END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment_chunk') OR (SELECT encode(data,'hex') FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='file')<>'616263' THEN RAISE EXCEPTION 'Cross-transport restore order failed';END IF;
  DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind IN('page','attachment');DELETE FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='file';
 END LOOP;
 -- A alone retained while B is active: releasing the final pin after staging
 -- must leave exactly one live byte transport, with the shared source intact.
 INSERT INTO fountain_private.entities VALUES(ws,'page','A','{"id":"A","archived":true,"blocks":[{"attachment_id":"file"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','B','{"id":"B","archived":false,"blocks":[{"attachment_id":"file"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','file','{"id":"file","storage":"chunks","size":3}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment_chunk',key_id,file_data,stamp,stamp);
 PERFORM fountain_cloud.retention_archive_page(ws,'A',stamp,30,NULL,a,NULL,'manual');
 IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment_chunk' AND id=key_id) THEN RAISE EXCEPTION 'Shared file manifest moved prematurely';END IF;
 PERFORM fountain_cloud.retention_stage_blob(ws,a,'file',0,decode('616263','hex'));
 PERFORM fountain_cloud.retention_restore_to_trash(ws,a);
 IF EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment_chunk' AND id=key_id) OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='file') OR (SELECT encode(data,'hex') FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='file')<>'616263' THEN RAISE EXCEPTION 'Last shared file pin release left ambiguous runtime transports';END IF;
END $vault_shared_transport$;
