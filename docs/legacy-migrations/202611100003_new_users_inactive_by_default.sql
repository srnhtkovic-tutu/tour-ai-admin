-- New Auth accounts must be explicitly enabled by a system administrator.
alter table public.user_profiles alter column is_active set default false;
