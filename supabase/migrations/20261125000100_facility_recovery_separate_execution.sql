-- 施設単位リカバリーを通常ジョブ処理から分離する。
-- 親ジョブは completed / human_review のまま維持し、同じ全体実行ロックを利用する。

CREATE OR REPLACE FUNCTION public.admin_retry_spot_import_facility(p_candidate_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_candidate public.spot_import_merged_v2%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_control private.spot_import_system_control%rowtype;
  v_progress jsonb;
  v_retry_kind text;
  v_requested_at timestamptz := now();
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.is_system_admin() then raise exception 'system_admin_required'; end if;

  select * into v_control from private.spot_import_system_control where id = 1 for update;
  if not found or v_control.lock_status <> 'unlocked' then raise exception 'system_execution_not_idle'; end if;
  if not v_control.system_enabled then raise exception 'system_execution_disabled'; end if;

  select * into v_candidate from public.spot_import_merged_v2 where id = p_candidate_id for update;
  if not found then raise exception 'facility_candidate_not_found'; end if;
  select * into v_job from public.spot_import_jobs where id = v_candidate.job_id for update;
  if not found then raise exception 'import_job_not_found'; end if;

  if v_job.pipeline_version <> 'redesign_v1' then raise exception 'facility_retry_requires_redesign_v1'; end if;
  if not exists (select 1 from public.regions r where r.id = v_job.region_id and r.is_active = true) then
    raise exception 'facility_retry_requires_active_region';
  end if;
  if v_job.status <> 'completed' or v_job.current_stage <> 'human_review' or v_job.final_outcome <> 'partial_error' then
    raise exception 'facility_retry_requires_completed_partial_error_job';
  end if;
  if v_candidate.review_status <> 'pending' or v_candidate.reviewed_data is not null or v_candidate.approved_spot_id is not null then
    raise exception 'reviewed_facility_cannot_be_retried';
  end if;

  v_progress := coalesce(v_candidate.relevance_progress, '{}'::jsonb);
  if v_candidate.status = 'skipped' and v_candidate.relevance_status = 'skipped'
     and v_progress->>'skip_reason' in ('edge_function_timeout', 'information_merge_timeout') then
    v_retry_kind := 'timeout_full_restart';
  elsif v_candidate.status = 'failed' or v_candidate.relevance_status = 'failed'
     or v_progress->>'status' = 'failed' or v_progress->>'merge_status' = 'failed' then
    v_retry_kind := 'failed_full_restart';
  else
    raise exception 'facility_is_not_in_retryable_error_state';
  end if;

  update public.spot_import_merged_v2
  set status = 'pending', relevance_status = 'pending', relevance_results = '[]'::jsonb,
      relevance_progress = jsonb_build_object(
        'recovery_requested_at', v_requested_at,
        'recovery_request', jsonb_build_object(
          'candidate_id', p_candidate_id, 'requested_at', v_requested_at,
          'requested_by', auth.uid(), 'retry_kind', v_retry_kind, 'restart_from_beginning', true
        )
      ),
      merged_data = null, source_count = 0, input_char_count = 0,
      source_candidate_ids = '{}'::uuid[], source_url_ids = '{}'::uuid[], sources = '[]'::jsonb,
      model = null, relevance_model = null, error_message = null, updated_at = v_requested_at
  where id = p_candidate_id;

  insert into private.spot_import_execution_logs
    (job_id, region_id, stage, event_type, actor_id, message, details, created_at)
  values
    (v_job.id, v_job.region_id, 'information_merge', 'facility_retry_requested', auth.uid(),
     'システム管理者が施設単位の最初からの再実行を指示',
     jsonb_build_object('candidate_id',p_candidate_id,'spot_name',v_candidate.spot_name,
       'retry_kind',v_retry_kind,'restart_from_beginning',true,'parent_job_kept_completed',true),
     v_requested_at);

  return jsonb_build_object('candidate_id',p_candidate_id,'spot_name',v_candidate.spot_name,
    'retry_kind',v_retry_kind,'restart_from_beginning',true,'recovery_requested',true,
    'job_status','completed','current_stage','human_review');
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_spot_import_execution(p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_candidate public.spot_import_merged_v2%rowtype;
  v_execution_id uuid;
  v_lock_token uuid;
  v_recovery_request jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not_authorized'; end if;
  if p_lease_seconds is null or p_lease_seconds <= 0 then raise exception 'invalid_lease_seconds'; end if;

  select * into v_control from private.spot_import_system_control where id = 1 for update;
  if not found or not v_control.system_enabled then return null; end if;
  if v_control.lock_status = 'anomaly' then return null; end if;
  if v_control.lock_status = 'active' then
    if v_control.lock_expires_at > now() then return null; end if;
    update private.spot_import_system_control set lock_status='anomaly', anomaly_reason='lease_expired', updated_at=now() where id=1;
    perform private.write_spot_import_execution_log('anomaly_detected',v_control.locked_job_id,v_control.execution_id,null,null,
      '実行リース期限切れを検出。ロックを保持して異常停止',jsonb_build_object('reason','lease_expired'));
    return jsonb_build_object('status','anomaly');
  end if;

  -- リカバリー要求を通常ジョブより先に取得する。親ジョブの状態は変更しない。
  select m.* into v_candidate
  from public.spot_import_merged_v2 m
  join public.spot_import_jobs j on j.id=m.job_id
  join public.regions r on r.id=j.region_id
  where m.status='pending' and m.relevance_status='pending'
    and m.relevance_progress ? 'recovery_request'
    and m.relevance_progress->'recovery_request'->>'candidate_id' = m.id::text
    and j.pipeline_version='redesign_v1' and j.status='completed'
    and j.current_stage='human_review' and j.final_outcome='partial_error'
    and m.review_status='pending' and m.reviewed_data is null and m.approved_spot_id is null
    and r.is_active=true
  order by (m.relevance_progress->'recovery_request'->>'requested_at')::timestamptz asc nulls last, m.id asc
  limit 1 for update of m,j skip locked;

  if found then
    select * into v_job from public.spot_import_jobs where id=v_candidate.job_id;
    v_recovery_request := v_candidate.relevance_progress->'recovery_request';
    v_execution_id := gen_random_uuid();
    v_lock_token := gen_random_uuid();

    update private.spot_import_system_control
    set lock_status='active', locked_job_id=v_job.id, execution_id=v_execution_id, lock_token=v_lock_token,
        lock_acquired_at=now(), last_heartbeat_at=now(),
        lock_expires_at=now()+make_interval(secs=>p_lease_seconds), anomaly_reason=null, updated_at=now()
    where id=1;

    insert into private.spot_import_execution_logs
      (job_id,execution_id,region_id,stage,event_type,actor_id,message,details,created_at)
    values
      (v_job.id,v_execution_id,v_job.region_id,'information_merge','facility_recovery_claimed',
       nullif(v_recovery_request->>'requested_by','')::uuid,'施設単位の情報統合再実行を取得',
       jsonb_build_object('candidate_id',v_candidate.id,'spot_name',v_candidate.spot_name,
         'retry_kind',v_recovery_request->>'retry_kind','restart_from_beginning',true),now());

    return jsonb_build_object('job_id',v_job.id,'stage','information_merge','pipeline_version',v_job.pipeline_version,
      'execution_id',v_execution_id,'lock_token',v_lock_token,
      'lease_expires_at',now()+make_interval(secs=>p_lease_seconds),
      'recovery',true,'candidate_id',v_candidate.id,'spot_name',v_candidate.spot_name);
  end if;

  -- 通常ジョブ取得処理は既存仕様を維持する。
  select j.* into v_job
  from public.spot_import_jobs j join public.regions r on r.id=j.region_id
  where j.status in ('pending','running') and j.current_stage is not null and j.current_stage<>'human_review'
    and (j.requested_action is null or j.requested_action='start') and r.is_active=true
  order by j.queue_entered_at asc nulls last,j.id asc
  limit 1 for update of j skip locked;
  if not found then return null; end if;

  v_execution_id:=gen_random_uuid();
  v_lock_token:=gen_random_uuid();
  update private.spot_import_system_control
  set lock_status='active',locked_job_id=v_job.id,execution_id=v_execution_id,lock_token=v_lock_token,
      lock_acquired_at=now(),last_heartbeat_at=now(),
      lock_expires_at=now()+make_interval(secs=>p_lease_seconds),anomaly_reason=null,updated_at=now()
  where id=1;
  update public.spot_import_jobs
  set status='running',requested_action=null,requested_at=null,requested_by=null,updated_at=now()
  where id=v_job.id;
  perform private.write_spot_import_execution_log('execution_claimed',v_job.id,v_execution_id,v_job.region_id,
    v_job.current_stage,'実行権を取得',jsonb_build_object('pipeline_version',v_job.pipeline_version));
  return jsonb_build_object('job_id',v_job.id,'stage',v_job.current_stage,'pipeline_version',v_job.pipeline_version,
    'execution_id',v_execution_id,'lock_token',v_lock_token,
    'lease_expires_at',now()+make_interval(secs=>p_lease_seconds),'recovery',false);
end;
$function$;

CREATE OR REPLACE FUNCTION private.assert_spot_import_execution(
  p_job_id uuid,p_execution_id uuid,p_lock_token uuid,p_stage text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_ok boolean;
begin
  if (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'not_authorized'; end if;
  if p_stage not in ('url_collection','page_extraction','candidate_analysis','information_merge') then raise exception 'invalid_stage'; end if;
  select exists (
    select 1 from private.spot_import_system_control c
    join public.spot_import_jobs j on j.id=c.locked_job_id
    where c.id=1 and c.lock_status='active' and c.locked_job_id=p_job_id
      and c.execution_id=p_execution_id and c.lock_token=p_lock_token and c.lock_expires_at>now()
      and j.id=p_job_id and (
        (j.status='running' and j.current_stage=p_stage)
        or (p_stage='information_merge' and j.status='completed' and j.current_stage='human_review'
          and exists (select 1 from private.spot_import_execution_logs l
            where l.job_id=p_job_id and l.execution_id=p_execution_id
              and l.event_type='facility_recovery_claimed' and l.details ? 'candidate_id'))
      )
  ) into v_ok;
  if not v_ok then raise exception 'execution_lock_mismatch_or_expired'; end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.save_spot_import_merge_progress_v2(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_spot_name text,
  p_status text,
  p_source_count integer,
  p_input_char_count integer,
  p_source_candidate_ids uuid[],
  p_source_url_ids uuid[],
  p_sources jsonb,
  p_merged_data jsonb,
  p_model text,
  p_relevance_status text,
  p_relevance_results jsonb,
  p_relevance_model text,
  p_relevance_progress jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_region_id uuid;
  v_id uuid;
  v_error_message text;
  v_recovery_details jsonb;
  v_recovery_candidate_id uuid;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'information_merge'
  );

  -- リカバリー実行では、claim時に記録した対象施設以外への保存を禁止する。
  select l.details into v_recovery_details
  from private.spot_import_execution_logs l
  where l.job_id = p_job_id
    and l.execution_id = p_execution_id
    and l.event_type = 'facility_recovery_claimed'
  order by l.created_at desc
  limit 1;

  if v_recovery_details is not null then
    v_recovery_candidate_id := nullif(v_recovery_details->>'candidate_id', '')::uuid;
    if v_recovery_candidate_id is null
       or p_spot_name is distinct from v_recovery_details->>'spot_name'
       or not exists (
         select 1
         from public.spot_import_merged_v2 m
         where m.id = v_recovery_candidate_id
           and m.job_id = p_job_id
           and m.spot_name = p_spot_name
       ) then
      raise exception 'facility_recovery_target_mismatch';
    end if;
  end if;

  if nullif(btrim(p_spot_name), '') is null then
    raise exception 'spot_name_required';
  end if;

  if p_status not in ('pending','completed','failed','skipped') then
    raise exception 'invalid_merge_status';
  end if;

  if p_source_count is not null and p_source_count < 0 then
    raise exception 'invalid_source_count';
  end if;

  if p_input_char_count is not null and p_input_char_count < 0 then
    raise exception 'invalid_input_char_count';
  end if;

  if p_relevance_status is not null
     and p_relevance_status not in ('pending','in_progress','completed','failed','skipped') then
    raise exception 'invalid_relevance_status';
  end if;

  select j.region_id
    into v_region_id
  from public.spot_import_jobs j
  join public.regions r on r.id = j.region_id
  where j.id = p_job_id and r.is_active = true;

  if v_region_id is null then
    raise exception 'active_job_region_required';
  end if;

  if p_status = 'failed' or p_relevance_status = 'failed' then
    v_error_message := left(
      coalesce(
        nullif(p_relevance_progress->>'last_error', ''),
        nullif(p_relevance_progress->>'merge_error', ''),
        '処理に失敗しました。'
      ),
      2000
    );
  else
    v_error_message := null;
  end if;

  insert into public.spot_import_merged_v2 (
    job_id, spot_name, status, source_count, input_char_count,
    source_candidate_ids, source_url_ids, sources, merged_data, model,
    relevance_status, relevance_results, relevance_model,
    relevance_progress, region_id, error_message
  )
  values (
    p_job_id, btrim(p_spot_name), p_status,
    coalesce(p_source_count, 0), coalesce(p_input_char_count, 0),
    coalesce(p_source_candidate_ids, '{}'::uuid[]),
    coalesce(p_source_url_ids, '{}'::uuid[]),
    coalesce(p_sources, '[]'::jsonb),
    p_merged_data, p_model, p_relevance_status,
    p_relevance_results, p_relevance_model, p_relevance_progress,
    v_region_id, v_error_message
  )
  on conflict (job_id, spot_name)
  do update set
    status = excluded.status,
    source_count = excluded.source_count,
    input_char_count = excluded.input_char_count,
    source_candidate_ids = excluded.source_candidate_ids,
    source_url_ids = excluded.source_url_ids,
    sources = excluded.sources,
    merged_data = coalesce(excluded.merged_data, public.spot_import_merged_v2.merged_data),
    model = coalesce(excluded.model, public.spot_import_merged_v2.model),
    error_message = excluded.error_message,
    relevance_status = coalesce(excluded.relevance_status, public.spot_import_merged_v2.relevance_status),
    relevance_results = coalesce(excluded.relevance_results, public.spot_import_merged_v2.relevance_results),
    relevance_model = coalesce(excluded.relevance_model, public.spot_import_merged_v2.relevance_model),
    relevance_progress = coalesce(excluded.relevance_progress, public.spot_import_merged_v2.relevance_progress),
    region_id = excluded.region_id,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_spot_import_execution_anomaly(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_region_id uuid;
  v_stage text;
  v_recovery_details jsonb;
  v_candidate_id uuid;
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

  select l.details into v_recovery_details
  from private.spot_import_execution_logs l
  where l.job_id = p_job_id
    and l.execution_id = p_execution_id
    and l.event_type = 'facility_recovery_claimed'
  order by l.created_at desc
  limit 1;

  if v_recovery_details is not null then
    v_stage := 'information_merge';
    v_candidate_id := nullif(v_recovery_details->>'candidate_id', '')::uuid;
  end if;

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

  if v_candidate_id is not null then
    update public.spot_import_merged_v2
    set status = 'failed',
        relevance_status = 'failed',
        error_message = left(p_reason, 2000),
        relevance_progress = coalesce(relevance_progress, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'failed',
            'merge_status', 'failed',
            'last_error', left(p_reason, 2000),
            'facility_recovery_failed_at', now()
          ),
        updated_at = now()
    where id = v_candidate_id
      and job_id = p_job_id;
  end if;

  perform private.write_spot_import_execution_log(
    'anomaly_detected',
    p_job_id,
    p_execution_id,
    v_region_id,
    v_stage,
    left(p_reason, 1000),
    case
      when v_candidate_id is not null then jsonb_build_object(
        'facility_recovery', true,
        'candidate_id', v_candidate_id,
        'spot_name', v_recovery_details->>'spot_name'
      )
      else '{}'::jsonb
    end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.finish_spot_import_execution(
  p_job_id uuid,p_execution_id uuid,p_lock_token uuid,p_next_stage text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_control private.spot_import_system_control%rowtype;
  v_job public.spot_import_jobs%rowtype;
  v_new_status text;
  v_new_stage text;
  v_outcome text;
  v_has_facility_errors boolean:=false;
  v_recovery_details jsonb;
  v_recovery_candidate_id uuid;
  v_recovery_candidate_status text;
  v_recovery_relevance_status text;
begin
  if auth.role()<>'service_role' then raise exception 'not_authorized'; end if;
  select * into v_control from private.spot_import_system_control where id=1 for update;
  if v_control.lock_status<>'active' or v_control.locked_job_id<>p_job_id
     or v_control.execution_id<>p_execution_id or v_control.lock_token<>p_lock_token
     or v_control.lock_expires_at<=now() then raise exception 'execution_lock_mismatch_or_expired'; end if;
  select * into v_job from public.spot_import_jobs where id=p_job_id for update;
  if not found then raise exception 'job_not_found'; end if;

  select l.details into v_recovery_details from private.spot_import_execution_logs l
  where l.job_id=p_job_id and l.execution_id=p_execution_id and l.event_type='facility_recovery_claimed'
  order by l.created_at desc limit 1;

  if v_recovery_details is not null then
    if v_job.status<>'completed' or v_job.current_stage<>'human_review' then
      raise exception 'facility_recovery_parent_job_state_changed';
    end if;
    v_recovery_candidate_id:=nullif(v_recovery_details->>'candidate_id','')::uuid;
    if v_recovery_candidate_id is null then raise exception 'facility_recovery_candidate_missing'; end if;

    -- 対象施設の保存が完了状態になったことを確認してから、親ジョブの終了処理へ進む。
    select m.status, m.relevance_status
      into v_recovery_candidate_status, v_recovery_relevance_status
    from public.spot_import_merged_v2 m
    where m.id = v_recovery_candidate_id
      and m.job_id = p_job_id
      and m.spot_name = v_recovery_details->>'spot_name';
    if not found then raise exception 'facility_recovery_target_not_found'; end if;
    if coalesce(v_recovery_candidate_status, '') not in ('completed', 'skipped')
       or coalesce(v_recovery_relevance_status, '') not in ('completed', 'skipped') then
      raise exception 'facility_recovery_target_not_finished';
    end if;

    select exists (
      select 1 from public.spot_import_merged_v2 m where m.job_id=p_job_id and (
        m.status='failed' or m.relevance_status='failed'
        or m.relevance_progress->>'skip_reason' in ('edge_function_timeout','information_merge_timeout')
          or m.relevance_progress ? 'recovery_request'
      )
    ) into v_has_facility_errors;
    v_outcome:=case when v_has_facility_errors then 'partial_error' else 'normal_completed' end;
    update public.spot_import_jobs set final_outcome=v_outcome,updated_at=now() where id=p_job_id;
    insert into private.spot_import_execution_logs
      (job_id,execution_id,region_id,stage,event_type,actor_id,message,details,created_at)
    values (p_job_id,p_execution_id,v_job.region_id,'information_merge','facility_recovery_completed',null,
      '施設単位の情報統合再実行を終了',
      jsonb_build_object('candidate_id',v_recovery_candidate_id,'spot_name',v_recovery_details->>'spot_name',
        'final_outcome',v_outcome,'parent_job_kept_completed',true),now());
    update private.spot_import_system_control
    set lock_status='unlocked',locked_job_id=null,execution_id=null,lock_token=null,
      lock_acquired_at=null,last_heartbeat_at=null,lock_expires_at=null,anomaly_reason=null,updated_at=now()
    where id=1;
    return jsonb_build_object('status','completed','current_stage','human_review','final_outcome',v_outcome,
      'recovery',true,'candidate_id',v_recovery_candidate_id);
  end if;

  if p_next_stage is not null and p_next_stage not in
    ('url_collection','page_extraction','candidate_analysis','information_merge') then raise exception 'invalid_next_stage'; end if;
  if v_job.requested_action='pause' then
    v_new_status:='paused'; v_new_stage:=v_job.current_stage; v_outcome:=null;
  elsif v_job.requested_action='cancel' then
    v_new_status:='cancelled'; v_new_stage:=v_job.current_stage; v_outcome:='cancelled';
  elsif not v_control.system_enabled then
    v_new_status:='pending'; v_new_stage:=v_job.current_stage; v_outcome:=null;
  elsif p_next_stage is null then
    select exists (
      select 1 from public.spot_import_merged_v2 m where m.job_id=p_job_id and (
        m.status='failed' or m.relevance_status='failed'
        or m.relevance_progress->>'skip_reason' in ('edge_function_timeout','information_merge_timeout')
      )
    ) into v_has_facility_errors;
    v_new_status:='completed'; v_new_stage:='human_review';
    v_outcome:=case when v_has_facility_errors then 'partial_error' else 'normal_completed' end;
  else
    v_new_status:='running'; v_new_stage:=p_next_stage; v_outcome:=null;
  end if;

  update public.spot_import_jobs set status=v_new_status,current_stage=v_new_stage,final_outcome=v_outcome,
    requested_action=null,requested_at=null,requested_by=null,updated_at=now() where id=p_job_id;
  perform private.write_spot_import_execution_log('worker_completed',p_job_id,p_execution_id,v_job.region_id,
    v_job.current_stage,'処理単位を終了',
    jsonb_build_object('result_status',v_new_status,'next_stage',v_new_stage,'final_outcome',v_outcome));
  update private.spot_import_system_control
  set lock_status='unlocked',locked_job_id=null,execution_id=null,lock_token=null,
    lock_acquired_at=null,last_heartbeat_at=null,lock_expires_at=null,anomaly_reason=null,updated_at=now()
  where id=1;
  return jsonb_build_object('status',v_new_status,'current_stage',v_new_stage,'final_outcome',v_outcome,'recovery',false);
end;
$function$;
