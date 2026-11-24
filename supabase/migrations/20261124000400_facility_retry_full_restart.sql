-- 施設単位の手動再実行を、保存済み進捗の再開ではなく施設の最初からの再実行に統一する。
-- 現行Workerの通常処理（process/start）と整合させ、再実行対象の施設だけを初期化する。

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

  if v_job.status <> 'completed'
     or v_job.current_stage <> 'human_review'
     or v_job.final_outcome <> 'partial_error' then
    raise exception 'facility_retry_requires_completed_partial_error_job';
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
    v_retry_kind := 'timeout_full_restart';
  elsif v_candidate.status = 'failed'
     or v_candidate.relevance_status = 'failed'
     or v_progress->>'status' = 'failed'
     or v_progress->>'merge_status' = 'failed' then
    v_retry_kind := 'failed_full_restart';
  else
    raise exception 'facility_is_not_in_retryable_error_state';
  end if;

  -- 対象施設だけの情報統合状態を初期化する。
  -- URL収集・ページ抽出・施設名候補分析、および他施設の結果には触れない。
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

  insert into private.spot_import_execution_logs (
    job_id, region_id, stage, event_type, actor_id, message, details
  )
  values (
    v_job.id, v_job.region_id, 'information_merge',
    'facility_retry_requested', auth.uid(),
    'システム管理者が施設単位の最初からの再実行を指示',
    jsonb_build_object(
      'candidate_id', p_candidate_id,
      'spot_name', v_candidate.spot_name,
      'retry_kind', v_retry_kind,
      'restart_from_beginning', true
    )
  );

  return jsonb_build_object(
    'candidate_id', p_candidate_id,
    'spot_name', v_candidate.spot_name,
    'retry_kind', v_retry_kind,
    'restart_from_beginning', true,
    'job_status', 'pending'
  );
end;
$function$;

revoke all on function public.admin_retry_spot_import_facility(uuid) from public;
revoke all on function public.admin_retry_spot_import_facility(uuid) from anon;
grant execute on function public.admin_retry_spot_import_facility(uuid) to authenticated;
