-- システム管理者だけが、redesign_v1の施設単位エラーを再開できるようにする。
-- 既存のAI評価結果・人による審査データは保持する。

create or replace function public.admin_retry_spot_import_facility(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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

  if v_job.current_stage <> 'information_merge'
     or v_job.status not in ('running', 'completed') then
    raise exception 'job_not_ready_for_facility_retry';
  end if;

  if v_job.status = 'completed'
     and v_job.final_outcome <> 'partial_error' then
    raise exception 'job_has_no_partial_errors';
  end if;

  if v_candidate.review_status <> 'pending'
     or v_candidate.reviewed_data is not null
     or v_candidate.approved_spot_id is not null then
    raise exception 'reviewed_facility_cannot_be_retried';
  end if;

  v_progress := coalesce(v_candidate.relevance_progress, '{}'::jsonb);

  if v_candidate.relevance_status = 'failed'
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

  if v_job.status = 'completed' then
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
  end if;

  insert into private.spot_import_execution_logs (
    job_id, region_id, stage, event_type, actor_id, message, details
  )
  values (
    v_job.id, v_job.region_id, 'information_merge',
    'facility_retry_requested', auth.uid(),
    'システム管理者が施設単位のエラー再開を指示',
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
