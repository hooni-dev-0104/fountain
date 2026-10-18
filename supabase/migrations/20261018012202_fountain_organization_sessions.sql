-- Independent organization realm. No Auth FK/trigger and no workspace authority.
-- Ciphertext is reachable only through the narrowly scoped service-only RPC.
CREATE TABLE fountain_private.organization_session_vault (
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
CREATE INDEX organization_session_identity ON fountain_private.organization_session_vault(user_id,auth_session_id);
CREATE INDEX organization_session_cleanup ON fountain_private.organization_session_vault(expires_at_ms,hash) WHERE token_ciphertext IS NOT NULL;
ALTER TABLE fountain_private.organization_session_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.organization_session_vault FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_private.organization_session_vault FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE POLICY organization_session_vault_closed ON fountain_private.organization_session_vault FOR ALL TO PUBLIC USING(false) WITH CHECK(false);

-- Explicit statements establish Auth user -> Auth session lock order.
CREATE OR REPLACE FUNCTION fountain_private.organization_identity(p_identity jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;sid uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Organization control requires read committed' USING ERRCODE='PT409';END IF;
 IF jsonb_typeof(p_identity) IS DISTINCT FROM 'object' OR NOT(p_identity ?& ARRAY['userId','authSessionId']) OR p_identity-ARRAY['userId','authSessionId']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid organization identity' USING ERRCODE='22023';END IF;
 uid:=fountain_private.organization_uuid(p_identity->'userId');sid:=fountain_private.organization_uuid(p_identity->'authSessionId');
 PERFORM 1 FROM auth.users u WHERE u.id=uid AND u.deleted_at IS NULL AND u.is_anonymous=false AND u.email_confirmed_at IS NOT NULL
 AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 PERFORM 1 FROM auth.sessions s WHERE s.id=sid AND s.user_id=uid AND(s.not_after IS NULL OR s.not_after>clock_timestamp()) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 RETURN uid;
END $f$;
CREATE FUNCTION fountain_private.organization_session_dto(p_row fountain_private.organization_session_vault) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('hash',(p_row).hash,'userId',(p_row).user_id,'authSessionId',(p_row).auth_session_id,
 'cacheBinding',(p_row).cache_binding,'createdAt',(p_row).created_at_ms,'expiresAt',(p_row).expires_at_ms,'version',(p_row).version,
 'tokens',(p_row).token_ciphertext,'revokedAt',(p_row).revoked_at_ms,'logoutPending',(p_row).logout_pending)
$f$;
CREATE FUNCTION fountain_private.organization_session_context(p_session jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;
BEGIN
 IF jsonb_typeof(p_session) IS DISTINCT FROM 'object' OR NOT(p_session ?& ARRAY['sessionHash','cacheBinding','userId','authSessionId'])
 OR p_session-ARRAY['sessionHash','cacheBinding','userId','authSessionId']<>'{}'::jsonb
 OR jsonb_typeof(p_session->'sessionHash') IS DISTINCT FROM 'string' OR(p_session->>'sessionHash') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(p_session->'cacheBinding') IS DISTINCT FROM 'string' OR(p_session->>'cacheBinding') !~ '^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Invalid organization session' USING ERRCODE='22023';END IF;
 uid:=fountain_private.organization_identity(p_session-ARRAY['sessionHash','cacheBinding']);
 PERFORM 1 FROM fountain_private.organization_session_vault v WHERE v.hash=p_session->>'sessionHash' AND v.user_id=uid
 AND v.auth_session_id=(p_session->>'authSessionId')::uuid AND v.cache_binding=p_session->>'cacheBinding'
 AND v.revoked_at_ms IS NULL AND NOT v.logout_pending AND v.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 RETURN uid;
END $f$;
-- All mutable-vault operations use the same lock order even after provider logout.
CREATE FUNCTION fountain_private.organization_session_lock(p_hash text) RETURNS fountain_private.organization_session_vault
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE row fountain_private.organization_session_vault;
BEGIN
 SELECT * INTO row FROM fountain_private.organization_session_vault WHERE hash=p_hash;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM 1 FROM auth.users WHERE id=row.user_id FOR SHARE;
 PERFORM 1 FROM auth.sessions WHERE id=row.auth_session_id AND user_id=row.user_id FOR SHARE;
 SELECT * INTO row FROM fountain_private.organization_session_vault WHERE hash=p_hash FOR UPDATE;
 RETURN row;
END $f$;
CREATE FUNCTION fountain_private.organization_session_prune(p_limit integer DEFAULT 128) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE candidate record;row fountain_private.organization_session_vault;stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;changed integer:=0;absent boolean;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'Invalid prune limit' USING ERRCODE='22023';END IF;
 FOR candidate IN SELECT v.hash FROM fountain_private.organization_session_vault v WHERE v.token_ciphertext IS NOT NULL
 AND((v.expires_at_ms<=stamp AND v.revoked_at_ms IS NULL) OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=v.user_id AND u.deleted_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=v.auth_session_id AND s.user_id=v.user_id))
 ORDER BY v.expires_at_ms,v.hash LIMIT p_limit LOOP
  row:=fountain_private.organization_session_lock(candidate.hash);stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF row.hash IS NULL OR row.token_ciphertext IS NULL THEN CONTINUE;END IF;
  absent:=NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=row.user_id AND u.deleted_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=row.auth_session_id AND s.user_id=row.user_id);
  IF NOT absent AND(row.expires_at_ms>stamp OR row.revoked_at_ms IS NOT NULL) THEN CONTINUE;END IF;
  IF row.revoked_at_ms IS NULL AND row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.organization_session_vault SET revoked_at_ms=COALESCE(revoked_at_ms,greatest(stamp,created_at_ms)),
   version=version+CASE WHEN revoked_at_ms IS NULL THEN 1 ELSE 0 END,
   token_ciphertext=CASE WHEN absent THEN NULL ELSE token_ciphertext END,logout_pending=NOT absent,
   refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=row.hash;
  changed:=changed+1;
 END LOOP;
 RETURN changed;
END $f$;
CREATE FUNCTION fountain_private.organization_session_integer(p_value jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' OR(p_value#>>'{}') !~ '^[0-9]{1,16}$' OR(p_value#>>'{}')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Invalid session integer' USING ERRCODE='22023';END IF;
 RETURN(p_value#>>'{}')::bigint;
END $f$;
CREATE FUNCTION public.fountain_cloud_organization_session_vault(p_action text,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE row fountain_private.organization_session_vault;value jsonb;uid uuid;sid uuid;stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
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
  now_ms:=fountain_private.organization_session_integer(p_value->'limit');IF now_ms NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'Invalid sweep limit' USING ERRCODE='22023';END IF;limit_n:=now_ms::integer;
  pruned:=fountain_private.organization_session_prune(limit_n);
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.hash),'[]'::jsonb) INTO answer FROM(SELECT v.hash,fountain_private.organization_session_dto(v) item
   FROM fountain_private.organization_session_vault v WHERE v.logout_pending ORDER BY v.hash LIMIT limit_n)x;
  RETURN jsonb_build_object('pending',answer,'pruned',pruned);
 END IF;
 IF p_action='create' THEN
  value:=p_value->'row';keys:=ARRAY['hash','userId','authSessionId','cacheBinding','createdAt','expiresAt','version','tokens','revokedAt','logoutPending'];
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT(value ?& keys) OR value-keys<>'{}'::jsonb
  OR jsonb_typeof(value->'hash') IS DISTINCT FROM 'string' OR(value->>'hash') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'cacheBinding') IS DISTINCT FROM 'string' OR(value->>'cacheBinding') !~ '^[a-f0-9]{32}$'
  OR value->'version' IS DISTINCT FROM '0'::jsonb OR value->'revokedAt' IS DISTINCT FROM 'null'::jsonb OR value->'logoutPending' IS DISTINCT FROM 'false'::jsonb
  OR NOT fountain_cloud.valid_token_cipher(value->'tokens') THEN RAISE EXCEPTION 'Invalid session envelope' USING ERRCODE='22023';END IF;
  now_ms:=fountain_private.organization_session_integer(value->'createdAt');until_ms:=fountain_private.organization_session_integer(value->'expiresAt');
  IF abs(now_ms-stamp)>60000 OR until_ms<>now_ms+604800000 OR until_ms>8640000000000000 THEN RAISE EXCEPTION 'Invalid session expiry' USING ERRCODE='22023';END IF;
  uid:=fountain_private.organization_identity(jsonb_build_object('userId',value->'userId','authSessionId',value->'authSessionId'));
  sid:=fountain_private.organization_uuid(value->'authSessionId');
  INSERT INTO fountain_private.organization_session_vault(hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,token_ciphertext)
   VALUES(value->>'hash',uid,sid,value->>'cacheBinding',now_ms,until_ms,value->'tokens');
  RETURN NULL;
 END IF;
 IF jsonb_typeof(p_value->'hash') IS DISTINCT FROM 'string' OR(p_value->>'hash') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid session hash' USING ERRCODE='22023';END IF;
 h:=p_value->>'hash';
 IF p_value ? 'expectedVersion' AND p_value->'expectedVersion'<>'null'::jsonb THEN ver:=fountain_private.organization_session_integer(p_value->'expectedVersion');END IF;
 IF p_value ? 'leaseId' AND p_value->'leaseId'<>'null'::jsonb THEN
  IF jsonb_typeof(p_value->'leaseId') IS DISTINCT FROM 'string' OR(p_value->>'leaseId') !~ '^[A-Za-z0-9_-]{16,160}$' THEN RAISE EXCEPTION 'Invalid refresh lease' USING ERRCODE='22023';END IF;lease:=p_value->>'leaseId';
 END IF;
 IF p_action IN('claim_refresh','finish_refresh','finish_logout') AND ver IS NULL OR p_action IN('claim_refresh','finish_refresh','release_refresh') AND lease IS NULL THEN RAISE EXCEPTION 'Invalid refresh command' USING ERRCODE='22023';END IF;
 IF p_value ? 'now' THEN now_ms:=fountain_private.organization_session_integer(p_value->'now');END IF;
 IF p_action='claim_refresh' THEN until_ms:=fountain_private.organization_session_integer(p_value->'until');END IF;
 IF p_action='finish_refresh' AND NOT fountain_cloud.valid_token_cipher(p_value->'tokens') THEN RAISE EXCEPTION 'Invalid cipher envelope' USING ERRCODE='22023';END IF;
 IF p_action='revoke' AND((ver IS NULL) IS DISTINCT FROM(lease IS NULL)) THEN RAISE EXCEPTION 'Invalid conditional revoke' USING ERRCODE='22023';END IF;
 row:=fountain_private.organization_session_lock(h);stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF row.hash IS NULL THEN RETURN CASE WHEN p_action IN('claim_refresh','finish_refresh','finish_logout') THEN 'false'::jsonb ELSE NULL END;END IF;
 -- Authoritative provider absence clears orphan secrets; bans and expired access
 -- credentials do not pretend that the provider session has been logged out.
 IF row.token_ciphertext IS NOT NULL AND(NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=row.user_id AND u.deleted_at IS NULL)
  OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=row.auth_session_id AND s.user_id=row.user_id)) THEN
  IF row.revoked_at_ms IS NULL AND row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.organization_session_vault SET revoked_at_ms=COALESCE(revoked_at_ms,greatest(stamp,created_at_ms)),version=version+CASE WHEN revoked_at_ms IS NULL THEN 1 ELSE 0 END,
   token_ciphertext=NULL,logout_pending=false,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h RETURNING * INTO row;
 END IF;
 IF row.revoked_at_ms IS NULL AND row.expires_at_ms<=stamp THEN
  IF row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.organization_session_vault SET revoked_at_ms=greatest(stamp,created_at_ms),version=version+1,
   logout_pending=token_ciphertext IS NOT NULL,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h RETURNING * INTO row;
 END IF;
 IF p_action='read' THEN RETURN fountain_private.organization_session_dto(row);END IF;
 IF p_action='release_refresh' THEN
  UPDATE fountain_private.organization_session_vault SET refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h AND refresh_lease_id=lease;
  RETURN NULL;
 END IF;
 IF p_action='finish_logout' THEN
  IF row.version<>ver OR row.revoked_at_ms IS NULL OR EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=row.auth_session_id AND s.user_id=row.user_id) THEN RETURN 'false';END IF;
  UPDATE fountain_private.organization_session_vault SET token_ciphertext=NULL,logout_pending=false WHERE hash=h;
  RETURN 'true';
 END IF;
 IF p_action='revoke' THEN
  IF ver IS NOT NULL AND(row.version<>ver OR row.refresh_lease_id IS DISTINCT FROM lease OR row.revoked_at_ms IS NOT NULL) THEN RETURN NULL;END IF;
  IF row.revoked_at_ms IS NULL AND row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
  UPDATE fountain_private.organization_session_vault SET revoked_at_ms=COALESCE(revoked_at_ms,greatest(stamp,created_at_ms)),version=version+CASE WHEN revoked_at_ms IS NULL THEN 1 ELSE 0 END,
   logout_pending=token_ciphertext IS NOT NULL,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h RETURNING * INTO row;
  RETURN fountain_private.organization_session_dto(row);
 END IF;
 IF row.revoked_at_ms IS NOT NULL OR row.expires_at_ms<=stamp OR row.version<>ver THEN RETURN 'false';END IF;
 IF p_action='claim_refresh' THEN
  IF until_ms<=stamp OR until_ms>stamp+60000 THEN RETURN 'false';END IF;
  IF row.refresh_lease_id IS NOT NULL THEN
   IF row.refresh_lease_until_ms<=stamp THEN
    IF row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
    UPDATE fountain_private.organization_session_vault SET revoked_at_ms=greatest(stamp,created_at_ms),version=version+1,logout_pending=true,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h;
   END IF;RETURN 'false';
  END IF;
  UPDATE fountain_private.organization_session_vault SET refresh_lease_id=lease,refresh_lease_until_ms=until_ms WHERE hash=h;RETURN 'true';
 END IF;
 IF row.refresh_lease_id IS DISTINCT FROM lease OR row.refresh_lease_until_ms<=stamp THEN RETURN 'false';END IF;
 IF row.version=9007199254740991 THEN RAISE EXCEPTION 'Session version exhausted' USING ERRCODE='PT413';END IF;
 UPDATE fountain_private.organization_session_vault SET token_ciphertext=p_value->'tokens',version=version+1,refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE hash=h;
 RETURN 'true';
