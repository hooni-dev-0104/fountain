-- Run directly after the draft migration inside an explicit top-level BEGIN;
-- always end with ROLLBACK. A subtransaction cannot create the import parent.
CREATE TEMP TABLE retention_top_source(table_name text NOT NULL,row_data jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE retention_top_result(ok boolean NOT NULL,result jsonb NOT NULL) ON COMMIT DROP;
DO $setup$
DECLARE ws text:='qa_retention_top_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T12:00:00+00:00';rid text:=repeat('a',32);started timestamptz:=clock_timestamp();answer jsonb;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM set_config('fountain.vault_test_source',ws,true);PERFORM set_config('fountain.vault_test_target',ws||'_copy',true);
 INSERT INTO fountain_private.entities VALUES(ws,'page','root','{"id":"root","title":"Many rows","archived":true,"blocks":[{"attachment_id":"file"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'database','db','{"id":"db","page_id":"root","properties":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities SELECT ws,'row','row-'||x,jsonb_build_object('id','row-'||x,'database_id','db','properties','{}'::jsonb),stamp,stamp FROM generate_series(1,1001) x;
 INSERT INTO fountain_private.entities VALUES(ws,'attachment','file','{"id":"file","storage":"chunks","size":3}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.attachment_chunks VALUES(ws,'file',0,decode('616263','hex'));
 answer:=fountain_cloud.retention_archive_page(ws,'root',stamp,30,NULL,rid,NULL,'manual');
 IF answer->'counts'->>'entities'<>'1004' OR answer->'counts'->>'provenance'<>'1003' THEN RAISE EXCEPTION 'Large row closure was truncated';END IF;
 INSERT INTO retention_top_result VALUES(true,jsonb_build_object('group','large_closure','entities',1004,'provenance',1003,'seconds',extract(epoch FROM clock_timestamp()-started)));
 INSERT INTO retention_top_source SELECT 'retention_records',to_jsonb(s)-'workspace_id' FROM fountain_private.retention_records s WHERE workspace_id=ws;
 INSERT INTO retention_top_source SELECT 'retention_entities',to_jsonb(s)-'workspace_id' FROM fountain_private.retention_entities s WHERE workspace_id=ws;
 INSERT INTO retention_top_source SELECT 'retention_provenance',to_jsonb(s)-'workspace_id' FROM fountain_private.retention_provenance s WHERE workspace_id=ws;
 INSERT INTO retention_top_source SELECT 'retention_attachment_refs',to_jsonb(s)-'workspace_id' FROM fountain_private.retention_attachment_refs s WHERE workspace_id=ws;
 INSERT INTO retention_top_source SELECT 'retention_identity_reservations',to_jsonb(s)-'workspace_id' FROM fountain_private.retention_identity_reservations s WHERE workspace_id=ws;
 INSERT INTO retention_top_source SELECT 'retention_links',to_jsonb(s)-'workspace_id' FROM fountain_private.retention_links s WHERE workspace_id=ws;
END $setup$;
GRANT SELECT ON retention_top_source TO fountain_backend;
GRANT INSERT ON retention_top_result TO fountain_backend;
SELECT set_config('fountain.workspace_id',current_setting('fountain.vault_test_target'),true);
SET LOCAL ROLE fountain_backend;
-- The parent INSERT executes outside a savepoint/subtransaction.
SELECT fountain_cloud.retention_import_row(current_setting('fountain.workspace_id'),'retention_records',row_data) FROM retention_top_source WHERE table_name='retention_records';
DO $import$
DECLARE r record;target text:=current_setting('fountain.workspace_id');rid text:=repeat('a',32);started timestamptz:=clock_timestamp();v jsonb;
BEGIN
 FOR r IN SELECT * FROM retention_top_source WHERE table_name<>'retention_records' ORDER BY CASE table_name WHEN 'retention_entities' THEN 0 WHEN 'retention_provenance' THEN 1 WHEN 'retention_attachment_refs' THEN 2 WHEN 'retention_identity_reservations' THEN 3 ELSE 4 END,row_data->>'id' LOOP
  PERFORM fountain_cloud.retention_import_row(target,r.table_name,r.row_data);
 END LOOP;
 INSERT INTO fountain_private.attachment_chunks VALUES(target,'file',0,decode('616263','hex'));
 PERFORM fountain_cloud.retention_import_finish(target,rid,true);
 SELECT row_data INTO v FROM retention_top_source WHERE table_name='retention_entities' LIMIT 1;
 BEGIN PERFORM fountain_cloud.retention_import_row(target,'retention_entities',v);RAISE EXCEPTION 'Duplicate imported entity overwritten';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN PERFORM fountain_cloud.retention_import_row(target,'retention_records',jsonb_build_object('id',rid,'data','{}','created_at','x','updated_at','x'));RAISE EXCEPTION 'Duplicate record overwritten';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN PERFORM fountain_cloud.retention_import_row(target,'entities','{}');RAISE EXCEPTION 'Unknown import table accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM fountain_cloud.retention_import_row(target,'retention_records',jsonb_build_object('id',repeat('f',32),'data','{}','created_at','x','updated_at','x','workspace_id',target));RAISE EXCEPTION 'Import namespace override accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 INSERT INTO retention_top_result VALUES(true,jsonb_build_object('group','top_level_import','entities',1004,'sameTransactionValidated',true,'seconds',extract(epoch FROM clock_timestamp()-started)));
END $import$;
RESET ROLE;
-- An incomplete append-only parent cannot commit. The test owner removes only
-- this invalid synthetic fixture after proving the deferred failure; all DDL,
-- fixtures, grants and valid imports are still rolled back by the outer BEGIN.
SELECT fountain_cloud.retention_import_row(current_setting('fountain.workspace_id'),'retention_records',jsonb_build_object('id',repeat('f',32),'data','{}','created_at','x','updated_at','x'));
DO $bad_import$
DECLARE target text:=current_setting('fountain.workspace_id');
BEGIN
 BEGIN SET CONSTRAINTS ALL IMMEDIATE;RAISE EXCEPTION 'Incomplete import passed deferred validation';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 PERFORM set_config('fountain.retention_transition',target,true);
 DELETE FROM fountain_private.retention_records WHERE workspace_id=target AND id=repeat('f',32);
 PERFORM set_config('fountain.retention_transition','',true);
 INSERT INTO retention_top_result VALUES(true,jsonb_build_object('group','incomplete_import_rejected','commitFence',true));
END $bad_import$;
-- Existing committed-parent rejection is verified after schema-only provisioning
-- by the independent PostgreSQL driver; this component never commits a fixture.
SET CONSTRAINTS ALL IMMEDIATE;
SELECT * FROM retention_top_result ORDER BY result->>'group';
