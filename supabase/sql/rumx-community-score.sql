-- RumX community medians count in the bottle score (user decision 2026-11-15).
-- Run once in the Supabase SQL editor, then import the medians:
--   cd scripts/ratings && python3 ratings.py import-batch batches/rumx-community.json --apply
-- Safe to run twice.
--
-- RumX is the only community source counted. Its 0-10 median is read as-is: on the
-- ~50 rums that also have 2+ expert reviews it sits +0.22 above the consensus (sd ~1.0),
-- as close as the critics already used. Each median's weight grows with how many
-- members rated it — the full 0.70 at 25+ ratings, proportionally less below (4 ratings
-- count 0.11) — and is stored on each review row; default_weight is that maximum.
insert into public.rating_sources (id, name, kind, scale, default_weight, scrape_ok, homepage, tos_notes) values
 ('rumx_community', 'RumX community', 'community', 'ten', 0.70, true, 'https://rumx.com',
  'Members'' median rating (0-10), counted in the score; weight 0.70 at 25+ ratings, proportionally less below. robots.txt welcomes AI agents; RumX asks for an email (info@rumx.com) before bulk or high-frequency access, so only rums already in the catalog are read.')
on conflict (id) do update
  set name = excluded.name, kind = excluded.kind, scale = excluded.scale,
      default_weight = excluded.default_weight, scrape_ok = excluded.scrape_ok, tos_notes = excluded.tos_notes;
