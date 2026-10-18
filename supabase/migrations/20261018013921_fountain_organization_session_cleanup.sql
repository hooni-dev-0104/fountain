-- Local opaque expiry is enforced on every access. This bounded SQL job also
-- removes orphan ciphertext after authoritative Auth deletion without a visit.
-- Live-provider logout failures retain retry-only ciphertext for the separate
-- server maintenance path; this job never calls Auth or reads workspace data.
DO $cleanup$
DECLARE existing cron.job;command_text constant text := 'SET statement_timeout = ''15s''; SELECT fountain_private.organization_session_prune(128);';
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'Organization cleanup requires migration owner';END IF;
 IF to_regprocedure('fountain_private.organization_session_prune(integer)') IS NULL THEN RAISE EXCEPTION 'Organization sessions must be installed first';END IF;
 SELECT * INTO existing FROM cron.job WHERE jobname='fountain-organization-session-prune';
 IF FOUND THEN
  IF existing.username<>'postgres' OR existing.database<>current_database() OR existing.schedule<>'17 * * * *'
   OR existing.command<>command_text OR NOT existing.active THEN RAISE EXCEPTION 'Organization cleanup job differs';END IF;
 ELSE
  PERFORM cron.schedule('fountain-organization-session-prune','17 * * * *',command_text);
 END IF;
END $cleanup$;
