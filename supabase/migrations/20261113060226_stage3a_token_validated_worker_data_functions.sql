
-- Stage 3A: token-validated worker data access
-- All worker functions are private and service_role-only.

create or replace function private.assert_spot_import_execution(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_stage text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if (select auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'not_authorized';
  end if;

  if p_stage not in ('url_collection','page_extraction','candidate_analysis','information_merge') then
    raise exception 'invalid_stage';
  end if;

  select exists (
    select 1
    from private.spot_import_system_control c
    join public.spot_import_jobs j on j.id = c.locked_job_id
    where c.id = 1
      and c.lock_status = 'active'
      and c.locked_job_id = p_job_id
      and c.execution_id = p_execution_id
      and c.lock_token = p_lock_token
      and c.lock_expires_at > now()
      and j.id = p_job_id
      and j.status = 'running'
      and j.current_stage = p_stage
  ) into v_ok;

  if not v_ok then
    raise exception 'execution_lock_mismatch_or_expired';
  end if;
end;
$$;

create or replace function private.claim_spot_import_url_batch(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_stage text,
  p_limit integer
)
returns table (
  id uuid,
  url text,
  page_title text,
  link_label text,
  crawl_depth integer,
  priority integer,
  extracted_text text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, p_stage
  );

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_batch_limit';
  end if;

  if p_stage = 'url_collection' then
    return query
    with picked as (
      select u.id
      from public.spot_import_urls u
      where u.job_id = p_job_id
        and (
          u.crawl_status = 'pending'
          or (u.crawl_status = 'failed' and u.retry_count < 2)
        )
      order by u.priority desc, u.created_at asc, u.id asc
      limit p_limit
      for update skip locked
    )
    update public.spot_import_urls u
    set crawl_status = 'processing',
        processing_execution_id = p_execution_id,
        updated_at = now()
    from picked
    where u.id = picked.id
    returning u.id, u.url, u.page_title, u.link_label,
              u.crawl_depth, u.priority, u.extracted_text;

  elsif p_stage = 'page_extraction' then
    return query
    with picked as (
      select u.id
      from public.spot_import_urls u
      where u.job_id = p_job_id
        and u.crawl_status = 'fetched'
        and u.candidate_extraction_status = 'pending'
        and u.processing_execution_id is null
      order by u.priority desc, u.created_at asc, u.id asc
      limit p_limit
      for update skip locked
    )
    update public.spot_import_urls u
    set candidate_extraction_status = 'processing',
        processing_execution_id = p_execution_id,
        updated_at = now()
    from picked
    where u.id = picked.id
    returning u.id, u.url, u.page_title, u.link_label,
              u.crawl_depth, u.priority, u.extracted_text;

  elsif p_stage = 'candidate_analysis' then
    return query
    with picked as (
      select u.id
      from public.spot_import_urls u
      where u.job_id = p_job_id
        and u.candidate_extraction_status = 'completed'
        and u.analysis_status = 'pending'
        and u.processing_execution_id is null
      order by u.priority desc, u.created_at asc, u.id asc
      limit p_limit
      for update skip locked
    )
    update public.spot_import_urls u
    set analysis_status = 'processing',
        processing_execution_id = p_execution_id,
        updated_at = now()
    from picked
    where u.id = picked.id
    returning u.id, u.url, u.page_title, u.link_label,
              u.crawl_depth, u.priority, u.extracted_text;
  else
    raise exception 'unsupported_stage_for_url_claim';
  end if;
end;
$$;

create or replace function private.initialize_spot_import_url_collection(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_urls jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region_id uuid;
  v_allowed_domains text[];
  v_item jsonb;
  v_url text;
  v_host text;
  v_inserted integer := 0;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'url_collection'
  );

  if jsonb_typeof(coalesce(p_urls, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_urls, '[]'::jsonb)) > 2000 then
    raise exception 'invalid_url_collection_payload';
  end if;

  select j.region_id, r.allowed_domains
    into v_region_id, v_allowed_domains
  from public.spot_import_jobs j
  join public.regions r on r.id = j.region_id
  where j.id = p_job_id and r.is_active = true;

  if v_region_id is null then
    raise exception 'active_job_region_required';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_urls, '[]'::jsonb))
  loop
    v_url := btrim(coalesce(v_item->>'url', ''));

    if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then
      raise exception 'invalid_discovered_url';
    end if;

    v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);

    if not (v_host = any(v_allowed_domains)) then
      raise exception 'discovered_url_domain_not_allowed';
    end if;

    insert into public.spot_import_urls (
      job_id, url, page_title, link_label, discovered_from_url,
      crawl_depth, priority, crawl_status
    )
    values (
      p_job_id,
      v_url,
      nullif(v_item->>'page_title',''),
      nullif(v_item->>'link_label',''),
      nullif(v_item->>'discovered_from_url',''),
      greatest(0, coalesce((v_item->>'crawl_depth')::integer, 0)),
      coalesce((v_item->>'priority')::integer, 0),
      'pending'
    )
    on conflict (job_id, url) do nothing;

    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  perform private.write_spot_import_execution_log(
    'url_collection_initialized',
    p_job_id,
    p_execution_id,
    v_region_id,
    'url_collection',
    'サイトマップURLの初期登録を確定',
    jsonb_build_object('submitted_count', jsonb_array_length(coalesce(p_urls, '[]'::jsonb)),
                       'inserted_count', v_inserted)
  );

  return v_inserted;