END $f$;

CREATE FUNCTION fountain_private.organization_subcommand(p_command uuid,p_label text) RETURNS uuid
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT(substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12))::uuid FROM(SELECT encode(sha256(convert_to('fountain:organization-setup:'||p_command::text||':'||p_label,'UTF8')),'hex') h)x
$f$;
CREATE FUNCTION public.fountain_cloud_organization_portal(p_session jsonb,p_operation text,p_organization_id uuid,p_expected_revision bigint,p_command_id uuid,p_value jsonb,p_workspace_context jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;identity jsonb;member jsonb;ws text;ws_name text;org fountain_private.organization_registry;gid uuid;target uuid;request fountain_private.organization_link_requests;
 initiator fountain_private.organization_owner_grants;answer jsonb;receipt jsonb;targets uuid[];digest text;nonce text;link uuid;command_boot uuid;command_request uuid;command_accept uuid;stamp timestamptz;entry record;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('list','read','rename','owner_grant_email','owner_revoke','link_request','link_detach','bootstrap_accept','setup_eligibility','create_from_workspace','link_preview','link_accept')
 OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR octet_length(p_value::text)>4096 THEN RAISE EXCEPTION 'Invalid organization command' USING ERRCODE='22023';END IF;
 IF p_operation IN('setup_eligibility','create_from_workspace','link_preview','link_accept') THEN
  -- The workspace writer is always first. Its mapping and member authorization
  -- are not inferred from the separate organization login.
  BEGIN member:=fountain_cloud.store_context(p_workspace_context);EXCEPTION WHEN SQLSTATE 'PT401' THEN RAISE EXCEPTION 'Workspace authentication required' USING ERRCODE='PT403';END;ws:=p_workspace_context->>'workspaceId';
  IF member->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Workspace owner required' USING ERRCODE='PT403';END IF;
  uid:=fountain_private.organization_session_context(p_session);
  IF uid IS DISTINCT FROM fountain_private.organization_uuid(p_workspace_context->'userId') THEN RAISE EXCEPTION 'Workspace account differs' USING ERRCODE='PT403';END IF;
  IF p_operation<>'setup_eligibility' AND(jsonb_typeof(p_value->'workspace_binding') IS DISTINCT FROM 'string' OR p_value->>'workspace_binding' IS DISTINCT FROM p_workspace_context->>'cacheBinding') THEN RAISE EXCEPTION 'Workspace session changed' USING ERRCODE='PT409';END IF;
  SELECT CASE WHEN jsonb_typeof(e.data->'name')='string' THEN left(e.data->>'name',1000) ELSE '' END INTO ws_name FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='settings' AND e.id='workspace';
 ELSE
  IF p_workspace_context IS NOT NULL THEN RAISE EXCEPTION 'Unexpected workspace context' USING ERRCODE='22023';END IF;
  uid:=fountain_private.organization_session_context(p_session);
 END IF;
 identity:=jsonb_build_object('userId',uid,'authSessionId',p_session->'authSessionId');
 IF p_operation='setup_eligibility' THEN
  IF p_value<>'{}'::jsonb OR p_organization_id IS NOT NULL OR p_expected_revision IS NOT NULL OR p_command_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid setup query' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE workspace_id=ws AND detached_at IS NULL) THEN RETURN jsonb_build_object('eligible',false,'reason','workspace_already_linked','workspaceId',ws);END IF;
  RETURN jsonb_build_object('eligible',true,'workspaceId',ws,'workspaceName',COALESCE(ws_name,''),'workspaceBinding',p_workspace_context->>'cacheBinding');
 END IF;
 IF p_operation='create_from_workspace' THEN
  IF p_organization_id IS NULL OR p_command_id IS NULL OR p_expected_revision IS NOT NULL OR NOT(p_value ?& ARRAY['name','confirm_owner','attach_workspace','workspace_binding'])
  OR p_value-ARRAY['name','confirm_owner','attach_workspace','workspace_binding']<>'{}'::jsonb OR p_value->'confirm_owner' IS DISTINCT FROM 'true'::jsonb OR p_value->'attach_workspace' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(p_value->'name') IS DISTINCT FROM 'string' OR length(btrim(p_value->>'name')) NOT BETWEEN 1 AND 200 OR octet_length(p_value->>'name')>800 THEN RAISE EXCEPTION 'Invalid organization setup' USING ERRCODE='22023';END IF;
  -- A stable UUID serializes create races before an organization row exists.
  -- Only this exact namespace is advisory; existing organizations are never adopted.
  PERFORM pg_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:organization-create:'||p_organization_id::text,'UTF8')),'hex'),1,16))::bit(64)::bigint);
  digest:=encode(sha256(convert_to(jsonb_build_object('operation','create_from_workspace','organizationId',p_organization_id,'userId',uid,'workspaceId',ws,'memberId',p_workspace_context->>'memberId','value',p_value)::text,'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM fountain_private.organization_registry WHERE id=p_organization_id) THEN
   org:=fountain_private.organization_lock(p_organization_id);gid:=fountain_private.organization_owner(p_organization_id,uid);
   answer:=fountain_private.organization_receipt(org.id,p_command_id,'grant:'||gid::text,digest);
   IF answer IS NULL THEN RAISE EXCEPTION 'Organization identifier already exists' USING ERRCODE='PT409';END IF;
   IF NOT EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE organization_id=org.id AND id=(answer->>'linkId')::uuid AND workspace_id=ws AND detached_at IS NULL) THEN RAISE EXCEPTION 'Organization setup no longer active' USING ERRCODE='PT403';END IF;
   PERFORM fountain_private.organization_session_context(p_session);RETURN answer;
  END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE workspace_id=ws AND detached_at IS NULL) THEN RAISE EXCEPTION 'Workspace already belongs to an organization' USING ERRCODE='PT409';END IF;
  INSERT INTO fountain_private.organization_registry(id,name,status,revision) VALUES(p_organization_id,p_value->>'name','pending',0);
  INSERT INTO fountain_private.organization_owner_grants(organization_id,user_id) VALUES(p_organization_id,uid) RETURNING id INTO gid;
  command_boot:=fountain_private.organization_subcommand(p_command_id,'bootstrap');command_request:=fountain_private.organization_subcommand(p_command_id,'request');command_accept:=fountain_private.organization_subcommand(p_command_id,'accept');
  PERFORM fountain_private.organization_record(p_organization_id,command_boot,'grant:'||gid::text,digest,uid,gid,'bootstrap',jsonb_build_object('grantId',gid,'source','workspace_owner_consent'),true,jsonb_build_object('grantId',gid));
  -- A private server nonce exists only inside this transaction; consent was
  -- supplied explicitly for both fresh independent sessions above.
  nonce:=encode(sha256(convert_to(p_command_id::text||':'||p_organization_id::text||':'||uid::text,'UTF8')),'hex');
  stamp:=clock_timestamp();
  answer:=public.fountain_cloud_organization_rpc(identity,p_organization_id,'link_request',1,command_request,jsonb_build_object('workspaceId',ws,'nonceHash',encode(sha256(convert_to(nonce,'UTF8')),'hex'),'expiresAtMs',floor(extract(epoch FROM stamp+interval '5 minutes')*1000)::bigint));
  BEGIN answer:=public.fountain_cloud_organization_link_accept(p_workspace_context,p_organization_id,(answer->>'requestId')::uuid,2,nonce,command_accept);EXCEPTION WHEN SQLSTATE 'PT401' THEN RAISE EXCEPTION 'Workspace authentication required' USING ERRCODE='PT403';END;
  answer:=jsonb_build_object('organizationId',p_organization_id,'revision',3,'changed',true,'grantId',gid,'linkId',answer->'linkId','workspaceId',ws);
  INSERT INTO fountain_private.organization_receipts(organization_id,command_id,actor_key,request_hash,result) VALUES(p_organization_id,p_command_id,'grant:'||gid::text,digest,answer);
  PERFORM fountain_private.organization_session_context(p_session);RETURN answer;
 END IF;
 IF p_operation IN('link_preview','link_accept') THEN
  IF p_organization_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991
  OR(p_operation='link_preview' AND p_command_id IS NOT NULL) OR(p_operation='link_accept' AND p_command_id IS NULL)
  OR NOT(p_value ?& ARRAY['requestId','code','workspace_binding']) OR p_value-ARRAY['requestId','code','workspace_binding']<>'{}'::jsonb
  OR jsonb_typeof(p_value->'code') IS DISTINCT FROM 'string' OR(p_value->>'code') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid workspace consent' USING ERRCODE='22023';END IF;
  target:=fountain_private.organization_uuid(p_value->'requestId');
  IF p_operation='link_accept' THEN
   BEGIN answer:=public.fountain_cloud_organization_link_accept(p_workspace_context,p_organization_id,target,p_expected_revision,p_value->>'code',p_command_id);EXCEPTION WHEN SQLSTATE 'PT401' THEN RAISE EXCEPTION 'Workspace authentication required' USING ERRCODE='PT403';END;
   PERFORM fountain_private.organization_session_context(p_session);RETURN answer;
  END IF;
  org:=fountain_private.organization_lock(p_organization_id);
  SELECT * INTO request FROM fountain_private.organization_link_requests WHERE organization_id=org.id AND id=target;
  IF NOT FOUND OR request.workspace_id<>ws OR request.nonce_hash<>encode(sha256(convert_to(p_value->>'code','UTF8')),'hex')
  OR request.consumed_at IS NOT NULL OR request.expires_at<=clock_timestamp() OR org.status<>'active' THEN RAISE EXCEPTION 'Workspace consent rejected' USING ERRCODE='PT403';END IF;
  SELECT * INTO initiator FROM fountain_private.organization_owner_grants WHERE organization_id=org.id AND id=request.initiator_grant_id AND closed_at IS NULL;
  IF NOT FOUND OR NOT fountain_private.organization_usable_user(initiator.user_id) THEN RAISE EXCEPTION 'Organization initiator unavailable' USING ERRCODE='PT403';END IF;
  IF org.revision<>p_expected_revision OR request.requested_revision<>p_expected_revision THEN RAISE EXCEPTION 'Workspace consent revision changed' USING ERRCODE='PT409';END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.organization_workspace_links WHERE workspace_id=ws AND detached_at IS NULL) THEN RAISE EXCEPTION 'Workspace already belongs to an organization' USING ERRCODE='PT409';END IF;
  PERFORM fountain_private.organization_session_context(p_session);RETURN jsonb_build_object('organizationId',org.id,'name',org.name,'revision',org.revision,'requestId',request.id,'workspaceId',ws,'workspaceName',COALESCE(ws_name,''),'workspaceBinding',p_workspace_context->>'cacheBinding','expiresAt',request.expires_at);
 END IF;
 IF p_operation='bootstrap_accept' THEN
  IF p_expected_revision IS NOT NULL OR NOT(p_value ? 'code') OR p_value-'code'<>'{}'::jsonb OR jsonb_typeof(p_value->'code') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid organization bootstrap' USING ERRCODE='22023';END IF;
  answer:=public.fountain_cloud_organization_bootstrap_accept(identity,p_organization_id,p_value->>'code',p_command_id);PERFORM fountain_private.organization_session_context(p_session);RETURN answer;
 END IF;
 IF p_operation='owner_grant_email' THEN
  IF p_organization_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_command_id IS NULL
  OR NOT(p_value ? 'email') OR p_value-'email'<>'{}'::jsonb OR jsonb_typeof(p_value->'email') IS DISTINCT FROM 'string'
  OR length(p_value->>'email') NOT BETWEEN 3 AND 320 OR p_value->>'email'<>btrim(p_value->>'email') OR(p_value->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN RAISE EXCEPTION 'Invalid owner email' USING ERRCODE='22023';END IF;
  -- Caller owner check precedes email resolution. The target UUID is bound into
  -- the underlying receipt digest, so email reassignment cannot replay a grant.
  org:=fountain_private.organization_lock(p_organization_id);PERFORM fountain_private.organization_owner(org.id,uid);
  SELECT array_agg(candidate.id ORDER BY candidate.id) INTO targets FROM(
   SELECT u.id FROM auth.users u WHERE lower(u.email)=lower(p_value->>'email') AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
   AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) ORDER BY u.id LIMIT 2 FOR SHARE
  ) candidate;
  IF COALESCE(cardinality(targets),0)<>1 THEN RAISE EXCEPTION 'Owner target unavailable' USING ERRCODE='PT403';END IF;
  target:=targets[1];
  answer:=public.fountain_cloud_organization_rpc(identity,p_organization_id,'owner_grant',p_expected_revision,p_command_id,jsonb_build_object('userId',target));PERFORM fountain_private.organization_session_context(p_session);RETURN answer;
 END IF;
 answer:=public.fountain_cloud_organization_rpc(identity,p_organization_id,p_operation,p_expected_revision,p_command_id,p_value);
 IF p_operation='read' THEN
  -- Org-owner authorized names only; raw Auth UUID and membership identifiers
  -- never leave the trusted server DTO. Display metadata grants no authority.
  answer:=answer||jsonb_build_object('owners',(SELECT COALESCE(jsonb_agg(jsonb_build_object('grantId',g.id,'name',
   COALESCE(NULLIF(left(u.raw_user_meta_data->>'full_name',1000),''),NULLIF(left(u.raw_user_meta_data->>'name',1000),''),u.email,''),
   'email',COALESCE(u.email,''),'self',g.user_id=uid,'usable',u.id IS NOT NULL AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp())) ORDER BY g.id),'[]'::jsonb)
   FROM fountain_private.organization_owner_grants g LEFT JOIN auth.users u ON u.id=g.user_id WHERE g.organization_id=p_organization_id AND g.closed_at IS NULL),
   'workspaces',(SELECT COALESCE(jsonb_agg(jsonb_build_object('linkId',l.id,'workspaceId',l.workspace_id,'name',CASE WHEN jsonb_typeof(e.data->'name')='string' THEN left(e.data->>'name',1000) ELSE '' END,'linkedAt',l.linked_at) ORDER BY l.id),'[]'::jsonb)
   FROM fountain_private.organization_workspace_links l LEFT JOIN fountain_private.entities e ON e.workspace_id=l.workspace_id AND e.kind='settings' AND e.id='workspace' WHERE l.organization_id=p_organization_id AND l.detached_at IS NULL),
   'events',(SELECT COALESCE(jsonb_agg(x.item ORDER BY x.revision),'[]'::jsonb) FROM(SELECT e.revision,jsonb_build_object('id',e.id,'revision',e.revision,'action',e.action,'actorKind',e.actor_kind,'actorGrantId',e.actor_grant_id,'occurredAt',e.occurred_at,'details',e.details-ARRAY['memberId','userId','authSessionId']) item FROM fountain_private.organization_events e WHERE e.organization_id=p_organization_id ORDER BY e.revision DESC LIMIT 100)x));
 END IF;
 PERFORM fountain_private.organization_session_context(p_session);RETURN answer;
END $f$;

ALTER FUNCTION fountain_private.organization_session_dto(fountain_private.organization_session_vault) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_session_dto(fountain_private.organization_session_vault) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_session_context(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_session_context(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_session_lock(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_session_lock(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_session_prune(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_session_prune(integer) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_session_integer(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_session_integer(jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION fountain_private.organization_subcommand(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.organization_subcommand(uuid,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
ALTER FUNCTION public.fountain_cloud_organization_session_vault(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_organization_session_vault(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_organization_session_vault(text,jsonb) TO service_role;
ALTER FUNCTION public.fountain_cloud_organization_portal(jsonb,text,uuid,bigint,uuid,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_organization_portal(jsonb,text,uuid,bigint,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_organization_portal(jsonb,text,uuid,bigint,uuid,jsonb,jsonb) TO service_role;
