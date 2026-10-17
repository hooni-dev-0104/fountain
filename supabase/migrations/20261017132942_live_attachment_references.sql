-- Metadata-only attachment reference probe. Existing attachment authorization
-- must precede this server-only RPC; the caller fences deletion to its revision.
-- No client table grants, source mutations, private state or policy activation.
CREATE FUNCTION fountain_private.attachment_referenced(p_workspace text,p_attachment_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE row_value record;doc record;field jsonb;value jsonb;entry jsonb;entry_id text;properties jsonb;state jsonb;history jsonb;baseline jsonb;component jsonb;block jsonb;fields jsonb;register jsonb;operation jsonb;row_found boolean;
 blank_chars text:=E' \t\n\r\v\f'||U&'\001C\001D\001E\001F\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000';
BEGIN
 IF p_workspace IS NULL OR length(p_workspace) NOT BETWEEN 1 AND 160 OR current_setting('fountain.workspace_id',true) IS DISTINCT FROM p_workspace
  OR p_attachment_id IS NULL OR length(p_attachment_id) NOT BETWEEN 1 AND 160 OR btrim(p_attachment_id,blank_chars)='' THEN RAISE EXCEPTION 'Invalid attachment reference scope' USING ERRCODE='22023';END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Attachment references require a current database snapshot' USING ERRCODE='PT409';END IF;
 PERFORM fountain_cloud.store_lock(p_workspace);
 FOR doc IN SELECT e.kind,e.data FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind IN('page','version','collaboration') LOOP
  IF jsonb_typeof(doc.data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference source is unavailable' USING ERRCODE='PT503';END IF;
  IF doc.kind IN('page','version') THEN
   component:=COALESCE(doc.data->'blocks','[]'::jsonb);
   IF jsonb_typeof(component) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Current attachment reference blocks are unavailable' USING ERRCODE='PT503';END IF;
   FOR block IN SELECT x FROM jsonb_array_elements(component) x LOOP
    IF jsonb_typeof(block) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference block is unavailable' USING ERRCODE='PT503';END IF;
    value:=block->'attachment_id';
    IF value IS NOT NULL AND value<>'null'::jsonb AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR NOT fountain_private.retention_id(value#>>'{}') OR btrim(value#>>'{}',blank_chars)='') THEN RAISE EXCEPTION 'Current attachment reference identity is unavailable' USING ERRCODE='PT503';END IF;
   END LOOP;
  ELSE
   state:=COALESCE(doc.data->'state','{}'::jsonb);
   history:=COALESCE(state->'history','{}'::jsonb);baseline:=COALESCE(history->'baseline','{}'::jsonb);
   IF jsonb_typeof(state) IS DISTINCT FROM 'object' OR jsonb_typeof(history) IS DISTINCT FROM 'object' OR jsonb_typeof(baseline) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference state is unavailable' USING ERRCODE='PT503';END IF;
   FOR component IN SELECT x FROM jsonb_array_elements(jsonb_build_array(state,baseline)) x LOOP
    IF NOT component ? 'blocks' THEN CONTINUE;END IF;
    IF jsonb_typeof(component->'blocks') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference registers are unavailable' USING ERRCODE='PT503';END IF;
    FOR block IN SELECT x.value FROM jsonb_each(component->'blocks') x LOOP
     IF jsonb_typeof(block) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference register block is unavailable' USING ERRCODE='PT503';END IF;
     fields:=COALESCE(block->'fields','{}'::jsonb);
     IF jsonb_typeof(fields) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference fields are unavailable' USING ERRCODE='PT503';END IF;
     IF fields ? 'attachment_id' THEN
      register:=fields->'attachment_id';
      IF jsonb_typeof(register) IS DISTINCT FROM 'object' OR NOT register ? 'value' THEN RAISE EXCEPTION 'Current attachment reference register is unavailable' USING ERRCODE='PT503';END IF;
      value:=register->'value';
      IF value<>'null'::jsonb AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR NOT fountain_private.retention_id(value#>>'{}') OR btrim(value#>>'{}',blank_chars)='') THEN RAISE EXCEPTION 'Current attachment reference identity is unavailable' USING ERRCODE='PT503';END IF;
     END IF;
    END LOOP;
   END LOOP;
   component:=COALESCE(history->'ops','{}'::jsonb);
   IF jsonb_typeof(component) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference operations are unavailable' USING ERRCODE='PT503';END IF;
   FOR operation IN SELECT x.value FROM jsonb_each(component) x LOOP
    IF jsonb_typeof(operation) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference operation is unavailable' USING ERRCODE='PT503';END IF;
    IF operation->>'type'='block.set' AND operation->>'field'='attachment_id' THEN
     IF NOT operation ? 'value' THEN RAISE EXCEPTION 'Current attachment reference operation value is unavailable' USING ERRCODE='PT503';END IF;
     value:=operation->'value';
     IF value<>'null'::jsonb AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR NOT fountain_private.retention_id(value#>>'{}') OR btrim(value#>>'{}',blank_chars)='') THEN RAISE EXCEPTION 'Current attachment reference identity is unavailable' USING ERRCODE='PT503';END IF;
    END IF;
   END LOOP;
  END IF;
  BEGIN
   IF EXISTS(SELECT 1 FROM fountain_private.retention_references(doc.kind,doc.data) r(attachment_id) WHERE r.attachment_id=p_attachment_id) THEN RETURN true;END IF;
  EXCEPTION WHEN SQLSTATE 'PT409' OR data_exception THEN RAISE EXCEPTION 'Current attachment reference source is unavailable' USING ERRCODE='PT503';END;
 END LOOP;
 -- A reference probe also protects legacy file values. This read normalization
 -- intentionally does not change the stricter applied retention snapshot schema.
 FOR row_value IN
  SELECT e.data AS row_data,d.data AS database_data FROM fountain_private.entities e
  LEFT JOIN fountain_private.entities d ON d.workspace_id=e.workspace_id AND d.kind='database' AND d.id=e.data->>'database_id'
  WHERE e.workspace_id=p_workspace AND e.kind='row'
 LOOP
  IF jsonb_typeof(row_value.row_data->'database_id') IS DISTINCT FROM 'string' OR NOT fountain_private.retention_id(row_value.row_data->>'database_id') OR btrim(row_value.row_data->>'database_id',blank_chars)='' THEN RAISE EXCEPTION 'Current attachment reference database identity is unavailable' USING ERRCODE='PT503';END IF;
  IF row_value.database_data IS NULL OR jsonb_typeof(row_value.database_data->'properties') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Current attachment reference schema is unavailable' USING ERRCODE='PT503';END IF;
  properties:=COALESCE(row_value.row_data->'properties','{}'::jsonb);
  IF jsonb_typeof(properties) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Current attachment reference values are unavailable' USING ERRCODE='PT503';END IF;
  row_found:=false;
  FOR field IN SELECT x FROM jsonb_array_elements(row_value.database_data->'properties') x LOOP
   IF jsonb_typeof(field) IS DISTINCT FROM 'object' OR jsonb_typeof(field->'id') IS DISTINCT FROM 'string' OR NOT fountain_private.retention_id(field->>'id') OR jsonb_typeof(field->'type') IS DISTINCT FROM 'string' OR btrim(field->>'id',blank_chars)='' THEN RAISE EXCEPTION 'Current attachment reference schema is unavailable' USING ERRCODE='PT503';END IF;
   IF field->>'type' IS DISTINCT FROM 'files' THEN CONTINUE;END IF;
   value:=properties->(field->>'id');
   IF value IS NULL OR value='null'::jsonb OR value='""'::jsonb THEN CONTINUE;END IF;
   IF jsonb_typeof(value)='string' THEN value:=jsonb_build_array(value);END IF;
   IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Current attachment reference values are unavailable' USING ERRCODE='PT503';END IF;
   FOR entry IN SELECT x FROM jsonb_array_elements(value) x LOOP
    IF jsonb_typeof(entry)='string' THEN entry_id:=entry#>>'{}';
    ELSIF jsonb_typeof(entry)='object' AND jsonb_typeof(entry->'id')='string' THEN entry_id:=entry->>'id';
    ELSE RAISE EXCEPTION 'Current attachment reference identity is unavailable' USING ERRCODE='PT503';END IF;
    IF NOT fountain_private.retention_id(entry_id) OR btrim(entry_id,blank_chars)='' THEN RAISE EXCEPTION 'Current attachment reference identity is unavailable' USING ERRCODE='PT503';END IF;
    IF entry_id=p_attachment_id THEN row_found:=true;END IF;
   END LOOP;
  END LOOP;
  IF row_found THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END $f$;
ALTER FUNCTION fountain_private.attachment_referenced(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.attachment_referenced(text,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.attachment_referenced(text,text) TO fountain_backend;

CREATE FUNCTION fountain_cloud.store_attachment_references(p_context jsonb,p_attachment_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;answer jsonb;referenced boolean;
BEGIN
 -- Exactly the same current Auth/session/member/workspace writer fence as
 -- store_snapshot; no actor, role or workspace is inferred from a client body.
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 referenced:=fountain_private.attachment_referenced(ws,p_attachment_id);
 answer:=jsonb_build_object('context',p_context,'attachmentId',p_attachment_id,'revision',fountain_cloud.store_revision(ws,'_entity_revision'),'referenced',referenced);
 IF octet_length(answer::text)>4096 THEN RAISE EXCEPTION 'Attachment reference response exceeds bound' USING ERRCODE='PT413';END IF;
 RETURN answer;
END $f$;
ALTER FUNCTION fountain_cloud.store_attachment_references(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_cloud.store_attachment_references(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_cloud.store_attachment_references(jsonb,text) TO service_role;

CREATE FUNCTION public.fountain_cloud_store_attachment_references(p_context jsonb,p_attachment_id text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT fountain_cloud.store_attachment_references(p_context,p_attachment_id)
$f$;
ALTER FUNCTION public.fountain_cloud_store_attachment_references(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fountain_cloud_store_attachment_references(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_store_attachment_references(jsonb,text) TO service_role;
