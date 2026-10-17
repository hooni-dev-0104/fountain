-- Full entity digest, not a normalized text/prefix digest. No source body leaves
-- SQL in this proof; only activity metadata is returned by the private kernel.
DO $activity_large$
DECLARE ws text:='qa_activity_large_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T14:00:00.000000Z';source jsonb;generation text;event jsonb;
BEGIN
 PERFORM fountain_cloud.store_lock(ws);PERFORM set_config('fountain.workspace_id',ws,true);
 source:=jsonb_build_object('id','large','title','Large','blocks','[]'::jsonb,'payload',repeat('x',4194304)||'終端','created_at',stamp,'updated_at',stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'page','large',source,stamp,stamp);SELECT p.generation INTO generation FROM fountain_private.content_provenance p WHERE p.workspace_id=ws AND p.kind='page' AND p.id='large';
 event:=fountain_private.activity_capture(ws,'page','large',NULL,source,generation,repeat('a',32),1,NULL,'import');
 IF event->>'origin'<>'import' OR event->'actor_member_id'<>'null'::jsonb OR (event->>'source_bytes')::bigint NOT BETWEEN 4194304 AND 4195304 OR octet_length(event::text)>4096 THEN RAISE EXCEPTION 'Full source size/body-free event or unattributed import origin failed';END IF;
 IF event->>'source_sha256'<>'0af9ea955dc477d8a7cc7615afa26f9b45bd2091717b7db58ece1ee07f311d53' THEN RAISE EXCEPTION 'Full entity source digest differs';END IF;
 PERFORM fountain_private.activity_validate_workspace(ws);
END $activity_large$;
