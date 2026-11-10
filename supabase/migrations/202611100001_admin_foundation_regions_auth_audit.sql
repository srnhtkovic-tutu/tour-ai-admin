-- Tabitsuzuki admin foundation: regions, users, region assignments, and audit log.
-- Existing importer records are preserved and associated with Higashiomi based on their source URL.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists public.regions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint regions_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]*$')
);

insert into public.regions (slug, name)
values ('higashiomi', '東近江市')
on conflict (slug) do update set name = excluded.name;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_active boolean not null default true,
  is_system_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_regions (
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  region_id uuid not null references public.regions(id) on delete restrict,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (user_id, region_id)
);

create table if not exists public.spot_operation_logs (
  id bigint generated always as identity primary key,
  region_id uuid references public.regions(id) on delete set null,
  from_region_id uuid references public.regions(id) on delete set null,
  to_region_id uuid references public.regions(id) on delete set null,
  spot_id bigint,
  spot_name text not null,
  operation_type text not null check (
    operation_type in ('register', 'update', 'approve', 'hide', 'republish', 'delete', 'transfer')
  ),
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  constraint spot_operation_logs_transfer_regions check (
    operation_type <> 'transfer'
    or (from_region_id is not null and to_region_id is not null)
  )
);

create index if not exists user_regions_region_id_idx on public.user_regions(region_id);
create index if not exists spot_operation_logs_region_created_idx on public.spot_operation_logs(region_id, created_at desc);
create index if not exists spot_operation_logs_from_region_created_idx on public.spot_operation_logs(from_region_id, created_at desc);
create index if not exists spot_operation_logs_to_region_created_idx on public.spot_operation_logs(to_region_id, created_at desc);
create index if not exists spot_operation_logs_spot_id_idx on public.spot_operation_logs(spot_id);

alter table public.spots add column if not exists region_id uuid references public.regions(id) on delete restrict;
update public.spots
set region_id = (select id from public.regions where slug = 'higashiomi')
where region_id is null;
alter table public.spots alter column region_id set not null;

alter table public.spot_import_jobs add column if not exists region_id uuid references public.regions(id) on delete restrict;
update public.spot_import_jobs
set region_id = (select id from public.regions where slug = 'higashiomi')
where region_id is null and source_url like 'https://www.higashiomi.net/%';
do $$
begin
  if exists (select 1 from public.spot_import_jobs where region_id is null) then
    raise exception 'Some import jobs have no region_id; assign them before making region_id required.';
  end if;
end $$;
alter table public.spot_import_jobs alter column region_id set not null;
create index if not exists spot_import_jobs_region_id_idx on public.spot_import_jobs(region_id);

create or replace function private.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = (select auth.uid()) and p.is_active
  );
$$;

create or replace function private.is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = (select auth.uid()) and p.is_active and p.is_system_admin
  );
$$;

create or replace function private.has_region_access(p_region_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_profiles p
    join public.user_regions ur on ur.user_id = p.id
    where p.id = (select auth.uid())
      and p.is_active
      and ur.region_id = p_region_id
  );
$$;

create or replace function private.can_access_region_folder(p_region_folder text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_profiles p
    join public.user_regions ur on ur.user_id = p.id
    where p.id = (select auth.uid())
      and p.is_active
      and ur.region_id::text = p_region_folder
  );
$$;

revoke all on function private.is_active_user() from public, anon;
revoke all on function private.is_system_admin() from public, anon;
revoke all on function private.has_region_access(uuid) from public, anon;
revoke all on function private.can_access_region_folder(text) from public, anon;
grant execute on function private.is_active_user() to authenticated;
grant execute on function private.is_system_admin() to authenticated;
grant execute on function private.has_region_access(uuid) to authenticated;
grant execute on function private.can_access_region_folder(text) to authenticated;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, display_name)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function private.handle_new_auth_user();

alter table public.regions enable row level security;
alter table public.user_profiles enable row level security;
alter table public.user_regions enable row level security;
alter table public.spot_operation_logs enable row level security;
alter table public.spots enable row level security;

drop policy if exists regions_select_assigned on public.regions;
create policy regions_select_assigned on public.regions
for select to authenticated
using (private.is_system_admin() or (is_active and private.has_region_access(id)));

drop policy if exists user_profiles_select_self_or_admin on public.user_profiles;
create policy user_profiles_select_self_or_admin on public.user_profiles
for select to authenticated
using (
  (id = (select auth.uid()) and private.is_active_user())
  or private.is_system_admin()
);

drop policy if exists user_regions_select_self_or_admin on public.user_regions;
create policy user_regions_select_self_or_admin on public.user_regions
for select to authenticated
using (
  (user_id = (select auth.uid()) and private.is_active_user())
  or private.is_system_admin()
);

