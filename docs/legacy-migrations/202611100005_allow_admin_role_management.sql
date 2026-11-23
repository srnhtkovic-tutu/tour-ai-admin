-- Allow active system administrators to grant/revoke the system-admin flag.
-- The existing RLS update policy limits this to system administrators and
-- the trigger prevents removal of the final active system administrator.
grant update (is_system_admin) on public.user_profiles to authenticated;
