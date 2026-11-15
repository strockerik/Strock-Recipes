-- House Index v1.9, part 2 of 2. Run AFTER the v1.9 app is live (it reads names
-- through my_people() from part 1) and the v1.9 Edge Functions are deployed
-- (research-bottle refreshes the bottle scores this creates). Safe to run twice.

-- 1. Profiles: each account reads only its own row again. Names for shared
--    recipes come from my_people() (part 1).
drop policy if exists "shared profiles are viewable by authenticated users" on public.profiles;

-- 2. Bottle scores, precomputed. spirit_consensus was a view that re-aggregated
--    every review on each read (~0.4 s for Best rated across all categories, and
--    growing with the catalog). Same name and columns, now a materialized view,
--    refreshed by ratings.py after imports and merges, by research-bottle after a
--    lookup writes scores, and hourly by pg_cron as a safety net.
--    A materialized view has no RLS: access is by grant (signed-in read, as before).
do $$
begin
  if exists (select 1 from pg_views where schemaname = 'public' and viewname = 'spirit_consensus') then
    execute 'drop view public.spirit_consensus';   -- no CASCADE: stop if anything depends on it
  end if;
end $$;

create materialized view if not exists public.spirit_consensus as
with w as (
  select r.product_id, r.source_id, r.score_10, s.kind,
         r.weight * (case when r.verified then 1 else 0.75 end)
                   * power(0.5, greatest(0, extract(year from now())::int
                                            - coalesce(r.review_year, extract(year from now())::int)) / 10.0) as w
  from public.spirit_reviews r
  join public.rating_sources s on s.id = r.source_id
  where r.product_id is not null and r.score_10 is not null
    and r.match_status in ('auto','confirmed')
)
select p.id as product_id,
       p.canonical_name,
       p.category,
       count(*) as n_reviews,
       count(distinct w.source_id) as n_sources,
       round(sum(w.w * w.score_10) / sum(w.w), 2) as score_exact,
       floor((sum(w.w * w.score_10) / sum(w.w)) * 2 + 0.5) / 2 as score_10,
       case when sum(w.w) >= 2.5 and count(distinct w.source_id) >= 2
                 and bool_or(w.kind in ('critic','panel')) then 'high'
            when count(*) >= 2 then 'medium' else 'low' end as confidence,
       round((sum(w.w * w.score_10) + 7.0) / (sum(w.w) + 1), 2) as rank_score
from w join public.spirit_products p on p.id = w.product_id
group by p.id, p.canonical_name, p.category;

create unique index if not exists spirit_consensus_product on public.spirit_consensus (product_id);
create index if not exists spirit_consensus_best on public.spirit_consensus (confidence, category, rank_score desc);

revoke all on public.spirit_consensus from public, anon;
grant select on public.spirit_consensus to authenticated, service_role;

create or replace function public.refresh_spirit_consensus()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view concurrently public.spirit_consensus;
end;
$$;
revoke execute on function public.refresh_spirit_consensus() from public;
revoke execute on function public.refresh_spirit_consensus() from anon;
revoke execute on function public.refresh_spirit_consensus() from authenticated;
grant execute on function public.refresh_spirit_consensus() to service_role;

create extension if not exists pg_cron;
select cron.schedule('refresh-spirit-consensus', '7 * * * *', 'select public.refresh_spirit_consensus()');

notify pgrst, 'reload schema';
