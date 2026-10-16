-- DRAFT: root applies only after independent review and isolated SQL/Auth tests.
-- Owner-only export is the sole cloud path allowed to read legacy credentials.
-- Trusted server authorization, NOT end-user RLS; no legacy grants are changed.
BEGIN;
CREATE FUNCTION fountain_cloud.backup_authorize(p_context jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal jsonb; settings jsonb; ws text;
BEGIN
 principal:=fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 IF principal->>'role' IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Backup requires owner' USING ERRCODE='PT403'; END IF;
 SELECT data INTO settings FROM fountain_private.entities WHERE workspace_id=ws AND kind='settings' AND id='workspace';
 IF FOUND AND (jsonb_typeof(settings) IS DISTINCT FROM 'object'
  OR COALESCE(settings->'disable_export','false'::jsonb) IS DISTINCT FROM 'false'::jsonb) THEN
  RAISE EXCEPTION 'Workspace export is disabled' USING ERRCODE='PT403';
 END IF;
 RETURN jsonb_build_object('context',p_context,'revision',fountain_cloud.store_revision(ws,'_entity_revision'));
END $$;
ALTER FUNCTION fountain_cloud.backup_authorize(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.backup_authorize(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.backup_authorize(jsonb) TO service_role;

CREATE FUNCTION fountain_cloud.backup_export(p_context jsonb,p_expected_revision bigint DEFAULT NULL,p_cursor jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE authority jsonb;ws text;revision bigint;scope text;phase integer:=0;
 last_kind text:='';last_id text:='';last_offset bigint:=0;last_part integer:=0;
 item record;raw text;parts integer;part integer;first_part integer;dto jsonb;
 items jsonb[]:=ARRAY[]::jsonb[];used bigint:=4096;following jsonb:=NULL;result jsonb;
BEGIN
 authority:=fountain_cloud.backup_authorize(p_context);ws:=p_context->>'workspaceId';revision:=(authority->>'revision')::bigint;
 IF p_expected_revision IS NOT NULL AND (p_expected_revision<0 OR p_expected_revision<>revision) THEN
  RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 scope:=encode(sha256(convert_to(jsonb_build_array(p_context,revision)::text,'UTF8')),'hex');
 IF p_cursor IS NOT NULL THEN
  IF p_expected_revision IS NULL OR jsonb_typeof(p_cursor) IS DISTINCT FROM 'object'
   OR NOT(p_cursor ?& ARRAY['phase','kind','id','offset','part','scope'])
   OR p_cursor-ARRAY['phase','kind','id','offset','part','scope']<>'{}'::jsonb
   OR jsonb_typeof(p_cursor->'scope') IS DISTINCT FROM 'string' OR p_cursor->>'scope' IS DISTINCT FROM scope
   OR jsonb_typeof(p_cursor->'phase') IS DISTINCT FROM 'number' OR (p_cursor->>'phase') !~ '^[0-2]$'
   OR jsonb_typeof(p_cursor->'kind') IS DISTINCT FROM 'string' OR length(p_cursor->>'kind')>64
   OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string' OR length(p_cursor->>'id') NOT BETWEEN 1 AND 160
   OR jsonb_typeof(p_cursor->'offset') IS DISTINCT FROM 'number' OR (p_cursor->>'offset') !~ '^[0-9]{1,10}$'
   OR (p_cursor->>'offset')::bigint>5000000000
   OR jsonb_typeof(p_cursor->'part') IS DISTINCT FROM 'number' OR (p_cursor->>'part') !~ '^[0-9]{1,3}$'
   OR (p_cursor->>'part')::integer>128 THEN
   RAISE EXCEPTION 'Invalid backup cursor' USING ERRCODE='22023';
  END IF;
  phase:=(p_cursor->>'phase')::integer;last_kind:=p_cursor->>'kind';last_id:=p_cursor->>'id';last_offset:=(p_cursor->>'offset')::bigint;last_part:=(p_cursor->>'part')::integer;
  IF (phase=0 AND (last_kind !~ '^[a-z][a-z0-9_]{0,63}$' OR last_offset<>0))
   OR (phase>0 AND last_kind<>'') OR (phase=1 AND last_offset<>0) OR (phase=2 AND last_part<>0) THEN
   RAISE EXCEPTION 'Invalid backup cursor' USING ERRCODE='22023';
  END IF;
 END IF;
 IF phase=0 THEN
  FOR item IN SELECT e.kind,e.id,e.data,e.created_at,e.updated_at FROM fountain_private.entities e
   WHERE e.workspace_id=ws
    AND e.kind NOT IN ('session','clipboard','upload','presence','attachment_chunk','cloud_chunk','upload_gc','upload_migration')
    AND (e.kind COLLATE "C",e.id COLLATE "C") >= (last_kind COLLATE "C",last_id COLLATE "C")
   ORDER BY e.kind COLLATE "C",e.id COLLATE "C"
  LOOP
   raw:=item.data::text;
   IF octet_length(raw)>16777216 THEN RAISE EXCEPTION 'Backup entity exceeds valid bounds' USING ERRCODE='PT413';END IF;
   IF length(item.id) NOT BETWEEN 1 AND 160 OR item.kind !~ '^[a-z][a-z0-9_]{0,63}$'
    OR length(item.created_at) NOT BETWEEN 1 AND 64 OR length(item.updated_at) NOT BETWEEN 1 AND 64
    OR jsonb_typeof(item.data) IS DISTINCT FROM 'object' OR jsonb_typeof(item.data->'id') IS DISTINCT FROM 'string'
    OR item.data->>'id' IS DISTINCT FROM item.id THEN
    RAISE EXCEPTION 'Backup entity is invalid' USING ERRCODE='PT503';
   END IF;
   parts:=greatest(1,(length(raw)+262143)/262144);first_part:=CASE WHEN item.kind=last_kind AND item.id=last_id THEN last_part+1 ELSE 0 END;
   FOR part IN first_part..parts-1 LOOP
    dto:=jsonb_build_object('type','entity','kind',item.kind,'id',item.id,'createdAt',item.created_at,'updatedAt',item.updated_at,'part',part,'parts',parts,'dataPart',substr(raw,part*262144+1,262144));
    IF used+octet_length(dto::text)+2>8388608 OR cardinality(items)>=256 THEN
     RETURN jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',following);
    END IF;
    items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',0,'kind',item.kind,'id',item.id,'offset',0,'part',part,'scope',scope);
   END LOOP;
  END LOOP;
  phase:=1;last_id:='';last_part:=-1;last_kind:='';
 END IF;
 IF phase=1 THEN
  FOR item IN SELECT m.key,m.data FROM fountain_private.meta m WHERE m.workspace_id=ws
   AND m.key NOT IN ('local_cache_binding','attachment_file_root','attachment_file_gc_cursor')
   AND m.key COLLATE "C">=last_id COLLATE "C" ORDER BY m.key COLLATE "C"
  LOOP
   raw:=item.data::text;
   IF octet_length(raw)>16777216 OR length(item.key) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Backup metadata exceeds valid bounds' USING ERRCODE='PT413';
   END IF;
   parts:=greatest(1,(length(raw)+262143)/262144);first_part:=CASE WHEN item.key=last_id THEN last_part+1 ELSE 0 END;
   FOR part IN first_part..parts-1 LOOP
    dto:=jsonb_build_object('type','meta','key',item.key,'part',part,'parts',parts,'dataPart',substr(raw,part*262144+1,262144));
    IF used+octet_length(dto::text)+2>8388608 OR cardinality(items)>=256 THEN
     RETURN jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',following);
    END IF;
    items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',1,'kind','','id',item.key,'offset',0,'part',part,'scope',scope);
   END LOOP;
  END LOOP;
  phase:=2;last_id:='';last_offset:=0;
 END IF;
 IF phase=2 THEN
  FOR item IN SELECT c.attachment_id,c."offset",c.data FROM fountain_private.attachment_chunks c
   JOIN fountain_private.entities e ON e.workspace_id=c.workspace_id AND e.kind='attachment' AND e.id=c.attachment_id
   WHERE c.workspace_id=ws AND e.data->>'storage'='chunks' AND NOT(e.data ? 'cloud_chunks')
    AND NOT EXISTS(SELECT 1 FROM fountain_private.entities o WHERE o.workspace_id=ws AND o.kind='attachment_cloud' AND o.id=e.id)
    AND (c.attachment_id COLLATE "C",c."offset")>(last_id COLLATE "C",last_offset)
   ORDER BY c.attachment_id COLLATE "C",c."offset"
  LOOP
   IF octet_length(item.data)>4194304 OR length(item.attachment_id) NOT BETWEEN 1 AND 160 OR item."offset"<0 OR item."offset">5000000000 THEN
    RAISE EXCEPTION 'Legacy attachment bytes exceed valid bounds' USING ERRCODE='PT503';
   END IF;
   dto:=jsonb_build_object('type','chunk','attachmentId',item.attachment_id,'offset',item."offset",'size',octet_length(item.data),'base64',replace(encode(item.data,'base64'),E'\n',''));
   IF used+octet_length(dto::text)+2>8388608 OR cardinality(items)>=256 THEN
    RETURN jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',following);
   END IF;
   items:=array_append(items,dto);used:=used+octet_length(dto::text)+2;following:=jsonb_build_object('phase',2,'kind','','id',item.attachment_id,'offset',item."offset",'part',0,'scope',scope);
  END LOOP;
 END IF;
 result:=jsonb_build_object('context',p_context,'revision',revision,'items',to_jsonb(items),'nextCursor',NULL);
 IF octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'Backup page limit exceeded' USING ERRCODE='PT413';END IF;
 RETURN result;
END $$;
ALTER FUNCTION fountain_cloud.backup_export(jsonb,bigint,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.backup_export(jsonb,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fountain_cloud.backup_export(jsonb,bigint,jsonb) TO service_role;
CREATE FUNCTION public.fountain_cloud_backup_authorize(p_context jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.backup_authorize(p_context) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_backup_authorize(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_backup_authorize(jsonb) TO service_role;
CREATE FUNCTION public.fountain_cloud_backup_export(p_context jsonb,p_expected_revision bigint DEFAULT NULL,p_cursor jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT fountain_cloud.backup_export(p_context,p_expected_revision,p_cursor) $$;
REVOKE ALL ON FUNCTION public.fountain_cloud_backup_export(jsonb,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_backup_export(jsonb,bigint,jsonb) TO service_role;
COMMIT;
