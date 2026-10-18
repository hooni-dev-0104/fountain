-- Service-only account directory. A listing is discovery; every open and domain
-- request revalidates live parent, mapping incarnation and activity episodes.
CREATE FUNCTION fountain_private.workspace_child_open(p_session jsonb,p_workspace text,p_expected text DEFAULT NULL) RETURNS fountain_private.workspace_children
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;identity jsonb;parent fountain_private.account_session_vault;child fountain_private.workspace_children;stamp bigint;
BEGIN
 uid:=fountain_private.account_session_context(p_session);
 SELECT * INTO parent FROM fountain_private.account_session_vault WHERE hash=p_session->>'sessionHash';
 identity:=fountain_private.workspace_identity(p_workspace,uid);stamp:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 SELECT * INTO child FROM fountain_private.workspace_children c WHERE c.parent_hash=parent.hash AND c.workspace_id=p_workspace
 AND c.mapping_grant_id=(identity->>'mappingGrantId')::uuid AND c.ledger_id=identity->>'ledgerId' AND c.membership_id=identity->>'membershipId'
 AND c.account_id=identity->>'accountId' AND c.revoked_at_ms IS NULL AND c.expires_at_ms>stamp ORDER BY c.created_at_ms DESC,c.hash LIMIT 1 FOR SHARE;
 IF p_expected IS NOT NULL AND(child.hash IS NULL OR child.cache_binding<>p_expected) THEN RAISE EXCEPTION 'Workspace grant changed' USING ERRCODE='PT409';END IF;
 IF child.hash IS NULL THEN
  INSERT INTO fountain_private.workspace_children(hash,parent_hash,user_id,auth_session_id,workspace_id,member_id,mapping_grant_id,ledger_id,membership_id,account_id,cache_binding,created_at_ms,expires_at_ms)
  VALUES(encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),parent.hash,uid,parent.auth_session_id,p_workspace,identity->'member'->>'id',(identity->>'mappingGrantId')::uuid,identity->>'ledgerId',identity->>'membershipId',identity->>'accountId',replace(gen_random_uuid()::text,'-',''),stamp,parent.expires_at_ms) RETURNING * INTO child;
 END IF;
 IF parent.expires_at_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
 RETURN child;
