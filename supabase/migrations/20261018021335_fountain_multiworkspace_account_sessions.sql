-- Independent account realm. No Auth FK/trigger and no workspace authority.
-- Ciphertext is reachable only through the narrowly scoped service-only RPC.
CREATE TABLE fountain_private.account_session_vault (
 hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'),user_id uuid NOT NULL,auth_session_id uuid NOT NULL,
 cache_binding text NOT NULL CHECK(cache_binding ~ '^[a-f0-9]{32}$'),
 created_at_ms bigint NOT NULL CHECK(created_at_ms BETWEEN 0 AND 8640000000000000),
 expires_at_ms bigint NOT NULL CHECK(expires_at_ms=created_at_ms+604800000 AND expires_at_ms<=8640000000000000),
 version bigint NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 9007199254740991),
 token_ciphertext jsonb CHECK(token_ciphertext IS NULL OR fountain_cloud.valid_token_cipher(token_ciphertext)),
 revoked_at_ms bigint CHECK(revoked_at_ms IS NULL OR revoked_at_ms BETWEEN created_at_ms AND 8640000000000000),
 logout_pending boolean NOT NULL DEFAULT false,
 refresh_lease_id text CHECK(refresh_lease_id IS NULL OR refresh_lease_id ~ '^[A-Za-z0-9_-]{16,160}$'),refresh_lease_until_ms bigint,
 CHECK((refresh_lease_id IS NULL)=(refresh_lease_until_ms IS NULL)),
 CHECK(refresh_lease_until_ms IS NULL OR refresh_lease_until_ms BETWEEN 0 AND 9007199254740991),
 CHECK(revoked_at_ms IS NULL OR refresh_lease_id IS NULL),
 CHECK((revoked_at_ms IS NULL AND token_ciphertext IS NOT NULL AND NOT logout_pending) OR(revoked_at_ms IS NOT NULL AND logout_pending=(token_ciphertext IS NOT NULL)))
);
CREATE INDEX account_session_identity ON fountain_private.account_session_vault(user_id,auth_session_id);
CREATE INDEX account_session_cleanup ON fountain_private.account_session_vault(expires_at_ms,hash) WHERE token_ciphertext IS NOT NULL;
ALTER TABLE fountain_private.account_session_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.account_session_vault FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.account_session_vault FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY account_session_vault_closed ON fountain_private.account_session_vault FOR ALL TO PUBLIC USING(false) WITH CHECK(false);

CREATE FUNCTION fountain_private.account_session_dto(p_row fountain_private.account_session_vault) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('hash',(p_row).hash,'userId',(p_row).user_id,'authSessionId',(p_row).auth_session_id,
 'cacheBinding',(p_row).cache_binding,'createdAt',(p_row).created_at_ms,'expiresAt',(p_row).expires_at_ms,'version',(p_row).version,
 'tokens',(p_row).token_ciphertext,'revokedAt',(p_row).revoked_at_ms,'logoutPending',(p_row).logout_pending)