drop policy if exists spots_public_read on public.spots;
create policy spots_public_read on public.spots
for select to anon using (true);

drop policy if exists spots_region_read on public.spots;
create policy spots_region_read on public.spots
for select to authenticated
using (private.is_system_admin() or private.has_region_access(region_id));

drop policy if exists spot_operation_logs_region_read on public.spot_operation_logs;
create policy spot_operation_logs_region_read on public.spot_operation_logs
for select to authenticated
using (
  private.is_system_admin()
  or private.has_region_access(region_id)
  or private.has_region_access(from_region_id)
  or private.has_region_access(to_region_id)
);

-- The import pipeline remains server-controlled. Authenticated users can read only
-- records belonging to regions assigned to them; writes stay with trusted server jobs.
drop policy if exists spot_import_jobs_region_read on public.spot_import_jobs;
create policy spot_import_jobs_region_read on public.spot_import_jobs
for select to authenticated
using (private.is_system_admin() or private.has_region_access(region_id));

drop policy if exists spot_import_urls_region_read on public.spot_import_urls;
create policy spot_import_urls_region_read on public.spot_import_urls
for select to authenticated
using (
  exists (
    select 1 from public.spot_import_jobs j
    where j.id = spot_import_urls.job_id
      and (private.is_system_admin() or private.has_region_access(j.region_id))
  )
);

drop policy if exists spot_import_candidates_region_read on public.spot_import_candidates;
create policy spot_import_candidates_region_read on public.spot_import_candidates
for select to authenticated
using (
  exists (
    select 1 from public.spot_import_jobs j
    where j.id = spot_import_candidates.job_id
      and (private.is_system_admin() or private.has_region_access(j.region_id))
  )
);

drop policy if exists spot_import_page_candidates_region_read on public.spot_import_page_candidates;
create policy spot_import_page_candidates_region_read on public.spot_import_page_candidates
for select to authenticated
using (
  exists (
    select 1 from public.spot_import_jobs j
    where j.id = spot_import_page_candidates.job_id
      and (private.is_system_admin() or private.has_region_access(j.region_id))
  )
);

drop policy if exists spot_import_merged_v2_region_read on public.spot_import_merged_v2;
create policy spot_import_merged_v2_region_read on public.spot_import_merged_v2
for select to authenticated
using (
  exists (
    select 1 from public.spot_import_jobs j
    where j.id = spot_import_merged_v2.job_id
      and (private.is_system_admin() or private.has_region_access(j.region_id))
  )
);

-- Remove broad public access to usage logs. Tourist clients may submit logs but cannot read or alter them.
drop policy if exists usage_logs_select on public.usage_logs;
drop policy if exists usage_logs_update on public.usage_logs;
revoke all on public.usage_logs from anon, authenticated;
grant insert on public.usage_logs to anon, authenticated;
grant usage, select on sequence public.usage_logs_id_seq to anon, authenticated;

-- Storage uploads must be authenticated and scoped to a region folder: <region-uuid>/<filename>.
drop policy if exists "spot_images_insert a3ji5f_0" on storage.objects;
drop policy if exists spot_images_region_insert on storage.objects;
create policy spot_images_region_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'spot-images'
  and private.can_access_region_folder((storage.foldername(name))[1])
);

-- No browser-side writes to spots or audit logs yet. Those will be added through
-- transactional database functions in the next implementation stage.
revoke all on public.spots from anon, authenticated;
grant select on public.spots to anon, authenticated;
revoke all on public.regions from anon, authenticated;
grant select on public.regions to authenticated;
revoke all on public.user_profiles from anon, authenticated;
grant select on public.user_profiles to authenticated;
revoke all on public.user_regions from anon, authenticated;
grant select on public.user_regions to authenticated;
revoke all on public.spot_operation_logs from anon, authenticated;
grant select on public.spot_operation_logs to authenticated;
revoke all on public.spot_import_jobs from anon, authenticated;
grant select on public.spot_import_jobs to authenticated;
revoke all on public.spot_import_urls from anon, authenticated;
grant select on public.spot_import_urls to authenticated;
revoke all on public.spot_import_candidates from anon, authenticated;
grant select on public.spot_import_candidates to authenticated;
revoke all on public.spot_import_page_candidates from anon, authenticated;
grant select on public.spot_import_page_candidates to authenticated;
revoke all on public.spot_import_merged_v2 from anon, authenticated;
grant select on public.spot_import_merged_v2 to authenticated;
revoke all on public.spot_import_merged from anon, authenticated;
