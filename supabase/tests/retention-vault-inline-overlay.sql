-- Legacy inline originals may also have a finalized cloud migration overlay.
DO $inline_overlay$
DECLARE ws text:='qa_retention_inline_overlay_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00+00:00';rid text:=repeat('8',32);hash text:=encode(sha256(decode('616263','hex')),'hex');original jsonb;overlay jsonb;raw_original text;raw_overlay text;answer jsonb;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 original:=jsonb_build_object('id','inline','size',3,'data','YWJj','sha256',hash,'name','Legacy source');
 overlay:=jsonb_build_object('id','inline','size',3,'storage','chunks','storage_id','inline-physical','sha256',hash,'cloud_chunks',jsonb_build_array(jsonb_build_object('version',1,'attachmentId','inline-physical','offset',0,'size',3,'sha256',hash)));
 INSERT INTO fountain_private.entities VALUES(ws,'page','root','{"id":"root","archived":true,"blocks":[{"attachment_id":"inline"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','inline',original,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment_cloud','inline',overlay,stamp,stamp);
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('fountain-files','v1/'||encode(sha256(convert_to(ws,'UTF8')),'hex')||'/'||encode(sha256(convert_to('inline-physical','UTF8')),'hex')||'/0-'||hash,jsonb_build_object('size',3));
 answer:=fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');
 SELECT data INTO raw_original FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=rid AND kind='attachment';
 SELECT data INTO raw_overlay FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=rid AND kind='attachment_cloud';
 IF raw_original::jsonb IS DISTINCT FROM original OR raw_overlay::jsonb IS DISTINCT FROM overlay OR answer->'counts'->>'refs'<>'1' THEN RAISE EXCEPTION 'Inline original or cloud overlay was not retained';END IF;
 -- A portable backup can carry both original raw rows and logical byte copy.
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'inline',0,decode('616263','hex'));
 PERFORM fountain_private.retention_validate_record(ws,rid,true);
 IF (SELECT data FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=rid AND kind='attachment') IS DISTINCT FROM raw_original OR (SELECT data FROM fountain_private.retention_entities WHERE workspace_id=ws AND record_id=rid AND kind='attachment_cloud') IS DISTINCT FROM raw_overlay THEN RAISE EXCEPTION 'Portable materialization rewrote archived source';END IF;
 PERFORM fountain_cloud.retention_restore_to_trash(ws,rid,1,'native');
 IF (SELECT data FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='inline') IS DISTINCT FROM original OR (SELECT data FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment_cloud' AND id='inline') IS DISTINCT FROM overlay THEN RAISE EXCEPTION 'Native inline/overlay source recovery failed';END IF;
 PERFORM fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');
 PERFORM fountain_cloud.retention_restore_to_trash(ws,rid,1,'blob');
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment_cloud' AND id='inline') OR (SELECT data FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='inline') IS DISTINCT FROM original OR (SELECT encode(data,'hex') FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='inline')<>'616263' THEN RAISE EXCEPTION 'Portable inline original recovery failed';END IF;
END $inline_overlay$;
