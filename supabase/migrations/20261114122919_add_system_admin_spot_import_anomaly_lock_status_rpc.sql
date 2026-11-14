create or replace function public.get_spot_import_anomaly_lock()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_job_found boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if not private.is_system_admin() then
    raise exception 'system_admin_required';
  end if;

  select *
  into v_control
  from private.spot_import_system_control
  where id = 1;

  if not found then
    raise exception 'system_control_not_found';
  end if;

  if v_control.locked_job_id is not null then
    select *
    into v_job
    from public.spot_import_jobs
    where id = v_control.locked_job_id;
    v_job_found := found;
  end if;

  return pg_catalog.jsonb_build_object(
    'system_enabled', v_control.system_enabled,
    'lock_status', v_control.lock_status,
    'locked_job_id', v_control.locked_job_id,
    'execution_id', v_control.execution_id,
    'lock_acquired_at', v_control.lock_acquired_at,
    'last_heartbeat_at', v_control.last_heartbeat_at,
    'lock_expires_at', v_control.lock_expires_at,
    'anomaly_reason', v_control.anomaly_reason,
    'job',
      case when v_job_found then
        pg_catalog.jsonb_build_object(
          'id', v_job.id,
          'region_id', v_job.region_id,
          'source_url', v_job.source_url,
          'status', v_job.status,
          'current_stage', v_job.current_stage
        )
      else null end
  );
end;
$function$;

revoke all on function public.get_spot_import_anomaly_lock() from public;
revoke all on function public.get_spot_import_anomaly_lock() from anon;
grant execute on function public.get_spot_import_anomaly_lock() to authenticated;