END $f$;
CREATE FUNCTION fountain_private.workspace_child_result(p_child fountain_private.workspace_children) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE parent fountain_private.account_session_vault;profile jsonb;
BEGIN
 SELECT * INTO parent FROM fountain_private.account_session_vault WHERE hash=(p_child).parent_hash;
 profile:=fountain_cloud.resolve_profile((p_child).workspace_id,(p_child).user_id,(p_child).auth_session_id);
 RETURN jsonb_build_object('workspaceId',(p_child).workspace_id,'accountBinding',parent.cache_binding,'session',jsonb_build_object(
 'enabled',true,'required',true,'authenticated',true,'mode','accounts','identity',profile->'member'->>'name','member',profile->'member',
 'workspace_id',(p_child).workspace_id,'cache_binding',(p_child).cache_binding,'account_binding',parent.cache_binding,
 'expires_at',to_char(to_timestamp((p_child).expires_at_ms/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END $f$;
CREATE FUNCTION fountain_private.workspace_receipt(p_parent text,p_workspace text,p_command uuid,p_operation text,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE receipt fountain_private.workspace_directory_receipts;child fountain_private.workspace_children;member jsonb;
BEGIN
 SELECT * INTO receipt FROM fountain_private.workspace_directory_receipts WHERE parent_hash=p_parent AND workspace_id=p_workspace AND command_id=p_command;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF receipt.operation<>p_operation OR receipt.request_hash<>p_digest THEN RAISE EXCEPTION 'Command already used' USING ERRCODE='PT409';END IF;
 SELECT * INTO child FROM fountain_private.workspace_children WHERE hash=receipt.child_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workspace grant changed' USING ERRCODE='PT403';END IF;
 member:=fountain_cloud.store_context(jsonb_build_object('workspaceId',child.workspace_id,'memberId',child.member_id,'userId',child.user_id,'authSessionId',child.auth_session_id,'sessionHash',child.hash,'cacheBinding',child.cache_binding));
 -- The durable command preserves identifiers/binding, while a subsequent
 -- display or role change is reflected in the live session projection. A
 -- receipt must never advertise a no-longer-current workspace owner role.
 IF receipt.operation IN('create','open','invitation_accept') THEN RETURN fountain_private.workspace_child_result(child);END IF;
 RETURN receipt.result;
END $f$;
CREATE FUNCTION fountain_private.workspace_invitation_check(p_workspace text,p_invitation uuid,p_code text,p_target uuid,p_allow_consumed boolean DEFAULT false) RETURNS fountain_private.workspace_invitations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE invitation fountain_private.workspace_invitations;identity jsonb;
BEGIN
 SELECT * INTO invitation FROM fountain_private.workspace_invitations WHERE workspace_id=p_workspace AND id=p_invitation FOR SHARE;
 IF NOT FOUND OR invitation.target_user_id<>p_target OR invitation.nonce_hash<>encode(sha256(convert_to(p_code,'UTF8')),'hex')
 OR invitation.expires_at<=clock_timestamp() OR(NOT p_allow_consumed AND invitation.consumed_at IS NOT NULL) THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='PT403';END IF;
 -- An invitation is not dependent on its issuer staying logged in, but it is
 -- dependent on the exact current issuer mapping/member/account incarnation.
 PERFORM 1 FROM auth.users WHERE id=invitation.issuer_user_id AND deleted_at IS NULL AND NOT is_anonymous AND email_confirmed_at IS NOT NULL AND(banned_until IS NULL OR banned_until<=clock_timestamp()) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invitation issuer unavailable' USING ERRCODE='PT403';END IF;
 identity:=fountain_private.workspace_identity(p_workspace,invitation.issuer_user_id);
 IF identity->'member'->>'role' NOT IN('owner','admin') OR identity->'member'->>'id'<>invitation.issuer_member_id
 OR(identity->>'mappingGrantId')::uuid<>invitation.issuer_mapping_grant_id OR identity->>'ledgerId'<>invitation.issuer_ledger_id
 OR identity->>'membershipId'<>invitation.issuer_membership_id OR identity->>'accountId'<>invitation.issuer_account_id THEN RAISE EXCEPTION 'Invitation issuer changed' USING ERRCODE='PT403';END IF;
 RETURN invitation;
END $f$;
CREATE FUNCTION public.fountain_cloud_account_directory(p_session jsonb,p_operation text,p_workspace_id text,p_workspace_binding text,p_command_id uuid,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE uid uuid;parent fountain_private.account_session_vault;child fountain_private.workspace_children;identity jsonb;member jsonb;answer jsonb;prior jsonb;
 digest text;stamp text;role_name text;name text;email text;after_ws text;limit_n integer;items jsonb;more boolean;target uuid;targets uuid[];
 invitation fountain_private.workspace_invitations;invitation_id uuid;expires_ms bigint;expected text;ctx jsonb;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('list','create','open','context','invite','invitation_preview','invitation_accept')
 OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR octet_length(p_value::text)>8192 THEN RAISE EXCEPTION 'Invalid workspace command' USING ERRCODE='22023';END IF;
 IF p_operation='list' THEN
  IF p_workspace_id IS NOT NULL OR p_workspace_binding IS NOT NULL OR p_command_id IS NOT NULL OR NOT(p_value ?& ARRAY['after','limit']) OR p_value-ARRAY['after','limit']<>'{}'::jsonb
  OR jsonb_typeof(p_value->'after') NOT IN('null','string') OR(jsonb_typeof(p_value->'after')='string' AND(p_value->>'after') !~ '^[A-Za-z0-9_-]{1,160}$') THEN RAISE EXCEPTION 'Invalid workspace query' USING ERRCODE='22023';END IF;
  uid:=fountain_private.account_session_context(p_session);expires_ms:=fountain_private.account_session_integer(p_value->'limit');IF expires_ms NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid page size' USING ERRCODE='22023';END IF;limit_n:=expires_ms::integer;
  SELECT * INTO parent FROM fountain_private.account_session_vault WHERE hash=p_session->>'sessionHash';after_ws:=p_value->>'after';
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ws COLLATE "C") FILTER(WHERE x.n<=limit_n),'[]'::jsonb),COALESCE(bool_or(x.n>limit_n),false) INTO items,more FROM(
   SELECT m.workspace_id ws,row_number() OVER(ORDER BY m.workspace_id COLLATE "C") n,jsonb_build_object('workspaceId',m.workspace_id,'name',CASE WHEN jsonb_typeof(s.data->'name')='string' THEN left(s.data->>'name',1000) ELSE '' END,'memberId',m.member_id,'role',e.data->>'role') item
   FROM fountain_private.identity_mapping m JOIN fountain_private.workspace_registry wr ON wr.workspace_id=m.workspace_id
   JOIN fountain_private.entities e ON e.workspace_id=m.workspace_id AND e.kind='member' AND e.id=m.member_id
   LEFT JOIN fountain_private.entities s ON s.workspace_id=m.workspace_id AND s.kind='settings' AND s.id='workspace'
   WHERE m.auth_user_id=uid AND(after_ws IS NULL OR m.workspace_id COLLATE "C">after_ws COLLATE "C") AND e.data->>'id'=e.id
   AND e.data->>'role' IN('owner','admin','member','guest') AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb
   AND jsonb_typeof(e.data->'name')='string' AND length(e.data->>'name') BETWEEN 1 AND 1000 AND jsonb_typeof(e.data->'email')='string' AND length(e.data->>'email')<=1000
   ORDER BY m.workspace_id COLLATE "C" LIMIT limit_n+1)x;
  PERFORM fountain_private.account_session_context(p_session);
  RETURN jsonb_build_object('workspaces',items,'nextCursor',CASE WHEN more THEN items->(jsonb_array_length(items)-1)->>'workspaceId' ELSE NULL END,'accountBinding',parent.cache_binding);
 END IF;
 IF p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9_-]{1,160}$' THEN RAISE EXCEPTION 'Invalid workspace identifier' USING ERRCODE='22023';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace_id);PERFORM set_config('fountain.workspace_id',p_workspace_id,true);
 -- Auth DELETE owns the user row before its mapping-cascade trigger asks
 -- for the global account key. Take the user row without waiting, then try
 -- that same key without waiting: neither side can form an inverted cycle.
 -- This is only a mutation preflight; the complete parent context below still
 -- validates the exact Auth SID, opaque hash, binding, local revoke and TTL.
 IF p_operation IN('create','invitation_accept') THEN
  uid:=fountain_private.organization_uuid(p_session->'userId');
  BEGIN
   PERFORM 1 FROM auth.users u WHERE u.id=uid AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL
   AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) FOR SHARE OF u NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='PT401';END IF;
  EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'Account identity transition is busy' USING ERRCODE='PT409';END;
  IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:auth-account:'||uid::text,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN
   RAISE EXCEPTION 'Account identity transition is busy' USING ERRCODE='PT409';
  END IF;
 END IF;
 uid:=fountain_private.account_session_context(p_session);SELECT * INTO parent FROM fountain_private.account_session_vault WHERE hash=p_session->>'sessionHash';
 IF p_operation='context' THEN
  IF p_command_id IS NOT NULL OR p_value<>'{}'::jsonb OR p_workspace_binding IS NULL OR p_workspace_binding !~ '^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Invalid workspace context' USING ERRCODE='22023';END IF;
  SELECT * INTO child FROM fountain_private.workspace_children WHERE parent_hash=parent.hash AND workspace_id=p_workspace_id AND cache_binding=p_workspace_binding;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace access required' USING ERRCODE='PT403';END IF;
  ctx:=jsonb_build_object('workspaceId',p_workspace_id,'memberId',child.member_id,'userId',uid,'authSessionId',parent.auth_session_id,'sessionHash',child.hash,'cacheBinding',child.cache_binding);
  member:=fountain_cloud.store_context(ctx);
  RETURN jsonb_build_object('hash',child.hash,'userId',uid,'authSessionId',parent.auth_session_id,'cacheBinding',child.cache_binding,'profile',jsonb_build_object('workspaceId',p_workspace_id,'authSessionActive',true,'member',member),'expiresAt',child.expires_at_ms,'accountBinding',parent.cache_binding,'parentHash',parent.hash);
 END IF;
 IF p_operation IN('open','create','invite','invitation_accept') AND p_command_id IS NULL THEN RAISE EXCEPTION 'Command identifier required' USING ERRCODE='22023';END IF;
 IF p_operation<>'invite' AND p_workspace_binding IS NOT NULL THEN RAISE EXCEPTION 'Unexpected workspace binding' USING ERRCODE='22023';END IF;
 IF p_operation='open' THEN
  IF NOT(p_value ? 'expectedBinding') OR p_value-'expectedBinding'<>'{}'::jsonb OR jsonb_typeof(p_value->'expectedBinding') NOT IN('null','string')
  OR(jsonb_typeof(p_value->'expectedBinding')='string' AND(p_value->>'expectedBinding') !~ '^[a-f0-9]{32}$') THEN RAISE EXCEPTION 'Invalid open command' USING ERRCODE='22023';END IF;
  expected:=p_value->>'expectedBinding';
 ELSIF p_operation='create' THEN
  IF NOT(p_value ? 'name') OR p_value-'name'<>'{}'::jsonb OR jsonb_typeof(p_value->'name') IS DISTINCT FROM 'string' OR length(btrim(p_value->>'name')) NOT BETWEEN 1 AND 200 OR octet_length(p_value->>'name')>800 THEN RAISE EXCEPTION 'Invalid workspace name' USING ERRCODE='22023';END IF;
 END IF;
 IF p_operation IN('create','open') THEN
  digest:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'workspaceId',p_workspace_id,'value',p_value)::text,'UTF8')),'hex');
  prior:=fountain_private.workspace_receipt(parent.hash,p_workspace_id,p_command_id,p_operation,digest);IF prior IS NOT NULL THEN RETURN prior;END IF;
  IF p_operation='create' THEN
   IF EXISTS(SELECT 1 FROM fountain_private.workspace_registry WHERE workspace_id=p_workspace_id) OR EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=p_workspace_id) OR EXISTS(SELECT 1 FROM fountain_private.meta WHERE workspace_id=p_workspace_id) OR EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=p_workspace_id) OR EXISTS(SELECT 1 FROM fountain_private.attachment_chunks WHERE workspace_id=p_workspace_id) OR EXISTS(SELECT 1 FROM fountain_private.activity_ledgers WHERE workspace_id=p_workspace_id) OR EXISTS(SELECT 1 FROM fountain_private.retention_records WHERE workspace_id=p_workspace_id) OR EXISTS(SELECT 1 FROM fountain_cloud.onboarding_claims WHERE workspace_id=p_workspace_id) THEN RAISE EXCEPTION 'Workspace identifier already exists' USING ERRCODE='PT409';END IF;
   SELECT COALESCE(NULLIF(left(u.raw_user_meta_data->>'full_name',1000),''),NULLIF(left(u.raw_user_meta_data->>'name',1000),''),u.email,'나'),u.email INTO name,email FROM auth.users u WHERE u.id=uid;
   stamp:=fountain_private.activity_now();INSERT INTO fountain_private.workspace_registry(workspace_id,created_by_user_id,source) VALUES(p_workspace_id,uid,'account');
   INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES
   (p_workspace_id,'member','local',jsonb_build_object('id','local','name',name,'email',email,'role','owner','active',true,'created_at',stamp,'updated_at',stamp),stamp,stamp),
   (p_workspace_id,'settings','workspace',jsonb_build_object('id','workspace','name',p_value->>'name','disable_guests',false,'created_at',stamp,'updated_at',stamp),stamp,stamp),
   (p_workspace_id,'teamspace','general',jsonb_build_object('id','general','name','팀 워크스페이스','icon','🏠','visibility','open','created_at',stamp,'updated_at',stamp),stamp,stamp);
   INSERT INTO fountain_private.meta(workspace_id,key,data) VALUES(p_workspace_id,'workspace_id',to_jsonb(p_workspace_id)),(p_workspace_id,'_entity_revision','3'),(p_workspace_id,'access_revision','0'),(p_workspace_id,'auth_accounts_required','true');
   INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id) VALUES(p_workspace_id,uid,'local');
   PERFORM fountain_private.activity_initialize(p_workspace_id);
  END IF;
  child:=fountain_private.workspace_child_open(p_session,p_workspace_id,expected);answer:=fountain_private.workspace_child_result(child);
  INSERT INTO fountain_private.workspace_directory_receipts(parent_hash,workspace_id,command_id,operation,request_hash,child_hash,result) VALUES(parent.hash,p_workspace_id,p_command_id,p_operation,digest,child.hash,answer);
  PERFORM fountain_private.account_session_context(p_session);RETURN answer;
 END IF;
 IF p_operation='invite' THEN
  IF p_workspace_binding IS NULL OR p_workspace_binding !~ '^[a-f0-9]{32}$' OR NOT(p_value ?& ARRAY['email','role','nonceHash','expiresAtMs']) OR p_value-ARRAY['email','role','nonceHash','expiresAtMs']<>'{}'::jsonb
  OR jsonb_typeof(p_value->'email') IS DISTINCT FROM 'string' OR length(p_value->>'email') NOT BETWEEN 3 AND 320 OR p_value->>'email'<>btrim(p_value->>'email') OR(p_value->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+$'
  OR jsonb_typeof(p_value->'role') IS DISTINCT FROM 'string' OR p_value->>'role' NOT IN('admin','member','guest') OR jsonb_typeof(p_value->'nonceHash') IS DISTINCT FROM 'string' OR(p_value->>'nonceHash') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid invitation' USING ERRCODE='22023';END IF;
  expires_ms:=fountain_private.account_session_integer(p_value->'expiresAtMs');
  SELECT * INTO child FROM fountain_private.workspace_children WHERE parent_hash=parent.hash AND workspace_id=p_workspace_id AND cache_binding=p_workspace_binding;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace access required' USING ERRCODE='PT403';END IF;
  member:=fountain_cloud.store_context(jsonb_build_object('workspaceId',p_workspace_id,'memberId',child.member_id,'userId',uid,'authSessionId',parent.auth_session_id,'sessionHash',child.hash,'cacheBinding',child.cache_binding));
  IF member->>'role' NOT IN('owner','admin') THEN RAISE EXCEPTION 'Workspace administrator required' USING ERRCODE='PT403';END IF;
  -- One bounded locking statement; never resolve a target in an unlocked query.
  SELECT array_agg(candidate.id ORDER BY candidate.id) INTO targets FROM(SELECT u.id FROM auth.users u WHERE lower(u.email)=lower(p_value->>'email') AND u.deleted_at IS NULL AND NOT u.is_anonymous AND u.email_confirmed_at IS NOT NULL AND(u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) ORDER BY u.id LIMIT 2 FOR SHARE) candidate;
  IF COALESCE(cardinality(targets),0)<>1 THEN RAISE EXCEPTION 'Invitation target unavailable' USING ERRCODE='PT403';END IF;target:=targets[1];
  digest:=encode(sha256(convert_to(jsonb_build_object('operation','invite','workspaceId',p_workspace_id,'binding',p_workspace_binding,'targetUserId',target,'value',p_value)::text,'UTF8')),'hex');
  prior:=fountain_private.workspace_receipt(parent.hash,p_workspace_id,p_command_id,p_operation,digest);IF prior IS NOT NULL THEN RETURN prior;END IF;
  IF expires_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint OR expires_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint+900000 THEN RAISE EXCEPTION 'Invalid invitation expiry' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=p_workspace_id AND auth_user_id=target) THEN RAISE EXCEPTION 'Account already belongs to workspace' USING ERRCODE='PT409';END IF;
  INSERT INTO fountain_private.workspace_invitations(workspace_id,issuer_parent_hash,issuer_child_hash,issuer_user_id,issuer_member_id,issuer_mapping_grant_id,issuer_ledger_id,issuer_membership_id,issuer_account_id,target_user_id,role,nonce_hash,expires_at)
  VALUES(p_workspace_id,parent.hash,child.hash,uid,child.member_id,child.mapping_grant_id,child.ledger_id,child.membership_id,child.account_id,target,p_value->>'role',p_value->>'nonceHash',to_timestamp(expires_ms/1000.0)) RETURNING * INTO invitation;
  answer:=jsonb_build_object('workspaceId',p_workspace_id,'invitationId',invitation.id,'role',invitation.role,'expiresAt',invitation.expires_at,'accountBinding',parent.cache_binding);
  INSERT INTO fountain_private.workspace_directory_receipts(parent_hash,workspace_id,command_id,operation,request_hash,child_hash,result) VALUES(parent.hash,p_workspace_id,p_command_id,p_operation,digest,child.hash,answer);
  PERFORM fountain_private.account_session_context(p_session);RETURN answer;
 END IF;
 IF NOT(p_value ?& ARRAY['invitationId','code']) OR p_value-ARRAY['invitationId','code']<>'{}'::jsonb OR jsonb_typeof(p_value->'code') IS DISTINCT FROM 'string' OR(p_value->>'code') !~ '^[a-f0-9]{64}$' OR(p_operation='invitation_preview' AND p_command_id IS NOT NULL) THEN RAISE EXCEPTION 'Invalid invitation code' USING ERRCODE='22023';END IF;
 invitation_id:=fountain_private.organization_uuid(p_value->'invitationId');
 invitation:=fountain_private.workspace_invitation_check(p_workspace_id,invitation_id,p_value->>'code',uid,p_operation='invitation_accept');
 IF p_operation='invitation_preview' THEN
  SELECT left(data->>'name',1000) INTO name FROM fountain_private.entities WHERE workspace_id=p_workspace_id AND kind='settings' AND id='workspace';
  PERFORM fountain_private.account_session_context(p_session);RETURN jsonb_build_object('workspaceId',p_workspace_id,'name',COALESCE(name,''),'role',invitation.role,'expiresAt',invitation.expires_at,'accountBinding',parent.cache_binding);
 END IF;
 digest:=encode(sha256(convert_to(jsonb_build_object('operation','invitation_accept','workspaceId',p_workspace_id,'targetUserId',uid,'value',p_value)::text,'UTF8')),'hex');
 prior:=fountain_private.workspace_receipt(parent.hash,p_workspace_id,p_command_id,p_operation,digest);IF prior IS NOT NULL THEN RETURN prior;END IF;
 IF invitation.consumed_at IS NOT NULL OR EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE workspace_id=p_workspace_id AND auth_user_id=uid) THEN RAISE EXCEPTION 'Invitation already consumed' USING ERRCODE='PT409';END IF;
 SELECT COALESCE(NULLIF(left(u.raw_user_meta_data->>'full_name',1000),''),NULLIF(left(u.raw_user_meta_data->>'name',1000),''),u.email,'멤버'),u.email INTO name,email FROM auth.users u WHERE u.id=uid;
 stamp:=fountain_private.activity_now();expected:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES(p_workspace_id,'member',expected,jsonb_build_object('id',expected,'name',name,'email',email,'role',invitation.role,'active',true,'created_at',stamp,'updated_at',stamp),stamp,stamp);
 INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id) VALUES(p_workspace_id,uid,expected);
 PERFORM fountain_cloud.account_touch(p_workspace_id,invitation.issuer_member_id,expected,'account.invitation.accept');
 child:=fountain_private.workspace_child_open(p_session,p_workspace_id,NULL);answer:=fountain_private.workspace_child_result(child);
 UPDATE fountain_private.workspace_invitations SET consumed_at=clock_timestamp(),consumed_parent_hash=parent.hash,consumed_child_hash=child.hash WHERE workspace_id=p_workspace_id AND id=invitation.id;
 INSERT INTO fountain_private.workspace_directory_receipts(parent_hash,workspace_id,command_id,operation,request_hash,child_hash,result) VALUES(parent.hash,p_workspace_id,p_command_id,p_operation,digest,child.hash,answer);
 PERFORM fountain_private.account_session_context(p_session);RETURN answer;
END $f$;
DO $acl$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['fountain_private.workspace_child_open(jsonb,text,text)','fountain_private.workspace_child_result(fountain_private.workspace_children)','fountain_private.workspace_receipt(text,text,uuid,text,text)','fountain_private.workspace_invitation_check(text,uuid,text,uuid,boolean)','public.fountain_cloud_account_directory(jsonb,text,text,text,uuid,jsonb)'] LOOP
 EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO postgres';EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated,service_role,fountain_backend';
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_account_directory(jsonb,text,text,text,uuid,jsonb) TO service_role;
