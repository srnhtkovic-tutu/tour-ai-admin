-- Persist sitemap files as a separate queue so URL discovery can continue across Cron runs.
create table if not exists private.spot_import_sitemaps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.spot_import_jobs(id) on delete cascade,
  sitemap_url text not null,
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  retry_count integer not null default 0 check (retry_count >= 0),
  processing_execution_id uuid,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, sitemap_url)
);
alter table private.spot_import_sitemaps enable row level security;
revoke all on table private.spot_import_sitemaps from public, anon, authenticated;
grant all on table private.spot_import_sitemaps to service_role;
create index if not exists idx_spot_import_sitemaps_pending
  on private.spot_import_sitemaps (job_id, status, created_at);

create or replace function private.initialize_spot_import_url_collection_v2(
  p_job_id uuid, p_execution_id uuid, p_lock_token uuid, p_urls jsonb
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
  perform private.assert_spot_import_execution(p_job_id, p_execution_id, p_lock_token, 'url_collection');
  if jsonb_typeof(coalesce(p_urls, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_urls, '[]'::jsonb)) > 2000 then
    raise exception 'invalid_url_collection_payload';
  end if;
  select j.region_id, r.allowed_domains into v_region_id, v_allowed_domains
  from public.spot_import_jobs j
  join public.regions r on r.id = j.region_id
  where j.id = p_job_id and r.is_active = true;
  if v_region_id is null then raise exception 'active_job_region_required'; end if;
  if exists (
    select 1 from private.spot_import_execution_logs l
    where l.job_id = p_job_id and l.stage = 'url_collection'
      and l.event_type = 'url_collection_initialized'
  ) then return 0; end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_urls, '[]'::jsonb))
  loop
    v_url := btrim(coalesce(v_item->>'url', ''));
    if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then
      raise exception 'invalid_discovered_url';
    end if;
    v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);
    if not exists (select 1 from unnest(v_allowed_domains) d(domain) where lower(d.domain) = v_host) then
      raise exception 'discovered_url_domain_not_allowed';
    end if;

    if coalesce(v_item->>'kind','page') = 'sitemap' then
      insert into private.spot_import_sitemaps(job_id, sitemap_url)
      values (p_job_id, v_url) on conflict (job_id, sitemap_url) do nothing;
    else
      insert into public.spot_import_urls (
        job_id, url, page_title, link_label, discovered_from_url,
        crawl_depth, priority, crawl_status
      ) values (
        p_job_id, v_url, nullif(v_item->>'page_title',''),
        nullif(v_item->>'link_label',''), nullif(v_item->>'discovered_from_url',''),
        greatest(0, coalesce((v_item->>'crawl_depth')::integer, 0)),
        coalesce((v_item->>'priority')::integer, 0), 'pending'
      ) on conflict (job_id, url) do nothing;
      if found then v_inserted := v_inserted + 1; end if;
    end if;
  end loop;

  perform private.write_spot_import_execution_log(
    'url_collection_initialized', p_job_id, p_execution_id, v_region_id,
    'url_collection', '開始URLとサイトマップ処理キューを登録',
    jsonb_build_object('submitted_count', jsonb_array_length(coalesce(p_urls, '[]'::jsonb)),
                       'page_urls_inserted', v_inserted)
  );
  return v_inserted;
end;
$function$;

create or replace function private.claim_spot_import_sitemap_batch(
  p_job_id uuid, p_execution_id uuid, p_lock_token uuid, p_limit integer
)
returns table(id uuid, sitemap_url text, retry_count integer)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_spot_import_execution(p_job_id, p_execution_id, p_lock_token, 'url_collection');
  if p_limit is null or p_limit < 1 or p_limit > 5 then raise exception 'invalid_sitemap_batch_limit'; end if;
  return query
  with picked as (
    select s.id from private.spot_import_sitemaps s
    where s.job_id = p_job_id
      and (s.status = 'pending' or (s.status = 'failed' and s.retry_count < 2))
    order by s.created_at asc, s.id asc
    limit p_limit
    for update skip locked
  )
  update private.spot_import_sitemaps s
  set processing_execution_id = p_execution_id, updated_at = now()
  from picked
  where s.id = picked.id
  returning s.id, s.sitemap_url, s.retry_count;
end;
$function$;

