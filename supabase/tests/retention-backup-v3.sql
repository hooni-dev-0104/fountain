-- Rollback-only operator component: authorization is stubbed inside the outer
-- rollback so this is source/format/CAS proof, never real Auth or Edge evidence.
CREATE OR REPLACE FUNCTION fountain_cloud.backup_authorize(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM set_config('fountain.workspace_id',p_context->>'workspaceId',true);RETURN jsonb_build_object('context',p_context,'revision',fountain_cloud.store_revision(p_context->>'workspaceId','_entity_revision'));END $$;
DO $v3$
DECLARE ws text:='qa_retention_backup_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00.000000+00:00';rid text:=repeat('e',32);ctx jsonb;v jsonb;item jsonb;c jsonb;rev bigint;pages integer:=0;count_vault integer:=0;v_job_id text:=gen_random_uuid()::text;tx text;token jsonb;source_count bigint;rows_read integer:=0;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 ctx:=jsonb_build_object('workspaceId',ws,'memberId','operator-component');
 INSERT INTO fountain_private.entities VALUES(ws,'page','root',jsonb_build_object('id','root','title','Archived','archived',true,'deleted_at',stamp,'blocks',jsonb_build_array(jsonb_build_object('text',repeat('x',800000),'attachment_id','file'))),stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','file',jsonb_build_object('id','file','name','retained.bin','storage','chunks','size',3,'sha256',encode(sha256(decode('616263','hex')),'hex')),stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'file',0,decode('616263','hex'));
 PERFORM fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');
 LOOP
  v:=fountain_cloud.backup_export(ctx,rev,c);rev:=(v->>'revision')::bigint;
  FOR item IN SELECT jsonb_array_elements(v->'items') LOOP
   IF item->>'type'='vault' THEN
    count_vault:=count_vault+1;
    IF length(item->>'dataPart')>262144 THEN RAISE EXCEPTION 'Unbounded vault export frame';END IF;
   END IF;
  END LOOP;
  c:=v->'nextCursor';pages:=pages+1;EXIT WHEN c='null'::jsonb;
  IF pages>100 THEN RAISE EXCEPTION 'Export cursor loop';END IF;
 END LOOP;
 IF count_vault<8 THEN RAISE EXCEPTION 'Vault records were omitted from sync export: %',count_vault;END IF;
 v:=fountain_cloud.backup_jobs_rpc(ctx,'create',jsonb_build_object('id',v_job_id,'quota_bytes',20000000));
 IF v->>'format_version'<>'3' THEN RAISE EXCEPTION 'Populated vault did not select v3';END IF;
 FOR pages IN 1..30 LOOP
  tx:=gen_random_uuid()::text;v:=fountain_cloud.backup_jobs_rpc(ctx,'claim',jsonb_build_object('id',v_job_id,'transaction_id',tx,'digest',repeat('a',64)));
  token:=jsonb_build_object('id',v_job_id,'transaction_id',tx,'digest',repeat('a',64),'lease_id',v->>'lease_id','version',(v->>'version')::bigint);
  v:=fountain_cloud.backup_jobs_rpc(ctx,'snapshot',token);EXIT WHEN v->>'phase'='building';
 END LOOP;
 IF v->>'phase'<>'building' THEN RAISE EXCEPTION 'v3 source snapshot did not finish';END IF;
 SELECT count(*) INTO source_count FROM fountain_cloud.backup_job_source WHERE workspace_id=ws AND job_id=v_job_id AND table_name LIKE 'retention_%';
 IF source_count<>7 THEN RAISE EXCEPTION 'v3 snapshot source descriptors mismatch: %',source_count;END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=ws AND s.job_id=v_job_id AND s.table_name='attachment_chunks' AND s.raw=decode('616263','hex')) THEN RAISE EXCEPTION 'Retained-only physical bytes were dropped';END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=ws AND s.job_id=v_job_id AND s.table_name='retention_entities' AND s.descriptor->'values'->>'kind'='page' AND octet_length(s.raw)>800000 AND s.descriptor->'values'->'data'->>'type'='text' AND octet_length(s.descriptor::text)<8192) THEN RAISE EXCEPTION 'Large retained body was embedded in descriptor';END IF;
 -- Generic bounded cleanup must include all six v3 source tables without
 -- deleting the independent retained source or its physical pins.
 UPDATE fountain_cloud.backup_jobs SET phase='cancelled',lease_id=NULL,lease_until=NULL WHERE workspace_id=ws AND id=v_job_id;
 PERFORM fountain_cloud.backup_gc_locked(ws,v_job_id,'gc_claim','{}'::jsonb,floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
 IF EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=ws AND s.job_id=v_job_id) OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_receipts r WHERE r.workspace_id=ws AND r.job_id=v_job_id) THEN RAISE EXCEPTION 'v3 private source cleanup was incomplete';END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=ws AND id=rid) OR NOT EXISTS(SELECT 1 FROM fountain_private.retention_attachment_refs WHERE workspace_id=ws AND record_id=rid) THEN RAISE EXCEPTION 'Backup cleanup removed independent retained state';END IF;
 -- Private content revision fence independently cancels source gathering.
 v_job_id:=gen_random_uuid()::text;PERFORM fountain_cloud.backup_jobs_rpc(ctx,'create',jsonb_build_object('id',v_job_id,'quota_bytes',20000000));
 UPDATE fountain_private.content_search_state SET content_revision=content_revision+1 WHERE workspace_id=ws;
 BEGIN PERFORM fountain_cloud.backup_jobs_rpc(ctx,'claim',jsonb_build_object('id',v_job_id,'transaction_id',gen_random_uuid()::text,'digest',repeat('a',64)));RAISE EXCEPTION 'Changed content revision accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
