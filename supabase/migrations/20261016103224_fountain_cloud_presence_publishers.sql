-- This narrow service RPC returns peer identities, never tokens/Auth UUIDs or
-- ciphertext. Trusted Edge + current actor/workspace gate; NOT per-user RLS.
CREATE FUNCTION fountain_cloud.presence_publishers(p_context jsonb,p_hashes text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ws text; peer record; profile jsonb; result jsonb:='[]'::jsonb;
BEGIN
 -- Claims the same workspace writer and verifies/locks the calling opaque
 -- session, live Auth session/user, trusted mapping and current legacy member.
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 IF p_hashes IS NULL OR cardinality(p_hashes)>500 OR COALESCE(array_ndims(p_hashes),1)<>1
  OR EXISTS(SELECT 1 FROM unnest(p_hashes) h WHERE h IS NULL OR h !~ '^[a-f0-9]{64}$')
  OR (SELECT count(DISTINCT h) FROM unnest(p_hashes) h)<>cardinality(p_hashes) THEN
  RAISE EXCEPTION 'Invalid presence publisher hashes' USING ERRCODE='22023';
 END IF;
 FOR peer IN
  SELECT v.hash,v.cache_binding,v.user_id,v.auth_session_id
  FROM fountain_cloud.session_vault v
  JOIN auth.sessions s ON s.id=v.auth_session_id AND s.user_id=v.user_id
  JOIN auth.users u ON u.id=s.user_id
  JOIN fountain_private.identity_mapping m ON m.workspace_id=v.workspace_id AND m.auth_user_id=v.user_id
  JOIN fountain_private.entities e ON e.workspace_id=m.workspace_id AND e.kind='member' AND e.id=m.member_id
  WHERE v.workspace_id=ws AND v.hash=ANY(p_hashes)
   AND v.revoked_at_ms IS NULL AND NOT v.logout_pending
   AND v.expires_at_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
   AND u.deleted_at IS NULL AND NOT u.is_anonymous
   AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   AND (s.not_after IS NULL OR s.not_after>clock_timestamp())
  ORDER BY v.hash COLLATE "C" FOR SHARE OF v,s,u,m,e
 LOOP
  profile:=fountain_cloud.resolve_profile(ws,peer.user_id,peer.auth_session_id);
  IF profile IS NOT NULL AND profile->'authSessionActive'='true'::jsonb
   AND profile->'member'->'active'='true'::jsonb THEN
   result:=result||jsonb_build_array(jsonb_build_object('hash',peer.hash,'cacheBinding',peer.cache_binding,'member',profile->'member'));
  END IF;
 END LOOP;
 RETURN result;
END $$;
ALTER FUNCTION fountain_cloud.presence_publishers(jsonb,text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.presence_publishers(jsonb,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.presence_publishers(jsonb,text[]) TO service_role;
CREATE FUNCTION public.fountain_cloud_presence_publishers(p_context jsonb,p_hashes text[]) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.presence_publishers(p_context,p_hashes) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_presence_publishers(jsonb,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_presence_publishers(jsonb,text[]) TO service_role;
