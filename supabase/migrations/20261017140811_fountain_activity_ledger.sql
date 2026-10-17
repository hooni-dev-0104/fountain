-- Canonical server activity, not a legal hold or historical reconstruction.
-- No source data migration, runtime initialization, grants or sessions are issued.
CREATE TABLE fountain_private.activity_ledgers(workspace_id text NOT NULL,id text NOT NULL,started_at text NOT NULL,origin text NOT NULL,capture_scope text NOT NULL,PRIMARY KEY(workspace_id,id));
ALTER TABLE fountain_private.activity_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.activity_ledgers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.activity_ledgers FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT SELECT ON fountain_private.activity_ledgers TO fountain_backend;
CREATE POLICY activity_ledgers_workspace ON fountain_private.activity_ledgers FOR ALL TO fountain_backend USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true))) WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
CREATE TABLE fountain_private.activity_memberships(workspace_id text NOT NULL,id text NOT NULL,ledger_id text NOT NULL,member_id text NOT NULL,opened_at text NOT NULL,closed_at text,close_reason text,PRIMARY KEY(workspace_id,id));
ALTER TABLE fountain_private.activity_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.activity_memberships FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.activity_memberships FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT SELECT ON fountain_private.activity_memberships TO fountain_backend;
CREATE POLICY activity_memberships_workspace ON fountain_private.activity_memberships FOR ALL TO fountain_backend USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true))) WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
CREATE TABLE fountain_private.activity_accounts(workspace_id text NOT NULL,id text NOT NULL,membership_id text NOT NULL,auth_kind text NOT NULL,opened_at text NOT NULL,closed_at text,close_reason text,PRIMARY KEY(workspace_id,id));
ALTER TABLE fountain_private.activity_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.activity_accounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.activity_accounts FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT SELECT ON fountain_private.activity_accounts TO fountain_backend;
CREATE POLICY activity_accounts_workspace ON fountain_private.activity_accounts FOR ALL TO fountain_backend USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true))) WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
CREATE TABLE fountain_private.activity_events(workspace_id text NOT NULL,ledger_id text NOT NULL,sequence bigint NOT NULL,event_id text NOT NULL,command_id text NOT NULL,command_ordinal bigint NOT NULL,actor_member_id text,membership_id text,account_id text,origin text NOT NULL,action text NOT NULL,resource_kind text NOT NULL,resource_id text NOT NULL,resource_generation text NOT NULL,occurred_at text NOT NULL,source_encoding text NOT NULL,source_bytes bigint NOT NULL,source_sha256 text NOT NULL,PRIMARY KEY(workspace_id,ledger_id,sequence));
ALTER TABLE fountain_private.activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.activity_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.activity_events FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT SELECT ON fountain_private.activity_events TO fountain_backend;
CREATE POLICY activity_events_workspace ON fountain_private.activity_events FOR ALL TO fountain_backend USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true))) WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
CREATE TABLE fountain_private.activity_runtime(workspace_id text NOT NULL,singleton integer NOT NULL CHECK(singleton=1),ledger_id text NOT NULL,next_sequence bigint NOT NULL CHECK(next_sequence BETWEEN 1 AND 9007199254740991),activity_revision bigint NOT NULL CHECK(activity_revision BETWEEN 0 AND 9007199254740991),PRIMARY KEY(workspace_id,singleton));
ALTER TABLE fountain_private.activity_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.activity_runtime FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.activity_runtime FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT SELECT ON fountain_private.activity_runtime TO fountain_backend;
CREATE POLICY activity_runtime_workspace ON fountain_private.activity_runtime FOR ALL TO fountain_backend USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true))) WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
CREATE TABLE fountain_private.activity_current_members(workspace_id text NOT NULL,member_id text NOT NULL,membership_id text NOT NULL,PRIMARY KEY(workspace_id,member_id));
ALTER TABLE fountain_private.activity_current_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.activity_current_members FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.activity_current_members FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT SELECT ON fountain_private.activity_current_members TO fountain_backend;
CREATE POLICY activity_current_members_workspace ON fountain_private.activity_current_members FOR ALL TO fountain_backend USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true))) WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
CREATE TABLE fountain_private.activity_current_accounts(workspace_id text NOT NULL,member_id text NOT NULL,auth_kind text NOT NULL,account_id text NOT NULL,PRIMARY KEY(workspace_id,member_id,auth_kind));
ALTER TABLE fountain_private.activity_current_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.activity_current_accounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.activity_current_accounts FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT SELECT ON fountain_private.activity_current_accounts TO fountain_backend;
CREATE POLICY activity_current_accounts_workspace ON fountain_private.activity_current_accounts FOR ALL TO fountain_backend USING(workspace_id=(SELECT current_setting('fountain.workspace_id',true))) WITH CHECK(workspace_id=(SELECT current_setting('fountain.workspace_id',true)));
ALTER TABLE fountain_private.activity_memberships ADD FOREIGN KEY(workspace_id,ledger_id) REFERENCES fountain_private.activity_ledgers(workspace_id,id);
ALTER TABLE fountain_private.activity_accounts ADD FOREIGN KEY(workspace_id,membership_id) REFERENCES fountain_private.activity_memberships(workspace_id,id);
ALTER TABLE fountain_private.activity_events ADD FOREIGN KEY(workspace_id,ledger_id) REFERENCES fountain_private.activity_ledgers(workspace_id,id), ADD FOREIGN KEY(workspace_id,membership_id) REFERENCES fountain_private.activity_memberships(workspace_id,id), ADD FOREIGN KEY(workspace_id,account_id) REFERENCES fountain_private.activity_accounts(workspace_id,id),ADD UNIQUE(workspace_id,event_id),ADD UNIQUE(workspace_id,ledger_id,command_id,command_ordinal);
ALTER TABLE fountain_private.activity_runtime ADD FOREIGN KEY(workspace_id,ledger_id) REFERENCES fountain_private.activity_ledgers(workspace_id,id);
ALTER TABLE fountain_private.activity_current_members ADD FOREIGN KEY(workspace_id,membership_id) REFERENCES fountain_private.activity_memberships(workspace_id,id);
ALTER TABLE fountain_private.activity_current_accounts ADD FOREIGN KEY(workspace_id,account_id) REFERENCES fountain_private.activity_accounts(workspace_id,id);
CREATE INDEX activity_events_resource ON fountain_private.activity_events(workspace_id,resource_kind,resource_id,resource_generation,ledger_id,sequence);
CREATE INDEX activity_events_actor ON fountain_private.activity_events(workspace_id,membership_id,account_id,ledger_id,sequence);

