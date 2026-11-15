-- House Index: print the live database's schema (public, plus the private helper
-- functions the sharing policies call) as ONE replayable SQL script.
-- Read-only (it only reads the system catalogs). In the Supabase SQL editor, run it,
-- copy the single "schema" cell, and paste it straight into supabase/schema.sql in
-- your editor. Not through a chat window: its formatting drops "*" pairs and joins
-- lines, which breaks count(*) and any line after a -- comment.
-- Order: extensions, tables (without foreign keys), RLS, functions, views, indexes,
-- foreign keys, policies, triggers, then function/view grants — so the output can
-- be replayed on an empty project. Table privileges are Supabase's defaults (RLS
-- decides access); the pg_cron schedule is in supabase/sql/v1.9-part2.sql.
with
tbl as (
  select c.oid, c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
cols as (
  select t.relname,
         string_agg(format('  %I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                           case when a.attnotnull then ' not null' else '' end,
                           coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')),
                    E',\n' order by a.attnum) as body
  from tbl t
  join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
  group by t.relname
),
cons as (   -- primary keys, uniques and checks inline; foreign keys come later
  select t.relname,
         string_agg(format('  constraint %I %s', co.conname, pg_get_constraintdef(co.oid)),
                    E',\n' order by co.contype, co.conname) as body
  from tbl t join pg_constraint co on co.conrelid = t.oid
  where co.contype in ('p', 'u', 'c')
  group by t.relname
),
fns as (    -- public functions, and the private helpers the sharing policies call
  select p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind = 'f'
    and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')  -- not an extension's
),
parts as (
  select 0 as ord, e.extname as name,
         format('create extension if not exists %I with schema %I;', e.extname, en.nspname) as sql
    from pg_extension e join pg_namespace en on en.oid = e.extnamespace
   where e.extname not in ('plpgsql')
  union all
  select 0, '~' || nspname, format('create schema if not exists %I;', nspname)
    from pg_namespace where nspname = 'private'
  union all
  select 1, c.relname, format(E'create table if not exists public.%I (\n%s%s\n);', c.relname, c.body, coalesce(E',\n' || k.body, ''))
    from cols c left join cons k using (relname)
  union all
  select 2, relname, format('alter table public.%I enable row level security;', relname)
    from tbl where relrowsecurity
  union all
  select 3, nspname || '.' || proname || '(' || args || ')', pg_get_functiondef(oid) || ';'
    from fns
  union all
  select 4, viewname, format(E'create or replace view public.%I as\n%s', viewname, definition)
    from pg_views where schemaname = 'public'
  union all
  select 4, matviewname, format(E'create materialized view if not exists public.%I as\n%s', matviewname, definition)
    from pg_matviews where schemaname = 'public'
  union all
  select 5, i.indexname, regexp_replace(i.indexdef, '^CREATE (UNIQUE )?INDEX ', 'CREATE \1INDEX IF NOT EXISTS ')
                          || ';'
    from pg_indexes i
   where i.schemaname = 'public'
     and not exists (select 1 from pg_constraint co where co.conname = i.indexname)
  union all
  select 6, t.relname || '.' || co.conname,
         format('alter table public.%I add constraint %I %s;', t.relname, co.conname, pg_get_constraintdef(co.oid))
    from tbl t join pg_constraint co on co.conrelid = t.oid
   where co.contype = 'f'
  union all
  select 7, pol.tablename || '.' || pol.policyname,
         format(E'create policy %I on public.%I as %s for %s to %s%s%s;',
                pol.policyname, pol.tablename, lower(pol.permissive), lower(pol.cmd),
                array_to_string(pol.roles, ', '),
                coalesce(E'\n  using (' || pol.qual || ')', ''),
                coalesce(E'\n  with check (' || pol.with_check || ')', ''))
    from pg_policies pol where pol.schemaname = 'public'
  union all
  select 8, tg.tgname, pg_get_triggerdef(tg.oid) || ';'
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where not tg.tgisinternal and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))
  union all
  select 9, f.nspname || '.' || f.proname || '(' || f.args || ')',
         format('revoke execute on function %I.%I(%s) from public;', f.nspname, f.proname, f.args)
         || coalesce((select string_agg(format(E'\ngrant execute on function %I.%I(%s) to %I;', f.nspname, f.proname, f.args, r.rolname), '')
                        from aclexplode(f.proacl) acl join pg_roles r on r.oid = acl.grantee
                       where acl.privilege_type = 'EXECUTE' and r.rolname in ('anon', 'authenticated', 'service_role')), '')
    from fns f
  union all
  select 9, c.relname,   -- a materialized view has no RLS: who may read it is its grants
         format('revoke all on public.%I from public, anon;', c.relname)
         || coalesce((select string_agg(format(E'\ngrant select on public.%I to %I;', c.relname, r.rolname), '')
                        from aclexplode(c.relacl) acl join pg_roles r on r.oid = acl.grantee
                       where acl.privilege_type = 'SELECT' and r.rolname in ('authenticated', 'service_role')), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'm'
)
select '-- House Index schema, exported ' || to_char(now(), 'YYYY-MM-DD') || E' (supabase/sql/export_schema.sql)\n\n'
       || string_agg(sql, E'\n\n' order by ord, name) as schema
from parts;
