-- Service-only explicit setup; never first-signup owner.
-- Depends on the reviewed cloud Auth/store migrations. Root alone inserts an
-- initial purpose=bootstrap hash for fixed member_id='local'; plaintext nonce,
-- Auth JWT/refresh/password/session cookie are never columns or SQL parameters.
CREATE TABLE fountain_cloud.onboarding_claims (
 workspace_id text NOT NULL,
 nonce_hash text NOT NULL CHECK (length(nonce_hash)=64 AND nonce_hash ~ '^[a-f0-9]{64}$'),
 member_id text NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('bootstrap','invite')),
 issuer_user_id uuid,
 issuer_member_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 used_auth_user_id uuid, -- no cascading FK: deleting an Auth user must not reuse a claim
 used_at timestamptz,
 PRIMARY KEY(workspace_id,nonce_hash),
 CHECK(length(workspace_id) BETWEEN 1 AND 160 AND length(member_id) BETWEEN 1 AND 160),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
 CHECK((used_auth_user_id IS NULL)=(used_at IS NULL)),
 CHECK(purpose<>'bootstrap' OR member_id='local' AND issuer_user_id IS NULL AND issuer_member_id IS NULL),
 CHECK(purpose<>'invite' OR issuer_user_id IS NOT NULL AND issuer_member_id IS NOT NULL)
);
ALTER TABLE fountain_cloud.onboarding_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.onboarding_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.onboarding_claims FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.onboarding_claim(p_workspace_id text,p_nonce_hash text,p_user_id uuid,p_auth_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claim fountain_cloud.onboarding_claims;member fountain_private.entities;linked text;profile jsonb;revision bigint;global_revision bigint;
BEGIN
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR p_nonce_hash IS NULL OR length(p_nonce_hash)<>64 OR p_nonce_hash !~ '^[a-f0-9]{64}$' OR p_user_id IS NULL OR p_auth_session_id IS NULL THEN
  RAISE EXCEPTION 'Invalid setup' USING ERRCODE='22023'; END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);
 PERFORM set_config('fountain.workspace_id',p_workspace_id,true);
 -- A decoded JWT/user_metadata/email is never sufficient authority.
 PERFORM 1 FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
 WHERE s.id=p_auth_session_id AND s.user_id=p_user_id AND u.deleted_at IS NULL
  AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
  AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
  AND (s.not_after IS NULL OR s.not_after>clock_timestamp()) FOR SHARE OF s,u;
 IF NOT FOUND THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
 SELECT * INTO claim FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=p_workspace_id AND c.nonce_hash=p_nonce_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
 IF claim.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Setup expired' USING ERRCODE='PT410'; END IF;
 SELECT * INTO member FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='member' AND e.id=claim.member_id FOR SHARE;
 IF NOT FOUND OR member.data->>'id' IS DISTINCT FROM member.id OR COALESCE(member.data->'active','true'::jsonb)<>'true'::jsonb
  OR jsonb_typeof(member.data->'role') IS DISTINCT FROM 'string' OR NOT COALESCE(member.data->>'role' IN ('owner','admin','member','guest'),false)
  OR jsonb_typeof(member.data->'name') IS DISTINCT FROM 'string' OR length(member.data->>'name') NOT BETWEEN 1 AND 1000
  OR jsonb_typeof(member.data->'email') IS DISTINCT FROM 'string' OR length(member.data->>'email')>1000 THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
 IF claim.purpose='bootstrap' THEN
  IF member.id<>'local' OR member.data->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
 ELSIF claim.purpose='invite' THEN
  -- Invite endpoints cannot manufacture an additional owner claim.
  IF member.data->>'role'='owner' THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
  -- Auth Admin bans/deletion do not take the workspace advisory lock. Keep the
  -- issuer identity rows locked until mapping+nonce consumption commits.
  PERFORM 1 FROM fountain_private.identity_mapping m JOIN fountain_private.entities e ON e.workspace_id=m.workspace_id AND e.kind='member' AND e.id=m.member_id
   JOIN auth.users u ON u.id=m.auth_user_id WHERE m.workspace_id=p_workspace_id AND m.auth_user_id=claim.issuer_user_id AND m.member_id=claim.issuer_member_id
    AND e.data->>'id'=e.id AND e.data->>'role'='owner' AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
    AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) FOR SHARE OF m,e,u;
  IF NOT FOUND THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
 END IF;
 SELECT m.member_id INTO linked FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.auth_user_id=p_user_id FOR SHARE;
 IF claim.used_auth_user_id IS NOT NULL THEN
  IF claim.used_auth_user_id<>p_user_id OR linked IS DISTINCT FROM claim.member_id THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
  RETURN jsonb_build_object('workspace_id',p_workspace_id,'member_id',claim.member_id,'replayed',true);
 END IF;
 IF linked IS NOT NULL OR EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=claim.member_id)
  OR claim.purpose='bootstrap' AND EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id) THEN
  RAISE EXCEPTION 'Setup conflict' USING ERRCODE='PT409'; END IF;
 INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id) VALUES(p_workspace_id,p_user_id,claim.member_id);
 UPDATE fountain_cloud.onboarding_claims c SET used_auth_user_id=p_user_id,used_at=clock_timestamp() WHERE c.workspace_id=p_workspace_id AND c.nonce_hash=p_nonce_hash AND c.used_auth_user_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Setup conflict' USING ERRCODE='PT409'; END IF;
 revision:=fountain_cloud.store_revision(p_workspace_id,'access_revision');
 global_revision:=fountain_cloud.store_revision(p_workspace_id,'_entity_revision');
 IF revision>=9007199254740991 OR global_revision>=9007199254740991 THEN RAISE EXCEPTION 'Revision limit' USING ERRCODE='PT413'; END IF;
 INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(p_workspace_id,'access_revision',to_jsonb(revision+1)) ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(p_workspace_id,'_entity_revision',to_jsonb(global_revision+1)) ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 RETURN jsonb_build_object('workspace_id',p_workspace_id,'member_id',claim.member_id,'replayed',false);