CREATE FUNCTION fountain_private.activity_cjson(p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE kind text:=jsonb_typeof(p_value);answer text;raw text;digits text;coefficient text;exponent integer;negative boolean;
BEGIN
 IF p_value IS NULL THEN RAISE EXCEPTION 'Canonical source must be JSON' USING ERRCODE='22023';END IF;
 IF kind IN('null','boolean','string') THEN RETURN p_value::text;END IF;
 IF kind='number' THEN
  raw:=p_value#>>'{}';IF raw::numeric=0 THEN RETURN '0';END IF;
  negative:=left(raw,1)='-';IF negative THEN raw:=substring(raw,2);END IF;
  exponent:=-length(split_part(raw,'.',2));digits:=ltrim(replace(raw,'.',''),'0');coefficient:=rtrim(digits,'0');exponent:=exponent+length(digits)-length(coefficient);
  RETURN CASE WHEN negative THEN '-' ELSE '' END||coefficient||'e'||exponent::text;
 ELSIF kind='array' THEN
  SELECT '['||COALESCE(string_agg(fountain_private.activity_cjson(x.value),',' ORDER BY x.ordinal),'')||']' INTO answer FROM jsonb_array_elements(p_value) WITH ORDINALITY x(value,ordinal);RETURN answer;
 ELSIF kind='object' THEN
  SELECT '{'||COALESCE(string_agg(to_jsonb(x.key)::text||':'||fountain_private.activity_cjson(x.value),',' ORDER BY x.key COLLATE "C"),'')||'}' INTO answer FROM jsonb_each(p_value) x;RETURN answer;
 END IF;
 RAISE EXCEPTION 'Unsupported canonical source type' USING ERRCODE='22023';
END $f$;
CREATE FUNCTION fountain_private.activity_now() RETURNS text
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'Z'
$f$;
CREATE FUNCTION fountain_private.activity_lock(p_workspace text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_workspace IS NULL OR length(p_workspace) NOT BETWEEN 1 AND 160 OR current_setting('fountain.workspace_id',true) IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Invalid activity workspace' USING ERRCODE='22023';END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Activity requires read committed isolation' USING ERRCODE='PT409';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace);
END $f$;
CREATE FUNCTION fountain_private.activity_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE ws text;
BEGIN
 ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF current_user<>'postgres' OR current_setting('fountain.activity_write',true) IS DISTINCT FROM ws THEN RAISE EXCEPTION 'Private activity kernel required' USING ERRCODE='PT403';END IF;
 IF TG_OP='DELETE' AND TG_TABLE_NAME NOT IN('activity_current_members','activity_current_accounts') THEN RAISE EXCEPTION 'Activity history cannot be deleted' USING ERRCODE='PT403';END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME IN('activity_events','activity_ledgers') THEN RAISE EXCEPTION 'Activity history is immutable' USING ERRCODE='PT403';END IF;
  IF TG_TABLE_NAME IN('activity_memberships','activity_accounts') THEN
   IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR NEW.close_reason IS NULL OR to_jsonb(NEW)-ARRAY['closed_at','close_reason'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['closed_at','close_reason'] THEN RAISE EXCEPTION 'Activity episode closure is one way' USING ERRCODE='PT403';END IF;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN RAISE EXCEPTION 'Activity namespace is immutable' USING ERRCODE='PT403';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $f$;
CREATE FUNCTION fountain_private.activity_touch(p_workspace text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 UPDATE fountain_private.activity_runtime SET activity_revision=activity_revision+1 WHERE workspace_id=p_workspace AND singleton=1 AND activity_revision<9007199254740991;
 IF NOT FOUND THEN RAISE EXCEPTION 'Activity revision is unavailable or exhausted' USING ERRCODE='PT413';END IF;
END $f$;

CREATE FUNCTION fountain_private.activity_close_account(p_workspace text,p_member text,p_kind text,p_reason text,p_at text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE target text;
BEGIN
 SELECT account_id INTO target FROM fountain_private.activity_current_accounts WHERE workspace_id=p_workspace AND member_id=p_member AND auth_kind=p_kind;
 IF NOT FOUND THEN RETURN;END IF;
 UPDATE fountain_private.activity_accounts SET closed_at=p_at,close_reason=p_reason WHERE workspace_id=p_workspace AND id=target AND closed_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Activity account binding is corrupt' USING ERRCODE='PT503';END IF;
 PERFORM fountain_private.activity_touch(p_workspace);
 DELETE FROM fountain_private.activity_current_accounts WHERE workspace_id=p_workspace AND member_id=p_member AND auth_kind=p_kind;
END $f$;
CREATE FUNCTION fountain_private.activity_close_member(p_workspace text,p_member text,p_reason text,p_at text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE target text;r record;
BEGIN
 SELECT membership_id INTO target FROM fountain_private.activity_current_members WHERE workspace_id=p_workspace AND member_id=p_member;
 IF NOT FOUND THEN RETURN;END IF;
 FOR r IN SELECT auth_kind FROM fountain_private.activity_current_accounts WHERE workspace_id=p_workspace AND member_id=p_member ORDER BY auth_kind COLLATE "C" LOOP
  PERFORM fountain_private.activity_close_account(p_workspace,p_member,r.auth_kind,'membership_closed',p_at);
 END LOOP;
 UPDATE fountain_private.activity_memberships SET closed_at=p_at,close_reason=p_reason WHERE workspace_id=p_workspace AND id=target AND closed_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Activity member binding is corrupt' USING ERRCODE='PT503';END IF;
 PERFORM fountain_private.activity_touch(p_workspace);
 DELETE FROM fountain_private.activity_current_members WHERE workspace_id=p_workspace AND member_id=p_member;
END $f$;
CREATE FUNCTION fountain_private.activity_ensure_member(p_workspace text,p_member text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE target text;ledger text;
BEGIN
 IF NOT fountain_private.retention_id(p_member) OR NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='member' AND e.id=p_member AND e.data->>'id'=e.id AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND e.data->>'role' IN('owner','admin','member','guest')) THEN RAISE EXCEPTION 'Current activity member is unavailable' USING ERRCODE='PT401';END IF;
 SELECT c.membership_id INTO target FROM fountain_private.activity_current_members c JOIN fountain_private.activity_memberships m ON m.workspace_id=c.workspace_id AND m.id=c.membership_id JOIN fountain_private.activity_runtime rt ON rt.workspace_id=c.workspace_id AND rt.singleton=1 AND rt.ledger_id=m.ledger_id WHERE c.workspace_id=p_workspace AND c.member_id=p_member AND m.member_id=p_member AND m.closed_at IS NULL;
 IF FOUND THEN RETURN target;END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=p_workspace AND member_id=p_member) OR EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=p_workspace AND member_id=p_member AND closed_at IS NULL) THEN RAISE EXCEPTION 'Activity membership binding is corrupt' USING ERRCODE='PT503';END IF;
 SELECT ledger_id INTO ledger FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace AND singleton=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Activity runtime is unavailable' USING ERRCODE='PT503';END IF;
 target:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.activity_memberships VALUES(p_workspace,target,ledger,p_member,fountain_private.activity_now(),NULL,NULL);
 INSERT INTO fountain_private.activity_current_members VALUES(p_workspace,p_member,target);
 PERFORM fountain_private.activity_touch(p_workspace);RETURN target;
END $f$;
CREATE FUNCTION fountain_private.activity_ensure_account(p_workspace text,p_member text,p_kind text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE membership text;target text;
BEGIN
 IF p_kind NOT IN('password','supabase') OR p_kind IS NULL THEN RAISE EXCEPTION 'Invalid activity account kind' USING ERRCODE='22023';END IF;
 membership:=fountain_private.activity_ensure_member(p_workspace,p_member);
 IF p_kind='password' AND NOT EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='credential' AND e.id=p_member)
  OR p_kind='supabase' AND NOT EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace AND m.member_id=p_member) THEN RAISE EXCEPTION 'Current activity account is unavailable' USING ERRCODE='PT401';END IF;
 SELECT c.account_id INTO target FROM fountain_private.activity_current_accounts c JOIN fountain_private.activity_accounts a ON a.workspace_id=c.workspace_id AND a.id=c.account_id WHERE c.workspace_id=p_workspace AND c.member_id=p_member AND c.auth_kind=p_kind AND a.auth_kind=p_kind AND a.membership_id=membership AND a.closed_at IS NULL;
 IF FOUND THEN RETURN target;END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=p_workspace AND member_id=p_member AND auth_kind=p_kind) OR EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=p_workspace AND membership_id=membership AND auth_kind=p_kind AND closed_at IS NULL) THEN RAISE EXCEPTION 'Activity account binding is corrupt' USING ERRCODE='PT503';END IF;
 target:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.activity_accounts VALUES(p_workspace,target,membership,p_kind,fountain_private.activity_now(),NULL,NULL);
 INSERT INTO fountain_private.activity_current_accounts VALUES(p_workspace,p_member,p_kind,target);
 PERFORM fountain_private.activity_touch(p_workspace);RETURN target;
