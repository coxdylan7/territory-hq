-- Territory HQ — first security phase: remove Data API access to public tables.
--
-- The application talks to Supabase Postgres over the server-side DATABASE_URL
-- connection (Postgres.js), using the postgres role. That role is intentionally
-- not touched here. The Data API roles (anon and authenticated) get no
-- privileges on application tables.
--
-- Grants and RLS are separate controls. This migration applies both, but only
-- to the 15 known application tables. Unrelated public objects (for example,
-- extension tables or functions) are deliberately left alone. Portal tables are
-- created by 20240921000000_portal.sql, which runs before this migration, so a
-- fresh install already has all 15 tables here. Every statement is idempotent.

-- RLS and table revokes for the known app tables. Tables that do not exist are
-- skipped, so REVOKE is never issued against a missing table. FORCE also
-- applies RLS to the table owner; on Supabase the server-side postgres role has
-- BYPASSRLS, so DATABASE_URL access is preserved.
-- The role list is built from pg_roles so plain Postgres without Supabase's
-- Data API roles can run this too.
do $$
declare
  app_table text;
  api_roles text;
begin
  select string_agg(format('%I', rolname), ', ' order by rolname)
    into api_roles
    from pg_catalog.pg_roles
   where rolname in ('anon', 'authenticated');

  foreach app_table in array array[
    'users', 'sessions', 'accounts', 'expenses', 'settings', 'ocm_seen',
    'kv', 'route_log', 'credits', 'messages', 'portal_users',
    'portal_sessions', 'portal_invites', 'event_types', 'bookings'
  ]::text[]
  loop
    -- A managed table may be absent; REVOKE on a missing table would error.
    if to_regclass(format('public.%I', app_table)) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', app_table);
    execute format('alter table public.%I force row level security', app_table);
    if api_roles is not null then
      execute format('revoke all on table public.%I from %s', app_table, api_roles);
    end if;
  end loop;
end
$$;

-- No blanket revokes on all public tables, sequences, or functions: extensions
-- may own objects there. This app defines no SQL functions or sequences, so
-- there are no existing function/sequence privileges to remove. The default
-- privileges below cover future objects only.

-- Future objects created by postgres in public must be explicitly granted
-- before they are visible to the Data API. Only revoke from Data API roles that
-- exist so this migration also runs on plain PostgreSQL and partial installs.
do $$
declare
  api_role text;
  object_kind text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role']::text[]
  loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = api_role) then
      foreach object_kind in array array['tables', 'sequences', 'functions']::text[]
      loop
        execute format(
          'alter default privileges for role postgres in schema public revoke all on %s from %I',
          object_kind,
          api_role
        );
      end loop;
    end if;
  end loop;
end
$$;

-- Postgres grants EXECUTE to PUBLIC on new functions by default. Remove that
-- default for future public functions only; existing (possibly extension)
-- functions are not touched.
alter default privileges for role postgres in schema public
  revoke execute on functions from public;
