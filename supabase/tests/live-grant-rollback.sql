-- Root-only disposable real-Postgres proof. Replace __QA_WORKSPACE__ with the
-- sealed grants namespace after a genuine application login. No Auth session,
-- mapping, password, cookie or credential is manufactured by this script.
DO $verify$
DECLARE ws constant text:='__QA_WORKSPACE__'; ctx jsonb; grant_id uuid:=gen_random_uuid();
 failed_id uuid:=gen_random_uuid(); proof_hash text:=encode(sha256(gen_random_bytes(32)),'hex');
 before_revision bigint; before_audits bigint; result jsonb; n integer:=0;
BEGIN
 IF ws!~'^fountain-qa-cloud-grants-[a-f0-9]{16}$' THEN RAISE EXCEPTION 'Disposable scope required';END IF;
 SELECT jsonb_build_object('workspaceId',v.workspace_id,'memberId',m.member_id,'userId',v.user_id,
  'authSessionId',v.auth_session_id,'sessionHash',v.hash,'cacheBinding',v.cache_binding)
 INTO STRICT ctx FROM fountain_cloud.session_vault v
 JOIN fountain_private.identity_mapping m ON m.workspace_id=v.workspace_id AND m.auth_user_id=v.user_id
 JOIN auth.sessions s ON s.id=v.auth_session_id AND s.user_id=v.user_id
 WHERE v.workspace_id=ws AND m.member_id='local' AND v.revoked_at_ms IS NULL AND v.expires_at_ms>extract(epoch FROM clock_timestamp())*1000;
 PERFORM fountain_cloud.store_context(ctx);
 before_revision:=fountain_cloud.store_revision(ws,'_entity_revision');
 SELECT count(*) INTO before_audits FROM fountain_private.entities WHERE workspace_id=ws AND kind='audit';
 BEGIN
  UPDATE fountain_private.meta SET data='9007199254740991' WHERE workspace_id=ws AND key='_entity_revision';
  PERFORM fountain_cloud.service_grant_admin(ctx,'create',jsonb_build_object('id',failed_id,'expires_at',NULL,'token_hash',proof_hash));
  RAISE EXCEPTION 'Audit revision limit accepted';
 EXCEPTION WHEN SQLSTATE 'PT413' THEN n:=n+1;
 END;
 IF EXISTS(SELECT 1 FROM fountain_cloud.service_grants WHERE workspace_id=ws AND id=failed_id)
  OR fountain_cloud.store_revision(ws,'_entity_revision')<>before_revision
  OR (SELECT count(*) FROM fountain_private.entities WHERE workspace_id=ws AND kind='audit')<>before_audits THEN RAISE EXCEPTION 'Create did not roll back';END IF;
 result:=fountain_cloud.service_grant_admin(ctx,'create',jsonb_build_object('id',grant_id,'expires_at',NULL,'token_hash',proof_hash));
 IF result->'created'<>'true'::jsonb OR result->'grant'->'enabled'<>'false'::jsonb THEN RAISE EXCEPTION 'Inactive grant required';END IF;
 before_revision:=fountain_cloud.store_revision(ws,'_entity_revision');
 BEGIN
  UPDATE fountain_private.meta SET data='9007199254740991' WHERE workspace_id=ws AND key='_entity_revision';
  PERFORM fountain_cloud.service_grant_admin(ctx,'activate',jsonb_build_object('id',grant_id,'token_hash',proof_hash));
  RAISE EXCEPTION 'Activation audit limit accepted';
 EXCEPTION WHEN SQLSTATE 'PT413' THEN n:=n+1;
 END;
 IF fountain_cloud.store_revision(ws,'_entity_revision')<>before_revision
  OR NOT EXISTS(SELECT 1 FROM fountain_cloud.service_grants WHERE workspace_id=ws AND id=grant_id AND NOT enabled AND version=1) THEN RAISE EXCEPTION 'Activation did not roll back';END IF;
 BEGIN
  UPDATE fountain_private.meta SET data='9007199254740991' WHERE workspace_id=ws AND key='_entity_revision';
  PERFORM fountain_cloud.service_grant_admin(ctx,'revoke',jsonb_build_object('id',grant_id));
  RAISE EXCEPTION 'Revocation audit limit accepted';
 EXCEPTION WHEN SQLSTATE 'PT413' THEN n:=n+1;
 END;
 IF fountain_cloud.store_revision(ws,'_entity_revision')<>before_revision
  OR NOT EXISTS(SELECT 1 FROM fountain_cloud.service_grants WHERE workspace_id=ws AND id=grant_id AND NOT enabled AND version=1)
  OR (SELECT count(*) FROM fountain_private.entities WHERE workspace_id=ws AND kind='audit')<>before_audits+1 THEN RAISE EXCEPTION 'Revocation did not roll back';END IF;
 PERFORM fountain_cloud.service_grant_admin(ctx,'revoke',jsonb_build_object('id',grant_id));
 IF n<>3 OR (SELECT count(*) FROM fountain_private.entities WHERE workspace_id=ws AND kind='audit')<>before_audits+2 THEN RAISE EXCEPTION 'Unexpected proof outcome';END IF;
END $verify$;
SELECT jsonb_build_object('realAuthSession',true,'atomicRollbackTransitions',3,'finalProofGrantRevoked',true) AS result;