END $v3$;

-- Inline authored bytes plus a finalized cloud overlay remain separate raw
-- snapshots, while portable re-export can use independently verified BYTEA.
DO $inline_v3$
DECLARE ws text:='qa_retention_inline_v3_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00.000000+00:00';ctx jsonb;v jsonb;c jsonb;rev bigint;count_chunks integer:=0;item jsonb;jid text:=gen_random_uuid()::text;tx text;token jsonb;n integer;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);ctx:=jsonb_build_object('workspaceId',ws,'memberId','operator-component');
 INSERT INTO fountain_private.entities VALUES(ws,'page','root','{"id":"root","archived":true,"deleted_at":"2026-10-17T12:00:00.000000+00:00","blocks":[{"attachment_id":"inline"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','inline','{"id":"inline","name":"inline.bin","mime":"application/octet-stream","size":3,"storage":"inline","data":"YWJj","sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","created_at":"2026-10-17T12:00:00.000000+00:00","updated_at":"2026-10-17T12:00:00.000000+00:00"}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'attachment_cloud','inline','{"id":"inline","name":"inline.bin","size":3,"mime":"application/octet-stream","storage":"chunks","sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","created_at":"2026-10-17T12:00:00.000000+00:00","updated_at":"2026-10-17T12:00:00.000000+00:00","storage_id":"historical-cloud","cloud_chunks":[{"version":1,"attachmentId":"historical-cloud","offset":0,"size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}],"source_fingerprint":"{\"created_at\":\"2026-10-17T12:00:00.000000+00:00\",\"id\":\"inline\",\"mime\":\"application/octet-stream\",\"name\":\"inline.bin\",\"owner_id\":null,\"page_id\":null,\"sha256\":\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\",\"size\":3,\"storage\":\"inline\",\"updated_at\":\"2026-10-17T12:00:00.000000+00:00\"}"}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'inline',0,decode('616263','hex'));
 PERFORM fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,repeat('f',32),NULL,'manual');
 LOOP v:=fountain_cloud.backup_export(ctx,rev,c);rev:=(v->>'revision')::bigint;FOR item IN SELECT jsonb_array_elements(v->'items') LOOP IF item->>'type'='chunk' THEN count_chunks:=count_chunks+1;END IF;END LOOP;c:=v->'nextCursor';EXIT WHEN c='null'::jsonb;END LOOP;
 IF count_chunks<>1 THEN RAISE EXCEPTION 'Inline overlay retained bytes were omitted from sync export';END IF;
 PERFORM fountain_cloud.backup_jobs_rpc(ctx,'create',jsonb_build_object('id',jid,'quota_bytes',20000000));
 FOR n IN 1..30 LOOP
  tx:=gen_random_uuid()::text;v:=fountain_cloud.backup_jobs_rpc(ctx,'claim',jsonb_build_object('id',jid,'transaction_id',tx,'digest',repeat('a',64)));token:=jsonb_build_object('id',jid,'transaction_id',tx,'digest',repeat('a',64),'lease_id',v->>'lease_id','version',(v->>'version')::bigint);v:=fountain_cloud.backup_jobs_rpc(ctx,'snapshot',token);EXIT WHEN v->>'phase'='building';
 END LOOP;
 IF v->>'phase'<>'building' OR NOT EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=ws AND s.job_id=jid AND s.table_name='attachment_chunks' AND s.raw=decode('616263','hex') AND s.cloud IS NULL) THEN RAISE EXCEPTION 'Inline overlay portable bytes were lost or forced through old provider objects';END IF;
END $inline_v3$;