create or replace function private.commit_spot_import_sitemap(
  p_job_id uuid, p_execution_id uuid, p_lock_token uuid, p_sitemap_id uuid,
  p_success boolean, p_page_urls jsonb default '[]'::jsonb,
  p_sitemap_urls jsonb default '[]'::jsonb, p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_allowed_domains text[];
  v_item jsonb;
  v_url text;
  v_host text;
  v_pages integer := 0;
  v_sitemaps integer := 0;
begin
  perform private.assert_spot_import_execution(p_job_id, p_execution_id, p_lock_token, 'url_collection');
  if jsonb_typeof(coalesce(p_page_urls,'[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_sitemap_urls,'[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_page_urls,'[]'::jsonb)) > 10000
     or jsonb_array_length(coalesce(p_sitemap_urls,'[]'::jsonb)) > 1000 then
    raise exception 'invalid_sitemap_result_payload';
  end if;
  select r.allowed_domains into v_allowed_domains
  from public.spot_import_jobs j join public.regions r on r.id=j.region_id
  where j.id=p_job_id and r.is_active=true;
  if v_allowed_domains is null then raise exception 'active_job_region_required'; end if;
  perform 1 from private.spot_import_sitemaps s
  where s.id=p_sitemap_id and s.job_id=p_job_id
    and s.processing_execution_id=p_execution_id
  for update;
  if not found then raise exception 'sitemap_not_claimed_by_execution'; end if;

  if not p_success then
    update private.spot_import_sitemaps
    set status='failed', retry_count=retry_count+1,
        error_message=left(coalesce(p_error,'sitemap_fetch_failed'),2000),
        processing_execution_id=null, updated_at=now()
    where id=p_sitemap_id and job_id=p_job_id;
    return jsonb_build_object('status','failed','pages_added',0,'sitemaps_added',0);
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_page_urls,'[]'::jsonb))
  loop
    v_url := btrim(coalesce(v_item->>'url',''));
    if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then raise exception 'invalid_sitemap_page_url'; end if;
    v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);
    if not exists (select 1 from unnest(v_allowed_domains) d(domain) where lower(d.domain)=v_host) then
      raise exception 'sitemap_page_domain_not_allowed';
    end if;
    insert into public.spot_import_urls(job_id,url,link_label,discovered_from_url,crawl_depth,priority,crawl_status)
    values(p_job_id,v_url,'sitemap',null,1,50,'pending')
    on conflict(job_id,url) do nothing;
    if found then v_pages:=v_pages+1; end if;
  end loop;

  for v_item in select value from jsonb_array_elements(coalesce(p_sitemap_urls,'[]'::jsonb))
  loop
    v_url := btrim(coalesce(v_item->>'url',''));
    if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then raise exception 'invalid_child_sitemap_url'; end if;
    v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);
    if not exists (select 1 from unnest(v_allowed_domains) d(domain) where lower(d.domain)=v_host) then
      raise exception 'child_sitemap_domain_not_allowed';
    end if;
    insert into private.spot_import_sitemaps(job_id,sitemap_url)
    values(p_job_id,v_url) on conflict(job_id,sitemap_url) do nothing;
    if found then v_sitemaps:=v_sitemaps+1; end if;
  end loop;

  update private.spot_import_sitemaps
  set status='completed', error_message=null, processing_execution_id=null, updated_at=now()
  where id=p_sitemap_id and job_id=p_job_id;
  return jsonb_build_object('status','completed','pages_added',v_pages,'sitemaps_added',v_sitemaps);
end;
$function$;

revoke all on function private.claim_spot_import_sitemap_batch(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function private.commit_spot_import_sitemap(uuid,uuid,uuid,uuid,boolean,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function private.claim_spot_import_sitemap_batch(uuid,uuid,uuid,integer) to service_role;
grant execute on function private.commit_spot_import_sitemap(uuid,uuid,uuid,uuid,boolean,jsonb,jsonb,text) to service_role;

create or replace function public.worker_claim_sitemap_batch(
  p_job_id uuid,p_execution_id uuid,p_lock_token uuid,p_limit integer
)
returns table(id uuid,sitemap_url text,retry_count integer)
language plpgsql security definer set search_path=''
as $function$
begin
  if auth.role() <> 'service_role' then raise exception 'not_authorized'; end if;
  return query select * from private.claim_spot_import_sitemap_batch(p_job_id,p_execution_id,p_lock_token,p_limit);
end;
$function$;

create or replace function public.worker_commit_sitemap(
  p_job_id uuid,p_execution_id uuid,p_lock_token uuid,p_sitemap_id uuid,
  p_success boolean,p_page_urls jsonb default '[]'::jsonb,
  p_sitemap_urls jsonb default '[]'::jsonb,p_error text default null
)
returns jsonb
language plpgsql security definer set search_path=''
as $function$
begin
  if auth.role() <> 'service_role' then raise exception 'not_authorized'; end if;
  return private.commit_spot_import_sitemap(
    p_job_id,p_execution_id,p_lock_token,p_sitemap_id,p_success,p_page_urls,p_sitemap_urls,p_error
  );
end;
$function$;

revoke all on function public.worker_claim_sitemap_batch(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.worker_commit_sitemap(uuid,uuid,uuid,uuid,boolean,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.worker_claim_sitemap_batch(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.worker_commit_sitemap(uuid,uuid,uuid,uuid,boolean,jsonb,jsonb,text) to service_role;
