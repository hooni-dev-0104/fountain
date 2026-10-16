-- Root-only real PostgreSQL/Auth proofs. Replace BOTH workspace literals below.
-- Keep the QA owner HTTP session live and pause other QA writers while running.
-- No Auth/session is fabricated; all temporary mutations and role changes roll
-- back. No original namespace is read, no private context/hash/body is emitted.
BEGIN ISOLATION LEVEL READ COMMITTED;
DO $proofs$
DECLARE v_ws text:='QA_WORKSPACE';v_operator text:=current_user;v_context jsonb;v_meta jsonb;v_reply jsonb;
 v_digest text;v_before text;v_after text;v_phase integer;v_case integer;v_pass integer:=0;v_role text;
 v_id text;v_denied boolean;v_user uuid;v_session uuid;v_vault text;
BEGIN
 IF v_ws !~ '^fountain-qa-cloud-inline-[a-f0-9]{16}$' OR current_setting('transaction_isolation')<>'read committed'
  OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user AND(r.rolsuper OR r.rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe inline QA scope';END IF;
 SELECT jsonb_build_object('workspaceId',v.workspace_id,'memberId',m.member_id,'userId',v.user_id::text,
  'authSessionId',v.auth_session_id::text,'sessionHash',v.hash,'cacheBinding',v.cache_binding)
 INTO v_context FROM fountain_cloud.session_vault v
 JOIN fountain_private.identity_mapping m ON m.workspace_id=v.workspace_id AND m.auth_user_id=v.user_id AND m.member_id='local'
 JOIN auth.sessions s ON s.id=v.auth_session_id AND s.user_id=v.user_id
 JOIN auth.users u ON u.id=v.user_id
 WHERE v.workspace_id=v_ws AND v.revoked_at_ms IS NULL AND NOT v.logout_pending
  AND v.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
  AND(s.not_after IS NULL OR s.not_after>clock_timestamp()) AND u.deleted_at IS NULL AND NOT u.is_anonymous
  AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
 ORDER BY v.created_at_ms DESC,v.hash LIMIT 1;
 IF v_context IS NULL THEN RAISE EXCEPTION 'A real linked live QA owner session is required';END IF;
 v_user:=(v_context->>'userId')::uuid;v_session:=(v_context->>'authSessionId')::uuid;v_vault:=v_context->>'sessionHash';
 -- Validate the actual current member through the production human verifier.
 IF fountain_cloud.store_context(v_context)->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Actual QA owner required';END IF;
 SELECT e.data-'data' INTO v_meta FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='attachment' AND e.id='qa-inline-small';
 IF v_meta IS NULL OR v_meta->>'size'<>'80' THEN RAISE EXCEPTION 'Expected QA inline seed is missing';END IF;
 FOR v_phase IN 0..1 LOOP
  SELECT encode(sha256(convert_to(jsonb_build_object(
   'attachments',(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='attachment'),
   'meta',(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.key),'[]'::jsonb) FROM fountain_private.meta m WHERE m.workspace_id=v_ws),
   'receipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.session_hash,r.transaction_id),'[]'::jsonb) FROM fountain_cloud.store_commit_receipts r WHERE r.workspace_id=v_ws)
  )::text,'UTF8')),'hex') INTO v_after;
  IF v_phase=1 THEN IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'QA source metadata or receipts changed';END IF;v_pass:=v_pass+1;EXIT;END IF;
  v_before:=v_after;
  SET LOCAL ROLE service_role;
  v_reply:=public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta,0,0,NULL);
  PERFORM set_config('role',v_operator,true);
  IF v_reply->>'workspaceId' IS DISTINCT FROM v_ws OR v_reply->>'attachmentId'<>'qa-inline-small' OR v_reply->>'offset'<>'0'
   OR v_reply->>'size'<>'80' OR v_reply->>'bytesBase64'<>'' OR v_reply->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(repeat('S',80),'UTF8')),'hex')
   OR v_reply->>'sourceDigest' !~ '^[a-f0-9]{64}$' OR v_reply-ARRAY['workspaceId','attachmentId','offset','size','sha256','sourceDigest','bytesBase64']<>'{}'::jsonb THEN RAISE EXCEPTION 'Actual preflight contract failed';END IF;
  v_digest:=v_reply->>'sourceDigest';v_pass:=v_pass+1;
  SET LOCAL ROLE service_role;
  v_reply:=public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta,3,11,v_digest);
  PERFORM set_config('role',v_operator,true);
  IF v_reply->>'offset'<>'3' OR v_reply->>'sourceDigest' IS DISTINCT FROM v_digest OR v_reply->>'size'<>'80'
   OR decode(v_reply->>'bytesBase64','base64') IS DISTINCT FROM convert_to(repeat('S',11),'UTF8') THEN RAISE EXCEPTION 'Actual range contract failed';END IF;v_pass:=v_pass+1;
  v_denied:=false;BEGIN SET LOCAL ROLE service_role;PERFORM public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta,0,65537,v_digest);
   EXCEPTION WHEN SQLSTATE 'PT400' THEN v_denied:=true;END;PERFORM set_config('role',v_operator,true);
  IF NOT v_denied THEN RAISE EXCEPTION 'Oversized range was accepted';END IF;v_pass:=v_pass+1;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
   v_denied:=false;BEGIN PERFORM set_config('role',v_role,true);PERFORM public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta,0,0,NULL);
    EXCEPTION WHEN insufficient_privilege THEN v_denied:=true;END;PERFORM set_config('role',v_operator,true);
   IF NOT v_denied THEN RAISE EXCEPTION 'Public role unexpectedly executed inline RPC';END IF;v_pass:=v_pass+1;
  END LOOP;
  v_denied:=false;BEGIN SET LOCAL ROLE service_role;PERFORM public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta||'{"name":"stale-qa-metadata"}'::jsonb,0,0,NULL);
   EXCEPTION WHEN SQLSTATE 'PT409' THEN v_denied:=true;END;PERFORM set_config('role',v_operator,true);
  IF NOT v_denied THEN RAISE EXCEPTION 'Stale metadata was accepted';END IF;v_pass:=v_pass+1;
  BEGIN
   UPDATE fountain_private.entities e SET data=jsonb_set(e.data,'{data}',to_jsonb(replace(encode(convert_to(repeat('T',80),'UTF8'),'base64'),E'\n','')))
    WHERE e.workspace_id=v_ws AND e.kind='attachment' AND e.id='qa-inline-small';
   v_denied:=false;BEGIN SET LOCAL ROLE service_role;PERFORM public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta,0,1,v_digest);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_denied:=true;END;PERFORM set_config('role',v_operator,true);
   IF NOT v_denied THEN RAISE EXCEPTION 'Same-size inline data replacement bypassed digest';END IF;
   RAISE EXCEPTION 'Rollback QA source mutation' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN v_pass:=v_pass+1;END;
  FOR v_case IN 1..6 LOOP BEGIN
   -- Both legitimate revoked states satisfy the private vault CHECKs. Never
   -- force an invalid row (Postgres constraint diagnostics could expose it).
   IF v_case=1 THEN UPDATE fountain_cloud.session_vault v SET logout_pending=true,revoked_at_ms=greatest(v.created_at_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint),refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE v.workspace_id=v_ws AND v.hash=v_vault;
   ELSIF v_case=2 THEN UPDATE fountain_cloud.session_vault v SET logout_pending=false,token_ciphertext=NULL,revoked_at_ms=greatest(v.created_at_ms,floor(extract(epoch FROM clock_timestamp())*1000)::bigint),refresh_lease_id=NULL,refresh_lease_until_ms=NULL WHERE v.workspace_id=v_ws AND v.hash=v_vault;
   ELSIF v_case=3 THEN UPDATE auth.sessions s SET not_after=clock_timestamp()-interval '1 minute' WHERE s.id=v_session AND s.user_id=v_user;
   ELSIF v_case=4 THEN UPDATE auth.users u SET banned_until=clock_timestamp()+interval '1 hour' WHERE u.id=v_user;
   ELSIF v_case=5 THEN DELETE FROM fountain_private.identity_mapping m WHERE m.workspace_id=v_ws AND m.member_id='local' AND m.auth_user_id=v_user;
   ELSE UPDATE fountain_private.entities e SET data=jsonb_set(e.data,'{active}','false'::jsonb) WHERE e.workspace_id=v_ws AND e.kind='member' AND e.id='local';END IF;
   v_denied:=false;BEGIN SET LOCAL ROLE service_role;PERFORM public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta,0,0,NULL);
    EXCEPTION WHEN SQLSTATE 'PT401' THEN v_denied:=true;END;PERFORM set_config('role',v_operator,true);
   IF NOT v_denied THEN RAISE EXCEPTION 'Revoked actual identity was accepted';END IF;
   RAISE EXCEPTION 'Rollback QA authorization mutation' USING ERRCODE='PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN v_pass:=v_pass+1;END;END LOOP;
  -- A live successful call after every mutation loop proves role/Auth rollback.
  SET LOCAL ROLE service_role;PERFORM public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-small',v_meta,0,0,NULL);PERFORM set_config('role',v_operator,true);
  FOREACH v_id IN ARRAY ARRAY['qa-inline-bad-suffix','qa-inline-bad-size','qa-inline-bad-sha'] LOOP
   SELECT e.data-'data' INTO v_reply FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='attachment' AND e.id=v_id;
   IF v_reply IS NULL THEN RAISE EXCEPTION 'Expected corrupt QA seed is missing';END IF;
   v_denied:=false;BEGIN SET LOCAL ROLE service_role;PERFORM public.fountain_cloud_inline_attachment_range(v_context,v_id,v_reply,0,0,NULL);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_denied:=true;END;PERFORM set_config('role',v_operator,true);
   IF NOT v_denied THEN RAISE EXCEPTION 'Corrupt inline source was accepted';END IF;v_pass:=v_pass+1;
  END LOOP;
  SELECT e.data-'data' INTO v_reply FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='attachment' AND e.id='qa-inline-padbits';
  IF v_reply IS NULL THEN RAISE EXCEPTION 'Expected padbits QA seed is missing';END IF;
  SET LOCAL ROLE service_role;v_reply:=public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-padbits',v_reply,0,0,NULL);PERFORM set_config('role',v_operator,true);
  IF v_reply->>'size'<>'1' OR v_reply->>'sha256' IS DISTINCT FROM encode(sha256(decode('00','hex')),'hex') THEN RAISE EXCEPTION 'Legacy padbits preflight failed';END IF;
  SELECT e.data-'data' INTO v_meta FROM fountain_private.entities e WHERE e.workspace_id=v_ws AND e.kind='attachment' AND e.id='qa-inline-padbits';
  SET LOCAL ROLE service_role;v_reply:=public.fountain_cloud_inline_attachment_range(v_context,'qa-inline-padbits',v_meta,0,1,v_reply->>'sourceDigest');PERFORM set_config('role',v_operator,true);
  IF decode(v_reply->>'bytesBase64','base64') IS DISTINCT FROM decode('00','hex') THEN RAISE EXCEPTION 'Legacy padbits bytes failed';END IF;v_pass:=v_pass+1;
 END LOOP;
 IF v_pass<>18 OR current_user IS DISTINCT FROM v_operator THEN RAISE EXCEPTION 'Inline QA coverage or role restoration failed';END IF;
