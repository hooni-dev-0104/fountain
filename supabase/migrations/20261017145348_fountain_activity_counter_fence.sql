-- Fail closed on a corrupted safe counter before any canonical source write.
-- The workspace/ledger/sequence primary key supports this last-event lookup.
CREATE OR REPLACE FUNCTION fountain_private.activity_initialize(p_workspace text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE target text;previous text;r record;
BEGIN
 PERFORM fountain_private.activity_lock(p_workspace);
 SELECT rt.ledger_id INTO target FROM fountain_private.activity_runtime rt JOIN fountain_private.activity_ledgers l ON l.workspace_id=rt.workspace_id AND l.id=rt.ledger_id WHERE rt.workspace_id=p_workspace AND rt.singleton=1 AND rt.next_sequence BETWEEN 1 AND 9007199254740991 AND rt.activity_revision BETWEEN 1 AND 9007199254740991
  AND rt.next_sequence=COALESCE((SELECT e.sequence+1 FROM fountain_private.activity_events e WHERE e.workspace_id=rt.workspace_id AND e.ledger_id=rt.ledger_id ORDER BY e.sequence DESC LIMIT 1),1);
 IF FOUND THEN RETURN target;END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.activity_runtime WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_ledgers WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=p_workspace) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=p_workspace) THEN RAISE EXCEPTION 'Activity history requires explicit trusted restoration or repair' USING ERRCODE='PT503';END IF;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',p_workspace,true);
 target:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.activity_ledgers VALUES(p_workspace,target,fountain_private.activity_now(),'installation','canonical-server-v1');
 INSERT INTO fountain_private.activity_runtime VALUES(p_workspace,1,target,1,1);
 FOR r IN SELECT e.id FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='member' AND e.data->>'id'=e.id AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND e.data->>'role' IN('owner','admin','member','guest') ORDER BY e.id COLLATE "C" LOOP
  PERFORM fountain_private.activity_ensure_member(p_workspace,r.id);
  IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace AND e.kind='credential' AND e.id=r.id) THEN PERFORM fountain_private.activity_ensure_account(p_workspace,r.id,'password');END IF;
  IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=p_workspace AND m.member_id=r.id) THEN PERFORM fountain_private.activity_ensure_account(p_workspace,r.id,'supabase');END IF;
 END LOOP;
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);RETURN target;
END $f$;
ALTER FUNCTION fountain_private.activity_initialize(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_initialize(text) FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
GRANT EXECUTE ON FUNCTION fountain_private.activity_initialize(text) TO fountain_backend;
