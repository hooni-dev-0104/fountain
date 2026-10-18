-- Local account expiry is checked on every request. A bounded owner-only job
-- also clears orphan token ciphertext after Auth deletion without a visit.
-- Live-provider logout failures keep retry-only ciphertext for maintenance.
DO $cleanup$
DECLARE existing cron.job;command_text constant text := 'SET statement_timeout = ''15s''; SELECT fountain_private.account_session_prune(128);';
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'Account cleanup requires migration owner';END IF;
 IF to_regprocedure('fountain_private.account_session_prune(integer)') IS NULL THEN RAISE EXCEPTION 'Account sessions must be installed first';END IF;
 SELECT * INTO existing FROM cron.job WHERE jobname='fountain-account-session-prune';
 IF FOUND THEN
  IF existing.username<>'postgres' OR existing.database<>current_database() OR existing.schedule<>'23 * * * *'
   OR existing.command<>command_text OR NOT existing.active THEN RAISE EXCEPTION 'Account cleanup job differs';END IF;
 ELSE
  PERFORM cron.schedule('fountain-account-session-prune','23 * * * *',command_text);
 END IF;
END $cleanup$;
