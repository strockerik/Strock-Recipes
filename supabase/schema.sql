-- House Index schema, exported 2026-11-15 (supabase/sql/export_schema.sql)
--
-- Rebuilds the database on an EMPTY Supabase project, in order: extensions,
-- tables, RLS, functions, the precomputed bottle scores, indexes, foreign keys,
-- policies, triggers, grants. Not a migration: the foreign keys and policies
-- aren't "if not exists", so it isn't meant to be re-run on a live database.
-- The pg_cron schedule for the bottle scores is in supabase/sql/v1.9-part2.sql.
-- Two hand edits to the export, both marked: unique indexes made "if not exists",
-- and the private sharing helpers (below) which this export run left out.

create extension if not exists pg_cron with schema pg_catalog;

create extension if not exists pg_stat_statements with schema extensions;

create extension if not exists pg_trgm with schema extensions;

create extension if not exists pgcrypto with schema extensions;

create extension if not exists supabase_vault with schema vault;

create extension if not exists "uuid-ossp" with schema extensions;

create table if not exists public.ai_calls (
  user_id uuid not null,
  task text not null,
  model text not null,
  valid boolean not null,
  latency_ms integer,
  escalated boolean not null default false,
  created_at timestamp with time zone not null default now(),
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  web_searches integer
);

create table if not exists public.ai_usage (
  user_id uuid not null,
  usage_date date not null,
  kind text not null,
  count integer not null default 0,
  constraint ai_usage_pkey PRIMARY KEY (user_id, usage_date, kind)
);

create table if not exists public.bottle_usage (
  user_id uuid not null,
  usage_date date not null,
  kind text not null,
  count integer not null default 0,
  constraint bottle_usage_kind_check CHECK ((kind = ANY (ARRAY['scan'::text, 'lookup'::text]))),
  constraint bottle_usage_pkey PRIMARY KEY (user_id, usage_date, kind)
);

create table if not exists public.coach_usage (
  user_id uuid not null,
  usage_date date not null,
  count integer not null default 0,
  constraint coach_usage_pkey PRIMARY KEY (user_id, usage_date)
);

create table if not exists public.extraction_usage (
  user_id uuid not null,
  usage_date date not null,
  count integer not null default 0,
  constraint extraction_usage_pkey PRIMARY KEY (user_id, usage_date)
);

create table if not exists public.generation_usage (
  user_id uuid not null,
  usage_date date not null,
  count integer not null default 0,
  constraint generation_usage_pkey PRIMARY KEY (user_id, usage_date)
);

create table if not exists public.grocery_basket_items (
  user_id uuid not null default auth.uid(),
  recipe_id uuid not null,
  servings integer not null,
  created_at timestamp with time zone not null default now(),
  constraint grocery_basket_items_pkey PRIMARY KEY (user_id, recipe_id)
);

create table if not exists public.grocery_checked_items (
  user_id uuid not null default auth.uid(),
  item_key text not null,
  checked_at timestamp with time zone not null default now(),
  constraint grocery_checked_items_pkey PRIMARY KEY (user_id, item_key)
);

create table if not exists public.grocery_manual_items (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null,
  source_inventory_id uuid,
  created_at timestamp with time zone not null default now(),
  constraint grocery_manual_items_pkey PRIMARY KEY (id)
);

create table if not exists public.inventory_items (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  section text not null,
  category text,
  name text,
  status text not null default 'in'::text,
  created_at timestamp with time zone not null default now(),
  product_id uuid,
  constraint inventory_items_section_check CHECK ((section = ANY (ARRAY['bar'::text, 'pantry'::text]))),
  constraint inventory_items_status_check CHECK ((status = ANY (ARRAY['in'::text, 'out'::text]))),
  constraint inventory_items_pkey PRIMARY KEY (id)
);

create table if not exists public.kroger_matches (
  user_id uuid not null default auth.uid(),
  ingredient_key text not null,
  product_id text,
  upc text,
  description text,
  image_url text,
  updated_at timestamp with time zone not null default now(),
  constraint kroger_matches_pkey PRIMARY KEY (user_id, ingredient_key)
);