END $f$;
CREATE FUNCTION fountain_private.activity_initialize(p_workspace text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE target text;previous text;r record;
BEGIN
 PERFORM fountain_private.activity_lock(p_workspace);
 SELECT rt.ledger_id INTO target FROM fountain_private.activity_runtime rt JOIN fountain_private.activity_ledgers l ON l.workspace_id=rt.workspace_id AND l.id=rt.ledger_id WHERE rt.workspace_id=p_workspace AND rt.singleton=1 AND rt.next_sequence BETWEEN 1 AND 9007199254740991 AND rt.activity_revision BETWEEN 1 AND 9007199254740991;
 IF FOUND THEN RETURN target;END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_ledgers WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=p_workspace) THEN RAISE EXCEPTION 'Activity history requires explicit trusted restoration or repair' USING ERRCODE='PT503';END IF;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',p_workspace,true);
 target:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.activity_ledgers VALUES(p_workspace,target,fountain_private.activity_now(),'installation','canonical-server-v1');
 INSERT INTO fountain_private.activity_runtime VALUES(p_workspace,1,target,1,1);
 FOR r IN SELECT e.id FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='member' AND e.data->>'id'=e.id AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND e.data->>'role' IN('owner','admin','member','guest') ORDER BY e.id COLLATE "C" LOOP
  PERFORM fountain_private.activity_ensure_member(p_workspace,r.id);
  IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='credential' AND e.id=r.id) THEN PERFORM fountain_private.activity_ensure_account(p_workspace,r.id,'password');END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace AND m.member_id=r.id) THEN PERFORM fountain_private.activity_ensure_account(p_workspace,r.id,'supabase');END IF;
 END LOOP;
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);RETURN target;
END $f$;
CREATE FUNCTION fountain_private.activity_lifecycle_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;member text;before_active boolean;after_active boolean;previous text;kind text;stamp text;
BEGIN
 ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_runtime WHERE workspace_id=ws AND singleton=1) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||ws,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN RAISE EXCEPTION 'Activity identity transition is busy' USING ERRCODE='PT409';END IF;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',ws,true);stamp:=fountain_private.activity_now();
 IF TG_TABLE_NAME='entities' THEN
  kind:=CASE WHEN TG_OP='DELETE' THEN OLD.kind ELSE NEW.kind END;member:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF kind='member' THEN
   before_active:=TG_OP<>'INSERT' AND COALESCE(OLD.data->'active','true'::jsonb)='true'::jsonb;
   after_active:=TG_OP<>'DELETE' AND COALESCE(NEW.data->'active','true'::jsonb)='true'::jsonb;
   IF NOT after_active THEN PERFORM fountain_private.activity_close_member(ws,member,CASE WHEN TG_OP='DELETE' THEN 'deleted' ELSE 'inactive' END,stamp);
   ELSIF NOT before_active THEN
    PERFORM fountain_private.activity_ensure_member(ws,member);
    IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='credential' AND e.id=member) THEN PERFORM fountain_private.activity_ensure_account(ws,member,'password');END IF;
    IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=ws AND m.member_id=member) THEN PERFORM fountain_private.activity_ensure_account(ws,member,'supabase');END IF;
   END IF;
  ELSIF kind='credential' THEN
   IF TG_OP='DELETE' THEN PERFORM fountain_private.activity_close_account(ws,member,'password','credential_removed',stamp);
   ELSIF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id=member) THEN PERFORM fountain_private.activity_ensure_account(ws,member,'password');END IF;
  END IF;
 ELSIF TG_TABLE_NAME='identity_mapping' THEN
  IF TG_OP IN('UPDATE','DELETE') AND(TG_OP='DELETE' OR (OLD.workspace_id,OLD.member_id,OLD.auth_user_id) IS DISTINCT FROM(NEW.workspace_id,NEW.member_id,NEW.auth_user_id)) THEN PERFORM fountain_private.activity_close_account(OLD.workspace_id,OLD.member_id,'supabase','identity_changed',stamp);END IF;
  IF TG_OP IN('INSERT','UPDATE') AND(TG_OP='INSERT' OR (OLD.workspace_id,OLD.member_id,OLD.auth_user_id) IS DISTINCT FROM(NEW.workspace_id,NEW.member_id,NEW.auth_user_id)) AND EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=NEW.workspace_id AND member_id=NEW.member_id) THEN PERFORM fountain_private.activity_ensure_account(NEW.workspace_id,NEW.member_id,'supabase');END IF;
 END IF;
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $f$;

CREATE FUNCTION fountain_private.activity_backup_fence(p_workspace text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE state fountain_private.activity_runtime;wire jsonb;
BEGIN
 PERFORM fountain_private.activity_lock(p_workspace);
 SELECT * INTO state FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace AND singleton=1;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM fountain_private.activity_ledgers WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=p_workspace) THEN RAISE EXCEPTION 'Activity history is not activated' USING ERRCODE='PT503';END IF;
  wire:=jsonb_build_array(NULL,0,0);
 ELSE
  IF state.next_sequence NOT BETWEEN 1 AND 9007199254740991 OR state.activity_revision NOT BETWEEN 1 AND 9007199254740991 OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_ledgers WHERE workspace_id=p_workspace AND id=state.ledger_id) THEN RAISE EXCEPTION 'Activity runtime is corrupt' USING ERRCODE='PT503';END IF;
  wire:=jsonb_build_array(state.ledger_id,state.next_sequence,state.activity_revision);
 END IF;
 RETURN jsonb_build_object('version',1,'sha256',encode(sha256(convert_to(fountain_private.activity_cjson(wire),'UTF8')),'hex'));
