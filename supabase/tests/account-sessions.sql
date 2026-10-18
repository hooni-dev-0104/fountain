-- Run in a rollback transaction. Synthetic Auth rows exercise real SQL joins;
-- they do not stand in for a GoTrue password login or native-client proof.
CREATE OR REPLACE FUNCTION pg_temp.account_session_expect(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $t$
DECLARE actual text;
BEGIN BEGIN EXECUTE statement;EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE;END;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Expected %, received % for %',expected,COALESCE(actual,'success'),left(statement,100);END IF;
END $t$;
DO $test$
DECLARE uid uuid:=gen_random_uuid();sid uuid:=gen_random_uuid();uid2 uuid:=gen_random_uuid();sid2 uuid:=gen_random_uuid();uid3 uuid:=gen_random_uuid();sid3 uuid:=gen_random_uuid();
 h text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');h2 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');h3 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');binding text:=repeat('e',32);
 stamp bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;cipher jsonb:='{"version":1,"keyId":"qa","iv":"AAAAAAAAAAAAAAAA","data":"AAAAAAAAAAAAAAAAAAAAAA"}';
 value jsonb;row jsonb;ctx jsonb;answer jsonb;lease text:='AAAAAAAAAAAAAAAA';rel record;
BEGIN
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous)
 VALUES(uid,'authenticated','authenticated','qa-org-session-'||uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false),
 (uid2,'authenticated','authenticated','qa-org-session-'||uid2||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false),
 (uid3,'authenticated','authenticated','qa-org-session-'||uid3||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp(),false);
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after) VALUES(sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),(sid2,uid2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour'),(sid3,uid3,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 answer:=public.fountain_cloud_account_session_vault('profile',jsonb_build_object('userId',uid,'authSessionId',sid));
 IF answer->'authSessionActive' IS DISTINCT FROM 'true'::jsonb OR answer->'user'->>'id' IS DISTINCT FROM uid::text OR answer-ARRAY['authSessionActive','user']<>'{}'::jsonb OR(answer->'user')-ARRAY['id','name','email']<>'{}'::jsonb THEN RAISE EXCEPTION 'Identity profile is not exact';END IF;
 IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping WHERE auth_user_id=uid) THEN RAISE EXCEPTION 'Account profile enrolled workspace identity';END IF;
 IF public.fountain_cloud_account_session_vault('profile',jsonb_build_object('userId',uid,'authSessionId',sid2)) IS NOT NULL THEN RAISE EXCEPTION 'Cross-user profile accepted';END IF;
 value:=jsonb_build_object('hash',h,'userId',uid,'authSessionId',sid,'cacheBinding',binding,'createdAt',stamp,'expiresAt',stamp+604800000,'version',0,'tokens',cipher,'revokedAt',NULL,'logoutPending',false);
 PERFORM public.fountain_cloud_account_session_vault('create',jsonb_build_object('row',value));
 row:=public.fountain_cloud_account_session_vault('read',jsonb_build_object('hash',h));
 IF row IS DISTINCT FROM value THEN RAISE EXCEPTION 'Vault DTO changed';END IF;
 ctx:=jsonb_build_object('sessionHash',h,'cacheBinding',binding,'userId',uid,'authSessionId',sid);
 IF fountain_private.account_session_context(ctx) IS DISTINCT FROM uid THEN RAISE EXCEPTION 'Live context rejected';END IF;
 PERFORM pg_temp.account_session_expect(format('SELECT fountain_private.account_session_context(%L::jsonb)',ctx||'{"role":"owner"}'),'22023');
 PERFORM pg_temp.account_session_expect(format('SELECT fountain_private.account_session_context(%L::jsonb)',ctx||jsonb_build_object('cacheBinding',repeat('d',32))),'PT401');
 PERFORM pg_temp.account_session_expect(format('SELECT public.fountain_cloud_account_session_vault(''create'',%L::jsonb)',jsonb_build_object('row',value||'{"version":1}')),'22023');
 PERFORM pg_temp.account_session_expect('SELECT public.fountain_cloud_account_session_vault(''sweep'',''{"limit":9007199254740991}'')','22023');
 PERFORM pg_temp.account_session_expect('SELECT public.fountain_cloud_account_session_vault(''read'',''{"hash":null}'')','22023');
 answer:=public.fountain_cloud_account_session_vault('claim_refresh',jsonb_build_object('hash',h,'expectedVersion',0,'leaseId',lease,'now',stamp,'until',stamp+30000));
 IF answer IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Refresh lease not claimed';END IF;
 IF public.fountain_cloud_account_session_vault('claim_refresh',jsonb_build_object('hash',h,'expectedVersion',0,'leaseId',repeat('B',16),'now',stamp,'until',stamp+30000)) IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Refresh token was claimed twice';END IF;
 PERFORM public.fountain_cloud_account_session_vault('release_refresh',jsonb_build_object('hash',h,'leaseId',repeat('B',16)));
 IF(SELECT refresh_lease_id FROM fountain_private.account_session_vault WHERE hash=h) IS DISTINCT FROM lease THEN RAISE EXCEPTION 'Foreign release cleared lease';END IF;
 PERFORM public.fountain_cloud_account_session_vault('release_refresh',jsonb_build_object('hash',h,'leaseId',lease));
 IF public.fountain_cloud_account_session_vault('claim_refresh',jsonb_build_object('hash',h,'expectedVersion',0,'leaseId',lease,'now',stamp,'until',stamp+30000)) IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Known unused lease not released';END IF;
 IF public.fountain_cloud_account_session_vault('finish_refresh',jsonb_build_object('hash',h,'expectedVersion',0,'leaseId',lease,'tokens',cipher||'{"keyId":"next"}')) IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Refresh completion failed';END IF;
 IF public.fountain_cloud_account_session_vault('finish_refresh',jsonb_build_object('hash',h,'expectedVersion',0,'leaseId',lease,'tokens',cipher)) IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Unknown ACK replay overwrote rotated token';END IF;
 row:=public.fountain_cloud_account_session_vault('read',jsonb_build_object('hash',h));
 IF row->'version'<>'1'::jsonb OR row->'tokens'->>'keyId'<>'next' THEN RAISE EXCEPTION 'Unknown refresh ACK not recognizable';END IF;
 -- Local revoke is authoritative even while the provider session remains live.
 row:=public.fountain_cloud_account_session_vault('revoke',jsonb_build_object('hash',h,'now',stamp,'expectedVersion',NULL,'leaseId',NULL));
 IF row->'logoutPending' IS DISTINCT FROM 'true'::jsonb OR row->'tokens' IS NULL OR row->'tokens'='null'::jsonb THEN RAISE EXCEPTION 'Revoke lost retry-only ciphertext';END IF;
 PERFORM pg_temp.account_session_expect(format('SELECT fountain_private.account_session_context(%L::jsonb)',ctx),'PT401');
 IF public.fountain_cloud_account_session_vault('finish_logout',jsonb_build_object('hash',h,'expectedVersion',2)) IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Logout falsely succeeded while provider session remained';END IF;
 DELETE FROM auth.sessions WHERE id=sid;
 IF public.fountain_cloud_account_session_vault('finish_logout',jsonb_build_object('hash',h,'expectedVersion',2)) IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Authoritative logout not acknowledged';END IF;
 row:=public.fountain_cloud_account_session_vault('read',jsonb_build_object('hash',h));
 IF row->'tokens'<>'null'::jsonb OR row->'logoutPending'<>'false'::jsonb THEN RAISE EXCEPTION 'Logout ciphertext survived';END IF;
 -- An abandoned one-use lease is revoked, never recycled.
 value:=value||jsonb_build_object('hash',h2,'userId',uid2,'authSessionId',sid2);
 PERFORM public.fountain_cloud_account_session_vault('create',jsonb_build_object('row',value));
 PERFORM public.fountain_cloud_account_session_vault('claim_refresh',jsonb_build_object('hash',h2,'expectedVersion',0,'leaseId',lease,'now',stamp,'until',stamp+30000));
 UPDATE fountain_private.account_session_vault SET refresh_lease_until_ms=stamp-1 WHERE hash=h2;
 IF public.fountain_cloud_account_session_vault('claim_refresh',jsonb_build_object('hash',h2,'expectedVersion',0,'leaseId',repeat('B',16),'now',stamp,'until',stamp+30000)) IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Abandoned lease recycled';END IF;
 IF(SELECT revoked_at_ms IS NULL OR NOT logout_pending FROM fountain_private.account_session_vault WHERE hash=h2) THEN RAISE EXCEPTION 'Abandoned lease not revoked';END IF;
 -- Seven-day local expiry revokes admission, while a still-live provider
 -- session keeps retry-only cipher. This older expired/revoked row must not
 -- monopolize a bounded orphan scan on every run.
 value:=value||jsonb_build_object('hash',h3,'userId',uid3,'authSessionId',sid3);
 PERFORM public.fountain_cloud_account_session_vault('create',jsonb_build_object('row',value));
 UPDATE fountain_private.account_session_vault SET created_at_ms=ms_shift.created_at,expires_at_ms=ms_shift.created_at+604800000
 FROM(SELECT stamp-604800001 created_at) ms_shift WHERE hash=h3;
 row:=public.fountain_cloud_account_session_vault('read',jsonb_build_object('hash',h3));
 IF row->'revokedAt'='null'::jsonb OR row->'logoutPending'<>'true'::jsonb OR row->'tokens'='null'::jsonb THEN RAISE EXCEPTION 'Local expiry did not preserve retry-only cipher';END IF;
 PERFORM pg_temp.account_session_expect(format('SELECT fountain_private.account_session_context(%L::jsonb)',jsonb_build_object('sessionHash',h3,'cacheBinding',binding,'userId',uid3,'authSessionId',sid3)),'PT401');
 IF public.fountain_cloud_account_session_vault('finish_logout',jsonb_build_object('hash',h3,'expectedVersion',1)) IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Local TTL pretended provider logout succeeded';END IF;
 DELETE FROM auth.users WHERE id=uid2;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.account_session_vault WHERE hash=h2) THEN RAISE EXCEPTION 'Auth deletion cascaded account history';END IF;
 answer:=public.fountain_cloud_account_session_vault('sweep','{"limit":1}');
 IF answer->'pruned'<>'1'::jsonb THEN RAISE EXCEPTION 'Expired retry-only row starved bounded orphan cleanup';END IF;
 IF(SELECT token_ciphertext IS NOT NULL OR logout_pending FROM fountain_private.account_session_vault WHERE hash=h2) THEN RAISE EXCEPTION 'Orphan-prune failed';END IF;
 IF(SELECT token_ciphertext IS NULL OR NOT logout_pending FROM fountain_private.account_session_vault WHERE hash=h3) THEN RAISE EXCEPTION 'Orphan cleanup erased a live provider retry token';END IF;
 IF NOT(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='fountain_private.account_session_vault'::regclass) THEN RAISE EXCEPTION 'Vault RLS not forced';END IF;
 IF has_table_privilege('service_role','fountain_private.account_session_vault','SELECT') OR has_table_privilege('fountain_backend','fountain_private.account_session_vault','UPDATE') OR has_function_privilege('authenticated','public.fountain_cloud_account_session_vault(text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Vault privilege leaked';END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='fountain_private.account_session_vault'::regclass AND contype='f') THEN RAISE EXCEPTION 'Vault has an Auth FK';END IF;
END $test$;
