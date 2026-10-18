-- Synthetic Auth/model transitions in a rollback transaction. Runtime epoch
-- rotation below tests the authorization predicate, not a full v4 import.
CREATE OR REPLACE FUNCTION pg_temp.workspace_grant_expect(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $t$
DECLARE actual text;
BEGIN BEGIN EXECUTE statement;EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;END;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Expected %, received %: %',expected,COALESCE(actual,'success'),left(statement,100);END IF;
END $t$;
DO $test$
DECLARE uid uuid:=gen_random_uuid();sid uuid:=gen_random_uuid();sid_other uuid:=gen_random_uuid();ws text:='qa-grant-'||replace(gen_random_uuid()::text,'-','');ws2 text:='qa-grant-b-'||replace(gen_random_uuid()::text,'-','');
 h text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');binding text:=replace(gen_random_uuid()::text,'-','');
 stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;cipher jsonb:='{"version":1,"keyId":"qa","iv":"AAAAAAAAAAAAAAAA","data":"AAAAAAAAAAAAAAAAAAAAAA"}';ctx jsonb;answer jsonb;old_context jsonb;old_private jsonb;new_private jsonb;new_context jsonb;member jsonb;initial_member jsonb;old_binding text;new_binding text;old_grant uuid;new_grant uuid;ledger text;previous text;result jsonb;cmd uuid:=gen_random_uuid();
BEGIN
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous) VALUES(uid,'authenticated','authenticated','qa-grant-'||uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false);
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after) VALUES(sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),(sid_other,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 PERFORM public.fountain_cloud_account_session_vault('create',jsonb_build_object('row',jsonb_build_object('hash',h,'userId',uid,'authSessionId',sid,'cacheBinding',binding,'createdAt',stamp,'expiresAt',stamp+604800000,'version',0,'tokens',cipher,'revokedAt',NULL,'logoutPending',false)));
 ctx:=jsonb_build_object('sessionHash',h,'cacheBinding',binding,'userId',uid,'authSessionId',sid);
 answer:=public.fountain_cloud_account_directory(ctx,'create',ws,NULL,cmd,'{"name":"권한 검증"}');old_binding:=answer->'session'->>'cache_binding';
 PERFORM public.fountain_cloud_account_directory(ctx,'create',ws2,NULL,gen_random_uuid(),'{"name":"유지할 작업공간"}');
 old_private:=public.fountain_cloud_account_directory(ctx,'context',ws,old_binding,NULL,'{}');
 old_context:=jsonb_build_object('workspaceId',ws,'memberId','local','userId',uid,'authSessionId',sid,'sessionHash',old_private->'hash','cacheBinding',old_binding);
 SELECT data,m.mapping_grant_id INTO member,old_grant FROM fountain_private.entities e JOIN fountain_private.identity_mapping m ON m.workspace_id=e.workspace_id AND m.member_id=e.id WHERE e.workspace_id=ws AND e.kind='member' AND e.id='local';initial_member:=member;
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context||jsonb_build_object('authSessionId',sid_other)),'PT401');
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context||jsonb_build_object('workspaceId',ws2)),'PT403');
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context||'{"role":"owner"}'),'22023');
 -- Ordinary mutable display/role fields preserve the same episode and child.
 UPDATE fountain_private.entities SET data=data||'{"name":"바뀐 이름"}' WHERE workspace_id=ws AND kind='member' AND id='local';
 answer:=public.fountain_cloud_account_directory(ctx,'open',ws,NULL,gen_random_uuid(),jsonb_build_object('expectedBinding',old_binding));IF answer->'session'->>'cache_binding'<>old_binding OR answer->'session'->'member'->>'name'<>'바뀐 이름' THEN RAISE EXCEPTION 'Display edit replaced authority';END IF;
 answer:=public.fountain_cloud_account_directory(ctx,'create',ws,NULL,cmd,'{"name":"권한 검증"}');IF answer->'session'->'member'->>'name'<>'바뀐 이름' THEN RAISE EXCEPTION 'Receipt hid current display identity';END IF;
 -- Deactivation closes episodes; identical timestamps/UUID/name do not repair it.
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{active}','false') WHERE workspace_id=ws AND kind='member' AND id='local';
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context),'PT403');
 UPDATE fountain_private.entities SET data=initial_member WHERE workspace_id=ws AND kind='member' AND id='local';
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context),'PT403');
 PERFORM pg_temp.workspace_grant_expect(format('SELECT public.fountain_cloud_account_directory(%L,''open'',%L,NULL,%L,%L)',ctx,ws,gen_random_uuid(),jsonb_build_object('expectedBinding',old_binding)),'PT409');
 answer:=public.fountain_cloud_account_directory(ctx,'open',ws,NULL,gen_random_uuid(),'{"expectedBinding":null}');new_binding:=answer->'session'->>'cache_binding';IF new_binding=old_binding THEN RAISE EXCEPTION 'Reactivation reused old child';END IF;
 new_private:=public.fountain_cloud_account_directory(ctx,'context',ws,new_binding,NULL,'{}');new_context:=old_context||jsonb_build_object('sessionHash',new_private->'hash','cacheBinding',new_binding);PERFORM fountain_cloud.store_context(new_context);
 -- Mapping metadata edits keep incarnation; direct replacement of its UUID fails.
 UPDATE fountain_private.identity_mapping SET linked_at=linked_at WHERE workspace_id=ws AND auth_user_id=uid;
 PERFORM pg_temp.workspace_grant_expect(format('UPDATE fountain_private.identity_mapping SET mapping_grant_id=%L WHERE workspace_id=%L AND auth_user_id=%L',gen_random_uuid(),ws,uid),'PT409');
 DELETE FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=uid;
 INSERT INTO fountain_private.identity_mapping(workspace_id,auth_user_id,member_id,mapping_grant_id) VALUES(ws,uid,'local',old_grant);
 SELECT mapping_grant_id INTO new_grant FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=uid;
 IF new_grant=old_grant THEN RAISE EXCEPTION 'Caller restored old mapping incarnation';END IF;
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',new_context),'PT403');
 PERFORM pg_temp.workspace_grant_expect(format('SELECT public.fountain_cloud_account_directory(%L,''create'',%L,NULL,%L,''{"name":"권한 검증"}'')',ctx,ws,cmd),'PT403');
 answer:=public.fountain_cloud_account_directory(ctx,'open',ws,NULL,gen_random_uuid(),'{"expectedBinding":null}');old_binding:=answer->'session'->>'cache_binding';old_private:=public.fountain_cloud_account_directory(ctx,'context',ws,old_binding,NULL,'{}');old_context:=old_context||jsonb_build_object('sessionHash',old_private->'hash','cacheBinding',old_binding);
 -- Delete/recreate the same member ID with the same source timestamps; the
 -- lifecycle creates new membership/account episodes and old grants stay dead.
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='member' AND id='local';
 INSERT INTO fountain_private.entities(workspace_id,kind,id,data,created_at,updated_at) VALUES(ws,'member','local',initial_member,initial_member->>'created_at',initial_member->>'updated_at');
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context),'PT403');
 answer:=public.fountain_cloud_account_directory(ctx,'open',ws,NULL,gen_random_uuid(),'{"expectedBinding":null}');new_binding:=answer->'session'->>'cache_binding';new_private:=public.fountain_cloud_account_directory(ctx,'context',ws,new_binding,NULL,'{}');new_context:=old_context||jsonb_build_object('sessionHash',new_private->'hash','cacheBinding',new_binding);
 -- A restored runtime epoch must invalidate an old child even with the same
 -- parent/mapping/member. This uses only private model transitions, no import claim.
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',ws,true);
 PERFORM fountain_private.activity_close_member(ws,'local','restore',fountain_private.activity_now());ledger:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO fountain_private.activity_ledgers VALUES(ws,ledger,fountain_private.activity_now(),'restore','canonical-server-v1');
 UPDATE fountain_private.activity_runtime SET ledger_id=ledger,next_sequence=1,activity_revision=activity_revision+1 WHERE workspace_id=ws AND singleton=1;
 PERFORM fountain_private.activity_ensure_member(ws,'local');PERFORM fountain_private.activity_ensure_account(ws,'local','supabase');PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',new_context),'PT403');
 answer:=public.fountain_cloud_account_directory(ctx,'open',ws,NULL,gen_random_uuid(),'{"expectedBinding":null}');old_binding:=answer->'session'->>'cache_binding';old_private:=public.fountain_cloud_account_directory(ctx,'context',ws,old_binding,NULL,'{}');old_context:=old_context||jsonb_build_object('sessionHash',old_private->'hash','cacheBinding',old_binding);
 -- Existing invalid legacy rows never fall back into the child validator.
 INSERT INTO fountain_cloud.session_vault(workspace_id,hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,version,token_ciphertext,revoked_at_ms,logout_pending)
 VALUES(ws,old_private->>'hash',uid,sid,old_binding,stamp,stamp+604800000,0,cipher,stamp,true);
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context),'PT401');
 DELETE FROM fountain_cloud.session_vault WHERE workspace_id=ws AND hash=old_private->>'hash';
 PERFORM fountain_cloud.store_context(old_context);
 -- A current parent logout denies all children; the unrelated provider SID is
 -- still live, proving that child authority cannot fall back to an Auth UUID.
 PERFORM public.fountain_cloud_account_session_vault('revoke',jsonb_build_object('hash',h,'now',stamp,'expectedVersion',NULL,'leaseId',NULL));
 PERFORM pg_temp.workspace_grant_expect(format('SELECT fountain_cloud.store_context(%L)',old_context),'PT401');
 IF NOT EXISTS(SELECT 1 FROM auth.sessions WHERE id=sid_other) THEN RAISE EXCEPTION 'Account logout revoked a foreign realm SID';END IF;
END $test$;
