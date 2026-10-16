-- Preserve fresh Read Committed pin reads after waiting for workspace ownership.
-- No data, privileges, ID retirement or registration changes.
CREATE OR REPLACE FUNCTION fountain_cloud.storage_gc_pinned(p_workspace_id text,p_storage_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR NOT fountain_cloud.storage_gc_id(p_storage_id) THEN RAISE EXCEPTION 'Invalid Storage identity' USING ERRCODE='PT409';END IF;
 -- Never expand a chunk array here. Consistent IDs are validated on writes.
 RETURN EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='upload' AND e.id=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='attachment' AND e.data ? 'cloud_chunks' AND COALESCE(e.data->>'storage_id',e.id)=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=p_workspace_id AND e.kind='attachment_cloud' AND COALESCE(e.data->>'storage_id',e.id)=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=p_workspace_id AND s.extra ? 'cloud_chunks' AND COALESCE(s.extra->>'storage_id',s.extra->>'id',s.descriptor->>'id')=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_source s WHERE s.workspace_id=p_workspace_id AND s.cloud IS NOT NULL AND s.cloud->>'attachmentId'=p_storage_id)
  OR EXISTS(SELECT 1 FROM fountain_cloud.backup_job_parts p WHERE p.workspace_id=p_workspace_id AND p.state IN('pending','published') AND p.manifest->>'attachmentId'=p_storage_id);
END $$;
CREATE OR REPLACE FUNCTION fountain_cloud.storage_gc_delete_allowed(p_workspace_id text,p_storage_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
#variable_conflict error
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'Storage requires read committed isolation' USING ERRCODE='PT409';END IF;
 IF p_workspace_id IS NULL OR length(p_workspace_id) NOT BETWEEN 1 AND 160 OR NOT fountain_cloud.storage_gc_id(p_storage_id) THEN RAISE EXCEPTION 'Invalid Storage identity' USING ERRCODE='PT409';END IF;
 RETURN EXISTS(SELECT 1 FROM fountain_cloud.storage_gc_tombstones t WHERE t.workspace_id=p_workspace_id AND t.storage_id=p_storage_id)
  AND NOT fountain_cloud.storage_gc_pinned(p_workspace_id,p_storage_id);
END $$;
