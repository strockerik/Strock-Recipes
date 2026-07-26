# The House Index — Recipes & Cocktails

A personal, multi-user recipe and cocktail app. The frontend is plain
HTML/CSS/JS (no build step) hosted on GitHub Pages; accounts and data live in
Supabase. Each signed-in user sees only their own recipes.

## Architecture

```
Browser (GitHub Pages)                 Supabase
┌──────────────────────┐               ┌─────────────────────────────┐
│ index.html / style.css│  auth ──────▶ │ Auth (email + password)     │
│ app.js                │  read/write ▶ │ Postgres `recipes` + RLS    │
│ config.js (URL + anon)│               │   (auth.uid() = user_id)    │
└──────────────────────┘  AI extract ▶ │ Edge Function extract-recipe│
                                        │   └▶ Claude (Haiku / Sonnet)│
                                        └─────────────────────────────┘
```

- **Auth:** email + password. Sessions persist in the browser, so you stay
  signed in across visits. "Forgot password?" emails a reset link.
- **Privacy:** every recipe row has a `user_id`; a Row Level Security policy
  (`auth.uid() = user_id`) means Postgres itself refuses to return other users'
  rows, even if the frontend had a bug. The only exception is a recipe an
  owner explicitly shares with a specific person's email, which becomes
  readable — but not writable — by that person only. See **Recipe sharing**
  below.
- **AI extraction:** "✨ Add with AI" sends a photo, pasted text, or a link to the
  `extract-recipe` Edge Function, which verifies the caller is signed in, calls
  Claude (structured output via forced tool-use), and returns a recipe that
  pre-fills the form for review — nothing is saved without your approval. Text
  and links use Haiku 4.5 (cheap); photos use the stronger Sonnet vision model,
  since handwritten recipe cards need it to read reliably. The model is told to
  ignore non-recipe clutter (card labels, names, decorations, copyright lines,
  phone UI in screenshots), and to intelligently fill gaps — completing a recipe
  that's cut off, inferring proportions when only ingredients are listed, and
  turning a loose narrative into clean steps. Anything it guesses is flagged in
  the recipe's Notes with an "AI added:" line so you can double-check it. The
  Anthropic API key lives only as a server-side secret, never in the browser.

## Files

```
index.html                              the page (auth gate, list, recipe form, AI import, grocery panel)
style.css                               styling (light theme)
app.js                                  all client logic
config.js                               Supabase project URL + anon key (safe to commit)
manifest.json / icons/                  iPhone home-screen PWA support
supabase/functions/extract-recipe/      Edge Function source (Deno/TS) for AI extraction
supabase/functions/recipe-coach/        Edge Function source (Deno/TS) for the AI recipe coach
data/recipes.js, data/cocktails.js      pre-migration backup of the original static data (unused)
```

`config.js` exposes the Supabase URL and **anon** key. That is intentional and
safe — the anon key only permits what RLS allows. The **service-role** key
(which bypasses RLS) must never be committed; it stays in the gitignored
`notes.md` / `.env.local` for one-off local admin tasks only.

## Accounts

The sign-in screen shows **one action at a time**: it opens in **Sign in** mode,
and a **"New here? Create an account"** link flips it to sign-up (and back). The
password field has a **Show/Hide** toggle, and the primary button shows a spinner
while a request is in flight.

- **Sign in** with your email + password.
- **Create an account** (via the switch link) makes a new private recipe book for
  a new email.
- **Forgot password?** (sign-in mode) emails a link that returns to the app and
  drops you straight into a **set-a-new-password** form — new password + confirm,
  with its own Show/Hide (also how you set a password the first time on an account
  originally created via magic link). No browser pop-up.
- **Account ▾** (top-right, once signed in) opens a small menu with your email,
  **Change password** (the same inline form), **⬇ Back up recipes**, and
  **Sign out**.
- **Guide** (next to Account ▾) opens an in-app **Feature guide** — a quick tour
  of the recipe book, Cook mode, the grocery list, meal planning, and Ask AI, plus
  the two ways to add a recipe.

Errors are mapped to plain, recoverable guidance instead of raw Supabase strings:
a wrong password points you at "reset your password"; an **unconfirmed email**
shows a one-tap **"Resend confirmation email"** button; signing up with an email
that already exists auto-switches you to Sign in.

New-account behavior depends on the Supabase **Authentication → Providers →
Email → "Confirm email"** setting: ON sends one confirmation email at signup;
OFF signs the new account in immediately. The app handles both. To avoid tripping
Supabase's rate limit, the submit / forgot / switch controls disable themselves
while a request is in flight (one request per tap).

### ⚠️ Required URL configuration (or confirmation/reset links 404)

The app asks Supabase to send confirmation and reset links back to its own
deployed URL (`emailRedirectTo` / `redirectTo`), **but Supabase only honors that
if the URL is allowlisted — otherwise it silently falls back to the project's
Site URL.** If the Site URL is wrong (e.g. the default, or the user-root
`https://strockerik.github.io` which has no Pages site), the email link lands on
a **404**. Set both, in **Supabase Dashboard → Authentication → URL
Configuration**:

- **Site URL:** `https://strockerik.github.io/Strock-Recipes/`
- **Redirect URLs (allowlist):** `https://strockerik.github.io/Strock-Recipes/**`
  — plus `http://localhost:*/**` for local `python3 -m http.server` testing.