$f$;
CREATE FUNCTION fountain_private.account_session_context(p_session jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;
BEGIN
 IF jsonb_typeof(p_session) IS DISTINCT FROM 'object' OR NOT(p_session ?& ARRAY['sessionHash','cacheBinding','userId','authSessionId'])
 OR p_session-ARRAY['sessionHash','cacheBinding','userId','authSessionId']<>'{}'::jsonb
 OR jsonb_typeof(p_session->'sessionHash') IS DISTINCT FROM 'string' OR(p_session->>'sessionHash') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(p_session->'cacheBinding') IS DISTINCT FROM 'string' OR(p_session->>'cacheBinding') !~ '^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Invalid account session' USING ERRCODE='22023';END IF;
 uid:=fountain_private.organization_identity(p_session-ARRAY['sessionHash','cacheBinding']);
 PERFORM 1 FROM fountain_private.account_session_vault v WHERE v.hash=p_session->>'sessionHash' AND v.user_id=uid
 AND v.auth_session_id=(p_session->>'authSessionId')::uuid AND v.cache_binding=p_session->>'cacheBinding'
 AND v.revoked_at_ms IS NULL AND NOT v.logout_pending AND v.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 RETURN uid;
END $f$;
-- All mutable-vault operations use the same lock order even after provider logout.
CREATE FUNCTION fountain_private.account_session_lock(p_hash text) RETURNS fountain_private.account_session_vault
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE row fountain_private.account_session_vault;
BEGIN
 SELECT * INTO row FROM fountain_private.account_session_vault WHERE hash=p_hash;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM auth.users WHERE id=row.user_id FOR SHARE;
 PERFORM 1 FROM auth.sessions WHERE id=row.auth_session_id AND user_id=row.user_id FOR SHARE;
 SELECT * INTO row FROM fountain_private.account_session_vault WHERE hash=p_hash FOR UPDATE;
 RETURN row;
END $f$;
CREATE FUNCTION fountain_private.account_session_prune(p_limit integer DEFAULT 128) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record;row fountain_private.account_session_vault;stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;changed integer:=0;absent boolean;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'Invalid prune limit' USING ERRCODE='22023';END IF;
 FOR candidate IN SELECT v.hash FROM fountain_private.account_session_vault v WHERE v.token_ciphertext IS NOT NULL
 AND((v.expires_at_ms<=stamp AND v.revoked_at_ms IS NULL) OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=v.user_id AND u.deleted_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=v.auth_session_id AND s.user_id=v.user_id))
 ORDER BY v.expires_at_ms,v.hash LIMIT p_limit LOOP
  row:=fountain_private.account_session_lock(candidate.hash);stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF row.hash IS NULL OR row.token_ciphertext IS NULL THEN CONTINUE;END IF;
  absent:=NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=row.user_id AND u.deleted_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=row.auth_session_id AND s.user_id=row.user_id);
  IF NOT absent AND(row.expires_at_ms>stamp OR row.revoked_at_ms IS NOT NULL) THEN CONTINUE;END IF;
  IF row.revoked_at_ms IS NULL AND row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.account_session_vault SET revoked_at_ms=COALESCE(revoked_at_ms,greatest(stamp,created_at_ms)),
   version=version+CASE WHEN revoked_at_ms IS NULL THEN 1 ELSE 0 END,
   token_ciphertext=CASE WHEN absent THEN NULL ELSE token_ciphertext END,logout_pending=NOT absent,
   refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=row.hash;
  changed:=changed+1;
 END LOOP;
 RETURN changed;
