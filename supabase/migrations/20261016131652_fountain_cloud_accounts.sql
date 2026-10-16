-- Trusted server authorization, not end-user RLS. Auth tables are SELECT-only:
-- create/password changes use official GoTrue Admin HTTP outside SQL transactions.
-- Protected app_metadata + preallocated UUID permit exact unknown-ACK recovery.
-- Never search/link by email, import legacy credentials, or delete an Auth user.

CREATE TABLE fountain_cloud.account_intents (
 workspace_id text NOT NULL,
 member_id text NOT NULL CHECK(length(member_id) BETWEEN 1 AND 160),
 id uuid NOT NULL,
 actor_id text NOT NULL,
 actor_user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('create','password')),
 state text NOT NULL CHECK(state IN ('prepared','attempted','done','cancelled','rejected')),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 nonce text NOT NULL CHECK(nonce ~ '^[a-f0-9]{32}$'),
 target_user_id uuid NOT NULL,
 relink boolean NOT NULL DEFAULT false,
 provider_email text NOT NULL CHECK(length(provider_email) BETWEEN 3 AND 254),
 prior_marker jsonb NOT NULL DEFAULT '{"account":null,"password":null}'::jsonb CHECK(jsonb_typeof(prior_marker)='object'
  AND prior_marker ?& ARRAY['account','password'] AND prior_marker-ARRAY['account','password']='{}'::jsonb
  AND jsonb_typeof(prior_marker->'account') IN ('null','string') AND jsonb_typeof(prior_marker->'password') IN ('null','string')
  AND octet_length(prior_marker::text)<=1024),
 target_snapshot jsonb NOT NULL CHECK(jsonb_typeof(target_snapshot)='object' AND octet_length(target_snapshot::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,member_id), UNIQUE(workspace_id,id)
);
ALTER TABLE fountain_cloud.account_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.account_intents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.account_intents FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX account_intents_auth_pending_idx ON fountain_cloud.account_intents(target_user_id)
 WHERE (kind='password' OR relink) AND state IN ('prepared','attempted');

