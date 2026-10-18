-- Independent organization control plane. No organization is enrolled here.
-- Identity-only RPC inputs are trusted Edge inputs, never a browser login API.
-- Global authority is excluded from workspace entities, exports and v1-v4 backups.
CREATE TABLE fountain_private.organization_registry (
 id uuid PRIMARY KEY,name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200 AND octet_length(name)<=800),
 status text NOT NULL CHECK(status IN('pending','active')),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='pending' AND revision=0) OR(status='active' AND revision>=1))
);
CREATE TABLE fountain_private.organization_owner_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES fountain_private.organization_registry(id),
 user_id uuid NOT NULL,granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 granted_by uuid,closed_at timestamptz,closed_by uuid,
 UNIQUE(organization_id,id),UNIQUE(organization_id,id,user_id),CHECK((closed_at IS NULL)=(closed_by IS NULL)),CHECK(closed_at IS NULL OR closed_at>=granted_at),
 FOREIGN KEY(organization_id,granted_by) REFERENCES fountain_private.organization_owner_grants(organization_id,id),
 FOREIGN KEY(organization_id,closed_by) REFERENCES fountain_private.organization_owner_grants(organization_id,id)
);
CREATE UNIQUE INDEX organization_owner_active ON fountain_private.organization_owner_grants(organization_id,user_id) WHERE closed_at IS NULL;
CREATE INDEX organization_owner_identity ON fountain_private.organization_owner_grants(user_id,organization_id) WHERE closed_at IS NULL;
CREATE TABLE fountain_private.organization_bootstrap_claims (
 organization_id uuid PRIMARY KEY REFERENCES fountain_private.organization_registry(id),target_user_id uuid NOT NULL,
 nonce_hash text NOT NULL CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 consumed_at timestamptz,consumed_command_id uuid,first_grant_id uuid,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
 CHECK((consumed_at IS NULL)=(consumed_command_id IS NULL) AND(consumed_at IS NULL)=(first_grant_id IS NULL)),
 CHECK(consumed_at IS NULL OR consumed_at>=created_at),
 FOREIGN KEY(organization_id,first_grant_id) REFERENCES fountain_private.organization_owner_grants(organization_id,id)
);
CREATE TABLE fountain_private.organization_link_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES fountain_private.organization_registry(id),
 workspace_id text NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 160),initiator_grant_id uuid NOT NULL,
 requested_revision bigint NOT NULL CHECK(requested_revision BETWEEN 1 AND 9007199254740991),
 nonce_hash text NOT NULL CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 consumed_at timestamptz,consumed_command_id uuid,link_id uuid,
 UNIQUE(organization_id,id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK((consumed_at IS NULL)=(consumed_command_id IS NULL) AND(consumed_at IS NULL)=(link_id IS NULL)),
 FOREIGN KEY(organization_id,initiator_grant_id) REFERENCES fountain_private.organization_owner_grants(organization_id,id)
);
CREATE INDEX organization_link_requests_workspace ON fountain_private.organization_link_requests(workspace_id,organization_id);
CREATE TABLE fountain_private.organization_workspace_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES fountain_private.organization_registry(id),
 workspace_id text NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 160),request_id uuid NOT NULL UNIQUE,
 accepted_by_user_id uuid NOT NULL,accepted_by_member_id text NOT NULL CHECK(length(accepted_by_member_id) BETWEEN 1 AND 160),
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),detached_at timestamptz,detached_by uuid,
 UNIQUE(organization_id,id),CHECK((detached_at IS NULL)=(detached_by IS NULL)),CHECK(detached_at IS NULL OR detached_at>=linked_at),
 FOREIGN KEY(organization_id,request_id) REFERENCES fountain_private.organization_link_requests(organization_id,id),
 FOREIGN KEY(organization_id,detached_by) REFERENCES fountain_private.organization_owner_grants(organization_id,id)
);
CREATE UNIQUE INDEX organization_workspace_active ON fountain_private.organization_workspace_links(workspace_id) WHERE detached_at IS NULL;
ALTER TABLE fountain_private.organization_link_requests ADD FOREIGN KEY(organization_id,link_id) REFERENCES fountain_private.organization_workspace_links(organization_id,id);
CREATE TABLE fountain_private.organization_events (
 organization_id uuid NOT NULL REFERENCES fountain_private.organization_registry(id),revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),command_id uuid NOT NULL,actor_user_id uuid NOT NULL,actor_grant_id uuid,
 actor_kind text NOT NULL CHECK(actor_kind IN('organization_owner','workspace_consent')),
 action text NOT NULL CHECK(action IN('bootstrap','rename','owner_grant','owner_revoke','link_request','link_accept','link_detach')),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=4096),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,revision),UNIQUE(organization_id,command_id),
 CHECK((actor_kind='organization_owner' AND actor_grant_id IS NOT NULL) OR(actor_kind='workspace_consent' AND actor_grant_id IS NULL)),
 CHECK((action='link_accept')=(actor_kind='workspace_consent')),
 FOREIGN KEY(organization_id,actor_grant_id,actor_user_id) REFERENCES fountain_private.organization_owner_grants(organization_id,id,user_id)
);
CREATE TABLE fountain_private.organization_receipts (
 organization_id uuid NOT NULL REFERENCES fountain_private.organization_registry(id),command_id uuid NOT NULL,actor_key text NOT NULL CHECK(length(actor_key) BETWEEN 1 AND 240),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=8192),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,command_id)
);
ALTER TABLE fountain_private.organization_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_registry FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_registry FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_registry_closed ON fountain_private.organization_registry FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
ALTER TABLE fountain_private.organization_owner_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_owner_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_owner_grants FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_owner_grants_closed ON fountain_private.organization_owner_grants FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
ALTER TABLE fountain_private.organization_bootstrap_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_bootstrap_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_bootstrap_claims FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_bootstrap_claims_closed ON fountain_private.organization_bootstrap_claims FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
ALTER TABLE fountain_private.organization_link_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_link_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_link_requests FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_link_requests_closed ON fountain_private.organization_link_requests FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
ALTER TABLE fountain_private.organization_workspace_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_workspace_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_workspace_links FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_workspace_links_closed ON fountain_private.organization_workspace_links FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
ALTER TABLE fountain_private.organization_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_events FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_events_closed ON fountain_private.organization_events FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
ALTER TABLE fountain_private.organization_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_receipts FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_receipts_closed ON fountain_private.organization_receipts FOR ALL TO PUBLIC USING(false) WITH CHECK(false);

