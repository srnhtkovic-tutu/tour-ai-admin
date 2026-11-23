create or replace function public.list_spot_import_jobs(p_region_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_jobs jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  if p_region_id is null or not private.has_region_access(p_region_id) then
    raise exception 'region_access_denied';
  end if;

  if not exists (
    select 1 from public.regions r
    where r.id = p_region_id and r.is_active
  ) then
    raise exception 'region_not_active';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', j.id,
        'source_url', j.source_url,
        'max_facilities', j.max_facilities,
        'batch_size', j.batch_size,
        'status', j.status,
        'current_stage', j.current_stage,
        'requested_action', j.requested_action,
        'final_outcome', j.final_outcome,
        'last_error', j.last_error,
        'created_at', j.created_at,
        'updated_at', j.updated_at
      ) order by j.created_at desc
    ),
    '[]'::jsonb
  )
  into v_jobs
  from (
    select *
    from public.spot_import_jobs
    where region_id = p_region_id
    order by created_at desc
    limit 50
  ) j;

  return v_jobs;
end;
$function$;

revoke all on function public.list_spot_import_jobs(uuid) from public;
grant execute on function public.list_spot_import_jobs(uuid) to authenticated;
