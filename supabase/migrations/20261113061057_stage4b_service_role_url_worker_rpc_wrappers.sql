
create or replace function public.worker_is_url_collection_initialized(
  p_job_id uuid, p_execution_id uuid, p_lock_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  return private.is_spot_import_url_collection_initialized(
    p_job_id, p_execution_id, p_lock_token
  );
end;
$function$;

create or replace function public.worker_initialize_url_collection(
  p_job_id uuid, p_execution_id uuid, p_lock_token uuid, p_urls jsonb
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
  return private.initialize_spot_import_url_collection_v2(
    p_job_id, p_execution_id, p_lock_token, p_urls
  );
end;
$function$;

create or replace function public.worker_claim_url_batch(
  p_job_id uuid, p_execution_id uuid, p_lock_token uuid,
  p_stage text, p_limit integer
)
returns table(
  id uuid, url text, page_title text, link_label text,
  crawl_depth integer, priority integer, extracted_text text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  return query
  select c.id, c.url, c.page_title, c.link_label,
         c.crawl_depth, c.priority, c.extracted_text
  from private.claim_spot_import_url_batch(
    p_job_id, p_execution_id, p_lock_token, p_stage, p_limit
  ) c;
end;
$function$;

create or replace function public.worker_commit_crawl_page(
  p_job_id uuid, p_execution_id uuid, p_lock_token uuid,
  p_url_id uuid, p_result_status text,
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
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  return private.commit_spot_import_crawl_page_v2(
    p_job_id, p_execution_id, p_lock_token, p_url_id,
    p_result_status, p_page_title, p_extracted_text, p_error,
    p_discovered_urls
  );
end;
$function$;

revoke all on function public.worker_is_url_collection_initialized(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.worker_initialize_url_collection(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.worker_claim_url_batch(uuid,uuid,uuid,text,integer) from public, anon, authenticated;
revoke all on function public.worker_commit_crawl_page(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) from public, anon, authenticated;

grant execute on function public.worker_is_url_collection_initialized(uuid,uuid,uuid) to service_role;
grant execute on function public.worker_initialize_url_collection(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.worker_claim_url_batch(uuid,uuid,uuid,text,integer) to service_role;
grant execute on function public.worker_commit_crawl_page(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) to service_role;
