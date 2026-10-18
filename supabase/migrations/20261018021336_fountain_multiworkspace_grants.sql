-- Global runtime authority is deliberately outside workspace backups. Mapping
-- grants identify a connection incarnation; content timestamps cannot recreate it.
CREATE TABLE fountain_private.workspace_registry(
 workspace_id text PRIMARY KEY CHECK(workspace_id ~ '^[A-Za-z0-9_-]{1,160}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_by_user_id uuid,
 source text NOT NULL CHECK(source IN('legacy','account'))
);
INSERT INTO fountain_private.workspace_registry(workspace_id,source)
 SELECT DISTINCT m.workspace_id,'legacy' FROM fountain_private.meta m
 WHERE m.key='workspace_id' AND m.data=to_jsonb(m.workspace_id) AND m.workspace_id ~ '^[A-Za-z0-9_-]{1,160}$'
 AND EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=m.workspace_id AND e.kind='settings' AND e.id='workspace');
ALTER TABLE fountain_private.identity_mapping ADD COLUMN mapping_grant_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX identity_mapping_grant_id ON fountain_private.identity_mapping(mapping_grant_id);
CREATE FUNCTION fountain_private.mapping_grant_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF TG_OP='INSERT' THEN NEW.mapping_grant_id:=gen_random_uuid();
 ELSIF(OLD.workspace_id,OLD.auth_user_id,OLD.member_id) IS DISTINCT FROM(NEW.workspace_id,NEW.auth_user_id,NEW.member_id) THEN NEW.mapping_grant_id:=gen_random_uuid();
 ELSIF NEW.mapping_grant_id IS DISTINCT FROM OLD.mapping_grant_id THEN RAISE EXCEPTION 'Mapping grant is immutable' USING ERRCODE='PT409';END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER fountain_mapping_incarnation BEFORE INSERT OR UPDATE ON fountain_private.identity_mapping FOR EACH ROW EXECUTE FUNCTION fountain_private.mapping_grant_guard();
