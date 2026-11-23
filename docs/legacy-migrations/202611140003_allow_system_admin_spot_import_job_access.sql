-- Allow system administrators to access spot import jobs in every active region.
-- Ordinary users remain restricted to their assigned regions.

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.list_spot_import_jobs(uuid)'::regprocedure)
    into v_def;
  if position('if p_region_id is null or not private.has_region_access(p_region_id) then' in v_def) = 0 then
    raise exception 'Expected authorization check not found in list_spot_import_jobs';
  end if;
  v_def := replace(
    v_def,
    'if p_region_id is null or not private.has_region_access(p_region_id) then',
    'if p_region_id is null or not (private.is_system_admin() or private.has_region_access(p_region_id)) then'
  );
  execute v_def;

  select pg_get_functiondef('public.create_spot_import_job(uuid,text,integer,integer)'::regprocedure)
    into v_def;
  if position('if p_region_id is null or not private.has_region_access(p_region_id) then' in v_def) = 0 then
    raise exception 'Expected authorization check not found in create_spot_import_job';
  end if;
  v_def := replace(
    v_def,
    'if p_region_id is null or not private.has_region_access(p_region_id) then',
    'if p_region_id is null or not (private.is_system_admin() or private.has_region_access(p_region_id)) then'
  );
  execute v_def;

  select pg_get_functiondef('public.request_spot_import_job_action(uuid,text)'::regprocedure)
    into v_def;
  if position('or not private.has_region_access(v_job.region_id) then' in v_def) = 0 then
    raise exception 'Expected authorization check not found in request_spot_import_job_action';
  end if;
  v_def := replace(
    v_def,
    'or not private.has_region_access(v_job.region_id) then',
    'or not (private.is_system_admin() or private.has_region_access(v_job.region_id)) then'
  );
  execute v_def;
end
$$;
