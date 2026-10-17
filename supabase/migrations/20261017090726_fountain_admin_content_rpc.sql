-- Bounded service-only content operations. Edge pins a fresh capability check to
-- the same storage context and entity revision; every RPC revalidates both.
CREATE FUNCTION fountain_private.content_rpc_guard(p_context jsonb,p_expected_revision bigint) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;
BEGIN
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Invalid revision' USING ERRCODE='22023';END IF;
 IF fountain_cloud.store_revision(ws,'_entity_revision')<>p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.content_search_state WHERE workspace_id=ws AND ready AND index_version=1) THEN RAISE EXCEPTION 'Content index unavailable' USING ERRCODE='PT503';END IF;
 RETURN ws;
END $f$;
CREATE FUNCTION fountain_private.content_cursor(p_ws text,p_context jsonb,p_purpose text,p_query jsonb,p_after jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE s fountain_private.content_search_state;payload jsonb;signature text;
BEGIN
 SELECT * INTO s FROM fountain_private.content_search_state WHERE workspace_id=p_ws;
 payload:=jsonb_build_object('version',1,'purpose',p_purpose,'query_hash',encode(sha256(convert_to(p_query::text,'UTF8')),'hex'),'context_hash',encode(sha256(convert_to(p_context::text,'UTF8')),'hex'),'index_version',s.index_version,'content_revision',s.content_revision,'after',p_after);
 signature:=encode(extensions.hmac(convert_to(payload::text,'UTF8'),decode(s.cursor_secret,'hex'),'sha256'),'hex');
 RETURN jsonb_build_object('payload',payload,'signature',signature);
END $f$;
CREATE FUNCTION fountain_private.content_cursor_read(p_ws text,p_context jsonb,p_purpose text,p_query jsonb,p_cursor jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE expected jsonb;payload jsonb;signature text;s fountain_private.content_search_state;
BEGIN
 IF p_cursor IS NULL OR p_cursor='null'::jsonb THEN RETURN NULL;END IF;
 IF jsonb_typeof(p_cursor) IS DISTINCT FROM 'object' OR NOT(p_cursor ?& ARRAY['payload','signature']) OR p_cursor-ARRAY['payload','signature']<>'{}' OR jsonb_typeof(p_cursor->'payload')<>'object' OR jsonb_typeof(p_cursor->'signature')<>'string' OR p_cursor->>'signature' !~ '^[a-f0-9]{64}$' OR octet_length(p_cursor::text)>16384 THEN RAISE EXCEPTION 'Invalid content cursor' USING ERRCODE='22023';END IF;
 payload:=p_cursor->'payload';SELECT * INTO s FROM fountain_private.content_search_state WHERE workspace_id=p_ws;
 signature:=encode(extensions.hmac(convert_to(payload::text,'UTF8'),decode(s.cursor_secret,'hex'),'sha256'),'hex');
 IF signature<>p_cursor->>'signature' THEN RAISE EXCEPTION 'Invalid content cursor' USING ERRCODE='22023';END IF;
 expected:=fountain_private.content_cursor(p_ws,p_context,p_purpose,p_query,payload->'after')->'payload';
 IF payload IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CONTENT_CURSOR_CHANGED' USING ERRCODE='PT409';END IF;
 IF jsonb_typeof(payload->'after') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid content cursor' USING ERRCODE='22023';END IF;
 RETURN payload->'after';
END $f$;
-- Display chunks are already NFKC/space normalized. Map folded offsets back to
-- displayed Unicode codepoints so full-casefold expansion never leaks oversized
-- excerpts or clips a surrogate. The matching field determines the excerpt.
CREATE FUNCTION fountain_private.content_excerpt(p_display text,p_terms jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE folded text:='';positions integer[]:='{}';i integer;j integer;c text;piece text;term text;hit integer;best integer;start_at integer;
BEGIN
 IF p_display IS NULL THEN RETURN NULL;END IF;
 FOR i IN 1..length(p_display) LOOP
  piece:=fountain_private.content_casefold(substring(p_display,i,1));folded:=folded||piece;
  FOR j IN 1..length(piece) LOOP positions:=array_append(positions,i);END LOOP;
 END LOOP;
 FOR term IN SELECT value FROM jsonb_array_elements_text(p_terms) LOOP
  hit:=strpos(folded,term);IF hit>0 AND (best IS NULL OR hit<best) THEN best:=hit;END IF;
 END LOOP;
 start_at:=greatest(1,COALESCE(positions[best],1)-60);
 RETURN substring(p_display,start_at,180);
END $f$;
CREATE FUNCTION fountain_private.content_public_actor(p_ws text,p_id text,p_cause text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('id',p_id,'name',(SELECT CASE WHEN jsonb_typeof(data->'name')='string' THEN left(data->>'name',1000) END FROM fountain_private.entities WHERE workspace_id=p_ws AND kind='member' AND id=p_id),'cause',CASE WHEN p_cause IN('human','automation','import','public_form','system') THEN p_cause ELSE 'unknown' END)
$f$;
-- Source/provenance timestamps preserve microseconds; authored property date
-- scalar semantics intentionally retain their separate millisecond oracle.
CREATE FUNCTION fountain_private.content_instant(p_value text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
DECLARE m text[];stamp timestamp;offset_minutes integer;
BEGIN
 m:=regexp_match(p_value,'^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$');
 IF m IS NULL OR m[1]::integer<1 OR m[4]::integer>23 OR m[5]::integer>59 OR m[6]::integer>59 OR COALESCE(m[10],'0')::integer>23 OR COALESCE(m[11],'0')::integer>59 THEN RETURN NULL;END IF;
 stamp:=make_timestamp(m[1]::integer,m[2]::integer,m[3]::integer,m[4]::integer,m[5]::integer,m[6]::double precision)+COALESCE(('0.'||m[7])::numeric,0)*interval '1 second';
 offset_minutes:=(COALESCE(m[10],'0')::integer*60+COALESCE(m[11],'0')::integer)*CASE WHEN m[9]='-' THEN -1 ELSE 1 END;
 stamp:=stamp-offset_minutes*interval '1 minute';
 IF stamp<timestamp '0001-01-01' OR stamp>=timestamp '10000-01-01' THEN RETURN NULL;END IF;
 RETURN extract(epoch FROM stamp);
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN RETURN NULL;
END $f$;
CREATE FUNCTION fountain_private.content_terms(p_query text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $f$
DECLARE result jsonb:='[]';position integer:=1;ending integer;token text;counted integer:=0;size integer:=length(p_query);
BEGIN
 WHILE position<=size LOOP
  IF substring(p_query,position,1)=' ' THEN position:=position+1;CONTINUE;END IF;
  IF substring(p_query,position,1)='"' THEN
   ending:=strpos(substring(p_query,position+1),'"');
   IF ending=0 THEN RAISE EXCEPTION 'Invalid search phrase' USING ERRCODE='22023';END IF;
   ending:=ending+position;token:=btrim(substring(p_query,position+1,ending-position-1),' ');
   IF token='' OR(ending<size AND substring(p_query,ending+1,1)<>' ') THEN RAISE EXCEPTION 'Invalid search phrase' USING ERRCODE='22023';END IF;
   position:=ending+1;
  ELSE
   ending:=strpos(substring(p_query,position),' ');ending:=CASE WHEN ending=0 THEN size+1 ELSE ending+position-1 END;
   token:=substring(p_query,position,ending-position);
   IF strpos(token,'"')>0 THEN RAISE EXCEPTION 'Invalid search phrase' USING ERRCODE='22023';END IF;
   position:=ending;
  END IF;
  counted:=counted+1;IF counted>16 THEN RAISE EXCEPTION 'Too many search terms' USING ERRCODE='22023';END IF;
  IF NOT(result @> jsonb_build_array(token)) THEN result:=result||jsonb_build_array(token);END IF;
 END LOOP;
 RETURN result;
END $f$;
CREATE FUNCTION fountain_private.content_after(p_value jsonb,p_kind text,p_id text,p_after_value jsonb,p_after_kind text,p_after_id text,p_desc boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $f$
DECLARE cmp integer;
BEGIN
 IF p_value IS NULL OR p_value='null'::jsonb THEN
  IF p_after_value IS NOT NULL AND p_after_value<>'null'::jsonb THEN RETURN true;END IF;
 ELSIF p_after_value IS NULL OR p_after_value='null'::jsonb THEN RETURN false;
 ELSE
  IF jsonb_typeof(p_value)='string' THEN cmp:=CASE WHEN (p_value#>>'{}') COLLATE "C"<(p_after_value#>>'{}') COLLATE "C" THEN -1 WHEN p_value=p_after_value THEN 0 ELSE 1 END;
  ELSE cmp:=CASE WHEN p_value<p_after_value THEN -1 WHEN p_value=p_after_value THEN 0 ELSE 1 END;END IF;
  IF cmp<>0 THEN RETURN CASE WHEN p_desc THEN cmp<0 ELSE cmp>0 END;END IF;
 END IF;
 RETURN (p_kind COLLATE "C",p_id COLLATE "C")>(p_after_kind COLLATE "C",p_after_id COLLATE "C");
END $f$;
CREATE FUNCTION public.fountain_cloud_content_search(p_context jsonb,p_expected_revision bigint,p_query jsonb,p_cursor jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;after_key jsonb;after_doc fountain_private.content_search_documents;after_value jsonb;d record;
 item jsonb;items jsonb:='[]';last_key jsonb;next_key jsonb;v_limit integer;v_field text;v_sort text;v_desc boolean;v_terms jsonb;v_audience jsonb;v_location jsonb;v_excerpt text;v_source text;v_seen integer:=0;v_size integer:=0;v_more boolean:=false;
BEGIN
 ws:=fountain_private.content_rpc_guard(p_context,p_expected_revision);
 IF jsonb_typeof(p_query) IS DISTINCT FROM 'object' OR NOT(p_query ?& ARRAY['version','q','terms','field','kind','status','audience','creator_id','creator_unknown','editor_id','editor_unknown','created_after','created_before','edited_after','edited_before','location_kind','location_id','shared_with_id','sort','direction','limit']) OR p_query-ARRAY['version','q','terms','field','kind','status','audience','creator_id','creator_unknown','editor_id','editor_unknown','created_after','created_before','edited_after','edited_before','location_kind','location_id','shared_with_id','sort','direction','limit']<>'{}'::jsonb
 OR p_query->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_query->'q')<>'string' OR length(p_query->>'q')>512 OR fountain_private.content_fold(p_query->>'q')<>p_query->>'q'
 OR p_query->'terms' IS DISTINCT FROM fountain_private.content_terms(p_query->>'q') OR jsonb_typeof(p_query->'terms')<>'array' OR jsonb_array_length(p_query->'terms')>16 OR (SELECT COALESCE(sum(length(t#>>'{}')),0) FROM jsonb_array_elements(p_query->'terms') t)>512 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_query->'terms') t WHERE jsonb_typeof(t)<>'string' OR length(t#>>'{}') NOT BETWEEN 1 AND 512 OR fountain_private.content_fold(t#>>'{}')<>t#>>'{}')
 OR p_query->>'field' NOT IN('all','id','title','body') OR p_query->>'kind' NOT IN('all','page','database','row') OR p_query->>'status' NOT IN('all','active','trash') OR p_query->>'audience' NOT IN('all','private','internal','external','web','unknown')
 OR p_query->>'sort' NOT IN('title','created','edited') OR p_query->>'direction' NOT IN('asc','desc') OR jsonb_typeof(p_query->'limit')<>'number' OR p_query->>'limit' !~ '^[0-9]+$' OR (p_query->>'limit')::numeric NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid content query' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_query) e WHERE e.key IN('field','kind','status','audience','location_kind','sort','direction') AND jsonb_typeof(e.value)<>'string') OR jsonb_typeof(p_query->'creator_unknown')<>'boolean' OR jsonb_typeof(p_query->'editor_unknown')<>'boolean' OR(p_query->'creator_unknown'='true' AND p_query->>'creator_id' IS NOT NULL) OR(p_query->'editor_unknown'='true' AND p_query->>'editor_id' IS NOT NULL) OR p_query->>'location_kind' NOT IN('all','page','teamspace','database') OR ((p_query->>'location_kind'='all') IS DISTINCT FROM(p_query->>'location_id' IS NULL)) THEN RAISE EXCEPTION 'Invalid content query' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_query) e WHERE e.key IN('creator_id','editor_id','location_id','shared_with_id') AND e.value<>'null'::jsonb AND(jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}') NOT BETWEEN 1 AND 160)) OR EXISTS(SELECT 1 FROM jsonb_each(p_query) e WHERE e.key IN('created_after','created_before','edited_after','edited_before') AND e.value<>'null'::jsonb AND(jsonb_typeof(e.value)<>'string' OR fountain_private.content_instant(e.value#>>'{}') IS NULL)) THEN RAISE EXCEPTION 'Invalid content filter' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p_query) e WHERE e.key IN('created_after','created_before','edited_after','edited_before') AND e.value<>'null'::jsonb AND(e.value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$') OR(p_query->>'created_after' IS NOT NULL AND p_query->>'created_before' IS NOT NULL AND (p_query->>'created_after') COLLATE "C">=(p_query->>'created_before') COLLATE "C") OR(p_query->>'edited_after' IS NOT NULL AND p_query->>'edited_before' IS NOT NULL AND(p_query->>'edited_after') COLLATE "C">=(p_query->>'edited_before') COLLATE "C") THEN RAISE EXCEPTION 'Invalid content dates' USING ERRCODE='22023';END IF;
 v_limit:=(p_query->>'limit')::integer;v_field:=p_query->>'field';v_sort:=p_query->>'sort';v_desc:=p_query->>'direction'='desc';v_terms:=p_query->'terms';
 after_key:=fountain_private.content_cursor_read(ws,p_context,'search',p_query,p_cursor);
 IF after_key IS NOT NULL THEN
  IF NOT(after_key ?& ARRAY['kind','id']) OR after_key-ARRAY['kind','id']<>'{}' OR jsonb_typeof(after_key->'kind')<>'string' OR jsonb_typeof(after_key->'id')<>'string' THEN RAISE EXCEPTION 'Invalid content cursor' USING ERRCODE='22023';END IF;
  SELECT * INTO after_doc FROM fountain_private.content_search_documents WHERE workspace_id=ws AND kind=after_key->>'kind' AND id=after_key->>'id';
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_CURSOR_CHANGED' USING ERRCODE='PT409';END IF;
  after_value:=CASE v_sort WHEN 'title' THEN to_jsonb(after_doc.title_fold) WHEN 'created' THEN to_jsonb(fountain_private.content_instant(after_doc.created_at)) ELSE to_jsonb(fountain_private.content_instant((SELECT edited_at FROM fountain_private.content_provenance WHERE workspace_id=ws AND kind=after_doc.kind AND id=after_doc.id))) END;
 END IF;
 FOR d IN
  SELECT x.*,p.creator_id,p.creator_cause,p.editor_id,p.edited_at,p.editor_cause,p.manager_id,p.manager_at,
   CASE v_sort WHEN 'title' THEN to_jsonb(x.title_fold) WHEN 'created' THEN to_jsonb(fountain_private.content_instant(x.created_at)) ELSE to_jsonb(fountain_private.content_instant(p.edited_at)) END AS sort_value
  FROM fountain_private.content_search_documents x LEFT JOIN fountain_private.content_provenance p USING(workspace_id,kind,id)
  WHERE x.workspace_id=ws AND(p_query->>'kind'='all' OR x.kind=p_query->>'kind')
   AND(p_query->>'status'='all' OR (CASE WHEN fountain_private.content_truth(x.header->'archived') OR fountain_private.content_truth(x.header->'deleted') OR fountain_private.content_truth(x.header->'deleted_at') THEN 'trash' ELSE 'active' END)=p_query->>'status')
   AND(p_query->>'creator_id' IS NULL OR p.creator_id=p_query->>'creator_id') AND(NOT(p_query->>'creator_unknown')::boolean OR p.creator_id IS NULL)
   AND(p_query->>'editor_id' IS NULL OR p.editor_id=p_query->>'editor_id') AND(NOT(p_query->>'editor_unknown')::boolean OR p.editor_id IS NULL)
   AND(p_query->>'created_after' IS NULL OR fountain_private.content_instant(x.created_at)>=fountain_private.content_instant(p_query->>'created_after'))
   AND(p_query->>'created_before' IS NULL OR fountain_private.content_instant(x.created_at)<fountain_private.content_instant(p_query->>'created_before'))
   AND(p_query->>'edited_after' IS NULL OR fountain_private.content_instant(p.edited_at)>=fountain_private.content_instant(p_query->>'edited_after'))
   AND(p_query->>'edited_before' IS NULL OR fountain_private.content_instant(p.edited_at)<fountain_private.content_instant(p_query->>'edited_before'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_terms) t WHERE NOT(
    (v_field IN('all','id') AND strpos(x.id_fold,t)>0) OR (v_field IN('all','title') AND strpos(x.title_fold,t)>0)
    OR(v_field IN('all','body') AND EXISTS(SELECT 1 FROM fountain_private.content_search_chunks c WHERE c.workspace_id=x.workspace_id AND c.kind=x.kind AND c.id=x.id AND strpos(c.folded_value,t)>0))))
  ORDER BY CASE WHEN v_sort='title' AND NOT v_desc THEN x.title_fold END COLLATE "C" ASC NULLS LAST,CASE WHEN v_sort='title' AND v_desc THEN x.title_fold END COLLATE "C" DESC NULLS LAST,
   CASE WHEN v_sort<>'title' AND NOT v_desc THEN fountain_private.content_instant(CASE WHEN v_sort='created' THEN x.created_at ELSE p.edited_at END) END ASC NULLS LAST,
   CASE WHEN v_sort<>'title' AND v_desc THEN fountain_private.content_instant(CASE WHEN v_sort='created' THEN x.created_at ELSE p.edited_at END) END DESC NULLS LAST,x.kind COLLATE "C",x.id COLLATE "C"
 LOOP
  IF after_key IS NOT NULL AND NOT fountain_private.content_after(d.sort_value,d.kind,d.id,after_value,after_key->>'kind',after_key->>'id',v_desc) THEN CONTINUE;END IF;
  v_location:=fountain_private.content_location(ws,d.kind,d.id);
  IF p_query->>'location_kind'<>'all' AND NOT fountain_private.content_in_location(ws,d.kind,d.id,p_query->>'location_kind',p_query->>'location_id') THEN CONTINUE;END IF;
  IF p_query->>'shared_with_id' IS NOT NULL AND COALESCE(fountain_private.content_access_level(ws,d.kind,d.id,p_query->>'shared_with_id',false),0)<1 THEN CONTINUE;END IF;
  v_audience:=fountain_private.content_audience(ws,d.kind,d.id);
  IF p_query->>'audience'<>'all' AND v_audience->>'audience'<>p_query->>'audience' THEN CONTINUE;END IF;
  IF v_seen>=v_limit THEN v_more:=true;EXIT;END IF;
  v_excerpt:=NULL;v_source:=NULL;
  IF jsonb_array_length(v_terms)>0 AND v_field IN('body','all') THEN
   SELECT fountain_private.content_excerpt(c.text_value,v_terms) INTO v_excerpt FROM fountain_private.content_search_chunks c WHERE c.workspace_id=ws AND c.kind=d.kind AND c.id=d.id AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_terms) t WHERE strpos(c.folded_value,t)>0) ORDER BY c.ordinal LIMIT 1;
   IF FOUND THEN v_source:='body';END IF;
  END IF;
  IF v_excerpt IS NULL AND v_field IN('title','all') THEN v_excerpt:=fountain_private.content_excerpt(d.title,v_terms);v_source:='title';END IF;
  IF v_excerpt IS NULL AND v_field='id' THEN v_excerpt:=fountain_private.content_excerpt(d.id,v_terms);v_source:='id';END IF;
  item:=jsonb_build_object('kind',d.kind,'id',d.id,'title',d.title,'icon',d.icon,'status',CASE WHEN fountain_private.content_truth(d.header->'archived') OR fountain_private.content_truth(d.header->'deleted') OR fountain_private.content_truth(d.header->'deleted_at') THEN 'trash' ELSE 'active' END,'location',v_location,'audience',v_audience->'audience','access_summary',v_audience->'access_summary','publication',v_audience->'publication','creator',fountain_private.content_public_actor(ws,d.creator_id,d.creator_cause),'last_editor',fountain_private.content_public_actor(ws,d.editor_id,d.editor_cause),'edited_at',CASE WHEN fountain_private.content_instant(d.edited_at) IS NOT NULL THEN d.edited_at END,'created_at',CASE WHEN fountain_private.content_instant(d.created_at) IS NOT NULL THEN d.created_at END,'snippet',COALESCE(v_excerpt,''),'review_revision',fountain_private.content_review_revision(ws,d.kind,d.id),'can_manage_permissions',false,'can_unpublish',false);
  IF v_size+octet_length(item::text)>524288 THEN IF v_seen=0 THEN RAISE EXCEPTION 'Content metadata limit exceeded' USING ERRCODE='PT413';END IF;v_more:=true;EXIT;END IF;
  items:=items||jsonb_build_array(item);v_size:=v_size+octet_length(item::text);v_seen:=v_seen+1;last_key:=jsonb_build_object('kind',d.kind,'id',d.id);
 END LOOP;
 IF v_more THEN next_key:=fountain_private.content_cursor(ws,p_context,'search',p_query,last_key);END IF;
 RETURN jsonb_build_object('items',items,'next_cursor',next_key,'content_revision',(SELECT content_revision FROM fountain_private.content_search_state WHERE workspace_id=ws));
END $f$;
CREATE FUNCTION public.fountain_cloud_content_access(p_context jsonb,p_expected_revision bigint,p_kind text,p_id text,p_limit integer,p_cursor jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;query jsonb;after_key jsonb;item jsonb;items jsonb:='[]';last_key jsonb;next_key jsonb;member record;reason jsonb;counted integer:=0;size_bytes integer:=0;more boolean:=false;review text;
BEGIN
 ws:=fountain_private.content_rpc_guard(p_context,p_expected_revision);
 IF p_kind IS NULL OR p_kind NOT IN('page','database','row') OR p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 160 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid content access query' USING ERRCODE='22023';END IF;
 review:=fountain_private.content_review_revision(ws,p_kind,p_id);
 IF review IS NULL THEN RAISE EXCEPTION 'Content not found' USING ERRCODE='PT404';END IF;
 query:=jsonb_build_object('kind',p_kind,'id',p_id,'limit',p_limit);after_key:=fountain_private.content_cursor_read(ws,p_context,'access',query,p_cursor);
 IF after_key IS NOT NULL AND(NOT(after_key ?& ARRAY['kind','id']) OR after_key-ARRAY['kind','id']<>'{}' OR after_key->>'kind'<>'member' OR jsonb_typeof(after_key->'id')<>'string') THEN RAISE EXCEPTION 'Invalid content cursor' USING ERRCODE='22023';END IF;
 FOR member IN SELECT id,data FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND(after_key IS NULL OR id COLLATE "C"> (after_key->>'id') COLLATE "C") ORDER BY id COLLATE "C" LOOP
  reason:=fountain_private.content_access_reason(ws,p_kind,p_id,member.id);
  IF COALESCE((reason->>'level')::integer,0)<1 THEN CONTINUE;END IF;
  IF counted>=p_limit THEN more:=true;EXIT;END IF;
  item:=jsonb_build_object('id',member.id,'name',CASE WHEN jsonb_typeof(member.data->'name')='string' THEN left(member.data->>'name',1000) END,'email',CASE WHEN jsonb_typeof(member.data->'email')='string' THEN left(member.data->>'email',1000) END,'role',member.data->>'role','level',(reason->>'level')::integer,'via',reason->>'via','can_revoke',reason->'can_revoke');
  IF size_bytes+octet_length(item::text)>524288 THEN IF counted=0 THEN RAISE EXCEPTION 'Content metadata limit exceeded' USING ERRCODE='PT413';END IF;more:=true;EXIT;END IF;
  items:=items||jsonb_build_array(item);size_bytes:=size_bytes+octet_length(item::text);counted:=counted+1;last_key:=jsonb_build_object('kind','member','id',member.id);
 END LOOP;
 IF more THEN next_key:=fountain_private.content_cursor(ws,p_context,'access',query,last_key);END IF;
 RETURN jsonb_build_object('kind',p_kind,'id',p_id,'items',items,'next_cursor',next_key,'review_revision',review,'content_revision',(SELECT content_revision FROM fountain_private.content_search_state WHERE workspace_id=ws));
END $f$;
CREATE FUNCTION public.fountain_cloud_content_options(p_context jsonb,p_expected_revision bigint,p_query jsonb,p_cursor jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;v_kind text;q text;lim integer;after_key jsonb;after_label text;row_data record;item jsonb;items jsonb:='[]';last_key jsonb;next_key jsonb;counted integer:=0;size_bytes integer:=0;more boolean:=false;
BEGIN
 ws:=fountain_private.content_rpc_guard(p_context,p_expected_revision);
 IF jsonb_typeof(p_query) IS DISTINCT FROM 'object' OR NOT(p_query ?& ARRAY['kind','q','limit']) OR p_query-ARRAY['kind','q','limit']<>'{}' OR jsonb_typeof(p_query->'kind')<>'string' OR p_query->>'kind' NOT IN('member','group','teamspace','page','database') OR jsonb_typeof(p_query->'q')<>'string' OR length(p_query->>'q')>100 OR fountain_private.content_fold(p_query->>'q')<>p_query->>'q' OR jsonb_typeof(p_query->'limit')<>'number' OR p_query->>'limit' !~ '^[0-9]+$' OR(p_query->>'limit')::numeric NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid content options' USING ERRCODE='22023';END IF;
 v_kind:=p_query->>'kind';q:=p_query->>'q';lim:=(p_query->>'limit')::integer;
 after_key:=fountain_private.content_cursor_read(ws,p_context,'options',p_query,p_cursor);
 IF after_key IS NOT NULL THEN
  IF NOT(after_key ?& ARRAY['kind','id']) OR after_key-ARRAY['kind','id']<>'{}' OR after_key->>'kind'<>v_kind OR jsonb_typeof(after_key->'id')<>'string' THEN RAISE EXCEPTION 'Invalid content cursor' USING ERRCODE='22023';END IF;
  IF v_kind IN('page','database') THEN SELECT title_fold INTO after_label FROM fountain_private.content_search_documents WHERE workspace_id=ws AND content_search_documents.kind=v_kind AND id=after_key->>'id';
  ELSE SELECT fountain_private.content_fold(CASE WHEN jsonb_typeof(data->'name')='string' THEN data->>'name' ELSE id END) INTO after_label FROM fountain_private.entities WHERE workspace_id=ws AND entities.kind=v_kind AND id=after_key->>'id';END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_CURSOR_CHANGED' USING ERRCODE='PT409';END IF;
 END IF;
 FOR row_data IN
  WITH options AS(
   SELECT e.id,CASE WHEN jsonb_typeof(e.data->'name')='string' THEN e.data->>'name' ELSE e.id END AS label,
    CASE WHEN v_kind='member' AND jsonb_typeof(e.data->'email')='string' THEN e.data->>'email' END AS email,
    CASE WHEN v_kind='member' AND e.data->>'role' IN('owner','admin','member','guest') THEN e.data->>'role' END AS role,
    CASE WHEN v_kind='member' THEN COALESCE(e.data->'active','true')='true'::jsonb END AS active
   FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind=v_kind AND v_kind IN('member','group','teamspace')
   UNION ALL SELECT d.id,d.title,NULL,NULL,NULL FROM fountain_private.content_search_documents d WHERE d.workspace_id=ws AND d.kind=v_kind AND v_kind IN('page','database'))
  SELECT o.*,fountain_private.content_fold(o.label) AS folded FROM options o
  WHERE q='' OR strpos(fountain_private.content_fold(o.label),q)>0 OR strpos(fountain_private.content_fold(o.id),q)>0 OR strpos(fountain_private.content_fold(COALESCE(o.email,'')),q)>0
  ORDER BY fountain_private.content_fold(o.label) COLLATE "C",o.id COLLATE "C"
 LOOP
  IF after_key IS NOT NULL AND NOT fountain_private.content_after(to_jsonb(row_data.folded),v_kind,row_data.id,to_jsonb(after_label),v_kind,after_key->>'id',false) THEN CONTINUE;END IF;
  IF counted>=lim THEN more:=true;EXIT;END IF;
  item:=jsonb_build_object('id',row_data.id,'label',row_data.label,'email',row_data.email,'role',row_data.role,'active',row_data.active);
  IF size_bytes+octet_length(item::text)>524288 THEN IF counted=0 THEN RAISE EXCEPTION 'Content metadata limit exceeded' USING ERRCODE='PT413';END IF;more:=true;EXIT;END IF;
  items:=items||jsonb_build_array(item);size_bytes:=size_bytes+octet_length(item::text);counted:=counted+1;last_key:=jsonb_build_object('kind',v_kind,'id',row_data.id);
 END LOOP;
 IF more THEN next_key:=fountain_private.content_cursor(ws,p_context,'options',p_query,last_key);END IF;
 RETURN jsonb_build_object('kind',v_kind,'items',items,'next_cursor',next_key,'content_revision',(SELECT content_revision FROM fountain_private.content_search_state WHERE workspace_id=ws));
END $f$;
CREATE FUNCTION public.fountain_cloud_content_permissions(p_context jsonb,p_expected_revision bigint,p_kind text,p_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;doc fountain_private.content_search_documents;acl jsonb;invalid boolean:=false;
BEGIN
 ws:=fountain_private.content_rpc_guard(p_context,p_expected_revision);
 IF p_kind IS NULL OR p_kind NOT IN('page','database','row') OR p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid content permissions query' USING ERRCODE='22023';END IF;
 SELECT * INTO doc FROM fountain_private.content_search_documents WHERE workspace_id=ws AND kind=p_kind AND id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Content not found' USING ERRCODE='PT404';END IF;
 acl:=doc.header->'permissions';
 IF acl IS NOT NULL AND acl<>'null'::jsonb THEN
  invalid:=fountain_private.content_acl(acl,'','{}') IS NULL OR acl-ARRAY['default','inherit','members','groups']<>'{}';
  IF invalid THEN acl:=NULL;END IF;
 END IF;
 IF octet_length(COALESCE(acl::text,''))>1048576 THEN RAISE EXCEPTION 'Permissions metadata limit exceeded' USING ERRCODE='PT413';END IF;
 RETURN jsonb_build_object('kind',p_kind,'id',p_id,'permissions',acl,'source_invalid',invalid,'review_revision',fountain_private.content_review_revision(ws,p_kind,p_id));
END $f$;
CREATE TABLE fountain_cloud.content_change_receipts (
 workspace_id text NOT NULL,member_id text NOT NULL,session_hash text NOT NULL,request_id uuid NOT NULL,digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,member_id,session_hash,request_id));
ALTER TABLE fountain_cloud.content_change_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.content_change_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON fountain_cloud.content_change_receipts FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
CREATE INDEX content_change_receipts_created_idx ON fountain_cloud.content_change_receipts(created_at);
CREATE FUNCTION public.fountain_cloud_content_change(p_context jsonb,p_expected_revision bigint,p_request_id uuid,p_digest text,p_canonical text,p_kind text,p_id text,p_review_revision text,p_operation text,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;actor text;recorded text;source fountain_private.entities;pub record;permissions jsonb;changed jsonb;changes jsonb:='[]';stamp text;audit_id text;previous_actor text;access_rev bigint;target text;reason jsonb;revision bigint;
BEGIN
 -- Authentication precedes receipt ACK. Replay deliberately ignores old entity
 -- revision after proving this exact authenticated request already committed.
 PERFORM fountain_cloud.store_context(p_context);ws:=p_context->>'workspaceId';actor:=p_context->>'memberId';
 IF p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 9007199254740991 OR p_request_id IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_canonical IS NULL OR octet_length(p_canonical)>1048576 OR p_kind IS NULL OR p_kind NOT IN('page','database','row') OR p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 160 OR p_review_revision IS NULL OR p_review_revision !~ '^[a-f0-9]{64}$' OR p_operation IS NULL OR p_operation NOT IN('set_private','revoke_member','remove_group','replace_permissions','unpublish') OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid content change' USING ERRCODE='22023';END IF;
 IF encode(sha256(convert_to(p_canonical,'UTF8')),'hex')<>p_digest OR p_canonical::jsonb IS DISTINCT FROM jsonb_build_object('context',p_context,'expectedRevision',p_expected_revision,'kind',p_kind,'id',p_id,'reviewRevision',p_review_revision,'operation',p_operation,'value',p_value) THEN RAISE EXCEPTION 'Invalid change digest' USING ERRCODE='22023';END IF;
 SELECT digest INTO recorded FROM fountain_cloud.content_change_receipts WHERE workspace_id=ws AND member_id=actor AND session_hash=p_context->>'sessionHash' AND request_id=p_request_id;
 IF FOUND THEN IF recorded<>p_digest THEN RAISE EXCEPTION 'COMMIT_ID_REUSED' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('applied',true);END IF;
 PERFORM fountain_private.content_rpc_guard(p_context,p_expected_revision);
 IF fountain_private.content_review_revision(ws,p_kind,p_id) IS DISTINCT FROM p_review_revision THEN RAISE EXCEPTION 'CONTENT_REVIEW_CHANGED' USING ERRCODE='PT409';END IF;
 SELECT * INTO source FROM fountain_private.entities WHERE workspace_id=ws AND kind=p_kind AND id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Content not found' USING ERRCODE='PT404';END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00';
 IF p_operation='unpublish' THEN
  IF p_value<>'{}' OR p_kind='row' THEN RAISE EXCEPTION 'Unsupported publication change' USING ERRCODE='22023';END IF;
  FOR pub IN SELECT * FROM fountain_private.entities WHERE workspace_id=ws AND((p_kind='page' AND kind='site' AND data->>'page_id'=p_id) OR(p_kind='database' AND kind='form' AND data->>'database_id'=p_id)) AND fountain_private.content_truth(data->'published') ORDER BY kind COLLATE "C",id COLLATE "C" LOOP
   changed:=pub.data||jsonb_build_object('published',false,'updated_at',stamp);
   changes:=changes||jsonb_build_array(jsonb_build_object('op','put','kind',pub.kind,'id',pub.id,'previousCreatedAt',pub.created_at,'data',changed));
  END LOOP;
 ELSE
  permissions:=CASE WHEN source.data->'permissions' IS NULL OR source.data->'permissions'='null'::jsonb THEN '{"default":"workspace","inherit":true,"members":{},"groups":{}}'::jsonb ELSE source.data->'permissions' END;
  IF p_operation='set_private' THEN
   IF p_value<>'{}' THEN RAISE EXCEPTION 'Invalid private change' USING ERRCODE='22023';END IF;
   permissions:='{"default":"private","inherit":false,"members":{},"groups":{}}';
  ELSIF p_operation='revoke_member' THEN
   IF p_value-ARRAY['member_id']<>'{}' OR jsonb_typeof(p_value->'member_id') IS DISTINCT FROM 'string' OR length(p_value->>'member_id') NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid member change' USING ERRCODE='22023';END IF;
   target:=p_value->>'member_id';reason:=fountain_private.content_access_reason(ws,p_kind,p_id,target);
   IF reason->>'via' IN('resource_owner','workspace_admin') THEN RAISE EXCEPTION 'Implicit owner access cannot be revoked' USING ERRCODE='PT409';END IF;
   IF NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND id=target) THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='22023';END IF;
   IF fountain_private.content_acl(permissions,target,'{}') IS NULL THEN RAISE EXCEPTION 'Invalid existing permissions' USING ERRCODE='PT409';END IF;
   permissions:=permissions||jsonb_build_object('members',COALESCE(permissions->'members','{}')||jsonb_build_object(target,'none'));
  ELSIF p_operation='remove_group' THEN
   IF p_value-ARRAY['group_id']<>'{}' OR jsonb_typeof(p_value->'group_id') IS DISTINCT FROM 'string' OR length(p_value->>'group_id') NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Invalid group change' USING ERRCODE='22023';END IF;
   target:=p_value->>'group_id';
   IF fountain_private.content_acl(permissions,'','{}') IS NULL OR COALESCE(permissions->'groups'->>target,'none') NOT IN('view','comment','edit','full') THEN RAISE EXCEPTION 'Direct group grant not found' USING ERRCODE='PT409';END IF;
   permissions:=permissions||jsonb_build_object('groups',(permissions->'groups')-target);
  ELSE
   IF p_value-ARRAY['permissions']<>'{}' OR jsonb_typeof(p_value->'permissions') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid permissions' USING ERRCODE='22023';END IF;
   permissions:=p_value->'permissions';
  END IF;
  IF permissions-ARRAY['default','inherit','members','groups']<>'{}' OR fountain_private.content_acl(permissions,'','{}') IS NULL
   OR (SELECT count(*) FROM jsonb_each(COALESCE(permissions->'members','{}')))>1000 OR (SELECT count(*) FROM jsonb_each(COALESCE(permissions->'groups','{}')))>1000
   OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(permissions->'members','{}')) m WHERE length(m.key) NOT BETWEEN 1 AND 160 OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND id=m.key AND data->>'role' IN('owner','admin','member','guest')))
   OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(permissions->'groups','{}')) g WHERE length(g.key) NOT BETWEEN 1 AND 160 OR NOT EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws AND kind='group' AND id=g.key)) THEN RAISE EXCEPTION 'Invalid permissions reference' USING ERRCODE='22023';END IF;
  permissions:=jsonb_build_object('default',COALESCE(permissions->>'default','workspace'),'inherit',COALESCE(permissions->'inherit','false'::jsonb),'members',COALESCE(permissions->'members','{}'::jsonb),'groups',COALESCE(permissions->'groups','{}'::jsonb));
  changed:=source.data||jsonb_build_object('permissions',permissions,'updated_at',stamp);
  changes:=jsonb_build_array(jsonb_build_object('op','put','kind',p_kind,'id',p_id,'previousCreatedAt',source.created_at,'data',changed));
 END IF;
 access_rev:=fountain_cloud.store_revision(ws,'access_revision');IF access_rev>=9007199254740991 THEN RAISE EXCEPTION 'Access revision limit reached' USING ERRCODE='PT503';END IF;
 audit_id:=gen_random_uuid()::text;
 changes:=changes||jsonb_build_array(jsonb_build_object('op','meta','key','access_revision','value',access_rev+1),jsonb_build_object('op','put','kind','audit','id',audit_id,'previousCreatedAt',NULL,'data',jsonb_build_object('id',audit_id,'actor',actor,'action','content.admin.'||p_operation,'details',jsonb_build_object('kind',p_kind,'id',p_id,'member_id',p_value->>'member_id','group_id',p_value->>'group_id'),'created_at',stamp,'updated_at',stamp)));
 previous_actor:=current_setting('fountain.content_actor',true);
 PERFORM set_config('fountain.content_actor',jsonb_build_object('workspace_id',ws,'member_id',actor,'cause','human')::text,true);
 BEGIN
  revision:=fountain_cloud.store_apply_changes_locked(ws,p_expected_revision,changes);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('fountain.content_actor',COALESCE(previous_actor,''),true);RAISE;END;
 PERFORM set_config('fountain.content_actor',COALESCE(previous_actor,''),true);
 INSERT INTO fountain_cloud.content_change_receipts(workspace_id,member_id,session_hash,request_id,digest) VALUES(ws,actor,p_context->>'sessionHash',p_request_id,p_digest);
 RETURN jsonb_build_object('applied',true);
END $f$;

DO $permissions$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fountain_private' AND p.proname IN('content_rpc_guard','content_cursor','content_cursor_read','content_excerpt','content_public_actor','content_after','content_instant','content_terms') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,fountain_backend',f.signature);
 END LOOP;
END $permissions$;
REVOKE ALL ON FUNCTION public.fountain_cloud_content_search(jsonb,bigint,jsonb,jsonb),public.fountain_cloud_content_access(jsonb,bigint,text,text,integer,jsonb),public.fountain_cloud_content_permissions(jsonb,bigint,text,text),public.fountain_cloud_content_options(jsonb,bigint,jsonb,jsonb),public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,fountain_backend;
GRANT EXECUTE ON FUNCTION public.fountain_cloud_content_search(jsonb,bigint,jsonb,jsonb),public.fountain_cloud_content_access(jsonb,bigint,text,text,integer,jsonb),public.fountain_cloud_content_permissions(jsonb,bigint,text,text),public.fountain_cloud_content_options(jsonb,bigint,jsonb,jsonb),public.fountain_cloud_content_change(jsonb,bigint,uuid,text,text,text,text,text,text,jsonb) TO service_role;
