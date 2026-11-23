-- Read-only policies needed by the first authenticated admin screens.
-- Writes to administration tables remain unavailable to browser clients.

create or replace function private.is_system_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = (select auth.uid()) and p.is_active and p.is_system_admin
  );
$$;

create or replace function private.has_region_access(p_region_id uuid)
returns boolean
language sql stable security definer
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

revoke all on function private.is_system_admin() from public, anon;
revoke all on function private.has_region_access(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_system_admin() to authenticated;
grant execute on function private.has_region_access(uuid) to authenticated;

drop policy if exists user_profiles_select_self_or_admin on public.user_profiles;
create policy user_profiles_select_self_or_admin on public.user_profiles
for select to authenticated
using (id = (select auth.uid()) or private.is_system_admin());

drop policy if exists user_regions_select_self_or_admin on public.user_regions;
create policy user_regions_select_self_or_admin on public.user_regions
for select to authenticated
using (user_id = (select auth.uid()) or private.is_system_admin());

drop policy if exists regions_select_assigned on public.regions;
create policy regions_select_assigned on public.regions
for select to authenticated
using (private.is_system_admin() or (is_active and private.has_region_access(id)));

grant select on public.user_profiles to authenticated;
grant select on public.user_regions to authenticated;
grant select on public.regions to authenticated;
