-- Bottle scores mean what their source says (owner's rule, 2026-11-21).
-- Run once in the Supabase SQL editor, AFTER redeploying research-bottle. Safe to run
-- twice: it recomputes every score from the raw number or medal already stored.
--
--   100-point score   /10        79.5 -> 7.95, 92 -> 9.2
--   x/10              as-is      8 -> 8.0
--   5 stars/barrels   x2         4.5 -> 9.0
--   medal only        one ladder for every competition, with Gold at 8 so scores
--                     above 8 stay rare: Bronze 6.0, Silver 7.0, Gold 8.0,
--                     Double/Grand Gold 9.0, Platinum 9.5
--
-- Each source used to have its own curve, which turned an 8/10 into a 6.75 and a 79.5
-- into a 5.4. Credibility now lives only in each review's weight, which isn't touched.
--
-- The previous scores are kept in spirit_reviews_score_backup_20261121. To undo:
--   update public.spirit_reviews r set score_10 = b.score_10
--     from public.spirit_reviews_score_backup_20261121 b where b.id = r.id;
--   select public.refresh_spirit_consensus();
begin;

create table if not exists public.spirit_reviews_score_backup_20261121 (
  id uuid primary key,
  score_10 numeric(4,2)
);
alter table public.spirit_reviews_score_backup_20261121 enable row level security;  -- no policies: admin only
insert into public.spirit_reviews_score_backup_20261121 (id, score_10)
  select id, score_10 from public.spirit_reviews
  on conflict (id) do nothing;   -- a second run keeps the original scores

update public.spirit_reviews r
set score_10 = round(least(10, greatest(0, n.score)), 2)
from (
  select x.id, case
    when x.score_raw is null then
      case regexp_replace(regexp_replace(lower(btrim(x.medal)), '\s+', ' ', 'g'), '^spirits? ', '')
        when 'bronze' then 6.0
        when 'silver' then 7.0
        when 'silver outstanding' then 7.5
        when 'gold' then 8.0
        when 'gold outstanding' then 8.5
        when 'double gold' then 9.0
        when 'grand gold' then 9.0
        when 'platinum' then 9.5
        when 'trophy' then 9.5
        when 'best in show' then 9.5
      end
    when s.scale in ('stars5', 'barrels5') then x.score_raw * 2
    when x.score_raw > 10 then x.score_raw / 10
    when s.scale in ('ten', 'drinkhacker') then x.score_raw
    -- A small number on a 100-point source was entered on another scale: BevX's
    -- lowest ratings and one Fat Rum Pirate row are stars, RumX's critics are x/10.
    when x.source_id = 'bevx' or x.reviewer = 'The Fat Rum Pirate' then x.score_raw * 2
    else x.score_raw
  end as score
  from public.spirit_reviews x
  join public.rating_sources s on s.id = x.source_id
) n
where n.id = r.id
  and n.score is not null;   -- a medal not on the ladder keeps its score

refresh materialized view concurrently public.spirit_consensus;

commit;

select count(*) as reviews,
       count(*) filter (where r.score_10 is distinct from b.score_10) as scores_changed,
       round(avg(b.score_10), 2) as average_before,
       round(avg(r.score_10), 2) as average_after
from public.spirit_reviews r
join public.spirit_reviews_score_backup_20261121 b on b.id = r.id;
