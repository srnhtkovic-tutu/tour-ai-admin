
create or replace function private.save_spot_import_merge_progress(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_spot_name text,
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
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region_id uuid;
  v_id uuid;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'information_merge'
  );

  if nullif(btrim(p_spot_name), '') is null then
    raise exception 'spot_name_required';
  end if;

  if p_source_count is not null and p_source_count < 0 then
    raise exception 'invalid_source_count';
  end if;

  if p_input_char_count is not null and p_input_char_count < 0 then
    raise exception 'invalid_input_char_count';
  end if;

  if p_relevance_status is not null
     and p_relevance_status not in ('pending','in_progress','completed','failed') then
    raise exception 'invalid_relevance_status';
  end if;

  select j.region_id
    into v_region_id
  from public.spot_import_jobs j
  join public.regions r on r.id = j.region_id
  where j.id = p_job_id
    and r.is_active = true;

  if v_region_id is null then
    raise exception 'active_job_region_required';
  end if;

  insert into public.spot_import_merged_v2 (
    job_id,
    spot_name,
    source_count,
    input_char_count,
    source_candidate_ids,
    source_url_ids,
    sources,
    merged_data,
    model,
    relevance_status,
    relevance_results,
    relevance_model,
    relevance_progress,
    region_id
  )
  values (
    p_job_id,
    btrim(p_spot_name),
    coalesce(p_source_count, 0),
    coalesce(p_input_char_count, 0),
    coalesce(p_source_candidate_ids, '{}'::uuid[]),
    coalesce(p_source_url_ids, '{}'::uuid[]),
    coalesce(p_sources, '[]'::jsonb),
    p_merged_data,
    p_model,
    p_relevance_status,
    p_relevance_results,
    p_relevance_model,
    p_relevance_progress,
    v_region_id
  )
  on conflict (job_id, spot_name)
  do update set
    source_count = excluded.source_count,
    input_char_count = excluded.input_char_count,
    source_candidate_ids = excluded.source_candidate_ids,
    source_url_ids = excluded.source_url_ids,
    sources = excluded.sources,
    merged_data = coalesce(excluded.merged_data, public.spot_import_merged_v2.merged_data),
    model = coalesce(excluded.model, public.spot_import_merged_v2.model),
    relevance_status = coalesce(excluded.relevance_status, public.spot_import_merged_v2.relevance_status),
    relevance_results = coalesce(excluded.relevance_results, public.spot_import_merged_v2.relevance_results),
    relevance_model = coalesce(excluded.relevance_model, public.spot_import_merged_v2.relevance_model),
    relevance_progress = coalesce(excluded.relevance_progress, public.spot_import_merged_v2.relevance_progress),
    region_id = excluded.region_id,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function private.save_spot_import_merge_progress(
  uuid,uuid,uuid,text,integer,integer,uuid[],uuid[],jsonb,jsonb,text,text,jsonb,text,jsonb
) from public, anon, authenticated;

grant execute on function private.save_spot_import_merge_progress(
  uuid,uuid,uuid,text,integer,integer,uuid[],uuid[],jsonb,jsonb,text,text,jsonb,text,jsonb
) to service_role;
