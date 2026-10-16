-- Server-only storage. Browser/native clients must use Fountain's authenticated
-- API; fountain_app credentials never belong in a public client or Data API JWT.
-- The backend sets fountain.workspace_id with SET LOCAL inside each transaction.
-- This workspace fence complements the application's live member/page ACL checks.

CREATE ROLE fountain_backend
    NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE fountain_app
    LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT fountain_backend TO fountain_app;
GRANT CONNECT ON DATABASE postgres TO fountain_app;
ALTER ROLE fountain_app SET search_path = pg_catalog, fountain_private;

CREATE SCHEMA fountain_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA fountain_private FROM PUBLIC, anon, authenticated, service_role;

-- These defaults are scoped to this private schema and the migration owner.
-- Do not change Supabase's managed public/auth schemas or their global defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA fountain_private
    REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA fountain_private
    REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA fountain_private
    REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

CREATE TABLE fountain_private.entities (
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, kind, id)
);

CREATE TABLE fountain_private.meta (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (workspace_id, key)
);

CREATE TABLE fountain_private.attachment_chunks (
    workspace_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    "offset" BIGINT NOT NULL CHECK ("offset" >= 0),
    data BYTEA NOT NULL,
    PRIMARY KEY (workspace_id, attachment_id, "offset")
);

CREATE TABLE fountain_private.identity_mapping (
    workspace_id TEXT NOT NULL,
    auth_user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, auth_user_id),
    UNIQUE (workspace_id, member_id)
);

-- Store.list(kind) is ordered by creation time and id within one workspace.
CREATE INDEX entities_workspace_kind_created_idx
    ON fountain_private.entities (workspace_id, kind, created_at, id);

-- PresenceService/PostgresStore filter these JSONB fields directly. Epoch expiry
-- is numeric seconds, so text ordering would be incorrect. Avoid a full JSONB GIN
-- index over document bodies, attachments, session digests and other entity kinds.
CREATE INDEX presence_workspace_page_retention_idx
    ON fountain_private.entities
    (workspace_id, (data ->> 'page_id'), ((data ->> 'retain_until')::DOUBLE PRECISION))
    WHERE kind = 'presence';
CREATE INDEX presence_workspace_origin_retention_idx
    ON fountain_private.entities
    (workspace_id, (data ->> 'origin_kind'), (data ->> 'origin_id'),
     ((data ->> 'retain_until')::DOUBLE PRECISION))
    WHERE kind = 'presence';
CREATE INDEX presence_workspace_retention_idx
    ON fountain_private.entities
    (workspace_id, ((data ->> 'retain_until')::DOUBLE PRECISION))
    WHERE kind = 'presence';

-- The workspace-leading mapping PK does not index auth.users' deletion lookup.
CREATE INDEX identity_mapping_auth_user_idx
    ON fountain_private.identity_mapping (auth_user_id);

ALTER TABLE fountain_private.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.entities FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.meta FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.attachment_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.attachment_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.identity_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE fountain_private.identity_mapping FORCE ROW LEVEL SECURITY;

-- Missing workspace context evaluates to NULL and grants no rows. USING protects
-- reads/deletes/old update rows; WITH CHECK also prevents cross-workspace writes.
CREATE POLICY entities_workspace ON fountain_private.entities
    FOR ALL TO fountain_backend
    USING (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)))
    WITH CHECK (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)));
CREATE POLICY meta_workspace ON fountain_private.meta
    FOR ALL TO fountain_backend
    USING (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)))
    WITH CHECK (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)));
CREATE POLICY attachment_chunks_workspace ON fountain_private.attachment_chunks
    FOR ALL TO fountain_backend
    USING (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)))
    WITH CHECK (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)));
CREATE POLICY identity_mapping_workspace ON fountain_private.identity_mapping
    FOR ALL TO fountain_backend
    USING (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)))
    WITH CHECK (workspace_id = (SELECT pg_catalog.current_setting('fountain.workspace_id', true)));

-- No direct client-role grants, schema creation, TRUNCATE, REFERENCES, TRIGGER,
-- grant options, ownership, or elevated role attributes for the application.
REVOKE ALL ON ALL TABLES IN SCHEMA fountain_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA fountain_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fountain_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA fountain_private TO fountain_backend;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON fountain_private.entities, fountain_private.meta,
       fountain_private.attachment_chunks, fountain_private.identity_mapping
    TO fountain_backend;

-- No functions or SECURITY DEFINER routines are created here. PostgreSQL's global
-- default PUBLIC function EXECUTE cannot be revoked by an IN SCHEMA default rule.
-- Every future function migration must explicitly REVOKE PUBLIC EXECUTE on that
-- function before granting narrowly selected callers, keeping this schema private.
-- No publication or PostgREST exposed-schema configuration is changed here.
