-- The public store_commit wrapper is SECURITY INVOKER. Preserve its existing
-- service-only call chain after replacing the inner implementation.
-- Caller context and live Auth/session validation remain inside store_commit.
GRANT EXECUTE ON FUNCTION fountain_cloud.store_commit(jsonb,bigint,uuid,text,text,jsonb) TO service_role;