CREATE FUNCTION fountain_private.organization_uuid(p_value jsonb) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR(p_value#>>'{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid UUID' USING ERRCODE='22023';END IF;
 RETURN (p_value#>>'{}')::uuid;
END $f$;
CREATE FUNCTION fountain_private.organization_identity(p_identity jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;sid uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Organization control requires read committed' USING ERRCODE='PT409';END IF;
 IF jsonb_typeof(p_identity) IS DISTINCT FROM 'object' OR NOT(p_identity ?& ARRAY['userId','authSessionId']) OR p_identity-ARRAY['userId','authSessionId']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid organization identity' USING ERRCODE='22023';END IF;
 uid:=fountain_private.organization_uuid(p_identity->'userId');sid:=fountain_private.organization_uuid(p_identity->'authSessionId');
 PERFORM 1 FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
 WHERE u.id=uid AND s.id=sid AND u.deleted_at IS NULL AND u.is_anonymous=false AND u.email_confirmed_at IS NOT NULL
 AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) AND(s.not_after IS NULL OR s.not_after>clock_timestamp()) FOR SHARE OF u,s;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 RETURN uid;
END $f$;
CREATE FUNCTION fountain_private.organization_usable_user(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 PERFORM 1 FROM auth.users u WHERE u.id=p_user_id AND u.deleted_at IS NULL AND u.is_anonymous=false AND u.email_confirmed_at IS NOT NULL
 AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) FOR SHARE;
 RETURN FOUND;
END $f$;
CREATE FUNCTION fountain_private.organization_lock(p_id uuid) RETURNS fountain_private.organization_registry
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE org fountain_private.organization_registry;
BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'Invalid organization' USING ERRCODE='22023';END IF;
 SELECT * INTO org FROM fountain_private.organization_registry WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='PT404';END IF;
 RETURN org;
END $f$;
CREATE FUNCTION fountain_private.organization_owner(p_id uuid,p_user_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE gid uuid;
BEGIN
 SELECT g.id INTO gid FROM fountain_private.organization_owner_grants g JOIN fountain_private.organization_registry o ON o.id=g.organization_id
 WHERE g.organization_id=p_id AND g.user_id=p_user_id AND g.closed_at IS NULL AND o.status='active' FOR SHARE OF g;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization owner required' USING ERRCODE='PT403';END IF;
 RETURN gid;
END $f$;
CREATE FUNCTION fountain_private.organization_receipt(p_id uuid,p_command uuid,p_actor text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE receipt fountain_private.organization_receipts;
BEGIN
 SELECT * INTO receipt FROM fountain_private.organization_receipts WHERE organization_id=p_id AND command_id=p_command;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF receipt.actor_key IS DISTINCT FROM p_actor OR receipt.request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'Organization command reused' USING ERRCODE='PT409';END IF;
 RETURN receipt.result;
END $f$;
CREATE FUNCTION fountain_private.organization_record(p_id uuid,p_command uuid,p_actor text,p_hash text,p_uid uuid,p_gid uuid,p_action text,p_details jsonb,p_changed boolean,p_extra jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE rev bigint;answer jsonb;
BEGIN
 SELECT revision INTO rev FROM fountain_private.organization_registry WHERE id=p_id;
 IF p_changed THEN
  IF rev>=9007199254740991 THEN RAISE EXCEPTION 'Organization revision exhausted' USING ERRCODE='PT413';END IF;
  rev:=rev+1;
  UPDATE fountain_private.organization_registry SET revision=rev,status='active' WHERE id=p_id;
  INSERT INTO fountain_private.organization_events(organization_id,revision,command_id,actor_user_id,actor_grant_id,actor_kind,action,details)
  VALUES(p_id,rev,p_command,p_uid,CASE WHEN p_action='link_accept' THEN NULL ELSE p_gid END,
   CASE WHEN p_action='link_accept' THEN 'workspace_consent' ELSE 'organization_owner' END,p_action,
   CASE WHEN p_action='link_accept' THEN p_details||jsonb_build_object('initiatorGrantId',p_gid) ELSE p_details END);
 END IF;
 answer:=jsonb_build_object('organizationId',p_id,'revision',rev,'changed',p_changed)||p_extra;
 INSERT INTO fountain_private.organization_receipts(organization_id,command_id,actor_key,request_hash,result) VALUES(p_id,p_command,p_actor,p_hash,answer);
 RETURN answer;
END $f$;
CREATE FUNCTION fountain_private.organization_immutable() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN RAISE EXCEPTION 'Organization history is immutable' USING ERRCODE='PT403';END $f$;
CREATE TRIGGER organization_events_immutable BEFORE UPDATE OR DELETE ON fountain_private.organization_events FOR EACH ROW EXECUTE FUNCTION fountain_private.organization_immutable();
CREATE TRIGGER organization_receipts_immutable BEFORE UPDATE OR DELETE ON fountain_private.organization_receipts FOR EACH ROW EXECUTE FUNCTION fountain_private.organization_immutable();
-- No Auth FK/cascade or Auth trigger: external security deletion/ban remains possible.
CREATE FUNCTION fountain_private.organization_history_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
DECLARE oldj jsonb:=to_jsonb(OLD);newj jsonb:=to_jsonb(NEW);mutable text[];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Organization history is immutable' USING ERRCODE='PT403';END IF;
 CASE TG_TABLE_NAME
 WHEN 'organization_owner_grants' THEN mutable:=ARRAY['closed_at','closed_by'];IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL THEN RAISE EXCEPTION 'Owner grant closure is immutable' USING ERRCODE='PT403';END IF;
 WHEN 'organization_workspace_links' THEN mutable:=ARRAY['detached_at','detached_by'];IF OLD.detached_at IS NOT NULL OR NEW.detached_at IS NULL THEN RAISE EXCEPTION 'Workspace link closure is immutable' USING ERRCODE='PT403';END IF;
 WHEN 'organization_bootstrap_claims' THEN mutable:=ARRAY['consumed_at','consumed_command_id','first_grant_id'];IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN RAISE EXCEPTION 'Bootstrap claim is immutable' USING ERRCODE='PT403';END IF;
 WHEN 'organization_link_requests' THEN mutable:=ARRAY['consumed_at','consumed_command_id','link_id'];IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN RAISE EXCEPTION 'Link request is immutable' USING ERRCODE='PT403';END IF;
 ELSE RAISE EXCEPTION 'Invalid organization history' USING ERRCODE='PT503';END CASE;
 IF oldj-mutable IS DISTINCT FROM newj-mutable THEN RAISE EXCEPTION 'Organization history is immutable' USING ERRCODE='PT403';END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER organization_grants_history BEFORE UPDATE OR DELETE ON fountain_private.organization_owner_grants FOR EACH ROW EXECUTE FUNCTION fountain_private.organization_history_guard();
CREATE TRIGGER organization_links_history BEFORE UPDATE OR DELETE ON fountain_private.organization_workspace_links FOR EACH ROW EXECUTE FUNCTION fountain_private.organization_history_guard();
CREATE TRIGGER organization_bootstrap_history BEFORE UPDATE OR DELETE ON fountain_private.organization_bootstrap_claims FOR EACH ROW EXECUTE FUNCTION fountain_private.organization_history_guard();
CREATE TRIGGER organization_requests_history BEFORE UPDATE OR DELETE ON fountain_private.organization_link_requests FOR EACH ROW EXECUTE FUNCTION fountain_private.organization_history_guard();

CREATE FUNCTION fountain_private.organization_bootstrap_prepare(p_organization_id uuid,p_name text,p_target_user_id uuid,p_nonce_hash text,p_expires_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE stamp timestamptz:=clock_timestamp();
BEGIN
 -- Explicit operator provisioning; connected service credentials cannot enroll.
 IF session_user<>'postgres' THEN RAISE EXCEPTION 'Organization operator required' USING ERRCODE='PT403';END IF;
 IF p_organization_id IS NULL OR p_target_user_id IS NULL OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 OR octet_length(p_name)>800
 OR p_nonce_hash IS NULL OR p_nonce_hash !~ '^[a-f0-9]{64}$' OR p_expires_at IS NULL OR p_expires_at<=stamp OR p_expires_at>stamp+interval '24 hours' THEN RAISE EXCEPTION 'Invalid organization bootstrap' USING ERRCODE='22023';END IF;
 IF NOT fountain_private.organization_usable_user(p_target_user_id) THEN RAISE EXCEPTION 'Bootstrap target unavailable' USING ERRCODE='PT403';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.organization_registry WHERE id=p_organization_id) THEN RAISE EXCEPTION 'Organization already prepared' USING ERRCODE='PT409';END IF;
 INSERT INTO fountain_private.organization_registry(id,name,status,revision,created_at) VALUES(p_organization_id,p_name,'pending',0,stamp);
 INSERT INTO fountain_private.organization_bootstrap_claims(organization_id,target_user_id,nonce_hash,created_at,expires_at) VALUES(p_organization_id,p_target_user_id,p_nonce_hash,stamp,p_expires_at);
 RETURN jsonb_build_object('organizationId',p_organization_id,'status','pending','expiresAt',p_expires_at);
END $f$;
CREATE FUNCTION public.fountain_cloud_organization_bootstrap_accept(p_identity jsonb,p_organization_id uuid,p_nonce text,p_command_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;org fountain_private.organization_registry;claim fountain_private.organization_bootstrap_claims;gid uuid;actor text;digest text;answer jsonb;
BEGIN
 uid:=fountain_private.organization_identity(p_identity);
 IF p_organization_id IS NULL OR p_command_id IS NULL OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid organization bootstrap' USING ERRCODE='22023';END IF;
 org:=fountain_private.organization_lock(p_organization_id);
 SELECT * INTO claim FROM fountain_private.organization_bootstrap_claims WHERE organization_id=p_organization_id;
 IF NOT FOUND OR claim.target_user_id<>uid OR claim.nonce_hash<>encode(sha256(convert_to(p_nonce,'UTF8')),'hex') THEN RAISE EXCEPTION 'Organization bootstrap rejected' USING ERRCODE='PT403';END IF;
 digest:=encode(sha256(convert_to(jsonb_build_object('operation','bootstrap','organizationId',p_organization_id,'userId',uid)::text,'UTF8')),'hex');
 IF claim.consumed_at IS NOT NULL THEN
  IF claim.consumed_command_id<>p_command_id THEN RAISE EXCEPTION 'Organization bootstrap consumed' USING ERRCODE='PT409';END IF;
  gid:=fountain_private.organization_owner(p_organization_id,uid);
  IF gid<>claim.first_grant_id THEN RAISE EXCEPTION 'Bootstrap grant unavailable' USING ERRCODE='PT403';END IF;
  answer:=fountain_private.organization_receipt(p_organization_id,p_command_id,'grant:'||gid::text,digest);
  IF answer IS NULL THEN RAISE EXCEPTION 'Bootstrap receipt missing' USING ERRCODE='PT503';END IF;
  RETURN answer;
 END IF;
 IF claim.expires_at<=clock_timestamp() OR org.status<>'pending' OR org.revision<>0 OR EXISTS(SELECT 1 FROM fountain_private.organization_owner_grants WHERE organization_id=p_organization_id) THEN RAISE EXCEPTION 'Organization bootstrap rejected' USING ERRCODE='PT403';END IF;
 INSERT INTO fountain_private.organization_owner_grants(organization_id,user_id) VALUES(p_organization_id,uid) RETURNING id INTO gid;
 UPDATE fountain_private.organization_bootstrap_claims SET consumed_at=clock_timestamp(),consumed_command_id=p_command_id,first_grant_id=gid WHERE organization_id=p_organization_id;
 RETURN fountain_private.organization_record(p_organization_id,p_command_id,'grant:'||gid::text,digest,uid,gid,'bootstrap',jsonb_build_object('grantId',gid),true,jsonb_build_object('grantId',gid));
END $f$;
CREATE FUNCTION public.fountain_cloud_organization_rpc(p_identity jsonb,p_organization_id uuid,p_operation text,p_expected_revision bigint,p_command_id uuid,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;gid uuid;org fountain_private.organization_registry;target uuid;target_grant fountain_private.organization_owner_grants;
 digest text;answer jsonb;changed boolean:=false;extra jsonb:='{}';details jsonb:='{}';counted integer;entry record;usable integer:=0;
 expires timestamptz;stamp timestamptz;request uuid;link fountain_private.organization_workspace_links;
BEGIN
 uid:=fountain_private.organization_identity(p_identity);
 IF p_operation IS NULL OR p_operation NOT IN('list','read','rename','owner_grant','owner_revoke','link_request','link_detach') OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR octet_length(p_value::text)>4096 THEN RAISE EXCEPTION 'Invalid organization command' USING ERRCODE='22023';END IF;
 IF p_operation IN('list','read') THEN
  IF p_expected_revision IS NOT NULL OR p_command_id IS NOT NULL OR p_value<>'{}'::jsonb OR(p_operation='list' AND p_organization_id IS NOT NULL) OR(p_operation='read' AND p_organization_id IS NULL) THEN RAISE EXCEPTION 'Invalid organization query' USING ERRCODE='22023';END IF;
  IF p_operation='list' THEN
   -- Keep listed grants live through the query without taking workspace locks.
   PERFORM g.id FROM fountain_private.organization_owner_grants g JOIN fountain_private.organization_registry o ON o.id=g.organization_id WHERE g.user_id=uid AND g.closed_at IS NULL AND o.status='active' ORDER BY g.organization_id FOR SHARE OF g;
   SELECT count(*) INTO counted FROM fountain_private.organization_owner_grants g JOIN fountain_private.organization_registry o ON o.id=g.organization_id WHERE g.user_id=uid AND g.closed_at IS NULL AND o.status='active';
   IF counted>100 THEN RAISE EXCEPTION 'Organization list limit' USING ERRCODE='PT413';END IF;
   SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',o.id,'name',o.name,'revision',o.revision,'grantId',g.id) ORDER BY o.id),'[]'::jsonb) INTO answer
   FROM fountain_private.organization_owner_grants g JOIN fountain_private.organization_registry o ON o.id=g.organization_id WHERE g.user_id=uid AND g.closed_at IS NULL AND o.status='active';
   RETURN jsonb_build_object('organizations',answer);
  END IF;
  org:=fountain_private.organization_lock(p_organization_id);gid:=fountain_private.organization_owner(p_organization_id,uid);
  RETURN jsonb_build_object('organizationId',org.id,'name',org.name,'revision',org.revision,
   'owners',(SELECT COALESCE(jsonb_agg(jsonb_build_object('grantId',g.id,'userId',g.user_id,'grantedAt',g.granted_at) ORDER BY g.id),'[]'::jsonb) FROM fountain_private.organization_owner_grants g WHERE g.organization_id=org.id AND g.closed_at IS NULL),
   'workspaces',(SELECT COALESCE(jsonb_agg(jsonb_build_object('linkId',l.id,'workspaceId',l.workspace_id,'linkedAt',l.linked_at) ORDER BY l.id),'[]'::jsonb) FROM fountain_private.organization_workspace_links l WHERE l.organization_id=org.id AND l.detached_at IS NULL),
   'events',(SELECT COALESCE(jsonb_agg(x.item ORDER BY x.revision),'[]'::jsonb) FROM(SELECT e.revision,jsonb_build_object('id',e.id,'revision',e.revision,'action',e.action,'actorKind',e.actor_kind,'actorGrantId',e.actor_grant_id,'occurredAt',e.occurred_at,'details',e.details) item FROM fountain_private.organization_events e WHERE e.organization_id=org.id ORDER BY e.revision DESC LIMIT 100)x));
 END IF;
 IF p_organization_id IS NULL OR p_command_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Invalid organization command' USING ERRCODE='22023';END IF;
 -- Validate the exact operation payload before interpreting a prior receipt.
 CASE p_operation
 WHEN 'rename' THEN
  IF NOT(p_value ? 'name') OR p_value-'name'<>'{}'::jsonb OR jsonb_typeof(p_value->'name') IS DISTINCT FROM 'string' OR length(btrim(p_value->>'name')) NOT BETWEEN 1 AND 200 OR octet_length(p_value->>'name')>800 THEN RAISE EXCEPTION 'Invalid organization name' USING ERRCODE='22023';END IF;
 WHEN 'owner_grant' THEN
  IF NOT(p_value ? 'userId') OR p_value-'userId'<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid owner target' USING ERRCODE='22023';END IF;
  target:=fountain_private.organization_uuid(p_value->'userId');
 WHEN 'owner_revoke' THEN
  IF NOT(p_value ? 'grantId') OR p_value-'grantId'<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid owner grant' USING ERRCODE='22023';END IF;
  target:=fountain_private.organization_uuid(p_value->'grantId');
 WHEN 'link_request' THEN
  IF NOT(p_value ?& ARRAY['workspaceId','nonceHash','expiresAtMs']) OR p_value-ARRAY['workspaceId','nonceHash','expiresAtMs']<>'{}'::jsonb
   OR jsonb_typeof(p_value->'workspaceId') IS DISTINCT FROM 'string' OR length(p_value->>'workspaceId') NOT BETWEEN 1 AND 160
   OR jsonb_typeof(p_value->'nonceHash') IS DISTINCT FROM 'string' OR(p_value->>'nonceHash') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(p_value->'expiresAtMs') IS DISTINCT FROM 'number' OR(p_value->>'expiresAtMs') !~ '^[0-9]{1,16}$' OR(p_value->>'expiresAtMs')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Invalid workspace link request' USING ERRCODE='22023';END IF;
  expires:=to_timestamp((p_value->>'expiresAtMs')::numeric/1000);
 WHEN 'link_detach' THEN
  IF NOT(p_value ? 'linkId') OR p_value-'linkId'<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid workspace link' USING ERRCODE='22023';END IF;
  target:=fountain_private.organization_uuid(p_value->'linkId');
 END CASE;
 org:=fountain_private.organization_lock(p_organization_id);gid:=fountain_private.organization_owner(p_organization_id,uid);
 digest:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'organizationId',p_organization_id,'expectedRevision',p_expected_revision,'value',p_value)::text,'UTF8')),'hex');
 answer:=fountain_private.organization_receipt(p_organization_id,p_command_id,'grant:'||gid::text,digest);
 IF answer IS NOT NULL THEN RETURN answer;END IF;
 IF org.revision<>p_expected_revision THEN RAISE EXCEPTION 'Organization revision changed' USING ERRCODE='PT409';END IF;
 CASE p_operation
 WHEN 'rename' THEN
  changed:=org.name IS DISTINCT FROM p_value->>'name';
  IF changed THEN UPDATE fountain_private.organization_registry SET name=p_value->>'name' WHERE id=org.id;END IF;
  details:=jsonb_build_object('name',p_value->>'name');
 WHEN 'owner_grant' THEN
  IF NOT fountain_private.organization_usable_user(target) THEN RAISE EXCEPTION 'Owner target unavailable' USING ERRCODE='PT403';END IF;
  SELECT id INTO target FROM fountain_private.organization_owner_grants WHERE organization_id=org.id AND user_id=target AND closed_at IS NULL;
  IF NOT FOUND THEN
   SELECT count(*) INTO counted FROM fountain_private.organization_owner_grants WHERE organization_id=org.id AND closed_at IS NULL;
   IF counted>=100 THEN RAISE EXCEPTION 'Organization owner limit' USING ERRCODE='PT413';END IF;
   INSERT INTO fountain_private.organization_owner_grants(organization_id,user_id,granted_by) VALUES(org.id,fountain_private.organization_uuid(p_value->'userId'),gid) RETURNING id INTO target;
   changed:=true;
  END IF;
  details:=jsonb_build_object('grantId',target);extra:=details;
 WHEN 'owner_revoke' THEN
  SELECT * INTO target_grant FROM fountain_private.organization_owner_grants WHERE organization_id=org.id AND id=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner grant not found' USING ERRCODE='PT404';END IF;
  IF target_grant.closed_at IS NULL THEN
   -- Lock every surviving candidate Auth row under the organization writer lock.
   -- External bans/deletion are never blocked by a trigger; absence fails closed.
   FOR entry IN SELECT g.user_id FROM fountain_private.organization_owner_grants g WHERE g.organization_id=org.id AND g.closed_at IS NULL AND g.id<>target ORDER BY g.user_id LOOP
    IF fountain_private.organization_usable_user(entry.user_id) THEN usable:=usable+1;END IF;
   END LOOP;
   IF usable=0 THEN RAISE EXCEPTION 'Last usable organization owner' USING ERRCODE='PT409';END IF;
   UPDATE fountain_private.organization_owner_grants SET closed_at=clock_timestamp(),closed_by=gid WHERE organization_id=org.id AND id=target;
   changed:=true;
  END IF;
  details:=jsonb_build_object('grantId',target);extra:=details;
 WHEN 'link_request' THEN
  stamp:=clock_timestamp();
  IF expires<=stamp OR expires>stamp+interval '15 minutes' THEN RAISE EXCEPTION 'Invalid workspace link expiry' USING ERRCODE='22023';END IF;
  IF org.revision>=9007199254740991 THEN RAISE EXCEPTION 'Organization revision exhausted' USING ERRCODE='PT413';END IF;
  -- Historical and expired requests remain evidence; bound only live requests.
  SELECT count(*) INTO counted FROM fountain_private.organization_link_requests WHERE organization_id=org.id AND consumed_at IS NULL AND expires_at>stamp;
  IF counted>=100 THEN RAISE EXCEPTION 'Workspace link request limit' USING ERRCODE='PT413';END IF;
  INSERT INTO fountain_private.organization_link_requests(organization_id,workspace_id,initiator_grant_id,requested_revision,nonce_hash,created_at,expires_at)
   VALUES(org.id,p_value->>'workspaceId',gid,org.revision+1,p_value->>'nonceHash',stamp,expires) RETURNING id INTO request;
  changed:=true;details:=jsonb_build_object('requestId',request,'workspaceId',p_value->>'workspaceId');extra:=details||jsonb_build_object('expiresAt',expires);
 WHEN 'link_detach' THEN
  SELECT * INTO link FROM fountain_private.organization_workspace_links WHERE organization_id=org.id AND id=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace link not found' USING ERRCODE='PT404';END IF;
  IF link.detached_at IS NULL THEN UPDATE fountain_private.organization_workspace_links SET detached_at=clock_timestamp(),detached_by=gid WHERE organization_id=org.id AND id=target;changed:=true;END IF;
  details:=jsonb_build_object('linkId',target,'workspaceId',link.workspace_id);extra:=jsonb_build_object('linkId',target);
 END CASE;
 RETURN fountain_private.organization_record(org.id,p_command_id,'grant:'||gid::text,digest,uid,gid,p_operation,details,changed,extra);
END $f$;

CREATE FUNCTION public.fountain_cloud_organization_link_accept(p_context jsonb,p_organization_id uuid,p_request_id uuid,p_expected_revision bigint,p_nonce text,p_command_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE member jsonb;ws text;uid uuid;org fountain_private.organization_registry;request fountain_private.organization_link_requests;initiator fountain_private.organization_owner_grants;
 digest text;actor text;answer jsonb;link uuid;counted integer;
BEGIN
 -- All cross-domain mutations take workspace writer before organization writer.
 member:=fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';uid:=(p_context->>'userId')::uuid;
 IF member->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Workspace owner required' USING ERRCODE='PT403';END IF;
 -- The older workspace context also has legacy compatibility modes. Organization
 -- consent additionally requires confirmed identity-only live Auth validation.
 PERFORM fountain_private.organization_identity(jsonb_build_object('userId',p_context->'userId','authSessionId',p_context->'authSessionId'));
 IF p_organization_id IS NULL OR p_request_id IS NULL OR p_command_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid workspace consent' USING ERRCODE='22023';END IF;
 org:=fountain_private.organization_lock(p_organization_id);
 SELECT * INTO request FROM fountain_private.organization_link_requests WHERE organization_id=org.id AND id=p_request_id;
 IF NOT FOUND OR request.workspace_id<>ws OR request.nonce_hash<>encode(sha256(convert_to(p_nonce,'UTF8')),'hex') THEN RAISE EXCEPTION 'Workspace consent rejected' USING ERRCODE='PT403';END IF;
 SELECT * INTO initiator FROM fountain_private.organization_owner_grants WHERE organization_id=org.id AND id=request.initiator_grant_id AND closed_at IS NULL;
 IF NOT FOUND OR org.status<>'active' THEN RAISE EXCEPTION 'Organization initiator unavailable' USING ERRCODE='PT403';END IF;
 IF NOT fountain_private.organization_usable_user(initiator.user_id) THEN RAISE EXCEPTION 'Organization initiator unavailable' USING ERRCODE='PT403';END IF;
 actor:='workspace:'||ws||':'||uid::text;
 digest:=encode(sha256(convert_to(jsonb_build_object('operation','link_accept','organizationId',org.id,'requestId',request.id,'workspaceId',ws,'expectedRevision',p_expected_revision,'userId',uid,'memberId',p_context->>'memberId')::text,'UTF8')),'hex');
 answer:=fountain_private.organization_receipt(org.id,p_command_id,actor,digest);
 IF answer IS NOT NULL THEN
  IF request.consumed_command_id IS DISTINCT FROM p_command_id OR NOT EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE organization_id=org.id AND id=request.link_id AND detached_at IS NULL) THEN RAISE EXCEPTION 'Workspace consent no longer active' USING ERRCODE='PT403';END IF;
  RETURN answer;
 END IF;
 IF request.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'Workspace consent consumed' USING ERRCODE='PT409';END IF;
 IF request.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Workspace consent expired' USING ERRCODE='PT403';END IF;
 IF org.revision<>p_expected_revision OR request.requested_revision<>p_expected_revision THEN RAISE EXCEPTION 'Workspace consent revision changed' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE workspace_id=ws AND detached_at IS NULL) THEN RAISE EXCEPTION 'Workspace already belongs to an organization' USING ERRCODE='PT409';END IF;
 SELECT count(*) INTO counted FROM fountain_private.organization_workspace_links WHERE organization_id=org.id AND detached_at IS NULL;
 IF counted>=128 THEN RAISE EXCEPTION 'Organization workspace limit' USING ERRCODE='PT413';END IF;
 INSERT INTO fountain_private.organization_workspace_links(organization_id,workspace_id,request_id,accepted_by_user_id,accepted_by_member_id)
 VALUES(org.id,ws,request.id,uid,p_context->>'memberId') RETURNING id INTO link;
 UPDATE fountain_private.organization_link_requests SET consumed_at=clock_timestamp(),consumed_command_id=p_command_id,link_id=link WHERE organization_id=org.id AND id=request.id;
 RETURN fountain_private.organization_record(org.id,p_command_id,actor,digest,uid,initiator.id,'link_accept',jsonb_build_object('linkId',link,'requestId',request.id,'workspaceId',ws,'memberId',p_context->>'memberId'),true,jsonb_build_object('linkId',link,'workspaceId',ws));
END $f$;
ALTER FUNCTION fountain_private.organization_uuid(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_uuid(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_identity(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_identity(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_usable_user(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_usable_user(uuid) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_lock(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_lock(uuid) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_owner(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_owner(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_receipt(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_receipt(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_record(uuid,uuid,text,text,uuid,uuid,text,jsonb,boolean,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_record(uuid,uuid,text,text,uuid,uuid,text,jsonb,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_immutable() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_history_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_history_guard() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_bootstrap_prepare(uuid,text,uuid,text,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_bootstrap_prepare(uuid,text,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION public.fountain_cloud_organization_bootstrap_accept(jsonb,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_organization_bootstrap_accept(jsonb,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_organization_bootstrap_accept(jsonb,uuid,text,uuid) TO service_role;
ALTER FUNCTION public.fountain_cloud_organization_rpc(jsonb,uuid,text,bigint,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_organization_rpc(jsonb,uuid,text,bigint,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_organization_rpc(jsonb,uuid,text,bigint,uuid,jsonb) TO service_role;
ALTER FUNCTION public.fountain_cloud_organization_link_accept(jsonb,uuid,uuid,bigint,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_organization_link_accept(jsonb,uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_organization_link_accept(jsonb,uuid,uuid,bigint,text,uuid) TO service_role;
