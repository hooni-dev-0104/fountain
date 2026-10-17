-- Deliberate legacy metadata fixtures: accepting a member row is not an
-- authentication claim, and an ineligible row must not mint actor episodes.
DO $member_eligibility$
DECLARE ws text:=current_setting('fountain.eligibility_test_workspace');stamp text:=fountain_private.activity_now();membership text;password_account text;supabase_account text;user_id uuid:=gen_random_uuid();new_member text;
BEGIN
 PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO fountain_private.entities VALUES(ws,'member','member','{"id":"member","name":"가족"}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'credential','member','{"id":"member","hash":"fixture-only-not-portable"}'::jsonb,stamp,stamp);
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at) VALUES(user_id,'authenticated','authenticated','eligibility-'||user_id||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp());
 INSERT INTO fountain_private.identity_mapping VALUES(ws,user_id,'member',clock_timestamp());
 IF EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=ws) THEN RAISE EXCEPTION 'Minimal member or its credential/mapping minted identity';END IF;
 UPDATE fountain_private.entities SET data=data||'{"role":"member","active":true,"email":"qa@example.invalid"}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 SELECT membership_id INTO membership FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member';SELECT account_id INTO password_account FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='password';SELECT account_id INTO supabase_account FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='supabase';
 IF membership IS NULL OR password_account IS NULL OR supabase_account IS NULL THEN RAISE EXCEPTION 'Newly eligible member did not open its observed episodes';END IF;
 UPDATE fountain_private.entities SET data=data||'{"role":"admin","name":"Changed","email":"changed@example.invalid"}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 UPDATE fountain_private.entities SET data=data||'{"hash":"reset-fixture-only"}'::jsonb WHERE workspace_id=ws AND kind='credential' AND id='member';
 IF (SELECT membership_id FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member')<>membership OR (SELECT account_id FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='password')<>password_account OR (SELECT account_id FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='supabase')<>supabase_account THEN RAISE EXCEPTION 'Valid role/name/email/password reset changed identity episode';END IF;
 UPDATE fountain_private.entities SET data=data||'{"role":"invalid-role"}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 IF EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=ws) OR EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=ws) OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=ws AND id=membership AND close_reason='inactive') OR (SELECT count(*) FROM fountain_private.activity_accounts WHERE workspace_id=ws AND closed_at IS NOT NULL)<>2 THEN RAISE EXCEPTION 'Ineligible role did not close current episodes';END IF;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='credential' AND id='member';INSERT INTO fountain_private.entities VALUES(ws,'credential','member','{"id":"member","hash":"another-fixture-only"}'::jsonb,stamp,stamp);
 DELETE FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=user_id;INSERT INTO fountain_private.identity_mapping VALUES(ws,user_id,'member',clock_timestamp());
 IF EXISTS(SELECT 1 FROM fountain_private.activity_current_accounts WHERE workspace_id=ws) THEN RAISE EXCEPTION 'Ineligible credential/mapping reopened an account';END IF;
 UPDATE fountain_private.entities SET data=data||'{"role":"guest"}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 SELECT membership_id INTO new_member FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member';IF new_member IS NULL OR new_member=membership THEN RAISE EXCEPTION 'Re-eligible member reused its closed episode';END IF;
 -- Missing role is false, not SQL unknown: valid -> missing must also close.
 UPDATE fountain_private.entities SET data=data-'role' WHERE workspace_id=ws AND kind='member' AND id='member';
 IF EXISTS(SELECT 1 FROM fountain_private.activity_current_members WHERE workspace_id=ws) OR NOT EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=ws AND id=new_member AND close_reason='inactive') THEN RAISE EXCEPTION 'Missing role failed to close a formerly eligible member';END IF;
 PERFORM fountain_private.activity_validate_workspace(ws);
END $member_eligibility$;
