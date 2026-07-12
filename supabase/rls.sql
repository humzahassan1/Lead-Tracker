-- Lead Tracker row-level security
-- Run in Supabase SQL Editor after creating properties + leads tables.
--
-- Auth model: Microsoft OAuth user IDs stored in user_id (text), not auth.users.
-- The Express API uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
-- These policies block direct PostgREST access via the public anon key.

alter table properties enable row level security;
alter table leads enable row level security;

-- Deny all anon access (forces clients through the Express API)
drop policy if exists "deny_anon_properties" on properties;
create policy "deny_anon_properties"
  on properties
  as restrictive
  for all
  to anon
  using (false)
  with check (false);

drop policy if exists "deny_anon_leads" on leads;
create policy "deny_anon_leads"
  on leads
  as restrictive
  for all
  to anon
  using (false)
  with check (false);

-- Defense-in-depth for authenticated role (if Supabase Auth is added later)
drop policy if exists "users_own_properties" on properties;
create policy "users_own_properties"
  on properties
  for all
  to authenticated
  using (user_id = (auth.jwt() ->> 'sub'))
  with check (user_id = (auth.jwt() ->> 'sub'));

drop policy if exists "users_own_leads" on leads;
create policy "users_own_leads"
  on leads
  for all
  to authenticated
  using (user_id = (auth.jwt() ->> 'sub'))
  with check (user_id = (auth.jwt() ->> 'sub'));
