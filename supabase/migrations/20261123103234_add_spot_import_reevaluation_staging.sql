alter table public.spot_import_merged_v2
  add column if not exists reevaluation_status text,
  add column if not exists reevaluation_progress jsonb,
  add column if not exists reevaluation_results jsonb,
  add column if not exists reevaluation_relevance_model text,
  add column if not exists reevaluation_merged_data jsonb,
  add column if not exists reevaluation_model text,
  add column if not exists reevaluation_error_message text;

alter table public.spot_import_merged_v2
  drop constraint if exists spot_import_merged_v2_reevaluation_status_check;

alter table public.spot_import_merged_v2
  add constraint spot_import_merged_v2_reevaluation_status_check
  check (
    reevaluation_status is null
    or reevaluation_status in ('pending','running','paused','error','completed')
  );

create or replace function private.save_spot_import_reevaluation_progress_v1(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_spot_name text,
  p_reevaluation_status text,
  p_reevaluation_progress jsonb,
  p_reevaluation_results jsonb,
  p_reevaluation_relevance_model text,
  p_reevaluation_merged_data jsonb,
  p_reevaluation_model text,
  p_reevaluation_error_message text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'information_merge'
  );

  if nullif(btrim(p_spot_name), '') is null then
    raise exception 'spot_name_required';
  end if;

  if p_reevaluation_status not in ('pending','running','paused','error','completed') then
    raise exception 'invalid_reevaluation_status';
  end if;

  if p_reevaluation_progress is not null
     and jsonb_typeof(p_reevaluation_progress) <> 'object' then
    raise exception 'invalid_reevaluation_progress';
  end if;

  if p_reevaluation_results is not null
     and jsonb_typeof(p_reevaluation_results) <> 'array' then
    raise exception 'invalid_reevaluation_results';
  end if;

  if p_reevaluation_merged_data is not null
     and jsonb_typeof(p_reevaluation_merged_data) <> 'object' then
    raise exception 'invalid_reevaluation_merged_data';
  end if;

  update public.spot_import_merged_v2
  set reevaluation_status = p_reevaluation_status,
      reevaluation_progress = coalesce(p_reevaluation_progress, reevaluation_progress),
      reevaluation_results = coalesce(p_reevaluation_results, reevaluation_results),
      reevaluation_relevance_model = coalesce(p_reevaluation_relevance_model, reevaluation_relevance_model),
      reevaluation_merged_data = coalesce(p_reevaluation_merged_data, reevaluation_merged_data),
      reevaluation_model = coalesce(p_reevaluation_model, reevaluation_model),
      reevaluation_error_message = case
        when p_reevaluation_status = 'error' then left(coalesce(p_reevaluation_error_message, '再評価に失敗しました。'), 2000)
        else null
      end,
      updated_at = now()
  where job_id = p_job_id
    and spot_name = btrim(p_spot_name)
    and reevaluation_status is not null
  returning id into v_id;

  if v_id is null then
    raise exception 'reevaluation_not_requested_or_candidate_not_found';
  end if;

  return v_id;
end;
$function$;

create or replace function public.worker_save_spot_import_reevaluation_progress(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_spot_name text,
  p_reevaluation_status text,
  p_reevaluation_progress jsonb,
  p_reevaluation_results jsonb,
  p_reevaluation_relevance_model text,
  p_reevaluation_merged_data jsonb,
  p_reevaluation_model text,
  p_reevaluation_error_message text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  return private.save_spot_import_reevaluation_progress_v1(
    p_job_id, p_execution_id, p_lock_token, p_spot_name,
    p_reevaluation_status, p_reevaluation_progress,
    p_reevaluation_results, p_reevaluation_relevance_model,
    p_reevaluation_merged_data, p_reevaluation_model,
    p_reevaluation_error_message
  );
end;
$function$;

revoke all on function public.worker_save_spot_import_reevaluation_progress(
  uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb,text,text
) from public, anon, authenticated;

grant execute on function public.worker_save_spot_import_reevaluation_progress(
  uuid,uuid,uuid,text,text,jsonb,jsonb,text,jsonb,text,text
) to service_role;
