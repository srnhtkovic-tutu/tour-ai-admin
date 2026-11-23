
-- =========================================================
-- 旅つづき 第2段階
-- 地域担当者のジョブ操作 / システム管理者の全体操作
-- =========================================================

create or replace function public.create_spot_import_job(
  p_region_id uuid,
  p_source_url text,
  p_max_facilities integer default 100,
  p_batch_size integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region public.regions%rowtype;
  v_host text;
  v_job_id uuid;
  v_url text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if p_region_id is null or not private.has_region_access(p_region_id) then
    raise exception 'region_access_denied';
  end if;

  select * into v_region
  from public.regions
  where id = p_region_id
  for share;

  if not found or not v_region.is_active then
    raise exception 'region_not_active';
  end if;

  v_url := btrim(coalesce(p_source_url, ''));

  if v_url = '' then
    raise exception 'source_url_required';
  end if;

  if p_max_facilities is null or p_max_facilities <= 0
     or p_batch_size is null or p_batch_size <= 0 then
    raise exception 'invalid_job_parameters';
  end if;

  if p_max_facilities > 10000 or p_batch_size > 1000 then
    raise exception 'job_parameters_too_large';
  end if;

  if v_url !~* '^https?://[^/:?#]+(:[0-9]+)?([/?#]|$)' then
    raise exception 'invalid_source_url';
  end if;

  v_host := lower((regexp_match(v_url, '^https?://([^/:?#]+)'))[1]);

  if not (v_host = any(v_region.allowed_domains)) then
    raise exception 'source_domain_not_allowed';
  end if;

  insert into public.spot_import_jobs (
    source_url, max_facilities, batch_size, status, region_id,
    current_stage, requested_action, requested_at, requested_by,
    queue_entered_at
  )
  values (
    v_url, p_max_facilities, p_batch_size, 'pending', p_region_id,
    'url_collection', 'start', now(), auth.uid(), now()
  )
  returning id into v_job_id;

  insert into private.spot_import_execution_logs (
    job_id, region_id, stage, event_type, actor_id, message, details
  )
  values (
    v_job_id, p_region_id, 'url_collection', 'job_created',
    auth.uid(), '地域担当者が収集ジョブを登録',
    jsonb_build_object(
      'source_url', v_url,
      'max_facilities', p_max_facilities,
      'batch_size', p_batch_size
    )
  );

  return jsonb_build_object(
    'job_id', v_job_id,
    'status', 'pending',
    'current_stage', 'url_collection'
  );
end;
$$;


create or replace function public.request_spot_import_job_action(
  p_job_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_is_active boolean;
  v_new_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if p_action is null or p_action not in ('start', 'pause', 'resume', 'cancel') then
    raise exception 'invalid_action';
  end if;

  select * into v_control
  from private.spot_import_system_control
  where id = 1
  for update;

  select * into v_job
  from public.spot_import_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception 'job_not_found';
  end if;

  if v_job.region_id is null
     or not private.has_region_access(v_job.region_id) then
    raise exception 'region_access_denied';
  end if;

  if exists (
    select 1 from public.regions r
    where r.id = v_job.region_id and not r.is_active
  ) then
    raise exception 'region_not_active';
  end if;

  if v_control.lock_status = 'anomaly'
     and v_control.locked_job_id = p_job_id then
    raise exception 'job_has_anomaly_lock';
  end if;

  v_is_active :=
    v_control.lock_status = 'active'
    and v_control.locked_job_id = p_job_id;

  if p_action = 'start' then
    if v_job.status <> 'pending'
       or v_job.current_stage is null
       or v_job.current_stage = 'human_review' then
      raise exception 'job_cannot_be_started';
    end if;

    update public.spot_import_jobs
    set requested_action = 'start',
        requested_at = now(),
        requested_by = auth.uid(),
        updated_at = now()
    where id = p_job_id;

    v_new_status := 'pending';

  elsif p_action = 'pause' then
    if v_job.status not in ('pending', 'running') then
      raise exception 'job_cannot_be_paused';
    end if;

    if v_is_active then
      update public.spot_import_jobs
      set requested_action = 'pause',
          requested_at = now(),
          requested_by = auth.uid(),
          updated_at = now()
      where id = p_job_id;
      v_new_status := v_job.status;
    else
      update public.spot_import_jobs
      set status = 'paused',
          requested_action = null,
          requested_at = null,
          requested_by = null,
          updated_at = now()
      where id = p_job_id;
      v_new_status := 'paused';
    end if;

  elsif p_action = 'cancel' then
    if v_job.status not in ('pending', 'running', 'paused') then
      raise exception 'job_cannot_be_cancelled';
    end if;

    if v_is_active then
      update public.spot_import_jobs
      set requested_action = 'cancel',
          requested_at = now(),
          requested_by = auth.uid(),
          updated_at = now()
      where id = p_job_id;
      v_new_status := v_job.status;
    else
      update public.spot_import_jobs
      set status = 'cancelled',
          final_outcome = 'cancelled',
          requested_action = null,
          requested_at = null,
          requested_by = null,
          updated_at = now()
      where id = p_job_id;
      v_new_status := 'cancelled';
    end if;

  else
    if v_job.status <> 'paused'
       or v_job.current_stage is null
       or v_job.current_stage = 'human_review' then
      raise exception 'job_cannot_be_resumed';
    end if;

    update public.spot_import_jobs
    set status = 'pending',
        requested_action = null,
        requested_at = null,
        requested_by = null,
        queue_entered_at = now(),
        updated_at = now()
    where id = p_job_id;

    v_new_status := 'pending';
  end if;

  insert into private.spot_import_execution_logs (
    job_id, region_id, stage, event_type, actor_id, message, details
  )
  values (
    p_job_id, v_job.region_id, v_job.current_stage,
    'job_action_requested', auth.uid(),
    '地域担当者がジョブ操作を実行',
    jsonb_build_object(
      'action', p_action,
      'result_status', v_new_status,
      'deferred_until_unit_finish',
        v_is_active and p_action in ('pause', 'cancel')
    )
  );

  return jsonb_build_object(
    'job_id', p_job_id,
    'action', p_action,
    'status', v_new_status,
    'deferred_until_unit_finish',
      v_is_active and p_action in ('pause', 'cancel')
  );
end;
$$;


create or replace function public.set_spot_import_system_enabled(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.spot_import_system_control%rowtype;
begin
  if auth.uid() is null or not private.is_system_admin() then
    raise exception 'system_admin_required';
  end if;

  select * into v_control
  from private.spot_import_system_control
  where id = 1
  for update;

  if not found then
    raise exception 'system_control_not_found';
  end if;

  if v_control.system_enabled is distinct from p_enabled then
    update private.spot_import_system_control
    set system_enabled = p_enabled, updated_at = now()
    where id = 1;

    insert into private.spot_import_execution_logs (
      job_id, execution_id, stage, event_type, actor_id, message, details
    )
    values (
      v_control.locked_job_id, v_control.execution_id, null,
      case when p_enabled then 'system_enabled' else 'system_disabled' end,
      auth.uid(),
      case when p_enabled then 'システム管理者が全体処理を再開'
           else 'システム管理者が全体処理を停止' end,
      jsonb_build_object('system_enabled', p_enabled)
    );
  end if;

  return jsonb_build_object(
    'system_enabled', p_enabled,
    'lock_status', v_control.lock_status
  );
end;
$$;


create or replace function public.release_spot_import_anomaly_lock(
  p_confirm_old_worker_stopped boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_status_after text;
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
      'processing_data_reset', false
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
    'processing_data_reset', false
  );
end;
$$;


create or replace function public.get_spot_import_system_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.spot_import_system_control%rowtype;
begin
  if auth.uid() is null or not private.is_system_admin() then
    raise exception 'system_admin_required';
  end if;

  select * into v_control
  from private.spot_import_system_control
  where id = 1;

  if not found then
    raise exception 'system_control_not_found';
  end if;

  return jsonb_build_object(
    'system_enabled', v_control.system_enabled,
    'lock_status', v_control.lock_status,
    'locked_job_id', v_control.locked_job_id,
    'execution_id', v_control.execution_id,
    'lock_acquired_at', v_control.lock_acquired_at,
    'last_heartbeat_at', v_control.last_heartbeat_at,
    'lock_expires_at', v_control.lock_expires_at,
    'anomaly_reason', v_control.anomaly_reason,
    'updated_at', v_control.updated_at
  );
end;
$$;


create or replace function public.get_spot_import_execution_logs(
  p_limit integer default 100,
  p_before_id bigint default null
)
returns table (
  id bigint,
  execution_id uuid,
  job_id uuid,
  region_id uuid,
  stage text,
  event_type text,
  actor_id uuid,
  message text,
  details jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_system_admin() then
    raise exception 'system_admin_required';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid_limit';
  end if;

  return query
  select
    l.id, l.execution_id, l.job_id, l.region_id, l.stage,
    l.event_type, l.actor_id, l.message, l.details, l.created_at
  from private.spot_import_execution_logs l
  where p_before_id is null or l.id < p_before_id
  order by l.id desc
  limit p_limit;
end;
$$;


revoke all on function public.create_spot_import_job(uuid,text,integer,integer)
  from public, anon;
revoke all on function public.request_spot_import_job_action(uuid,text)
  from public, anon;
revoke all on function public.set_spot_import_system_enabled(boolean)
  from public, anon;
revoke all on function public.release_spot_import_anomaly_lock(boolean,text)
  from public, anon;
revoke all on function public.get_spot_import_system_status()
  from public, anon;
revoke all on function public.get_spot_import_execution_logs(integer,bigint)
  from public, anon;

grant execute on function public.create_spot_import_job(uuid,text,integer,integer)
  to authenticated;
grant execute on function public.request_spot_import_job_action(uuid,text)
  to authenticated;
grant execute on function public.set_spot_import_system_enabled(boolean)
  to authenticated;
grant execute on function public.release_spot_import_anomaly_lock(boolean,text)
  to authenticated;
grant execute on function public.get_spot_import_system_status()
  to authenticated;
grant execute on function public.get_spot_import_execution_logs(integer,bigint)
  to authenticated;