create table if not exists public.kroger_tokens (
  user_id uuid not null default auth.uid(),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamp with time zone not null,
  updated_at timestamp with time zone not null default now(),
  constraint kroger_tokens_pkey PRIMARY KEY (user_id)
);

create table if not exists public.meal_plan_entries (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  recipe_id uuid not null,
  plan_date date not null,
  slot text not null,
  servings integer,
  purchased_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  constraint meal_plan_entries_slot_check CHECK ((slot = ANY (ARRAY['breakfast'::text, 'lunch'::text, 'dinner'::text]))),
  constraint meal_plan_entries_pkey PRIMARY KEY (id)
);

create table if not exists public.pairing_usage (
  user_id uuid not null,
  usage_date date not null,
  count integer not null default 0,
  constraint pairing_usage_pkey PRIMARY KEY (user_id, usage_date)
);

create table if not exists public.profiles (
  id uuid not null,
  display_name text,
  default_servings integer default 4,
  units text default 'metric'::text,
  created_at timestamp with time zone default now(),
  diet_prefs jsonb not null default '{}'::jsonb,
  grocery_prefs jsonb not null default '{}'::jsonb,
  kroger_prefs jsonb not null default '{}'::jsonb,
  constraint profiles_pkey PRIMARY KEY (id)
);

create table if not exists public.rating_sources (
  id text not null,
  name text not null,
  kind text not null,
  scale text not null,
  default_weight numeric(3,2) not null,
  scrape_ok boolean not null default false,
  homepage text,
  tos_notes text,
  search_tier integer,
  search_domains text[],
  search_categories text[],
  constraint rating_sources_kind_check CHECK ((kind = ANY (ARRAY['critic'::text, 'panel'::text, 'competition'::text, 'community'::text, 'aggregator'::text]))),
  constraint rating_sources_pkey PRIMARY KEY (id)
);

create table if not exists public.recipe_shares (
  recipe_id uuid not null,
  shared_with_user_id uuid not null,
  shared_by_user_id uuid not null,
  created_at timestamp with time zone not null default now(),
  constraint recipe_shares_pkey PRIMARY KEY (recipe_id, shared_with_user_id)
);

create table if not exists public.recipes (
  id uuid not null default uuid_generate_v4(),
  user_id uuid not null,
  section text not null,
  name text not null,
  subtitle text,
  source text,
  tags text[] default ARRAY[]::text[],
  base_servings integer not null default 4,
  servings_label text default 'servings'::text,
  ingredients jsonb not null default '[]'::jsonb,
  method jsonb not null default '[]'::jsonb,
  specs jsonb,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  is_favorite boolean not null default false,
  constraint recipes_section_check CHECK ((section = ANY (ARRAY['kitchen'::text, 'bar'::text]))),
  constraint recipes_pkey PRIMARY KEY (id)
);

create table if not exists public.spirit_aliases (
  alias_norm text not null,
  product_id uuid not null,
  source_id text,
  created_at timestamp with time zone not null default now(),
  constraint spirit_aliases_pkey PRIMARY KEY (alias_norm)
);

create table if not exists public.spirit_barcodes (
  gtin text not null,
  product_id uuid not null,
  source text,
  created_at timestamp with time zone not null default now(),
  constraint spirit_barcodes_pkey PRIMARY KEY (gtin)
);

create table if not exists public.spirit_community (
  product_id uuid not null,
  source text not null default 'rumx'::text,
  median numeric(3,1) not null,
  n_ratings integer not null,
  url text not null,
  fetched_at timestamp with time zone not null default now(),
  constraint spirit_community_n_ratings_check CHECK ((n_ratings >= 4)),
  constraint spirit_community_pkey PRIMARY KEY (product_id)
);

create table if not exists public.spirit_lookup_queue (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  query text not null,
  product_id uuid,
  status text not null default 'open'::text,
  created_at timestamp with time zone not null default now(),
  constraint spirit_lookup_queue_query_check CHECK (((length(query) >= 2) AND (length(query) <= 200))),
  constraint spirit_lookup_queue_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'no_results'::text]))),
  constraint spirit_lookup_queue_pkey PRIMARY KEY (id)
);

