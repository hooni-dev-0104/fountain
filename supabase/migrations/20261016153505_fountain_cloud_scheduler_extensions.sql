-- Enable existing Supabase scheduling/delivery facilities only.
-- No workspace, Cron job, network request, grant or ticket is created here.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH VERSION '1.6.4';
CREATE EXTENSION IF NOT EXISTS pg_net WITH VERSION '0.20.4';
