-- DRAFT ONLY: issues no credentials, mappings, grants, sessions or Auth users.
-- Requires current service-authority/grant-admin/accounts/scheduler migrations.
-- Server-role RPC, not client RLS. Review and actual PostgreSQL QA before apply.
CREATE UNIQUE INDEX service_grants_scim_token_unique ON fountain_cloud.service_grants(workspace_id,token_hash) WHERE purpose='scim';
CREATE INDEX onboarding_claims_member_lookup ON fountain_cloud.onboarding_claims(workspace_id,member_id,nonce_hash);
CREATE INDEX account_intents_pending_user_all ON fountain_cloud.account_intents(target_user_id,workspace_id,member_id) WHERE state IN('prepared','attempted');

CREATE FUNCTION fountain_cloud.scim_authorize(p_workspace_id text,p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_grant fountain_cloud.service_grants;v_context jsonb;
BEGIN
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR p_token_hash IS NULL OR p_token_hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'SCIM authentication required' USING ERRCODE='PT401';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);PERFORM set_config('fountain.workspace_id',p_workspace_id,true);
 SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=p_workspace_id AND g.purpose='scim' AND g.token_hash=p_token_hash AND g.enabled AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp()) FOR SHARE OF g;
 IF NOT FOUND THEN RAISE EXCEPTION 'SCIM authentication required' USING ERRCODE='PT401';END IF;
 v_context:=jsonb_build_object('kind','scim','workspaceId',p_workspace_id,'grantId',v_grant.id,'grantVersion',v_grant.version,'memberId',v_grant.member_id,'tokenHash',p_token_hash);
 -- Existing current mapped/active/confirmed/unbanned real owner proof. No SID,
 -- email adoption or user_metadata role is manufactured for a service caller.
 PERFORM fountain_cloud.service_context(v_context);RETURN v_context;