END $$;
ALTER FUNCTION fountain_cloud.onboarding_claim(text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.onboarding_claim(text,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.onboarding_claim(text,text,uuid,uuid) TO service_role;

CREATE FUNCTION fountain_cloud.onboarding_invite(p_context jsonb,p_member_id text,p_nonce_hash text,p_expires_at_ms bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal jsonb;ws text;expires timestamptz;member fountain_private.entities;
BEGIN
 principal:=fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 IF principal->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='PT403'; END IF;
 IF p_member_id IS NULL OR length(p_member_id) NOT BETWEEN 1 AND 160 OR p_nonce_hash IS NULL OR length(p_nonce_hash)<>64 OR p_nonce_hash !~ '^[a-f0-9]{64}$'
  OR p_expires_at_ms IS NULL OR p_expires_at_ms NOT BETWEEN 0 AND 8640000000000000 THEN RAISE EXCEPTION 'Invalid invite' USING ERRCODE='22023'; END IF;
 expires:=to_timestamp(p_expires_at_ms/1000.0);
 IF expires<=clock_timestamp() OR expires>clock_timestamp()+interval '1 hour' THEN RAISE EXCEPTION 'Invalid expiry' USING ERRCODE='22023'; END IF;
 SELECT * INTO member FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='member' AND e.id=p_member_id FOR SHARE;
 IF NOT FOUND OR member.data->>'id' IS DISTINCT FROM member.id OR COALESCE(member.data->'active','true'::jsonb)<>'true'::jsonb
  OR jsonb_typeof(member.data->'role') IS DISTINCT FROM 'string' OR NOT COALESCE(member.data->>'role' IN ('admin','member','guest'),false)
  OR jsonb_typeof(member.data->'name') IS DISTINCT FROM 'string' OR length(member.data->>'name') NOT BETWEEN 1 AND 1000
  OR jsonb_typeof(member.data->'email') IS DISTINCT FROM 'string' OR length(member.data->>'email')>1000 THEN RAISE EXCEPTION 'Invite rejected' USING ERRCODE='PT403'; END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=ws AND m.member_id=p_member_id) THEN RAISE EXCEPTION 'Already linked' USING ERRCODE='PT409'; END IF;
 INSERT INTO fountain_cloud.onboarding_claims(workspace_id,nonce_hash,member_id,purpose,issuer_user_id,issuer_member_id,expires_at)
 VALUES(ws,p_nonce_hash,p_member_id,'invite',(p_context->>'userId')::uuid,principal->>'id',expires);
 RETURN jsonb_build_object('workspace_id',ws,'member_id',p_member_id,'expires_at_ms',p_expires_at_ms);
END $$;
ALTER FUNCTION fountain_cloud.onboarding_invite(jsonb,text,text,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.onboarding_invite(jsonb,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.onboarding_invite(jsonb,text,text,bigint) TO service_role;

CREATE FUNCTION public.fountain_cloud_onboarding_claim(p_workspace_id text,p_nonce_hash text,p_user_id uuid,p_auth_session_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.onboarding_claim(p_workspace_id,p_nonce_hash,p_user_id,p_auth_session_id) $$;
CREATE FUNCTION public.fountain_cloud_onboarding_invite(p_context jsonb,p_member_id text,p_nonce_hash text,p_expires_at_ms bigint) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.onboarding_invite(p_context,p_member_id,p_nonce_hash,p_expires_at_ms) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_onboarding_claim(text,text,uuid,uuid),public.fountain_cloud_onboarding_invite(jsonb,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_onboarding_claim(text,text,uuid,uuid),public.fountain_cloud_onboarding_invite(jsonb,text,text,bigint) TO service_role;