END $f$;
CREATE FUNCTION fountain_private.activity_emit(p_workspace text,p_kind text,p_id text,p_generation text,p_source jsonb,p_action text,p_command text,p_ordinal bigint,p_actor jsonb,p_origin text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE ledger text;actor_id text;membership text;account text;auth_kind text;origin text:=p_origin;encoded text;size_bytes bigint;digest text;seq bigint;event_id text;previous fountain_private.activity_events;result jsonb;
BEGIN
 ledger:=fountain_private.activity_initialize(p_workspace);
 IF p_kind NOT IN('page','database','row') OR NOT fountain_private.retention_id(p_id) OR p_generation IS NULL OR p_generation!~'^[a-f0-9]{32}$' OR p_command IS NULL OR p_command!~'^[a-f0-9]{32}$' OR p_ordinal IS NULL OR p_ordinal NOT BETWEEN 0 AND 9007199254740991 OR p_action IS NULL OR p_action NOT IN('created','edited','managed','deleted','viewed') OR jsonb_typeof(p_source) IS DISTINCT FROM 'object' OR jsonb_typeof(p_source->'id') IS DISTINCT FROM 'string' OR p_source->>'id' IS DISTINCT FROM p_id OR p_origin IS NULL OR p_origin NOT IN('human','automation','import','public_form','system','unknown') THEN RAISE EXCEPTION 'Invalid activity event source' USING ERRCODE='22023';END IF;
 IF p_actor IS NOT NULL AND p_actor<>'null'::jsonb THEN
  IF jsonb_typeof(p_actor) IS DISTINCT FROM 'object' OR NOT(p_actor ?& ARRAY['member_id','auth_kind']) OR p_actor-ARRAY['member_id','auth_kind']<>'{}'::jsonb OR jsonb_typeof(p_actor->'member_id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_actor->'auth_kind') IS DISTINCT FROM 'string' OR p_actor->>'auth_kind' NOT IN('local','password','supabase','service') THEN RAISE EXCEPTION 'Invalid trusted activity actor' USING ERRCODE='22023';END IF;
  actor_id:=p_actor->>'member_id';auth_kind:=p_actor->>'auth_kind';membership:=fountain_private.activity_ensure_member(p_workspace,actor_id);
  IF auth_kind IN('password','supabase') THEN account:=fountain_private.activity_ensure_account(p_workspace,actor_id,auth_kind);
  ELSIF auth_kind='service' AND origin NOT IN('automation','system','public_form') THEN RAISE EXCEPTION 'Service activity requires an explicit service origin' USING ERRCODE='22023';END IF;
 ELSE
  IF origin='human' THEN origin:='unknown';END IF;
 END IF;
 encoded:=fountain_private.activity_cjson(p_source);size_bytes:=octet_length(encoded);digest:=encode(sha256(convert_to(encoded,'UTF8')),'hex');
 SELECT * INTO previous FROM fountain_private.activity_events e WHERE e.workspace_id=p_workspace AND e.ledger_id=ledger AND e.command_id=p_command AND e.command_ordinal=p_ordinal;
 IF FOUND THEN
  IF (previous.actor_member_id,previous.membership_id,previous.account_id,previous.origin,previous.action,previous.resource_kind,previous.resource_id,previous.resource_generation,previous.source_bytes,previous.source_sha256) IS DISTINCT FROM (actor_id,membership,account,origin,p_action,p_kind,p_id,p_generation,size_bytes,digest) THEN RAISE EXCEPTION 'Activity command reused with another payload' USING ERRCODE='PT409';END IF;
  RETURN to_jsonb(previous)-'workspace_id';
 END IF;
 SELECT next_sequence INTO seq FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace AND singleton=1;
 IF seq>=9007199254740991 THEN RAISE EXCEPTION 'Activity sequence exhausted' USING ERRCODE='PT413';END IF;
 event_id:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.activity_events VALUES(p_workspace,ledger,seq,event_id,p_command,p_ordinal,actor_id,membership,account,origin,p_action,p_kind,p_id,p_generation,fountain_private.activity_now(),'fountain-cjson-v1',size_bytes,digest);
 UPDATE fountain_private.activity_runtime SET next_sequence=seq+1 WHERE workspace_id=p_workspace AND singleton=1;
 PERFORM fountain_private.activity_touch(p_workspace);
 SELECT to_jsonb(e)-'workspace_id' INTO result FROM fountain_private.activity_events e WHERE e.workspace_id=p_workspace AND e.ledger_id=ledger AND e.sequence=seq;RETURN result;
END $f$;
CREATE FUNCTION fountain_private.activity_capture(p_workspace text,p_kind text,p_id text,p_before jsonb,p_after jsonb,p_generation text,p_command text,p_ordinal bigint,p_actor jsonb DEFAULT NULL,p_origin text DEFAULT 'unknown') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE action text;source jsonb;previous text;authored text[];field text;edited boolean:=false;result jsonb;actual jsonb;generation text;
BEGIN
 PERFORM fountain_private.activity_lock(p_workspace);
 IF p_kind NOT IN('page','database','row') THEN RETURN NULL;END IF;
 IF p_before IS NULL AND p_after IS NULL THEN RETURN NULL;END IF;
 IF p_after IS NOT NULL THEN
  SELECT e.data,d.generation INTO actual,generation FROM fountain_private.entities e JOIN fountain_private.content_provenance d ON d.workspace_id=e.workspace_id AND d.kind=e.kind AND d.id=e.id WHERE e.workspace_id=p_workspace AND e.kind=p_kind AND e.id=p_id;
  IF NOT FOUND OR actual IS DISTINCT FROM p_after OR generation IS DISTINCT FROM p_generation THEN RAISE EXCEPTION 'Activity source or final generation changed' USING ERRCODE='PT409';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=p_workspace AND kind=p_kind AND id=p_id) THEN RAISE EXCEPTION 'Deleted activity source still exists' USING ERRCODE='PT409';END IF;
 END IF;
 IF p_before IS NULL THEN action:='created';source:=p_after;
 ELSIF p_after IS NULL THEN action:='deleted';source:=p_before;
 ELSE
  IF p_before-ARRAY['id','created_at','updated_at','revision'] IS NOT DISTINCT FROM p_after-ARRAY['id','created_at','updated_at','revision'] THEN RETURN NULL;END IF;
  authored:=CASE p_kind WHEN 'page' THEN ARRAY['title','blocks','icon','cover'] WHEN 'database' THEN ARRAY['name','title','description','properties','icon','cover'] ELSE ARRAY['properties','icon','cover'] END;
  FOREACH field IN ARRAY authored LOOP IF p_before->field IS DISTINCT FROM p_after->field THEN edited:=true;END IF;END LOOP;
  action:=CASE WHEN edited THEN 'edited' ELSE 'managed' END;source:=p_after;
 END IF;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',p_workspace,true);
 result:=fountain_private.activity_emit(p_workspace,p_kind,p_id,p_generation,source,action,p_command,p_ordinal,p_actor,p_origin);
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);RETURN result;
END $f$;
CREATE FUNCTION fountain_private.activity_view(p_workspace text,p_kind text,p_id text,p_command text,p_actor jsonb,p_origin text DEFAULT 'human') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE source jsonb;generation text;previous text;result jsonb;
BEGIN
 PERFORM fountain_private.activity_lock(p_workspace);
 SELECT e.data,p.generation INTO source,generation FROM fountain_private.entities e JOIN fountain_private.content_provenance p ON p.workspace_id=e.workspace_id AND p.kind=e.kind AND p.id=e.id WHERE e.workspace_id=p_workspace AND e.kind=p_kind AND e.id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Activity view source is unavailable' USING ERRCODE='PT404';END IF;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',p_workspace,true);
 result:=fountain_private.activity_emit(p_workspace,p_kind,p_id,generation,source,'viewed',p_command,0,p_actor,p_origin);
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);RETURN result;
END $f$;

CREATE OR REPLACE FUNCTION fountain_cloud.store_apply_changes_locked(p_workspace_id text,p_expected_revision bigint,p_changes jsonb,p_activity_actor jsonb,p_activity_command text,p_allow_activity_view boolean) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text:=p_workspace_id;v_revision bigint;v_change jsonb;v_previous fountain_private.entities;
 v_found_previous boolean;v_affected bigint;v_data jsonb;v_change_kind text;v_change_id text;v_meta_key text;v_steps bigint:=0;v_owner_mutated boolean:=false;v_origin jsonb;v_parent_actor jsonb;v_previous_actor text;v_activity_generation text;v_activity_ordinal bigint:=0;v_activity_previous jsonb;v_activity_origin text;v_view_member jsonb;v_view_access jsonb;