create table if not exists public.spirit_lookups (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  query text not null,
  name_norm text not null,
  product_id uuid,
  status text not null default 'running'::text,
  added integer not null default 0,
  detail text,
  created_at timestamp with time zone not null default now(),
  finished_at timestamp with time zone,
  constraint spirit_lookups_query_check CHECK (((length(query) >= 2) AND (length(query) <= 200))),
  constraint spirit_lookups_status_check CHECK ((status = ANY (ARRAY['running'::text, 'found'::text, 'none'::text, 'failed'::text]))),
  constraint spirit_lookups_pkey PRIMARY KEY (id)
);

create table if not exists public.spirit_products (
  id uuid not null default gen_random_uuid(),
  canonical_name text not null,
  name_norm text not null,
  brand text,
  producer text,
  category text,
  country text,
  region text,
  age_years integer,
  abv numeric(5,2),
  batch text,
  release_year integer,
  cask_finish text,
  is_single_barrel boolean not null default false,
  is_store_pick boolean not null default false,
  pick_name text,
  parent_id uuid,
  created_at timestamp with time zone not null default now(),
  researched_at timestamp with time zone,
  created_by uuid,
  constraint spirit_products_pkey PRIMARY KEY (id)
);

create table if not exists public.spirit_reports (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  product_id uuid,
  review_id uuid,
  kind text not null,
  note text,
  status text not null default 'open'::text,
  created_at timestamp with time zone not null default now(),
  constraint spirit_reports_kind_check CHECK ((kind = ANY (ARRAY['wrong_bottle'::text, 'wrong_score'::text, 'other'::text]))),
  constraint spirit_reports_note_check CHECK (((note IS NULL) OR (length(note) <= 300))),
  constraint spirit_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'fixed'::text, 'dismissed'::text]))),
  constraint spirit_reports_pkey PRIMARY KEY (id)
);

create table if not exists public.spirit_reviews (
  id uuid not null default gen_random_uuid(),
  source_id text not null,
  source_ref text not null,
  product_id uuid,
  source_name text not null,
  source_producer text,
  url text,
  review_year integer,
  reviewer text,
  medal text,
  score_raw numeric,
  score_10 numeric(4,2),
  weight numeric(3,2) not null,
  descriptors jsonb,
  excerpt text,
  match_status text not null default 'pending'::text,
  match_score numeric(4,3),
  fetched_at timestamp with time zone not null default now(),
  origin text not null default 'curated'::text,
  added_by uuid,
  verified boolean not null default true,
  seen_count integer not null default 1,
  last_checked_at timestamp with time zone,
  constraint spirit_reviews_excerpt_check CHECK (((excerpt IS NULL) OR (length(excerpt) <= 120))),
  constraint spirit_reviews_match_status_check CHECK ((match_status = ANY (ARRAY['auto'::text, 'confirmed'::text, 'pending'::text, 'rejected'::text]))),
  constraint spirit_reviews_origin_check CHECK ((origin = ANY (ARRAY['curated'::text, 'bulk'::text, 'field'::text]))),
  constraint spirit_reviews_pkey PRIMARY KEY (id),
  constraint spirit_reviews_source_id_source_ref_key UNIQUE (source_id, source_ref)
);

create table if not exists public.spirit_summaries (
  product_id uuid not null,
  summary_text text not null,
  review_ids uuid[] not null,
  model text,
  updated_at timestamp with time zone not null default now(),
  constraint spirit_summaries_pkey PRIMARY KEY (product_id)
);

alter table public.ai_calls enable row level security;

alter table public.ai_usage enable row level security;

alter table public.bottle_usage enable row level security;

alter table public.coach_usage enable row level security;

alter table public.extraction_usage enable row level security;

alter table public.generation_usage enable row level security;

alter table public.grocery_basket_items enable row level security;

alter table public.grocery_checked_items enable row level security;

alter table public.grocery_manual_items enable row level security;

alter table public.inventory_items enable row level security;

alter table public.kroger_matches enable row level security;

alter table public.kroger_tokens enable row level security;

