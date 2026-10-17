-- Run after the draft counter patch in a rollback-only transaction. The counter
-- corruption is a deliberate owner fixture, not a claim of a client exploit.
DO $counter_green$
DECLARE ws text:=current_setting('fountain.counter_test_workspace');before_revision bigint;before_activity bigint;before_counter bigint;changes jsonb;stamp text:=fountain_private.activity_now();
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);
 before_revision:=fountain_cloud.store_revision(ws,'_entity_revision');SELECT activity_revision,next_sequence INTO before_activity,before_counter FROM fountain_private.activity_runtime WHERE workspace_id=ws;
 changes:=jsonb_build_array(jsonb_build_object('op','put','kind','page','id','must-not-write','data',jsonb_build_object('id','must-not-write','title','Counter fence','blocks','[]'::jsonb,'created_at',stamp,'updated_at',stamp),'previousCreatedAt',NULL));
 BEGIN PERFORM fountain_cloud.store_apply_changes_locked(ws,before_revision,changes,NULL,repeat('d',32),false);RAISE EXCEPTION 'Corrupt safe counter accepted a canonical write';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
 IF EXISTS(SELECT 1 FROM fountain_private.entities WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=ws) OR fountain_cloud.store_revision(ws,'_entity_revision')<>before_revision OR (SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>before_counter OR (SELECT activity_revision FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>before_activity THEN RAISE EXCEPTION 'Counter rejection wrote source/events/revision or silently reset state';END IF;
 -- A separate fresh valid namespace still accepts the canonical path.
 ws:=ws||'_valid';PERFORM set_config('fountain.workspace_id',ws,true);PERFORM fountain_private.activity_initialize(ws);
 PERFORM fountain_cloud.store_apply_changes_locked(ws,0,changes,NULL,repeat('e',32),false);
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_events WHERE workspace_id=ws AND sequence=1) OR (SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>2 THEN RAISE EXCEPTION 'Valid current ledger counter was rejected or advanced incorrectly';END IF;
 PERFORM fountain_private.activity_validate_workspace(ws);
END $counter_green$;