CREATE TABLE fountain_private.workspace_children(
 hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'),parent_hash text NOT NULL CHECK(parent_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL,auth_session_id uuid NOT NULL,workspace_id text NOT NULL,member_id text NOT NULL,mapping_grant_id uuid NOT NULL,
 ledger_id text NOT NULL,membership_id text NOT NULL,account_id text NOT NULL,
 cache_binding text NOT NULL UNIQUE CHECK(cache_binding ~ '^[a-f0-9]{32}$'),
 created_at_ms bigint NOT NULL,expires_at_ms bigint NOT NULL CHECK(expires_at_ms>created_at_ms),revoked_at_ms bigint,
 UNIQUE(parent_hash,workspace_id,mapping_grant_id,ledger_id,membership_id,account_id,cache_binding)
);
CREATE INDEX workspace_children_parent ON fountain_private.workspace_children(parent_hash,workspace_id);
CREATE INDEX workspace_children_identity ON fountain_private.workspace_children(workspace_id,user_id) WHERE revoked_at_ms IS NULL;
CREATE TABLE fountain_private.workspace_directory_receipts(
 parent_hash text NOT NULL,workspace_id text NOT NULL,command_id uuid NOT NULL,operation text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),child_hash text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(parent_hash,workspace_id,command_id)
);
CREATE TABLE fountain_private.workspace_invitations(
 workspace_id text NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),issuer_parent_hash text NOT NULL,issuer_child_hash text NOT NULL,
 issuer_user_id uuid NOT NULL,issuer_member_id text NOT NULL,issuer_mapping_grant_id uuid NOT NULL,
 issuer_ledger_id text NOT NULL,issuer_membership_id text NOT NULL,issuer_account_id text NOT NULL,
 target_user_id uuid NOT NULL,role text NOT NULL CHECK(role IN('admin','member','guest')),
 nonce_hash text NOT NULL CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 consumed_at timestamptz,consumed_parent_hash text,consumed_child_hash text,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK((consumed_at IS NULL)=(consumed_parent_hash IS NULL) AND(consumed_at IS NULL)=(consumed_child_hash IS NULL)),
 PRIMARY KEY(workspace_id,id)
);
CREATE INDEX workspace_invitation_target ON fountain_private.workspace_invitations(target_user_id,workspace_id);
DO $rls$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['workspace_registry','workspace_children','workspace_directory_receipts','workspace_invitations'] LOOP
 EXECUTE format('ALTER TABLE fountain_private.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE fountain_private.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('REVOKE ALL ON fountain_private.%I FROM PUBLIC,anon,authenticated,service_role,fountain_backend',n);
 EXECUTE format('CREATE POLICY %I ON fountain_private.%I FOR ALL TO PUBLIC USING(false) WITH CHECK(false)',n||'_closed',n);
 END LOOP;
END $rls$;

-- Caller holds workspace writer, then live Auth user/session and parent vault.
-- No ensure/repair operation is permitted here: closed episodes stay closed.
CREATE FUNCTION fountain_private.workspace_identity(p_workspace text,p_user uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE answer jsonb;
BEGIN
 SELECT jsonb_build_object('member',jsonb_build_object('id',e.id,'name',e.data->>'name','email',e.data->>'email','role',e.data->>'role','active',true),
 'mappingGrantId',m.mapping_grant_id,'ledgerId',rt.ledger_id,'membershipId',cm.membership_id,'accountId',ca.account_id)
 INTO answer FROM fountain_private.identity_mapping m
 JOIN fountain_private.entities e ON e.workspace_id=m.workspace_id AND e.kind='member' AND e.id=m.member_id
 JOIN fountain_private.workspace_registry wr ON wr.workspace_id=m.workspace_id
 JOIN fountain_private.activity_runtime rt ON rt.workspace_id=m.workspace_id AND rt.singleton=1
 JOIN fountain_private.activity_current_members cm ON cm.workspace_id=m.workspace_id AND cm.member_id=m.member_id
 JOIN fountain_private.activity_memberships am ON am.workspace_id=cm.workspace_id AND am.id=cm.membership_id AND am.member_id=m.member_id AND am.ledger_id=rt.ledger_id AND am.closed_at IS NULL
 JOIN fountain_private.activity_current_accounts ca ON ca.workspace_id=m.workspace_id AND ca.member_id=m.member_id AND ca.auth_kind='supabase'
 JOIN fountain_private.activity_accounts aa ON aa.workspace_id=ca.workspace_id AND aa.id=ca.account_id AND aa.membership_id=am.id AND aa.auth_kind='supabase' AND aa.closed_at IS NULL
 WHERE m.workspace_id=p_workspace AND m.auth_user_id=p_user AND e.data->>'id'=e.id
 AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000
 AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
 AND e.data->>'role' IN('owner','admin','member','guest') AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
 FOR SHARE OF m,e,wr,rt,cm,am,ca,aa;
 IF answer IS NULL THEN RAISE EXCEPTION 'Workspace access required' USING ERRCODE='PT403';END IF;
 RETURN answer;
END $f$;
CREATE FUNCTION fountain_private.workspace_child_context(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE child fountain_private.workspace_children;parent fountain_private.account_session_vault;identity jsonb;uid uuid;stamp bigint;
BEGIN
 -- The unlocked lookup supplies immutable parent identity only. Authorization
 -- always rechecks under ordered locks, including the child row after waiting.
 SELECT * INTO child FROM fountain_private.workspace_children WHERE hash=p_context->>'sessionHash';
 IF NOT FOUND THEN RAISE EXCEPTION 'Workspace access required' USING ERRCODE='PT403';END IF;
 uid:=fountain_private.organization_identity(jsonb_build_object('userId',p_context->'userId','authSessionId',p_context->'authSessionId'));
 SELECT * INTO parent FROM fountain_private.account_session_vault WHERE hash=child.parent_hash FOR SHARE;
 stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF NOT FOUND OR parent.user_id<>uid OR parent.auth_session_id<>(p_context->>'authSessionId')::uuid OR parent.revoked_at_ms IS NOT NULL OR parent.logout_pending OR parent.expires_at_ms<=stamp THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 identity:=fountain_private.workspace_identity(p_context->>'workspaceId',uid);
 SELECT * INTO child FROM fountain_private.workspace_children WHERE hash=p_context->>'sessionHash' FOR SHARE;
 IF NOT FOUND OR child.user_id<>uid OR child.auth_session_id<>parent.auth_session_id OR child.parent_hash<>parent.hash
 OR child.workspace_id IS DISTINCT FROM p_context->>'workspaceId' OR child.member_id IS DISTINCT FROM p_context->>'memberId'
 OR child.cache_binding IS DISTINCT FROM p_context->>'cacheBinding' OR child.revoked_at_ms IS NOT NULL
 OR child.expires_at_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 OR child.mapping_grant_id IS DISTINCT FROM(identity->>'mappingGrantId')::uuid OR child.ledger_id IS DISTINCT FROM identity->>'ledgerId'
 OR child.membership_id IS DISTINCT FROM identity->>'membershipId' OR child.account_id IS DISTINCT FROM identity->>'accountId' THEN RAISE EXCEPTION 'Workspace grant changed' USING ERRCODE='PT403';END IF;
 IF parent.expires_at_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 RETURN identity->'member';
END $f$;

-- Keep the entire original validator for the original realm. An existing but
-- invalid legacy row can never fall through and be interpreted as a child.
CREATE FUNCTION fountain_cloud.store_context_legacy(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE profile jsonb; ws text; actor_id text;
BEGIN
 IF jsonb_typeof(p_context) IS DISTINCT FROM 'object'
  OR NOT (p_context ?& ARRAY['workspaceId','memberId','userId','authSessionId','sessionHash','cacheBinding'])
  OR p_context - ARRAY['workspaceId','memberId','userId','authSessionId','sessionHash','cacheBinding'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'Invalid storage context' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_context) e WHERE jsonb_typeof(e.value) <> 'string')
  OR length(p_context->>'workspaceId') NOT BETWEEN 1 AND 160 OR length(p_context->>'memberId') NOT BETWEEN 1 AND 160
  OR (p_context->>'userId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR (p_context->>'authSessionId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR (p_context->>'sessionHash') !~ '^[a-f0-9]{64}$' OR (p_context->>'cacheBinding') !~ '^[a-f0-9]{32}$' THEN
  RAISE EXCEPTION 'Invalid storage context' USING ERRCODE='22023';
 END IF;
 ws:=p_context->>'workspaceId';actor_id:=p_context->>'memberId';
 PERFORM fountain_cloud.store_lock(ws);
 PERFORM set_config('fountain.workspace_id',ws,true);
 -- Lock the live identities through this RPC: logout/ban/unlink cannot slip
 -- between authorization and mutation. The public RPC itself is service-only.
 PERFORM 1 FROM fountain_cloud.session_vault v
  JOIN auth.sessions s ON s.id=v.auth_session_id AND s.user_id=v.user_id
  JOIN auth.users u ON u.id=s.user_id
  JOIN fountain_private.identity_mapping m ON m.workspace_id=v.workspace_id AND m.auth_user_id=v.user_id
  JOIN fountain_private.entities e ON e.workspace_id=m.workspace_id AND e.kind='member' AND e.id=m.member_id
 WHERE v.workspace_id=ws AND v.hash=p_context->>'sessionHash'
  AND v.user_id=(p_context->>'userId')::uuid AND v.auth_session_id=(p_context->>'authSessionId')::uuid
  AND v.cache_binding=p_context->>'cacheBinding' AND v.revoked_at_ms IS NULL AND NOT v.logout_pending
  AND v.expires_at_ms > floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  AND m.member_id=actor_id
  AND u.deleted_at IS NULL AND NOT u.is_anonymous AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
  AND (s.not_after IS NULL OR s.not_after > clock_timestamp())
 FOR SHARE OF v,s,u,m,e;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401'; END IF;
 -- Reuse the authoritative member shape and live Auth validation, not JWT role,
 -- email matching or user-editable user_metadata.
 profile:=fountain_cloud.resolve_profile(ws,(p_context->>'userId')::uuid,(p_context->>'authSessionId')::uuid);
 IF profile IS NULL OR profile->'authSessionActive' IS DISTINCT FROM 'true'::jsonb
  OR profile->'member'->'active' IS DISTINCT FROM 'true'::jsonb OR profile->'member'->>'id' IS DISTINCT FROM actor_id THEN
  RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';
 END IF;
 RETURN profile->'member';
END $$;

CREATE OR REPLACE FUNCTION fountain_cloud.store_context(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
 IF jsonb_typeof(p_context) IS DISTINCT FROM 'object' OR NOT(p_context ?& ARRAY['workspaceId','memberId','userId','authSessionId','sessionHash','cacheBinding'])
 OR p_context-ARRAY['workspaceId','memberId','userId','authSessionId','sessionHash','cacheBinding']<>'{}'::jsonb
 OR EXISTS(SELECT 1 FROM jsonb_each(p_context) e WHERE jsonb_typeof(e.value)<>'string')
 OR length(p_context->>'workspaceId') NOT BETWEEN 1 AND 160 OR length(p_context->>'memberId') NOT BETWEEN 1 AND 160
 OR(p_context->>'sessionHash') !~ '^[a-f0-9]{64}$' OR(p_context->>'cacheBinding') !~ '^[a-f0-9]{32}$'
 OR(p_context->>'userId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR(p_context->>'authSessionId') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid storage context' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_context->>'workspaceId');PERFORM set_config('fountain.workspace_id',p_context->>'workspaceId',true);
 IF EXISTS(SELECT 1 FROM fountain_cloud.session_vault WHERE workspace_id=p_context->>'workspaceId' AND hash=p_context->>'sessionHash') THEN RETURN fountain_cloud.store_context_legacy(p_context);END IF;
 IF(p_context->>'workspaceId') !~ '^[A-Za-z0-9_-]{1,160}$' THEN RAISE EXCEPTION 'Invalid workspace identifier' USING ERRCODE='22023';END IF;
 RETURN fountain_private.workspace_child_context(p_context);
END $f$;

-- Workspace unlink/revoke must revoke children too, without touching the global
-- parent or another workspace. Existing password/shared-UUID guards are retained.
CREATE OR REPLACE FUNCTION fountain_cloud.account_revoke(p_workspace_id text,p_user_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
 UPDATE fountain_cloud.session_vault SET revoked_at_ms=greatest(created_at_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint),logout_pending=(token_ciphertext IS NOT NULL),version=version+1,refresh_lease_id=NULL,refresh_lease_until_ms=NULL
 WHERE workspace_id=p_workspace_id AND user_id=p_user_id AND revoked_at_ms IS NULL AND version<9007199254740991;
 IF EXISTS(SELECT 1 FROM fountain_cloud.session_vault WHERE workspace_id=p_workspace_id AND user_id=p_user_id AND revoked_at_ms IS NULL) THEN RAISE EXCEPTION 'Vault version limit' USING ERRCODE='PT503';END IF;
 UPDATE fountain_private.workspace_children SET revoked_at_ms=greatest(created_at_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE workspace_id=p_workspace_id AND user_id=p_user_id AND revoked_at_ms IS NULL;
END $f$;

-- Presence is the one read path that enumerates vault peers directly. Include
-- tokenless children through the same validator, never through a loose join.
CREATE OR REPLACE FUNCTION fountain_cloud.presence_publishers(p_context jsonb,p_hashes text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;peer record;member jsonb;answer jsonb:='[]';
BEGIN
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 IF p_hashes IS NULL OR cardinality(p_hashes)>500 OR COALESCE(array_ndims(p_hashes),1)<>1 OR EXISTS(SELECT 1 FROM unnest(p_hashes) h WHERE h IS NULL OR h !~ '^[a-f0-9]{64}$') OR(SELECT count(DISTINCT h) FROM unnest(p_hashes) h)<>cardinality(p_hashes) THEN RAISE EXCEPTION 'Invalid presence publisher hashes' USING ERRCODE='22023';END IF;
 FOR peer IN SELECT * FROM(SELECT v.hash,v.user_id,v.auth_session_id,v.cache_binding,m.member_id FROM fountain_cloud.session_vault v JOIN fountain_private.identity_mapping m ON m.workspace_id=v.workspace_id AND m.auth_user_id=v.user_id WHERE v.workspace_id=ws AND v.hash=ANY(p_hashes)
 UNION ALL SELECT c.hash,c.user_id,c.auth_session_id,c.cache_binding,c.member_id FROM fountain_private.workspace_children c WHERE c.workspace_id=ws AND c.hash=ANY(p_hashes)) peers ORDER BY hash COLLATE "C" LOOP
  BEGIN member:=fountain_cloud.store_context(jsonb_build_object('workspaceId',ws,'memberId',peer.member_id,'userId',peer.user_id,'authSessionId',peer.auth_session_id,'sessionHash',peer.hash,'cacheBinding',peer.cache_binding));
  EXCEPTION WHEN SQLSTATE 'PT401' OR SQLSTATE 'PT403' THEN CONTINUE;END;
  answer:=answer||jsonb_build_array(jsonb_build_object('hash',peer.hash,'cacheBinding',peer.cache_binding,'member',member));
 END LOOP;RETURN answer;
END $f$;
DO $acl$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['fountain_private.mapping_grant_guard()','fountain_private.workspace_identity(text,uuid)','fountain_private.workspace_child_context(jsonb)','fountain_cloud.store_context(jsonb)','fountain_cloud.store_context_legacy(jsonb)','fountain_cloud.account_revoke(text,uuid)'] LOOP
 EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO postgres';EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated,service_role,fountain_backend';
 END LOOP;
END $acl$;