end;
$$;

create or replace function private.commit_spot_import_crawl_page(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_url_id uuid,
  p_success boolean,
  p_extracted_text text default null,
  p_error text default null,
  p_discovered_urls jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region_id uuid;
  v_allowed_domains text[];
  v_source_url text;
  v_item jsonb;
  v_url text;
  v_host text;
  v_added integer := 0;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'url_collection'
  );

  select r.id, r.allowed_domains, u.url
    into v_region_id, v_allowed_domains, v_source_url
  from public.spot_import_jobs j
  join public.regions r on r.id = j.region_id
  join public.spot_import_urls u on u.job_id = j.id
  where j.id = p_job_id
    and u.id = p_url_id
    and u.processing_execution_id = p_execution_id
    and u.crawl_status = 'processing'
    and r.is_active = true
  for update of u;

  if not found then
    raise exception 'url_not_claimed_by_execution';
  end if;

  if p_success then
    update public.spot_import_urls
    set extracted_text = p_extracted_text,
        crawl_status = 'fetched',
        crawl_error = null,
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;

    if jsonb_typeof(coalesce(p_discovered_urls, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(p_discovered_urls, '[]'::jsonb)) > 500 then
      raise exception 'invalid_discovered_urls_payload';
    end if;

    for v_item in select value from jsonb_array_elements(coalesce(p_discovered_urls, '[]'::jsonb))
    loop
      v_url := btrim(coalesce(v_item->>'url', ''));

      if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then
        raise exception 'invalid_discovered_url';
      end if;

      v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);

      if not (v_host = any(v_allowed_domains)) then
        raise exception 'discovered_url_domain_not_allowed';
      end if;

      insert into public.spot_import_urls (
        job_id, url, page_title, link_label, discovered_from_url,
        crawl_depth, priority, crawl_status
      )
      values (
        p_job_id, v_url,
        nullif(v_item->>'page_title',''),
        nullif(v_item->>'link_label',''),
        v_source_url,
        greatest(0, coalesce((v_item->>'crawl_depth')::integer, 0)),
        coalesce((v_item->>'priority')::integer, 0),
        'pending'
      )
      on conflict (job_id, url) do nothing;

      if found then
        v_added := v_added + 1;
      end if;
    end loop;
  else
    update public.spot_import_urls
    set crawl_status = 'failed',
        crawl_error = left(coalesce(p_error, 'crawl_failed'), 2000),
        retry_count = retry_count + 1,
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;
  end if;

  return jsonb_build_object(
    'success', p_success,
    'discovered_urls_added', v_added
  );
