-- Narrow old/new reference predicate comparison in actual PostgreSQL. This
-- proves the latent gap in the old DELETE guard; full HTTP DELETE/undo evidence
-- is recorded by the application integration tests, not asserted by this query.
DO $latent_regression$
DECLARE ws text:='qa_live_attachment_refs_red_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T13:00:00.000000Z';legacy_referenced boolean;fixed_referenced boolean;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 INSERT INTO fountain_private.entities VALUES(ws,'page','p','{"id":"p","blocks":[]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'collaboration','p','{"id":"p","state":{"blocks":{},"history":{"baseline":{"blocks":{}},"ops":{"earlier-attachment":{"type":"block.set","field":"attachment_id","value":"latent-only"},"later-removal":{"type":"block.set","field":"attachment_id","value":null}}}}}'::jsonb,stamp,stamp);
 -- Existing DELETE checks page/version blocks, plus row files. There are no rows
 -- in this fixture, and the attachment exists only in one historical operation.
 SELECT EXISTS(SELECT 1 FROM fountain_private.entities e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data->'blocks')='array' THEN e.data->'blocks' ELSE '[]'::jsonb END) b WHERE e.workspace_id=ws AND e.kind IN('page','version') AND b->>'attachment_id'='latent-only') INTO legacy_referenced;
 fixed_referenced:=fountain_private.attachment_referenced(ws,'latent-only');
 IF legacy_referenced IS DISTINCT FROM false OR fixed_referenced IS DISTINCT FROM true THEN RAISE EXCEPTION 'Old/new latent-only reference predicate did not reproduce the gap';END IF;
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{state,history,ops}','{}') WHERE workspace_id=ws AND kind='collaboration' AND id='p';
 IF fountain_private.attachment_referenced(ws,'latent-only') THEN RAISE EXCEPTION 'Removed historical reference still blocks deletion';END IF;
END $latent_regression$;