alter table public.meal_plan_entries enable row level security;

alter table public.pairing_usage enable row level security;

alter table public.profiles enable row level security;

alter table public.rating_sources enable row level security;

alter table public.recipe_shares enable row level security;

alter table public.recipes enable row level security;

alter table public.spirit_aliases enable row level security;

alter table public.spirit_barcodes enable row level security;

alter table public.spirit_community enable row level security;

alter table public.spirit_lookup_queue enable row level security;

alter table public.spirit_lookups enable row level security;

alter table public.spirit_products enable row level security;

alter table public.spirit_reports enable row level security;

alter table public.spirit_reviews enable row level security;

alter table public.spirit_summaries enable row level security;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_ai_usage(usage_kind text, daily_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.increment_bottle_usage(usage_kind text, daily_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  updated_count int;
begin
  insert into public.bottle_usage as bu (user_id, usage_date, kind, count)
  values (auth.uid(), (now() at time zone 'utc')::date, usage_kind, 1)
  on conflict (user_id, usage_date, kind) do update
    set count = bu.count + 1
    where bu.count < daily_limit
  returning bu.count into updated_count;

  if updated_count is null then
    return -1; -- already at/over the limit, not incremented
  end if;
  return updated_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_coach_usage(daily_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  updated_count int;
begin
  insert into public.coach_usage as cu (user_id, usage_date, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set count = cu.count + 1
    where cu.count < daily_limit
  returning cu.count into updated_count;

  if updated_count is null then
    return -1; -- already at/over the limit, not incremented
  end if;
  return updated_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_extraction_usage(daily_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  updated_count int;
begin
  insert into public.extraction_usage as eu (user_id, usage_date, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set count = eu.count + 1
    where eu.count < daily_limit
  returning eu.count into updated_count;

  if updated_count is null then
    return -1; -- already at/over the limit, not incremented
  end if;
  return updated_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.increment_generation_usage(daily_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare updated_count int;
begin
  insert into public.generation_usage as gu (user_id, usage_date, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set count = gu.count + 1 where gu.count < daily_limit
  returning gu.count into updated_count;
  if updated_count is null then return -1; end if;
  return updated_count;
end; $function$
;

CREATE OR REPLACE FUNCTION public.increment_pairing_usage(daily_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  updated_count int;
begin
  insert into public.pairing_usage as pu (user_id, usage_date, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set count = pu.count + 1
    where pu.count < daily_limit
  returning pu.count into updated_count;

  if updated_count is null then
    return -1; -- already at/over the limit, not incremented
  end if;
  return updated_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.log_ai_call(p_task text, p_model text, p_valid boolean, p_latency_ms integer, p_escalated boolean DEFAULT false, p_input_tokens integer DEFAULT NULL::integer, p_output_tokens integer DEFAULT NULL::integer, p_cache_read_tokens integer DEFAULT NULL::integer, p_web_searches integer DEFAULT NULL::integer, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  uid uuid := coalesce(auth.uid(), case when auth.role() = 'service_role' then p_user_id end);
begin
  if uid is null then return; end if;
  insert into public.ai_calls (user_id, task, model, valid, latency_ms, escalated,
                               input_tokens, output_tokens, cache_read_tokens, web_searches)
  values (uid, p_task, p_model, p_valid, p_latency_ms, coalesce(p_escalated, false),
          p_input_tokens, p_output_tokens, p_cache_read_tokens, p_web_searches);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.lookup_user_id_by_email(lookup_email text)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select id from auth.users where lower(email) = lower(lookup_email) limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.my_people()
 RETURNS TABLE(id uuid, display_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.id, p.display_name
  from public.profiles p
  where p.id = auth.uid()
     or p.id in (select s.shared_with_user_id from public.recipe_shares s where s.shared_by_user_id = auth.uid())
     or p.id in (select s.shared_by_user_id from public.recipe_shares s where s.shared_with_user_id = auth.uid());
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_spirit_consensus()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  refresh materialized view concurrently public.spirit_consensus;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.spirit_candidates(q text, max_results integer DEFAULT 5)
 RETURNS TABLE(product_id uuid, canonical_name text, category text, age_years integer, abv numeric, batch text, score real)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select p.id, p.canonical_name, p.category, p.age_years, p.abv, p.batch, max(x.sim)
  from (
    select id as pid, similarity(name_norm, q) as sim from public.spirit_products
     where similarity(name_norm, q) > 0.2
    union all
    select product_id, similarity(alias_norm, q) from public.spirit_aliases
     where similarity(alias_norm, q) > 0.2
  ) x
  join public.spirit_products p on p.id = x.pid
  group by p.id
  order by max(x.sim) desc
  limit least(greatest(max_results, 1), 20);
$function$
;

CREATE OR REPLACE FUNCTION public.spirit_confirm_alias(p_product uuid, p_alias_norm text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or p_alias_norm is null
     or length(p_alias_norm) not between 2 and 200 then
    return;
  end if;
  insert into public.spirit_aliases (alias_norm, product_id)
  select p_alias_norm, p.id from public.spirit_products p where p.id = p_product
  on conflict (alias_norm) do nothing;
end;
$function$
;

-- ---------------------------------------------------------------------------
-- HAND-ADDED: the two helpers the sharing policies call (private.owns_recipe,
-- private.recipe_shared_with_me). They live in the `private` schema, which this
-- export run didn't cover (export_schema.sql includes it now). Rebuilt from the
-- README's definitions, which show them in `public`; the live policies call them
-- in `private`. Replace this block with the real definitions at the next export.
-- They read the other table without re-triggering its RLS, which breaks the
-- recipes <-> recipe_shares policy cycle ("infinite recursion detected in policy").
create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.owns_recipe(rid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.recipes where id = rid and user_id = auth.uid());
$$;

create or replace function private.recipe_shared_with_me(rid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.recipe_shares where recipe_id = rid and shared_with_user_id = auth.uid());
$$;

revoke execute on function private.owns_recipe(uuid) from public;
grant execute on function private.owns_recipe(uuid) to authenticated;
revoke execute on function private.recipe_shared_with_me(uuid) from public;
grant execute on function private.recipe_shared_with_me(uuid) to authenticated;
-- ---------------------------------------------------------------------------

create materialized view if not exists public.spirit_consensus as
 WITH w AS (
         SELECT r.product_id,
            r.source_id,
            r.score_10,
            s.kind,
            ((r.weight *
                CASE
                    WHEN r.verified THEN (1)::numeric
                    ELSE 0.75
                END) * power(0.5, ((GREATEST(0, ((EXTRACT(year FROM now()))::integer - COALESCE(r.review_year, (EXTRACT(year FROM now()))::integer))))::numeric / 10.0))) AS w
           FROM (spirit_reviews r
             JOIN rating_sources s ON ((s.id = r.source_id)))
          WHERE ((r.product_id IS NOT NULL) AND (r.score_10 IS NOT NULL) AND (r.match_status = ANY (ARRAY['auto'::text, 'confirmed'::text])))
        )
 SELECT p.id AS product_id,
    p.canonical_name,
    p.category,
    count(*) AS n_reviews,
    count(DISTINCT w.source_id) AS n_sources,
    round((sum((w.w * w.score_10)) / sum(w.w)), 2) AS score_exact,
    (floor((((sum((w.w * w.score_10)) / sum(w.w)) * (2)::numeric) + 0.5)) / (2)::numeric) AS score_10,
        CASE
            WHEN ((sum(w.w) >= 2.5) AND (count(DISTINCT w.source_id) >= 2) AND bool_or((w.kind = ANY (ARRAY['critic'::text, 'panel'::text])))) THEN 'high'::text
            WHEN (count(*) >= 2) THEN 'medium'::text
            ELSE 'low'::text
        END AS confidence,
    round(((sum((w.w * w.score_10)) + 7.0) / (sum(w.w) + (1)::numeric)), 2) AS rank_score
   FROM (w
     JOIN spirit_products p ON ((p.id = w.product_id)))
  GROUP BY p.id, p.canonical_name, p.category;

CREATE INDEX IF NOT EXISTS grocery_manual_items_user ON public.grocery_manual_items USING btree (user_id);

CREATE INDEX IF NOT EXISTS inventory_items_user_section ON public.inventory_items USING btree (user_id, section);

CREATE INDEX IF NOT EXISTS meal_plan_entries_user_date ON public.meal_plan_entries USING btree (user_id, plan_date);

CREATE INDEX IF NOT EXISTS recipes_section_idx ON public.recipes USING btree (section);

CREATE INDEX IF NOT EXISTS recipes_user_id_idx ON public.recipes USING btree (user_id);

CREATE INDEX IF NOT EXISTS recipes_user_name ON public.recipes USING btree (user_id, name);

CREATE INDEX IF NOT EXISTS spirit_aliases_trgm ON public.spirit_aliases USING gin (alias_norm gin_trgm_ops);

CREATE INDEX IF NOT EXISTS spirit_consensus_best ON public.spirit_consensus USING btree (confidence, category, rank_score DESC);

CREATE UNIQUE INDEX IF NOT EXISTS spirit_consensus_product ON public.spirit_consensus USING btree (product_id);

CREATE UNIQUE INDEX IF NOT EXISTS spirit_lookups_one_running ON public.spirit_lookups USING btree (name_norm) WHERE (status = 'running'::text);

CREATE INDEX IF NOT EXISTS spirit_lookups_recent ON public.spirit_lookups USING btree (name_norm, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS spirit_products_identity ON public.spirit_products USING btree (name_norm, COALESCE(batch, ''::text), COALESCE(pick_name, ''::text));

CREATE INDEX IF NOT EXISTS spirit_products_trgm ON public.spirit_products USING gin (name_norm gin_trgm_ops);

CREATE INDEX IF NOT EXISTS spirit_reviews_pending ON public.spirit_reviews USING btree (fetched_at) WHERE (match_status = 'pending'::text);

CREATE INDEX IF NOT EXISTS spirit_reviews_product ON public.spirit_reviews USING btree (product_id) WHERE (product_id IS NOT NULL);

alter table public.ai_calls add constraint ai_calls_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.ai_usage add constraint ai_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.bottle_usage add constraint bottle_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.coach_usage add constraint coach_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.extraction_usage add constraint extraction_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.generation_usage add constraint generation_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.grocery_basket_items add constraint grocery_basket_items_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE;

alter table public.grocery_basket_items add constraint grocery_basket_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.grocery_checked_items add constraint grocery_checked_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.grocery_manual_items add constraint grocery_manual_items_source_inventory_id_fkey FOREIGN KEY (source_inventory_id) REFERENCES inventory_items(id) ON DELETE SET NULL;

alter table public.grocery_manual_items add constraint grocery_manual_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.inventory_items add constraint inventory_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE SET NULL;

alter table public.inventory_items add constraint inventory_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.kroger_matches add constraint kroger_matches_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.kroger_tokens add constraint kroger_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.meal_plan_entries add constraint meal_plan_entries_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE;

alter table public.meal_plan_entries add constraint meal_plan_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.pairing_usage add constraint pairing_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.recipe_shares add constraint recipe_shares_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE;

alter table public.recipe_shares add constraint recipe_shares_shared_by_user_id_fkey FOREIGN KEY (shared_by_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.recipe_shares add constraint recipe_shares_shared_with_user_id_fkey FOREIGN KEY (shared_with_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.recipes add constraint recipes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.spirit_aliases add constraint spirit_aliases_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE CASCADE;

alter table public.spirit_aliases add constraint spirit_aliases_source_id_fkey FOREIGN KEY (source_id) REFERENCES rating_sources(id);

alter table public.spirit_barcodes add constraint spirit_barcodes_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE CASCADE;

alter table public.spirit_community add constraint spirit_community_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE CASCADE;

alter table public.spirit_lookup_queue add constraint spirit_lookup_queue_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE CASCADE;

alter table public.spirit_lookup_queue add constraint spirit_lookup_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.spirit_lookups add constraint spirit_lookups_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE SET NULL;

alter table public.spirit_lookups add constraint spirit_lookups_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.spirit_products add constraint spirit_products_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

alter table public.spirit_products add constraint spirit_products_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES spirit_products(id) ON DELETE SET NULL;

alter table public.spirit_reports add constraint spirit_reports_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE CASCADE;

alter table public.spirit_reports add constraint spirit_reports_review_id_fkey FOREIGN KEY (review_id) REFERENCES spirit_reviews(id) ON DELETE CASCADE;

alter table public.spirit_reports add constraint spirit_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table public.spirit_reviews add constraint spirit_reviews_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL;

alter table public.spirit_reviews add constraint spirit_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE SET NULL;

alter table public.spirit_reviews add constraint spirit_reviews_source_id_fkey FOREIGN KEY (source_id) REFERENCES rating_sources(id);

alter table public.spirit_summaries add constraint spirit_summaries_product_id_fkey FOREIGN KEY (product_id) REFERENCES spirit_products(id) ON DELETE CASCADE;

create policy "users see their ai usage" on public.ai_usage as permissive for select to authenticated
  using ((user_id = auth.uid()));

create policy "users see their usage" on public.bottle_usage as permissive for select to authenticated
  using ((user_id = auth.uid()));

create policy "owners manage their grocery basket" on public.grocery_basket_items as permissive for all to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "owners manage their checked grocery items" on public.grocery_checked_items as permissive for all to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "owners manage their manual grocery items" on public.grocery_manual_items as permissive for all to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "owners manage their inventory" on public.inventory_items as permissive for all to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "owners manage their kroger matches" on public.kroger_matches as permissive for all to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "owners manage their kroger tokens" on public.kroger_tokens as permissive for all to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "owners manage their meal plan" on public.meal_plan_entries as permissive for all to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy "Users can insert own profile" on public.profiles as permissive for insert to authenticated
  with check ((auth.uid() = id));

create policy "Users can update own profile" on public.profiles as permissive for update to authenticated
  using ((auth.uid() = id))
  with check ((auth.uid() = id));

create policy "Users can view own profile" on public.profiles as permissive for select to authenticated
  using ((auth.uid() = id));

create policy "signed-in read" on public.rating_sources as permissive for select to authenticated
  using (true);

create policy "owners manage shares on their recipes" on public.recipe_shares as permissive for all to authenticated
  using ((shared_by_user_id = auth.uid()))
  with check (((shared_by_user_id = auth.uid()) AND private.owns_recipe(recipe_id)));

create policy "recipients view shares directed at them" on public.recipe_shares as permissive for select to authenticated
  using ((shared_with_user_id = auth.uid()));

create policy "Users can delete own recipes" on public.recipes as permissive for delete to authenticated
  using ((auth.uid() = user_id));

create policy "Users can insert own recipes" on public.recipes as permissive for insert to authenticated
  with check ((auth.uid() = user_id));

create policy "Users can update own recipes" on public.recipes as permissive for update to authenticated
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));

create policy "Users can view own recipes" on public.recipes as permissive for select to authenticated
  using ((auth.uid() = user_id));

create policy "recipes shared with you are viewable" on public.recipes as permissive for select to authenticated
  using (private.recipe_shared_with_me(id));

create policy "signed-in read" on public.spirit_aliases as permissive for select to authenticated
  using (true);

create policy "signed-in read" on public.spirit_barcodes as permissive for select to authenticated
  using (true);

create policy "signed-in read" on public.spirit_community as permissive for select to authenticated
  using (true);

create policy "users add lookups" on public.spirit_lookup_queue as permissive for insert to authenticated
  with check ((user_id = auth.uid()));

create policy "users see their lookups" on public.spirit_lookup_queue as permissive for select to authenticated
  using ((user_id = auth.uid()));

create policy "signed-in read" on public.spirit_lookups as permissive for select to authenticated
  using (true);

create policy "signed-in read" on public.spirit_products as permissive for select to authenticated
  using (true);

create policy "users report" on public.spirit_reports as permissive for insert to authenticated
  with check ((user_id = auth.uid()));

create policy "users see their reports" on public.spirit_reports as permissive for select to authenticated
  using ((user_id = auth.uid()));

create policy "signed-in read matched" on public.spirit_reviews as permissive for select to authenticated
  using ((match_status = ANY (ARRAY['auto'::text, 'confirmed'::text])));

create policy "signed-in read" on public.spirit_summaries as permissive for select to authenticated
  using (true);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.recipes FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

revoke execute on function public.handle_updated_at() from public;
grant execute on function public.handle_updated_at() to anon;
grant execute on function public.handle_updated_at() to authenticated;
grant execute on function public.handle_updated_at() to service_role;

revoke execute on function public.increment_ai_usage(usage_kind text, daily_limit integer) from public;
grant execute on function public.increment_ai_usage(usage_kind text, daily_limit integer) to authenticated;
grant execute on function public.increment_ai_usage(usage_kind text, daily_limit integer) to service_role;

revoke execute on function public.increment_bottle_usage(usage_kind text, daily_limit integer) from public;
grant execute on function public.increment_bottle_usage(usage_kind text, daily_limit integer) to authenticated;
grant execute on function public.increment_bottle_usage(usage_kind text, daily_limit integer) to service_role;

revoke execute on function public.increment_coach_usage(daily_limit integer) from public;
grant execute on function public.increment_coach_usage(daily_limit integer) to authenticated;
grant execute on function public.increment_coach_usage(daily_limit integer) to service_role;

revoke execute on function public.increment_extraction_usage(daily_limit integer) from public;
grant execute on function public.increment_extraction_usage(daily_limit integer) to authenticated;
grant execute on function public.increment_extraction_usage(daily_limit integer) to service_role;

revoke execute on function public.increment_generation_usage(daily_limit integer) from public;
grant execute on function public.increment_generation_usage(daily_limit integer) to authenticated;
grant execute on function public.increment_generation_usage(daily_limit integer) to service_role;

revoke execute on function public.increment_pairing_usage(daily_limit integer) from public;
grant execute on function public.increment_pairing_usage(daily_limit integer) to authenticated;
grant execute on function public.increment_pairing_usage(daily_limit integer) to service_role;

revoke execute on function public.log_ai_call(p_task text, p_model text, p_valid boolean, p_latency_ms integer, p_escalated boolean, p_input_tokens integer, p_output_tokens integer, p_cache_read_tokens integer, p_web_searches integer, p_user_id uuid) from public;
grant execute on function public.log_ai_call(p_task text, p_model text, p_valid boolean, p_latency_ms integer, p_escalated boolean, p_input_tokens integer, p_output_tokens integer, p_cache_read_tokens integer, p_web_searches integer, p_user_id uuid) to authenticated;
grant execute on function public.log_ai_call(p_task text, p_model text, p_valid boolean, p_latency_ms integer, p_escalated boolean, p_input_tokens integer, p_output_tokens integer, p_cache_read_tokens integer, p_web_searches integer, p_user_id uuid) to service_role;

revoke execute on function public.lookup_user_id_by_email(lookup_email text) from public;
grant execute on function public.lookup_user_id_by_email(lookup_email text) to authenticated;
grant execute on function public.lookup_user_id_by_email(lookup_email text) to service_role;

revoke execute on function public.my_people() from public;
grant execute on function public.my_people() to authenticated;
grant execute on function public.my_people() to service_role;

revoke execute on function public.refresh_spirit_consensus() from public;
grant execute on function public.refresh_spirit_consensus() to service_role;

revoke execute on function public.spirit_candidates(q text, max_results integer) from public;
grant execute on function public.spirit_candidates(q text, max_results integer) to anon;
grant execute on function public.spirit_candidates(q text, max_results integer) to authenticated;
grant execute on function public.spirit_candidates(q text, max_results integer) to service_role;

revoke execute on function public.spirit_confirm_alias(p_product uuid, p_alias_norm text) from public;
grant execute on function public.spirit_confirm_alias(p_product uuid, p_alias_norm text) to authenticated;
grant execute on function public.spirit_confirm_alias(p_product uuid, p_alias_norm text) to service_role;

revoke all on public.spirit_consensus from public, anon;
grant select on public.spirit_consensus to authenticated;
grant select on public.spirit_consensus to service_role;
