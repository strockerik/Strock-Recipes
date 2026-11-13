-- The 2026-11-13 expert pass: run this once in the Supabase SQL editor (safe to run twice).
-- 11: the table for RumX community medians. 12: three critics as their own sources.
-- 13: confidence by review count (one review = low, two or more = medium).

-- 11. RumX community medians (2026-11-12): a crowd's median per rum, shown under
-- the expert score on the score card and never part of it (so it isn't a
-- spirit_reviews row: a median has no weight in the consensus).
create table if not exists public.spirit_community (
  product_id uuid primary key references public.spirit_products(id) on delete cascade,
  source text not null default 'rumx',
  median numeric(3,1) not null,
  n_ratings int not null check (n_ratings >= 4),
  url text not null,
  fetched_at timestamptz not null default now()
);
alter table public.spirit_community enable row level security;
drop policy if exists "signed-in read" on public.spirit_community;
create policy "signed-in read" on public.spirit_community for select to authenticated using (true);

-- 12. Three critics under their own names (2026-11-12), so the catalog counts them as
--     independent sources and the score card names them. Weights from how each one's
--     scores sit against the catalog's consensus on the bottles they share.
insert into public.rating_sources (id, name, kind, scale, default_weight, scrape_ok, homepage, tos_notes) values
 ('fat_rum_pirate','The Fat Rum Pirate','critic','stars5',0.8,true,'https://thefatrumpirate.com','Rum, 0.5-5 stars. robots allows; read through its WordPress feed, from each review''s own rating image.'),
 ('bourbon_culture','The Bourbon Culture','critic','ten',0.7,true,'https://thebourbonculture.com','Whiskey, x/10. robots allows; harvested through its WordPress feed.'),
 ('bevx','BevX','critic','competition100',0.6,true,'https://bevx.com','Spirits; stars on a generous wine-style points scale, so read like a competition''s points. robots allows; WordPress feed, spirit sections only.')
on conflict (id) do nothing;

-- 13. Confidence by review count (decided 2026-11-13): one review = low, two or more =
--     medium, and "high" as in step 10. One full-weight review used to be enough for
--     "medium", so a single Distiller or Drinkhacker review of a limited release could
--     top Best rated (the list is built from medium and high). Projected on the merged
--     catalog, Best rated is rum 177, whiskey 589, agave 211, gin 276, liqueur 109,
--     amaro 10, and the top of the rum list is bottles several critics agree on.
--     Two weak reviews (say two old medals) also reach medium under this rule.
create or replace view public.spirit_consensus with (security_invoker = true) as
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
