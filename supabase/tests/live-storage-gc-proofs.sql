-- Operator-only PostgreSQL metadata proofs; substitute the one workspace placeholder.
-- Run at READ COMMITTED with other writers paused. No Auth/SID, Storage objects,
-- principal authorization, physical deletion, concurrency or 5GB transfer is proved.
-- Every fixture ends in a caught sentinel rollback; unexpected failures abort all.
DO $proofs$
DECLARE
 v_ws text := '__QA_WORKSPACE__'; v_case integer; v_pass integer:=0; v_phase integer; v_table text;
 v_job text:='11111111-1111-4111-8111-111111111111'; v_part text:='22222222-2222-4222-8222-222222222222';
 v_sid text; v_logical text; v_kind text; v_manifest jsonb; v_data jsonb; v_chunks jsonb; v_claim jsonb;
 v_before jsonb:='{}'; v_after jsonb; v_hash text; v_count bigint; v_rejected boolean;
BEGIN
 IF v_ws !~ '^fountain-qa-cloud-gc-proofs-[a-f0-9]{16}$' OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe operator proof scope';END IF;
 -- Hash canonical row digests only in RAM. No private payload/digest is returned.
 FOR v_phase IN 0..1 LOOP
  v_after:='{}';
  FOR v_table IN SELECT format('%I.%I',n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped WHERE n.nspname IN('fountain_private','fountain_cloud') AND c.relkind IN('r','p') LOOP
   EXECUTE format('SELECT count(*) FROM %s WHERE workspace_id=$1',v_table) INTO v_count USING v_ws;
   IF v_count<>0 THEN RAISE EXCEPTION 'QA namespace contains rows';END IF;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['fountain_private.entities','fountain_private.meta','fountain_cloud.backup_jobs',
   'fountain_cloud.backup_job_source','fountain_cloud.backup_job_parts','fountain_cloud.storage_gc_tombstones'] LOOP
   EXECUTE format('SELECT count(*) FROM %s WHERE workspace_id=$1',v_table) INTO v_count USING v_ws;
   IF v_count<>0 THEN RAISE EXCEPTION 'QA scope is not empty';END IF;
   EXECUTE format('SELECT encode(sha256(convert_to(COALESCE(string_agg(h,'''' ORDER BY h),''''),''UTF8'')),''hex'') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') h FROM %s t WHERE workspace_id<>$1) s',v_table) INTO v_hash USING v_ws;
   v_after:=v_after||jsonb_build_object(v_table,v_hash);
  END LOOP;
  IF v_phase=1 THEN
   IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'Foreign workspace baseline changed';END IF;
   EXIT;
  END IF;
  v_before:=v_after;
  -- Fresh-read migration must be installed; STABLE would hide waited-on writes.
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_cloud'
   AND p.proname IN('storage_gc_pinned','storage_gc_delete_allowed') AND p.provolatile<>'v') THEN RAISE EXCEPTION 'Fresh reads missing';END IF;
  FOR v_case IN 1..7 LOOP BEGIN
   v_logical:='qa-logical-'||v_case;v_sid:='qa-storage-'||v_case;
   IF v_case=1 THEN v_logical:=v_sid;END IF;
   IF v_case>=6 THEN v_sid:='backup-'||v_job||'-'||v_part;END IF;
   v_manifest:=jsonb_build_object('version',1,'attachmentId',v_sid,'offset',0,'size',4096,'sha256',repeat('a',64));
   v_data:=jsonb_build_object('id',v_logical,'storage_id',v_sid,'size',4096,'cloud_chunks',jsonb_build_array(v_manifest));
   IF v_case<=3 THEN
    v_kind:=CASE v_case WHEN 1 THEN 'upload' WHEN 2 THEN 'attachment' ELSE 'attachment_cloud' END;
    IF v_case=1 THEN v_data:=jsonb_build_object('id',v_sid,'size',4096);END IF; -- legacy upload remains pinned
    INSERT INTO fountain_private.entities VALUES(v_ws,v_kind,v_logical,v_data,'operator-fixture','operator-fixture');
   ELSE
    INSERT INTO fountain_cloud.backup_jobs(workspace_id,id,context,revision,phase,expires_at,quota_bytes)
     VALUES(v_ws,v_job,'{"operatorMetadata":"storage-gc-proof; never an authenticated context"}',0,CASE WHEN v_case=5 THEN 'expired' ELSE 'cancelled' END,0,5000000000);
    IF v_case=4 THEN
     INSERT INTO fountain_cloud.backup_job_source(workspace_id,job_id,table_name,ordinal,descriptor,extra) VALUES(v_ws,v_job,'entities',0,jsonb_build_object('id',v_logical),v_data);
    ELSIF v_case=5 THEN
     INSERT INTO fountain_cloud.backup_job_source(workspace_id,job_id,table_name,ordinal,descriptor,cloud) VALUES(v_ws,v_job,'attachment_chunks',0,'{"offset":0,"data":{"size":4096}}',v_manifest);
    ELSE
     INSERT INTO fountain_cloud.backup_job_parts(workspace_id,job_id,id,start_bytes,manifest,state) VALUES(v_ws,v_job,v_part,0,v_manifest,CASE WHEN v_case=6 THEN 'pending' ELSE 'published' END);
    END IF;
   END IF;
   IF NOT fountain_cloud.storage_gc_pinned(v_ws,v_sid) THEN RAISE EXCEPTION 'Expected live pin';END IF;
   -- Overlay references bind storage_id, not the unrelated logical entity id.
   IF v_case=3 AND fountain_cloud.storage_gc_pinned(v_ws,v_logical) THEN RAISE EXCEPTION 'Overlay identity alias';END IF;
   v_rejected:=false;BEGIN PERFORM fountain_cloud.storage_gc_fence(v_ws,v_sid);EXCEPTION WHEN SQLSTATE 'PT409' THEN v_rejected:=true;END;
   IF NOT v_rejected OR EXISTS(SELECT 1 FROM fountain_cloud.storage_gc_tombstones WHERE workspace_id=v_ws) THEN RAISE EXCEPTION 'Pinned fence mutated state';END IF;
   IF v_case<=3 THEN DELETE FROM fountain_private.entities WHERE workspace_id=v_ws;
   ELSIF v_case<=5 THEN DELETE FROM fountain_cloud.backup_job_source WHERE workspace_id=v_ws;
   ELSE UPDATE fountain_cloud.backup_job_parts SET state='gc' WHERE workspace_id=v_ws;END IF;
   IF fountain_cloud.storage_gc_pinned(v_ws,v_sid) THEN RAISE EXCEPTION 'Released reference is pinned';END IF;
   PERFORM fountain_cloud.storage_gc_fence(v_ws,v_sid);
   IF NOT fountain_cloud.storage_gc_delete_allowed(v_ws,v_sid) THEN RAISE EXCEPTION 'Retirement does not allow deletion';END IF;
   PERFORM fountain_cloud.storage_gc_fence(v_ws,v_sid);
   IF (SELECT count(*) FROM fountain_cloud.storage_gc_tombstones WHERE workspace_id=v_ws)<>1 THEN RAISE EXCEPTION 'Retirement is not permanent/idempotent';END IF;
   -- Read-only foreign-workspace lookup must not inherit this namespace's tombstone.
   IF fountain_cloud.storage_gc_delete_allowed('gc-proof-unwritten-foreign',v_sid) THEN RAISE EXCEPTION 'Foreign retirement leak';END IF;
   v_rejected:=false;BEGIN
    IF v_case<=3 THEN INSERT INTO fountain_private.entities VALUES(v_ws,v_kind,v_logical,v_data,'operator-fixture','operator-fixture');
    ELSIF v_case=4 THEN INSERT INTO fountain_cloud.backup_job_source(workspace_id,job_id,table_name,ordinal,descriptor,extra) VALUES(v_ws,v_job,'entities',0,jsonb_build_object('id',v_logical),v_data);
    ELSIF v_case=5 THEN INSERT INTO fountain_cloud.backup_job_source(workspace_id,job_id,table_name,ordinal,descriptor,cloud) VALUES(v_ws,v_job,'attachment_chunks',0,'{"offset":0,"data":{"size":4096}}',v_manifest);
    ELSE UPDATE fountain_cloud.backup_job_parts SET state='pending' WHERE workspace_id=v_ws;END IF;
   EXCEPTION WHEN SQLSTATE 'PT409' THEN v_rejected:=true;END;
   IF NOT v_rejected THEN RAISE EXCEPTION 'Retired reference was accepted';END IF;
   IF v_case>=6 THEN
    UPDATE fountain_cloud.backup_job_parts SET state='removed' WHERE workspace_id=v_ws;
    IF fountain_cloud.storage_gc_pinned(v_ws,v_sid) THEN RAISE EXCEPTION 'Removed part is pinned';END IF;
    DELETE FROM fountain_cloud.backup_job_parts WHERE workspace_id=v_ws; -- release DELETE remains allowed
   END IF;
   RAISE EXCEPTION 'rollback fixture' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN v_pass:=v_pass+1;END;END LOOP;
  BEGIN -- Valid numeric integers, full 5GB layout (1193 metadata chunks only).
   v_sid:='qa-bounds';v_manifest:=jsonb_build_object('version',1,'attachmentId',v_sid,'offset',0.0,'size',4194304.0,'sha256',repeat('b',64));
   PERFORM fountain_cloud.storage_gc_manifest(v_manifest,v_sid,0,4194304);
   SELECT jsonb_agg(jsonb_build_object('version',1,'attachmentId',v_sid,'offset',i::bigint*4194304,'size',least(4194304::bigint,5000000000-i::bigint*4194304),'sha256',repeat('b',64)) ORDER BY i) INTO v_chunks FROM generate_series(0,1192) i;
   IF jsonb_array_length(v_chunks)<>1193 OR fountain_cloud.storage_gc_layout(jsonb_build_object('id',v_sid,'size',5000000000,'cloud_chunks',v_chunks),v_sid)<>v_sid THEN RAISE EXCEPTION '5GB layout rejected';END IF;
   FOR v_case IN 1..4 LOOP
    v_rejected:=false;BEGIN
     IF v_case=1 THEN PERFORM fountain_cloud.storage_gc_manifest(v_manifest||'{"size":4194305}',v_sid);
     ELSIF v_case=2 THEN PERFORM fountain_cloud.storage_gc_layout(jsonb_build_object('id',v_sid,'size',5000000001,'cloud_chunks',v_chunks),v_sid);
     ELSIF v_case=3 THEN PERFORM fountain_cloud.storage_gc_layout(jsonb_build_object('id',v_sid,'size',5000000000,'cloud_chunks',v_chunks||jsonb_build_array(v_manifest)),v_sid);
     ELSE PERFORM fountain_cloud.storage_gc_layout(jsonb_build_object('id','qa-logical','storage_id',v_sid,'size',4194304,'cloud_chunks',jsonb_build_array(v_manifest||'{"attachmentId":"qa-logical"}')),'qa-logical');END IF;
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_rejected:=true;END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'Invalid layout accepted';END IF;
   END LOOP;
   RAISE EXCEPTION 'rollback fixture' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN v_pass:=v_pass+1;END;
  BEGIN -- Artifact UUID binding and 256KiB limit are enforced by the actual BEFORE trigger.
   INSERT INTO fountain_cloud.backup_jobs(workspace_id,id,context,revision,expires_at,quota_bytes) VALUES(v_ws,v_job,'{"operatorMetadata":"storage-gc-proof"}',0,0,5000000000);
   FOR v_case IN 1..2 LOOP
    v_manifest:=jsonb_build_object('version',1,'attachmentId',CASE WHEN v_case=1 THEN 'backup-'||v_job||'-wrong-part' ELSE 'backup-'||v_job||'-'||v_part END,'offset',0,'size',CASE WHEN v_case=1 THEN 4096 ELSE 266240 END,'sha256',repeat('c',64));
    v_rejected:=false;BEGIN
     INSERT INTO fountain_cloud.backup_job_parts(workspace_id,job_id,id,start_bytes,manifest) VALUES(v_ws,v_job,v_part,0,v_manifest);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_rejected:=true;END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'Invalid artifact identity/size accepted';END IF;
   END LOOP;
   RAISE EXCEPTION 'rollback fixture' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN v_pass:=v_pass+1;END;
  BEGIN -- SQL DTO semantics only; this does not authorize or dispatch a GC worker.
   SELECT jsonb_agg(jsonb_build_object('version',1,'attachmentId',repeat(chr(128512),159)||chr(128512+i),'offset',0.0,'size',262144.0,'sha256',repeat('d',64)) ORDER BY i) INTO v_chunks FROM generate_series(1,16) i;
   v_claim:=jsonb_build_object('mode','delete','resourceId','qa-dto','fingerprint',repeat('e',64),'manifests',v_chunks);
   PERFORM fountain_cloud.maintenance_claim_valid(v_claim);
   IF octet_length(v_claim::text)>32768 OR jsonb_array_length(v_chunks)<>16 THEN RAISE EXCEPTION 'DTO budget violated';END IF;
   RAISE EXCEPTION 'rollback fixture' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN v_pass:=v_pass+1;END;
 END LOOP;
 IF v_pass<>10 THEN RAISE EXCEPTION 'Proof count mismatch';END IF;
 RAISE NOTICE 'gc_proofs_ok=%, rollback_cases=%, fixture_rows=%, foreign_baseline_unchanged=%',true,v_pass,0,true;
END $proofs$;
SELECT jsonb_build_object('metadataCases',10,'allFixturesRolledBack',true,'foreignWorkspaceHashesPreserved',true,'authOrPhysicalStorageVerified',false) AS proof;