BEGIN
 v_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
 IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF p_activity_command IS NULL OR p_activity_command!~'^[a-f0-9]{32}$' OR p_allow_activity_view IS NULL THEN RAISE EXCEPTION 'Invalid canonical activity command' USING ERRCODE='22023';END IF;
 PERFORM fountain_private.activity_initialize(v_ws);
 PERFORM fountain_cloud.member_deprovision_preflight(p_workspace_id,p_changes);
 FOR v_change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  v_activity_ordinal:=v_activity_ordinal+1;
  IF jsonb_typeof(v_change) IS DISTINCT FROM 'object' OR jsonb_typeof(v_change->'op') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023';
  END IF;
  IF v_change->>'op' IN ('put','delete') THEN
   v_change_kind:=v_change->>'kind';v_change_id:=v_change->>'id';
   IF jsonb_typeof(v_change->'kind') IS DISTINCT FROM 'string' OR v_change_kind !~ '^[a-z][a-z0-9_]{0,63}$' OR v_change_kind IN ('credential','session')
    OR jsonb_typeof(v_change->'id') IS DISTINCT FROM 'string' OR length(v_change_id) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023';
   END IF;
   IF v_change_kind='member' AND EXISTS(SELECT 1 FROM fountain_private.entities e
     WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id=v_change_id AND e.data->>'role'='owner') THEN
    v_owner_mutated:=true;
   END IF;
   IF v_change->>'op'='put' THEN
    IF NOT(v_change ?& ARRAY['op','kind','id','data','previousCreatedAt']) OR v_change-ARRAY['op','kind','id','data','previousCreatedAt','origin']<>'{}'::jsonb
     OR jsonb_typeof(v_change->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    v_data:=v_change->'data';
    IF btrim(v_change_id)='' OR v_data->>'id' IS DISTINCT FROM v_change_id OR jsonb_typeof(v_data->'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_data->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v_data->'updated_at') IS DISTINCT FROM 'string'
     OR length(v_data->>'created_at') NOT BETWEEN 1 AND 64 OR length(v_data->>'updated_at') NOT BETWEEN 1 AND 64
     OR v_change_kind='attachment' AND v_data ? 'data' THEN RAISE EXCEPTION 'Invalid entity data' USING ERRCODE='22023'; END IF;
    v_origin:=NULL;
    IF v_change ? 'origin' THEN
     v_origin:=v_change->'origin';
     BEGIN v_parent_actor:=NULLIF(current_setting('fountain.content_actor',true),'')::jsonb;EXCEPTION WHEN invalid_text_representation THEN v_parent_actor:=NULL;END;
     IF jsonb_typeof(v_origin) IS DISTINCT FROM 'object' OR NOT(v_origin ?& ARRAY['member_id','cause']) OR v_origin-ARRAY['member_id','cause']<>'{}'::jsonb
      OR jsonb_typeof(v_origin->'member_id') IS DISTINCT FROM 'string' OR length(v_origin->>'member_id') NOT BETWEEN 1 AND 160
      OR jsonb_typeof(v_origin->'cause') IS DISTINCT FROM 'string' OR v_origin->>'cause' NOT IN('human','automation','import','public_form')
      OR v_parent_actor->>'workspace_id' IS DISTINCT FROM v_ws OR jsonb_typeof(v_parent_actor->'member_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_parent_actor->>'cause','') NOT IN('human','automation','import','public_form','system','scim')
      OR(v_origin->>'cause'<>'automation' AND v_origin->>'member_id' IS DISTINCT FROM v_parent_actor->>'member_id')
      OR NOT EXISTS(SELECT 1 FROM fountain_private.entities a WHERE a.workspace_id=v_ws AND a.kind='member' AND a.id=v_origin->>'member_id'
       AND a.data->>'id'=a.id AND COALESCE(a.data->'active','true'::jsonb)='true'::jsonb
       AND a.data->>'role'=ANY(CASE WHEN v_origin->>'cause'='automation' THEN ARRAY['owner','admin','member'] ELSE ARRAY['owner','admin','member','guest'] END))
      OR NOT EXISTS(SELECT 1 FROM fountain_private.entities a WHERE a.workspace_id=v_ws AND a.kind='member' AND a.id=v_parent_actor->>'member_id'
       AND a.data->>'id'=a.id AND COALESCE(a.data->'active','true'::jsonb)='true'::jsonb AND a.data->>'role' IN('owner','admin','member','guest')) THEN
      RAISE EXCEPTION 'Invalid trusted content origin' USING ERRCODE='22023';
     END IF;
    END IF;
    SELECT * INTO v_previous FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    v_found_previous:=FOUND;
    IF (v_found_previous AND (v_change->'previousCreatedAt' IS DISTINCT FROM to_jsonb(v_previous.created_at) OR v_data->>'created_at' IS DISTINCT FROM v_previous.created_at))
     OR (NOT v_found_previous AND v_change->'previousCreatedAt' IS DISTINCT FROM 'null'::jsonb) THEN
     RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
    END IF;
    v_activity_previous:=CASE WHEN v_found_previous THEN v_previous.data ELSE NULL END;
    v_previous_actor:=current_setting('fountain.content_actor',true);
    IF v_origin IS NOT NULL THEN PERFORM set_config('fountain.content_actor',(v_origin||jsonb_build_object('workspace_id',v_ws))::text,true);END IF;
    BEGIN
    INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at)
    VALUES(v_ws,v_change_kind,v_change_id,v_data,v_data->>'created_at',v_data->>'updated_at')
    ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at;
    EXCEPTION WHEN OTHERS THEN
     PERFORM set_config('fountain.content_actor',COALESCE(v_previous_actor,''),true);RAISE;
    END;
    PERFORM set_config('fountain.content_actor',COALESCE(v_previous_actor,''),true);
    IF v_change_kind IN('page','database','row') THEN
     SELECT generation INTO v_activity_generation FROM fountain_private.content_provenance WHERE workspace_id=v_ws AND kind=v_change_kind AND id=v_change_id;
     v_activity_origin:=COALESCE(v_origin->>'cause',CASE WHEN p_allow_activity_view THEN 'human' ELSE CASE WHEN p_activity_actor->>'auth_kind'='service' THEN 'automation' ELSE 'unknown' END END);
     PERFORM fountain_private.activity_capture(v_ws,v_change_kind,v_change_id,v_activity_previous,v_data,v_activity_generation,p_activity_command,v_activity_ordinal,p_activity_actor,v_activity_origin);
    END IF;
    v_steps:=v_steps+1;
   ELSE
    IF NOT(v_change ?& ARRAY['op','kind','id']) OR v_change-ARRAY['op','kind','id']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    SELECT e.data,p.generation INTO v_activity_previous,v_activity_generation FROM fountain_private.entities e LEFT JOIN fountain_private.content_provenance p ON p.workspace_id=e.workspace_id AND p.kind=e.kind AND p.id=e.id WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    DELETE FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    GET DIAGNOSTICS v_affected=ROW_COUNT;
    IF v_affected>0 AND v_change_kind IN('page','database','row') THEN PERFORM fountain_private.activity_capture(v_ws,v_change_kind,v_change_id,v_activity_previous,NULL,v_activity_generation,p_activity_command,v_activity_ordinal,p_activity_actor,CASE WHEN p_allow_activity_view THEN 'human' ELSE 'automation' END);END IF;
    v_steps:=v_steps+v_affected;
   END IF;
  ELSIF v_change->>'op'='activity_view' THEN
   IF NOT p_allow_activity_view OR p_activity_actor IS NULL OR p_activity_actor->>'auth_kind' IS DISTINCT FROM 'supabase' OR v_change-ARRAY['op','kind','id','commandId']<>'{}'::jsonb OR NOT(v_change ?& ARRAY['op','kind','id','commandId']) OR v_change->>'kind' IS DISTINCT FROM 'page' OR jsonb_typeof(v_change->'id') IS DISTINCT FROM 'string' OR NOT fountain_private.retention_id(v_change->>'id') OR jsonb_typeof(v_change->'commandId') IS DISTINCT FROM 'string' OR v_change->>'commandId'!~'^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Invalid canonical activity view' USING ERRCODE='22023';END IF;
   SELECT data INTO v_view_member FROM fountain_private.entities WHERE workspace_id=v_ws AND kind='member' AND id=p_activity_actor->>'member_id';
   v_view_access:=fountain_private.content_access_internal(v_ws,'page',v_change->>'id',v_view_member,true);
   IF jsonb_typeof(v_view_access->'level') IS DISTINCT FROM 'number' OR (v_view_access->>'level')::integer<1 THEN RAISE EXCEPTION 'Activity view permission required' USING ERRCODE='PT403';END IF;
   PERFORM fountain_private.activity_view(v_ws,'page',v_change->>'id',v_change->>'commandId',p_activity_actor,'human');v_steps:=v_steps+1;
  ELSIF v_change->>'op'='meta' THEN
   v_meta_key:=v_change->>'key';
   IF NOT(v_change ?& ARRAY['op','key','value']) OR v_change-ARRAY['op','key','value']<>'{}'::jsonb
    OR jsonb_typeof(v_change->'key') IS DISTINCT FROM 'string' OR length(v_meta_key) NOT BETWEEN 1 AND 160
    OR v_meta_key IN ('_entity_revision','local_cache_binding','attachment_file_root','attachment_file_gc_cursor','_backup_storage_reserved')
    OR v_meta_key='workspace_id' AND v_change->'value' IS DISTINCT FROM to_jsonb(v_ws) THEN RAISE EXCEPTION 'Invalid metadata change' USING ERRCODE='22023'; END IF;
   INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,v_meta_key,v_change->'value')
   ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
   v_steps:=v_steps+1;
  ELSE RAISE EXCEPTION 'Invalid change' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Evaluate the final transaction state, including multi-member changes.
 -- Legacy password hashes never prove that a Supabase owner can log in.
 IF v_owner_mutated THEN
  PERFORM 1 FROM fountain_private.entities e
   JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id
   JOIN auth.users u ON u.id=m.auth_user_id
   WHERE e.workspace_id=v_ws AND e.kind='member' AND e.data->>'id'=e.id AND e.data->>'role'='owner'
    AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
    AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
    AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
    AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
    AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   ORDER BY u.id FOR SHARE OF e,m,u;
  IF NOT FOUND THEN RAISE EXCEPTION 'LAST_OWNER_ACCOUNT' USING ERRCODE='PT409'; END IF;
 END IF;
 IF v_revision+v_steps>9007199254740991 THEN RAISE EXCEPTION 'Revision limit exceeded' USING ERRCODE='PT413'; END IF;
 v_revision:=v_revision+v_steps;
 IF v_steps>0 THEN
  INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(v_ws,'_entity_revision',to_jsonb(v_revision))
  ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 END IF;
 RETURN v_revision;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.store_apply_changes_locked(text,bigint,jsonb,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION fountain_cloud.store_commit(p_context jsonb, p_expected_revision bigint, p_transaction_id uuid, p_digest text, p_canonical text, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE ws text;actor_id text;revision bigint;recorded fountain_cloud.store_commit_receipts;v_content_actor text;
BEGIN
 -- Always authenticate BEFORE replay ACK, including a previously committed tx.
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';actor_id:=p_context->>'memberId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_transaction_id IS NULL
  OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>16777216
  OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid commit' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p_changes)>1000 OR octet_length(p_changes::text)>16777216 THEN
  RAISE EXCEPTION 'Commit limit exceeded' USING ERRCODE='PT413';
 END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest
  OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'changes',p_changes) THEN
  RAISE EXCEPTION 'Invalid commit digest' USING ERRCODE='22023';
 END IF;
 SELECT * INTO recorded FROM fountain_cloud.store_commit_receipts r
 WHERE r.workspace_id=ws AND r.member_id=actor_id AND r.session_hash=p_context->>'sessionHash' AND r.transaction_id=p_transaction_id;
 IF FOUND THEN
  IF recorded.digest<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('revision',recorded.result_revision);
 END IF;
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');
 IF revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409'; END IF;
 v_content_actor:=current_setting('fountain.content_actor',true);
 PERFORM set_config('fountain.content_actor',jsonb_build_object('workspace_id',ws,'member_id',actor_id,'cause','human')::text,true);
 BEGIN
  revision:=fountain_cloud.store_apply_changes_locked(ws,p_expected_revision,p_changes,jsonb_build_object('member_id',actor_id,'auth_kind','supabase'),replace(p_transaction_id::text,'-',''),true);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);RAISE;END;
 PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);
 INSERT INTO fountain_cloud.store_commit_receipts(workspace_id,member_id,session_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(ws,actor_id,p_context->>'sessionHash',p_transaction_id,p_digest,p_expected_revision,revision);
 RETURN jsonb_build_object('revision',revision);
END $function$;
CREATE OR REPLACE FUNCTION fountain_cloud.service_commit(p_context jsonb,p_expected_revision bigint,p_transaction_id uuid,p_digest text,p_canonical text,p_changes jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_principal jsonb;v_ws text;v_scope text;v_recorded fountain_cloud.service_commit_receipts;v_revision bigint;
 v_job fountain_cloud.scheduler_jobs;v_final_run jsonb;v_final_auto jsonb;v_stamp text;v_next jsonb;v_content_actor text;
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
 v_content_actor:=current_setting('fountain.content_actor',true);
 PERFORM set_config('fountain.content_actor',jsonb_build_object('workspace_id',v_ws,'member_id',v_principal->>'id','cause',CASE WHEN p_context->>'kind'='automation' THEN 'automation' ELSE 'system' END)::text,true);
 BEGIN
  v_revision:=fountain_cloud.store_apply_changes_locked(v_ws,p_expected_revision,p_changes,jsonb_build_object('member_id',v_principal->>'id','auth_kind','service'),replace(p_transaction_id::text,'-',''),false);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);RAISE;END;
 PERFORM set_config('fountain.content_actor',COALESCE(v_content_actor,''),true);
 IF p_context->>'kind'='automation' THEN UPDATE fountain_cloud.scheduler_jobs j SET result_revision=v_revision WHERE j.workspace_id=v_ws AND j.id=v_job.id;END IF;
 INSERT INTO fountain_cloud.service_commit_receipts(workspace_id,grant_id,authority_hash,transaction_id,digest,expected_revision,result_revision)
 VALUES(v_ws,(p_context->>'grantId')::uuid,v_scope,p_transaction_id,p_digest,p_expected_revision,v_revision);
 RETURN jsonb_build_object('revision',v_revision);
END $$;


CREATE FUNCTION fountain_private.activity_valid_stamp(p_value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_value IS NULL OR p_value!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|\+00:00)$' THEN RETURN false;END IF;
 PERFORM fountain_private.retention_stamp(p_value);RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END $f$;
CREATE FUNCTION fountain_private.activity_validate_workspace_internal(p_workspace text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE r record;state fountain_private.activity_runtime;
BEGIN
 IF p_workspace IS NULL THEN RAISE EXCEPTION 'Invalid activity validation namespace' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_ledgers l WHERE l.workspace_id=p_workspace AND (l.id!~'^[a-f0-9]{32}$' OR l.origin NOT IN('installation','restore') OR l.capture_scope<>'canonical-server-v1' OR NOT fountain_private.activity_valid_stamp(l.started_at))) THEN RAISE EXCEPTION 'Invalid activity ledger' USING ERRCODE='PT503';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_memberships m JOIN fountain_private.activity_ledgers l ON l.workspace_id=m.workspace_id AND l.id=m.ledger_id WHERE m.workspace_id=p_workspace AND (m.id!~'^[a-f0-9]{32}$' OR NOT fountain_private.retention_id(m.member_id) OR NOT fountain_private.activity_valid_stamp(m.opened_at) OR m.opened_at::timestamptz<l.started_at::timestamptz OR (m.closed_at IS NULL) IS DISTINCT FROM (m.close_reason IS NULL) OR m.closed_at IS NOT NULL AND (NOT fountain_private.activity_valid_stamp(m.closed_at) OR m.closed_at::timestamptz<m.opened_at::timestamptz OR m.close_reason NOT IN('inactive','deleted','restore')))) THEN RAISE EXCEPTION 'Invalid activity membership episode' USING ERRCODE='PT503';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_accounts a JOIN fountain_private.activity_memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id WHERE a.workspace_id=p_workspace AND (a.id!~'^[a-f0-9]{32}$' OR a.auth_kind NOT IN('password','supabase') OR NOT fountain_private.activity_valid_stamp(a.opened_at) OR a.opened_at::timestamptz<m.opened_at::timestamptz OR (a.closed_at IS NULL) IS DISTINCT FROM (a.close_reason IS NULL) OR a.closed_at IS NOT NULL AND (NOT fountain_private.activity_valid_stamp(a.closed_at) OR a.closed_at::timestamptz<a.opened_at::timestamptz OR a.close_reason NOT IN('credential_removed','identity_changed','membership_closed','restore')) OR m.closed_at IS NOT NULL AND (a.closed_at IS NULL OR a.closed_at::timestamptz>m.closed_at::timestamptz))) THEN RAISE EXCEPTION 'Invalid activity account episode' USING ERRCODE='PT503';END IF;
 FOR r IN SELECT e.*,m.member_id AS episode_member,m.ledger_id AS membership_ledger,m.opened_at AS member_opened,m.closed_at AS member_closed,a.membership_id AS account_membership,a.opened_at AS account_opened,a.closed_at AS account_closed,l.started_at FROM fountain_private.activity_events e JOIN fountain_private.activity_ledgers l ON l.workspace_id=e.workspace_id AND l.id=e.ledger_id LEFT JOIN fountain_private.activity_memberships m ON m.workspace_id=e.workspace_id AND m.id=e.membership_id LEFT JOIN fountain_private.activity_accounts a ON a.workspace_id=e.workspace_id AND a.id=e.account_id WHERE e.workspace_id=p_workspace LOOP
  IF r.sequence NOT BETWEEN 1 AND 9007199254740991 OR r.command_ordinal NOT BETWEEN 0 AND 9007199254740991 OR r.source_bytes NOT BETWEEN 0 AND 9007199254740991 OR r.event_id!~'^[a-f0-9]{32}$' OR r.command_id!~'^[a-f0-9]{32}$' OR r.resource_generation!~'^[a-f0-9]{32}$' OR r.source_sha256!~'^[a-f0-9]{64}$' OR r.resource_kind NOT IN('page','database','row') OR NOT fountain_private.retention_id(r.resource_id) OR r.source_encoding<>'fountain-cjson-v1' OR r.origin NOT IN('human','automation','import','public_form','system','unknown') OR r.action NOT IN('created','edited','managed','deleted','viewed') OR NOT fountain_private.activity_valid_stamp(r.occurred_at) OR r.occurred_at::timestamptz<r.started_at::timestamptz THEN RAISE EXCEPTION 'Invalid immutable activity event' USING ERRCODE='PT503';END IF;
  IF (r.actor_member_id IS NULL) IS DISTINCT FROM (r.membership_id IS NULL) OR r.actor_member_id IS NOT NULL AND (r.actor_member_id IS DISTINCT FROM r.episode_member OR r.membership_ledger IS DISTINCT FROM r.ledger_id OR r.occurred_at::timestamptz<r.member_opened::timestamptz OR r.member_closed IS NOT NULL AND r.occurred_at::timestamptz>r.member_closed::timestamptz) OR r.account_id IS NOT NULL AND (r.account_membership IS DISTINCT FROM r.membership_id OR r.occurred_at::timestamptz<r.account_opened::timestamptz OR r.account_closed IS NOT NULL AND r.occurred_at::timestamptz>r.account_closed::timestamptz) THEN RAISE EXCEPTION 'Activity actor episode does not contain its event' USING ERRCODE='PT503';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=p_workspace GROUP BY ledger_id HAVING min(sequence)<>1 OR max(sequence)<>count(*)) THEN RAISE EXCEPTION 'Activity event sequence has gaps' USING ERRCODE='PT503';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_current_members c LEFT JOIN fountain_private.activity_memberships m ON m.workspace_id=c.workspace_id AND m.id=c.membership_id LEFT JOIN fountain_private.activity_runtime rt ON rt.workspace_id=c.workspace_id AND rt.singleton=1 WHERE c.workspace_id=p_workspace AND (m.id IS NULL OR m.member_id IS DISTINCT FROM c.member_id OR m.closed_at IS NOT NULL OR m.ledger_id IS DISTINCT FROM rt.ledger_id)) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts c LEFT JOIN fountain_private.activity_accounts a ON a.workspace_id=c.workspace_id AND a.id=c.account_id LEFT JOIN fountain_private.activity_current_members m ON m.workspace_id=c.workspace_id AND m.member_id=c.member_id WHERE c.workspace_id=p_workspace AND (a.id IS NULL OR a.closed_at IS NOT NULL OR a.auth_kind IS DISTINCT FROM c.auth_kind OR a.membership_id IS DISTINCT FROM m.membership_id)) THEN RAISE EXCEPTION 'Activity current binding is corrupt' USING ERRCODE='PT503';END IF;
 SELECT * INTO state FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace AND singleton=1;
 IF FOUND THEN
  IF EXISTS(SELECT 1 FROM fountain_private.activity_memberships m WHERE m.workspace_id=p_workspace AND m.closed_at IS NULL AND (m.ledger_id IS DISTINCT FROM state.ledger_id OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_current_members c WHERE c.workspace_id=p_workspace AND c.member_id=m.member_id AND c.membership_id=m.id))) OR EXISTS(SELECT 1 FROM fountain_private.activity_accounts a JOIN fountain_private.activity_memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id WHERE a.workspace_id=p_workspace AND a.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts c WHERE c.workspace_id=p_workspace AND c.member_id=m.member_id AND c.auth_kind=a.auth_kind AND c.account_id=a.id)) THEN RAISE EXCEPTION 'Open activity episode has no current binding' USING ERRCODE='PT503';END IF;
  IF state.next_sequence IS DISTINCT FROM COALESCE((SELECT max(sequence)+1 FROM fountain_private.activity_events WHERE workspace_id=p_workspace AND ledger_id=state.ledger_id),1) OR state.activity_revision NOT BETWEEN 1 AND 9007199254740991 OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_ledgers WHERE workspace_id=p_workspace AND id=state.ledger_id) THEN RAISE EXCEPTION 'Activity runtime high-water is corrupt' USING ERRCODE='PT503';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=p_workspace) THEN RAISE EXCEPTION 'Unactivated activity has live bindings' USING ERRCODE='PT503';END IF;
 END IF;
