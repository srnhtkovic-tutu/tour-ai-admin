
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
as $function$
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
       or jsonb_array_length(coalesce(p_candidates, '[]'::jsonb)) > 200 then
      raise exception 'invalid_extraction_payload';
    end if;

    delete from public.spot_import_page_candidates
    where job_id = p_job_id and source_url_id = p_url_id;

    for v_item in
      select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
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
$function$;

create or replace function public.worker_commit_extraction(
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

  return private.commit_spot_import_extraction(
    p_job_id, p_execution_id, p_lock_token, p_url_id,
    p_success, p_candidates, p_error
  );
end;
$function$;

revoke all on function public.worker_commit_extraction(uuid,uuid,uuid,uuid,boolean,jsonb,text) from public, anon, authenticated;
grant execute on function public.worker_commit_extraction(uuid,uuid,uuid,uuid,boolean,jsonb,text) to service_role;
