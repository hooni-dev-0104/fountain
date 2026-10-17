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
  ) WHEN keys.key='database_verification_rows_v1' THEN (
   WITH database_source AS (
    SELECT e.id,e.data,CASE WHEN jsonb_typeof(e.data->'properties')='array' THEN e.data->'properties' ELSE '[]'::jsonb END AS properties
    FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='database'
   ), database_projection AS (
    SELECT d.id,CASE WHEN d.data->'id' IS DISTINCT FROM to_jsonb(d.id)
     OR jsonb_typeof(d.data->'properties') IS DISTINCT FROM 'array'
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.properties) p WHERE jsonb_typeof(p) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR length(p->>'id') NOT BETWEEN 1 AND 160 OR jsonb_typeof(p->'type') IS DISTINCT FROM 'string')
     OR (SELECT count(*) FROM jsonb_array_elements(d.properties))<>(SELECT count(DISTINCT p->>'id') FROM jsonb_array_elements(d.properties) p)
     OR (SELECT count(*) FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='owner')>1
     OR (SELECT count(*) FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='verification')>1
     THEN 'null'::jsonb
     WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='owner')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.properties) p WHERE p->>'type'='verification') THEN
      (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(d.data) f
       WHERE f.key=ANY(ARRAY['id','name','title','icon','parent_id','owner_id','teamspace_id','permissions','row_permissions','archived','deleted','deleted_at','created_at','updated_at']))
      ||jsonb_build_object('properties',(
       SELECT jsonb_agg((SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(p.value) f
        WHERE f.key=ANY(ARRAY['id','name','type','generation','initial_default','limit','default','owner_property_id'])) ORDER BY p.ordinality)
       FROM jsonb_array_elements(d.properties) WITH ORDINALITY p(value,ordinality)
       WHERE p.value->>'type' IN ('owner','verification')
        OR p.ordinality=(SELECT min(t.ordinality) FROM jsonb_array_elements(d.properties) WITH ORDINALITY t(value,ordinality) WHERE t.value->>'type'='title')
        OR (d.data->'row_permissions'->>'mode'='assigned' AND p.value->'id'=d.data->'row_permissions'->'property_id')
      )) ELSE NULL END AS data
    FROM database_source d
   ), selected_databases AS (
    SELECT * FROM database_projection WHERE data IS NOT NULL
   ), selected_rows AS (
    SELECT e.id,CASE WHEN e.data->'id' IS DISTINCT FROM to_jsonb(e.id)
     OR jsonb_typeof(e.data->'properties') IS DISTINCT FROM 'object' THEN 'null'::jsonb ELSE
     (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data) f
      WHERE f.key=ANY(ARRAY['id','database_id','owner_id','permissions','archived','deleted','deleted_at','created_at','updated_at','verification_cycle']))
     ||jsonb_build_object('properties',(
      SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data->'properties') f
      WHERE f.key IN (SELECT p->>'id' FROM jsonb_array_elements(d.data->'properties') p WHERE p->>'type' IN ('owner','title'))
       OR (d.data->'row_permissions'->>'mode'='assigned' AND to_jsonb(f.key)=d.data->'row_permissions'->'property_id')
     ),'verification',CASE WHEN jsonb_typeof(e.data->'verification')='object' THEN
      (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data->'verification') f WHERE f.key=ANY(ARRAY['generation','verified_by','verified_at','expires_at']))
      ELSE e.data->'verification' END)
     ||CASE WHEN e.data ? '_owner_generations' THEN jsonb_build_object('_owner_generations',
       CASE WHEN jsonb_typeof(e.data->'_owner_generations')='object' THEN
        (SELECT COALESCE(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(e.data->'_owner_generations') f
         WHERE f.key IN (SELECT p->>'id' FROM jsonb_array_elements(d.data->'properties') p WHERE p->>'type'='owner'))
       ELSE e.data->'_owner_generations' END) ELSE '{}'::jsonb END END AS data
    FROM fountain_private.entities e JOIN selected_databases d ON d.data<>'null'::jsonb AND e.data->'database_id'=d.data->'id'
    WHERE e.workspace_id=ws AND e.kind='row' AND e.data ? 'verification'
   )
   SELECT jsonb_build_object('databases',(SELECT COALESCE(jsonb_agg(d.data ORDER BY d.id COLLATE "C"),'[]'::jsonb) FROM selected_databases d),
    'rows',(SELECT COALESCE(jsonb_agg(r.data ORDER BY r.id COLLATE "C"),'[]'::jsonb) FROM selected_rows r))
  ) ELSE m.data END,'present',CASE WHEN keys.key IN ('wiki_page_headers_v1','database_verification_rows_v1') THEN true ELSE m.key IS NOT NULL END)
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
