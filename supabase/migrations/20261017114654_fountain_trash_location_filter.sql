-- Match the original-location filter to the body-free location metadata for a
-- trashed selected page. Every ancestor must pass the existing strict review;
-- active content and non-page resources retain their prior helper behavior.
CREATE OR REPLACE FUNCTION fountain_private.content_in_location(p_ws text,p_kind text,p_id text,p_location_kind text,p_location_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE locations jsonb;archived jsonb;
BEGIN
 SELECT header->'archived' INTO archived FROM fountain_private.content_search_documents WHERE workspace_id=p_ws AND kind=p_kind AND id=p_id;
 IF p_kind='page' AND archived='true'::jsonb THEN
  IF fountain_private.content_location(p_ws,p_kind,p_id) IS NULL THEN RETURN false;END IF;
  locations:=fountain_private.content_locations(p_ws,p_kind,p_id,true);
 ELSE locations:=fountain_private.content_locations(p_ws,p_kind,p_id);
 END IF;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(locations) x WHERE x.value->>'kind'=p_location_kind AND x.value->>'id'=p_location_id);
END $f$;
