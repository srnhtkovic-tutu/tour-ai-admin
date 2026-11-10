-- Tabitsuzuki admin foundation (additive phase).
-- This migration intentionally does not change existing access policies or
-- make existing columns NOT NULL. The current published admin UI is still
-- unauthenticated; security lockdown follows after the authenticated UI is ready.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

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

-- Nullable during the compatibility period. The authenticated app migration
-- will enforce NOT NULL after all writes include a server-validated region.
alter table public.spots add column if not exists region_id uuid references public.regions(id) on delete restrict;
update public.spots
set region_id = (select id from public.regions where slug = 'higashiomi')
where region_id is null;

alter table public.spot_import_jobs add column if not exists region_id uuid references public.regions(id) on delete restrict;
update public.spot_import_jobs
set region_id = (select id from public.regions where slug = 'higashiomi')
where region_id is null and source_url like 'https://www.higashiomi.net/%';
create index if not exists spot_import_jobs_region_id_idx on public.spot_import_jobs(region_id);

-- Create an inactive-by-default profile for each newly registered Auth user.
-- A system administrator must explicitly activate/assign the account.
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

revoke all on function private.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function private.handle_new_auth_user();

-- New admin tables are closed to browser access until the corresponding
-- authenticated screens and region-aware policies are deployed.
alter table public.regions enable row level security;
alter table public.user_profiles enable row level security;
alter table public.user_regions enable row level security;
alter table public.spot_operation_logs enable row level security;
