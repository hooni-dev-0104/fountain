-- Pending operator-reviewed migration. Read-only legacy inline bytes; never
-- remove Store snapshot redaction or treat this RPC as a resource ACL check.
CREATE FUNCTION fountain_cloud.inline_attachment_range(
 p_context jsonb,p_attachment_id text,p_expected jsonb,p_offset bigint,p_length integer,p_source_digest text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict error
DECLARE v_workspace text;v_source jsonb;v_encoded text;v_core text;v_padding integer;v_mod integer;
 v_size numeric;v_decoded bytea;v_source_digest text;v_content_sha text;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION 'Inline attachment requires fresh reads' USING ERRCODE='PT503';
 END IF;
 IF p_attachment_id IS NULL OR length(p_attachment_id) NOT BETWEEN 1 AND 160
  OR p_attachment_id IN('.','..') OR p_attachment_id ~ '[[:cntrl:]/]' OR strpos(p_attachment_id,chr(92))>0
  OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR p_expected ? 'data'
  OR octet_length(p_expected::text)>65536 OR p_offset IS NULL OR p_offset<0
  OR p_length IS NULL OR p_length NOT BETWEEN 0 AND 65536
  OR (p_source_digest IS NULL AND (p_offset<>0 OR p_length<>0))
  OR (p_source_digest IS NOT NULL AND p_source_digest !~ '^[a-f0-9]{64}$') THEN
  RAISE EXCEPTION 'Invalid inline attachment request' USING ERRCODE='PT400';
 END IF;
 -- Existing human context verifies the live vault/Auth session/mapping/member,
 -- takes the shared Python/cloud workspace advisory lock and sets RLS scope.
 PERFORM fountain_cloud.store_context(p_context);
 v_workspace:=p_context->>'workspaceId';
 SELECT e.data INTO v_source FROM fountain_private.entities e
 WHERE e.workspace_id=v_workspace AND e.kind='attachment' AND e.id=p_attachment_id FOR SHARE OF e;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attachment not found' USING ERRCODE='PT404';END IF;
 IF jsonb_typeof(v_source) IS DISTINCT FROM 'object'
  OR jsonb_typeof(v_source->'id') IS DISTINCT FROM 'string' OR v_source->>'id' IS DISTINCT FROM p_attachment_id
  OR (v_source-'data') IS DISTINCT FROM p_expected
  OR v_source ?| ARRAY['cloud_chunks','storage_id']
  OR (v_source ? 'storage' AND v_source->'storage' IS DISTINCT FROM 'null'::jsonb AND v_source->'storage' IS DISTINCT FROM '"inline"'::jsonb)
  OR EXISTS(SELECT 1 FROM fountain_private.entities o WHERE o.workspace_id=v_workspace AND o.kind='attachment_cloud' AND o.id=p_attachment_id)
  OR jsonb_typeof(v_source->'size') IS DISTINCT FROM 'number'
  OR jsonb_typeof(v_source->'data') IS DISTINCT FROM 'string' THEN
  RAISE EXCEPTION 'Inline attachment changed or is unavailable' USING ERRCODE='PT409';
 END IF;
 v_size:=(v_source->>'size')::numeric;
 IF v_size<0 OR v_size>5000000 OR v_size<>trunc(v_size) THEN
  RAISE EXCEPTION 'Inline attachment is invalid' USING ERRCODE='PT409';
 END IF;
 v_encoded:=v_source->>'data';
 -- Python 3.12 base64.b64decode(validate=True): no whitespace, internal pad or
 -- excess pad. Nonzero unused pad bits remain compatible with legacy Python.
 IF octet_length(v_encoded)>7000000 OR length(v_encoded)%4<>0 OR v_encoded ~ '[^A-Za-z0-9+/=]' THEN
  RAISE EXCEPTION 'Inline attachment is invalid' USING ERRCODE='PT409';
 END IF;
 v_core:=rtrim(v_encoded,'=');v_padding:=length(v_encoded)-length(v_core);v_mod:=length(v_core)%4;
 IF v_padding>2 OR strpos(v_core,'=')>0 OR v_mod=1
  OR (v_mod=0 AND v_padding<>0) OR (v_mod=2 AND v_padding<>2) OR (v_mod=3 AND v_padding<>1) THEN
  RAISE EXCEPTION 'Inline attachment is invalid' USING ERRCODE='PT409';
 END IF;
 -- Validate/decode the ENTIRE bounded payload before any preflight/range result,
 -- including suffixes outside the requested range. No whole-file bytes leave PG.
 BEGIN v_decoded:=decode(v_encoded,'base64');
 EXCEPTION WHEN SQLSTATE '22023' THEN RAISE EXCEPTION 'Inline attachment is invalid' USING ERRCODE='PT409';END;
 IF octet_length(v_decoded)<>v_size THEN RAISE EXCEPTION 'Inline attachment is invalid' USING ERRCODE='PT409';END IF;
 v_source_digest:=encode(pg_catalog.sha256(convert_to(v_source::text,'UTF8')),'hex');
 v_content_sha:=encode(pg_catalog.sha256(v_decoded),'hex');
 IF p_source_digest IS NOT NULL AND p_source_digest IS DISTINCT FROM v_source_digest THEN
  RAISE EXCEPTION 'Inline attachment changed' USING ERRCODE='PT409';
 END IF;
 IF v_source ? 'sha256' AND (jsonb_typeof(v_source->'sha256') IS DISTINCT FROM 'string'
  OR v_source->>'sha256' IS DISTINCT FROM v_content_sha) THEN
  RAISE EXCEPTION 'Inline attachment checksum is invalid' USING ERRCODE='PT409';
 END IF;
 -- Subtraction avoids bigint overflow even for hostile offset input.
 IF p_offset>v_size OR p_length>v_size-p_offset THEN
  RAISE EXCEPTION 'Invalid inline attachment range' USING ERRCODE='PT400';
 END IF;
 RETURN jsonb_build_object('workspaceId',v_workspace,'attachmentId',p_attachment_id,'offset',p_offset,
  'size',v_size::bigint,'sha256',v_content_sha,'sourceDigest',v_source_digest,
  'bytesBase64',replace(encode(substring(v_decoded FROM (p_offset+1)::integer FOR p_length),'base64'),E'\n',''));
EXCEPTION
 WHEN SQLSTATE 'PT400' OR SQLSTATE 'PT401' OR SQLSTATE 'PT404' OR SQLSTATE 'PT409' OR SQLSTATE 'PT503' THEN RAISE;
 WHEN SQLSTATE '22023' OR SQLSTATE '22P02' OR SQLSTATE '22003' THEN
  RAISE EXCEPTION 'Invalid inline attachment request' USING ERRCODE='PT400';
 WHEN OTHERS THEN RAISE EXCEPTION 'Inline attachment is unavailable' USING ERRCODE='PT503';
END $$;
ALTER FUNCTION fountain_cloud.inline_attachment_range(jsonb,text,jsonb,bigint,integer,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.inline_attachment_range(jsonb,text,jsonb,bigint,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION fountain_cloud.inline_attachment_range(jsonb,text,jsonb,bigint,integer,text) TO service_role;
CREATE FUNCTION public.fountain_cloud_inline_attachment_range(
 p_context jsonb,p_attachment_id text,p_expected jsonb,p_offset bigint,p_length integer,p_source_digest text
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT fountain_cloud.inline_attachment_range(p_context,p_attachment_id,p_expected,p_offset,p_length,p_source_digest)
$$;
ALTER FUNCTION public.fountain_cloud_inline_attachment_range(jsonb,text,jsonb,bigint,integer,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_inline_attachment_range(jsonb,text,jsonb,bigint,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_inline_attachment_range(jsonb,text,jsonb,bigint,integer,text) TO service_role;

-- Run actual catalog assertions atomically when Root applies this migration.
-- No table data, session, revision, quota or receipt is written by this block.
DO $$
DECLARE v_impl regprocedure:='fountain_cloud.inline_attachment_range(jsonb,text,jsonb,bigint,integer,text)'::regprocedure;
 v_wire regprocedure:='public.fountain_cloud_inline_attachment_range(jsonb,text,jsonb,bigint,integer,text)'::regprocedure;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=v_impl
  AND r.rolname='postgres' AND p.prosecdef AND p.provolatile='v' AND 'search_path=pg_catalog'=ANY(p.proconfig))
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=v_wire
   AND r.rolname='postgres' AND NOT p.prosecdef AND p.provolatile='v' AND 'search_path=pg_catalog'=ANY(p.proconfig))
  OR NOT has_function_privilege('service_role',v_impl,'EXECUTE') OR NOT has_function_privilege('service_role',v_wire,'EXECUTE')
  OR has_function_privilege('anon',v_impl,'EXECUTE') OR has_function_privilege('anon',v_wire,'EXECUTE')
  OR has_function_privilege('authenticated',v_impl,'EXECUTE') OR has_function_privilege('authenticated',v_wire,'EXECUTE') THEN
  RAISE EXCEPTION 'Inline attachment privilege contract is invalid';
 END IF;
END $$;
