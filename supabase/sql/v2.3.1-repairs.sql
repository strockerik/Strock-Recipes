-- v2.3.1 repairs. Run once in the Supabase SQL editor. Safe to run twice.
--
--  1. Recipients can remove a recipe shared with them. The README always had this
--     rule, but the live database didn't, so "Remove" did nothing.
--  2. Bottle lookups: members can still follow a lookup's progress, but can no
--     longer read who looked up what.
--  3. "Which one is it?" only saves a shortcut name when it plausibly names the
--     bottle that was tapped, and records who saved it. Checked against all 11,786
--     current aliases: none would be refused. A mis-tap such as "eagle rare" on
--     Buffalo Trace scores 0.00 and is refused.
--
-- To review shortcut names people have saved since this ran:
--   select a.alias_norm, p.canonical_name, a.created_by, a.created_at
--   from public.spirit_aliases a join public.spirit_products p on p.id = a.product_id
--   where a.created_by is not null order by a.created_at desc;
-- Delete a wrong one with: delete from public.spirit_aliases where alias_norm = '...';
begin;

-- 1
drop policy if exists "recipients can remove a share directed at them" on public.recipe_shares;
create policy "recipients can remove a share directed at them" on public.recipe_shares
  as permissive for delete to authenticated
  using (shared_with_user_id = auth.uid());

-- 2 (the app reads only these four columns, by id; the Edge Function uses admin rights)
revoke select on public.spirit_lookups from anon, authenticated;
grant select (id, status, product_id, added) on public.spirit_lookups to authenticated;

-- 3
alter table public.spirit_aliases
  add column if not exists created_by uuid references auth.users(id) on delete set null;

create or replace function public.spirit_confirm_alias(p_product uuid, p_alias_norm text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_alias_norm is null
     or length(p_alias_norm) not between 2 and 200 then
    return;
  end if;
  -- The typed name and the bottle's name must share words, in either direction
  -- ("blantons" in "blantons original single barrel bourbon", or the reverse).
  insert into public.spirit_aliases (alias_norm, product_id, created_by)
  select p_alias_norm, p.id, auth.uid()
  from public.spirit_products p
  where p.id = p_product
    and greatest(extensions.word_similarity(p_alias_norm, p.name_norm),
                 extensions.word_similarity(p.name_norm, p_alias_norm)) >= 0.3
  on conflict (alias_norm) do nothing;
end;
$$;

commit;

select
  (select count(*) from pg_policies where tablename = 'recipe_shares'
     and policyname = 'recipients can remove a share directed at them') as share_remove_rule,
  has_column_privilege('authenticated', 'public.spirit_lookups', 'user_id', 'select') as members_see_who_looked_up,
  (select count(*) from information_schema.columns where table_name = 'spirit_aliases'
     and column_name = 'created_by') as alias_created_by_column;
