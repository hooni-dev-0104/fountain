-- Rollback-only overload/bounds regression. The authorizer is a temporary
-- component stub; this does not create Auth users or touch an existing job.
CREATE OR REPLACE FUNCTION fountain_cloud.backup_authorize(p_context jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('context',p_context,'revision',0) $$;
DO $range_test$
DECLARE ws text:='qa_backup_range_'||replace(gen_random_uuid()::text,'-','');jid text:=gen_random_uuid()::text;tx text:=gen_random_uuid()::text;lease text:=gen_random_uuid()::text;now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;ctx jsonb;token jsonb;answer jsonb;raw bytea;
BEGIN
 ctx:=jsonb_build_object('workspaceId',ws,'memberId','component-only');PERFORM set_config('fountain.workspace_id',ws,true);
 PERFORM fountain_cloud.backup_jobs_rpc(ctx,'create',jsonb_build_object('id',jid,'quota_bytes',10000000));
 UPDATE fountain_cloud.backup_jobs SET phase='building',format_version=3,lease_id=lease,lease_until=now_ms+60000,lease_tx=tx,lease_digest=repeat('8',64) WHERE workspace_id=ws AND id=jid;
 raw:=convert_to(jsonb_build_object('id','source','text',repeat('x',131072))::text,'UTF8');
 INSERT INTO fountain_cloud.backup_job_source(workspace_id,job_id,table_name,ordinal,descriptor,raw) VALUES(ws,jid,'retention_entities',0,jsonb_build_object('data',jsonb_build_object('ref','retention_entities:0','size',octet_length(raw),'type','text')),raw);
 token:=jsonb_build_object('id',jid,'transaction_id',tx,'digest',repeat('8',64),'lease_id',lease,'version',0);
 answer:=fountain_cloud.backup_jobs_rpc(ctx,'read',token||'{"source":{"ref":"retention_entities:0","offset":65536,"length":65536}}'::jsonb);
 IF decode(answer->'bytes'->0->>'base64','base64') IS DISTINCT FROM substr(raw,65537,65536) THEN RAISE EXCEPTION 'Private byte range differs from its source';END IF;
 BEGIN
  PERFORM fountain_cloud.backup_jobs_rpc(ctx,'read',token||'{"source":{"ref":"retention_entities:0","offset":5000000000,"length":65536}}'::jsonb);
  RAISE EXCEPTION 'Outside-row offset was accepted';
 EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
END $range_test$;
