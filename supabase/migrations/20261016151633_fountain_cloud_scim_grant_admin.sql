-- DRAFT ONLY. No credentials are issued by this migration. Requires the private
-- service-authority/store kernels. Apply only after independent/actual SQL QA.
BEGIN;
ALTER TABLE fountain_cloud.service_grants ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE fountain_cloud.service_grants ADD COLUMN creation_digest text CHECK(creation_digest~'^[a-f0-9]{64}$');
ALTER TABLE fountain_cloud.service_grants ADD COLUMN pending_until timestamptz;
CREATE INDEX service_grants_scim_created ON fountain_cloud.service_grants(workspace_id,created_at,id) WHERE purpose='scim';

CREATE FUNCTION fountain_cloud.scim_grant_metadata(p_grant fountain_cloud.service_grants) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p_grant.id,'purpose','scim','version',p_grant.version,'enabled',p_grant.enabled,
  'issuer_member_id',p_grant.member_id,
  'created_at',to_char(p_grant.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expires_at',CASE WHEN p_grant.expires_at IS NULL THEN NULL ELSE to_char(p_grant.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'pending_until',CASE WHEN p_grant.pending_until IS NULL THEN NULL ELSE to_char(p_grant.pending_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
$$;
REVOKE ALL ON FUNCTION fountain_cloud.scim_grant_metadata(fountain_cloud.service_grants) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION fountain_cloud.service_grant_admin(p_context jsonb,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_actor jsonb;v_ws text;v_now timestamptz;v_id uuid;v_grant fountain_cloud.service_grants;
 v_expiry timestamptz;v_digest text;v_operation text;v_created boolean:=false;
 v_limit integer;v_cursor_time timestamptz;v_cursor_id uuid;v_tokens jsonb:='[]'::jsonb;v_next jsonb;v_count integer:=0;v_last jsonb;
 v_audit_id text;v_stamp text;v_revision bigint;
BEGIN
 -- Real human Auth/vault/mapping/member checks and the workspace writer lock
 -- precede metadata, exact-create replay and every credential state change.
 v_actor:=fountain_cloud.store_context(p_context);v_ws:=p_context->>'workspaceId';v_now:=clock_timestamp();
 IF v_actor->>'role' IS DISTINCT FROM 'owner' OR v_actor->'active' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='PT403';END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>4096 THEN RAISE EXCEPTION 'Invalid grant request' USING ERRCODE='22023';END IF;
 IF p_action='list' THEN
  IF NOT(p_payload ?& ARRAY['limit','cursor']) OR p_payload-ARRAY['limit','cursor']<>'{}'::jsonb OR jsonb_typeof(p_payload->'limit') IS DISTINCT FROM 'number'
   OR (p_payload->>'limit')!~'^(?:[1-9]|[1-9][0-9]|100)$' THEN RAISE EXCEPTION 'Invalid grant list' USING ERRCODE='22023';END IF;
  v_limit:=(p_payload->>'limit')::integer;
  IF p_payload->'cursor'<>'null'::jsonb THEN
   IF jsonb_typeof(p_payload->'cursor') IS DISTINCT FROM 'object' OR NOT(p_payload->'cursor' ?& ARRAY['workspaceId','created_at','id'])
    OR (p_payload->'cursor')-ARRAY['workspaceId','created_at','id']<>'{}'::jsonb OR p_payload->'cursor'->>'workspaceId' IS DISTINCT FROM v_ws
    OR EXISTS(SELECT 1 FROM jsonb_each(p_payload->'cursor') j WHERE jsonb_typeof(j.value) IS DISTINCT FROM 'string')
    OR (p_payload->'cursor'->>'created_at')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?Z$'
    OR (p_payload->'cursor'->>'id')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid grant cursor' USING ERRCODE='22023';END IF;
   v_cursor_time:=(p_payload->'cursor'->>'created_at')::timestamptz;v_cursor_id:=(p_payload->'cursor'->>'id')::uuid;
  END IF;
  FOR v_grant IN SELECT g.* FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_ws AND g.purpose='scim'
   AND(v_cursor_time IS NULL OR (g.created_at,g.id)>(v_cursor_time,v_cursor_id)) ORDER BY g.created_at,g.id LIMIT v_limit+1 LOOP
   IF v_count=v_limit THEN v_next:=jsonb_build_object('created_at',v_last->>'created_at','id',v_last->>'id');EXIT;END IF;
   v_last:=jsonb_build_object('created_at',to_char(v_grant.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',v_grant.id);v_tokens:=v_tokens||jsonb_build_array(fountain_cloud.scim_grant_metadata(v_grant));v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('tokens',v_tokens,'next_cursor',v_next);
 END IF;
 IF p_action IS NULL OR p_action NOT IN('create','activate','revoke') OR jsonb_typeof(p_payload->'id') IS DISTINCT FROM 'string'
  OR (p_payload->>'id')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid grant action' USING ERRCODE='22023';END IF;
 v_id:=(p_payload->>'id')::uuid;
 SELECT g.* INTO v_grant FROM fountain_cloud.service_grants g WHERE g.workspace_id=v_ws AND g.id=v_id FOR UPDATE;
 IF p_action='create' THEN
  IF NOT(p_payload ?& ARRAY['id','expires_at','token_hash']) OR p_payload-ARRAY['id','expires_at','token_hash']<>'{}'::jsonb
   OR jsonb_typeof(p_payload->'token_hash') IS DISTINCT FROM 'string' OR (p_payload->>'token_hash')!~'^[a-f0-9]{64}$'
   OR p_payload->'expires_at'<>'null'::jsonb AND(jsonb_typeof(p_payload->'expires_at') IS DISTINCT FROM 'string'
    OR (p_payload->>'expires_at')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') THEN RAISE EXCEPTION 'Invalid grant creation' USING ERRCODE='22023';END IF;
  v_expiry:=(p_payload->>'expires_at')::timestamptz;
  v_digest:=encode(sha256(convert_to(jsonb_build_object('expires_at',p_payload->'expires_at')::text,'UTF8')),'hex');
  IF v_grant.id IS NOT NULL THEN
   IF v_grant.purpose<>'scim' OR v_grant.creation_digest IS DISTINCT FROM v_digest OR v_grant.member_id IS DISTINCT FROM v_actor->>'id'
    OR v_grant.auth_user_id IS DISTINCT FROM (p_context->>'userId')::uuid OR v_grant.expires_at IS DISTINCT FROM v_expiry THEN RAISE EXCEPTION 'Grant request conflict' USING ERRCODE='PT409';END IF;
   RETURN jsonb_build_object('grant',fountain_cloud.scim_grant_metadata(v_grant),'created',false);
  END IF;
  IF v_expiry IS NOT NULL AND v_expiry<=v_now THEN RAISE EXCEPTION 'Grant expiry must be future' USING ERRCODE='22023';END IF;
  INSERT INTO fountain_cloud.service_grants(workspace_id,id,purpose,version,enabled,member_id,auth_user_id,token_hash,expires_at,created_at,creation_digest,pending_until)
   VALUES(v_ws,v_id,'scim',1,false,v_actor->>'id',(p_context->>'userId')::uuid,p_payload->>'token_hash',v_expiry,date_trunc('milliseconds',v_now),v_digest,v_now+interval '15 minutes') RETURNING * INTO v_grant;
  v_created:=true;v_operation:='create';
 ELSE
  IF v_grant.id IS NULL OR v_grant.purpose<>'scim' THEN RAISE EXCEPTION 'Grant not found' USING ERRCODE='PT404';END IF;
  IF p_action='activate' THEN
   IF NOT(p_payload ?& ARRAY['id','token_hash']) OR p_payload-ARRAY['id','token_hash']<>'{}'::jsonb OR jsonb_typeof(p_payload->'token_hash') IS DISTINCT FROM 'string' OR (p_payload->>'token_hash')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid grant activation' USING ERRCODE='22023';END IF;
   IF v_grant.version<>1 OR v_grant.creation_digest IS NULL OR v_grant.pending_until IS NULL
    OR v_grant.member_id IS DISTINCT FROM v_actor->>'id' OR v_grant.auth_user_id IS DISTINCT FROM (p_context->>'userId')::uuid
    OR v_grant.token_hash IS DISTINCT FROM p_payload->>'token_hash' THEN RAISE EXCEPTION 'Grant activation forbidden' USING ERRCODE='PT403';END IF;
   IF v_grant.expires_at IS NOT NULL AND v_grant.expires_at<=v_now THEN RAISE EXCEPTION 'Grant expired' USING ERRCODE='PT409';END IF;
   -- An exact proof after an acknowledged activation is metadata-only; the
   -- pending deadline restricts NEW activation, not a lost-ACK replay.
   IF v_grant.enabled THEN RETURN jsonb_build_object('grant',fountain_cloud.scim_grant_metadata(v_grant));END IF;
   IF v_grant.pending_until<=v_now THEN RAISE EXCEPTION 'Grant activation expired' USING ERRCODE='PT409';END IF;
   UPDATE fountain_cloud.service_grants g SET enabled=true WHERE g.workspace_id=v_ws AND g.id=v_id RETURNING * INTO v_grant;
   v_operation:='activate';
  ELSE
   IF NOT(p_payload ? 'id') OR p_payload-ARRAY['id']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid grant revocation' USING ERRCODE='22023';END IF;
   IF NOT v_grant.enabled AND v_grant.version>1 THEN RETURN jsonb_build_object('grant',fountain_cloud.scim_grant_metadata(v_grant));END IF;
   IF v_grant.version>=9007199254740991 THEN RAISE EXCEPTION 'Grant version exhausted' USING ERRCODE='PT409';END IF;
   UPDATE fountain_cloud.service_grants g SET enabled=false,version=g.version+1 WHERE g.workspace_id=v_ws AND g.id=v_id RETURNING * INTO v_grant;
   v_operation:='revoke';
  END IF;
 END IF;
 -- Exactly one safe audit and one global revision increment in this same
 -- transaction. No raw token, token digest or Auth identifier enters the audit.
 v_audit_id:=gen_random_uuid()::text;v_stamp:=to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');
 v_revision:=fountain_cloud.store_revision(v_ws,'_entity_revision');
 PERFORM fountain_cloud.store_apply_changes_locked(v_ws,v_revision,jsonb_build_array(jsonb_build_object('op','put','kind','audit','id',v_audit_id,'previousCreatedAt',NULL,
  'data',jsonb_build_object('id',v_audit_id,'actor',v_actor->>'id','action','scim.token.'||v_operation,'details',jsonb_build_object('kind','scim','id',v_id,'operation',v_operation),'created_at',v_stamp,'updated_at',v_stamp))));
 IF p_action='create' THEN RETURN jsonb_build_object('grant',fountain_cloud.scim_grant_metadata(v_grant),'created',v_created);END IF;
 RETURN jsonb_build_object('grant',fountain_cloud.scim_grant_metadata(v_grant));
END $$;
ALTER FUNCTION fountain_cloud.service_grant_admin(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.service_grant_admin(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fountain_cloud_service_grant_admin(p_context jsonb,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.service_grant_admin(p_context,p_action,p_payload) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_service_grant_admin(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_service_grant_admin(jsonb,text,jsonb) TO service_role;
COMMIT;
