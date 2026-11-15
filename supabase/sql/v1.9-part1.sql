-- House Index v1.9, part 1 of 2. Run in the Supabase SQL editor BEFORE deploying
-- the v1.9 Edge Functions (they call what this creates, and refuse paid calls if
-- a cap can't be checked). Safe to run twice.

-- 1. Daily caps for the two AI calls that had none: recipe ideas (generate-recipe,
--    "concepts") and cocktail pairing options (pair-drink). Same shape as
--    bottle_usage; the limit lives in each function.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  kind text not null,
  count int not null default 0,
  primary key (user_id, usage_date, kind)
);
alter table public.ai_usage enable row level security;
drop policy if exists "users see their ai usage" on public.ai_usage;
create policy "users see their ai usage" on public.ai_usage for select to authenticated
  using (user_id = auth.uid());

create or replace function public.increment_ai_usage(usage_kind text, daily_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count int;
begin
  insert into public.ai_usage as au (user_id, usage_date, kind, count)
  values (auth.uid(), (now() at time zone 'utc')::date, usage_kind, 1)
  on conflict (user_id, usage_date, kind) do update
    set count = au.count + 1
    where au.count < daily_limit
  returning au.count into updated_count;

  if updated_count is null then
    return -1; -- already at/over the limit, not incremented
  end if;
  return updated_count;
end;
$$;
revoke execute on function public.increment_ai_usage(text, int) from public;
revoke execute on function public.increment_ai_usage(text, int) from anon;
grant execute on function public.increment_ai_usage(text, int) to authenticated;

-- 2. Every paid AI call logged, with tokens: ai_calls gains token and web-search
--    columns, and log_ai_call takes them. Old callers (5 arguments) still work.
--    A background job running on the secret key (research-bottle) has no
--    auth.uid(), so the service role may name the user itself.
alter table public.ai_calls
  add column if not exists input_tokens int,
  add column if not exists output_tokens int,
  add column if not exists cache_read_tokens int,
  add column if not exists web_searches int;

drop function if exists public.log_ai_call(text, text, boolean, int, boolean);
create or replace function public.log_ai_call(
  p_task text, p_model text, p_valid boolean, p_latency_ms int,
  p_escalated boolean default false,
  p_input_tokens int default null, p_output_tokens int default null,
  p_cache_read_tokens int default null, p_web_searches int default null,
  p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := coalesce(auth.uid(), case when auth.role() = 'service_role' then p_user_id end);
begin
  if uid is null then return; end if;
  insert into public.ai_calls (user_id, task, model, valid, latency_ms, escalated,
                               input_tokens, output_tokens, cache_read_tokens, web_searches)
  values (uid, p_task, p_model, p_valid, p_latency_ms, coalesce(p_escalated, false),
          p_input_tokens, p_output_tokens, p_cache_read_tokens, p_web_searches);
end;
$$;
revoke execute on function public.log_ai_call(text, text, boolean, int, boolean, int, int, int, int, uuid) from public;
revoke execute on function public.log_ai_call(text, text, boolean, int, boolean, int, int, int, int, uuid) from anon;
grant execute on function public.log_ai_call(text, text, boolean, int, boolean, int, int, int, int, uuid) to authenticated, service_role;

-- 3. Names for "Shared by …" without opening every profile: you, the people you
--    share recipes with, and the people who share with you. v1.9 of the app
--    reads this; part 2 then closes the policy that let any account read every
--    profile (diet and allergy notes, King Soopers ZIP and store included).
create or replace function public.my_people()
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.display_name
  from public.profiles p
  where p.id = auth.uid()
     or p.id in (select s.shared_with_user_id from public.recipe_shares s where s.shared_by_user_id = auth.uid())
     or p.id in (select s.shared_by_user_id from public.recipe_shares s where s.shared_with_user_id = auth.uid());
$$;
revoke execute on function public.my_people() from public;
revoke execute on function public.my_people() from anon;
grant execute on function public.my_people() to authenticated;

notify pgrst, 'reload schema';
