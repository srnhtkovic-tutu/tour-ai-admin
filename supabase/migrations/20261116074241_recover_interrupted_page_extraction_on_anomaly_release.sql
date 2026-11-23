create or replace function public.release_spot_import_anomaly_lock(
  p_confirm_old_worker_stopped boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_status_after text;
  v_reset_count integer := 0;
begin
  if auth.uid() is null or not private.is_system_admin() then
    raise exception 'system_admin_required';
  end if;

  if p_confirm_old_worker_stopped is distinct from true then
    raise exception 'old_worker_stop_confirmation_required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'release_reason_required';
  end if;

  select * into v_control
  from private.spot_import_system_control
  where id = 1
  for update;

  if not found or v_control.lock_status <> 'anomaly' then
    raise exception 'no_anomaly_lock';
  end if;

  select * into v_job
  from public.spot_import_jobs
  where id = v_control.locked_job_id
  for update;

  if not found then
    raise exception 'locked_job_not_found';
  end if;

  -- Recover only URL rows still owned by the exact execution being released.
  -- Successfully committed rows have already cleared processing_execution_id
  -- and therefore remain untouched.
  if v_job.current_stage = 'page_extraction' and v_control.execution_id is not null then
    update public.spot_import_urls
    set candidate_extraction_status = 'pending',
        candidate_extraction_error = null,
        processing_execution_id = null,
        updated_at = now()
    where job_id = v_job.id
      and candidate_extraction_status = 'processing'
      and processing_execution_id = v_control.execution_id;

    get diagnostics v_reset_count = row_count;
  end if;

  if v_job.status not in ('completed', 'failed', 'cancelled') then
    update public.spot_import_jobs
    set status = 'paused',
        requested_action = null,
        requested_at = null,
        requested_by = null,
        updated_at = now()
    where id = v_job.id;
    v_status_after := 'paused';
  else
    v_status_after := v_job.status;
  end if;

  insert into private.spot_import_execution_logs (
    job_id, execution_id, region_id, stage,
    event_type, actor_id, message, details
  )
  values (
    v_control.locked_job_id, v_control.execution_id,
    v_job.region_id, v_job.current_stage,
    'anomaly_lock_released', auth.uid(), left(trim(p_reason), 1000),
    jsonb_build_object(
      'previous_anomaly_reason', v_control.anomaly_reason,
      'job_status_after_release', v_status_after,
      'processing_data_reset', false,
      'interrupted_urls_reset_to_pending', v_reset_count
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
    'released', true,
    'job_id', v_job.id,
    'job_status', v_status_after,
    'processing_data_reset', false,
    'interrupted_urls_reset_to_pending', v_reset_count
  );
end;
$function$;