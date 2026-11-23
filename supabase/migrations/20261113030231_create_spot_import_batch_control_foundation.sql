-- Tabitsuzuki batch execution control foundation (v1)
-- Preserve all existing job, URL, candidate, and review data.

ALTER TABLE public.regions
  ADD COLUMN allowed_domains text[] NOT NULL DEFAULT '{}'::text[];

UPDATE public.regions
SET allowed_domains = ARRAY['higashiomi.net', 'www.higashiomi.net']::text[]
WHERE slug = 'higashiomi';

ALTER TABLE public.spot_import_jobs
  ADD COLUMN current_stage text NULL,
  ADD COLUMN requested_action text NULL,
  ADD COLUMN requested_at timestamptz NULL,
  ADD COLUMN requested_by uuid NULL,
  ADD COLUMN final_outcome text NULL,
  ADD COLUMN queue_entered_at timestamptz NULL;

ALTER TABLE public.spot_import_jobs
  ADD CONSTRAINT spot_import_jobs_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.spot_import_jobs
  DROP CONSTRAINT spot_import_jobs_status_check;

ALTER TABLE public.spot_import_jobs
  ADD CONSTRAINT spot_import_jobs_status_check
  CHECK (status = ANY (ARRAY['pending','running','paused','completed','failed','cancelled']::text[]));

ALTER TABLE public.spot_import_jobs
  ADD CONSTRAINT spot_import_jobs_current_stage_check
  CHECK (current_stage IS NULL OR current_stage = ANY (ARRAY[
    'url_collection','page_extraction','candidate_analysis','information_merge','human_review'
  ]::text[]));

ALTER TABLE public.spot_import_jobs
  ADD CONSTRAINT spot_import_jobs_requested_action_check
  CHECK (requested_action IS NULL OR requested_action = ANY (ARRAY['start','pause','resume','cancel']::text[]));

ALTER TABLE public.spot_import_urls
  ADD COLUMN processing_execution_id uuid NULL;

ALTER TABLE public.spot_import_urls
  DROP CONSTRAINT spot_import_urls_crawl_status_check;

ALTER TABLE public.spot_import_urls
  ADD CONSTRAINT spot_import_urls_crawl_status_check
  CHECK (crawl_status = ANY (ARRAY['pending','processing','fetched','skipped','failed']::text[]));

CREATE TABLE private.spot_import_system_control (
  id smallint PRIMARY KEY CHECK (id = 1),
  system_enabled boolean NOT NULL DEFAULT true,
  lock_status text NOT NULL DEFAULT 'unlocked'
    CHECK (lock_status = ANY (ARRAY['unlocked','active','anomaly']::text[])),
  locked_job_id uuid NULL REFERENCES public.spot_import_jobs(id) ON DELETE RESTRICT,
  execution_id uuid NULL,
  lock_token uuid NULL,
  lock_acquired_at timestamptz NULL,
  last_heartbeat_at timestamptz NULL,
  lock_expires_at timestamptz NULL,
  anomaly_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spot_import_system_control_lock_consistency_check CHECK (
    (lock_status = 'unlocked'
      AND locked_job_id IS NULL
      AND execution_id IS NULL
      AND lock_token IS NULL
      AND lock_acquired_at IS NULL
      AND last_heartbeat_at IS NULL
      AND lock_expires_at IS NULL
      AND anomaly_reason IS NULL)
    OR
    (lock_status = 'active'
      AND locked_job_id IS NOT NULL
      AND execution_id IS NOT NULL
      AND lock_token IS NOT NULL
      AND lock_acquired_at IS NOT NULL
      AND last_heartbeat_at IS NOT NULL
      AND lock_expires_at IS NOT NULL
      AND anomaly_reason IS NULL)
    OR
    (lock_status = 'anomaly'
      AND locked_job_id IS NOT NULL
      AND execution_id IS NOT NULL
      AND lock_token IS NOT NULL
      AND lock_acquired_at IS NOT NULL
      AND last_heartbeat_at IS NOT NULL
      AND lock_expires_at IS NOT NULL)
  )
);

INSERT INTO private.spot_import_system_control (id, system_enabled, lock_status)
VALUES (1, true, 'unlocked');

CREATE TABLE private.spot_import_execution_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  execution_id uuid NULL,
  job_id uuid NULL,
  region_id uuid NULL,
  stage text NULL,
  event_type text NOT NULL,
  actor_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  message text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.spot_import_system_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.spot_import_execution_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.spot_import_system_control FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.spot_import_execution_logs FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT ALL ON TABLE private.spot_import_system_control TO service_role;
GRANT ALL ON TABLE private.spot_import_execution_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE private.spot_import_execution_logs_id_seq TO service_role;
