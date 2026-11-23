
create or replace function public.prepare_spot_import_job_recovery(
  p_job_id uuid,
  p_confirm_old_worker_stopped boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_inflight_count integer := 0;
  v_retry_count integer := 0;
  v_billing_count integer := 0;
  v_analysis_ready_count integer := 0;
  v_candidate_count integer := 0;
  v_merged_count integer := 0;
begin
  if auth.uid() is null or not private.is_system_admin() then
    raise exception 'system_admin_required';
  end if;

  if p_confirm_old_worker_stopped is distinct from true then
    raise exception 'old_worker_stop_confirmation_required';
  end if;

  if p_job_id is null then
    raise exception 'job_id_required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'recovery_reason_required';
  end if;

  select *
  into v_control
  from private.spot_import_system_control
  where id = 1
  for update;

  if not found
     or v_control.lock_status <> 'anomaly'
     or v_control.locked_job_id is distinct from p_job_id then
    raise exception 'matching_anomaly_lock_required';
  end if;

  select *
  into v_job
  from public.spot_import_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'job_not_found';
  end if;

  if v_job.current_stage <> 'information_merge'
     or v_job.status in ('completed', 'failed', 'cancelled') then
    raise exception 'job_not_in_expected_recovery_state';
  end if;

  select count(*)::integer
  into v_inflight_count
  from public.spot_import_urls
  where job_id = p_job_id
    and processing_execution_id is not null;

  if v_inflight_count > 0 then
    raise exception 'inflight_url_rows_exist';
  end if;

  select count(*)::integer
  into v_retry_count
  from public.spot_import_urls
  where job_id = p_job_id
    and crawl_status = 'fetched'
    and candidate_extraction_status = 'failed'
    and extracted_text is not null
    and length(extracted_text) > 0
    and (
      candidate_extraction_error = 'Signal timed out.'
      or candidate_extraction_error like '%(503)%'
    );

  select count(*)::integer
  into v_billing_count
  from public.spot_import_urls
  where job_id = p_job_id
    and crawl_status = 'fetched'
    and candidate_extraction_status = 'failed'
    and candidate_extraction_error like '%(402)%';

  select count(*)::integer
  into v_analysis_ready_count
  from public.spot_import_urls
  where job_id = p_job_id
    and crawl_status = 'fetched'
    and candidate_extraction_status = 'completed'
    and analysis_status = 'pending';

  select count(*)::integer
  into v_candidate_count
  from public.spot_import_candidates
  where job_id = p_job_id;

  select count(*)::integer
  into v_merged_count
  from public.spot_import_merged_v2
  where job_id = p_job_id;

  update public.spot_import_urls
  set candidate_extraction_status = 'pending',
      candidate_extraction_error = null,
      processing_execution_id = null,
      updated_at = now()
  where job_id = p_job_id
    and crawl_status = 'fetched'
    and candidate_extraction_status = 'failed'
    and extracted_text is not null
    and length(extracted_text) > 0
    and (
      candidate_extraction_error = 'Signal timed out.'
      or candidate_extraction_error like '%(503)%'
    );

  get diagnostics v_retry_count = row_count;

  update public.spot_import_jobs
  set status = 'paused',
      current_stage = 'page_extraction',
      requested_action = null,
      requested_at = null,
      requested_by = null,
      updated_at = now()
  where id = p_job_id;

  insert into private.spot_import_execution_logs (
    job_id,
    execution_id,
    region_id,
    stage,
    event_type,
    actor_id,
    message,
    details
  )
  values (
    p_job_id,
    v_control.execution_id,
    v_job.region_id,
    'page_extraction',
    'anomaly_recovery_prepared',
    auth.uid(),
    left(trim(p_reason), 1000),
    jsonb_build_object(
      'previous_stage', v_job.current_stage,
      'new_stage', 'page_extraction',
      'job_status_after_recovery_preparation', 'paused',
      'retryable_extraction_rows_reset_to_pending', v_retry_count,
      'billing_error_rows_left_failed', v_billing_count,
      'analysis_ready_rows_preserved', v_analysis_ready_count,
      'spot_candidates_preserved', v_candidate_count,
      'merged_rows_preserved', v_merged_count,
      'processing_rows_found_before_recovery', v_inflight_count,
      'automatic_resume', false
    )
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
    'prepared', true,
    'job_id', p_job_id,
    'job_status', 'paused',
    'current_stage', 'page_extraction',
    'retryable_extraction_rows_reset_to_pending', v_retry_count,
    'billing_error_rows_left_failed', v_billing_count,
    'analysis_ready_rows_preserved', v_analysis_ready_count,
    'spot_candidates_preserved', v_candidate_count,
    'merged_rows_preserved', v_merged_count,
    'automatic_resume', false
  );
end;
$function$;

revoke execute on function public.prepare_spot_import_job_recovery(uuid, boolean, text) from public, anon;
grant execute on function public.prepare_spot_import_job_recovery(uuid, boolean, text) to authenticated;
