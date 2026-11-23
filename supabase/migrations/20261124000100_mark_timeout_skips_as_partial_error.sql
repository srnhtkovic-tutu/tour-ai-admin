-- 施設単位のEdge Functionタイムアウトによるスキップを、ジョブの部分エラーとして記録する。
-- no_related_pages など、通常の対象外スキップは部分エラーに含めない。

CREATE OR REPLACE FUNCTION public.finish_spot_import_execution(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_next_stage text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_new_status text;
  v_new_stage text;
  v_outcome text;
  v_has_facility_errors boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  select * into v_control
  from private.spot_import_system_control
  where id = 1
  for update;

  if v_control.lock_status <> 'active'
     or v_control.locked_job_id <> p_job_id
     or v_control.execution_id <> p_execution_id
     or v_control.lock_token <> p_lock_token
     or v_control.lock_expires_at <= now() then
    raise exception 'execution_lock_mismatch_or_expired';
  end if;

  select * into v_job
  from public.spot_import_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'job_not_found';
  end if;

  if p_next_stage is not null and p_next_stage not in
    ('url_collection','page_extraction','candidate_analysis','information_merge') then
    raise exception 'invalid_next_stage';
  end if;

  if v_job.requested_action = 'pause' then
    v_new_status := 'paused';
    v_new_stage := v_job.current_stage;
    v_outcome := null;
  elsif v_job.requested_action = 'cancel' then
    v_new_status := 'cancelled';
    v_new_stage := v_job.current_stage;
    v_outcome := 'cancelled';
  elsif not v_control.system_enabled then
    v_new_status := 'pending';
    v_new_stage := v_job.current_stage;
    v_outcome := null;
  elsif p_next_stage is null then
    select exists (
      select 1
      from public.spot_import_merged_v2 m
      where m.job_id = p_job_id
        and (
          m.status = 'failed'
          or m.relevance_status = 'failed'
          or m.relevance_progress->>'skip_reason' = 'edge_function_timeout'
        )
    ) into v_has_facility_errors;

    v_new_status := 'completed';
    v_new_stage := 'human_review';
    v_outcome := case when v_has_facility_errors then 'partial_error' else 'normal_completed' end;
  else
    v_new_status := 'running';
    v_new_stage := p_next_stage;
    v_outcome := null;
  end if;

  update public.spot_import_jobs
  set status = v_new_status,
      current_stage = v_new_stage,
      final_outcome = v_outcome,
      requested_action = null,
      requested_at = null,
      requested_by = null,
      updated_at = now()
  where id = p_job_id;

  perform private.write_spot_import_execution_log(
    'worker_completed',
    p_job_id,
    p_execution_id,
    v_job.region_id,
    v_job.current_stage,
    '処理単位を終了',
    jsonb_build_object('result_status', v_new_status, 'next_stage', v_new_stage, 'final_outcome', v_outcome)
  );

  update private.spot_import_system_control
  set lock_status = 'unlocked',
      locked_job_id = null,
      execution_id = null,
      lock_token = null,
      lock_acquired_at = null,
      last_heartbeat_at = null,
      lock_expires_at = null,
      anomaly_reason = null,
      updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'status', v_new_status,
    'current_stage', v_new_stage,
    'final_outcome', v_outcome
  );
end;
$function$;
