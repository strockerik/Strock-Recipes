-- New profiles wait for the owner's approval (v2.3).
-- Run once in the Supabase SQL editor, BEFORE redeploying kroger and extract-recipe.
-- Safe to run twice: it never approves anyone who already has a row.
--
-- To approve someone: Table Editor -> member_requests -> set approved to true.
-- To refuse someone: Authentication -> Users -> delete the user.
--
-- Accounts confirmed before v2.2 opened sign-ups are approved here. Anyone who joined
-- after that starts out waiting, so you decide on them too.
--
-- Until approved, a person can sign in and see the waiting screen, but can't read or
-- write personal data, use the AI features, use King Soopers, change the bottle
-- catalog, or look up other members. Bottle scores (spirit_consensus) stay readable:
-- a materialized view can't carry row-level security, and it holds no personal data.
--
-- A table added later is covered only if this script is run again after it exists.
--
-- Off switch, which lets every account back in without undoing anything else:
--   create or replace function public.is_approved_member()
--     returns boolean language sql stable as 'select true';
begin;

create table if not exists public.member_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email text,
  approved boolean not null default false,
  requested_at timestamptz not null default now()
);
alter table public.member_requests enable row level security;  -- no policies: admin only
revoke all on public.member_requests from anon, authenticated;

create or replace function public.is_approved_member()
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select approved from public.member_requests where user_id = auth.uid()), false);
$$;
revoke execute on function public.is_approved_member() from public, anon;
grant execute on function public.is_approved_member() to authenticated, service_role;

-- Every new account gets a row, waiting.
create schema if not exists private;
create or replace function private.add_member_request()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.member_requests (user_id, display_name, email)
  values (new.id, left(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 40), new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke execute on function private.add_member_request() from public, anon, authenticated;
drop trigger if exists member_request_on_signup on auth.users;
create trigger member_request_on_signup
  after insert on auth.users
  for each row execute function private.add_member_request();

-- Accounts from before open sign-up (v2.2, 2026-11-21 22:25 MT) are already trusted.
insert into public.member_requests (user_id, display_name, email, approved, requested_at)
select u.id,
       left(coalesce(nullif(btrim(p.display_name), ''), split_part(u.email, '@', 1)), 40),
       u.email,
       u.email_confirmed_at is not null and u.created_at < timestamptz '2026-11-21 22:25:19-07',
       u.created_at
from auth.users u
left join public.profiles p on p.id = u.id
on conflict (user_id) do nothing;

-- Tables: on top of each table's own rules, the reader must be approved.
do $$
declare t text;
begin
  for t in
    select distinct tablename from pg_policies
    where schemaname = 'public' and tablename <> 'member_requests'
  loop
    execute format('drop policy if exists "approved members only" on public.%I', t);
    execute format(
      'create policy "approved members only" on public.%I as restrictive for all to authenticated
         using ((select public.is_approved_member()))
         with check ((select public.is_approved_member()))', t);
  end loop;
end $$;

-- Functions that run with admin rights skip table policies, so what they write is
-- checked here. Edge Functions' own admin calls have no signed-in user and pass.
create or replace function private.require_approved_member()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.is_approved_member() then
    raise exception 'This profile is waiting for approval' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function private.require_approved_member() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['ai_usage', 'bottle_usage', 'coach_usage', 'extraction_usage',
                           'generation_usage', 'pairing_usage', 'ai_calls', 'spirit_aliases']
  loop
    execute format('drop trigger if exists require_approved_member on public.%I', t);
    execute format('create trigger require_approved_member before insert or update on public.%I
                    for each row execute function private.require_approved_member()', t);
  end loop;
end $$;

-- The two lookups that read other people's details.
create or replace function public.lookup_user_id_by_email(lookup_email text)
returns uuid
language sql security definer set search_path = '' as $$
  select u.id from auth.users u
  where (select public.is_approved_member()) and lower(u.email) = lower(lookup_email)
  limit 1;
$$;

create or replace function public.my_people()
returns table(id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name
  from public.profiles p
  where (select public.is_approved_member())
    and (p.id = auth.uid()
     or p.id in (select s.shared_with_user_id from public.recipe_shares s where s.shared_by_user_id = auth.uid())
     or p.id in (select s.shared_by_user_id from public.recipe_shares s where s.shared_with_user_id = auth.uid()));
$$;

commit;

select count(*) filter (where approved) as approved_members,
       count(*) filter (where not approved) as waiting_for_approval
from public.member_requests;
