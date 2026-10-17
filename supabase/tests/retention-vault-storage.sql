-- Storage metadata/manifest proof; cloud object presence is metadata-only and
-- deliberately not a claim that SQL fetched/hash-verified provider bytes.
DO $vault_storage$
DECLARE ws text:='qa_retention_storage_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00+00:00';rid text:=repeat('d',32);hash text:=encode(sha256(decode('616263','hex')),'hex');key_id text;value jsonb;answer jsonb;manifest jsonb;raw text;r record;before_rev bigint;offset_value bigint;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 INSERT INTO fountain_private.entities VALUES(ws,'page','latent','{"id":"latent","title":"Latent","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'collaboration','latent','{"id":"latent","state":{"blocks":{"deleted":{"fields":{"attachment_id":{"value":"latent-file"}}}},"history":{"baseline":{"blocks":{"old":{"fields":{"attachment_id":{"value":"latent-file"}}}}},"ops":{"op":{"type":"block.set","field":"attachment_id","value":"latent-file"}}}}}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','latent-file',jsonb_build_object('id','latent-file','storage','chunks','size',3,'sha256',hash),stamp,stamp);
 key_id:=encode(sha256(convert_to('["latent-file",0]','UTF8')),'hex');
 INSERT INTO fountain_private.entities VALUES(ws,'attachment_chunk',key_id,jsonb_build_object('id',key_id,'attachment_id','latent-file','offset',0,'size',3,'sha256',hash),stamp,stamp);
 answer:=fountain_cloud.retention_archive_page(ws,'latent',stamp,30,NULL,rid,NULL,'manual');
 IF answer->'counts'->>'entities'<>'4' OR answer->'counts'->>'refs'<>'1' OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND storage_kind='file' AND physical_id=hash) THEN RAISE EXCEPTION 'Latent CRDT/file reference missing';END IF;
 BEGIN PERFORM fountain_cloud.retention_restore_to_trash(ws,rid);RAISE EXCEPTION 'Native file restoration bypassed materialization';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
 -- Portable byte mismatch and direct mutation must fail before any release.
 BEGIN
  INSERT INTO fountain_private.attachment_chunks VALUES(ws,'latent-file',0,decode('646566','hex'));
  RAISE EXCEPTION 'Wrong portable bytes accepted';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 PERFORM fountain_cloud.retention_stage_blob(ws,rid,'latent-file',0,decode('616263','hex'));
 PERFORM fountain_cloud.retention_stage_blob(ws,rid,'latent-file',0,decode('616263','hex'));
 BEGIN DELETE FROM fountain_private.attachment_chunks WHERE workspace_id=ws AND attachment_id='latent-file';RAISE EXCEPTION 'Portable pinned bytes deletion accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 answer:=fountain_cloud.retention_restore_to_trash(ws,rid,1,'native');
 IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='latent-file' AND data->>'storage'='chunks') OR EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment_chunk' AND id=key_id) THEN RAISE EXCEPTION 'Portable file normalization failed';END IF;
 -- Native cloud uses canonical hashed paths/private bucket, never an arbitrary
 -- user JSON object URL. Missing provider metadata requires materialization.
 INSERT INTO fountain_private.entities VALUES(ws,'page','cloud-page','{"id":"cloud-page","title":"Cloud","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[{"attachment_id":"cloud-file"}]}'::jsonb,stamp,stamp);
 manifest:=jsonb_build_object('version',1,'attachmentId','cloud-file','offset',0,'size',3,'sha256',hash);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','cloud-file',jsonb_build_object('id','cloud-file','storage','chunks','size',3,'sha256',hash,'cloud_chunks',jsonb_build_array(manifest)),stamp,stamp);
 answer:=fountain_cloud.retention_archive_page(ws,'cloud-page',stamp,30,NULL,rid,NULL,'manual');
 IF NOT fountain_cloud.storage_gc_pinned(ws,'cloud-file') THEN RAISE EXCEPTION 'Cloud vault pin not visible to GC';END IF;
 BEGIN PERFORM fountain_cloud.storage_gc_fence(ws,'cloud-file');RAISE EXCEPTION 'Physical GC fence ignored retained cloud';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN PERFORM fountain_cloud.retention_restore_to_trash(ws,rid);RAISE EXCEPTION 'Missing native cloud object accepted';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND id='cloud-page') OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws AND id=rid) THEN RAISE EXCEPTION 'Missing provider object released source';END IF;
 -- Temporary object metadata only; rolled back with the enclosing component.
 -- No provider object is written and no existing bucket is modified.
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='fountain-files' AND NOT public) THEN RAISE EXCEPTION 'Expected existing private application bucket';END IF;
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('fountain-files','v1/'||encode(sha256(convert_to(ws,'UTF8')),'hex')||'/'||encode(sha256(convert_to('cloud-file','UTF8')),'hex')||'/0-'||hash,jsonb_build_object('size',3));
 answer:=fountain_cloud.retention_restore_to_trash(ws,rid);
 IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND id='cloud-file' AND data ? 'cloud_chunks') THEN RAISE EXCEPTION 'Native cloud manifest was not recovered';END IF;
 -- Re-archive cloud, then materialize portable bytes and release as blob.
 PERFORM fountain_cloud.retention_archive_page(ws,'cloud-page',stamp,30,NULL,rid,NULL,'manual');
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'cloud-file',0,decode('616263','hex'));
 PERFORM fountain_cloud.retention_restore_to_trash(ws,rid,1,'blob');
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='attachment' AND id='cloud-file' AND (data ? 'cloud_chunks' OR data ? 'storage_id')) THEN RAISE EXCEPTION 'Blob restoration retained obsolete provider metadata';END IF;
 -- Multi-chunk file manifests must be ordered numerically by offset, not ID.
 INSERT INTO fountain_private.entities VALUES(ws,'page','multi','{"id":"multi","title":"Multi","archived":true,"deleted_at":"2026-10-17T12:00:00+00:00","blocks":[{"attachment_id":"multi-file"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','multi-file','{"id":"multi-file","storage":"chunks","size":4194307}'::jsonb,stamp,stamp);
 FOR offset_value IN SELECT x FROM unnest(ARRAY[0::bigint,4194304::bigint]) x LOOP
  key_id:=encode(sha256(convert_to('["multi-file",'||offset_value::text||']','UTF8')),'hex');
  INSERT INTO fountain_private.entities VALUES(ws,'attachment_chunk',key_id,jsonb_build_object('id',key_id,'attachment_id','multi-file','offset',offset_value,'size',CASE WHEN offset_value=0 THEN 4194304 ELSE 3 END,'sha256',CASE WHEN offset_value=0 THEN repeat('e',64) ELSE hash END),stamp,stamp);
 END LOOP;
 answer:=fountain_cloud.retention_archive_page(ws,'multi',stamp,30,NULL,rid,NULL,'manual');
 IF answer->'counts'->>'refs'<>'2' OR answer->'counts'->>'entities'<>'4' THEN RAISE EXCEPTION 'Multi-chunk file archive omitted manifest';END IF;
END $vault_storage$;