EXCEPTION WHEN OTHERS THEN
 -- Never propagate failed-row DETAIL from a private vault/Auth constraint.
 -- The exception block first rolls back ALL SQL changes made by this DO.
 RAISE EXCEPTION 'Inline QA proof failed after % checked groups',v_pass;
END $proofs$;
SELECT true AS inline_read_committed_proofs_passed,18 AS checked_groups;
ROLLBACK;

BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $isolation$
DECLARE v_ws text:='QA_WORKSPACE';v_denied boolean:=false;v_operator text:=current_user;
BEGIN
 IF v_ws !~ '^fountain-qa-cloud-inline-[a-f0-9]{16}$' THEN RAISE EXCEPTION 'Unsafe inline QA scope';END IF;
 -- Isolation must fail before a malformed context can reach Auth or data reads.
 BEGIN SET LOCAL ROLE service_role;PERFORM public.fountain_cloud_inline_attachment_range('{}'::jsonb,'qa-inline-small','{}'::jsonb,0,0,NULL);
 EXCEPTION WHEN SQLSTATE 'PT503' THEN v_denied:=true;END;
 PERFORM set_config('role',v_operator,true);
 IF NOT v_denied THEN RAISE EXCEPTION 'Stale isolation was accepted';END IF;
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Inline isolation QA proof failed';
END $isolation$;
SELECT true AS inline_repeatable_read_rejected,19 AS total_checked_groups;
ROLLBACK;
