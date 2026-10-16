-- DRAFT ONLY. Requires the applied service authority, pg_cron / pg_net, and
-- the separately reviewed maintenance_{upload,backup}_{claim,check,observed,done}
-- hooks. No workspace registration, Cron installation or delivery runs here.
-- This is a trusted server-only control plane, NOT a human principal/data API.
CREATE TABLE fountain_cloud.maintenance_registry (
 workspace_id text PRIMARY KEY CHECK(length(workspace_id) BETWEEN 1 AND 160),
 enabled boolean NOT NULL DEFAULT false,worker_url text NOT NULL,
 cron_id bigint,cron_name text NOT NULL,cron_user text NOT NULL,cron_command text NOT NULL,
 upload_grant_id uuid NOT NULL,backup_grant_id uuid NOT NULL,
 upload_generation bigint NOT NULL DEFAULT 0 CHECK(upload_generation BETWEEN 0 AND 9007199254740991),
 backup_generation bigint NOT NULL DEFAULT 0 CHECK(backup_generation BETWEEN 0 AND 9007199254740991),
 dispatch_minute timestamptz,dispatch_mask integer NOT NULL DEFAULT 0 CHECK(dispatch_mask BETWEEN 0 AND 3),
 cursors jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(cursors)='object' AND octet_length(cursors::text)<=8192),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,upload_grant_id) REFERENCES fountain_cloud.service_grants(workspace_id,id),
 FOREIGN KEY(workspace_id,backup_grant_id) REFERENCES fountain_cloud.service_grants(workspace_id,id),
 CHECK(upload_grant_id<>backup_grant_id)
);
CREATE TABLE fountain_cloud.maintenance_attempts (
 workspace_id text NOT NULL REFERENCES fountain_cloud.maintenance_registry(workspace_id),id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('upload-gc','backup-gc')),generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 grant_id uuid NOT NULL,grant_version bigint NOT NULL CHECK(grant_version BETWEEN 1 AND 9007199254740991),lease_id uuid NOT NULL,
 ticket_hash text NOT NULL UNIQUE CHECK(ticket_hash~'^[a-f0-9]{64}$'),invocation_id uuid,
 work_until timestamptz NOT NULL,ack_until timestamptz NOT NULL,state text NOT NULL DEFAULT 'ready' CHECK(state IN('ready','observe','delete','done')),
 claim jsonb CHECK(jsonb_typeof(claim)='object' AND octet_length(claim::text)<=32768),net_request_id bigint,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,purpose,generation),CHECK(ack_until>work_until),
 FOREIGN KEY(workspace_id,grant_id,lease_id) REFERENCES fountain_cloud.service_leases(workspace_id,grant_id,id)
);
CREATE INDEX maintenance_attempts_cleanup ON fountain_cloud.maintenance_attempts(workspace_id,ack_until,id);
CREATE TABLE fountain_cloud.maintenance_receipts (
 workspace_id text NOT NULL,attempt_id uuid NOT NULL,transaction_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),action text NOT NULL CHECK(action IN('claim','check','observed','done')),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=32768),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,attempt_id,transaction_id),
 FOREIGN KEY(workspace_id,attempt_id) REFERENCES fountain_cloud.maintenance_attempts(workspace_id,id)
);
ALTER TABLE fountain_cloud.maintenance_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.maintenance_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.maintenance_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.maintenance_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.maintenance_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.maintenance_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.maintenance_registry,fountain_cloud.maintenance_attempts,fountain_cloud.maintenance_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_context(p_attempt fountain_cloud.maintenance_attempts) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('kind','maintenance','workspaceId',p_attempt.workspace_id,'purpose',p_attempt.purpose,
  'grantId',p_attempt.grant_id,'grantVersion',p_attempt.grant_version,'leaseId',p_attempt.lease_id,'generation',p_attempt.generation,'ticketHash',p_attempt.ticket_hash)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_context(fountain_cloud.maintenance_attempts) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_ticket(p_ticket_hash text,p_invocation_id uuid) RETURNS fountain_cloud.maintenance_attempts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text;v_attempt fountain_cloud.maintenance_attempts;v_registry fountain_cloud.maintenance_registry;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Maintenance requires a current database snapshot' USING ERRCODE='PT503';END IF;
 IF p_ticket_hash IS NULL OR p_ticket_hash!~'^[a-f0-9]{64}$' OR p_invocation_id IS NULL THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
 SELECT a.workspace_id INTO v_ws FROM fountain_cloud.maintenance_attempts a WHERE a.ticket_hash=p_ticket_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
 PERFORM fountain_cloud.store_lock(v_ws);PERFORM set_config('fountain.workspace_id',v_ws,true);
 SELECT r.* INTO v_registry FROM fountain_cloud.maintenance_registry r WHERE r.workspace_id=v_ws;
 SELECT a.* INTO v_attempt FROM fountain_cloud.maintenance_attempts a WHERE a.workspace_id=v_ws AND a.ticket_hash=p_ticket_hash FOR UPDATE;
 IF v_attempt.id IS NULL OR NOT v_registry.enabled OR v_attempt.ack_until<=clock_timestamp()
  OR v_attempt.generation<>(CASE WHEN v_attempt.purpose='upload-gc' THEN v_registry.upload_generation ELSE v_registry.backup_generation END)
  OR v_attempt.grant_id<>(CASE WHEN v_attempt.purpose='upload-gc' THEN v_registry.upload_grant_id ELSE v_registry.backup_grant_id END) THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
 -- Maintenance service_context intentionally returns SQL NULL on success.
 PERFORM fountain_cloud.service_context(fountain_cloud.maintenance_context(v_attempt));
 IF v_attempt.invocation_id IS NOT NULL AND v_attempt.invocation_id<>p_invocation_id THEN RAISE EXCEPTION 'INVOCATION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF v_attempt.invocation_id IS NULL THEN
  IF v_attempt.work_until<=clock_timestamp() THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
  UPDATE fountain_cloud.maintenance_attempts a SET invocation_id=p_invocation_id WHERE a.workspace_id=v_ws AND a.id=v_attempt.id;v_attempt.invocation_id:=p_invocation_id;
 END IF;
 RETURN v_attempt;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_ticket(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_open(p_ticket_hash text,p_invocation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.maintenance_attempts;
BEGIN
 v_attempt:=fountain_cloud.maintenance_ticket(p_ticket_hash,p_invocation_id);
 IF v_attempt.state='done' THEN RETURN jsonb_build_object('state','done');END IF;
 IF v_attempt.work_until<=clock_timestamp() THEN RAISE EXCEPTION 'Maintenance deadline exceeded' USING ERRCODE='PT409';END IF;
 RETURN jsonb_build_object('state','ready','context',fountain_cloud.maintenance_context(v_attempt));
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_open(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_claim_valid(p_claim jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_item jsonb;v_count integer;v_offset numeric;v_size numeric;
BEGIN
 IF jsonb_typeof(p_claim) IS DISTINCT FROM 'object' OR octet_length(p_claim::text)>32768 THEN RAISE EXCEPTION 'Invalid maintenance claim' USING ERRCODE='22023';END IF;
 IF p_claim=jsonb_build_object('mode','none') THEN RETURN;END IF;
 IF jsonb_typeof(p_claim->'mode') IS DISTINCT FROM 'string' OR p_claim->>'mode' NOT IN('observe','delete') OR NOT(p_claim ?& ARRAY['mode','resourceId','fingerprint','manifests'])
  OR jsonb_typeof(p_claim->'resourceId') IS DISTINCT FROM 'string' OR length(p_claim->>'resourceId') NOT BETWEEN 1 AND 160
  OR jsonb_typeof(p_claim->'fingerprint') IS DISTINCT FROM 'string' OR (p_claim->>'fingerprint')!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(p_claim->'manifests') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid maintenance claim' USING ERRCODE='22023';END IF;
 v_count:=jsonb_array_length(p_claim->'manifests');
 IF v_count NOT BETWEEN 1 AND 16 OR p_claim->>'mode'='observe' AND v_count<>1 THEN RAISE EXCEPTION 'Invalid maintenance claim' USING ERRCODE='22023';END IF;
 FOR v_item IN SELECT j.value FROM jsonb_array_elements(p_claim->'manifests') j LOOP
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR NOT(v_item ?& ARRAY['version','attachmentId','offset','size','sha256']) OR v_item-ARRAY['version','attachmentId','offset','size','sha256']<>'{}'
   OR v_item->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(v_item->'attachmentId') IS DISTINCT FROM 'string'
   OR length(v_item->>'attachmentId') NOT BETWEEN 1 AND 160 OR (v_item->>'attachmentId')~'[[:cntrl:]/\\]' OR v_item->>'attachmentId' IN('.','..')
   OR jsonb_typeof(v_item->'offset') IS DISTINCT FROM 'number'
   OR jsonb_typeof(v_item->'size') IS DISTINCT FROM 'number'
   OR jsonb_typeof(v_item->'sha256') IS DISTINCT FROM 'string' OR (v_item->>'sha256')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid maintenance manifest' USING ERRCODE='22023';END IF;
  v_offset:=(v_item->>'offset')::numeric;v_size:=(v_item->>'size')::numeric;
  IF v_offset<0 OR v_offset>=5000000000 OR v_offset<>trunc(v_offset) OR mod(v_offset,4194304)<>0 OR v_size<=0 OR v_size>4194304 OR v_size<>trunc(v_size) OR v_offset+v_size>5000000000 THEN RAISE EXCEPTION 'Invalid maintenance manifest' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (j.value->>'attachmentId',(j.value->>'offset')::numeric)) FROM jsonb_array_elements(p_claim->'manifests') j)<>v_count THEN RAISE EXCEPTION 'Duplicate maintenance manifest' USING ERRCODE='22023';END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_claim_valid(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_resource_check(p_workspace_id text,p_purpose text,p_claim jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF p_purpose='upload-gc' THEN RETURN fountain_cloud.maintenance_upload_check(p_workspace_id,p_claim);
 ELSIF p_purpose='backup-gc' THEN RETURN fountain_cloud.maintenance_backup_check(p_workspace_id,p_claim);END IF;
 RAISE EXCEPTION 'Invalid maintenance purpose' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_resource_check(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_step(p_context jsonb,p_invocation_id uuid,p_transaction_id uuid,p_digest text,p_canonical text,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.maintenance_attempts;v_receipt fountain_cloud.maintenance_receipts;v_response jsonb;v_claim jsonb;
BEGIN
 IF jsonb_typeof(p_context) IS DISTINCT FROM 'object' OR p_context->>'kind' IS DISTINCT FROM 'maintenance' OR p_invocation_id IS NULL OR p_transaction_id IS NULL
  OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>8192
  OR p_action IS NULL OR p_action NOT IN('claim','check','observed','done') OR p_payload IS DISTINCT FROM '{}'::jsonb THEN RAISE EXCEPTION 'Invalid maintenance step' USING ERRCODE='22023';END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'invocationId',p_invocation_id,'action',p_action,'payload',p_payload) THEN RAISE EXCEPTION 'Invalid maintenance digest' USING ERRCODE='22023';END IF;
 v_attempt:=fountain_cloud.maintenance_ticket(p_context->>'ticketHash',p_invocation_id);
 IF p_context IS DISTINCT FROM fountain_cloud.maintenance_context(v_attempt) THEN RAISE EXCEPTION 'Maintenance authorization required' USING ERRCODE='PT401';END IF;
 -- A check never replays stale permission: current claim/deadline/resource must
 -- pass BEFORE consulting a receipt, even with an identical transaction ID.
 IF p_action='check' THEN
  IF v_attempt.state NOT IN('observe','delete') OR v_attempt.work_until<=clock_timestamp() OR fountain_cloud.maintenance_resource_check(v_attempt.workspace_id,v_attempt.purpose,v_attempt.claim) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MAINTENANCE_RESOURCE_CHANGED' USING ERRCODE='PT409';END IF;
 END IF;
 SELECT r.* INTO v_receipt FROM fountain_cloud.maintenance_receipts r WHERE r.workspace_id=v_attempt.workspace_id AND r.attempt_id=v_attempt.id AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF v_receipt.digest<>p_digest OR v_receipt.action<>p_action THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409';END IF;
  RETURN v_receipt.response;
 END IF;
 IF v_attempt.state='done' OR v_attempt.work_until<=clock_timestamp() THEN RAISE EXCEPTION 'Maintenance work is finished' USING ERRCODE='PT409';END IF;
 IF (SELECT count(*) FROM fountain_cloud.maintenance_receipts r WHERE r.workspace_id=v_attempt.workspace_id AND r.attempt_id=v_attempt.id)>=32 THEN RAISE EXCEPTION 'Maintenance receipt limit' USING ERRCODE='PT413';END IF;
 IF p_action='claim' THEN
  IF v_attempt.state<>'ready' THEN RAISE EXCEPTION 'Maintenance already claimed' USING ERRCODE='PT409';END IF;
  IF v_attempt.purpose='upload-gc' THEN v_claim:=fountain_cloud.maintenance_upload_claim(v_attempt.workspace_id,floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  ELSE v_claim:=fountain_cloud.maintenance_backup_claim(v_attempt.workspace_id,floor(extract(epoch FROM clock_timestamp())*1000)::bigint);END IF;
  PERFORM fountain_cloud.maintenance_claim_valid(v_claim);
  IF v_claim->>'mode'='none' THEN v_response:=jsonb_build_object('state','done');
  ELSE v_response:=jsonb_build_object('state',v_claim->>'mode','manifests',v_claim->'manifests');END IF;
  UPDATE fountain_cloud.maintenance_attempts a SET claim=v_claim,state=CASE WHEN v_claim->>'mode'='none' THEN 'done' ELSE v_claim->>'mode' END WHERE a.workspace_id=v_attempt.workspace_id AND a.id=v_attempt.id;
 ELSIF p_action='check' THEN v_response:=jsonb_build_object('allowed',true);
 ELSE
  IF v_attempt.state<>(CASE WHEN p_action='observed' THEN 'observe' ELSE 'delete' END) OR fountain_cloud.maintenance_resource_check(v_attempt.workspace_id,v_attempt.purpose,v_attempt.claim) IS DISTINCT FROM true THEN RAISE EXCEPTION 'MAINTENANCE_RESOURCE_CHANGED' USING ERRCODE='PT409';END IF;
  IF v_attempt.purpose='upload-gc' THEN
   IF p_action='observed' THEN PERFORM fountain_cloud.maintenance_upload_observed(v_attempt.workspace_id,v_attempt.claim);ELSE PERFORM fountain_cloud.maintenance_upload_done(v_attempt.workspace_id,v_attempt.claim);END IF;
  ELSE
   IF p_action='observed' THEN PERFORM fountain_cloud.maintenance_backup_observed(v_attempt.workspace_id,v_attempt.claim);ELSE PERFORM fountain_cloud.maintenance_backup_done(v_attempt.workspace_id,v_attempt.claim);END IF;
  END IF;
  UPDATE fountain_cloud.maintenance_attempts a SET state='done' WHERE a.workspace_id=v_attempt.workspace_id AND a.id=v_attempt.id;v_response:=jsonb_build_object('state','done');
 END IF;
 -- Hook change, attempt state and accepted receipt share this transaction.
 -- Keep the lease open for exact terminal ACKs, never for new work.
 INSERT INTO fountain_cloud.maintenance_receipts(workspace_id,attempt_id,transaction_id,digest,action,response) VALUES(v_attempt.workspace_id,v_attempt.id,p_transaction_id,p_digest,p_action,v_response);
 RETURN v_response;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_step(jsonb,uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_owned(p_registry fountain_cloud.maintenance_registry) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF p_registry.cron_id IS NULL OR NOT EXISTS(SELECT 1 FROM cron.job c WHERE c.jobid=p_registry.cron_id AND c.jobname=p_registry.cron_name AND c.username=p_registry.cron_user AND c.command=p_registry.cron_command AND c.schedule='* * * * *' AND c.database=current_database() AND c.active=p_registry.enabled) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_owned(fountain_cloud.maintenance_registry) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_cleanup(p_registry fountain_cloud.maintenance_registry) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.maintenance_attempts;v_cutoff timestamptz:=clock_timestamp()-interval '1 day';
BEGIN
 PERFORM fountain_cloud.maintenance_owned(p_registry);
 FOR v_attempt IN SELECT a.* FROM fountain_cloud.maintenance_attempts a WHERE a.workspace_id=p_registry.workspace_id AND a.ack_until<v_cutoff ORDER BY a.ack_until,a.id LIMIT 32 LOOP
  DELETE FROM fountain_cloud.maintenance_receipts r WHERE r.workspace_id=v_attempt.workspace_id AND r.attempt_id=v_attempt.id;
  DELETE FROM fountain_cloud.maintenance_attempts a WHERE a.workspace_id=v_attempt.workspace_id AND a.id=v_attempt.id;
  DELETE FROM fountain_cloud.service_leases l WHERE l.workspace_id=v_attempt.workspace_id AND l.grant_id=v_attempt.grant_id AND l.id=v_attempt.lease_id AND l.expires_at<v_cutoff;
 END LOOP;
 -- Never prune resource intents, unknown publishers, reservations or tombstones.
 DELETE FROM cron.job_run_details d WHERE d.runid IN(SELECT x.runid FROM cron.job_run_details x WHERE x.jobid=p_registry.cron_id AND x.end_time<clock_timestamp()-interval '7 days' ORDER BY x.end_time,x.runid LIMIT 32);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_cleanup(fountain_cloud.maintenance_registry) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_dispatch(p_workspace_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_registry fountain_cloud.maintenance_registry;v_grant fountain_cloud.service_grants;v_purpose text;v_bit integer;v_generation bigint;
 v_id uuid;v_lease uuid;v_raw text;v_hash text;v_request bigint;v_now timestamptz;v_minute timestamptz;
BEGIN
 PERFORM fountain_cloud.store_lock(p_workspace_id);PERFORM set_config('fountain.workspace_id',p_workspace_id,true);v_now:=clock_timestamp();v_minute:=date_trunc('minute',v_now);
 SELECT r.* INTO v_registry FROM fountain_cloud.maintenance_registry r WHERE r.workspace_id=p_workspace_id AND r.enabled FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;PERFORM fountain_cloud.maintenance_owned(v_registry);
 IF v_registry.dispatch_minute IS DISTINCT FROM v_minute THEN v_registry.dispatch_mask:=0;END IF;
 FOREACH v_purpose IN ARRAY ARRAY['upload-gc','backup-gc'] LOOP
  v_bit:=CASE WHEN v_purpose='upload-gc' THEN 1 ELSE 2 END;
  IF (v_registry.dispatch_mask & v_bit)<>0 THEN CONTINUE;END IF;
  SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=p_workspace_id AND g.id=CASE WHEN v_purpose='upload-gc' THEN v_registry.upload_grant_id ELSE v_registry.backup_grant_id END AND g.purpose=v_purpose AND g.enabled AND(g.expires_at IS NULL OR g.expires_at>v_now) FOR SHARE;
  IF NOT FOUND THEN CONTINUE;END IF;
  v_generation:=CASE WHEN v_purpose='upload-gc' THEN v_registry.upload_generation ELSE v_registry.backup_generation END;
  IF EXISTS(SELECT 1 FROM fountain_cloud.maintenance_attempts a WHERE a.workspace_id=p_workspace_id AND a.purpose=v_purpose AND a.generation=v_generation AND a.grant_id=v_grant.id AND a.grant_version=v_grant.version AND a.work_until>v_now AND a.state<>'done') THEN CONTINUE;END IF;
  IF v_generation>=9007199254740991 THEN RAISE EXCEPTION 'Maintenance generation limit' USING ERRCODE='PT413';END IF;
  UPDATE fountain_cloud.service_leases l SET closed=true FROM fountain_cloud.maintenance_attempts a WHERE a.workspace_id=p_workspace_id AND a.purpose=v_purpose AND a.generation=v_generation AND l.workspace_id=a.workspace_id AND l.grant_id=a.grant_id AND l.id=a.lease_id;
  v_generation:=v_generation+1;v_id:=gen_random_uuid();v_lease:=gen_random_uuid();v_raw:=rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');v_hash:=encode(sha256(convert_to(v_raw,'UTF8')),'hex');
  INSERT INTO fountain_cloud.service_leases(workspace_id,grant_id,id,generation,ticket_hash,run_id,expires_at,closed) VALUES(p_workspace_id,v_grant.id,v_lease,v_generation,v_hash,NULL,v_now+interval '150 seconds',false);
  INSERT INTO fountain_cloud.maintenance_attempts(workspace_id,id,purpose,generation,grant_id,grant_version,lease_id,ticket_hash,work_until,ack_until) VALUES(p_workspace_id,v_id,v_purpose,v_generation,v_grant.id,v_grant.version,v_lease,v_hash,v_now+interval '90 seconds',v_now+interval '150 seconds');
  -- Only the transient UNLOGGED pg_net delivery contains the raw ticket. Queue
  -- loss never clears the LOGGED attempt or resource intent/reservation.
  v_request:=net.http_post(url:=v_registry.worker_url,body:=jsonb_build_object('ticket',v_raw),params:='{}',headers:=jsonb_build_object('Content-Type','application/json'),timeout_milliseconds:=120000);
  UPDATE fountain_cloud.maintenance_attempts a SET net_request_id=v_request WHERE a.workspace_id=p_workspace_id AND a.id=v_id;
  IF v_purpose='upload-gc' THEN v_registry.upload_generation:=v_generation;ELSE v_registry.backup_generation:=v_generation;END IF;v_registry.dispatch_mask:=v_registry.dispatch_mask | v_bit;
 END LOOP;
 UPDATE fountain_cloud.maintenance_registry r SET upload_generation=v_registry.upload_generation,backup_generation=v_registry.backup_generation,dispatch_minute=v_minute,dispatch_mask=v_registry.dispatch_mask WHERE r.workspace_id=p_workspace_id;
 PERFORM fountain_cloud.maintenance_cleanup(v_registry);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_dispatch(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_rotate(p_registry fountain_cloud.maintenance_registry,p_enabled boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM fountain_cloud.service_grants g WHERE g.workspace_id=p_registry.workspace_id AND g.id IN(p_registry.upload_grant_id,p_registry.backup_grant_id) AND g.version>=9007199254740991) THEN RAISE EXCEPTION 'Maintenance grant version limit' USING ERRCODE='PT413';END IF;
 UPDATE fountain_cloud.service_grants g SET version=g.version+1,enabled=p_enabled WHERE g.workspace_id=p_registry.workspace_id AND g.id IN(p_registry.upload_grant_id,p_registry.backup_grant_id);
 UPDATE fountain_cloud.service_leases l SET closed=true WHERE l.workspace_id=p_registry.workspace_id AND l.grant_id IN(p_registry.upload_grant_id,p_registry.backup_grant_id) AND NOT l.closed;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_rotate(fountain_cloud.maintenance_registry,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_install(p_workspace_id text,p_worker_url text,p_enabled boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_registry fountain_cloud.maintenance_registry;v_name text;v_command text;v_user text:=current_user;v_id bigint;v_upload uuid:=gen_random_uuid();v_backup uuid:=gen_random_uuid();
BEGIN
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR p_enabled IS NULL OR p_worker_url IS NULL OR p_worker_url!~'^https://[a-z0-9]{20}(\.supabase\.co/functions/v1/fountain-maintenance|\.functions\.supabase\.co/fountain-maintenance)$' THEN RAISE EXCEPTION 'Invalid maintenance installation' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);v_name:='fountain-maintenance-'||substr(encode(sha256(convert_to(p_workspace_id,'UTF8')),'hex'),1,32);v_command:='SELECT fountain_cloud.maintenance_dispatch('||quote_literal(p_workspace_id)||');';
 SELECT r.* INTO v_registry FROM fountain_cloud.maintenance_registry r WHERE r.workspace_id=p_workspace_id FOR UPDATE;
 IF FOUND THEN
  IF v_registry.cron_id IS NOT NULL THEN PERFORM fountain_cloud.maintenance_owned(v_registry);ELSIF EXISTS(SELECT 1 FROM cron.job c WHERE c.jobname=v_registry.cron_name) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
  IF v_registry.cron_name<>v_name OR v_registry.cron_user<>v_user OR v_registry.cron_command<>v_command OR v_registry.worker_url<>p_worker_url THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
  IF v_registry.enabled IS DISTINCT FROM p_enabled THEN PERFORM fountain_cloud.maintenance_rotate(v_registry,p_enabled);END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM cron.job c WHERE c.jobname=v_name) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
  INSERT INTO fountain_cloud.service_grants(workspace_id,id,purpose,version,enabled,member_id,auth_user_id,resource_id,token_hash,expires_at,created_at,creation_digest,pending_until)
   VALUES(p_workspace_id,v_upload,'upload-gc',1,p_enabled,NULL,NULL,NULL,NULL,NULL,clock_timestamp(),NULL,NULL),(p_workspace_id,v_backup,'backup-gc',1,p_enabled,NULL,NULL,NULL,NULL,NULL,clock_timestamp(),NULL,NULL);
  INSERT INTO fountain_cloud.maintenance_registry(workspace_id,enabled,worker_url,cron_name,cron_user,cron_command,upload_grant_id,backup_grant_id) VALUES(p_workspace_id,false,p_worker_url,v_name,v_user,v_command,v_upload,v_backup);
 END IF;
 v_id:=v_registry.cron_id;
 IF p_enabled AND v_id IS NULL THEN v_id:=cron.schedule(v_name,'* * * * *',v_command);
 ELSIF v_id IS NOT NULL THEN PERFORM cron.alter_job(job_id:=v_id,active:=p_enabled);END IF;
 UPDATE fountain_cloud.maintenance_registry r SET enabled=p_enabled,worker_url=p_worker_url,cron_id=v_id WHERE r.workspace_id=p_workspace_id;
 RETURN jsonb_build_object('enabled',p_enabled,'job_id',v_id);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_install(text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.maintenance_remove(p_workspace_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_registry fountain_cloud.maintenance_registry;
BEGIN
 PERFORM fountain_cloud.store_lock(p_workspace_id);SELECT r.* INTO v_registry FROM fountain_cloud.maintenance_registry r WHERE r.workspace_id=p_workspace_id FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 IF v_registry.cron_id IS NOT NULL THEN PERFORM fountain_cloud.maintenance_owned(v_registry);PERFORM cron.unschedule(v_registry.cron_id);
 ELSIF EXISTS(SELECT 1 FROM cron.job c WHERE c.jobname=v_registry.cron_name) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
 IF v_registry.enabled OR v_registry.cron_id IS NOT NULL THEN PERFORM fountain_cloud.maintenance_rotate(v_registry,false);END IF;
 UPDATE fountain_cloud.maintenance_registry r SET enabled=false,cron_id=NULL WHERE r.workspace_id=p_workspace_id;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.maintenance_remove(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fountain_cloud_maintenance_open(p_ticket_hash text,p_invocation_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.maintenance_open(p_ticket_hash,p_invocation_id) $$;
CREATE FUNCTION public.fountain_cloud_maintenance_step(p_context jsonb,p_invocation_id uuid,p_transaction_id uuid,p_digest text,p_canonical text,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.maintenance_step(p_context,p_invocation_id,p_transaction_id,p_digest,p_canonical,p_action,p_payload) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_maintenance_open(text,uuid),public.fountain_cloud_maintenance_step(jsonb,uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_maintenance_open(text,uuid),public.fountain_cloud_maintenance_step(jsonb,uuid,uuid,text,text,text,jsonb) TO service_role;
-- Operators apply this file as postgres. Make that ownership explicit without
-- granting any helper/table privilege to the service-role transport.
ALTER FUNCTION fountain_cloud.maintenance_context(fountain_cloud.maintenance_attempts) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_ticket(text,uuid) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_open(text,uuid) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_claim_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_resource_check(text,text,jsonb) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_step(jsonb,uuid,uuid,text,text,text,jsonb) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_owned(fountain_cloud.maintenance_registry) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_cleanup(fountain_cloud.maintenance_registry) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_dispatch(text) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_rotate(fountain_cloud.maintenance_registry,boolean) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_install(text,text,boolean) OWNER TO postgres;
ALTER FUNCTION fountain_cloud.maintenance_remove(text) OWNER TO postgres;
ALTER FUNCTION public.fountain_cloud_maintenance_open(text,uuid) OWNER TO postgres;
ALTER FUNCTION public.fountain_cloud_maintenance_step(jsonb,uuid,uuid,text,text,text,jsonb) OWNER TO postgres;
