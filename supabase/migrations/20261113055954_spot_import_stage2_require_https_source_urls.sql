
create or replace function public.create_spot_import_job(
  p_region_id uuid,
  p_source_url text,
  p_max_facilities integer default 100,
  p_batch_size integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region public.regions%rowtype;
  v_host text;
  v_job_id uuid;
  v_url text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if p_region_id is null or not private.has_region_access(p_region_id) then
    raise exception 'region_access_denied';
  end if;

  select * into v_region
  from public.regions
  where id = p_region_id
  for share;

  if not found or not v_region.is_active then
    raise exception 'region_not_active';
  end if;

  v_url := btrim(coalesce(p_source_url, ''));

  if v_url = '' then
    raise exception 'source_url_required';
  end if;

  if p_max_facilities is null or p_max_facilities <= 0
     or p_batch_size is null or p_batch_size <= 0 then
    raise exception 'invalid_job_parameters';
  end if;

  if p_max_facilities > 10000 or p_batch_size > 1000 then
    raise exception 'job_parameters_too_large';
  end if;

  -- HTTPS only; host must exactly match the region allowlist.
  if v_url !~* '^https://[^/:?#]+(:[0-9]+)?([/?#]|$)' then
    raise exception 'invalid_source_url_https_required';
  end if;

  v_host := lower((regexp_match(v_url, '^https://([^/:?#]+)'))[1]);

  if not (v_host = any(v_region.allowed_domains)) then
    raise exception 'source_domain_not_allowed';
  end if;

  insert into public.spot_import_jobs (
    source_url, max_facilities, batch_size, status, region_id,
    current_stage, requested_action, requested_at, requested_by,
    queue_entered_at
  )
  values (
    v_url, p_max_facilities, p_batch_size, 'pending', p_region_id,
    'url_collection', 'start', now(), auth.uid(), now()
  )
  returning id into v_job_id;

  insert into private.spot_import_execution_logs (
    job_id, region_id, stage, event_type, actor_id, message, details
  )
  values (
    v_job_id, p_region_id, 'url_collection', 'job_created',
    auth.uid(), '地域担当者が収集ジョブを登録',
    jsonb_build_object(
      'source_url', v_url,
      'max_facilities', p_max_facilities,
      'batch_size', p_batch_size
    )
  );

  return jsonb_build_object(
    'job_id', v_job_id,
    'status', 'pending',
    'current_stage', 'url_collection'
  );
end;
$$;
