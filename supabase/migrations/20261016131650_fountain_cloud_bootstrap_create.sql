ALTER TABLE fountain_cloud.onboarding_claims ADD COLUMN create_attempts integer NOT NULL DEFAULT 0 CHECK(create_attempts BETWEEN 0 AND 3);
CREATE FUNCTION fountain_cloud.bootstrap_begin(p_workspace_id text,p_nonce_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claim fountain_cloud.onboarding_claims;
BEGIN
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR p_nonce_hash IS NULL OR p_nonce_hash !~ '^[a-f0-9]{64}$' OR length(p_nonce_hash)<>64 THEN RAISE EXCEPTION 'Invalid setup' USING ERRCODE='22023'; END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);
 SELECT * INTO claim FROM fountain_cloud.onboarding_claims c WHERE c.workspace_id=p_workspace_id AND c.nonce_hash=p_nonce_hash FOR UPDATE;
 IF NOT FOUND OR claim.purpose<>'bootstrap' OR claim.member_id<>'local' OR claim.used_auth_user_id IS NOT NULL THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
 IF claim.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Setup expired' USING ERRCODE='PT410'; END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace_id) OR NOT EXISTS(
  SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='member' AND e.id='local' AND e.data->>'id'='local' AND e.data->>'role'='owner' AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
 ) THEN RAISE EXCEPTION 'Setup rejected' USING ERRCODE='PT403'; END IF;
 IF claim.create_attempts>=3 THEN RAISE EXCEPTION 'Setup attempt limit' USING ERRCODE='PT429'; END IF;
 UPDATE fountain_cloud.onboarding_claims c SET create_attempts=c.create_attempts+1 WHERE c.workspace_id=p_workspace_id AND c.nonce_hash=p_nonce_hash;
 RETURN jsonb_build_object('allowed',true);
END $$;
ALTER FUNCTION fountain_cloud.bootstrap_begin(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.bootstrap_begin(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.bootstrap_begin(text,text) TO service_role;
CREATE FUNCTION public.fountain_cloud_bootstrap_begin(p_workspace_id text,p_nonce_hash text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.bootstrap_begin(p_workspace_id,p_nonce_hash) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_bootstrap_begin(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_bootstrap_begin(text,text) TO service_role;
