-- Private encrypted Supabase Auth sessions; public RPCs are service-role only.
-- Apply atomically: every exposed wrapper loses PUBLIC EXECUTE before commit.

CREATE SCHEMA IF NOT EXISTS fountain_cloud AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA fountain_cloud FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA fountain_cloud TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA fountain_cloud REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

CREATE FUNCTION fountain_cloud.valid_token_cipher(p_cipher jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(p_cipher) = 'object'
   AND p_cipher ?& ARRAY['version','keyId','iv','data']
   AND p_cipher - ARRAY['version','keyId','iv','data'] = '{}'::jsonb
   AND p_cipher->'version' = '1'::jsonb
   AND jsonb_typeof(p_cipher->'keyId') = 'string' AND p_cipher->>'keyId' ~ '^[A-Za-z0-9_-]{1,64}$'
   AND jsonb_typeof(p_cipher->'iv') = 'string' AND p_cipher->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
   AND jsonb_typeof(p_cipher->'data') = 'string' AND p_cipher->>'data' ~ '^[A-Za-z0-9_-]+$' AND length(p_cipher->>'data') BETWEEN 22 AND 240000
   AND (length(p_cipher->>'data') % 4 = 0
     OR length(p_cipher->>'data') % 4 = 2 AND right(p_cipher->>'data',1) ~ '^[AQgw]$'
     OR length(p_cipher->>'data') % 4 = 3 AND right(p_cipher->>'data',1) ~ '^[AEIMQUYcgkosw048]$'), false)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.valid_token_cipher(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.valid_token_cipher(jsonb) TO service_role;

CREATE TABLE fountain_cloud.session_vault (
 workspace_id text NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 1000),
 hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 -- Deliberately no auth.sessions FK: remote logout deletes that session while
 -- this encrypted retry-only record must remain until local CAS completion.
 auth_session_id uuid NOT NULL,
 cache_binding text NOT NULL CHECK (cache_binding ~ '^[a-f0-9]{32}$'),
 created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
 expires_at_ms bigint NOT NULL CHECK (expires_at_ms = created_at_ms + 604800000 AND expires_at_ms <= 8640000000000000),
 version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
 token_ciphertext jsonb CHECK (token_ciphertext IS NULL OR fountain_cloud.valid_token_cipher(token_ciphertext)),
 revoked_at_ms bigint CHECK (revoked_at_ms IS NULL OR revoked_at_ms BETWEEN created_at_ms AND 8640000000000000),
 logout_pending boolean NOT NULL DEFAULT false,
 refresh_lease_id text CHECK (refresh_lease_id IS NULL OR refresh_lease_id ~ '^[A-Za-z0-9_-]{16,160}$'),
 refresh_lease_until_ms bigint,
 PRIMARY KEY (workspace_id, hash),
 CHECK ((refresh_lease_id IS NULL) = (refresh_lease_until_ms IS NULL)),
 CHECK (refresh_lease_until_ms IS NULL OR refresh_lease_until_ms BETWEEN 0 AND 9007199254740991),
 CHECK (revoked_at_ms IS NULL OR refresh_lease_id IS NULL),
 CHECK ((revoked_at_ms IS NULL AND token_ciphertext IS NOT NULL AND NOT logout_pending)
     OR (revoked_at_ms IS NOT NULL AND logout_pending = (token_ciphertext IS NOT NULL)))
);
ALTER TABLE fountain_cloud.session_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.session_vault FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.session_vault FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON fountain_cloud.session_vault TO service_role;
-- This is trusted server authorization, not end-user RLS. Supabase service_role
-- bypasses RLS; the policy additionally documents the only permitted caller.
CREATE POLICY session_vault_service ON fountain_cloud.session_vault FOR ALL TO service_role USING (true) WITH CHECK (true);
-- PostgreSQL does not automatically index the referencing side of a foreign key.
CREATE INDEX session_vault_user_idx ON fountain_cloud.session_vault(user_id);

