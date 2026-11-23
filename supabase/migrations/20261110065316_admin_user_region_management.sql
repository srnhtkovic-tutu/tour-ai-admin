-- System administrator management permissions and profile email snapshots.
-- All writes are restricted to active system administrators.

alter table public.user_profiles add column if not exists email text;

create or replace function private.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'name', '')), '')
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

revoke all on function private.sync_auth_user_profile() from public, anon, authenticated;
drop trigger if exists on_auth_user_sync_profile on auth.users;
create trigger on_auth_user_sync_profile
after insert or update of email on auth.users
for each row execute function private.sync_auth_user_profile();

update public.user_profiles p
set email = u.email, updated_at = now()
from auth.users u
where u.id = p.id and p.email is distinct from u.email;

create or replace function private.prevent_last_system_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_active and old.is_system_admin
     and (not new.is_active or not new.is_system_admin) then
    if not exists (
      select 1
      from public.user_profiles other_admin
      where other_admin.id <> old.id
        and other_admin.is_active
        and other_admin.is_system_admin
    ) then
      raise exception '最後の有効なシステム管理者は無効化・降格できません';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_last_system_admin_removal() from public, anon, authenticated;
drop trigger if exists prevent_last_system_admin_removal on public.user_profiles;
create trigger prevent_last_system_admin_removal
before update of is_active, is_system_admin on public.user_profiles
for each row execute function private.prevent_last_system_admin_removal();

drop policy if exists regions_insert_admin on public.regions;
create policy regions_insert_admin on public.regions
for insert to authenticated
with check (private.is_system_admin());

drop policy if exists regions_update_admin on public.regions;
create policy regions_update_admin on public.regions
for update to authenticated
using (private.is_system_admin())
with check (private.is_system_admin());

drop policy if exists user_profiles_update_admin on public.user_profiles;
create policy user_profiles_update_admin on public.user_profiles
for update to authenticated
using (private.is_system_admin())
with check (private.is_system_admin());

drop policy if exists user_regions_insert_admin on public.user_regions;
create policy user_regions_insert_admin on public.user_regions
for insert to authenticated
with check (private.is_system_admin());

drop policy if exists user_regions_delete_admin on public.user_regions;
create policy user_regions_delete_admin on public.user_regions
for delete to authenticated
using (private.is_system_admin());

grant insert, update on public.regions to authenticated;
grant update (display_name, is_active, updated_at) on public.user_profiles to authenticated;
grant insert, delete on public.user_regions to authenticated;
