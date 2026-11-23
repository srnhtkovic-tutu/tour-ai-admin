
create or replace function private.write_spot_import_execution_log(
  p_event_type text,
  p_job_id uuid default null,
  p_execution_id uuid default null,
  p_region_id uuid default null,
  p_stage text default null,
  p_message text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.spot_import_execution_logs
    (event_type, job_id, execution_id, region_id, stage, message, details)
  values
    (p_event_type, p_job_id, p_execution_id, p_region_id,
     p_stage, p_message, coalesce(p_details, '{}'::jsonb));
end;
$$;

create or replace function public.claim_spot_import_execution(
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_execution_id uuid;
  v_lock_token uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'invalid_lease_seconds';
  end if;

  select * into v_control
  from private.spot_import_system_control
  where id = 1
  for update;

  if not found or not v_control.system_enabled then
    return null;
  end if;

  if v_control.lock_status = 'anomaly' then
    return null;
  end if;

  if v_control.lock_status = 'active' then
    if v_control.lock_expires_at > now() then
      return null;
    end if;

    update private.spot_import_system_control
    set lock_status = 'anomaly',
        anomaly_reason = 'lease_expired',
        updated_at = now()
    where id = 1;

    perform private.write_spot_import_execution_log(
      'anomaly_detected',
      v_control.locked_job_id,
      v_control.execution_id,
      null,
      null,
      '実行リース期限切れを検出。ロックを保持して異常停止',
      jsonb_build_object('reason', 'lease_expired')
    );
    return jsonb_build_object('status', 'anomaly');
  end if;

  select j.* into v_job
  from public.spot_import_jobs j
  join public.regions r on r.id = j.region_id
  where j.status in ('pending', 'running')
    and j.current_stage is not null
    and j.current_stage <> 'human_review'
    and (j.requested_action is null or j.requested_action = 'start')
    and r.is_active = true
  order by j.queue_entered_at asc nulls last, j.id asc
  limit 1
  for update of j skip locked;

  if not found then
    return null;
  end if;

  v_execution_id := gen_random_uuid();
  v_lock_token := gen_random_uuid();

  update private.spot_import_system_control
  set lock_status = 'active',
      locked_job_id = v_job.id,
      execution_id = v_execution_id,
      lock_token = v_lock_token,
      lock_acquired_at = now(),
      last_heartbeat_at = now(),
      lock_expires_at = now() + make_interval(secs => p_lease_seconds),
      anomaly_reason = null,
      updated_at = now()
  where id = 1;

  update public.spot_import_jobs
  set status = 'running',
      requested_action = null,
      requested_at = null,
      requested_by = null,
      updated_at = now()
  where id = v_job.id;

  perform private.write_spot_import_execution_log(
    'execution_claimed',
    v_job.id,
    v_execution_id,
    v_job.region_id,
    v_job.current_stage,
    '実行権を取得',
    '{}'::jsonb
  );

  return jsonb_build_object(
    'job_id', v_job.id,
    'stage', v_job.current_stage,
    'execution_id', v_execution_id,
    'lock_token', v_lock_token,
    'lease_expires_at', now() + make_interval(secs => p_lease_seconds)
  );
end;
$$;

create or replace function public.heartbeat_spot_import_execution(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_lease_seconds integer
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'invalid_lease_seconds';
  end if;

  update private.spot_import_system_control
  set last_heartbeat_at = now(),
      lock_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = 1
    and lock_status = 'active'
    and locked_job_id = p_job_id
    and execution_id = p_execution_id
    and lock_token = p_lock_token
    and lock_expires_at > now()
  returning lock_expires_at into v_expires_at;

  if v_expires_at is null then
    raise exception 'execution_lock_mismatch_or_expired';
  end if;
  return v_expires_at;
end;
$$;

create or replace function public.finish_spot_import_execution(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_next_stage text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_new_status text;
  v_new_stage text;
  v_outcome text;
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
    v_new_status := 'completed';
    v_new_stage := 'human_review';
    v_outcome := 'normal_completed';
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
    jsonb_build_object('result_status', v_new_status, 'next_stage', v_new_stage)
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
$$;

create or replace function public.mark_spot_import_execution_anomaly(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region_id uuid;
  v_stage text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'anomaly_reason_required';
  end if;

  select region_id, current_stage into v_region_id, v_stage
  from public.spot_import_jobs
  where id = p_job_id;

  update private.spot_import_system_control
  set lock_status = 'anomaly',
      anomaly_reason = left(p_reason, 1000),
      updated_at = now()
  where id = 1
    and lock_status = 'active'
    and locked_job_id = p_job_id
    and execution_id = p_execution_id
    and lock_token = p_lock_token;

  if not found then
    raise exception 'execution_lock_mismatch';
  end if;

  perform private.write_spot_import_execution_log(
    'anomaly_detected',
    p_job_id,
    p_execution_id,
    v_region_id,
    v_stage,
    left(p_reason, 1000),
    '{}'::jsonb
  );
end;
$$;

revoke all on function private.write_spot_import_execution_log(text,uuid,uuid,uuid,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_spot_import_execution(integer)
  from public, anon, authenticated;
revoke all on function public.heartbeat_spot_import_execution(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.finish_spot_import_execution(uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.mark_spot_import_execution_anomaly(uuid,uuid,uuid,text)
  from public, anon, authenticated;

grant execute on function private.write_spot_import_execution_log(text,uuid,uuid,uuid,text,text,jsonb)
  to service_role;
grant execute on function public.claim_spot_import_execution(integer)
  to service_role;
grant execute on function public.heartbeat_spot_import_execution(uuid,uuid,uuid,integer)
  to service_role;
grant execute on function public.finish_spot_import_execution(uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.mark_spot_import_execution_anomaly(uuid,uuid,uuid,text)
  to service_role;
