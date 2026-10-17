-- Rollback-only private kernel tests; real DB, no human authentication claim.
DO $activity_kernel$
DECLARE ws text:='qa_activity_kernel_'||replace(gen_random_uuid()::text,'-','');stamp text:='2026-10-17T14:00:00.000000Z';before_data jsonb;after_data jsonb;gen text;event jsonb;fence jsonb;ledger text;member text;account text;actor jsonb:='{"member_id":"member","auth_kind":"local"}';seq bigint;rev bigint;kind_name text;
BEGIN
 PERFORM fountain_cloud.store_lock(ws);PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO fountain_private.entities VALUES(ws,'member','member','{"id":"member","name":"Member","email":"qa@example.invalid","role":"member","active":true}'::jsonb,stamp,stamp);
 fence:=fountain_private.activity_backup_fence(ws);ledger:=fountain_private.activity_initialize(ws);
 IF fence=fountain_private.activity_backup_fence(ws) OR ledger IS DISTINCT FROM fountain_private.activity_initialize(ws) THEN RAISE EXCEPTION 'Lazy initialization or stable epoch failed';END IF;
 SELECT membership_id INTO member FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member';
 INSERT INTO fountain_private.entities VALUES(ws,'page','page','{"id":"page","title":"Original","blocks":[],"big":9007199254740993,"decimal":1.2300}'::jsonb,stamp,stamp);
 SELECT data INTO after_data FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id='page';SELECT generation INTO gen FROM fountain_private.content_provenance WHERE workspace_id=ws AND kind='page' AND id='page';
 EXECUTE 'SET LOCAL ROLE fountain_backend';
 event:=fountain_private.activity_capture(ws,'page','page',NULL,after_data,gen,repeat('a',32),1,actor,'human');
 IF event->>'action'<>'created' OR event->>'actor_member_id'<>'member' OR event->>'membership_id'<>member OR event->'account_id'<>'null'::jsonb THEN RAISE EXCEPTION 'Trusted local source attribution failed';END IF;
 SELECT next_sequence,activity_revision INTO seq,rev FROM fountain_private.activity_runtime WHERE workspace_id=ws;
 IF fountain_private.activity_capture(ws,'page','page',NULL,after_data,gen,repeat('a',32),1,actor,'human') IS DISTINCT FROM event OR (SELECT next_sequence FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>seq OR (SELECT activity_revision FROM fountain_private.activity_runtime WHERE workspace_id=ws)<>rev THEN RAISE EXCEPTION 'Activity exact replay consumed sequence/revision';END IF;
 BEGIN PERFORM fountain_private.activity_capture(ws,'page','page',after_data,NULL,gen,repeat('a',32),1,actor,'human');RAISE EXCEPTION 'Conflicting command accepted';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 BEGIN UPDATE fountain_private.activity_events SET action='viewed' WHERE workspace_id=ws;RAISE EXCEPTION 'Backend changed immutable activity';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 PERFORM set_config('fountain.activity_write',ws,true);
 BEGIN DELETE FROM fountain_private.activity_memberships WHERE workspace_id=ws;RAISE EXCEPTION 'Forged activity GUC bypassed private guard';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 PERFORM set_config('fountain.activity_write','',true);EXECUTE 'RESET ROLE';
 before_data:=after_data;after_data:=after_data||'{"title":"Edited","revision":2}'::jsonb;UPDATE fountain_private.entities SET data=after_data WHERE workspace_id=ws AND kind='page' AND id='page';
 event:=fountain_private.activity_capture(ws,'page','page',before_data,after_data,gen,repeat('b',32),1,actor,'human');IF event->>'action'<>'edited' THEN RAISE EXCEPTION 'Authored edit was not captured';END IF;
 before_data:=after_data;after_data:=after_data||'{"parent_id":"moved","permissions":{"default":"private"}}'::jsonb;UPDATE fountain_private.entities SET data=after_data WHERE workspace_id=ws AND kind='page' AND id='page';
 event:=fountain_private.activity_capture(ws,'page','page',before_data,after_data,gen,repeat('c',32),1,actor,'human');IF event->>'action'<>'managed' THEN RAISE EXCEPTION 'Movement/ACL was not management';END IF;
 before_data:=after_data;after_data:=after_data||'{"revision":999,"updated_at":"ignored"}'::jsonb;UPDATE fountain_private.entities SET data=after_data WHERE workspace_id=ws AND kind='page' AND id='page';
 IF fountain_private.activity_capture(ws,'page','page',before_data,after_data,gen,repeat('d',32),1,actor,'human') IS NOT NULL THEN RAISE EXCEPTION 'Timestamp/revision created false edit';END IF;
 PERFORM set_config('fountain.content_actor','{"workspace_id":"forged","member_id":"member","cause":"human"}',true);
 INSERT INTO fountain_private.entities VALUES(ws,'audit','forged-audit','{"id":"forged-audit","action":"page.viewed","user":"member","details":{"page_id":"page"}}'::jsonb,stamp,stamp);
 IF (SELECT count(*) FROM fountain_private.activity_events WHERE workspace_id=ws)<>3 THEN RAISE EXCEPTION 'Generic audit/actor GUC created activity';END IF;
 fence:=fountain_private.activity_backup_fence(ws);PERFORM fountain_private.activity_view(ws,'page','page',repeat('e',32),actor,'human');IF fence=fountain_private.activity_backup_fence(ws) THEN RAISE EXCEPTION 'View did not move activity fence';END IF;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='page' AND id='page';PERFORM fountain_private.activity_capture(ws,'page','page',after_data,NULL,gen,repeat('f',32),1,actor,'human');
 INSERT INTO fountain_private.entities VALUES(ws,'page','page','{"id":"page","title":"New generation","blocks":[]}'::jsonb,stamp,stamp);
 IF (SELECT generation FROM fountain_private.content_provenance WHERE workspace_id=ws AND kind='page' AND id='page')=gen THEN RAISE EXCEPTION 'Reused resource ID inherited the old generation';END IF;
 -- Role/name/email edits preserve membership, inactive closes, reactivation
 -- opens another membership, and credential reset preserves account episode.
 UPDATE fountain_private.entities SET data=data||'{"role":"admin","name":"Changed","email":"changed@example.invalid"}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 IF (SELECT membership_id FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member')<>member THEN RAISE EXCEPTION 'Role or email changed membership identity';END IF;
 INSERT INTO fountain_private.entities VALUES(ws,'credential','member','{"id":"member","secret":"not-portable"}'::jsonb,stamp,stamp);SELECT account_id INTO account FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='password';
 UPDATE fountain_private.entities SET data=data||'{"secret":"new-not-portable"}'::jsonb WHERE workspace_id=ws AND kind='credential' AND id='member';
 IF (SELECT account_id FROM fountain_private.activity_current_accounts WHERE workspace_id=ws AND member_id='member' AND auth_kind='password')<>account THEN RAISE EXCEPTION 'Password reset changed account episode';END IF;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='credential' AND id='member';
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_accounts WHERE workspace_id=ws AND id=account AND close_reason='credential_removed') THEN RAISE EXCEPTION 'Credential deletion did not close episode';END IF;
 UPDATE fountain_private.entities SET data=data||'{"active":false}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_memberships WHERE workspace_id=ws AND id=member AND close_reason='inactive') THEN RAISE EXCEPTION 'Inactive membership remained open';END IF;
 UPDATE fountain_private.entities SET data=data||'{"active":true}'::jsonb WHERE workspace_id=ws AND kind='member' AND id='member';
 IF (SELECT membership_id FROM fountain_private.activity_current_members WHERE workspace_id=ws AND member_id='member')=member THEN RAISE EXCEPTION 'Reactivation reused closed membership';END IF;
 PERFORM fountain_private.activity_validate_workspace(ws);
END $activity_kernel$;
