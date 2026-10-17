-- Missing legacy containers are empty; explicitly malformed containers fail
-- closed. The applied retention extractor remains unchanged.
DO $reference_shapes$
DECLARE ws text:='qa_live_attachment_refs_shapes_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T13:00:00Z';variant jsonb;kind_name text;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_cloud.store_lock(ws);
 FOREACH kind_name IN ARRAY ARRAY['page','version'] LOOP
  INSERT INTO fountain_private.entities VALUES(ws,kind_name,'source','{"id":"source"}'::jsonb,stamp,stamp);
  IF fountain_private.attachment_referenced(ws,'target') THEN RAISE EXCEPTION 'Missing document blocks became a reference';END IF;
  DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind=kind_name;
  FOR variant IN SELECT x FROM jsonb_array_elements('[null,{},[null],[[]],[42],[{"attachment_id":42}],[{"attachment_id":"target"},42]]'::jsonb) x LOOP
   INSERT INTO fountain_private.entities VALUES(ws,kind_name,'source',jsonb_build_object('id','source','blocks',variant),stamp,stamp);
   BEGIN PERFORM fountain_private.attachment_referenced(ws,'target');RAISE EXCEPTION 'Malformed document blocks were accepted';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
   DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind=kind_name;
  END LOOP;
 END LOOP;
 FOR variant IN SELECT x FROM jsonb_array_elements('[{}, {"state":{}}, {"state":{"history":{}}}, {"state":{"history":{"baseline":{}}}}, {"state":{"blocks":{"b":{}}}}, {"state":{"blocks":{"b":{"fields":{}}}}}, {"state":{"blocks":{"b":{"fields":{"attachment_id":{"value":null}}}}}}, {"state":{"history":{"ops":{"x":{"type":"block.set","field":"attachment_id","value":null}}}}}, {"state":{"history":{"ops":{"unrelated":{"type":"text.insert","value":["target"],"metadata":{"attachment_id":"target"}}}}}}]'::jsonb) x LOOP
  INSERT INTO fountain_private.entities VALUES(ws,'collaboration','source',variant||'{"id":"source"}'::jsonb,stamp,stamp);
  IF fountain_private.attachment_referenced(ws,'target') THEN RAISE EXCEPTION 'Legacy missing or unrelated metadata became a reference';END IF;
  DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='collaboration';
 END LOOP;
 FOR variant IN SELECT x FROM jsonb_array_elements('[{"state":null},{"state":[]},{"state":{"history":null}},{"state":{"history":[]}},{"state":{"history":{"baseline":null}}},{"state":{"history":{"baseline":[]}}},{"state":{"blocks":null}},{"state":{"blocks":[]}},{"state":{"blocks":{"b":null}}},{"state":{"blocks":{"b":[]}}},{"state":{"blocks":{"b":{"fields":null}}}},{"state":{"blocks":{"b":{"fields":[]}}}},{"state":{"blocks":{"b":{"fields":{"attachment_id":null}}}}},{"state":{"blocks":{"b":{"fields":{"attachment_id":{}}}}}},{"state":{"blocks":{"b":{"fields":{"attachment_id":{"value":42}}}}}},{"state":{"history":{"baseline":{"blocks":null}}}},{"state":{"history":{"baseline":{"blocks":[]}}}},{"state":{"history":{"ops":null}}},{"state":{"history":{"ops":[]}}},{"state":{"history":{"ops":{"x":null}}}},{"state":{"history":{"ops":{"x":[]}}}},{"state":{"history":{"ops":{"x":{"type":"block.set","field":"attachment_id"}}}}}]'::jsonb) x LOOP
  INSERT INTO fountain_private.entities VALUES(ws,'collaboration','source',variant||'{"id":"source"}'::jsonb,stamp,stamp);
  BEGIN PERFORM fountain_private.attachment_referenced(ws,'target');RAISE EXCEPTION 'Malformed CRDT container was accepted';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
  DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='collaboration';
 END LOOP;
 INSERT INTO fountain_private.entities VALUES(ws,'database','db','{"id":"db","properties":[{"id":"f","type":"files"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','row','{"id":"row","database_id":"db","properties":{"f":["target",42]}}'::jsonb,stamp,stamp);
 BEGIN PERFORM fountain_private.attachment_referenced(ws,'target');RAISE EXCEPTION 'Found row reference bypassed later malformed identity';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='row';
 INSERT INTO fountain_private.entities VALUES(ws,'database','1','{"id":"1","properties":[{"id":"f","type":"files"}]}'::jsonb,stamp,stamp);
 FOR variant IN SELECT x FROM jsonb_array_elements('[null,1,{},"", " "]'::jsonb) x LOOP
  INSERT INTO fountain_private.entities VALUES(ws,'row','coerced',jsonb_build_object('id','coerced','database_id',variant,'properties','{}'::jsonb),stamp,stamp);
  BEGIN PERFORM fountain_private.attachment_referenced(ws,'unknown-file');RAISE EXCEPTION 'Non-string or blank database identity was coerced into a reference schema';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
  DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='row' AND id='coerced';
 END LOOP;
 INSERT INTO fountain_private.entities VALUES(ws,'row','missing-db-id','{"id":"missing-db-id","properties":{}}'::jsonb,stamp,stamp);
 BEGIN PERFORM fountain_private.attachment_referenced(ws,'unknown-file');RAISE EXCEPTION 'Missing database identity was accepted';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;

END $reference_shapes$;
