-- DRAFT ONLY: no extensions, workspace registration, backfill or Cron job is run.
-- Prerequisites: pg_cron / pg_net enabled by the operator; all current cloud
-- Auth/Store/service-authority/grant-admin migrations. Never edit applied SQL.
-- Trusted service-role RPCs, NOT user RLS. No raw tickets or action bodies persist.

CREATE TABLE fountain_cloud.scheduler_registry (
 workspace_id text PRIMARY KEY CHECK(length(workspace_id) BETWEEN 1 AND 160),
 enabled boolean NOT NULL DEFAULT false,
 worker_url text NOT NULL,
 cron_id bigint,cron_name text NOT NULL,cron_user text NOT NULL,cron_command text NOT NULL,
 backfill_cursor text NOT NULL DEFAULT '',backfill_done boolean NOT NULL DEFAULT false,
 dispatch_minute timestamptz,dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 4),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE fountain_cloud.scheduler_due (
 workspace_id text NOT NULL REFERENCES fountain_cloud.scheduler_registry(workspace_id),
 automation_id text NOT NULL CHECK(length(automation_id) BETWEEN 1 AND 160),
 incarnation uuid NOT NULL,definition_version bigint NOT NULL CHECK(definition_version BETWEEN 1 AND 9007199254740991),
 definition_hash text NOT NULL CHECK(definition_hash~'^[a-f0-9]{64}$'),due_hash text NOT NULL CHECK(due_hash~'^[a-f0-9]{64}$'),
 author_id text,identity_user uuid,identity_epoch bigint NOT NULL DEFAULT 0 CHECK(identity_epoch BETWEEN 0 AND 9007199254740991),grant_id uuid,grant_version bigint,enabled boolean NOT NULL,deleted boolean NOT NULL DEFAULT false,
 CHECK((grant_id IS NULL)=(grant_version IS NULL)),CHECK(grant_version BETWEEN 1 AND 9007199254740991),
 wake_at timestamptz,active_job uuid,PRIMARY KEY(workspace_id,automation_id)
);
CREATE INDEX scheduler_due_wake ON fountain_cloud.scheduler_due(workspace_id,wake_at,automation_id) WHERE enabled AND NOT deleted;
CREATE INDEX scheduler_due_author ON fountain_cloud.scheduler_due(workspace_id,author_id,automation_id);
CREATE TABLE fountain_cloud.scheduler_jobs (
 workspace_id text NOT NULL, id uuid NOT NULL,automation_id text NOT NULL,incarnation uuid NOT NULL,
 definition_version bigint NOT NULL CHECK(definition_version BETWEEN 1 AND 9007199254740991),
 definition_hash text NOT NULL CHECK(definition_hash~'^[a-f0-9]{64}$'),due_hash text NOT NULL CHECK(due_hash~'^[a-f0-9]{64}$'),
 fixed_now timestamptz NOT NULL,state text NOT NULL CHECK(state IN('preparing','ready','done','superseded')),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 9007199254740991),
 scheduled_at text,run_id text CHECK(run_id~'^[a-f0-9]{64}$'),next_at text,
 outcome text,result_revision bigint,finished_at timestamptz,
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,automation_id) REFERENCES fountain_cloud.scheduler_due(workspace_id,automation_id)
);
CREATE INDEX scheduler_jobs_cleanup ON fountain_cloud.scheduler_jobs(workspace_id,finished_at,id) WHERE state IN('done','superseded');
CREATE TABLE fountain_cloud.scheduler_attempts (
 workspace_id text NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 id uuid NOT NULL,ticket_hash text NOT NULL UNIQUE CHECK(ticket_hash~'^[a-f0-9]{64}$'),
 invocation_id uuid,work_until timestamptz NOT NULL,ack_until timestamptz NOT NULL,
 grant_id uuid,lease_id uuid,identity_epoch bigint CHECK(identity_epoch BETWEEN 0 AND 9007199254740991),authority_hash text CHECK(authority_hash~'^[a-f0-9]{64}$'),net_request_id bigint,
 PRIMARY KEY(workspace_id,job_id,generation),UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES fountain_cloud.scheduler_jobs(workspace_id,id),
 CHECK(ack_until>work_until),CHECK((grant_id IS NULL)=(lease_id IS NULL)),CHECK((grant_id IS NULL)=(authority_hash IS NULL)),CHECK((grant_id IS NULL)=(identity_epoch IS NULL))
);
CREATE INDEX scheduler_attempts_cleanup ON fountain_cloud.scheduler_attempts(workspace_id,ack_until,job_id,generation);
CREATE INDEX scheduler_service_receipt_cleanup ON fountain_cloud.service_commit_receipts(workspace_id,created_at,transaction_id);
CREATE INDEX scheduler_attempts_service ON fountain_cloud.scheduler_attempts(workspace_id,grant_id,lease_id) WHERE grant_id IS NOT NULL;
CREATE TABLE fountain_cloud.scheduler_prepare_receipts (
 workspace_id text NOT NULL,attempt_id uuid NOT NULL,invocation_id uuid NOT NULL,transaction_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,attempt_id,invocation_id,transaction_id),UNIQUE(workspace_id,attempt_id),
 FOREIGN KEY(workspace_id,attempt_id) REFERENCES fountain_cloud.scheduler_attempts(workspace_id,id)
);
CREATE TABLE fountain_cloud.scheduler_owner_dirty (
 workspace_id text NOT NULL,member_id text NOT NULL,cursor_id text NOT NULL DEFAULT '',
 identity_epoch bigint NOT NULL DEFAULT 0 CHECK(identity_epoch BETWEEN 0 AND 9007199254740991),
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),pending boolean NOT NULL DEFAULT true,
 touched_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,member_id)
);
CREATE INDEX scheduler_owner_pending ON fountain_cloud.scheduler_owner_dirty(workspace_id,touched_at,member_id) WHERE pending;
ALTER TABLE fountain_cloud.scheduler_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_due FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_prepare_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_prepare_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_owner_dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.scheduler_owner_dirty FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.scheduler_registry,fountain_cloud.scheduler_due,fountain_cloud.scheduler_jobs,
 fountain_cloud.scheduler_attempts,fountain_cloud.scheduler_prepare_receipts,fountain_cloud.scheduler_owner_dirty FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_stamp(p_time timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT to_char(p_time AT TIME ZONE 'UTC',CASE WHEN extract(microseconds FROM p_time)::bigint%1000000=0 THEN 'YYYY-MM-DD"T"HH24:MI:SS' ELSE 'YYYY-MM-DD"T"HH24:MI:SS.US' END)||'+00:00'
$$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_stamp(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
-- Match ServiceStore's Date.parse(clock) millisecond truncation and six digits.
CREATE FUNCTION fountain_cloud.scheduler_store_stamp(p_time timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT to_char(date_trunc('milliseconds',p_time) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS')||'000+00:00'
$$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_store_stamp(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_utc(p_value text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_time timestamptz;
BEGIN
 IF p_value IS NULL OR p_value!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{6})?\+00:00$' THEN RAISE EXCEPTION 'Invalid scheduler datetime' USING ERRCODE='22023';END IF;
 v_time:=p_value::timestamptz;
 IF v_time<'1970-01-01T00:00:00Z'::timestamptz OR v_time>='9999-01-01T00:00:00Z'::timestamptz OR fountain_cloud.scheduler_stamp(v_time)<>p_value THEN RAISE EXCEPTION 'Invalid scheduler datetime' USING ERRCODE='22023';END IF;
 RETURN v_time;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_utc(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_definition(p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to((p_data-ARRAY['updated_at','next_run_at','last_run_at','last_run_status','last_error','schedule_status','enabled'])::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_definition(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_due_hash(p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(COALESCE(p_data->'next_run_at','null'::jsonb)::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_due_hash(jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- A bounded actual-instant parser for queue wake-up ONLY, not recurrence/DST.
-- New definitions are always planned immediately; TS validates the calendar.
CREATE FUNCTION fountain_cloud.scheduler_wake(p_data jsonb,p_now timestamptz) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_text text;v_time timestamptz;
BEGIN
 IF jsonb_typeof(p_data->'next_run_at')='string' AND p_data->>'next_run_at'<>'' THEN v_text:=p_data->>'next_run_at';ELSE v_text:=p_data->'schedule'->>'start_at';END IF;
 IF v_text IS NULL OR length(v_text)>100 OR v_text!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.,][0-9]{1,9})?)?(Z|[+-][0-9]{2}:?[0-9]{2}(:?[0-9]{2}([.,][0-9]{1,6})?)?)$' THEN RETURN p_now;END IF;
 -- JS scheduleDatetime truncates beyond microseconds; PostgreSQL otherwise rounds.
 v_text:=regexp_replace(replace(v_text,',','.'),'([.][0-9]{6})[0-9]+',E'\\1','g');
 BEGIN v_time:=v_text::timestamptz;EXCEPTION WHEN data_exception THEN RETURN p_now;END;
 IF v_time<'1970-01-01T00:00:00Z'::timestamptz OR v_time>='9999-01-01T00:00:00Z'::timestamptz THEN RETURN p_now;END IF;RETURN v_time;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_wake(jsonb,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_author(p_workspace_id text,p_member_id text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_user uuid;
BEGIN
 SELECT u.id INTO v_user FROM fountain_private.entities e
 JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id JOIN auth.users u ON u.id=m.auth_user_id
 WHERE e.workspace_id=p_workspace_id AND e.kind='member' AND e.id=p_member_id AND e.data->>'id'=e.id AND jsonb_typeof(e.data->'id')='string'
  AND e.data->>'role' IN('owner','admin','member','guest') AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
  AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
  AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
  AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
 FOR SHARE OF e,m,u;RETURN v_user;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_author(text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_retire(p_workspace_id text,p_grant_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_grant fountain_cloud.service_grants;
BEGIN
 SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=p_workspace_id AND g.id=p_grant_id FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 IF v_grant.purpose<>'automation' THEN RAISE EXCEPTION 'Invalid scheduler grant' USING ERRCODE='PT503';END IF;
 IF v_grant.enabled THEN
  IF v_grant.version>=9007199254740991 THEN RAISE EXCEPTION 'Scheduler version limit' USING ERRCODE='PT413';END IF;
  UPDATE fountain_cloud.service_grants g SET enabled=false,version=g.version+1 WHERE g.workspace_id=p_workspace_id AND g.id=p_grant_id;
 END IF;
 UPDATE fountain_cloud.service_leases l SET closed=true WHERE l.workspace_id=p_workspace_id AND l.grant_id=p_grant_id AND NOT l.closed;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_retire(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_sync(p_workspace_id text,p_id text,p_data jsonb,p_previous jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_due fountain_cloud.scheduler_due;v_job fountain_cloud.scheduler_jobs;v_old_grant fountain_cloud.service_grants;
 v_now timestamptz:=clock_timestamp();v_definition text;v_hash text;v_author text;v_user uuid;v_mapped uuid;v_epoch bigint;v_grant uuid;v_grant_version bigint;
 v_new boolean;v_changed boolean;v_identity_changed boolean:=false;v_active boolean;v_own_completion boolean:=false;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=p_workspace_id AND r.enabled) THEN RETURN;END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);PERFORM set_config('fountain.workspace_id',p_workspace_id,true);
 SELECT d.* INTO v_due FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=p_workspace_id AND d.automation_id=p_id FOR UPDATE;
 IF p_data IS NULL THEN
  IF NOT FOUND THEN RETURN;END IF;
  IF v_due.active_job IS NOT NULL THEN UPDATE fountain_cloud.scheduler_jobs j SET state='superseded',outcome='deleted',finished_at=v_now WHERE j.workspace_id=p_workspace_id AND j.id=v_due.active_job AND j.state IN('preparing','ready');END IF;
  IF v_due.grant_id IS NOT NULL THEN PERFORM fountain_cloud.scheduler_retire(p_workspace_id,v_due.grant_id);END IF;
  UPDATE fountain_cloud.scheduler_due d SET deleted=true,enabled=false,wake_at=NULL,active_job=NULL,grant_id=NULL,grant_version=NULL WHERE d.workspace_id=p_workspace_id AND d.automation_id=p_id;RETURN;
 END IF;
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR jsonb_typeof(p_data->'id') IS DISTINCT FROM 'string' OR p_data->>'id' IS DISTINCT FROM p_id THEN RAISE EXCEPTION 'Invalid scheduler entity' USING ERRCODE='22023';END IF;
 v_new:=v_due.automation_id IS NULL OR v_due.deleted;v_definition:=fountain_cloud.scheduler_definition(p_data);v_hash:=fountain_cloud.scheduler_due_hash(p_data);
 IF v_due.active_job IS NOT NULL THEN
  SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=p_workspace_id AND j.id=v_due.active_job FOR UPDATE;
  -- PG JSONB numeric equality preserves a self-completion whose JS roundtrip
  -- changed only representation (1.0 -> 1). No exemption for external NEW work.
  v_own_completion:=v_job.state='done' AND p_previous IS NOT NULL AND
   p_previous-ARRAY['updated_at','next_run_at','last_run_at','last_run_status','last_error','schedule_status','enabled'] =
   p_data-ARRAY['updated_at','next_run_at','last_run_at','last_run_status','last_error','schedule_status','enabled'];
 END IF;
 v_changed:=v_new OR(v_due.definition_hash<>v_definition AND NOT COALESCE(v_own_completion,false));
 v_author:=CASE WHEN jsonb_typeof(p_data->'owner_id')='string' AND length(p_data->>'owner_id') BETWEEN 1 AND 160 THEN p_data->>'owner_id' ELSE NULL END;
 v_active:=p_data->>'trigger'='scheduled' AND COALESCE(p_data->'enabled','true'::jsonb)='true'::jsonb;
 SELECT m.auth_user_id INTO v_mapped FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=v_author FOR SHARE OF m;
 v_user:=fountain_cloud.scheduler_author(p_workspace_id,v_author);v_grant:=v_due.grant_id;v_grant_version:=v_due.grant_version;
 IF v_due.grant_id IS NOT NULL THEN SELECT g.* INTO v_old_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=p_workspace_id AND g.id=v_due.grant_id FOR UPDATE;END IF;
 SELECT COALESCE((SELECT q.identity_epoch FROM fountain_cloud.scheduler_owner_dirty q WHERE q.workspace_id=p_workspace_id AND q.member_id=v_author),0) INTO v_epoch;
 v_identity_changed:=NOT v_new AND(v_due.identity_user IS DISTINCT FROM v_mapped OR v_due.identity_epoch IS DISTINCT FROM v_epoch);
 v_changed:=v_changed OR v_identity_changed OR(v_grant IS NULL AND v_user IS NOT NULL AND COALESCE(v_active,false));
 IF v_new THEN
  v_due.incarnation:=gen_random_uuid();v_due.definition_version:=1;
 ELSIF v_changed THEN
  IF v_due.definition_version>=9007199254740991 THEN RAISE EXCEPTION 'Scheduler version limit' USING ERRCODE='PT413';END IF;v_due.definition_version:=v_due.definition_version+1;
 END IF;
 IF v_changed THEN
  IF v_grant IS NOT NULL THEN PERFORM fountain_cloud.scheduler_retire(p_workspace_id,v_grant);END IF;v_grant:=NULL;v_grant_version:=NULL;
 END IF;
 -- A revoked/rotated grant alone never authorizes automatic re-issuance.
 IF v_user IS NOT NULL AND v_grant IS NULL AND COALESCE(v_active,false) THEN
  v_grant:=gen_random_uuid();v_grant_version:=1;
  INSERT INTO fountain_cloud.service_grants(workspace_id,id,purpose,version,enabled,member_id,auth_user_id,resource_id,token_hash,expires_at,created_at,creation_digest,pending_until)
  VALUES(p_workspace_id,v_grant,'automation',1,true,v_author,v_user,p_id,NULL,NULL,v_now,NULL,NULL);
 END IF;
 IF v_due.active_job IS NOT NULL THEN
  SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=p_workspace_id AND j.id=v_due.active_job FOR UPDATE;
  -- A successful service commit marks done provisionally in this SAME TX before
  -- applying its nextAt/disable. Do not fence its accepted-ACK lease here.
  IF v_job.state IN('preparing','ready') THEN
   IF v_changed OR v_job.due_hash<>v_hash OR NOT v_active THEN
    UPDATE fountain_cloud.scheduler_jobs j SET state='superseded',outcome='source_changed',finished_at=v_now WHERE j.workspace_id=p_workspace_id AND j.id=v_job.id;
    UPDATE fountain_cloud.service_leases l SET closed=true FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=p_workspace_id AND a.job_id=v_job.id AND l.workspace_id=a.workspace_id AND l.grant_id=a.grant_id AND l.id=a.lease_id AND NOT l.closed;
    v_due.active_job:=NULL;
   ELSIF v_user IS NULL OR NOT EXISTS(SELECT 1 FROM fountain_cloud.service_grants g WHERE g.workspace_id=p_workspace_id AND g.id=v_grant AND g.version=v_grant_version AND g.enabled) THEN
    UPDATE fountain_cloud.scheduler_jobs j SET state='preparing' WHERE j.workspace_id=p_workspace_id AND j.id=v_job.id;
   END IF;
  ELSE v_due.active_job:=NULL;END IF;
 END IF;
 INSERT INTO fountain_cloud.scheduler_due(workspace_id,automation_id,incarnation,definition_version,definition_hash,due_hash,author_id,identity_user,identity_epoch,grant_id,grant_version,enabled,deleted,wake_at,active_job)
 VALUES(p_workspace_id,p_id,v_due.incarnation,v_due.definition_version,v_definition,v_hash,v_author,v_mapped,v_epoch,v_grant,v_grant_version,COALESCE(v_active,false),false,
  CASE WHEN NOT COALESCE(v_active,false) THEN NULL WHEN v_due.active_job IS NOT NULL THEN v_due.wake_at WHEN v_new OR v_changed THEN v_now ELSE fountain_cloud.scheduler_wake(p_data,v_now) END,v_due.active_job)
 ON CONFLICT(workspace_id,automation_id) DO UPDATE SET incarnation=EXCLUDED.incarnation,definition_version=EXCLUDED.definition_version,definition_hash=EXCLUDED.definition_hash,due_hash=EXCLUDED.due_hash,author_id=EXCLUDED.author_id,identity_user=EXCLUDED.identity_user,identity_epoch=EXCLUDED.identity_epoch,grant_id=EXCLUDED.grant_id,grant_version=EXCLUDED.grant_version,enabled=EXCLUDED.enabled,deleted=false,wake_at=EXCLUDED.wake_at,active_job=EXCLUDED.active_job;
END $$;
ALTER FUNCTION fountain_cloud.scheduler_sync(text,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_sync(text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_entity_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text;v_kind text;v_id text;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'entities' THEN RAISE EXCEPTION 'Invalid scheduler trigger' USING ERRCODE='22023';END IF;
 IF TG_OP='DELETE' THEN v_ws:=OLD.workspace_id;v_kind:=OLD.kind;v_id:=OLD.id;ELSE v_ws:=NEW.workspace_id;v_kind:=NEW.kind;v_id:=NEW.id;END IF;
 IF v_kind='automation' THEN PERFORM fountain_cloud.scheduler_sync(v_ws,v_id,CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.data END,CASE WHEN TG_OP='UPDATE' THEN OLD.data ELSE NULL END);

 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
ALTER FUNCTION fountain_cloud.scheduler_entity_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_entity_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fountain_scheduler_entity AFTER INSERT OR UPDATE OR DELETE ON fountain_private.entities FOR EACH ROW EXECUTE FUNCTION fountain_cloud.scheduler_entity_event();
-- Defer member ID enqueue until the human writer's final-owner Auth-user SHARE
-- checks have completed. Immediate dirty UPDATE could invert GoTrue DELETE's
-- Auth-user -> mapping-cascade -> dirty-row lock order. No authority is granted.
CREATE FUNCTION fountain_cloud.scheduler_member_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text;v_id text;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'entities' THEN RAISE EXCEPTION 'Invalid scheduler member trigger' USING ERRCODE='22023';END IF;
 IF TG_OP='DELETE' THEN v_ws:=OLD.workspace_id;v_id:=OLD.id;ELSE v_ws:=NEW.workspace_id;v_id:=NEW.id;END IF;
 IF EXISTS(SELECT 1 FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=v_ws AND r.enabled) THEN
  INSERT INTO fountain_cloud.scheduler_owner_dirty AS queued(workspace_id,member_id) VALUES(v_ws,v_id)
  ON CONFLICT(workspace_id,member_id) DO UPDATE SET cursor_id='',version=queued.version+1,pending=true,touched_at=clock_timestamp();
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
ALTER FUNCTION fountain_cloud.scheduler_member_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_member_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER fountain_scheduler_member_insert AFTER INSERT ON fountain_private.entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='member') EXECUTE FUNCTION fountain_cloud.scheduler_member_event();
CREATE CONSTRAINT TRIGGER fountain_scheduler_member_update AFTER UPDATE ON fountain_private.entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='member') EXECUTE FUNCTION fountain_cloud.scheduler_member_event();
CREATE CONSTRAINT TRIGGER fountain_scheduler_member_delete AFTER DELETE ON fountain_private.entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(OLD.kind='member') EXECUTE FUNCTION fountain_cloud.scheduler_member_event();

CREATE FUNCTION fountain_cloud.scheduler_mapping_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'identity_mapping' THEN RAISE EXCEPTION 'Invalid scheduler mapping trigger' USING ERRCODE='22023';END IF;
 -- Registered-disabled mapping events still advance safety epoch ONLY; no
 -- business/due/grant/backfill work is performed. Unregistered namespaces stay inert.
 -- Enqueue IDs ONLY: existing account_user_lock may already be held. Do not take
 -- a workspace/grant/lease/member lock in this trigger and reverse lock order.
 IF TG_OP IN('UPDATE','DELETE') AND EXISTS(SELECT 1 FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=OLD.workspace_id) THEN
  INSERT INTO fountain_cloud.scheduler_owner_dirty AS queued(workspace_id,member_id,identity_epoch) VALUES(OLD.workspace_id,OLD.member_id,1) ON CONFLICT(workspace_id,member_id) DO UPDATE SET cursor_id='',identity_epoch=queued.identity_epoch+1,version=queued.version+1,pending=true,touched_at=clock_timestamp();END IF;
 IF TG_OP IN('INSERT','UPDATE') AND EXISTS(SELECT 1 FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=NEW.workspace_id) THEN
  INSERT INTO fountain_cloud.scheduler_owner_dirty AS queued(workspace_id,member_id,identity_epoch) VALUES(NEW.workspace_id,NEW.member_id,1) ON CONFLICT(workspace_id,member_id) DO UPDATE SET cursor_id='',identity_epoch=queued.identity_epoch+1,version=queued.version+1,pending=true,touched_at=clock_timestamp();END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
ALTER FUNCTION fountain_cloud.scheduler_mapping_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_mapping_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fountain_scheduler_mapping AFTER INSERT OR UPDATE OR DELETE ON fountain_private.identity_mapping FOR EACH ROW EXECUTE FUNCTION fountain_cloud.scheduler_mapping_event();

-- Resolve by globally unique hash, then take the workspace lock BEFORE row locks.
CREATE FUNCTION fountain_cloud.scheduler_ticket(p_ticket_hash text,p_invocation_id uuid) RETURNS fountain_cloud.scheduler_attempts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text;v_attempt fountain_cloud.scheduler_attempts;v_job fountain_cloud.scheduler_jobs;v_now timestamptz;
BEGIN
 IF p_ticket_hash IS NULL OR p_ticket_hash!~'^[a-f0-9]{64}$' OR p_invocation_id IS NULL THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
 SELECT a.workspace_id INTO v_ws FROM fountain_cloud.scheduler_attempts a WHERE a.ticket_hash=p_ticket_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
 PERFORM fountain_cloud.store_lock(v_ws);PERFORM set_config('fountain.workspace_id',v_ws,true);v_now:=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=v_ws AND r.enabled) THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
 SELECT a.* INTO v_attempt FROM fountain_cloud.scheduler_attempts a WHERE a.ticket_hash=p_ticket_hash AND a.workspace_id=v_ws FOR UPDATE;
 SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_ws AND j.id=v_attempt.job_id FOR UPDATE;
 IF v_attempt.id IS NULL OR v_job.id IS NULL OR v_job.generation<>v_attempt.generation OR v_attempt.ack_until<=v_now OR v_job.state='superseded' OR(v_job.state<>'done' AND v_attempt.work_until<=v_now) THEN RAISE EXCEPTION 'Ticket not found' USING ERRCODE='PT404';END IF;
 IF v_attempt.invocation_id IS NOT NULL AND v_attempt.invocation_id<>p_invocation_id THEN RAISE EXCEPTION 'INVOCATION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF v_attempt.invocation_id IS NULL THEN UPDATE fountain_cloud.scheduler_attempts a SET invocation_id=p_invocation_id WHERE a.workspace_id=v_ws AND a.id=v_attempt.id;v_attempt.invocation_id:=p_invocation_id;END IF;
 RETURN v_attempt;
END $$;
ALTER FUNCTION fountain_cloud.scheduler_ticket(text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_ticket(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_bound(p_attempt fountain_cloud.scheduler_attempts) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_job fountain_cloud.scheduler_jobs;v_due fountain_cloud.scheduler_due;v_grant fountain_cloud.service_grants;v_lease uuid;v_context jsonb;
BEGIN
 SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=p_attempt.workspace_id AND j.id=p_attempt.job_id FOR UPDATE;
 SELECT d.* INTO v_due FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=v_job.workspace_id AND d.automation_id=v_job.automation_id FOR UPDATE;
 IF v_job.state<>'ready' OR v_job.generation<>p_attempt.generation OR v_due.active_job IS DISTINCT FROM v_job.id OR v_due.deleted OR NOT v_due.enabled OR v_due.grant_id IS NULL THEN RAISE EXCEPTION 'Scheduler is not ready' USING ERRCODE='PT409';END IF;
 SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_job.workspace_id AND g.id=v_due.grant_id FOR SHARE;
 IF v_grant.id IS NULL OR NOT v_grant.enabled OR v_grant.version IS DISTINCT FROM v_due.grant_version THEN RAISE EXCEPTION 'Scheduler authority unavailable' USING ERRCODE='PT401';END IF;
 IF p_attempt.lease_id IS NULL THEN
  v_lease:=gen_random_uuid();
  INSERT INTO fountain_cloud.service_leases(workspace_id,grant_id,id,generation,ticket_hash,run_id,expires_at,closed)
  VALUES(v_job.workspace_id,v_grant.id,v_lease,p_attempt.generation,p_attempt.ticket_hash,v_job.run_id,p_attempt.ack_until,false);
 ELSE
  IF p_attempt.grant_id IS DISTINCT FROM v_grant.id THEN RAISE EXCEPTION 'Scheduler authority changed' USING ERRCODE='PT401';END IF;v_lease:=p_attempt.lease_id;
 END IF;
 v_context:=jsonb_build_object('kind','automation','workspaceId',v_job.workspace_id,'memberId',v_grant.member_id,'grantId',v_grant.id,'grantVersion',v_grant.version,'resourceId',v_job.automation_id,'runId',v_job.run_id,'leaseId',v_lease,'generation',p_attempt.generation,'ticketHash',p_attempt.ticket_hash);
 PERFORM fountain_cloud.service_context(v_context);
 UPDATE fountain_cloud.scheduler_attempts a SET grant_id=v_grant.id,lease_id=v_lease,authority_hash=encode(sha256(convert_to(v_context::text,'UTF8')),'hex'),identity_epoch=v_due.identity_epoch WHERE a.workspace_id=p_attempt.workspace_id AND a.id=p_attempt.id;
 PERFORM fountain_cloud.scheduler_identity_guard(v_context);
 RETURN jsonb_build_object('state','ready','context',v_context,'claim',jsonb_build_object('jobId',v_job.id,'workspaceId',v_job.workspace_id,'automationId',v_job.automation_id,'definitionVersion',v_job.definition_version,'definitionHash',v_job.definition_hash,'dueHash',v_job.due_hash,'fixedNow',fountain_cloud.scheduler_stamp(v_job.fixed_now),'scheduledAt',v_job.scheduled_at,'runId',v_job.run_id,'nextRunAt',v_job.next_at));
END $$;
ALTER FUNCTION fountain_cloud.scheduler_bound(fountain_cloud.scheduler_attempts) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_bound(fountain_cloud.scheduler_attempts) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_image(p_job fountain_cloud.scheduler_jobs,p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_schedule jsonb:=p_data->'schedule';v_malformed boolean:=false;v_key text;v_value jsonb;v_next jsonb;v_due fountain_cloud.scheduler_due;
BEGIN
 IF jsonb_typeof(v_schedule) IS DISTINCT FROM 'object' OR pg_column_size(v_schedule)>4096 THEN v_schedule:=NULL;v_malformed:=true;
 ELSIF v_schedule-ARRAY['frequency','interval','timezone','start_at','end_at']<>'{}'::jsonb THEN v_schedule:=NULL;v_malformed:=true;
 ELSE
  -- Fixed five lookups, never a PL loop/tuplestore over arbitrary legacy keys.
  FOREACH v_key IN ARRAY ARRAY['frequency','interval','timezone','start_at','end_at'] LOOP
   IF NOT(v_schedule ? v_key) THEN CONTINUE;END IF;v_value:=v_schedule->v_key;
   IF v_key='interval' THEN
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'number' OR octet_length(v_value::text)>32 THEN v_malformed:=true;
    ELSIF (v_value#>>'{}')::numeric NOT BETWEEN -9007199254740991 AND 9007199254740991 THEN v_malformed:=true;END IF;
   ELSIF jsonb_typeof(v_value) IS DISTINCT FROM 'string' OR length(v_value#>>'{}')>100 THEN v_malformed:=true;END IF;
   IF v_malformed THEN EXIT;END IF;
  END LOOP;
 END IF;
 v_next:=COALESCE(p_data->'next_run_at','null'::jsonb);
 IF v_next<>'null'::jsonb AND(jsonb_typeof(v_next) IS DISTINCT FROM 'string' OR length(v_next#>>'{}')>100) THEN v_malformed:=true;v_next:='null'::jsonb;END IF;
 IF v_malformed THEN v_schedule:=NULL;END IF;
 SELECT d.* INTO v_due FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=p_job.workspace_id AND d.automation_id=p_job.automation_id;
 RETURN jsonb_build_object('jobId',p_job.id,'workspaceId',p_job.workspace_id,'automationId',p_job.automation_id,'incarnation',p_job.incarnation,'definitionVersion',p_job.definition_version,'definitionHash',p_job.definition_hash,'dueHash',p_job.due_hash,'fixedNow',fountain_cloud.scheduler_stamp(p_job.fixed_now),'revision',fountain_cloud.store_revision(p_job.workspace_id,'_entity_revision'),'enabled',true,'trigger','scheduled','schedule',v_schedule,'nextRunAt',v_next,'malformed',v_malformed,'authorAvailable',fountain_cloud.scheduler_author(p_job.workspace_id,v_due.author_id) IS NOT NULL AND EXISTS(SELECT 1 FROM fountain_cloud.service_grants g WHERE g.workspace_id=p_job.workspace_id AND g.id=v_due.grant_id AND g.version=v_due.grant_version AND g.enabled AND g.purpose='automation' AND g.resource_id=p_job.automation_id AND g.member_id=v_due.author_id AND g.auth_user_id=v_due.identity_user AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp())));
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_image(fountain_cloud.scheduler_jobs,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_open(p_ticket_hash text,p_invocation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.scheduler_attempts;v_job fountain_cloud.scheduler_jobs;v_data jsonb;
BEGIN
 v_attempt:=fountain_cloud.scheduler_ticket(p_ticket_hash,p_invocation_id);
 SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_attempt.workspace_id AND j.id=v_attempt.job_id;
 IF v_job.state='done' THEN RETURN jsonb_build_object('state','done');END IF;
 SELECT e.data INTO v_data FROM fountain_private.entities e WHERE e.workspace_id=v_job.workspace_id AND e.kind='automation' AND e.id=v_job.automation_id FOR SHARE OF e;
 PERFORM fountain_cloud.scheduler_sync(v_job.workspace_id,v_job.automation_id,v_data);
 SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_attempt.workspace_id AND j.id=v_attempt.job_id;
 IF v_job.state IN('done','superseded') THEN RETURN jsonb_build_object('state','done');END IF;
 IF v_job.state='ready' THEN RETURN fountain_cloud.scheduler_bound(v_attempt);END IF;
 RETURN jsonb_build_object('state','planning','image',fountain_cloud.scheduler_image(v_job,v_data));
END $$;
ALTER FUNCTION fountain_cloud.scheduler_open(text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_open(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_prepare(p_ticket_hash text,p_invocation_id uuid,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_plan jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.scheduler_attempts;v_job fountain_cloud.scheduler_jobs;v_due fountain_cloud.scheduler_due;v_receipt fountain_cloud.scheduler_prepare_receipts;
 v_data jsonb;v_kind text;v_slot text;v_next text;v_run text;v_message text;v_now text;v_store_stamp text;v_time timestamptz;v_next_time timestamptz;v_revision bigint;v_response jsonb;
 v_run_data jsonb;v_previous fountain_private.entities;v_changes jsonb:='[]'::jsonb;v_runtime jsonb;v_actor uuid;v_current_actor uuid;v_existing boolean;v_outcome text;
BEGIN
 v_attempt:=fountain_cloud.scheduler_ticket(p_ticket_hash,p_invocation_id);
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_transaction_id IS NULL OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$'
  OR p_canonical IS NULL OR octet_length(p_canonical)>16384 OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object' OR octet_length(p_plan::text)>8192 THEN RAISE EXCEPTION 'Invalid scheduler plan' USING ERRCODE='22023';END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('ticketHash',p_ticket_hash,'invocationId',p_invocation_id,'expectedRevision',p_expected_revision,'plan',p_plan) THEN RAISE EXCEPTION 'Invalid scheduler digest' USING ERRCODE='22023';END IF;
 SELECT r.* INTO v_receipt FROM fountain_cloud.scheduler_prepare_receipts r WHERE r.workspace_id=v_attempt.workspace_id AND r.attempt_id=v_attempt.id AND r.invocation_id=p_invocation_id AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF v_receipt.digest<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409';END IF;
  IF v_receipt.response->>'state'='ready' THEN PERFORM fountain_cloud.service_context(v_receipt.response->'context');PERFORM fountain_cloud.scheduler_identity_guard(v_receipt.response->'context');END IF;RETURN v_receipt.response;
 END IF;
 IF EXISTS(SELECT 1 FROM fountain_cloud.scheduler_prepare_receipts r WHERE r.workspace_id=v_attempt.workspace_id AND r.attempt_id=v_attempt.id) THEN RAISE EXCEPTION 'PREPARE_ALREADY_ACCEPTED' USING ERRCODE='PT409';END IF;
 SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_attempt.workspace_id AND j.id=v_attempt.job_id FOR UPDATE;
 IF v_job.state='done' THEN RETURN jsonb_build_object('state','done');END IF;
 v_revision:=fountain_cloud.store_revision(v_job.workspace_id,'_entity_revision');IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 SELECT e.data INTO v_data FROM fountain_private.entities e WHERE e.workspace_id=v_job.workspace_id AND e.kind='automation' AND e.id=v_job.automation_id FOR SHARE OF e;
 PERFORM fountain_cloud.scheduler_sync(v_job.workspace_id,v_job.automation_id,v_data);
 SELECT d.* INTO v_due FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=v_job.workspace_id AND d.automation_id=v_job.automation_id FOR UPDATE;
 SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_attempt.workspace_id AND j.id=v_attempt.job_id;
 IF v_job.state='superseded' OR v_data IS NULL THEN RETURN jsonb_build_object('state','done');END IF;
 IF v_due.active_job IS DISTINCT FROM v_job.id OR v_due.incarnation<>v_job.incarnation OR v_due.definition_version<>v_job.definition_version OR fountain_cloud.scheduler_definition(v_data)<>v_job.definition_hash OR fountain_cloud.scheduler_due_hash(v_data)<>v_job.due_hash OR NOT v_due.enabled THEN RAISE EXCEPTION 'SLOT_CHANGED' USING ERRCODE='PT409';END IF;
 v_kind:=p_plan->>'kind';
 IF v_kind NOT IN('due','defer','complete','invalid') OR jsonb_typeof(p_plan->'kind') IS DISTINCT FROM 'string'
  OR NOT(p_plan ?& ARRAY['kind','scheduledAt','runId','nextRunAt']) OR p_plan-ARRAY['kind','scheduledAt','runId','nextRunAt','error']<>'{}'::jsonb
  OR jsonb_typeof(p_plan->'runId') IS DISTINCT FROM 'string' OR (p_plan->>'runId')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid scheduler plan' USING ERRCODE='22023';END IF;
 v_run:=p_plan->>'runId';v_now:=fountain_cloud.scheduler_stamp(v_job.fixed_now);v_store_stamp:=fountain_cloud.scheduler_store_stamp(v_job.fixed_now);
 IF v_kind='invalid' THEN
  IF p_plan->'scheduledAt' IS DISTINCT FROM 'null'::jsonb OR p_plan->'nextRunAt' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(p_plan->'error') IS DISTINCT FROM 'string' OR length(p_plan->>'error') NOT BETWEEN 1 AND 1000 OR v_run<>encode(sha256(convert_to(v_job.automation_id||chr(10)||'invalid-schedule','UTF8')),'hex') THEN RAISE EXCEPTION 'Invalid scheduler plan' USING ERRCODE='22023';END IF;
  v_message:=p_plan->>'error';
 ELSE
  IF p_plan ? 'error' OR jsonb_typeof(p_plan->'scheduledAt') IS DISTINCT FROM 'string' OR(p_plan->'nextRunAt'<>'null'::jsonb AND jsonb_typeof(p_plan->'nextRunAt') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'Invalid scheduler plan' USING ERRCODE='22023';END IF;
  v_slot:=p_plan->>'scheduledAt';v_time:=fountain_cloud.scheduler_utc(v_slot);v_next:=p_plan->>'nextRunAt';IF v_next IS NOT NULL THEN v_next_time:=fountain_cloud.scheduler_utc(v_next);END IF;
  IF v_run<>encode(sha256(convert_to(v_job.automation_id||chr(10)||v_slot,'UTF8')),'hex')
   OR v_kind='due' AND(v_time>v_job.fixed_now OR v_next_time<=v_job.fixed_now)
   OR v_kind='defer' AND(v_time<=v_job.fixed_now OR v_next IS DISTINCT FROM v_slot)
   OR v_kind='complete' AND v_next IS NOT NULL THEN RAISE EXCEPTION 'Invalid scheduler slot' USING ERRCODE='22023';END IF;
  -- Source instant parsing stays in the trusted TS planner/claimed-slot guard.
  -- PG casts differ for legacy commas, >6 fraction digits and +23:59 offsets.
  -- Current raw definition/due hashes + revision pin the exact planning image;
  -- scheduler_wake is only a conservative queue hint, never slot authority.
 END IF;
 -- A bound plan cannot change between retries/generations even after CAS loss.
 IF v_job.run_id IS NOT NULL AND(v_job.run_id IS DISTINCT FROM v_run OR v_job.scheduled_at IS DISTINCT FROM v_slot OR v_job.next_at IS DISTINCT FROM v_next) THEN RAISE EXCEPTION 'SLOT_CHANGED' USING ERRCODE='PT409';END IF;
 UPDATE fountain_cloud.scheduler_jobs j SET run_id=v_run,scheduled_at=v_slot,next_at=v_next WHERE j.workspace_id=v_job.workspace_id AND j.id=v_job.id;
 SELECT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_job.workspace_id AND e.kind='automation_run' AND e.id=v_run) INTO v_existing;
 v_current_actor:=fountain_cloud.scheduler_author(v_job.workspace_id,v_due.author_id);v_actor:=v_current_actor;
 IF NOT EXISTS(SELECT 1 FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_job.workspace_id AND g.id=v_due.grant_id AND g.version=v_due.grant_version AND g.enabled AND g.purpose='automation' AND g.resource_id=v_job.automation_id AND g.member_id=v_due.author_id AND g.auth_user_id=v_actor AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp())) THEN v_actor:=NULL;END IF;
 IF v_kind='due' AND v_actor IS NOT NULL AND NOT v_existing THEN
  UPDATE fountain_cloud.scheduler_jobs j SET state='ready' WHERE j.workspace_id=v_job.workspace_id AND j.id=v_job.id;v_response:=fountain_cloud.scheduler_bound(v_attempt);
 ELSE
  -- Ticket-backed CONTROL ONLY: build runtime/run changes here, never accept
  -- arbitrary actions, page/row writes or a manufactured domain principal.
  v_runtime:=v_data;v_outcome:=v_kind;
  IF v_kind='defer' THEN
   UPDATE fountain_cloud.scheduler_jobs j SET state='done',outcome='defer',result_revision=v_revision,finished_at=clock_timestamp() WHERE j.workspace_id=v_job.workspace_id AND j.id=v_job.id;
   UPDATE fountain_cloud.scheduler_due d SET active_job=NULL,wake_at=v_time WHERE d.workspace_id=v_job.workspace_id AND d.automation_id=v_job.automation_id;
  ELSE
   IF v_kind='invalid' THEN v_runtime:=v_runtime||jsonb_build_object('enabled',false,'next_run_at',NULL,'last_error',v_message);
   ELSIF v_kind='complete' THEN v_runtime:=v_runtime||jsonb_build_object('enabled',false,'next_run_at',NULL,'schedule_status','completed');
   ELSE
    v_outcome:=CASE WHEN v_existing THEN 'deduplicated' ELSE 'author_unavailable' END;
    v_runtime:=v_runtime||jsonb_build_object('next_run_at',v_next);
    IF v_next IS NULL THEN v_runtime:=v_runtime||jsonb_build_object('enabled',false,'schedule_status','completed');END IF;
    IF NOT v_existing THEN v_message:=CASE WHEN v_current_actor IS NULL THEN 'Automation author was deleted or deactivated' ELSE 'Automation delegated authority is unavailable' END;v_runtime:=v_runtime||jsonb_build_object('last_run_at',v_now,'last_run_status','failed','last_error',v_message);END IF;
   END IF;
   IF v_kind='invalid' OR(v_kind='due' AND NOT v_existing) THEN
    SELECT e.* INTO v_previous FROM fountain_private.entities e WHERE e.workspace_id=v_job.workspace_id AND e.kind='automation_run' AND e.id=v_run;
    IF v_kind='due' THEN
     -- Match tick_one's running->failed->automation counter/timestamp semantics.
     v_run_data:=jsonb_build_object('id',v_run,'automation_id',v_job.automation_id,'scheduled_at',v_slot,'started_at',v_now,'status','running','next_run_at',v_next,'created_at',v_store_stamp,'updated_at',v_store_stamp);
     v_changes:=v_changes||jsonb_build_array(jsonb_build_object('op','put','kind','automation_run','id',v_run,'data',v_run_data,'previousCreatedAt',NULL));
    END IF;
    v_run_data:=jsonb_build_object('id',v_run,'automation_id',v_job.automation_id,'scheduled_at',v_slot,'started_at',v_now,'finished_at',v_now,'status','failed','error',v_message,'next_run_at',v_next,'created_at',COALESCE(v_previous.created_at,v_store_stamp),'updated_at',v_store_stamp);
    v_changes:=v_changes||jsonb_build_array(jsonb_build_object('op','put','kind','automation_run','id',v_run,'data',v_run_data,'previousCreatedAt',CASE WHEN v_kind='due' THEN v_store_stamp ELSE v_previous.created_at END));
   END IF;
   v_runtime:=v_runtime||jsonb_build_object('updated_at',v_store_stamp);
   v_changes:=v_changes||jsonb_build_array(jsonb_build_object('op','put','kind','automation','id',v_job.automation_id,'data',v_runtime,'previousCreatedAt',v_data->>'created_at'));
   UPDATE fountain_cloud.scheduler_jobs j SET state='done',outcome=v_outcome,finished_at=clock_timestamp() WHERE j.workspace_id=v_job.workspace_id AND j.id=v_job.id;
   v_revision:=fountain_cloud.store_apply_changes_locked(v_job.workspace_id,p_expected_revision,v_changes);
   UPDATE fountain_cloud.scheduler_jobs j SET result_revision=v_revision WHERE j.workspace_id=v_job.workspace_id AND j.id=v_job.id;
  END IF;
  v_response:=jsonb_build_object('state','done');
 END IF;
 INSERT INTO fountain_cloud.scheduler_prepare_receipts(workspace_id,attempt_id,invocation_id,transaction_id,digest,response) VALUES(v_attempt.workspace_id,v_attempt.id,p_invocation_id,p_transaction_id,p_digest,v_response);
 RETURN v_response;
END $$;
ALTER FUNCTION fountain_cloud.scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Sticky event epoch prevents unlink->sameUUID relink from reviving an old
-- lease/receipt before dirty reconciliation. Read without a dirty row lock AFTER
-- the caller's live Auth/mapping SHARE locks; mapping triggers never need ws locks.
CREATE FUNCTION fountain_cloud.scheduler_identity_guard(p_context jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.scheduler_attempts;v_epoch bigint;
BEGIN
 IF p_context->>'kind'<>'automation' THEN RETURN;END IF;
 SELECT a.* INTO v_attempt FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=p_context->>'workspaceId' AND a.grant_id=(p_context->>'grantId')::uuid AND a.lease_id=(p_context->>'leaseId')::uuid AND a.generation=(p_context->>'generation')::bigint AND a.ticket_hash=p_context->>'ticketHash';
 IF NOT FOUND THEN RAISE EXCEPTION 'Scheduler authority changed' USING ERRCODE='PT401';END IF;
 SELECT COALESCE((SELECT q.identity_epoch FROM fountain_cloud.scheduler_owner_dirty q WHERE q.workspace_id=p_context->>'workspaceId' AND q.member_id=p_context->>'memberId'),0) INTO v_epoch;
 IF v_attempt.identity_epoch IS DISTINCT FROM v_epoch THEN RAISE EXCEPTION 'Scheduler authority changed' USING ERRCODE='PT401';END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_identity_guard(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- NEW data snapshots/commits must be bound to a current broker slot. Exact
-- service receipts bypass this NEW-work gate, not current service_context auth.
CREATE FUNCTION fountain_cloud.scheduler_service_ready(p_context jsonb) RETURNS fountain_cloud.scheduler_jobs
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.scheduler_attempts;v_job fountain_cloud.scheduler_jobs;v_due fountain_cloud.scheduler_due;v_data jsonb;
BEGIN
 SELECT a.* INTO v_attempt FROM fountain_cloud.scheduler_attempts a
 WHERE a.workspace_id=p_context->>'workspaceId' AND a.grant_id=(p_context->>'grantId')::uuid AND a.lease_id=(p_context->>'leaseId')::uuid
  AND a.generation=(p_context->>'generation')::bigint AND a.ticket_hash=p_context->>'ticketHash' AND a.invocation_id IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR v_attempt.work_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=v_attempt.workspace_id AND r.enabled) THEN RAISE EXCEPTION 'Scheduler scope forbidden' USING ERRCODE='PT403';END IF;
 SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=v_attempt.workspace_id AND j.id=v_attempt.job_id FOR UPDATE;
 SELECT d.* INTO v_due FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=v_attempt.workspace_id AND d.automation_id=p_context->>'resourceId' FOR UPDATE;
 SELECT e.data INTO v_data FROM fountain_private.entities e WHERE e.workspace_id=v_attempt.workspace_id AND e.kind='automation' AND e.id=p_context->>'resourceId' FOR SHARE OF e;
 IF v_job.state IS DISTINCT FROM 'ready' OR v_job.generation IS DISTINCT FROM v_attempt.generation OR v_job.run_id IS DISTINCT FROM p_context->>'runId'
  OR v_due.grant_id IS DISTINCT FROM (p_context->>'grantId')::uuid OR v_due.grant_version IS DISTINCT FROM (p_context->>'grantVersion')::bigint
  OR v_due.active_job IS DISTINCT FROM v_job.id OR v_due.incarnation IS DISTINCT FROM v_job.incarnation OR v_due.definition_version IS DISTINCT FROM v_job.definition_version
  OR v_due.deleted OR NOT v_due.enabled OR v_data IS NULL OR v_data->>'trigger' IS DISTINCT FROM 'scheduled' OR COALESCE(v_data->'enabled','true'::jsonb)<>'true'::jsonb
  OR fountain_cloud.scheduler_definition(v_data) IS DISTINCT FROM v_job.definition_hash OR fountain_cloud.scheduler_due_hash(v_data) IS DISTINCT FROM v_job.due_hash THEN RAISE EXCEPTION 'SLOT_CHANGED' USING ERRCODE='PT409';END IF;
 RETURN v_job;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_service_ready(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION fountain_cloud.service_data_ready(p_context jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF p_context->>'kind'='automation' THEN PERFORM fountain_cloud.scheduler_identity_guard(p_context);PERFORM fountain_cloud.scheduler_service_ready(p_context);END IF;
END $$;
CREATE OR REPLACE FUNCTION fountain_cloud.service_commit(p_context jsonb,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_principal jsonb;v_ws text;v_scope text;v_recorded fountain_cloud.service_commit_receipts;v_revision bigint;
 v_job fountain_cloud.scheduler_jobs;v_final_run jsonb;v_final_auto jsonb;v_stamp text;v_next jsonb;
BEGIN
 v_principal:=fountain_cloud.service_context(p_context);
 IF v_principal IS NULL THEN RAISE EXCEPTION 'Service scope forbidden' USING ERRCODE='PT403';END IF;
 PERFORM fountain_cloud.scheduler_identity_guard(p_context);
 v_ws:=p_context->>'workspaceId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_transaction_id IS NULL
  OR p_digest IS NULL OR p_digest!~'^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>16777216
  OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid commit' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_changes)>1000 OR octet_length(p_changes::text)>16777216 THEN RAISE EXCEPTION 'Commit limit exceeded' USING ERRCODE='PT413';END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest
  OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes) THEN RAISE EXCEPTION 'Invalid commit digest' USING ERRCODE='22023';END IF;
 v_scope:=encode(sha256(convert_to(p_context::text,'UTF8')),'hex');
 SELECT r.* INTO v_recorded FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_ws AND r.grant_id=(p_context->>'grantId')::uuid AND r.authority_hash=v_scope AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF v_recorded.digest<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409';END IF;
  RETURN jsonb_build_object('revision',v_recorded.result_revision);
 END IF;
 PERFORM fountain_cloud.service_data_ready(p_context);PERFORM fountain_cloud.service_changes(p_context,p_changes);
 IF p_context->>'kind'='automation' THEN
  v_job:=fountain_cloud.scheduler_service_ready(p_context);v_stamp:=fountain_cloud.scheduler_stamp(v_job.fixed_now);v_next:=COALESCE(to_jsonb(v_job.next_at),'null'::jsonb);
  SELECT c.value->'data' INTO v_final_run FROM jsonb_array_elements(p_changes) WITH ORDINALITY c(value,ordinal)
   WHERE c.value->>'kind'='automation_run' AND c.value->>'id'=v_job.run_id AND c.value->>'op'='put' ORDER BY c.ordinal DESC LIMIT 1;
  SELECT c.value->'data' INTO v_final_auto FROM jsonb_array_elements(p_changes) WITH ORDINALITY c(value,ordinal)
   WHERE c.value->>'kind'='automation' AND c.value->>'id'=v_job.automation_id AND c.value->>'op'='put' ORDER BY c.ordinal DESC LIMIT 1;
  IF v_final_run IS NULL OR v_final_auto IS NULL OR v_final_run->'id' IS DISTINCT FROM to_jsonb(v_job.run_id) OR v_final_run->'automation_id' IS DISTINCT FROM to_jsonb(v_job.automation_id)
   OR v_final_run->'scheduled_at' IS DISTINCT FROM to_jsonb(v_job.scheduled_at) OR v_final_run->>'status' NOT IN('succeeded','failed') OR jsonb_typeof(v_final_run->'status') IS DISTINCT FROM 'string'
   OR v_final_run->'started_at' IS DISTINCT FROM to_jsonb(v_stamp) OR v_final_run->'finished_at' IS DISTINCT FROM to_jsonb(v_stamp) OR v_final_run->'next_run_at' IS DISTINCT FROM v_next
   OR v_final_auto->'next_run_at' IS DISTINCT FROM v_next OR v_final_auto->'last_run_at' IS DISTINCT FROM to_jsonb(v_stamp) OR v_final_auto->>'last_run_status' IS DISTINCT FROM v_final_run->>'status'
   OR(v_job.next_at IS NULL AND(v_final_auto->'enabled' IS DISTINCT FROM 'false'::jsonb OR v_final_auto->>'schedule_status' IS DISTINCT FROM 'completed'))
   OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='automation_run' AND e.id=v_job.run_id) THEN RAISE EXCEPTION 'SLOT_CHANGED' USING ERRCODE='PT409';END IF;
  -- Provisional done is visible to the source trigger only within THIS TX. An
  -- apply failure rolls this back together with all actions/due/receipt changes.
  UPDATE fountain_cloud.scheduler_jobs j SET state='done',outcome='data_'||(v_final_run->>'status'),finished_at=clock_timestamp() WHERE j.workspace_id=v_ws AND j.id=v_job.id;
 END IF;
 v_revision:=fountain_cloud.store_apply_changes_locked(v_ws,p_expected_revision,p_changes);
 IF p_context->>'kind'='automation' THEN UPDATE fountain_cloud.scheduler_jobs j SET result_revision=v_revision WHERE j.workspace_id=v_ws AND j.id=v_job.id;END IF;
 INSERT INTO fountain_cloud.service_commit_receipts(workspace_id,grant_id,authority_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(v_ws,(p_context->>'grantId')::uuid,v_scope,p_transaction_id,p_digest,p_expected_revision,v_revision);
 RETURN jsonb_build_object('revision',v_revision);
END $$;
-- CREATE OR REPLACE preserves original private ownership/ACL; repeat revocation.
REVOKE ALL ON FUNCTION fountain_cloud.service_data_ready(jsonb),fountain_cloud.service_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_owned(p_registry fountain_cloud.scheduler_registry) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF p_registry.cron_id IS NULL OR NOT EXISTS(SELECT 1 FROM cron.job c WHERE c.jobid=p_registry.cron_id AND c.jobname=p_registry.cron_name AND c.username=p_registry.cron_user AND c.command=p_registry.cron_command AND c.schedule='* * * * *' AND c.database=current_database() AND c.active=p_registry.enabled) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_owned(fountain_cloud.scheduler_registry) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_cleanup(p_registry fountain_cloud.scheduler_registry) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_attempt fountain_cloud.scheduler_attempts;v_cutoff timestamptz:=clock_timestamp()-interval '1 day';
BEGIN
 PERFORM fountain_cloud.scheduler_owned(p_registry);
 FOR v_attempt IN SELECT a.* FROM fountain_cloud.scheduler_attempts a JOIN fountain_cloud.scheduler_jobs j ON j.workspace_id=a.workspace_id AND j.id=a.job_id
  WHERE a.workspace_id=p_registry.workspace_id AND a.ack_until<v_cutoff AND(j.state IN('done','superseded') OR a.generation<j.generation)
  ORDER BY a.ack_until,a.job_id,a.generation LIMIT 32 LOOP
  -- Bind cleanup to THIS expired authority, not all leases of a busy grant.
  -- At most one data commit is accepted per broker attempt; retain the attempt
  -- if corrupt extra receipts exceed this defensive bounded batch.
  DELETE FROM fountain_cloud.service_commit_receipts r WHERE r.ctid IN(SELECT x.ctid FROM fountain_cloud.service_commit_receipts x
   WHERE x.workspace_id=v_attempt.workspace_id AND x.grant_id=v_attempt.grant_id AND x.authority_hash=v_attempt.authority_hash ORDER BY x.created_at,x.transaction_id LIMIT 32);
  IF EXISTS(SELECT 1 FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=v_attempt.workspace_id AND r.grant_id=v_attempt.grant_id AND r.authority_hash=v_attempt.authority_hash) THEN CONTINUE;END IF;
  DELETE FROM fountain_cloud.scheduler_prepare_receipts r WHERE r.workspace_id=v_attempt.workspace_id AND r.attempt_id=v_attempt.id;
  -- UNIQUE(workspace_id,attempt_id) bounds accepted prepare receipts to one.
  DELETE FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=v_attempt.workspace_id AND a.id=v_attempt.id;
  IF v_attempt.lease_id IS NOT NULL THEN DELETE FROM fountain_cloud.service_leases l WHERE l.workspace_id=v_attempt.workspace_id AND l.grant_id=v_attempt.grant_id AND l.id=v_attempt.lease_id AND l.expires_at<v_cutoff;END IF;
 END LOOP;
 DELETE FROM fountain_cloud.scheduler_jobs j WHERE j.ctid IN(
  SELECT x.ctid FROM fountain_cloud.scheduler_jobs x WHERE x.workspace_id=p_registry.workspace_id AND x.state IN('done','superseded') AND x.finished_at<v_cutoff
   AND NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=x.workspace_id AND a.job_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=x.workspace_id AND d.active_job=x.id)
  ORDER BY x.finished_at,x.id LIMIT 32);
 DELETE FROM fountain_cloud.service_grants g WHERE g.ctid IN(
  SELECT x.ctid FROM fountain_cloud.service_grants x WHERE x.workspace_id=p_registry.workspace_id AND x.purpose='automation' AND NOT x.enabled AND x.created_at<v_cutoff
   AND NOT EXISTS(SELECT 1 FROM fountain_cloud.service_leases l WHERE l.workspace_id=x.workspace_id AND l.grant_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM fountain_cloud.service_commit_receipts r WHERE r.workspace_id=x.workspace_id AND r.grant_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=x.workspace_id AND a.grant_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=x.workspace_id AND d.grant_id=x.id)
  ORDER BY x.created_at,x.id LIMIT 32);
 DELETE FROM cron.job_run_details d WHERE d.runid IN(SELECT x.runid FROM cron.job_run_details x WHERE x.jobid=p_registry.cron_id AND x.end_time<clock_timestamp()-interval '7 days' ORDER BY x.end_time,x.runid LIMIT 32);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_cleanup(fountain_cloud.scheduler_registry) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_dispatch(p_workspace_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_registry fountain_cloud.scheduler_registry;v_due fountain_cloud.scheduler_due;v_job fountain_cloud.scheduler_jobs;v_dirty fountain_cloud.scheduler_owner_dirty;
 v_item record;v_budget integer:=32;v_count integer:=0;v_last text;v_now timestamptz;v_minute timestamptz;v_limit integer;
 v_attempt_id uuid;v_raw text;v_hash text;v_net_id bigint;
BEGIN
 PERFORM fountain_cloud.store_lock(p_workspace_id);PERFORM set_config('fountain.workspace_id',p_workspace_id,true);v_now:=clock_timestamp();v_minute:=date_trunc('minute',v_now);
 SELECT r.* INTO v_registry FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=p_workspace_id AND r.enabled FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;PERFORM fountain_cloud.scheduler_owned(v_registry);
 -- Bounded keyset-only automation bootstrap; no unregistered namespace scan.
 IF NOT v_registry.backfill_done THEN
  v_last:=v_registry.backfill_cursor;
  FOR v_item IN SELECT e.id,e.data FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='automation' AND e.id COLLATE "C">v_registry.backfill_cursor COLLATE "C" ORDER BY e.id COLLATE "C" LIMIT 32 LOOP
   PERFORM fountain_cloud.scheduler_sync(p_workspace_id,v_item.id,v_item.data);v_last:=v_item.id;v_budget:=v_budget-1;
  END LOOP;
  UPDATE fountain_cloud.scheduler_registry r SET backfill_cursor=v_last,backfill_done=(v_budget>0) WHERE r.workspace_id=p_workspace_id;
 END IF;
 IF v_budget>0 THEN
  SELECT q.* INTO v_dirty FROM fountain_cloud.scheduler_owner_dirty q WHERE q.workspace_id=p_workspace_id AND q.pending ORDER BY q.touched_at,q.member_id LIMIT 1;
  IF FOUND THEN
   v_last:=v_dirty.cursor_id;
   FOR v_item IN SELECT d.automation_id,e.data FROM fountain_cloud.scheduler_due d LEFT JOIN fountain_private.entities e ON e.workspace_id=d.workspace_id AND e.kind='automation' AND e.id=d.automation_id
    WHERE d.workspace_id=p_workspace_id AND d.author_id=v_dirty.member_id AND d.automation_id COLLATE "C">v_dirty.cursor_id COLLATE "C" ORDER BY d.automation_id COLLATE "C" LIMIT v_budget LOOP
    PERFORM fountain_cloud.scheduler_sync(p_workspace_id,v_item.automation_id,v_item.data);v_last:=v_item.automation_id;
   END LOOP;
   IF EXISTS(SELECT 1 FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=p_workspace_id AND d.author_id=v_dirty.member_id AND d.automation_id COLLATE "C">v_last COLLATE "C") THEN
    UPDATE fountain_cloud.scheduler_owner_dirty q SET cursor_id=v_last,touched_at=v_now WHERE q.workspace_id=p_workspace_id AND q.member_id=v_dirty.member_id AND q.version=v_dirty.version;
   ELSE UPDATE fountain_cloud.scheduler_owner_dirty q SET pending=false,cursor_id='' WHERE q.workspace_id=p_workspace_id AND q.member_id=v_dirty.member_id AND q.version=v_dirty.version;END IF;
  END IF;
 END IF;
 IF v_registry.dispatch_minute IS DISTINCT FROM v_minute THEN v_registry.dispatch_count:=0;END IF;
 v_limit:=4-v_registry.dispatch_count;
 FOR v_due IN SELECT d.* FROM fountain_cloud.scheduler_due d WHERE d.workspace_id=p_workspace_id AND d.enabled AND NOT d.deleted AND d.wake_at<=v_now ORDER BY d.wake_at,d.automation_id LIMIT v_limit FOR UPDATE LOOP
  IF v_due.active_job IS NULL THEN
   INSERT INTO fountain_cloud.scheduler_jobs(workspace_id,id,automation_id,incarnation,definition_version,definition_hash,due_hash,fixed_now,state)
   VALUES(p_workspace_id,gen_random_uuid(),v_due.automation_id,v_due.incarnation,v_due.definition_version,v_due.definition_hash,v_due.due_hash,v_now,'preparing') RETURNING * INTO v_job;
   UPDATE fountain_cloud.scheduler_due d SET active_job=v_job.id WHERE d.workspace_id=p_workspace_id AND d.automation_id=v_due.automation_id;
  ELSE
   SELECT j.* INTO v_job FROM fountain_cloud.scheduler_jobs j WHERE j.workspace_id=p_workspace_id AND j.id=v_due.active_job FOR UPDATE;
   IF v_job.id IS NULL OR v_job.state NOT IN('preparing','ready') THEN CONTINUE;END IF;
   IF EXISTS(SELECT 1 FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=p_workspace_id AND a.job_id=v_job.id AND a.generation=v_job.generation AND a.work_until>v_now) THEN CONTINUE;END IF;
   UPDATE fountain_cloud.service_leases l SET closed=true FROM fountain_cloud.scheduler_attempts a WHERE a.workspace_id=p_workspace_id AND a.job_id=v_job.id AND a.generation=v_job.generation AND l.workspace_id=a.workspace_id AND l.grant_id=a.grant_id AND l.id=a.lease_id;
  END IF;
  IF v_job.generation>=9007199254740991 THEN RAISE EXCEPTION 'Scheduler generation limit' USING ERRCODE='PT413';END IF;
  v_job.generation:=v_job.generation+1;UPDATE fountain_cloud.scheduler_jobs j SET generation=v_job.generation WHERE j.workspace_id=p_workspace_id AND j.id=v_job.id;
  v_attempt_id:=gen_random_uuid();v_raw:=rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');v_hash:=encode(sha256(convert_to(v_raw,'UTF8')),'hex');
  INSERT INTO fountain_cloud.scheduler_attempts(workspace_id,job_id,generation,id,ticket_hash,work_until,ack_until)
  VALUES(p_workspace_id,v_job.id,v_job.generation,v_attempt_id,v_hash,v_now+interval '90 seconds',v_now+interval '150 seconds');
  UPDATE fountain_cloud.scheduler_due d SET wake_at=v_now+interval '90 seconds' WHERE d.workspace_id=p_workspace_id AND d.automation_id=v_job.automation_id;
  -- The only raw-token value is the transient pg_net HTTP request body. Its
  -- UNLOGGED queue/response is not authoritative and never clears this job.
  v_net_id:=net.http_post(url:=v_registry.worker_url,body:=jsonb_build_object('ticket',v_raw),params:='{}'::jsonb,headers:=jsonb_build_object('Content-Type','application/json'),timeout_milliseconds:=120000);
  UPDATE fountain_cloud.scheduler_attempts a SET net_request_id=v_net_id WHERE a.workspace_id=p_workspace_id AND a.id=v_attempt_id;v_count:=v_count+1;
 END LOOP;
 UPDATE fountain_cloud.scheduler_registry r SET dispatch_minute=v_minute,dispatch_count=v_registry.dispatch_count+v_count WHERE r.workspace_id=p_workspace_id;
 PERFORM fountain_cloud.scheduler_cleanup(v_registry);
END $$;
ALTER FUNCTION fountain_cloud.scheduler_dispatch(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_dispatch(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.scheduler_install(p_workspace_id text,p_worker_url text,p_enabled boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_registry fountain_cloud.scheduler_registry;v_name text;v_command text;v_user text:=current_user;v_id bigint;
BEGIN
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR p_enabled IS NULL OR p_worker_url IS NULL
  OR p_worker_url!~'^https://[a-z0-9]{20}(\.supabase\.co/functions/v1/fountain-worker|\.functions\.supabase\.co/fountain-worker)$' THEN RAISE EXCEPTION 'Invalid scheduler installation' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);
 v_name:='fountain-scheduler-'||substr(encode(sha256(convert_to(p_workspace_id,'UTF8')),'hex'),1,32);
 v_command:='SELECT fountain_cloud.scheduler_dispatch('||quote_literal(p_workspace_id)||');';
 SELECT r.* INTO v_registry FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=p_workspace_id FOR UPDATE;
 IF FOUND THEN
  IF v_registry.cron_id IS NOT NULL THEN PERFORM fountain_cloud.scheduler_owned(v_registry);ELSE IF EXISTS(SELECT 1 FROM cron.job c WHERE c.jobname=v_registry.cron_name) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;END IF;
  IF v_registry.cron_name<>v_name OR v_registry.cron_user<>v_user OR v_registry.cron_command<>v_command THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM cron.job c WHERE c.jobname=v_name) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
  INSERT INTO fountain_cloud.scheduler_registry(workspace_id,enabled,worker_url,cron_name,cron_user,cron_command) VALUES(p_workspace_id,false,p_worker_url,v_name,v_user,v_command);
 END IF;
 IF p_enabled THEN
  IF v_registry.cron_id IS NULL THEN v_id:=cron.schedule(v_name,'* * * * *',v_command);ELSE v_id:=v_registry.cron_id;PERFORM cron.alter_job(job_id:=v_id,active:=true);END IF;
 ELSE v_id:=v_registry.cron_id;IF v_id IS NOT NULL THEN PERFORM cron.alter_job(job_id:=v_id,active:=false);END IF;END IF;
 UPDATE fountain_cloud.scheduler_registry r SET enabled=p_enabled,worker_url=p_worker_url,cron_id=v_id,
  backfill_cursor=CASE WHEN p_enabled AND NOT COALESCE(v_registry.enabled,false) THEN '' ELSE r.backfill_cursor END,
  backfill_done=CASE WHEN p_enabled AND NOT COALESCE(v_registry.enabled,false) THEN false ELSE r.backfill_done END WHERE r.workspace_id=p_workspace_id;
 RETURN jsonb_build_object('enabled',p_enabled,'job_id',v_id);
END $$;
ALTER FUNCTION fountain_cloud.scheduler_install(text,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_install(text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION fountain_cloud.scheduler_remove(p_workspace_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_registry fountain_cloud.scheduler_registry;
BEGIN
 PERFORM fountain_cloud.store_lock(p_workspace_id);SELECT r.* INTO v_registry FROM fountain_cloud.scheduler_registry r WHERE r.workspace_id=p_workspace_id FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 IF v_registry.cron_id IS NOT NULL THEN PERFORM fountain_cloud.scheduler_owned(v_registry);PERFORM cron.unschedule(v_registry.cron_id);
 ELSIF EXISTS(SELECT 1 FROM cron.job c WHERE c.jobname=v_registry.cron_name) THEN RAISE EXCEPTION 'CRON_OWNERSHIP_CONFLICT' USING ERRCODE='PT409';END IF;
 UPDATE fountain_cloud.scheduler_registry r SET enabled=false,cron_id=NULL WHERE r.workspace_id=p_workspace_id;
END $$;
ALTER FUNCTION fountain_cloud.scheduler_remove(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scheduler_remove(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fountain_cloud_scheduler_open(p_ticket_hash text,p_invocation_id uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.scheduler_open(p_ticket_hash,p_invocation_id) $$;
CREATE FUNCTION public.fountain_cloud_scheduler_prepare(p_ticket_hash text,p_invocation_id uuid,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_plan jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.scheduler_prepare(p_ticket_hash,p_invocation_id,p_expected_revision,p_transaction_id,p_digest,p_canonical,p_plan) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_scheduler_open(text,uuid),public.fountain_cloud_scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_scheduler_open(text,uuid),public.fountain_cloud_scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb) TO service_role;

ALTER FUNCTION public.fountain_cloud_scheduler_open(text,uuid) OWNER TO postgres;
ALTER FUNCTION public.fountain_cloud_scheduler_prepare(text,uuid,bigint,uuid,text,text,jsonb) OWNER TO postgres;