-- Only an actual scoped unlink can establish this prior-UUID evidence. Neither
-- a browser-supplied email nor a user-editable metadata claim can create it.
CREATE TABLE fountain_cloud.account_unlinks (
 workspace_id text NOT NULL,member_id text NOT NULL,auth_user_id uuid NOT NULL,
 member_created_at text NOT NULL CHECK(length(member_created_at) BETWEEN 1 AND 64),member_email text NOT NULL CHECK(length(member_email)<=1000),provider_email text NOT NULL CHECK(length(provider_email) BETWEEN 3 AND 254),
 prior_marker jsonb NOT NULL CHECK(jsonb_typeof(prior_marker)='object' AND prior_marker ?& ARRAY['account','password']
  AND prior_marker-ARRAY['account','password']='{}'::jsonb AND jsonb_typeof(prior_marker->'account') IN ('null','string')
  AND jsonb_typeof(prior_marker->'password') IN ('null','string') AND octet_length(prior_marker::text)<=1024),PRIMARY KEY(workspace_id,member_id)
);
ALTER TABLE fountain_cloud.account_unlinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.account_unlinks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.account_unlinks FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.account_user_lock(p_user uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:auth-account:'||p_user::text,'UTF8')),'hex'),1,16))::bit(64)::bigint)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.account_user_lock(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Every writer, including onboarding RPCs, serializes mapping changes with the
-- durable Admin intent. A pending/unknown password request must not suddenly
-- acquire a foreign workspace while its global Auth password is being changed.
CREATE FUNCTION fountain_cloud.account_mapping_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Account mapping requires a current database snapshot' USING ERRCODE='PT503';
 END IF;
 IF TG_OP='UPDATE' AND OLD.auth_user_id<>NEW.auth_user_id THEN
  PERFORM fountain_cloud.account_user_lock(LEAST(OLD.auth_user_id,NEW.auth_user_id));
  PERFORM fountain_cloud.account_user_lock(GREATEST(OLD.auth_user_id,NEW.auth_user_id));
 ELSIF TG_OP='DELETE' THEN PERFORM fountain_cloud.account_user_lock(OLD.auth_user_id);
 ELSE PERFORM fountain_cloud.account_user_lock(NEW.auth_user_id);END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF EXISTS(SELECT 1 FROM fountain_cloud.account_intents i
  WHERE i.target_user_id=NEW.auth_user_id AND (i.kind='password' OR i.relink) AND i.state IN ('prepared','attempted')
   AND (i.workspace_id<>NEW.workspace_id OR i.member_id<>NEW.member_id)) THEN
  RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION fountain_cloud.account_mapping_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.account_mapping_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fountain_account_mapping_guard BEFORE INSERT OR UPDATE OR DELETE ON fountain_private.identity_mapping
 FOR EACH ROW EXECUTE FUNCTION fountain_cloud.account_mapping_guard();

CREATE FUNCTION fountain_cloud.account_safe(p_member jsonb,p_linked boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p_member->>'id','name',p_member->>'name','email',p_member->>'email',
  'role',p_member->>'role','active',COALESCE(p_member->'active','true'::jsonb),'has_account',p_linked)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.account_safe(jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.account_touch(p_workspace_id text,p_actor text,p_target text,p_action text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r bigint; a bigint; stamp text; event_id text;
BEGIN
 r:=fountain_cloud.store_revision(p_workspace_id,'_entity_revision');a:=fountain_cloud.store_revision(p_workspace_id,'access_revision');
 IF r>9007199254740989 OR a>=9007199254740991 THEN RAISE EXCEPTION 'Revision limit' USING ERRCODE='PT413'; END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00';event_id:=gen_random_uuid()::text;
 INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at)
 VALUES(p_workspace_id,'audit',event_id,jsonb_build_object('id',event_id,'actor',p_actor,'action',p_action,'details',jsonb_build_object('member_id',p_target),'created_at',stamp,'updated_at',stamp),stamp,stamp);
 INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(p_workspace_id,'_entity_revision',to_jsonb(r+2)),(p_workspace_id,'access_revision',to_jsonb(a+1))
 ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.account_touch(text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.account_revoke(p_workspace_id text,p_user_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE fountain_cloud.session_vault SET revoked_at_ms=GREATEST(created_at_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint),
  logout_pending=(token_ciphertext IS NOT NULL),version=version+1,refresh_lease_id=NULL,refresh_lease_until_ms=NULL
 WHERE workspace_id=p_workspace_id AND user_id=p_user_id AND revoked_at_ms IS NULL AND version<9007199254740991;
 IF EXISTS(SELECT 1 FROM fountain_cloud.session_vault WHERE workspace_id=p_workspace_id AND user_id=p_user_id AND revoked_at_ms IS NULL) THEN
  RAISE EXCEPTION 'Vault version limit' USING ERRCODE='PT503';
 END IF;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.account_revoke(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.accounts(p_context jsonb,p_action text,p_member_id text DEFAULT NULL,p_kind text DEFAULT NULL,
 p_digest text DEFAULT NULL,p_intent_id uuid DEFAULT NULL,p_nonce text DEFAULT NULL,p_user_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor jsonb;ws text;member jsonb;linked uuid;entry fountain_cloud.account_intents;old_found boolean;claimed boolean:=false;
 result jsonb;user_row auth.users;count_members bigint;prior fountain_cloud.account_unlinks;is_relink boolean:=false;provider_email text;prior_marker jsonb;
BEGIN
 actor:=fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 IF actor->>'role'<>'owner' OR actor->'active' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='PT403'; END IF;
 IF p_action IN ('list','enable') THEN
  IF p_action='enable' THEN RETURN jsonb_build_object('required',true,'mode','accounts'); END IF;
  SELECT count(*) INTO count_members FROM fountain_private.entities WHERE workspace_id=ws AND kind='member';
  IF count_members>1000 THEN RAISE EXCEPTION 'Member limit' USING ERRCODE='PT413'; END IF;
  SELECT COALESCE(jsonb_agg(fountain_cloud.account_safe(e.data,m.auth_user_id IS NOT NULL) ORDER BY e.created_at,e.id),'[]'::jsonb)
   INTO result FROM fountain_private.entities e LEFT JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id
   WHERE e.workspace_id=ws AND e.kind='member';
  RETURN jsonb_build_object('accounts',result,'required',true);
 END IF;
 IF p_member_id IS NULL OR length(p_member_id) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Member required' USING ERRCODE='22023'; END IF;
 SELECT data INTO member FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND id=p_member_id FOR SHARE;
 IF NOT FOUND OR member->>'id' IS DISTINCT FROM p_member_id THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='PT404'; END IF;
 SELECT auth_user_id INTO linked FROM fountain_private.identity_mapping WHERE workspace_id=ws AND member_id=p_member_id FOR UPDATE;
 IF p_action='unlink' THEN
  -- Admin PUT may still be running outside this transaction. Unlink must not
  -- cancel its durable intent or release the global UUID mapping fence, even
  -- when a relink has not yet restored its local mapping. Unknown stays fenced.
  SELECT * INTO entry FROM fountain_cloud.account_intents WHERE workspace_id=ws AND member_id=p_member_id FOR UPDATE;
  IF FOUND AND (entry.kind='password' OR entry.relink) AND entry.state IN ('prepared','attempted') THEN
   PERFORM fountain_cloud.account_user_lock(entry.target_user_id);
   RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';
  END IF;
  IF linked IS NULL THEN RAISE EXCEPTION 'Account not found' USING ERRCODE='PT404'; END IF;
  PERFORM fountain_cloud.account_user_lock(linked);
  SELECT * INTO user_row FROM auth.users WHERE id=linked AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND OR user_row.email IS NULL THEN RAISE EXCEPTION 'Auth account not found' USING ERRCODE='PT409';END IF;
  -- Check the final usable Auth-owner set, not a legacy password or unlinked role.
  IF member->>'role'='owner' THEN
   PERFORM 1 FROM fountain_private.entities e JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id
    JOIN auth.users u ON u.id=m.auth_user_id
   WHERE e.workspace_id=ws AND e.kind='member' AND e.id<>p_member_id AND e.data->>'role'='owner' AND e.data->>'id'=e.id
    AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
    AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
    AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   ORDER BY u.id FOR SHARE OF e,m,u;
   IF NOT FOUND THEN RAISE EXCEPTION 'LAST_OWNER_ACCOUNT' USING ERRCODE='PT409'; END IF;
  END IF;
  INSERT INTO fountain_cloud.account_unlinks(workspace_id,member_id,auth_user_id,member_created_at,member_email,provider_email,prior_marker)
   VALUES(ws,p_member_id,linked,member->>'created_at',member->>'email',user_row.email,
    jsonb_build_object('account',user_row.raw_app_meta_data->'fountain_account_intent','password',user_row.raw_app_meta_data->'fountain_password_intent'))
  ON CONFLICT(workspace_id,member_id) DO UPDATE SET auth_user_id=EXCLUDED.auth_user_id,member_created_at=EXCLUDED.member_created_at,
   member_email=EXCLUDED.member_email,provider_email=EXCLUDED.provider_email,prior_marker=EXCLUDED.prior_marker;
  UPDATE fountain_cloud.account_intents SET state='cancelled' WHERE workspace_id=ws AND member_id=p_member_id AND state NOT IN ('prepared','attempted');
  DELETE FROM fountain_private.identity_mapping WHERE workspace_id=ws AND member_id=p_member_id AND auth_user_id=linked;
  PERFORM fountain_cloud.account_revoke(ws,linked);
  PERFORM fountain_cloud.account_touch(ws,actor->>'id',p_member_id,'account.removed');
  RETURN fountain_cloud.account_safe(member,false);
 END IF;
 IF COALESCE(member->'active','true'::jsonb)<>'true'::jsonb OR member->>'role' IS NULL OR member->>'role' NOT IN ('owner','admin','member','guest')
  OR jsonb_typeof(member->'email') IS DISTINCT FROM 'string' OR member->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  OR length(member->>'email')>254 OR jsonb_typeof(member->'name') IS DISTINCT FROM 'string' THEN
  RAISE EXCEPTION 'Active member with email required' USING ERRCODE='PT404';
 END IF;
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_intent_id IS NULL THEN RAISE EXCEPTION 'Intent required' USING ERRCODE='22023'; END IF;
 SELECT * INTO entry FROM fountain_cloud.account_intents WHERE workspace_id=ws AND member_id=p_member_id FOR UPDATE;old_found:=FOUND;
 IF p_action='begin' THEN
  IF p_kind NOT IN ('create','password') OR p_kind IS NULL OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{32}$' OR p_user_id IS NULL THEN RAISE EXCEPTION 'Invalid intent' USING ERRCODE='22023'; END IF;
  IF old_found AND entry.state IN ('prepared','attempted') THEN
   IF entry.kind<>p_kind OR entry.request_digest<>p_digest OR entry.actor_id<>actor->>'id' OR entry.actor_user_id<>(p_context->>'userId')::uuid
    OR entry.target_snapshot IS DISTINCT FROM member THEN RAISE EXCEPTION 'ACCOUNT_RECOVERY_REQUIRED' USING ERRCODE='PT409'; END IF;
  ELSIF old_found AND entry.state='done' AND entry.kind=p_kind AND entry.request_digest=p_digest AND entry.actor_id=actor->>'id'
   AND entry.actor_user_id=(p_context->>'userId')::uuid AND entry.target_snapshot=member AND linked=entry.target_user_id THEN
   NULL; -- Exact acknowledged retry, no repeated Admin password/create request.
  ELSE
   IF p_kind='create' AND linked IS NOT NULL THEN RAISE EXCEPTION 'Account exists' USING ERRCODE='PT409'; END IF;
   IF p_kind='create' THEN
    SELECT * INTO prior FROM fountain_cloud.account_unlinks WHERE workspace_id=ws AND member_id=p_member_id;
    IF FOUND THEN
     IF prior.member_created_at IS DISTINCT FROM member->>'created_at' OR prior.member_email IS DISTINCT FROM member->>'email' THEN
      RAISE EXCEPTION 'Prior member identity changed' USING ERRCODE='PT409';END IF;
     p_user_id:=prior.auth_user_id;is_relink:=true;prior_marker:=prior.prior_marker;provider_email:=prior.provider_email;
    ELSE provider_email:=member->>'email';prior_marker:='{"account":null,"password":null}'::jsonb;END IF;
   END IF;
   IF p_kind='password' OR is_relink THEN
    p_user_id:=CASE WHEN is_relink THEN p_user_id ELSE linked END;
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'Account not found' USING ERRCODE='PT404'; END IF;
    PERFORM fountain_cloud.account_user_lock(p_user_id);
    IF EXISTS(SELECT 1 FROM fountain_cloud.account_intents WHERE target_user_id=p_user_id AND (kind='password' OR relink)
     AND state IN ('prepared','attempted') AND (workspace_id<>ws OR member_id<>p_member_id)) THEN RAISE EXCEPTION 'Other account intent pending' USING ERRCODE='PT409';END IF;
    IF NOT is_relink AND linked IS NULL THEN RAISE EXCEPTION 'Account not found' USING ERRCODE='PT404'; END IF;
    SELECT * INTO user_row FROM auth.users WHERE id=p_user_id AND deleted_at IS NULL AND NOT is_anonymous
     AND email_confirmed_at IS NOT NULL AND (banned_until IS NULL OR banned_until<=clock_timestamp()) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE='PT404'; END IF;
    IF is_relink THEN
     IF lower(user_row.email) IS DISTINCT FROM lower(provider_email) OR jsonb_build_object('account',user_row.raw_app_meta_data->'fountain_account_intent','password',user_row.raw_app_meta_data->'fountain_password_intent') IS DISTINCT FROM prior_marker THEN RAISE EXCEPTION 'Prior Auth identity changed' USING ERRCODE='PT409';END IF;
    ELSE provider_email:=user_row.email;prior_marker:=jsonb_build_object('account',user_row.raw_app_meta_data->'fountain_account_intent','password',user_row.raw_app_meta_data->'fountain_password_intent');END IF;
    IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE auth_user_id=p_user_id AND (is_relink OR workspace_id<>ws OR member_id<>p_member_id)) THEN RAISE EXCEPTION 'Shared account password cannot be reset here' USING ERRCODE='PT409'; END IF;
   ELSE
    IF EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'Auth UUID already exists' USING ERRCODE='PT409'; END IF;
   END IF;
   INSERT INTO fountain_cloud.account_intents(workspace_id,member_id,id,actor_id,actor_user_id,kind,state,request_digest,nonce,target_user_id,target_snapshot,relink,provider_email,prior_marker)
    VALUES(ws,p_member_id,p_intent_id,actor->>'id',(p_context->>'userId')::uuid,p_kind,'prepared',p_digest,p_nonce,p_user_id,member,is_relink,provider_email,prior_marker)
   ON CONFLICT(workspace_id,member_id) DO UPDATE SET id=EXCLUDED.id,actor_id=EXCLUDED.actor_id,actor_user_id=EXCLUDED.actor_user_id,kind=EXCLUDED.kind,state=EXCLUDED.state,
    request_digest=EXCLUDED.request_digest,nonce=EXCLUDED.nonce,target_user_id=EXCLUDED.target_user_id,target_snapshot=EXCLUDED.target_snapshot,relink=EXCLUDED.relink,provider_email=EXCLUDED.provider_email,prior_marker=EXCLUDED.prior_marker,created_at=clock_timestamp()
   RETURNING * INTO entry;
  END IF;
 ELSE
  IF NOT old_found OR entry.id<>p_intent_id OR entry.request_digest<>p_digest OR entry.actor_id<>actor->>'id'
   OR entry.actor_user_id<>(p_context->>'userId')::uuid OR entry.target_snapshot IS DISTINCT FROM member OR entry.state IN ('cancelled','rejected') THEN
   RAISE EXCEPTION 'ACCOUNT_RECOVERY_REQUIRED' USING ERRCODE='PT409';
  END IF;
 END IF;
 -- Re-check current mapping and cross-workspace scope at EVERY external phase.
 IF entry.kind='create' AND (entry.state<>'done' AND linked IS NOT NULL OR entry.state='done' AND linked IS DISTINCT FROM entry.target_user_id)
  OR entry.kind='password' AND linked IS DISTINCT FROM entry.target_user_id THEN RAISE EXCEPTION 'Mapping changed' USING ERRCODE='PT409'; END IF;
 IF entry.kind='password' OR entry.relink THEN
  PERFORM fountain_cloud.account_user_lock(entry.target_user_id);
  IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE auth_user_id=entry.target_user_id AND (workspace_id<>ws OR member_id<>p_member_id)) THEN RAISE EXCEPTION 'Shared account' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM auth.users WHERE id=entry.target_user_id AND deleted_at IS NULL AND lower(email)=lower(entry.provider_email) AND NOT is_anonymous
   AND email_confirmed_at IS NOT NULL AND (banned_until IS NULL OR banned_until<=clock_timestamp()) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auth target changed' USING ERRCODE='PT409'; END IF;
 END IF;
 IF p_action='claim' THEN
  IF entry.state='prepared' THEN UPDATE fountain_cloud.account_intents SET state='attempted' WHERE workspace_id=ws AND member_id=p_member_id;claimed:=true; END IF;
  RETURN jsonb_build_object('claimed',claimed);
 ELSIF p_action='check' THEN
  IF entry.state<>'attempted' THEN RAISE EXCEPTION 'Intent is not pending' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('valid',true);
 ELSIF p_action='reject' THEN
  IF entry.state<>'attempted' THEN RAISE EXCEPTION 'Intent not attempted' USING ERRCODE='PT409';END IF;
  -- Called only after a definite Admin 400/422, never a lost/timeout/5xx result.
  UPDATE fountain_cloud.account_intents SET state='rejected' WHERE workspace_id=ws AND member_id=p_member_id;
  RETURN jsonb_build_object('rejected',true);
 ELSIF p_action='finish' THEN
  IF entry.state='done' THEN RETURN fountain_cloud.account_safe(member,true); END IF;
  IF entry.state<>'attempted' THEN RAISE EXCEPTION 'Intent not attempted' USING ERRCODE='PT409'; END IF;
  -- Read-only Auth evidence: SHARE blocks Admin UPDATE through this RPC while
  -- staying compatible with onboarding's user SHARE -> mapping-trigger order.
  SELECT * INTO user_row FROM auth.users WHERE id=entry.target_user_id FOR SHARE;
  IF NOT FOUND OR user_row.deleted_at IS NOT NULL OR user_row.is_anonymous OR user_row.email_confirmed_at IS NULL
   OR user_row.banned_until>clock_timestamp() OR lower(user_row.email) IS DISTINCT FROM lower(entry.provider_email)
   OR user_row.raw_app_meta_data->>(CASE WHEN entry.kind='create' THEN 'fountain_account_intent' ELSE 'fountain_password_intent' END) IS DISTINCT FROM entry.nonce THEN
   RAISE EXCEPTION 'Protected Auth intent not verified' USING ERRCODE='PT409';
  END IF;
  IF entry.kind='create' THEN
   IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE auth_user_id=entry.target_user_id) THEN RAISE EXCEPTION 'Auth UUID already linked' USING ERRCODE='PT409'; END IF;
   INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id) VALUES(ws,entry.target_user_id,p_member_id);
  END IF;
  IF entry.kind='password' OR entry.relink THEN PERFORM fountain_cloud.account_revoke(ws,entry.target_user_id);END IF;
  DELETE FROM fountain_cloud.account_unlinks WHERE workspace_id=ws AND member_id=p_member_id;
  UPDATE fountain_cloud.account_intents SET state='done' WHERE workspace_id=ws AND member_id=p_member_id;
  PERFORM fountain_cloud.account_touch(ws,actor->>'id',p_member_id,CASE WHEN entry.kind='create' THEN 'account.created' ELSE 'account.password.changed' END);
  RETURN fountain_cloud.account_safe(member,true);
 ELSIF p_action<>'begin' THEN RAISE EXCEPTION 'Unsupported account action' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('id',entry.id,'kind',entry.kind,'state',entry.state,'userId',entry.target_user_id,'nonce',entry.nonce,'digest',entry.request_digest,'relink',entry.relink,'providerEmail',entry.provider_email,'priorMarker',entry.prior_marker,'member',fountain_cloud.account_safe(member,linked IS NOT NULL));
END $$;
ALTER FUNCTION fountain_cloud.accounts(jsonb,text,text,text,text,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.accounts(jsonb,text,text,text,text,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.accounts(jsonb,text,text,text,text,uuid,text,uuid) TO service_role;

-- Denial-only capability: an Admin password attempt can end the caller's Auth
-- session before its final owner check. This never authorizes/links/changes Auth.
CREATE FUNCTION fountain_cloud.account_revoke_attempt(p_context jsonb,p_member_id text,p_intent_id uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE entry fountain_cloud.account_intents;ws text;
BEGIN
 ws:=p_context->>'workspaceId';IF ws IS NULL OR length(ws) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid workspace' USING ERRCODE='22023'; END IF;
 PERFORM fountain_cloud.store_lock(ws);
 SELECT * INTO entry FROM fountain_cloud.account_intents WHERE workspace_id=ws AND member_id=p_member_id FOR UPDATE;
 IF NOT FOUND OR (entry.kind<>'password' AND NOT entry.relink) OR entry.state NOT IN ('attempted','done') OR entry.id IS DISTINCT FROM p_intent_id
  OR entry.request_digest IS DISTINCT FROM p_digest OR entry.actor_id IS DISTINCT FROM p_context->>'memberId'
  OR entry.actor_user_id::text IS DISTINCT FROM p_context->>'userId' THEN RAISE EXCEPTION 'Invalid revocation capability' USING ERRCODE='PT403'; END IF;
 PERFORM fountain_cloud.account_user_lock(entry.target_user_id);
 PERFORM fountain_cloud.account_revoke(ws,entry.target_user_id);
 RETURN jsonb_build_object('revoked',true);
END $$;
ALTER FUNCTION fountain_cloud.account_revoke_attempt(jsonb,text,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.account_revoke_attempt(jsonb,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.account_revoke_attempt(jsonb,text,uuid,text) TO service_role;

CREATE FUNCTION public.fountain_cloud_accounts(p_context jsonb,p_action text,p_member_id text DEFAULT NULL,p_kind text DEFAULT NULL,p_digest text DEFAULT NULL,p_intent_id uuid DEFAULT NULL,p_nonce text DEFAULT NULL,p_user_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.accounts(p_context,p_action,p_member_id,p_kind,p_digest,p_intent_id,p_nonce,p_user_id) $$;
CREATE FUNCTION public.fountain_cloud_account_revoke_attempt(p_context jsonb,p_member_id text,p_intent_id uuid,p_digest text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.account_revoke_attempt(p_context,p_member_id,p_intent_id,p_digest) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_accounts(jsonb,text,text,text,text,uuid,text,uuid),public.fountain_cloud_account_revoke_attempt(jsonb,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_accounts(jsonb,text,text,text,text,uuid,text,uuid),public.fountain_cloud_account_revoke_attempt(jsonb,text,uuid,text) TO service_role;