Confirmation links already sent before fixing this keep the old (bad) redirect
baked in — sign up again (or resend) after correcting the config.

## Adding recipes

Use the app — no editing JS files:

- **✨ Add with AI** — snap or choose a photo of a recipe (cookbook page,
  handwritten card, screenshot), paste a link to a recipe page, or paste text
  (e.g. an Instagram caption); the whole form fills in for you to review,
  edit, and save. Photos are downscaled and converted to JPEG in the browser
  before upload, so iPhone HEIC photos work. **Links are two-tier:** the Edge
  Function fetches the page server-side, and when the site ships complete
  schema.org Recipe data (JSON-LD — most recipe blogs do), it's parsed
  **deterministically and returned without any AI call at all** — instant,
  free, doesn't count against the daily cap, and the review form says so
  ("Read straight from the site's recipe data"). Only when the structured
  data is absent or too partial does the extraction fall back to the AI path
  (which still receives the JSON-LD as context when present). **YouTube**
  links (including Shorts) work too: the function reads the recipe out of the
  video's description (and falls back to the auto-generated captions if the
  description is just a teaser). **TikTok** links work via TikTok's official
  oEmbed API, which serves the video's caption — where recipe TikToks
  usually carry the recipe; if the recipe is only spoken in the video, the
  app says so and routes you to Paste text. **Instagram** stays paste-only:
  it exposes no server-readable caption without a Facebook developer app
  token. Two other categories of link can't be fetched either, and the app
  will tell you to paste text instead (with a one-tap **📋 Paste text
  instead** button right on the error): **bot-protected sites** (e.g.
  liquor.com, AllRecipes, Serious Eats) — their Cloudflare-style protection
  blocks any non-browser request outright, no matter the headers — and
  **JS-only "app" sites** (e.g. some recipe-card apps built with React/Vite)
  whose server response is an empty shell with no content until client-side
  JavaScript runs. Both are fundamental limits of fetching a page
  server-side, not bugs to retry. Text and AI-path link extractions cost
  roughly half a cent (Haiku); photo extractions a couple of cents (Sonnet,
  needed to read messy handwriting); structured-data link extractions cost
  nothing. The AI completes cut-off recipes, infers proportions when only
  ingredients are given, and ignores non-recipe clutter on the card or
  screenshot — anything it guesses shows up as an "AI added:" line in Notes.
  Each account is capped at **20 AI extractions/day** (resets at midnight
  UTC) to keep API costs predictable — structured-data parses don't consume
  it.
  - **Multiple photos, one recipe:** if a recipe spans the front and back of a
    card, or several pages, tap "Take / choose photo" for each one (up to 4) —
    a thumbnail strip with an **+ Add another photo** button appears, and
    nothing is sent until you tap **Extract recipe**. The AI reads all the
    photos together as one recipe (not a batch of separate recipes), merging
    e.g. ingredients from the front with the method from the back.