CREATE FUNCTION fountain_cloud.vault_dto(p_row fountain_cloud.session_vault) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object('hash',(p_row).hash,'userId',(p_row).user_id,'authSessionId',(p_row).auth_session_id,
  'cacheBinding',(p_row).cache_binding,'createdAt',(p_row).created_at_ms,'expiresAt',(p_row).expires_at_ms,
  'version',(p_row).version,'tokens',(p_row).token_ciphertext,'revokedAt',(p_row).revoked_at_ms,'logoutPending',(p_row).logout_pending)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_dto(fountain_cloud.session_vault) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_dto(fountain_cloud.session_vault) TO service_role;

-- The sole narrow definer is required because service_role has NO legacy schema
-- privileges. Never grant it generic legacy table access to fix this lookup.
CREATE FUNCTION fountain_cloud.resolve_profile(p_workspace_id text,p_user_id uuid,p_auth_session_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object('workspaceId',m.workspace_id,
  'authSessionActive',EXISTS(SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
    WHERE s.id=p_auth_session_id AND s.user_id=p_user_id AND u.deleted_at IS NULL AND NOT u.is_anonymous
     AND (u.banned_until IS NULL OR u.banned_until <= statement_timestamp())
     AND (s.not_after IS NULL OR s.not_after > statement_timestamp())),
  'member',jsonb_build_object('id',e.id,'name',e.data->>'name','email',e.data->>'email','role',e.data->>'role',
    'active',COALESCE(e.data->'active','true'::jsonb)='true'::jsonb))
 FROM fountain_private.identity_mapping m JOIN fountain_private.entities e
  ON e.workspace_id=m.workspace_id AND e.kind='member' AND e.id=m.member_id
 WHERE m.workspace_id=p_workspace_id AND m.auth_user_id=p_user_id
  AND jsonb_typeof(e.data->'id')='string' AND e.data->>'id'=e.id AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
  AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email') <= 1000
  AND e.data->>'role' IN ('owner','admin','member','guest')
  AND (NOT (e.data ? 'active') OR jsonb_typeof(e.data->'active')='boolean')
$$;
ALTER FUNCTION fountain_cloud.resolve_profile(text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.resolve_profile(text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.resolve_profile(text,uuid,uuid) TO service_role;

CREATE FUNCTION fountain_cloud.vault_create(p_workspace_id text,p_row jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE profile jsonb;
BEGIN
 IF jsonb_typeof(p_row) IS DISTINCT FROM 'object'
  OR NOT (p_row ?& ARRAY['hash','userId','authSessionId','cacheBinding','createdAt','expiresAt','version','tokens','revokedAt','logoutPending'])
  OR p_row - ARRAY['hash','userId','authSessionId','cacheBinding','createdAt','expiresAt','version','tokens','revokedAt','logoutPending'] <> '{}'::jsonb
  OR p_row->'version' IS DISTINCT FROM '0'::jsonb OR p_row->'revokedAt' IS DISTINCT FROM 'null'::jsonb
  OR p_row->'logoutPending' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p_row->'createdAt') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_row->'hash') IS DISTINCT FROM 'string' OR jsonb_typeof(p_row->'userId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_row->'authSessionId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_row->'cacheBinding') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_row->'expiresAt') IS DISTINCT FROM 'number' OR NOT fountain_cloud.valid_token_cipher(p_row->'tokens') THEN
  RAISE EXCEPTION 'Invalid session envelope' USING ERRCODE='22023';
 END IF;
 profile := fountain_cloud.resolve_profile(p_workspace_id,(p_row->>'userId')::uuid,(p_row->>'authSessionId')::uuid);
 IF profile IS NULL OR profile->'authSessionActive' IS DISTINCT FROM 'true'::jsonb OR profile->'member'->'active' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'Session identity unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO fountain_cloud.session_vault(workspace_id,hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,version,token_ciphertext)
 VALUES(p_workspace_id,p_row->>'hash',(p_row->>'userId')::uuid,(p_row->>'authSessionId')::uuid,p_row->>'cacheBinding',(p_row->>'createdAt')::bigint,(p_row->>'expiresAt')::bigint,0,p_row->'tokens');
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_create(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_create(text,jsonb) TO service_role;

CREATE FUNCTION fountain_cloud.vault_read(p_workspace_id text,p_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT fountain_cloud.vault_dto(v) FROM fountain_cloud.session_vault v WHERE v.workspace_id=p_workspace_id AND v.hash=p_hash
$$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_read(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_read(text,text) TO service_role;

CREATE FUNCTION fountain_cloud.vault_claim_refresh(p_workspace_id text,p_hash text,p_expected_version bigint,p_lease_id text,p_until bigint,p_now bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE current_row fountain_cloud.session_vault; actual_now bigint;
BEGIN
 SELECT * INTO current_row FROM fountain_cloud.session_vault
  WHERE workspace_id=p_workspace_id AND hash=p_hash AND version=p_expected_version FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 actual_now := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF p_now IS NULL OR p_now < 0 OR p_now > 9007199254740991 OR p_until IS NULL
  OR p_until <= greatest(actual_now,p_now) OR p_until > actual_now+60000
  OR p_lease_id IS NULL OR p_lease_id !~ '^[A-Za-z0-9_-]{16,160}$' THEN RETURN false; END IF;
 IF current_row.revoked_at_ms IS NOT NULL OR current_row.expires_at_ms <= greatest(actual_now,p_now) THEN RETURN false; END IF;
 IF current_row.refresh_lease_id IS NOT NULL THEN
  IF current_row.refresh_lease_until_ms <= greatest(actual_now,p_now) THEN
   -- Its one-use Auth refresh token may already have been consumed. Never
   -- reacquire an abandoned lease and send that token to Auth a second time.
   UPDATE fountain_cloud.session_vault SET revoked_at_ms=greatest(actual_now,created_at_ms),version=version+1,
    logout_pending=true,refresh_lease_id=NULL,refresh_lease_until_ms=NULL
    WHERE workspace_id=p_workspace_id AND hash=p_hash;
  END IF;
  RETURN false;
 END IF;
 UPDATE fountain_cloud.session_vault SET refresh_lease_id=p_lease_id,refresh_lease_until_ms=p_until
  WHERE workspace_id=p_workspace_id AND hash=p_hash;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_claim_refresh(text,text,bigint,text,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_claim_refresh(text,text,bigint,text,bigint,bigint) TO service_role;

CREATE FUNCTION fountain_cloud.vault_finish_refresh(p_workspace_id text,p_hash text,p_expected_version bigint,p_lease_id text,p_tokens jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE current_row fountain_cloud.session_vault; actual_now bigint;
BEGIN
 IF NOT fountain_cloud.valid_token_cipher(p_tokens) THEN RAISE EXCEPTION 'Invalid cipher envelope' USING ERRCODE='22023'; END IF;
 SELECT * INTO current_row FROM fountain_cloud.session_vault WHERE workspace_id=p_workspace_id AND hash=p_hash FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 actual_now := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF current_row.version IS DISTINCT FROM p_expected_version OR current_row.refresh_lease_id IS NULL
  OR current_row.refresh_lease_id IS DISTINCT FROM p_lease_id OR current_row.refresh_lease_until_ms <= actual_now
  OR current_row.revoked_at_ms IS NOT NULL OR current_row.expires_at_ms <= actual_now THEN RETURN false; END IF;
 UPDATE fountain_cloud.session_vault SET token_ciphertext=p_tokens,version=version+1,refresh_lease_id=NULL,refresh_lease_until_ms=NULL
  WHERE workspace_id=p_workspace_id AND hash=p_hash;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_finish_refresh(text,text,bigint,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_finish_refresh(text,text,bigint,text,jsonb) TO service_role;

CREATE FUNCTION fountain_cloud.vault_release_refresh(p_workspace_id text,p_hash text,p_lease_id text) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $$
 -- Trusted caller may use this only BEFORE provider I/O (known not consumed).
 -- Success finish clears its own lease; abandoned leases are never reclaimed.
 UPDATE fountain_cloud.session_vault SET refresh_lease_id=NULL,refresh_lease_until_ms=NULL
 WHERE workspace_id=p_workspace_id AND hash=p_hash AND refresh_lease_id=p_lease_id
$$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_release_refresh(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_release_refresh(text,text,text) TO service_role;

CREATE FUNCTION fountain_cloud.vault_revoke(p_workspace_id text,p_hash text,p_now bigint,p_expected_version bigint,p_lease_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE result fountain_cloud.session_vault;
BEGIN
 IF p_now IS NULL OR p_now < 0 OR p_now > 8640000000000000 THEN RAISE EXCEPTION 'Invalid clock' USING ERRCODE='22023'; END IF;
 UPDATE fountain_cloud.session_vault SET revoked_at_ms=COALESCE(revoked_at_ms,greatest(p_now,created_at_ms)),
  version=CASE WHEN revoked_at_ms IS NULL THEN version+1 ELSE version END,
  logout_pending=CASE WHEN revoked_at_ms IS NULL THEN token_ciphertext IS NOT NULL ELSE logout_pending END,
  refresh_lease_id=NULL,refresh_lease_until_ms=NULL
 WHERE workspace_id=p_workspace_id AND hash=p_hash
  AND ((p_expected_version IS NULL AND p_lease_id IS NULL) OR (version=p_expected_version AND refresh_lease_id=p_lease_id AND revoked_at_ms IS NULL))
 RETURNING * INTO result;
 IF NOT FOUND THEN RETURN NULL; END IF; RETURN fountain_cloud.vault_dto(result);
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_revoke(text,text,bigint,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_revoke(text,text,bigint,bigint,text) TO service_role;

CREATE FUNCTION fountain_cloud.vault_finish_logout(p_workspace_id text,p_hash text,p_expected_version bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE affected bigint;
BEGIN
 UPDATE fountain_cloud.session_vault SET token_ciphertext=NULL,logout_pending=false
 WHERE workspace_id=p_workspace_id AND hash=p_hash AND version=p_expected_version AND revoked_at_ms IS NOT NULL AND logout_pending;
 GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_finish_logout(text,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_finish_logout(text,text,bigint) TO service_role;

-- Only these thin service-only RPC wrappers are in the Data API's public schema.
CREATE FUNCTION public.fountain_cloud_vault_create(p_workspace_id text,p_row jsonb) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.vault_create(p_workspace_id,p_row) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_vault_create(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_vault_create(text,jsonb) TO service_role;
CREATE FUNCTION public.fountain_cloud_vault_read(p_workspace_id text,p_hash text) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.vault_read(p_workspace_id,p_hash) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_vault_read(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_vault_read(text,text) TO service_role;
CREATE FUNCTION public.fountain_cloud_resolve_profile(p_workspace_id text,p_user_id uuid,p_auth_session_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.resolve_profile(p_workspace_id,p_user_id,p_auth_session_id) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_resolve_profile(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_resolve_profile(text,uuid,uuid) TO service_role;
CREATE FUNCTION public.fountain_cloud_vault_claim_refresh(p_workspace_id text,p_hash text,p_expected_version bigint,p_lease_id text,p_until bigint,p_now bigint) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.vault_claim_refresh(p_workspace_id,p_hash,p_expected_version,p_lease_id,p_until,p_now) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_vault_claim_refresh(text,text,bigint,text,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_vault_claim_refresh(text,text,bigint,text,bigint,bigint) TO service_role;
CREATE FUNCTION public.fountain_cloud_vault_finish_refresh(p_workspace_id text,p_hash text,p_expected_version bigint,p_lease_id text,p_tokens jsonb) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.vault_finish_refresh(p_workspace_id,p_hash,p_expected_version,p_lease_id,p_tokens) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_vault_finish_refresh(text,text,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_vault_finish_refresh(text,text,bigint,text,jsonb) TO service_role;
CREATE FUNCTION public.fountain_cloud_vault_release_refresh(p_workspace_id text,p_hash text,p_lease_id text) RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.vault_release_refresh(p_workspace_id,p_hash,p_lease_id) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_vault_release_refresh(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_vault_release_refresh(text,text,text) TO service_role;
CREATE FUNCTION public.fountain_cloud_vault_revoke(p_workspace_id text,p_hash text,p_now bigint,p_expected_version bigint,p_lease_id text) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.vault_revoke(p_workspace_id,p_hash,p_now,p_expected_version,p_lease_id) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_vault_revoke(text,text,bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_vault_revoke(text,text,bigint,bigint,text) TO service_role;
CREATE FUNCTION public.fountain_cloud_vault_finish_logout(p_workspace_id text,p_hash text,p_expected_version bigint) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.vault_finish_logout(p_workspace_id,p_hash,p_expected_version) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_vault_finish_logout(text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_vault_finish_logout(text,text,bigint) TO service_role;
