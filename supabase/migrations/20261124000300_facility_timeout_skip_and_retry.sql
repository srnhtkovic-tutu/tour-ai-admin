-- 情報統合の既知タイムアウトを施設単位で記録し、管理者が施設単位で最初から再実行できるようにする。
-- 既存の施設データ・人による審査結果は、タイムアウト再実行の対象外として保持する。

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
          or m.relevance_progress->>'skip_reason' in (
            'edge_function_timeout',
            'information_merge_timeout'
          )
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

CREATE OR REPLACE FUNCTION public.admin_retry_spot_import_facility(
  p_candidate_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_candidate public.spot_import_merged_v2%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_control private.spot_import_system_control%rowtype;
  v_progress jsonb;
  v_retry_kind text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;
  if not private.is_system_admin() then
    raise exception 'system_admin_required';
  end if;

  select * into v_control
  from private.spot_import_system_control
  where id = 1
  for update;

  if not found or v_control.lock_status <> 'unlocked' then
    raise exception 'system_execution_not_idle';
  end if;

  select * into v_candidate
  from public.spot_import_merged_v2
  where id = p_candidate_id
  for update;

  if not found then
    raise exception 'facility_candidate_not_found';
  end if;

  select * into v_job
  from public.spot_import_jobs
  where id = v_candidate.job_id
  for update;

  if not found then
    raise exception 'import_job_not_found';
  end if;

  if v_job.pipeline_version <> 'redesign_v1' then
    raise exception 'facility_retry_requires_redesign_v1';
  end if;

  if v_candidate.review_status <> 'pending'
     or v_candidate.reviewed_data is not null
     or v_candidate.approved_spot_id is not null then
    raise exception 'reviewed_facility_cannot_be_retried';
  end if;

  v_progress := coalesce(v_candidate.relevance_progress, '{}'::jsonb);

  if v_candidate.status = 'skipped'
     and v_candidate.relevance_status = 'skipped'
     and v_progress->>'skip_reason' in ('edge_function_timeout', 'information_merge_timeout') then
    if v_job.status <> 'completed'
       or v_job.current_stage <> 'human_review'
       or v_job.final_outcome <> 'partial_error' then
      raise exception 'timeout_retry_requires_completed_partial_error_job';
    end if;

    v_retry_kind := 'timeout_full_restart';
    update public.spot_import_merged_v2
    set status = 'pending',
        relevance_status = 'pending',
        relevance_results = '[]'::jsonb,
        relevance_progress = null,
        merged_data = null,
        source_count = 0,
        input_char_count = 0,
        source_candidate_ids = '{}'::uuid[],
        source_url_ids = '{}'::uuid[],
        sources = '[]'::jsonb,
        model = null,
        relevance_model = null,
        error_message = null,
        updated_at = now()
    where id = p_candidate_id;

  elsif v_candidate.relevance_status = 'failed'
     or v_progress->>'status' = 'failed' then
    v_retry_kind := 'relevance';
    v_progress := (v_progress - 'last_error' - 'last_error_at')
      || jsonb_build_object(
        'status', 'in_progress',
        'batch_attempts', 0,
        'updated_at', now()
      );
    update public.spot_import_merged_v2
    set status = 'pending',
        relevance_status = 'in_progress',
        relevance_progress = v_progress,
        error_message = null,
        updated_at = now()
    where id = p_candidate_id;

  elsif v_candidate.status = 'failed'
        and v_progress->>'merge_status' = 'failed' then
    v_retry_kind := 'merge';
    v_progress := (v_progress - 'merge_error' - 'merge_error_at')
      || jsonb_build_object(
        'status', 'completed',
        'merge_status', 'retry_pending',
        'merge_attempts', 0,
        'updated_at', now()
      );
    update public.spot_import_merged_v2
    set status = 'pending',
        relevance_status = 'completed',
        relevance_progress = v_progress,
        error_message = null,
        updated_at = now()
    where id = p_candidate_id;
  else
    raise exception 'facility_is_not_in_retryable_error_state';
  end if;

  if v_job.status = 'running' then
    if v_job.current_stage <> 'information_merge' then
      raise exception 'job_not_ready_for_facility_retry';
    end if;
  elsif v_job.status = 'completed' then
    if v_job.current_stage <> 'human_review'
       or v_job.final_outcome <> 'partial_error' then
      raise exception 'job_has_no_partial_errors';
    end if;

    update public.spot_import_jobs
    set status = 'pending',
        current_stage = 'information_merge',
        final_outcome = null,
        requested_action = null,
        requested_at = null,
        requested_by = null,
        queue_entered_at = now(),
        updated_at = now()
    where id = v_job.id;
  else
    raise exception 'job_not_ready_for_facility_retry';
  end if;

  insert into private.spot_import_execution_logs (
    job_id, region_id, stage, event_type, actor_id, message, details
  )
  values (
    v_job.id, v_job.region_id, 'information_merge',
    'facility_retry_requested', auth.uid(),
    'システム管理者が施設単位の再実行を指示',
    jsonb_build_object(
      'candidate_id', p_candidate_id,
      'spot_name', v_candidate.spot_name,
      'retry_kind', v_retry_kind
    )
  );

  return jsonb_build_object(
    'candidate_id', p_candidate_id,
    'spot_name', v_candidate.spot_name,
    'retry_kind', v_retry_kind,
    'job_status', case when v_job.status = 'completed' then 'pending' else v_job.status end
  );
end;
$function$;

revoke all on function public.admin_retry_spot_import_facility(uuid) from public;
revoke all on function public.admin_retry_spot_import_facility(uuid) from anon;
grant execute on function public.admin_retry_spot_import_facility(uuid) to authenticated;