END $f$;
CREATE FUNCTION fountain_private.account_session_integer(p_value jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' OR(p_value#>>'{}') !~ '^[0-9]{1,16}$' OR(p_value#>>'{}')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Invalid session integer' USING ERRCODE='22023';END IF;
 RETURN(p_value#>>'{}')::bigint;
END $f$;
CREATE FUNCTION public.fountain_cloud_account_session_vault(p_action text,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE row fountain_private.account_session_vault;value jsonb;uid uuid;sid uuid;stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 keys text[];h text;ver bigint;lease text;until_ms bigint;now_ms bigint;limit_n integer;pruned integer;answer jsonb;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR octet_length(p_value::text)>250000 THEN RAISE EXCEPTION 'Invalid session command' USING ERRCODE='22023';END IF;
 CASE p_action
 WHEN 'profile' THEN keys:=ARRAY['userId','authSessionId'];WHEN 'create' THEN keys:=ARRAY['row'];WHEN 'read' THEN keys:=ARRAY['hash'];
 WHEN 'claim_refresh' THEN keys:=ARRAY['hash','expectedVersion','leaseId','until','now'];WHEN 'finish_refresh' THEN keys:=ARRAY['hash','expectedVersion','leaseId','tokens'];
 WHEN 'release_refresh' THEN keys:=ARRAY['hash','leaseId'];WHEN 'revoke' THEN keys:=ARRAY['hash','now','expectedVersion','leaseId'];
 WHEN 'finish_logout' THEN keys:=ARRAY['hash','expectedVersion'];WHEN 'sweep' THEN keys:=ARRAY['limit'];
 ELSE RAISE EXCEPTION 'Invalid session action' USING ERRCODE='22023';END CASE;
 IF NOT(p_value ?& keys) OR p_value-keys<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid session command' USING ERRCODE='22023';END IF;
 IF p_action='profile' THEN
  BEGIN uid:=fountain_private.organization_identity(p_value);EXCEPTION WHEN SQLSTATE 'PT401' THEN RETURN NULL;END;
  SELECT jsonb_build_object('authSessionActive',true,'user',jsonb_build_object('id',u.id,'email',COALESCE(u.email,''),
   'name',COALESCE(NULLIF(left(u.raw_user_meta_data->>'full_name',1000),''),NULLIF(left(u.raw_user_meta_data->>'name',1000),''),u.email,''))) INTO answer FROM auth.users u WHERE u.id=uid;
  RETURN answer;
 END IF;
 IF p_action='sweep' THEN
  now_ms:=fountain_private.account_session_integer(p_value->'limit');IF now_ms NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'Invalid sweep limit' USING ERRCODE='22023';END IF;limit_n:=now_ms::integer;
  pruned:=fountain_private.account_session_prune(limit_n);
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.hash),'[]'::jsonb) INTO answer FROM(SELECT v.hash,fountain_private.account_session_dto(v) item
   FROM fountain_private.account_session_vault v WHERE v.logout_pending ORDER BY v.hash LIMIT limit_n)x;
  RETURN jsonb_build_object('pending',answer,'pruned',pruned);
 END IF;
 IF p_action='create' THEN
  value:=p_value->'row';keys:=ARRAY['hash','userId','authSessionId','cacheBinding','createdAt','expiresAt','version','tokens','revokedAt','logoutPending'];
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT(value ?& keys) OR value-keys<>'{}'::jsonb
  OR jsonb_typeof(value->'hash') IS DISTINCT FROM 'string' OR(value->>'hash') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'cacheBinding') IS DISTINCT FROM 'string' OR(value->>'cacheBinding') !~ '^[a-f0-9]{32}$'
  OR value->'version' IS DISTINCT FROM '0'::jsonb OR value->'revokedAt' IS DISTINCT FROM 'null'::jsonb OR value->'logoutPending' IS DISTINCT FROM 'false'::jsonb
  OR NOT fountain_cloud.valid_token_cipher(value->'tokens') THEN RAISE EXCEPTION 'Invalid session envelope' USING ERRCODE='22023';END IF;
  now_ms:=fountain_private.account_session_integer(value->'createdAt');until_ms:=fountain_private.account_session_integer(value->'expiresAt');
  IF abs(now_ms-stamp)>60000 OR until_ms<>now_ms+604800000 OR until_ms>8640000000000000 THEN RAISE EXCEPTION 'Invalid session expiry' USING ERRCODE='22023';END IF;
  uid:=fountain_private.organization_identity(jsonb_build_object('userId',value->'userId','authSessionId',value->'authSessionId'));
  sid:=fountain_private.organization_uuid(value->'authSessionId');
  INSERT INTO fountain_private.account_session_vault(hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,token_ciphertext)
   VALUES(value->>'hash',uid,sid,value->>'cacheBinding',now_ms,until_ms,value->'tokens');
  RETURN NULL;
 END IF;
 IF jsonb_typeof(p_value->'hash') IS DISTINCT FROM 'string' OR(p_value->>'hash') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid session hash' USING ERRCODE='22023';END IF;
 h:=p_value->>'hash';
 IF p_value ? 'expectedVersion' AND p_value->'expectedVersion'<>'null'::jsonb THEN ver:=fountain_private.account_session_integer(p_value->'expectedVersion');END IF;
 IF p_value ? 'leaseId' AND p_value->'leaseId'<>'null'::jsonb THEN
  IF jsonb_typeof(p_value->'leaseId') IS DISTINCT FROM 'string' OR(p_value->>'leaseId') !~ '^[A-Za-z0-9_-]{16,160}$' THEN RAISE EXCEPTION 'Invalid refresh lease' USING ERRCODE='22023';END IF;lease:=p_value->>'leaseId';
 END IF;
 IF p_action IN('claim_refresh','finish_refresh','finish_logout') AND ver IS NULL OR p_action IN('claim_refresh','finish_refresh','release_refresh') AND lease IS NULL THEN RAISE EXCEPTION 'Invalid refresh command' USING ERRCODE='22023';END IF;
 IF p_value ? 'now' THEN now_ms:=fountain_private.account_session_integer(p_value->'now');END IF;
 IF p_action='claim_refresh' THEN until_ms:=fountain_private.account_session_integer(p_value->'until');END IF;
 IF p_action='finish_refresh' AND NOT fountain_cloud.valid_token_cipher(p_value->'tokens') THEN RAISE EXCEPTION 'Invalid cipher envelope' USING ERRCODE='22023';END IF;
 IF p_action='revoke' AND((ver IS NULL) IS DISTINCT FROM(lease IS NULL)) THEN RAISE EXCEPTION 'Invalid conditional revoke' USING ERRCODE='22023';END IF;
 row:=fountain_private.account_session_lock(h);stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF row.hash IS NULL THEN RETURN CASE WHEN p_action IN('claim_refresh','finish_refresh','finish_logout') THEN 'false'::jsonb ELSE NULL END;END IF;
 -- Authoritative provider absence clears orphan secrets; bans and expired access
 -- credentials do not pretend that the provider session has been logged out.
 IF row.token_ciphertext IS NOT NULL AND(NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=row.user_id AND u.deleted_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=row.auth_session_id AND s.user_id=row.user_id)) THEN
  IF row.revoked_at_ms IS NULL AND row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.account_session_vault SET revoked_at_ms=COALESCE(revoked_at_ms,greatest(stamp,created_at_ms)),version=version+CASE WHEN revoked_at_ms IS NULL THEN 1 ELSE 0 END,
   token_ciphertext=NULL,logout_pending=false,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h RETURNING * INTO row;
 END IF;
 IF row.revoked_at_ms IS NULL AND row.expires_at_ms<=stamp THEN
  IF row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.account_session_vault SET revoked_at_ms=greatest(stamp,created_at_ms),version=version+1,
   logout_pending=token_ciphertext IS NOT NULL,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h RETURNING * INTO row;
 END IF;
 IF p_action='read' THEN RETURN fountain_private.account_session_dto(row);END IF;
 IF p_action='release_refresh' THEN
  UPDATE fountain_private.account_session_vault SET refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h AND refresh_lease_id=lease;
  RETURN NULL;
 END IF;
 IF p_action='finish_logout' THEN
  IF row.version<>ver OR row.revoked_at_ms IS NULL OR EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=row.auth_session_id AND s.user_id=row.user_id) THEN RETURN 'false';END IF;
  UPDATE fountain_private.account_session_vault SET token_ciphertext=NULL,logout_pending=false WHERE hash=h;
  RETURN 'true';
 END IF;
 IF p_action='revoke' THEN
  IF ver IS NOT NULL AND(row.version<>ver OR row.refresh_lease_id IS DISTINCT FROM lease OR row.revoked_at_ms IS NOT NULL) THEN RETURN NULL;END IF;
  IF row.revoked_at_ms IS NULL AND row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.account_session_vault SET revoked_at_ms=COALESCE(revoked_at_ms,greatest(stamp,created_at_ms)),version=version+CASE WHEN revoked_at_ms IS NULL THEN 1 ELSE 0 END,
   logout_pending=token_ciphertext IS NOT NULL,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h RETURNING * INTO row;
  RETURN fountain_private.account_session_dto(row);
 END IF;
 IF row.revoked_at_ms IS NOT NULL OR row.expires_at_ms<=stamp OR row.version<>ver THEN RETURN 'false';END IF;
 IF p_action='claim_refresh' THEN
  IF until_ms<=stamp OR until_ms>stamp+60000 THEN RETURN 'false';END IF;
  IF row.refresh_lease_id IS NOT NULL THEN
   IF row.refresh_lease_until_ms<=stamp THEN
    IF row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
    UPDATE fountain_private.account_session_vault SET revoked_at_ms=greatest(stamp,created_at_ms),version=version+1,logout_pending=true,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h;
   END IF;RETURN 'false';
  END IF;
  UPDATE fountain_private.account_session_vault SET refresh_lease_id=lease,refresh_lease_until_ms=until_ms WHERE hash=h;RETURN 'true';
 END IF;
 IF row.refresh_lease_id IS DISTINCT FROM lease OR row.refresh_lease_until_ms<=stamp THEN RETURN 'false';END IF;
 IF row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
 UPDATE fountain_private.account_session_vault SET token_ciphertext=p_value->'tokens',version=version+1,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h;
 RETURN 'true';
END $f$;

ALTER FUNCTION fountain_private.account_session_dto(fountain_private.account_session_vault) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.account_session_dto(fountain_private.account_session_vault) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.account_session_context(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.account_session_context(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.account_session_lock(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.account_session_lock(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.account_session_prune(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.account_session_prune(integer) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.account_session_integer(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.account_session_integer(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION public.fountain_cloud_account_session_vault(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_account_session_vault(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_account_session_vault(text,jsonb) TO service_role;