- **+ Add recipe** — fill in the form manually (name, section, servings, tags,
  ingredient rows, method steps, notes). Need to slot a step into the middle?
  Tap **↕ Reorder** by Method to reveal ▲▼ controls on each step and nudge it
  into place (the saved order follows what's on screen).
- Open any recipe to **Edit** or **Delete** it — or tap **▶ Cook** for a
  full-screen guided mode: one step at a time, tap to advance, an ingredients
  toggle scaled to your servings, and the screen stays awake while you cook.
- **✨ Ask AI** (on any open recipe) — a conversational AI coach with two modes,
  powered by Claude Sonnet 4.6 via the `recipe-coach` Edge Function:
  - **🛟 What went wrong?** — describe a dish that flopped ("the caramel burned
    and there was too much liquid"); the coach **asks a clarifying question or two
    first** (pan, heat, timing) to pin down the real cause, then explains *why* it
    happened and how to prevent or rescue it. Once it's diagnosed the problem, an
    **✍️ Update recipe to emphasize this** button (your own recipes) asks the coach
    to rewrite the relevant method step(s) to call out the critical detail you
    missed — exact amount, temperature, timing, or technique — then routes through
    the same review-before-save flow.
  - **✨ Improve it** — say what you want changed ("too sweet", "too salty",
    "missing something"); the coach suggests specific changes with amounts and
    technique. When a rewrite helps, an **Apply changes to recipe** button opens
    the edit form pre-filled with the revised recipe — you always review and Save
    yourself; nothing is written automatically (and Apply only appears on your own
    recipes). The change it made is noted in the recipe's Notes as an
    "AI tweaked:" line.

  It's a real back-and-forth (type a reply, press Enter to send; Shift+Enter for a
  newline). Each recipe's conversation is **kept for 24 hours** (per mode, in the
  browser's local storage) so you can close the panel and revisit the coaching
  later; after 24 hours it's cleared automatically. Coaching has its **own
  20/day cap** (separate from the 20/day import cap), where each message in a
  conversation — including an "emphasize this in the recipe" request — counts as
  one request.

Every open recipe has a **servings stepper** at the top: scale a recipe written
for 4 up to 8 (it shows "×2 of 4") and the ingredient amounts rescale live. The
chosen servings carry straight into the grocery list, so a doubled recipe adds
doubled quantities to your shopping list.

Tags are picked from a fixed list, not typed — kitchen recipes get at most one
cuisine, one protein/diet, and one dish-type tag (e.g. italian + chicken +
casserole); bar recipes get at most one spirit and one style tag (e.g. rum +
sour). This keeps the tag filter bar small and useful. AI extraction follows
the same list.

Amounts entered as decimals display as fractions (0.5 → ½). Leave an ingredient
amount blank for "to taste"–style items that shouldn't scale.

Each open recipe has an **Original / US / Metric** toggle by the Ingredients
heading. *Original* shows the units as written; *US* converts weights to oz/lb
and volumes to tsp/tbsp/cup; *Metric* converts weights to g/kg and volumes to
ml/l — so a recipe written in 700 g of beef can be read as 1½ lb. Counts that
aren't weights or volumes (e.g. "2 cloves garlic") and blank "to taste" amounts
are left untouched. The toggle only changes the on-screen display; the saved
recipe and the grocery list are unaffected.

### Recipe sections (sub-recipes)

A recipe that's really two preparations — a dough and a sauce, a cocktail and
its syrup — can split its ingredients and steps into labeled sections. In the
form, hit **+ Add section** under Ingredients or Method and type a label (e.g.
"Dough"); every row below it belongs to that section until the next heading.
Leave out all headings for a plain single-list recipe (the default). The recipe
detail and Cook mode then show each section under its own subheading, and AI
extraction auto-detects sections (e.g. it splits a pizza into Dough/Sauce on its
own). Sections are display-only — the grocery list still combines ingredients
across sections and recipes by name. Internally each ingredient and step carries
an optional `group` label; **method steps are stored as `{text, group}` objects**
(older recipes' plain-string steps are read transparently and upgraded on edit).

## Send a recipe to anyone

For sending a recipe to someone **outside the app** (no account needed), open any
recipe and tap **📤 Send**. The app builds a single **self-contained `.html` file**
— styled to match the in-app Feature guide (Fraunces headings, the mono kicker,
dot-bullet ingredients, numbered steps; green for Kitchen, red for Bar) — and hands
it to your device's **share sheet**, so you pick **Messages** or **Mail** and address
it yourself. The recipient just taps the attachment and it opens in any browser.

- It exports **what you're looking at**: the currently chosen **servings** and
  **unit system** (Original / US / Metric).
- The file is tiny (~5–7 KB), built instantly in the browser — no server, no PDF
  library. Where the share sheet can't take a file it shares plain text instead;
  on desktop it downloads the `.html` to attach manually.
- This is distinct from **Share** below, which grants another *signed-in* account
  live access inside the app.

## Recipe sharing

Sharing is explicit and per-recipient — a recipe is visible only to its owner
and whoever the owner has specifically shared it with by email:

- Open any of **your** recipes and tap **Share**. A panel opens where you can
  enter the email address of another account and tap **Share** — that person
  will now see the recipe under their **👥 Shared with me** view, with a
  "Shared by \<you\>" attribution. The panel lists everyone the recipe is
  currently shared with as a chip; tap the **×** on a chip to stop sharing
  with that person. The button label shows the recipient count (e.g. "Shared
  with 2 people").
  - The recipient must already have an account in this app — sharing looks up
    their user id by email and shows "No account found with that email" if
    they haven't signed up yet.
- Browsing a recipe shared with you, tap **📋 Copy to my book** to clone it
  into your own recipe book as an independent copy — editing your copy never
  affects the original, and the owner unsharing or deleting their original
  doesn't touch your copy.
- You can't edit, delete, favorite, or manage sharing on another person's
  recipe — only the owner can, and Postgres enforces this via RLS regardless
  of the UI.

**One-time setup (Supabase SQL editor)** — run once, in order. (This replaces
an earlier "share with the whole household" design built on a single
`is_shared` boolean — the steps below retire that column and policy.)

```sql
-- 1. profiles already exists with its own RLS policies (view/insert/update
--    own row only). One more SELECT policy lets every signed-in user read
--    display names for "Shared by <name>" attribution — this OR's with the
--    existing "view own profile" policy, it doesn't replace it. (Already
--    applied if you set up the earlier household-sharing design — safe to
--    skip if so.)
create policy "shared profiles are viewable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

-- 2. Retire the old "visible to everyone" policy and its column.
drop policy "shared recipes are viewable by authenticated users" on public.recipes;
alter table public.recipes drop column is_shared;

-- 3. Per-recipe, per-recipient shares.
create table public.recipe_shares (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  shared_with_user_id uuid not null references auth.users(id) on delete cascade,
  shared_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recipe_id, shared_with_user_id)
);
alter table public.recipe_shares enable row level security;

-- SECURITY DEFINER helpers: a policy on recipe_shares needs to check recipes
-- (and vice-versa). Calling the other table inline makes each table's RLS
-- invoke the other's, which Postgres rejects as "infinite recursion detected
-- in policy". These helpers read the other table WITHOUT re-triggering its RLS,
-- breaking the cycle. Empty search_path keeps them locked down.
create or replace function public.owns_recipe(rid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.recipes where id = rid and user_id = auth.uid());
$$;
grant execute on function public.owns_recipe(uuid) to authenticated;

create or replace function public.recipe_shared_with_me(rid uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.recipe_shares where recipe_id = rid and shared_with_user_id = auth.uid());
$$;
grant execute on function public.recipe_shared_with_me(uuid) to authenticated;

-- Owners can create/view/delete shares for recipes they own. The `with check`
-- (via owns_recipe) stops anyone from "sharing" a recipe_id they don't own.
create policy "owners manage shares on their recipes"
  on public.recipe_shares for all
  to authenticated
  using (shared_by_user_id = auth.uid())
  with check (shared_by_user_id = auth.uid() and public.owns_recipe(recipe_id));

-- Recipients can see shares directed at them (drives "Shared by X" lookups).
create policy "recipients view shares directed at them"
  on public.recipe_shares for select
  to authenticated
  using (shared_with_user_id = auth.uid());

-- Recipients can dismiss a recipe shared with them (delete their own share
-- row). This only removes it from their "Shared with me" list — the owner's
-- recipe is untouched.
create policy "recipients can remove a share directed at them"
  on public.recipe_shares for delete
  to authenticated
  using (shared_with_user_id = auth.uid());

-- 4. A recipe is visible if you own it (existing policy, unchanged) or it has
-- been explicitly shared with you.
create policy "recipes shared with you are viewable"
  on public.recipes for select
  to authenticated
  using (public.recipe_shared_with_me(id));

-- 5. Email -> user id lookup for the "share with..." flow. SECURITY DEFINER +
-- empty search_path so it can read auth.users without granting broad access;
-- returns only the id (or null), never other account details.
create or replace function public.lookup_user_id_by_email(lookup_email text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(lookup_email) limit 1;
$$;

grant execute on function public.lookup_user_id_by_email(text) to authenticated;
```

The existing owner-only policy for insert/update/delete on `recipes` is
untouched, so "Copy to my book" is still the only way another user gets a
writable row from a recipe shared with them.

> **Already set up sharing and seeing "infinite recursion detected in policy
> for relation recipe_shares"?** You ran an earlier version whose policies
> referenced each other's table inline. Run this once to switch to the
> recursion-free helper form:
>
> ```sql
> create or replace function public.owns_recipe(rid uuid)
> returns boolean language sql security definer set search_path = '' stable as $$
>   select exists (select 1 from public.recipes where id = rid and user_id = auth.uid());
> $$;
> grant execute on function public.owns_recipe(uuid) to authenticated;
>
> create or replace function public.recipe_shared_with_me(rid uuid)
> returns boolean language sql security definer set search_path = '' stable as $$
>   select exists (select 1 from public.recipe_shares where recipe_id = rid and shared_with_user_id = auth.uid());
> $$;
> grant execute on function public.recipe_shared_with_me(uuid) to authenticated;
>
> drop policy if exists "owners manage shares on their recipes" on public.recipe_shares;
> create policy "owners manage shares on their recipes"
>   on public.recipe_shares for all to authenticated
>   using (shared_by_user_id = auth.uid())
>   with check (shared_by_user_id = auth.uid() and public.owns_recipe(recipe_id));
>
> drop policy if exists "recipes shared with you are viewable" on public.recipes;
> create policy "recipes shared with you are viewable"
>   on public.recipes for select to authenticated
>   using (public.recipe_shared_with_me(id));
> ```

> **Note:** recipes previously shared via the old "share with household"
> toggle stop being shared with anyone once this SQL runs (`recipe_shares`
> starts empty) — re-share them with specific people's emails afterward.

## Weekly meal planning

Plan what to cook across the week and shop for it in one pass:

- On any recipe, tap **📅 Add to Weekly Meal Plan** (next to ▶ Cook) to stage it.
- Open **📅 Meal Plan** (top controls) for a three-part page:
  - **Recipes to plan** (top) — your staged recipes. Tap one to *arm* it.
  - **Upcoming 7 days** (middle) — with a recipe armed, tap a day's
    Breakfast / Lunch / Dinner **+** to schedule it there. A slot can hold more
    than one recipe; tap a meal's **×** to unschedule it.
  - **History — last 7 days** (bottom) — past days you've shopped for; tap a
    meal to jump straight into that recipe's Cook mode.
- Tap **🛒 Create grocery list** to roll every upcoming planned meal into the
  normal grocery list — a recipe planned on two days has its servings summed,
  and those days are marked "✓ purchased."

The staging tray is per-session; the schedule itself is saved per-user in
Supabase, so it follows you across devices. The app only ever shows a rolling
window of the past 7 and next 7 days.

**One-time setup (Supabase SQL editor)** — run once:

```sql
create table public.meal_plan_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  plan_date date not null,
  slot text not null check (slot in ('breakfast','lunch','dinner')),
  servings int,                       -- null = use the recipe's base servings
  purchased_at timestamptz,           -- set when a grocery list is generated for it
  created_at timestamptz not null default now()
);
alter table public.meal_plan_entries enable row level security;
create policy "owners manage their meal plan" on public.meal_plan_entries
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index meal_plan_entries_user_date on public.meal_plan_entries (user_id, plan_date);
```

Until this runs, the planner just shows up empty (it fails open).

## Bar & pantry inventory + dietary preferences

Two additions that power the AI recipe generator: a per-user inventory of what's
on hand (bar liquor by type + optional brand, and pantry staples), and dietary
preferences/allergies stored on the profile so the generator honors them
silently across devices.

**One-time setup (Supabase SQL editor)** — run once:

```sql
-- Dietary preferences on the existing profile row (owner-only RLS already covers it).
-- Shape: { "diets": ["vegetarian"], "allergies": ["peanut"], "avoid": ["cilantro"] }
alter table public.profiles
  add column if not exists diet_prefs jsonb not null default '{}'::jsonb;

-- Inventory: one row per tracked item, owner-only (same pattern as meal_plan_entries).
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  section text not null check (section in ('bar','pantry')),
  category text,        -- bar: spirit type (rum/gin/…); pantry: aisle bucket
  name text,            -- bar: optional brand; pantry: staple name
  status text not null default 'in' check (status in ('in','out')), -- kept simple: no "low"
  created_at timestamptz not null default now()
);
alter table public.inventory_items enable row level security;
create policy "owners manage their inventory" on public.inventory_items
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index inventory_items_user_section on public.inventory_items (user_id, section);
```

Until this runs, inventory shows empty and dietary preferences silently no-op
(both fail open).

**Already ran the setup above with the old 3-value status?** The app now only
sends `'in'`/`'out'` — run this once to fold any existing `'low'` rows into
`'out'` and match the constraint to what the app actually writes:

```sql
update public.inventory_items set status = 'out' where status = 'low';
alter table public.inventory_items drop constraint if exists inventory_items_status_check;
alter table public.inventory_items add constraint inventory_items_status_check check (status in ('in','out'));
```

## Pair a drink

On any kitchen recipe, **🍷 Pair a drink** asks whether you want a cocktail,
wine, or beer pairing, then proposes 2-3 options to pick from:

- **Cocktail** — checks your own saved bar recipes first (cross-referenced
  against your bar inventory, if you track one) for a genuinely good existing
  match before inventing anything new. Picking an existing match just opens
  it — no AI call needed. Picking an invented idea develops it into a full,
  saveable cocktail recipe.
- **Wine / beer** — recommends a **type or style** (e.g. "a dry Sauvignon
  Blanc," "a Belgian witbier"), never a specific bottle or brand, with a
  short tasting profile and why it suits the dish. Not a saveable recipe —
  there's a quick "add to grocery list" action instead.

The pairing knowledge (which wine/beer/cocktail styles suit which kinds of
dishes, and why) is baked into the `pair-drink` Edge Function's prompts as a
static reference — condensed from `research/drink-pairing-research-brief.md`,
a sourced deep-research brief (WSET, Cicerone/Brewers Association,
Punch, Wine Enthusiast) — the same technique already used for the AI
generator's cuisine flavor bases, so the model isn't relying on its own
uncertain recall of pairing facts on every request. See that file if the
pairing prompts ever need revisiting.

## AI usage limits

Four independent per-user daily caps, all enforced server-side (in the Edge
Functions, via `SECURITY DEFINER` RPCs) so they can't be bypassed from the
browser, and all resetting at midnight UTC:

- **20 AI extractions/day** — `extract-recipe` (any mix of photo, text, or link).
- **20 AI coaching requests/day** — `recipe-coach` (each ✨ Ask AI message,
  including an "emphasize this in the recipe" request, counts as one).
- **20 AI recipe generations/day** — `generate-recipe`. It's a two-step call
  (`mode:"concepts"` proposes 3 ideas, then `mode:"full"` writes the chosen one);
  **only the full-recipe step counts against the cap**, so browsing ideas is
  free and the limit is effectively 20 finished recipes/day.
- **20 AI drink pairings/day** — `pair-drink` (🍷 Pair a drink). Proposing 2-3
  cocktail options is free (like the generator's concepts step) since a picked
  option may just point at a recipe you already have; only *developing* an
  invented cocktail into a full recipe counts. Every wine/beer call counts —
  there's no separate "browsing" step for those, the one call is the whole
  answer.

Each limit is a single constant in its Edge Function (`DAILY_EXTRACTION_LIMIT` /
`DAILY_COACH_LIMIT` / `DAILY_PAIRING_LIMIT`) — change the number and redeploy
that function. Each uses its own table + RPC, so they never starve each other.

**One-time setup (Supabase SQL editor)** — run once for extractions:

```sql
create table public.extraction_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  primary key (user_id, usage_date)
);
alter table public.extraction_usage enable row level security;
-- Intentionally no policies: only reachable via the SECURITY DEFINER
-- function below (or the service role), so users can't reset or inflate
-- their own counters directly.

create or replace function public.increment_extraction_usage(daily_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default; lock it to signed-in
-- users only (the Security Advisor flags the default public grant otherwise).
revoke execute on function public.increment_extraction_usage(int) from public;
grant execute on function public.increment_extraction_usage(int) to authenticated;
```

**And once for coaching** — the same pattern in its own bucket, so coaching and
imports are counted separately:

```sql
create table public.coach_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  primary key (user_id, usage_date)
);
alter table public.coach_usage enable row level security;
-- No policies on purpose: reachable only via the SECURITY DEFINER function below.

create or replace function public.increment_coach_usage(daily_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke execute on function public.increment_coach_usage(int) from public;
grant execute on function public.increment_coach_usage(int) to authenticated;
```

**And once for the AI recipe generator** — same pattern, its own bucket
(20 generations/day), used by the `generate-recipe` function:

```sql
create table public.generation_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  primary key (user_id, usage_date)
);
alter table public.generation_usage enable row level security;
-- No policies on purpose: reachable only via the SECURITY DEFINER function below.

create or replace function public.increment_generation_usage(daily_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count int;
begin
  insert into public.generation_usage as gu (user_id, usage_date, count)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set count = gu.count + 1
    where gu.count < daily_limit
  returning gu.count into updated_count;

  if updated_count is null then
    return -1; -- already at/over the limit, not incremented
  end if;
  return updated_count;
end;
$$;

revoke execute on function public.increment_generation_usage(int) from public;
grant execute on function public.increment_generation_usage(int) to authenticated;
```

**And once for drink pairing** — same pattern, its own bucket, used by the
`pair-drink` function:

```sql
create table public.pairing_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  primary key (user_id, usage_date)
);
alter table public.pairing_usage enable row level security;
-- No policies on purpose: reachable only via the SECURITY DEFINER function below.

create or replace function public.increment_pairing_usage(daily_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- Both PUBLIC and anon default-grant EXECUTE on a new function — revoke both
-- up front (learned from the earlier caps needing this as a fast-follow fix).
revoke execute on function public.increment_pairing_usage(int) from public;
revoke execute on function public.increment_pairing_usage(int) from anon;
grant execute on function public.increment_pairing_usage(int) to authenticated;
```

If any of these SQL blocks hasn't been run yet (or an RPC call errors for any
reason), that Edge Function fails open — the request proceeds without a cap
rather than breaking.

> **Security Advisor flags a cap RPC as callable by `anon`?** Supabase grants
> `EXECUTE` to `anon` on every new function by default, regardless of
> `revoke ... from public` above — `anon` has to be revoked by name. Run once:
>
> ```sql
> revoke execute on function public.increment_extraction_usage(int) from anon;
> revoke execute on function public.increment_coach_usage(int) from anon;
> revoke execute on function public.increment_generation_usage(int) from anon;
> revoke execute on function public.increment_pairing_usage(int) from anon;
> ```

**Verifying setup:** don't call the RPCs directly from the SQL editor — they run
there as `postgres` with no signed-in user, so `auth.uid()` is null and the insert
fails with a not-null error (that error means the function exists, not that it's
broken). Just confirm the objects exist:

```sql
select count(*) from public.coach_usage;                              -- table exists → 0
select proname from pg_proc where proname = 'increment_coach_usage';  -- function exists
```

The caps only increment with a real user's JWT, so the true test is in the app:
use the feature and watch the count climb (the 21st same-day call returns the
"used today's 20…" message). The same applies to `increment_extraction_usage`.

## AI provider routing — the Groq cheap tier (optional)

`extract-recipe`'s **text and URL** paths can run through a cheap open model
(Groq, `openai/gpt-oss-20b`, with strict JSON-schema constrained decoding) first,
**escalating to Claude on any miss** (error, timeout, or schema-invalid output).
Image/vision extraction and the other three functions always use Claude. The tier
is **opt-in and fail-open**: with no `GROQ_API_KEY` set, everything routes to
Claude exactly as before, so deploying the function is a no-op until you enable it.

Enable it with these Edge Function secrets (Edge Functions → Secrets, shared):

- `GROQ_API_KEY` — a free key from console.groq.com (`gsk_…`). Server-side only,
  never in the frontend. Unset = tier disabled.
- `ALLOW_PROVIDER_OVERRIDE` — set to `1` **only** while running the old-vs-new
  comparison test; it lets a request pin a provider via `force_provider` (and
  skips the daily cap for those calls). Leave it unset in normal production.

Notes: gpt-oss-20b is one of only two Groq models with strict `json_schema`
support (llama-3.1-8b-instant does **not**), and Groq's free tier caps at 8000
tokens/min — so the function keeps Groq's `max_tokens` small and only sends
short-enough inputs to Groq; long pages/transcripts skip it and go straight to
Claude. Responses carry `extracted_via`: `"structured"` (JSON-LD tier-1, free),
`"groq"` (cheap tier), or `"ai"` (Claude).

### Observability — the `ai_calls` log

One row per extraction records which provider handled it, so you can measure the
cheap model's real-world success rate. Run once in the SQL editor:

```sql
create table public.ai_calls (
  user_id uuid not null references auth.users(id) on delete cascade,
  task text not null,
  model text not null,
  valid boolean not null,
  latency_ms int,
  escalated boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.ai_calls enable row level security;
-- No policies on purpose: written only via the SECURITY DEFINER function below.

create or replace function public.log_ai_call(
  p_task text, p_model text, p_valid boolean, p_latency_ms int, p_escalated boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_calls (user_id, task, model, valid, latency_ms, escalated)
  values (auth.uid(), p_task, p_model, p_valid, p_latency_ms, p_escalated);
end;
$$;

-- Both PUBLIC and anon default-grant EXECUTE on a new function — revoke both.
revoke execute on function public.log_ai_call(text, text, boolean, int, boolean) from public;
revoke execute on function public.log_ai_call(text, text, boolean, int, boolean) from anon;
grant execute on function public.log_ai_call(text, text, boolean, int, boolean) to authenticated;
```

Like the caps, `extract-recipe` fails open if this hasn't been run — logging is
skipped, extraction still works. Inspect the cheap-tier success rate with:

```sql
select
  count(*) filter (where model = 'openai/gpt-oss-20b')                as groq_ok,
  count(*) filter (where escalated)                                   as escalated_to_claude,
  count(*) filter (where model like 'claude%' and not escalated)      as claude_direct,
  round(100.0 * count(*) filter (where model = 'openai/gpt-oss-20b')
        / nullif(count(*) filter (where model = 'openai/gpt-oss-20b' or escalated), 0), 1) as groq_success_pct,
  round(avg(latency_ms)) as avg_ms
from public.ai_calls;
```

## Edge Function deployment (AI)

There are **four** Edge Functions, each deployed via the Supabase dashboard (Edge
Functions → the in-browser editor), with the repo files as the source of truth —
keep them in sync when editing:

- **`extract-recipe`** — AI import (photo / text / link → recipe). Its text/URL
  paths optionally route through the Groq cheap tier first (see "AI provider
  routing" above); image extraction stays on Claude.
- **`recipe-coach`** — the AI coach (troubleshoot / improve an existing recipe).
  Deploy it the same way: create the function, paste in
  `supabase/functions/recipe-coach/index.ts`, Deploy.
- **`generate-recipe`** — the AI recipe generator (on-hand ingredients → a new
  recipe). Same deploy: create the function, paste in
  `supabase/functions/generate-recipe/index.ts`, Deploy.
- **`pair-drink`** — 🍷 Pair a drink (cocktail/wine/beer pairings for a kitchen
  recipe). Same deploy: create the function, paste in
  `supabase/functions/pair-drink/index.ts`, Deploy.

Requirements (apply to **all four** functions):

- Secret `ANTHROPIC_API_KEY` set under Edge Functions → Secrets (shared).
- (Optional, `extract-recipe` only) `GROQ_API_KEY` to enable the cheap tier, and
  `ALLOW_PROVIDER_OVERRIDE=1` only during comparison testing — see "AI provider
  routing — the Groq cheap tier" above.
- **Verify JWT: OFF** for each (they do their own auth check and handle the CORS
  preflight; leaving it on breaks browser calls).
- Each has its **own** per-user daily cap: `extract-recipe` uses
  `increment_extraction_usage`, `recipe-coach` uses `increment_coach_usage`,
  `generate-recipe` uses `increment_generation_usage`, and `pair-drink` uses
  `increment_pairing_usage` (all 20/day) — each fails open if its migration
  hasn't run. See "AI usage limits" for the one-time SQL.
- Set a monthly spend limit on the Anthropic account as a runaway-cost guard.
- After editing a repo `index.ts`, paste the new contents into that function's
  dashboard editor and hit Deploy — pushing to GitHub does **not** redeploy it.

VSCode shows errors in `index.ts` ("Cannot find name 'Deno'", "Cannot find
module 'jsr:…'") because its TypeScript server type-checks the file as Node
code. They're cosmetic — the function runs on Supabase's Deno runtime, where
both resolve fine. Installing the official Deno VSCode extension (with
`deno.enablePaths: ["supabase/functions"]`) silences them.

## Grocery list sync

The grocery list (checked recipes + servings, hand-typed items, pantry/bar
restocks, and check-off state) is saved per-user in Supabase, so it follows
you across devices — plan on a laptop or iPad, shop from a phone, or split
planning and shopping between two people signed into the same account. It
refetches whenever the grocery panel is opened, so a change made on another
device shows up the next time you open the list there (not instantly live —
reopen the panel or reload to see someone else's latest change).

Checking off an item that came from the pantry/bar **🛒 Restock** button also
flips that item back to "in stock" in Bar & Pantry automatically — buying it
closes the loop. Unchecking it does *not* reverse that; marking something
back out of stock is still a deliberate action in the inventory panel.

**One-time setup (Supabase SQL editor)** — run once:

```sql
-- Basket: one row per recipe per user — mirrors the app's basket exactly, so
-- (user_id, recipe_id) is the natural key adds/servings-updates upsert into.
create table public.grocery_basket_items (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  servings int not null,
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_id)
);
alter table public.grocery_basket_items enable row level security;
create policy "owners manage their grocery basket" on public.grocery_basket_items
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Manual (non-recipe) items — hand-typed or added via a pantry/bar restock.
-- source_inventory_id is the restock provenance link: set only when the item
-- came from "🛒 Restock", so checking it off can auto-restock that item.
create table public.grocery_manual_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  source_inventory_id uuid references public.inventory_items(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.grocery_manual_items enable row level security;
create policy "owners manage their manual grocery items" on public.grocery_manual_items
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index grocery_manual_items_user on public.grocery_manual_items (user_id);

-- Checked-off state. Recipe-ingredient keys are computed client-side (name +
-- unit) and manual items key off their own row id — both are just opaque
-- text, so this is a pure membership table: upsert to check, delete to uncheck.
create table public.grocery_checked_items (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_key text not null,
  checked_at timestamptz not null default now(),
  primary key (user_id, item_key)
);
alter table public.grocery_checked_items enable row level security;
create policy "owners manage their checked grocery items" on public.grocery_checked_items
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Settings, not list contents (skip-pantry-staples + aisle order) — same
-- jsonb-on-profile shape as diet_prefs.
alter table public.profiles
  add column if not exists grocery_prefs jsonb not null default '{}'::jsonb;
```

Until this runs, the grocery list fails open like every other table here:
empty list, no errors, nothing saves. The app also migrates each browser's
existing local grocery list into these tables once, automatically, the first
time it loads after this SQL has been run — nothing to do on your end beyond
running the SQL.

## Grocery list → Google Keep

- **On your phone:** check the recipes you want, set servings, open the grocery
  list, and tap **Send to phone / Keep** — the share sheet opens; choose Google
  Keep and the list lands in a new note.
- **On desktop:** tap **Copy list** and paste into keep.google.com.
- **Download .txt** saves a plain file.

The grocery list combines matching ingredients across every checked recipe
into a single shopping list — e.g. ground beef needed by two recipes becomes
one line. Names are normalized before combining, so prep notes and wording
don't split a line ("Salt and Black Pepper, to taste" + "salt and pepper",
or "guanciale, diced" + "guanciale", each merge to one). Weights and volumes
are converted to what a US grocery store sells (grams/kg → oz/lb, ml/l →
cups/tbsp/tsp) and rounded **up** to a practical amount so you never under-buy —
weights to the nearest ¼ oz/lb (450 g → 1 lb, 90 g → 3¼ oz), volumes to ¼ cup /
½ tbsp, loose counts to a whole; small gram amounts like yeast or spices are
left as-is. Prep instructions are dropped from the shopping name ("carrots,
diced" → "carrots") while what-to-buy adjectives stay ("peeled tomatoes",
"floury potatoes"). Items are grouped under store-aisle headers (Produce, Meat
& Seafood, Dairy, …). Tap
an item to check it off as you shop, or use **Skip pantry staples** to hide
salt, pepper, oil, water, sugar, butter, and flour from the list (produce
peppers like bell or red pepper are never treated as a staple). The **By
recipe** section below the list still shows each recipe's full ingredients at
your chosen servings, unaffected by the staples toggle.

The grocery selection is saved per-user in Supabase (see "Grocery list sync"
above), so it follows you across devices and survives closing the app —
build the list on one device and send it to Keep from another if you like.

## Add to your iPhone home screen

1. Open the live URL in **Safari**.
2. **Share → Add to Home Screen → Add**.
3. Launching from the home screen opens it full-screen and behaves like a native
   app. Sign in once and your recipes sync to any device you sign in on with the
   same email + password.

## Backup & restore

Your recipes live only in Supabase, so keep an off-Supabase copy — especially of
anything you'd hate to lose (the handwritten family recipes you photographed).
There are two paths; the scope of a backup is **your own recipes, kitchen + bar**
(recipes others shared with you, your meal plan, and grocery picks are not
included — they're reconstructable).

**Everyday, from the app (phone-friendly).** Sign in, open **Account ▾** in the
header, and tap **⬇ Back up recipes**. It exports your recipes as a single JSON
file with three options:

- **Send / email to yourself** — opens the share sheet so you can email or AirDrop
  the file to yourself. This is the important one: it's your *offsite* copy. Do it
  now, and again whenever you add recipes you care about.
- **Download .json** — saves the file to Files / Downloads on the device.
- **Copy JSON** — copies the text as a fallback.

**Archival + restore, from your Mac (the disaster-recovery path).**
`scripts/backup_recipes.py` reads `SUPABASE_URL` and the service-role key from the
environment or the gitignored `notes.md` (same as `migrate_ingredients.py`).

```bash
# Write a faithful, timestamped snapshot to backups/house-index-YYYY-MM-DD.json
python3 scripts/backup_recipes.py

# Put a snapshot back. Dry-run first (prints what it would do), then --apply.
python3 scripts/backup_recipes.py --restore backups/house-index-2026-06-22.json
python3 scripts/backup_recipes.py --restore backups/house-index-2026-06-22.json --apply
```

The script snapshot keeps each recipe's `id` and owner, so a restore is exact and
**idempotent** — a recipe whose `id` already exists is skipped, so re-running
never duplicates. To restore an **in-app export** instead (those files carry no
ids), add `--owner <your-user-uuid>` (find it in `notes.md`); those rows are
inserted as new recipes owned by you and deduped by name + section. The
`backups/` folder is gitignored — keep at least one copy somewhere off this Mac.

## Data maintenance (optional)

Two tables grow unbounded — not a performance problem (their reads are indexed
and the rows are tiny), just housekeeping. `meal_plan_entries` keeps rows
forever outside the app's rolling ±7-day window, and each `*_usage` cap table
accrues one small row per user per active day. Prune them whenever you feel
like it (Supabase SQL editor):

```sql
delete from public.meal_plan_entries where plan_date < (now() at time zone 'utc')::date - 30;
delete from public.extraction_usage  where usage_date < (now() at time zone 'utc')::date - 90;
delete from public.coach_usage       where usage_date < (now() at time zone 'utc')::date - 90;
delete from public.generation_usage  where usage_date < (now() at time zone 'utc')::date - 90;
delete from public.pairing_usage     where usage_date < (now() at time zone 'utc')::date - 90;
delete from public.ai_calls          where created_at < (now() at time zone 'utc') - interval '90 days';
```

If the `pg_cron` extension is enabled on the project, schedule the same
statements to run nightly; otherwise running them by hand once in a while (or
never) is fine — the bytes are negligible.

**Index check (one-time):** the main recipe-list query filters by `user_id`
and orders by `name`. Confirm an index covers it:

```sql
select indexname, indexdef from pg_indexes where tablename = 'recipes';
```

If nothing covers `(user_id, name)`, add it — only matters past a few hundred
recipes, but the query runs on every load:

```sql
create index if not exists recipes_user_name on public.recipes (user_id, name);
```

## Local preview

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

Use a local server (rather than opening the file directly) so Supabase auth and
its redirects work correctly.
