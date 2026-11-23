
create or replace function private.commit_spot_import_analysis_batch(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_url_id uuid,
  p_success boolean,
  p_candidates jsonb default '[]'::jsonb,
  p_error text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
  v_item jsonb;
  v_name text;
  v_name_key text;
  v_exists boolean;
  v_max_facilities integer;
  v_candidate_count integer;
  v_remaining_slots integer;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'candidate_analysis'
  );

  perform 1
  from public.spot_import_urls u
  where u.id = p_url_id
    and u.job_id = p_job_id
    and u.processing_execution_id = p_execution_id
    and u.analysis_status = 'processing'
  for update;

  if not found then
    raise exception 'url_not_claimed_by_execution';
  end if;

  if p_success then
    if jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(p_candidates, '[]'::jsonb)) > 20 then
      raise exception 'invalid_analysis_payload';
    end if;

    select coalesce(j.max_facilities, 100)
      into v_max_facilities
    from public.spot_import_jobs j
    where j.id = p_job_id;

    if v_max_facilities is null then
      raise exception 'job_not_found';
    end if;

    select count(*)::integer
      into v_candidate_count
    from public.spot_import_candidates c
    where c.job_id = p_job_id;

    v_remaining_slots := greatest(0, v_max_facilities - v_candidate_count);

    for v_item in
      select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
    loop
      if nullif(btrim(v_item->>'name'), '') is null then
        raise exception 'candidate_name_required';
      end if;

      v_name := left(btrim(v_item->>'name'), 500);
      v_name_key := lower(
        regexp_replace(normalize(v_name, NFKC), '[[:space:]]+', '', 'g')
      );

      select exists (
        select 1
        from public.spot_import_candidates c
        where c.job_id = p_job_id
          and lower(
            regexp_replace(normalize(btrim(c.name), NFKC), '[[:space:]]+', '', 'g')
          ) = v_name_key
      ) into v_exists;

      if not v_exists and v_remaining_slots > 0 then
        insert into public.spot_import_candidates (
          job_id, source_url_id, name, address, official_url, description,
          best_season, catch_copy, top_reason, highlight_points, tags, raw_data,
          review_status, registration_status
        )
        values (
          p_job_id,
          p_url_id,
          v_name,
          nullif(v_item->>'address', ''),
          nullif(v_item->>'official_url', ''),
          nullif(v_item->>'description', ''),
          nullif(v_item->>'best_season', ''),
          nullif(v_item->>'catch_copy', ''),
          nullif(v_item->>'top_reason', ''),
          coalesce(v_item->'highlight_points', '[]'::jsonb),
          coalesce(v_item->'tags', '[]'::jsonb),
          coalesce(v_item->'raw_data', '{}'::jsonb),
          'pending',
          'pending'
        );

        v_count := v_count + 1;
        v_remaining_slots := v_remaining_slots - 1;
      end if;
    end loop;

    update public.spot_import_urls
    set analysis_status = 'completed',
        analysis_error = null,
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;
  else
    update public.spot_import_urls
    set analysis_status = 'failed',
        analysis_error = left(coalesce(p_error, 'analysis_failed'), 2000),
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;
  end if;

  return v_count;
end;
$function$;

create or replace function public.worker_commit_analysis_batch(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_url_id uuid,
  p_success boolean,
  p_candidates jsonb default '[]'::jsonb,
  p_error text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  return private.commit_spot_import_analysis_batch(
    p_job_id, p_execution_id, p_lock_token, p_url_id,
    p_success, p_candidates, p_error
  );
end;
$function$;

revoke all on function public.worker_commit_analysis_batch(uuid,uuid,uuid,uuid,boolean,jsonb,text) from public, anon, authenticated;
grant execute on function public.worker_commit_analysis_batch(uuid,uuid,uuid,uuid,boolean,jsonb,text) to service_role;
