CREATE OR REPLACE FUNCTION fountain_cloud.store_snapshot_locked(p_context jsonb,p_principal jsonb,p_selection jsonb,p_cursor jsonb DEFAULT NULL,p_expected_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal jsonb; ws text; revision bigint; access_revision bigint; scope text; item record;
 result jsonb; records jsonb[]:=ARRAY[]::jsonb[]; metas jsonb; dto jsonb; following jsonb:=NULL;
 last_kind text;last_created text;last_id text;count integer:=0;total_bytes bigint;page_size integer;
BEGIN
 principal:=p_principal;ws:=p_context->>'workspaceId';
 PERFORM fountain_cloud.store_selection(p_selection);
 revision:=fountain_cloud.store_revision(ws,'_entity_revision');access_revision:=fountain_cloud.store_revision(ws,'access_revision');
 IF p_expected_revision IS NOT NULL AND (p_expected_revision<0 OR p_expected_revision<>revision) THEN
  RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 page_size:=(p_selection->>'pageSize')::integer;
 scope:=encode(sha256(convert_to(jsonb_build_array(p_context,p_selection,revision)::text,'UTF8')),'hex');
 IF p_cursor IS NOT NULL THEN
  IF p_expected_revision IS NULL OR jsonb_typeof(p_cursor) IS DISTINCT FROM 'object'
   OR NOT(p_cursor ?& ARRAY['kind','createdAt','id','scope']) OR p_cursor-ARRAY['kind','createdAt','id','scope'] <> '{}'::jsonb
   OR p_cursor->>'scope' IS DISTINCT FROM scope
   OR EXISTS(SELECT 1 FROM jsonb_each(p_cursor) e WHERE jsonb_typeof(e.value)<>'string') THEN
   RAISE EXCEPTION 'Invalid snapshot cursor' USING ERRCODE='22023';
  END IF;
 END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('key',keys.key,'value',
  CASE WHEN keys.key='wiki_page_headers_v1' THEN (
   SELECT COALESCE(jsonb_agg(CASE WHEN e.data->'id' IS DISTINCT FROM to_jsonb(e.id) THEN 'null'::jsonb ELSE (
    SELECT COALESCE(jsonb_object_agg(field.key,field.value),'{}'::jsonb)
    FROM jsonb_each(e.data) field WHERE field.key=ANY(ARRAY['id','title','icon','parent_id','teamspace_id','owner_id','permissions','archived','deleted','deleted_at','locked','revision','is_wiki','verification','created_at','updated_at'])
   ) END ORDER BY e.id COLLATE "C"),'[]'::jsonb)
   FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='page'
  ) ELSE m.data END,'present',CASE WHEN keys.key='wiki_page_headers_v1' THEN true ELSE m.key IS NOT NULL END)
  ORDER BY keys.key COLLATE "C"),'[]'::jsonb)
 INTO metas FROM (SELECT DISTINCT value #>> '{}' AS key FROM jsonb_array_elements(p_selection->'metaKeys')) keys
 LEFT JOIN fountain_private.meta m ON m.workspace_id=ws AND m.key=keys.key;
 total_bytes:=octet_length(metas::text)+octet_length(principal::text)+4096;
 IF total_bytes>16777216 THEN RAISE EXCEPTION 'Snapshot limit exceeded' USING ERRCODE='PT413'; END IF;
 FOR item IN
  SELECT e.kind,e.id,e.data,e.created_at,e.updated_at FROM fountain_private.entities e
  WHERE e.workspace_id=ws
   AND ((p_selection->'kinds') ? e.kind OR COALESCE((p_selection->'ids'->e.kind) ? e.id,false))
   AND (p_cursor IS NULL OR (e.kind COLLATE "C",e.created_at COLLATE "C",e.id COLLATE "C") >
    ((p_cursor->>'kind') COLLATE "C",(p_cursor->>'createdAt') COLLATE "C",(p_cursor->>'id') COLLATE "C"))
  ORDER BY e.kind COLLATE "C",e.created_at COLLATE "C",e.id COLLATE "C" LIMIT page_size+1
 LOOP
  IF count=page_size THEN following:=jsonb_build_object('kind',last_kind,'createdAt',last_created,'id',last_id,'scope',scope);EXIT; END IF;
  dto:=jsonb_build_object('kind',item.kind,'id',item.id,'data',CASE WHEN item.kind='attachment' THEN item.data-'data' ELSE item.data END,'createdAt',item.created_at,'updatedAt',item.updated_at);
  IF total_bytes+octet_length(dto::text)>16777216 THEN
   IF count=0 THEN RAISE EXCEPTION 'Snapshot record limit exceeded' USING ERRCODE='PT413'; END IF;
   following:=jsonb_build_object('kind',last_kind,'createdAt',last_created,'id',last_id,'scope',scope);EXIT;
  END IF;
  records:=array_append(records,dto);total_bytes:=total_bytes+octet_length(dto::text);count:=count+1;
  last_kind:=item.kind;last_created:=item.created_at;last_id:=item.id;
 END LOOP;
 result:=jsonb_build_object('workspaceId',ws,'memberId',p_context->>'memberId','revision',revision,'accessRevision',access_revision,
  'principal',principal,'entities',to_jsonb(records),'meta',metas,'nextCursor',following);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'Snapshot limit exceeded' USING ERRCODE='PT413'; END IF;
 RETURN result;
END $$;