end;
$$;

create or replace function private.commit_spot_import_extraction(
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
as $$
declare
  v_count integer := 0;
  v_item jsonb;
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'page_extraction'
  );

  perform 1
  from public.spot_import_urls u
  where u.id = p_url_id
    and u.job_id = p_job_id
    and u.processing_execution_id = p_execution_id
    and u.candidate_extraction_status = 'processing'
  for update;

  if not found then
    raise exception 'url_not_claimed_by_execution';
  end if;

  if p_success then
    if jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(p_candidates, '[]'::jsonb)) > 20 then
      raise exception 'invalid_extraction_payload';
    end if;

    delete from public.spot_import_page_candidates
    where job_id = p_job_id and source_url_id = p_url_id;

    for v_item in select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
    loop
      if nullif(btrim(v_item->>'name'), '') is null then
        raise exception 'candidate_name_required';
      end if;

      insert into public.spot_import_page_candidates (
        job_id, source_url_id, name, evidence_text, category, raw_data
      )
      values (
        p_job_id,
        p_url_id,
        left(btrim(v_item->>'name'), 500),
        v_item->>'evidence_text',
        v_item->>'category',
        coalesce(v_item->'raw_data', '{}'::jsonb)
      );

      v_count := v_count + 1;
    end loop;

    update public.spot_import_urls
    set candidate_extraction_status = 'completed',
        candidate_extraction_error = null,
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;
  else
    update public.spot_import_urls
    set candidate_extraction_status = 'failed',
        candidate_extraction_error = left(coalesce(p_error, 'extraction_failed'), 2000),
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;
  end if;

  return v_count;
end;
$$;

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
as $$
declare
  v_count integer := 0;
  v_item jsonb;
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

    for v_item in select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
    loop
      if nullif(btrim(v_item->>'name'), '') is null then
        raise exception 'candidate_name_required';
      end if;

      insert into public.spot_import_candidates (
        job_id, source_url_id, name, address, official_url, description,
        best_season, catch_copy, top_reason, highlight_points, tags, raw_data
      )
      values (
        p_job_id,
        p_url_id,
        left(btrim(v_item->>'name'), 500),
        v_item->>'address',
        v_item->>'official_url',
        v_item->>'description',
        v_item->>'best_season',
        v_item->>'catch_copy',
        v_item->>'top_reason',
        coalesce(v_item->'highlight_points', '[]'::jsonb),
        coalesce(v_item->'tags', '[]'::jsonb),
        coalesce(v_item->'raw_data', '{}'::jsonb)
      );

      v_count := v_count + 1;
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
$$;

revoke all on function private.assert_spot_import_execution(uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function private.claim_spot_import_url_batch(uuid,uuid,uuid,text,integer)
  from public, anon, authenticated;
revoke all on function private.initialize_spot_import_url_collection(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
revoke all on function private.commit_spot_import_crawl_page(uuid,uuid,uuid,uuid,boolean,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function private.commit_spot_import_extraction(uuid,uuid,uuid,uuid,boolean,jsonb,text)
  from public, anon, authenticated;
revoke all on function private.commit_spot_import_analysis_batch(uuid,uuid,uuid,uuid,boolean,jsonb,text)
  from public, anon, authenticated;

grant execute on function private.assert_spot_import_execution(uuid,uuid,uuid,text) to service_role;
grant execute on function private.claim_spot_import_url_batch(uuid,uuid,uuid,text,integer) to service_role;
grant execute on function private.initialize_spot_import_url_collection(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function private.commit_spot_import_crawl_page(uuid,uuid,uuid,uuid,boolean,text,text,jsonb) to service_role;
grant execute on function private.commit_spot_import_extraction(uuid,uuid,uuid,uuid,boolean,jsonb,text) to service_role;
grant execute on function private.commit_spot_import_analysis_batch(uuid,uuid,uuid,uuid,boolean,jsonb,text) to service_role;