END $f$;
ALTER FUNCTION fountain_private.activity_validate_workspace_internal(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_validate_workspace_internal(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE FUNCTION fountain_private.activity_validate_workspace(p_workspace text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF p_workspace IS NULL OR current_setting('fountain.workspace_id',true) IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Invalid activity validation namespace' USING ERRCODE='22023';END IF;
 PERFORM fountain_private.activity_validate_workspace_internal(p_workspace);
END $f$;
CREATE FUNCTION fountain_private.activity_import_row(p_workspace text,p_table text,p_row jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE fields text[];nullable text[];numeric_cols text[];field text;value jsonb;previous text;
BEGIN
 PERFORM fountain_private.activity_lock(p_workspace);
 IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_ledgers l WHERE l.workspace_id=p_workspace AND l.xmin<>mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid) THEN RAISE EXCEPTION 'Activity import requires an empty top-level target transaction' USING ERRCODE='PT409';END IF;
 CASE p_table
 WHEN 'activity_ledgers' THEN fields:=ARRAY['id','started_at','origin','capture_scope'];nullable:='{}';numeric_cols:='{}';
 WHEN 'activity_memberships' THEN fields:=ARRAY['id','ledger_id','member_id','opened_at','closed_at','close_reason'];nullable:=ARRAY['closed_at','close_reason'];numeric_cols:='{}';
 WHEN 'activity_accounts' THEN fields:=ARRAY['id','membership_id','auth_kind','opened_at','closed_at','close_reason'];nullable:=ARRAY['closed_at','close_reason'];numeric_cols:='{}';
 WHEN 'activity_events' THEN fields:=ARRAY['ledger_id','sequence','event_id','command_id','command_ordinal','actor_member_id','membership_id','account_id','origin','action','resource_kind','resource_id','resource_generation','occurred_at','source_encoding','source_bytes','source_sha256'];nullable:=ARRAY['actor_member_id','membership_id','account_id'];numeric_cols:=ARRAY['sequence','command_ordinal','source_bytes'];
 ELSE RAISE EXCEPTION 'Invalid activity portable table' USING ERRCODE='22023';END CASE;
 IF NOT(p_row ?& fields) OR p_row-fields<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid activity portable columns' USING ERRCODE='22023';END IF;
 FOREACH field IN ARRAY fields LOOP
  value:=p_row->field;
  IF value='null'::jsonb AND field=ANY(nullable) THEN CONTINUE;END IF;
  IF field=ANY(numeric_cols) THEN IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR value#>>'{}'!~'^[0-9]{1,16}$' OR (value#>>'{}')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Invalid activity portable number' USING ERRCODE='22023';END IF;
  ELSIF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid activity portable string' USING ERRCODE='22023';END IF;
 END LOOP;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',p_workspace,true);
 CASE p_table
 WHEN 'activity_ledgers' THEN INSERT INTO fountain_private.activity_ledgers SELECT (jsonb_populate_record(NULL::fountain_private.activity_ledgers,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
 WHEN 'activity_memberships' THEN INSERT INTO fountain_private.activity_memberships SELECT (jsonb_populate_record(NULL::fountain_private.activity_memberships,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
 WHEN 'activity_accounts' THEN INSERT INTO fountain_private.activity_accounts SELECT (jsonb_populate_record(NULL::fountain_private.activity_accounts,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
 WHEN 'activity_events' THEN INSERT INTO fountain_private.activity_events SELECT (jsonb_populate_record(NULL::fountain_private.activity_events,p_row||jsonb_build_object('workspace_id',p_workspace))).* ON CONFLICT DO NOTHING;
 END CASE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Activity portable row already exists' USING ERRCODE='PT409';END IF;
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);
END $f$;
CREATE FUNCTION fountain_private.activity_import_finish(p_workspace text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ledger text;previous text;stamp text;r record;
BEGIN
 PERFORM fountain_private.activity_lock(p_workspace);
 IF EXISTS(SELECT 1 FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace) OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_ledgers WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_ledgers l WHERE l.workspace_id=p_workspace AND l.xmin<>mod(pg_current_xact_id()::text::numeric,4294967296)::text::xid) THEN RAISE EXCEPTION 'Activity activation requires freshly imported history' USING ERRCODE='PT409';END IF;
 PERFORM fountain_private.activity_validate_workspace(p_workspace);stamp:=fountain_private.activity_now();
 IF EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=p_workspace AND opened_at::timestamptz>stamp::timestamptz) OR EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=p_workspace AND opened_at::timestamptz>stamp::timestamptz) THEN RAISE EXCEPTION 'Activity episode starts after restore time' USING ERRCODE='PT409';END IF;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',p_workspace,true);ledger:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.activity_ledgers VALUES(p_workspace,ledger,stamp,'restore','canonical-server-v1');
 INSERT INTO fountain_private.activity_runtime VALUES(p_workspace,1,ledger,1,1);
 FOR r IN SELECT id FROM fountain_private.activity_accounts WHERE workspace_id=p_workspace AND closed_at IS NULL ORDER BY id COLLATE "C" LOOP
  UPDATE fountain_private.activity_accounts SET closed_at=stamp,close_reason='restore' WHERE workspace_id=p_workspace AND id=r.id;PERFORM fountain_private.activity_touch(p_workspace);
 END LOOP;
 FOR r IN SELECT id FROM fountain_private.activity_memberships WHERE workspace_id=p_workspace AND closed_at IS NULL ORDER BY id COLLATE "C" LOOP
  UPDATE fountain_private.activity_memberships SET closed_at=stamp,close_reason='restore' WHERE workspace_id=p_workspace AND id=r.id;PERFORM fountain_private.activity_touch(p_workspace);
 END LOOP;
 -- New current episodes are observations of the restored live configuration;
 -- old account pointers and sessions are never restored from portable history.
 FOR r IN SELECT e.id FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='member' AND e.data->>'id'=e.id AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND e.data->>'role' IN('owner','admin','member','guest') ORDER BY e.id COLLATE "C" LOOP
  PERFORM fountain_private.activity_ensure_member(p_workspace,r.id);
  IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='credential' AND e.id=r.id) THEN PERFORM fountain_private.activity_ensure_account(p_workspace,r.id,'password');END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace AND m.member_id=r.id) THEN PERFORM fountain_private.activity_ensure_account(p_workspace,r.id,'supabase');END IF;
 END LOOP;
 PERFORM fountain_private.activity_validate_workspace(p_workspace);
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);RETURN ledger;
END $f$;

CREATE TRIGGER activity_ledgers_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.activity_ledgers FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_guard();

CREATE TRIGGER activity_memberships_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.activity_memberships FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_guard();

CREATE TRIGGER activity_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.activity_accounts FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_guard();

CREATE TRIGGER activity_events_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.activity_events FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_guard();

CREATE TRIGGER activity_runtime_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.activity_runtime FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_guard();

CREATE TRIGGER activity_current_members_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.activity_current_members FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_guard();

CREATE TRIGGER activity_current_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.activity_current_accounts FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_guard();
CREATE TRIGGER fountain_activity_member_insert AFTER INSERT ON fountain_private.entities FOR EACH ROW WHEN(NEW.kind IN('member','credential')) EXECUTE FUNCTION fountain_private.activity_lifecycle_event();
CREATE TRIGGER fountain_activity_member_update AFTER UPDATE ON fountain_private.entities FOR EACH ROW WHEN(OLD.kind IN('member','credential') OR NEW.kind IN('member','credential')) EXECUTE FUNCTION fountain_private.activity_lifecycle_event();
CREATE TRIGGER fountain_activity_member_delete AFTER DELETE ON fountain_private.entities FOR EACH ROW WHEN(OLD.kind IN('member','credential')) EXECUTE FUNCTION fountain_private.activity_lifecycle_event();
CREATE TRIGGER fountain_activity_mapping AFTER INSERT OR UPDATE OR DELETE ON fountain_private.identity_mapping FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_lifecycle_event();
ALTER FUNCTION fountain_private.activity_cjson(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_cjson(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_now() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_now() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_lock(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_lock(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_guard() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_touch(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_touch(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_close_account(text,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_close_account(text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_close_member(text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_close_member(text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_ensure_member(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_ensure_member(text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_ensure_account(text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_ensure_account(text,text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_initialize(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_initialize(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_initialize(text) TO fountain_backend;
ALTER FUNCTION fountain_private.activity_lifecycle_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_lifecycle_event() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_backup_fence(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_backup_fence(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_backup_fence(text) TO fountain_backend;
ALTER FUNCTION fountain_private.activity_emit(text,text,text,text,jsonb,text,text,bigint,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_emit(text,text,text,text,jsonb,text,text,bigint,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_capture(text,text,text,jsonb,jsonb,text,text,bigint,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_capture(text,text,text,jsonb,jsonb,text,text,bigint,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_capture(text,text,text,jsonb,jsonb,text,text,bigint,jsonb,text) TO fountain_backend;
ALTER FUNCTION fountain_private.activity_view(text,text,text,text,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_view(text,text,text,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_view(text,text,text,text,jsonb,text) TO fountain_backend;
ALTER FUNCTION fountain_cloud.store_apply_changes_locked(text,bigint,jsonb,jsonb,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.store_apply_changes_locked(text,bigint,jsonb,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_cloud.service_commit(jsonb,bigint,uuid,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.service_commit(jsonb,bigint,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_valid_stamp(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_valid_stamp(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.activity_validate_workspace(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_validate_workspace(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_validate_workspace(text) TO fountain_backend;
ALTER FUNCTION fountain_private.activity_import_row(text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_import_row(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_import_row(text,text,jsonb) TO fountain_backend;
ALTER FUNCTION fountain_private.activity_import_finish(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_import_finish(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_import_finish(text) TO fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb),fountain_cloud.service_commit(jsonb,bigint,uuid,text,text,jsonb) TO service_role;

-- An append-only import cannot commit an unactivated partial history. Each
-- imported epoch checks runtime presence cheaply; one runtime INSERT validates
-- the complete restored graph, avoiding a full scan per event row.
CREATE FUNCTION fountain_private.activity_epoch_commit_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_runtime WHERE workspace_id=NEW.workspace_id AND singleton=1) THEN RAISE EXCEPTION 'Activity import was not finalized' USING ERRCODE='PT503';END IF;
 RETURN NULL;
END $f$;
CREATE FUNCTION fountain_private.activity_runtime_commit_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 -- Only trusted private runtime inserts can queue this read-only check; do
 -- not change a caller's workspace GUC while processing deferred workspaces.
 PERFORM fountain_private.activity_validate_workspace_internal(NEW.workspace_id);RETURN NULL;
END $f$;
ALTER FUNCTION fountain_private.activity_epoch_commit_guard() OWNER TO postgres;
ALTER FUNCTION fountain_private.activity_runtime_commit_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_epoch_commit_guard(),fountain_private.activity_runtime_commit_guard() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE CONSTRAINT TRIGGER activity_epoch_commit AFTER INSERT ON fountain_private.activity_ledgers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_epoch_commit_guard();
CREATE CONSTRAINT TRIGGER activity_runtime_commit AFTER INSERT ON fountain_private.activity_runtime DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fountain_private.activity_runtime_commit_guard();

-- Preserve the existing administrator business/receipt kernel unchanged. The
-- public signature remains stable; the moved base loses all transport access.
ALTER FUNCTION public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) SET SCHEMA fountain_cloud;
ALTER FUNCTION fountain_cloud.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) RENAME TO content_change_activity_base;
REVOKE ALL ON FUNCTION fountain_cloud.content_change_activity_base(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE FUNCTION public.fountain_cloud_content_change(p_context jsonb,p_expected_revision bigint,p_request_id uuid,p_digest text,p_canonical text,p_kind text,p_id text,p_review_revision text,p_operation text,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;actor jsonb;had_receipt boolean;before_source jsonb;after_source jsonb;generation text;result jsonb;
BEGIN
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 SELECT EXISTS(SELECT 1 FROM fountain_cloud.content_change_receipts r WHERE r.workspace_id=ws AND r.member_id=p_context->>'memberId' AND r.session_hash=p_context->>'sessionHash' AND r.request_id=p_request_id) INTO had_receipt;
 IF NOT had_receipt THEN SELECT e.data INTO before_source FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind=p_kind AND e.id=p_id;END IF;
 -- The unchanged base still validates digest, current review/source revision,
 -- existing receipt collisions and the complete restore/publication behavior.
 result:=fountain_cloud.content_change_activity_base(p_context,p_expected_revision,p_request_id,p_digest,p_canonical,p_kind,p_id,p_review_revision,p_operation,p_value);
 IF NOT had_receipt AND before_source IS NOT NULL THEN
  SELECT e.data,p.generation INTO after_source,generation FROM fountain_private.entities e JOIN fountain_private.content_provenance p ON p.workspace_id=e.workspace_id AND p.kind=e.kind AND p.id=e.id WHERE e.workspace_id=ws AND e.kind=p_kind AND e.id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Administrator activity source disappeared' USING ERRCODE='PT409';END IF;
  actor:=jsonb_build_object('member_id',p_context->>'memberId','auth_kind','supabase');
  PERFORM fountain_private.activity_capture(ws,p_kind,p_id,before_source,after_source,generation,replace(p_request_id::text,'-',''),0,actor,'human');
 END IF;
 RETURN result;
END $f$;
ALTER FUNCTION public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) TO service_role;
