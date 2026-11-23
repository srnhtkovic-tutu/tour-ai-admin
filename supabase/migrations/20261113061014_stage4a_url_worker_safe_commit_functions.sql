
create or replace function private.is_spot_import_url_collection_initialized(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_spot_import_execution(
    p_job_id, p_execution_id, p_lock_token, 'url_collection'
  );

  return exists (
    select 1
    from private.spot_import_execution_logs l
    where l.job_id = p_job_id
      and l.stage = 'url_collection'
      and l.event_type = 'url_collection_initialized'
  );
end;
$function$;

create or replace function private.initialize_spot_import_url_collection_v2(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_urls jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
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

  -- A retry after a lost response must not repeat initialization or its log.
  if exists (
    select 1
    from private.spot_import_execution_logs l
    where l.job_id = p_job_id
      and l.stage = 'url_collection'
      and l.event_type = 'url_collection_initialized'
  ) then
    return 0;
  end if;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_urls, '[]'::jsonb))
  loop
    v_url := btrim(coalesce(v_item->>'url', ''));

    if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then
      raise exception 'invalid_discovered_url';
    end if;

    v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);

    if not exists (
      select 1
      from unnest(v_allowed_domains) d(domain)
      where lower(d.domain) = v_host
    ) then
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
    jsonb_build_object(
      'submitted_count', jsonb_array_length(coalesce(p_urls, '[]'::jsonb)),
      'inserted_count', v_inserted
    )
  );

  return v_inserted;
end;
$function$;

create or replace function private.commit_spot_import_crawl_page_v2(
  p_job_id uuid,
  p_execution_id uuid,
  p_lock_token uuid,
  p_url_id uuid,
  p_result_status text,
  p_page_title text default null,
  p_extracted_text text default null,
  p_error text default null,
  p_discovered_urls jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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

  if p_result_status not in ('fetched', 'failed', 'skipped') then
    raise exception 'invalid_crawl_result_status';
  end if;

  if p_result_status = 'fetched' then
    if jsonb_typeof(coalesce(p_discovered_urls, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(p_discovered_urls, '[]'::jsonb)) > 500 then
      raise exception 'invalid_discovered_urls_payload';
    end if;
    if length(coalesce(p_extracted_text, '')) > 12000 then
      raise exception 'extracted_text_too_long';
    end if;
  end if;

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

  if p_result_status = 'fetched' then
    update public.spot_import_urls
    set page_title = left(nullif(p_page_title, ''), 300),
        extracted_text = p_extracted_text,
        crawl_status = 'fetched',
        crawl_error = null,
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;

    for v_item in
      select value from jsonb_array_elements(coalesce(p_discovered_urls, '[]'::jsonb))
    loop
      v_url := btrim(coalesce(v_item->>'url', ''));

      if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then
        raise exception 'invalid_discovered_url';
      end if;

      v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);

      if not exists (
        select 1
        from unnest(v_allowed_domains) d(domain)
        where lower(d.domain) = v_host
      ) then
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

  elsif p_result_status = 'skipped' then
    update public.spot_import_urls
    set crawl_status = 'skipped',
        analysis_status = 'skipped',
        crawl_error = left(coalesce(p_error, 'skipped'), 2000),
        processing_execution_id = null,
        updated_at = now()
    where id = p_url_id and job_id = p_job_id;

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
    'result_status', p_result_status,
    'discovered_urls_added', v_added
  );
end;
$function$;

revoke all on function private.is_spot_import_url_collection_initialized(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.initialize_spot_import_url_collection_v2(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.commit_spot_import_crawl_page_v2(uuid, uuid, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function private.is_spot_import_url_collection_initialized(uuid, uuid, uuid) to service_role;
grant execute on function private.initialize_spot_import_url_collection_v2(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function private.commit_spot_import_crawl_page_v2(uuid, uuid, uuid, uuid, text, text, text, text, jsonb) to service_role;
