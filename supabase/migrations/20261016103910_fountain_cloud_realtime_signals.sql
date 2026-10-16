-- Private, body-free invalidation ledger; never publish entities/meta themselves.
-- Protocol reference: https://supabase.com/docs/guides/realtime/protocol
CREATE TABLE fountain_cloud.workspace_signals (
 workspace_id text PRIMARY KEY,
 revision bigint NOT NULL CHECK (revision>=0 AND revision<=9007199254740991)
);
ALTER TABLE fountain_cloud.workspace_signals OWNER TO postgres;
ALTER TABLE fountain_cloud.workspace_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_cloud.workspace_signals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE fountain_cloud.workspace_signals FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE fountain_cloud.workspace_signals TO service_role;
CREATE POLICY workspace_signals_server_read ON fountain_cloud.workspace_signals
 FOR SELECT TO service_role USING (true);

-- Trigger has no arguments/public RPC. The existing authorized workspace writer
-- changes only its own revision; trigger owner writes the two scalar signal fields.
CREATE FUNCTION fountain_private.emit_workspace_signal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE next_revision bigint;
BEGIN
 IF TG_TABLE_SCHEMA<>'fountain_private' OR TG_TABLE_NAME<>'meta' OR NEW.key<>'_entity_revision' THEN
  RAISE EXCEPTION 'Invalid revision trigger context' USING ERRCODE='22023';
 END IF;
 IF TG_OP='UPDATE' AND NEW.workspace_id=OLD.workspace_id AND NEW.key=OLD.key AND NEW.data=OLD.data THEN RETURN NEW; END IF;
 IF jsonb_typeof(NEW.data)<>'number' OR (NEW.data#>>'{}') !~ '^[0-9]{1,16}$' THEN
  RAISE EXCEPTION 'Invalid workspace revision' USING ERRCODE='22023';
 END IF;
 next_revision:=(NEW.data#>>'{}')::bigint;
 IF next_revision>9007199254740991 THEN RAISE EXCEPTION 'Invalid workspace revision' USING ERRCODE='22023'; END IF;
 INSERT INTO fountain_cloud.workspace_signals AS current(workspace_id,revision) VALUES(NEW.workspace_id,next_revision)
 ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision WHERE current.revision<EXCLUDED.revision;
 RETURN NEW;
END $$;
ALTER FUNCTION fountain_private.emit_workspace_signal() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.emit_workspace_signal() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fountain_revision_signal AFTER INSERT OR UPDATE OF key,data ON fountain_private.meta
 FOR EACH ROW WHEN (NEW.key='_entity_revision') EXECUTE FUNCTION fountain_private.emit_workspace_signal();
-- Validate then seed scalar revisions only; originals are never edited.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM fountain_private.meta WHERE key='_entity_revision' AND
  CASE WHEN jsonb_typeof(data)='number' AND (data#>>'{}') ~ '^[0-9]{1,16}$'
   THEN (data#>>'{}')::numeric>9007199254740991 ELSE true END) THEN
  RAISE EXCEPTION 'Invalid initial workspace revision' USING ERRCODE='22023';
 END IF;
END $$;
INSERT INTO fountain_cloud.workspace_signals(workspace_id,revision)
 SELECT workspace_id,(data#>>'{}')::bigint FROM fountain_private.meta WHERE key='_entity_revision';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime' AND NOT puballtables) THEN
  RAISE EXCEPTION 'A reviewed narrow Realtime publication is required';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='fountain_cloud' AND tablename='workspace_signals') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE fountain_cloud.workspace_signals;
 END IF;
END $$;