EXCEPTION WHEN SQLSTATE 'PT401' THEN RAISE EXCEPTION 'SCIM authentication required' USING ERRCODE='PT401';
END $$;
ALTER FUNCTION fountain_cloud.scim_authorize(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.scim_authorize(text,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fountain_cloud_scim_authorize(p_workspace_id text,p_token_hash text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.scim_authorize(p_workspace_id,p_token_hash) $$;
ALTER FUNCTION public.fountain_cloud_scim_authorize(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_scim_authorize(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_scim_authorize(text,text) TO service_role;

-- Under the workspace lock, AFTER CAS and BEFORE entity mutation. All target
-- Auth rows get SHARE NOWAIT before try-account-lock: GoTrue DELETE takes Auth
-- EXCL then cascades into the blocking account_mapping_guard global lock.
-- Issuer SHAREs may already be held, so no new lock acquisition may block.
CREATE FUNCTION fountain_cloud.member_deprovision_preflight(p_workspace_id text,p_changes jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_targets jsonb;v_ids text[];v_delete_ids text[];v_users uuid[];v_mapped_users uuid[];v_current_users uuid[];v_user uuid;v_target record;
BEGIN
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'deleted',x.deleted) ORDER BY x.id COLLATE "C"),'[]'::jsonb),COALESCE(array_agg(x.id ORDER BY x.id COLLATE "C"),ARRAY[]::text[]) INTO v_targets,v_ids
 FROM(SELECT c.value->>'id' AS id,bool_or(c.value->>'op'='delete') AS deleted FROM jsonb_array_elements(p_changes) c
  WHERE c.value->>'kind'='member' AND jsonb_typeof(c.value->'id')='string' AND length(c.value->>'id') BETWEEN 1 AND 160
   AND(c.value->>'op'='delete' OR(c.value->>'op'='put' AND c.value->'data'->'active'='false'::jsonb)) GROUP BY c.value->>'id') x;
 IF cardinality(v_ids)=0 THEN RETURN;END IF;
 SELECT COALESCE(array_agg(j.value->>'id' ORDER BY (j.value->>'id') COLLATE "C"),ARRAY[]::text[]) INTO v_delete_ids FROM jsonb_array_elements(v_targets) j WHERE j.value->'deleted'='true'::jsonb;
 -- Preserve unknown local creates as well as password/relink operations. Do not
 -- cancel/forget an Admin request which can still publish after this transaction.
 IF EXISTS(SELECT 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=ANY(v_ids) AND i.state IN('prepared','attempted')) THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 SELECT COALESCE(array_agg(m.auth_user_id ORDER BY m.auth_user_id),ARRAY[]::uuid[]) INTO v_mapped_users FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids);
 SELECT COALESCE(array_agg(x.user_id ORDER BY x.user_id),ARRAY[]::uuid[]) INTO v_users FROM(
  SELECT m.auth_user_id AS user_id FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids)
  UNION SELECT i.target_user_id FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=ANY(v_ids)
  UNION SELECT u.auth_user_id FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=p_workspace_id AND u.member_id=ANY(v_ids)) x;
 PERFORM 1 FROM auth.users u WHERE u.id=ANY(v_users) ORDER BY u.id FOR SHARE OF u NOWAIT;
 FOREACH v_user IN ARRAY v_users LOOP
  IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:auth-account:'||v_user::text,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 END LOOP;
 -- Same key namespace as account_user_lock, without waiting on cross-ws issuers.
 -- Mapping DELETE's trigger reacquires our held global key reentrantly.
 PERFORM 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids) ORDER BY m.auth_user_id FOR UPDATE OF m NOWAIT;
 SELECT COALESCE(array_agg(m.auth_user_id ORDER BY m.auth_user_id),ARRAY[]::uuid[]) INTO v_current_users FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=ANY(v_ids);
 IF v_current_users IS DISTINCT FROM v_mapped_users THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 PERFORM 1 FROM fountain_cloud.session_vault v WHERE v.workspace_id=p_workspace_id AND v.user_id=ANY(v_mapped_users) AND v.revoked_at_ms IS NULL ORDER BY v.hash FOR UPDATE OF v NOWAIT;
 -- No foreign workspace is changed; its pending intent nevertheless remains a
 -- global fence for the shared Auth UUID, regardless of kind/create/relink.
 PERFORM 1 FROM fountain_cloud.account_intents i WHERE i.target_user_id=ANY(v_users) AND i.state IN('prepared','attempted') ORDER BY i.target_user_id,i.workspace_id,i.member_id FOR SHARE OF i NOWAIT;
 IF FOUND THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';END IF;
 PERFORM 1 FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=ANY(v_ids) ORDER BY i.member_id FOR UPDATE OF i NOWAIT;
 PERFORM 1 FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=p_workspace_id AND u.member_id=ANY(v_ids) ORDER BY u.member_id FOR UPDATE OF u NOWAIT;
 -- Used AND unused setup claims must not re-authorize a recreated member ID.
 PERFORM 1 FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=p_workspace_id AND c.member_id=ANY(v_delete_ids) ORDER BY c.member_id,c.nonce_hash FOR UPDATE OF c NOWAIT;
 -- Historical unlink/terminal UUIDs are locks/fences only. If such a UUID now
 -- belongs to another member, do NOT revoke that other member's current sessions.
 FOREACH v_user IN ARRAY v_mapped_users LOOP PERFORM fountain_cloud.account_revoke(p_workspace_id,v_user);END LOOP;
 FOR v_target IN SELECT j.value FROM jsonb_array_elements(v_targets) j LOOP
  IF v_target.value->'deleted'='true'::jsonb THEN
   DELETE FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id AND m.member_id=v_target.value->>'id';
   DELETE FROM fountain_cloud.account_intents i WHERE i.workspace_id=p_workspace_id AND i.member_id=v_target.value->>'id' AND i.state NOT IN('prepared','attempted');
   DELETE FROM fountain_cloud.account_unlinks u WHERE u.workspace_id=p_workspace_id AND u.member_id=v_target.value->>'id';
   DELETE FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=p_workspace_id AND c.member_id=v_target.value->>'id';
  END IF;
 END LOOP;
 -- The unchanged kernel checks FINAL usable mapped owners after these removals.
 -- Every later validation/last-owner/revision error rolls back revocation,
 -- mapping epochs, terminal cleanup and entity writes together.
 -- active:false keeps mapping but old vault sessions stay revoked on reactivation.
 -- DELETE+same-ID recreation cannot recover old terminal receipts/unlink proof.
 -- Re-provision explicitly; never adopt an existing Auth identity by email/ID.
 -- Auth users/sessions and other workspaces are never mutated by this helper.
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'ACCOUNT_OPERATION_PENDING' USING ERRCODE='PT409';
END $$;
ALTER FUNCTION fountain_cloud.member_deprovision_preflight(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.member_deprovision_preflight(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Unchanged original kernel except the single pre-mutation hook below.
CREATE OR REPLACE FUNCTION fountain_cloud.store_apply_changes_locked(p_workspace_id text,p_expected_revision bigint,p_changes jsonb) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_ws text:=p_workspace_id;v_revision bigint;v_change jsonb;v_previous fountain_private.entities;
 v_found_previous boolean;v_affected bigint;v_data jsonb;v_change_kind text;v_change_id text;v_meta_key text;v_steps bigint:=0;v_owner_mutated boolean:=false;
BEGIN
 v_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
 IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 PERFORM fountain_cloud.member_deprovision_preflight(p_workspace_id,p_changes);
 FOR v_change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
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
    IF NOT(v_change ?& ARRAY['op','kind','id','data','previousCreatedAt']) OR v_change-ARRAY['op','kind','id','data','previousCreatedAt']<>'{}'::jsonb
     OR jsonb_typeof(v_change->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    v_data:=v_change->'data';
    IF btrim(v_change_id)='' OR v_data->>'id' IS DISTINCT FROM v_change_id OR jsonb_typeof(v_data->'id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_data->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v_data->'updated_at') IS DISTINCT FROM 'string'
     OR length(v_data->>'created_at') NOT BETWEEN 1 AND 64 OR length(v_data->>'updated_at') NOT BETWEEN 1 AND 64
     OR v_change_kind='attachment' AND v_data ? 'data' THEN RAISE EXCEPTION 'Invalid entity data' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_previous FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    v_found_previous:=FOUND;
    IF (v_found_previous AND (v_change->'previousCreatedAt' IS DISTINCT FROM to_jsonb(v_previous.created_at) OR v_data->>'created_at' IS DISTINCT FROM v_previous.created_at))
     OR (NOT v_found_previous AND v_change->'previousCreatedAt' IS DISTINCT FROM 'null'::jsonb) THEN
     RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
    END IF;
    INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at)
    VALUES(v_ws,v_change_kind,v_change_id,v_data,v_data->>'created_at',v_data->>'updated_at')
    ON CONFLICT(workspace_id,kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at;
    v_steps:=v_steps+1;
   ELSE
    IF NOT(v_change ?& ARRAY['op','kind','id']) OR v_change-ARRAY['op','kind','id']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid entity change' USING ERRCODE='22023'; END IF;
    DELETE FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind=v_change_kind AND e.id=v_change_id;
    GET DIAGNOSTICS v_affected=ROW_COUNT;v_steps:=v_steps+v_affected;
   END IF;
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
REVOKE ALL ON FUNCTION fountain_cloud.store_apply_changes_locked(text,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Serialize profile-check -> vault INSERT with membership deprovision. A login
-- before deprovision is scanned/revoked; a login after it sees inactive/unmapped.
CREATE OR REPLACE FUNCTION fountain_cloud.vault_create(p_workspace_id text,p_row jsonb) RETURNS void
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
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Session creation requires a current database snapshot' USING ERRCODE='PT503';END IF;
 -- SECURITY INVOKER has no private store_lock EXECUTE. Use its identical builtin
 -- namespace directly, keeping all original privileges/cipher/Auth validation.
 PERFORM pg_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||p_workspace_id,'UTF8')),'hex'),1,16))::bit(64)::bigint);
 profile := fountain_cloud.resolve_profile(p_workspace_id,(p_row->>'userId')::uuid,(p_row->>'authSessionId')::uuid);
 IF profile IS NULL OR profile->'authSessionActive' IS DISTINCT FROM 'true'::jsonb OR profile->'member'->'active' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'Session identity unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO fountain_cloud.session_vault(workspace_id,hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,version,token_ciphertext)
 VALUES(p_workspace_id,p_row->>'hash',(p_row->>'userId')::uuid,(p_row->>'authSessionId')::uuid,p_row->>'cacheBinding',(p_row->>'createdAt')::bigint,(p_row->>'expiresAt')::bigint,0,p_row->'tokens');
END $$;
REVOKE ALL ON FUNCTION fountain_cloud.vault_create(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.vault_create(text,jsonb) TO service_role;
