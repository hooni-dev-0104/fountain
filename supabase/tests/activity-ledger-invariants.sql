DO $activity_invariants$
DECLARE ws text:='qa_activity_invariant_'||replace(gen_random_uuid()::text,'-','');stamp text:=fountain_private.activity_now();ledger text;member text;account text;other_ledger text:=replace(gen_random_uuid()::text,'-','');old_member text:=replace(gen_random_uuid()::text,'-','');case_no integer;before_fence jsonb;
BEGIN
 PERFORM fountain_cloud.store_lock(ws);PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO fountain_private.entities VALUES(ws,'member','member','{"id":"member","role":"member","name":"Member","email":"qa@example.invalid","active":true}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'credential','member','{"id":"member","hash":"not-portable"}'::jsonb,stamp,stamp);
 ledger:=fountain_private.activity_initialize(ws);SELECT membership_id INTO member FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member';SELECT account_id INTO account FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='password';before_fence:=fountain_private.activity_backup_fence(ws);
 -- Deliberate owner-only corruption fixtures always roll back their subtransaction;
 -- no production helper or trigger disabling is introduced for repair/purge.
 FOR case_no IN 1..4 LOOP
  BEGIN
   PERFORM set_config('fountain.activity_write',ws,true);
   IF case_no=1 THEN
    INSERT INTO fountain_private.activity_ledgers VALUES(ws,other_ledger,stamp,'restore','canonical-server-v1');
    INSERT INTO fountain_private.activity_memberships VALUES(ws,old_member,other_ledger,'member',stamp,NULL,NULL);
    UPDATE fountain_private.activity_current_members SET membership_id=old_member WHERE workspace_id=ws AND member_id='member';
    BEGIN PERFORM fountain_private.activity_ensure_member(ws,'member');RAISE EXCEPTION 'Old-epoch actor was reused';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
   ELSIF case_no=2 THEN DELETE FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member';
   ELSIF case_no=3 THEN DELETE FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='password';
   ELSE UPDATE fountain_private.activity_current_accounts SET auth_kind='supabase' WHERE workspace_id=ws AND member_id='member' AND auth_kind='password';END IF;
   BEGIN PERFORM fountain_private.activity_validate_workspace(ws);RAISE EXCEPTION 'Corrupt or orphan episode binding was accepted';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
   RAISE EXCEPTION USING ERRCODE='Z0002',MESSAGE='rollback corrupt fixture';
  EXCEPTION WHEN SQLSTATE 'Z0002' THEN NULL;END;
 END LOOP;
 IF fountain_private.activity_backup_fence(ws) IS DISTINCT FROM before_fence THEN RAISE EXCEPTION 'Rejected corrupt fixture changed the activity fence';END IF;
 PERFORM fountain_private.activity_validate_workspace(ws);
END $activity_invariants$;
