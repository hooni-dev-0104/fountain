-- Cover the scheduler job/source foreign key for source fencing and cleanup.
-- This changes lookup cost only; no workspace, job or authority is created.
CREATE INDEX scheduler_jobs_source ON fountain_cloud.scheduler_jobs(workspace_id,automation_id);
