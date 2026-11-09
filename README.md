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
config.js                               Supabase project URL + public (anon/publishable) key (safe to commit)
manifest.json / icons/                  iPhone home-screen PWA support
sw.js                                   service worker: opens offline with your last-synced data
vendor/supabase-<ver>.min.js            supabase-js UMD build, vendored (no CDN at runtime)
supabase/functions/extract-recipe/      Edge Function source (Deno/TS) for AI extraction
supabase/functions/recipe-coach/        Edge Function source (Deno/TS) for the AI recipe coach
supabase/functions/identify-bottle/     Edge Function: reads a bottle label photo (Bottles)
supabase/functions/research-bottle/     Edge Function: looks a bottle's scores up on the web, grows the catalog
data/recipes.js, data/cocktails.js      pre-migration backup of the original static data (unused)
scripts/ratings/                        spirits ratings catalog builder (see Spirits ratings catalog)
testing-skills/*.py                     headless Chrome harnesses (no backend, no spend)
```

`config.js` exposes the Supabase URL and the **public** key (the legacy `anon`
key, or its replacement `sb_publishable_…`). That is intentional and safe — it
only permits what RLS allows. The **secret** key (`sb_secret_…`, replacing the
legacy service-role key; both bypass RLS) must never be committed; it stays in
the gitignored `notes.md` / `.env.local` for one-off local admin tasks only.

**Content Security Policy.** `index.html` carries a CSP `<meta>`: the page runs
only its own scripts (no inline script, no `eval`), loads styles from itself and
Google Fonts, images from itself plus `data:`/`blob:` (AI-import photo previews),
and talks only to this Supabase project. If you add a script, a host the page
calls, or move Supabase projects, update that tag — `testing-skills/offline_csp_test.py`
loads the real page head and fails on any violation.

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
  description is just a teaser). **TikTok** links read the video's caption —
  where recipe TikToks usually carry the recipe — from TikTok's official oEmbed
  API, or, since oEmbed stopped returning captions (2026-10), from TikTok's
  public embed page (`/embed/v2/<id>`). TikTok turns away a random share of
  those requests ("429 Too Many Requests"), so the function retries a few
  times with short pauses; the function log line shows each try
  (`embed=429,200`). If the recipe is only spoken in the video, the app says
  so and routes you to Paste text. **Instagram** stays paste-only:
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
  - **Note for the AI:** once a photo is staged, an optional note box lets you
    steer the extraction — e.g. "only the brownie recipe on the left page" when
    a page shows several recipes.
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

  **It knows your kitchen.** Each message also carries what's in stock in your
  Bar & Pantry (and what's marked out) plus the names of your other recipes, so
  it can suggest swaps from what you have ("you have sherry vinegar — use
  that"). When a question needs another recipe's details ("use the sauce from my
  lasagna"), it reads that recipe itself (up to two look-ups per message, still
  one counted request).

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

Plan what to cook across the week and shop for it in one pass. Meal planning
lives on the **Kitchen** tab only — the Bar tab has no Meal plan tab, staged
pill or 📅 controls (its second view is 🥃 Bottles).

- On any kitchen recipe, tap **📅 Stage for plan** (next to ▶ Cook) — or the 📅 box on
  the row itself — to stage it. It reads "✓ Staged for plan" once it's in the
  tray; staging is *not* scheduling, and the wording is deliberate (it used to
  say "✓ In meal plan", which it wasn't).
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
- Tap **📤 Send plan** to send the coming week to the household as one
  self-contained page (through the share sheet, like a recipe's 📤 Send).
  It has three parts, with jump links between them:
  - **The week**: each day's meals, today first. Empty nights show as
    "Nothing planned", and each meal links to its recipe below.
  - **Shopping list**: the same merged list "Create grocery list" would build,
    in your aisle order with checkboxes. Staples you skip are left off, and
    pantry stock is listed as "already at home". It never touches your actual
    grocery list.
  - **Recipes**: each recipe once, with the days it's cooked and its
    ingredients at the planned servings (one list per size if two nights
    differ). There are no methods; an imported recipe links to its original
    for those.

  The page has no script, so its checkboxes work wherever it opens. Printing
  puts the week, the list and the recipes on separate pages: one for the
  fridge, one for the store. Where a file can't be shared it sends the same
  content as plain text, and on a desktop it downloads the file.

The staging tray lives in this device's localStorage (so it does *not* follow
you to another device); the schedule itself is saved per-user in Supabase, so
that part does. The Meal plan tab only appears once something is staged or
scheduled — the 📅 controls on a recipe are the way in. The app only ever shows a rolling
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

**Allergies are enforced twice.** The prompt states each allergy with its family
spelled out ("shellfish (includes shrimp, prawn, crab, … clamato, oyster …)"), and
after generation a safety net (`allergyHit` in `generate-recipe` and `pair-drink`)
rejects any recipe whose name or ingredients name an allergen. Category allergies
— shellfish, crustacean, mollusc, fish, seafood, tree nuts, nuts, peanut, dairy /
milk / lactose, egg, gluten / wheat / celiac, soy, sesame — expand to their foods,
including hidden sources (Worcestershire = anchovy, orgeat = almond, Baileys =
dairy). Free-from forms don't trip it ("coconut milk" under dairy, "gluten-free
pasta", "ginger beer"). Anything not in the table is matched literally. The table
lives in an `ALLERGEN NET` block that must stay identical in both functions —
`testing-skills/allergen_net_test.py` checks that and runs the cases.

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

## Spirits ratings catalog

The groundwork for scanning a bottle and seeing what the experts think of it
(like Distiller or Vivino). The app never queries review sites live: a
catalog of bottles and their expert scores lives in Supabase, built up over
time from your Mac with `scripts/ratings/ratings.py`, and the
`spirit_consensus` view blends each bottle's scores into one **0–10 score in
0.5 steps**.

**How a score is built.** Each source's raw score is converted to 0–10 through
that source's own anchor table in `scripts/ratings/normalize.py`, because
published spirits scores sit almost entirely in 80–97 (dividing by ten would
squash everything into 8–9.7). IWSC 95 (Gold) → 8.0; a critic's 92 → 8.0.
The view then takes an age-weighted average; how far to trust it is the
`confidence` label's job, not the score's:

```
score_10   = Σ weight·score / Σ weight                     shown rounded to 0.5
rank_score = (Σ weight·score + 1·7.0) / (Σ weight + 1)     sorting "best bottles" only
weights:  critic/panel with points 1.0 · competition with points 0.8
          medal only 0.5 · Jim Murray 0.7 — each halved for every 10 years of age
```

`rank_score` pulls toward 7.0 as if it were one extra review, so a single old
rave doesn't top a list. It used to be the displayed score, but with mostly one
or two older reviews per bottle it squeezed every bottle into 7.0–8.0 (changed
2026-11-08).

`confidence` is **high** with total weight ≥ 2.5 from at least two sources,
**medium** at ≥ 1, otherwise **low**. What's stored per review is facts — score,
medal, year, reviewer, link — never review prose (`excerpt` is capped at 120
characters and only for a short attributed phrase). Distiller's and
Tastings.com's (BTI) terms forbid scraping and building databases from them, so
those go in by hand with `ratings.py score`. IWSC does too, for a different
reason: its results are public, but every scripted request (robots.txt
included) gets a Cloudflare bot challenge (checked 2026-11-08), and the script
doesn't try to get past that.

**One-time setup (Supabase SQL editor)** — run once:

```sql
create extension if not exists pg_trgm with schema extensions;
set search_path = public, extensions;   -- so the trigram indexes find gin_trgm_ops

-- Where scores come from. scale = which anchor table in scripts/ratings/normalize.py.
create table public.rating_sources (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('critic','panel','competition','community','aggregator')),
  scale text not null,
  default_weight numeric(3,2) not null,
  scrape_ok boolean not null default false,
  homepage text,
  tos_notes text
);
insert into public.rating_sources (id, name, kind, scale, default_weight, scrape_ok, homepage, tos_notes) values
 ('iwsc','IWSC','competition','iwsc',0.8,false,'https://www.iwsc.net','Public results, but scripts get a Cloudflare challenge: manual entry. Store medal, points, year and link; not judges'' notes.'),
 ('sfwsc','San Francisco World Spirits Competition','competition','sfwsc',0.5,true,'https://thetastingalliance.com','Medal results are public facts.'),
 ('whisky_advocate','Whisky Advocate','critic','critic100',1.0,false,'https://whiskyadvocate.com','Check robots.txt and terms before automating; manual entry until then.'),
 ('wine_enthusiast','Wine Enthusiast','critic','wine_enthusiast',1.0,false,'https://www.wineenthusiast.com','Check terms before automating; manual entry until then.'),
 ('distiller','Distiller (expert score)','critic','critic100',1.0,false,'https://distiller.com','Terms ban scraping and database building: manual entry only.'),
 ('bti','Beverage Testing Institute (Tastings.com)','panel','critic100',1.0,false,'https://www.tastings.com','Terms ban scraping and aggregation: manual entry only.'),
 ('usc','Ultimate Spirits Challenge','panel','critic100',0.8,false,null,'Defunct since 2023; historic scores only.'),
 ('murray','Jim Murray''s Whisky Bible','critic','murray',0.7,false,null,'Print/ebook: manual entry.'),
 ('tequila_matchmaker','Tequila Matchmaker (panel score)','panel','tequila_matchmaker',0.8,false,'https://www.tequilamatchmaker.com','Check terms; manual entry until then.'),
 ('breaking_bourbon','Breaking Bourbon','critic','barrels5',1.0,false,'https://www.breakingbourbon.com','Check terms; manual entry until then.'),
 ('whiskey_wash','The Whiskey Wash','critic','ten',0.8,false,'https://thewhiskeywash.com','Current 1-10 scale; older reviews used 5 stars or 100 points.'),
 ('whiskycast','WhiskyCast','critic','critic100',1.0,false,'https://whiskycast.com','Public ratings pages; manual entry.'),
 ('drinkhacker','Drinkhacker','critic','drinkhacker',1.0,false,'https://www.drinkhacker.com','x/10 with a letter grade (A 9.5, A- 9.0, B+ 8.5, B 8.0); manual entry.'),
 ('spirit_journal','F. Paul Pacult''s Spirit Journal','critic','stars5',1.0,false,null,'Print newsletter, 1-5 stars; manual entry.'),
 ('bartender_spirits_awards','Bartender Spirits Awards','competition','critic100',0.5,false,'https://bartenderspiritsawards.com','Results pages give medal and points.'),
 ('spirits_masters','The Spirits Business Masters','competition','medal',0.5,false,'https://www.thespiritsbusiness.com','Medal-only results articles.'),
 ('independent','Independent reviewer','critic','critic100',0.5,false,null,'A blog or newsletter''s own 100-point score; reviewer = the publication.')
on conflict (id) do nothing;

-- The catalog: one row per distinct bottle. Batches and store picks are their own
-- rows with parent_id pointing at the base expression.
create table public.spirit_products (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  name_norm text not null,             -- match key from normalize.norm_name()
  brand text,
  producer text,
  category text,                       -- the app's BAR_CATEGORIES (bourbon, scotch, tequila, ...)
  country text,
  region text,
  age_years int,
  abv numeric(5,2),
  batch text,
  release_year int,
  cask_finish text,
  is_single_barrel boolean not null default false,
  is_store_pick boolean not null default false,
  pick_name text,
  parent_id uuid references public.spirit_products(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index spirit_products_identity
  on public.spirit_products (name_norm, coalesce(batch, ''), coalesce(pick_name, ''));
create index spirit_products_trgm on public.spirit_products using gin (name_norm gin_trgm_ops);

-- Every spelling of a bottle seen in any source, so the next match is instant.
create table public.spirit_aliases (
  alias_norm text primary key,
  product_id uuid not null references public.spirit_products(id) on delete cascade,
  source_id text references public.rating_sources(id),
  created_at timestamptz not null default now()
);
create index spirit_aliases_trgm on public.spirit_aliases using gin (alias_norm gin_trgm_ops);

create table public.spirit_barcodes (
  gtin text primary key,               -- UPC/EAN digits
  product_id uuid not null references public.spirit_products(id) on delete cascade,
  source text,
  created_at timestamptz not null default now()
);

-- One row per score from one source. product_id null = waiting in the match queue.
create table public.spirit_reviews (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.rating_sources(id),
  source_ref text not null,            -- the source's own id or URL (dedupe key)
  product_id uuid references public.spirit_products(id) on delete set null,
  source_name text not null,           -- the bottle's name exactly as the source printed it
  source_producer text,
  url text,
  review_year int,
  reviewer text,
  medal text,
  score_raw numeric,
  score_10 numeric(4,2),               -- normalized, unrounded
  weight numeric(3,2) not null,
  descriptors jsonb,                   -- AI-extracted tasting descriptors (never review prose)
  excerpt text check (excerpt is null or length(excerpt) <= 120),
  match_status text not null default 'pending'
    check (match_status in ('auto','confirmed','pending','rejected')),
  match_score numeric(4,3),
  fetched_at timestamptz not null default now(),
  unique (source_id, source_ref)
);
create index spirit_reviews_product on public.spirit_reviews (product_id) where product_id is not null;
create index spirit_reviews_pending on public.spirit_reviews (fetched_at) where match_status = 'pending';

-- The "what the experts say" paragraph, regenerated only when a bottle gains a source.
create table public.spirit_summaries (
  product_id uuid primary key references public.spirit_products(id) on delete cascade,
  summary_text text not null,
  review_ids uuid[] not null,
  model text,
  updated_at timestamptz not null default now()
);

-- Scans that found no bottle; ratings.py works through these on its next run.
create table public.spirit_lookup_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  query text not null check (length(query) between 2 and 200),
  product_id uuid references public.spirit_products(id) on delete cascade,
  status text not null default 'open' check (status in ('open','done','no_results')),
  created_at timestamptz not null default now()
);

-- Link a bottle in your bar to its catalog entry.
alter table public.inventory_items
  add column if not exists product_id uuid references public.spirit_products(id) on delete set null;

-- RLS: the catalog is shared reference data. Signed-in users read it; only the
-- secret key (ratings.py) writes. The lookup queue is per user.
alter table public.rating_sources      enable row level security;
alter table public.spirit_products     enable row level security;
alter table public.spirit_aliases      enable row level security;
alter table public.spirit_barcodes     enable row level security;
alter table public.spirit_reviews      enable row level security;
alter table public.spirit_summaries    enable row level security;
alter table public.spirit_lookup_queue enable row level security;
create policy "signed-in read" on public.rating_sources   for select to authenticated using (true);
create policy "signed-in read" on public.spirit_products  for select to authenticated using (true);
create policy "signed-in read" on public.spirit_aliases   for select to authenticated using (true);
create policy "signed-in read" on public.spirit_barcodes  for select to authenticated using (true);
create policy "signed-in read" on public.spirit_summaries for select to authenticated using (true);
create policy "signed-in read matched" on public.spirit_reviews for select to authenticated
  using (match_status in ('auto','confirmed'));
create policy "users add lookups" on public.spirit_lookup_queue for insert to authenticated
  with check (user_id = auth.uid());
create policy "users see their lookups" on public.spirit_lookup_queue for select to authenticated
  using (user_id = auth.uid());

-- Bottles that look like q (a normalize.norm_name() key), best first.
create or replace function public.spirit_candidates(q text, max_results int default 5)
returns table (product_id uuid, canonical_name text, category text, age_years int,
               abv numeric, batch text, score real)
language sql stable set search_path = public, extensions as $$
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
$$;

-- One blended score per bottle (formula above). security_invoker so RLS applies.
create or replace view public.spirit_consensus with (security_invoker = true) as
with w as (
  select r.product_id, r.source_id, r.score_10,
         r.weight * power(0.5, greatest(0, extract(year from now())::int
                                            - coalesce(r.review_year, extract(year from now())::int)) / 10.0) as w
  from public.spirit_reviews r
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
       case when sum(w.w) >= 2.5 and count(distinct w.source_id) >= 2 then 'high'
            when sum(w.w) >= 1 then 'medium' else 'low' end as confidence,
       round((sum(w.w * w.score_10) + 7.0) / (sum(w.w) + 1), 2) as rank_score
from w join public.spirit_products p on p.id = w.product_id
group by p.id, p.canonical_name, p.category;
```

**Building it, from your Mac.** Every writing command is a dry run until you add
`--apply`. Credentials come from the environment, `notes.md` or `.env.local`
(the secret / service-role key — it bypasses RLS, local use only).

```bash
cd scripts/ratings
python3 ratings.py seed --apply                       # catalog every named bottle in your bar
python3 ratings.py product "Weller Full Proof" --category bourbon --apply
python3 ratings.py score "Knob Creek 12" --source iwsc --raw 95 --year 2022 \
    --url https://www.iwsc.net/results/detail/120667 --apply   # a result you looked up
python3 ratings.py score "Knob Creek 9" --source distiller --raw 88 --year 2025 --apply
python3 ratings.py score "Wyoming Whiskey" --source whiskey_wash --scale critic100 --raw 86 --year 2015 --apply
python3 ratings.py show                               # consensus scores, best first
bash first_scores.sh --apply                          # every score found so far, with its source link
```

`score` needs the bottle in the catalog first (`seed` or `product`). `--scale`
overrides the source's scale for one review, for a source that changed scales
(The Whiskey Wash's older reviews are out of 100). `first_scores.sh` is the
record of what was looked up: only the critic's own review page, the
competition's own results, or the brand's own awards list count, never a
retailer, and never a site whose robots.txt keeps scripts or AI agents out. For an
IWSC result with no points, use `--medal "Silver Outstanding"` instead of
`--raw`. Packaging, design and highball awards don't count; they're not about
what's in the bottle.

**The automated collector (`iwsc`, `inspect`, `review`) is parked.** It was
written for IWSC, which now blocks scripts, so `iwsc` stops with an explanation
before touching Supabase. The fetch code is kept for a future source that
allows it. It follows robots.txt (401/403 or an unreachable file means keep
out), waits 4 s between requests, and caches pages in `scripts/ratings/cache/`
(gitignored) for 30 days. It links a result to a bottle automatically only on
a clear name match (similarity ≥ 0.55 with a 0.10 lead) where age, ABV and
batch don't conflict; everything else waits for `review`.
`testing-skills/ratings_normalize_test.py` pins the conversions, name matching,
the IWSC parser (synthetic pages, never checked against real ones) and the
robots rules, all offline.

### Bottles: looking a bottle up in the app

On the **Bar** tab, **Bottles** sits next to Recipes. It has a **Look up a
bottle** button (photograph the label, or type a name) and a **Best rated**
list of every scored bottle in the catalog, filterable by category. A lookup
lands on one of three screens:

- **One clear match** → the score card: the 0–10 score, its confidence, and
  every review behind it with a link to the page it came from. *Add to my bar*
  (or *In your bar*), and *Wrong bottle?* to report a bad match.
- **Several close matches** → *Which one is it?* (the label's age, proof and
  batch already rule out the impossible ones). Picking one teaches the catalog
  that label's wording, so the next scan of it is instant.
- **Not in the catalog** → *Look it up*: the `research-bottle` function searches
  critic reviews and competition results on the web and saves what it can cite.
  About 20–30 seconds; it keeps going if the sheet is closed, and a toast says
  when it's done.

**A known bottle is re-checked too.** A lookup that lands on a bottle already in
the catalog shows its score at once, then asks `research-bottle` to *check* it:
confirm the scores we hold still say what their pages say, and add new ones.
The card updates in place (“Updated — 2 new reviews” / “Up to date”). The check
is skipped when that bottle was checked in the last 7 days by anyone
(`VERIFY_FRESH_DAYS` in the function; 0 = every lookup). Opening a bottle from
Best rated or a score chip doesn't spend anything; the card says when it was
last checked and offers *Check for newer reviews*. A known score whose page now
shows something different is flagged in `ratings.py reports` — never rewritten
automatically, since a search can land on the wrong bottle's page.

**The searches are curated, best sources first.** Each lookup runs three
stages, each limited to its own sites, so the best sources are always tried:

1. **Critics' own review sites** — Wine Enthusiast and Drinkhacker for every
   spirit; Whisky Advocate, Breaking Bourbon, The Whiskey Wash and WhiskyCast
   for whiskey.
2. **Competitions' own results** — IWSC, SFWSC (via SevenFifty Daily, which
   publishes them), The Spirits Business Masters, Bartender Spirits Awards,
   International Spirits Challenge, Concours Mondial de Bruxelles, NYISC.
3. **Everything else** minus the blocked list — mainly the producer's own
   awards page, and other independent critics.

The plan is data: `rating_sources.search_tier / search_domains /
search_categories` (setup SQL step 7). Add a critic or reorder with SQL; no
redeploy.

The bottles in **Bar & Pantry** show their score beside them.

Photos go to `identify-bottle` (Claude Haiku reads brand, expression, age, ABV,
batch from the label — about half a cent; 40 a day). Typed names never touch AI:
the app normalises the name (the same rules as `normalize.py`, ported to JS) and
calls `spirit_candidates` directly.

**How lookups grow the shared catalog.** Every review row records where it came
from: `origin` is `curated` (looked up by hand, `first_scores.sh`), `bulk`
(a competition's published results, `sfwsc-import`) or `field` (an in-app
lookup). Field rows start **unverified** and count at ¾ weight in the score
until they're confirmed — automatically when a later, independent lookup
finds the same review, or by hand with `ratings.py field`. `research-bottle`
only keeps a score when:

- its page was in the search results the model actually got (no invented
  links), and wherever the model cited that page, the cited words contain the
  score or medal;
- the site isn't one whose terms forbid this or whose robots.txt keeps AI
  agents out (Distiller, Tastings.com, Tequila Matchmaker, Forbes, …);
- it's for this exact bottle (age, proof and batch agree), and on a page whose
  title doesn't name the bottle (a competition's results list, a brand's awards
  page) the cited line has to name it beside the medal;
- a medal and the points from one competition entry are one score, a known
  score re-read off the same page under another label is a confirmation, and
  independent reviewers (blogs) only count when no named critic has scored the
  bottle — at most two, the most recent.

**Which model** came from a paid comparison (`testing-skills/bottle_model_compare.py`,
2026-11-09): on bottles with hand-checked scores, Haiku 5.5 and Sonnet 5.5
confirmed the same known scores, at 9–15¢ vs 55–89¢ a lookup. To compare again,
set the `ALLOW_MODEL_OVERRIDE` secret to `1` on research-bottle (it enables a
dry-run mode that writes nothing), run the script with `--yes`, then delete the
secret.

A bottle's research is shared: a lookup that finds nothing is remembered for 30
days, a bottle checked in the last 7 days isn't checked again, and two people
scanning the same bottle at once share one search. Per-user cap: 20
lookups or checks a day (≈9–15¢ each, Haiku 5.5 + web search; each lookup logs its
real cost in `spirit_lookups.detail`); a site-wide cap of 200 a
day protects the bill. *Wrong bottle?* reports land in `ratings.py reports`.

**One-time setup (SQL editor)** — after the catalog SQL above:

```sql
-- 1. Where each score came from, so lookups can grow the catalog safely.
alter table public.spirit_reviews
  add column if not exists origin text not null default 'curated'
    check (origin in ('curated','bulk','field')),
  add column if not exists added_by uuid references auth.users(id) on delete set null,
  add column if not exists verified boolean not null default true,
  add column if not exists seen_count int not null default 1;
alter table public.spirit_products
  add column if not exists researched_at timestamptz,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- 2. Catch-alls for scores a lookup finds outside the named sources.
insert into public.rating_sources (id, name, kind, scale, default_weight, scrape_ok, homepage, tos_notes) values
 ('other_critic','Other critic','critic','critic100',0.5,false,null,'Found by an in-app lookup; reviewer = the publication.'),
 ('other_competition','Other competition','competition','medal',0.5,false,null,'Found by an in-app lookup; reviewer = the competition.')
on conflict (id) do nothing;

-- 3. One row per lookup: the lock while it runs, the memory of "nothing found",
--    the audit trail. Written only by the research-bottle function.
create table public.spirit_lookups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  query text not null check (length(query) between 2 and 200),
  name_norm text not null,
  product_id uuid references public.spirit_products(id) on delete set null,
  status text not null default 'running' check (status in ('running','found','none','failed')),
  added int not null default 0,
  detail text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index spirit_lookups_one_running on public.spirit_lookups (name_norm) where status = 'running';
create index spirit_lookups_recent on public.spirit_lookups (name_norm, created_at desc);
alter table public.spirit_lookups enable row level security;
create policy "signed-in read" on public.spirit_lookups for select to authenticated using (true);

-- 4. "Wrong bottle?" / "wrong score" from the score card.
create table public.spirit_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id uuid references public.spirit_products(id) on delete cascade,
  review_id uuid references public.spirit_reviews(id) on delete cascade,
  kind text not null check (kind in ('wrong_bottle','wrong_score','other')),
  note text check (note is null or length(note) <= 300),
  status text not null default 'open' check (status in ('open','fixed','dismissed')),
  created_at timestamptz not null default now()
);
alter table public.spirit_reports enable row level security;
create policy "users report" on public.spirit_reports for insert to authenticated
  with check (user_id = auth.uid());
create policy "users see their reports" on public.spirit_reports for select to authenticated
  using (user_id = auth.uid());

-- 5. Picking a bottle teaches the catalog that label's wording.
create or replace function public.spirit_confirm_alias(p_product uuid, p_alias_norm text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_alias_norm is null
     or length(p_alias_norm) not between 2 and 200 then
    return;
  end if;
  insert into public.spirit_aliases (alias_norm, product_id)
  select p_alias_norm, p.id from public.spirit_products p where p.id = p_product
  on conflict (alias_norm) do nothing;
end;
$$;
revoke execute on function public.spirit_confirm_alias(uuid, text) from public;
revoke execute on function public.spirit_confirm_alias(uuid, text) from anon;
grant execute on function public.spirit_confirm_alias(uuid, text) to authenticated;

-- 6. Daily caps: label photos ('scan') and web lookups ('lookup'), counted apart.
create table public.bottle_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  kind text not null check (kind in ('scan','lookup')),
  count int not null default 0,
  primary key (user_id, usage_date, kind)
);
alter table public.bottle_usage enable row level security;
create policy "users see their usage" on public.bottle_usage for select to authenticated
  using (user_id = auth.uid());

create or replace function public.increment_bottle_usage(usage_kind text, daily_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
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
$$;
revoke execute on function public.increment_bottle_usage(text, int) from public;
revoke execute on function public.increment_bottle_usage(text, int) from anon;
grant execute on function public.increment_bottle_usage(text, int) to authenticated;

-- 7. The curated search plan: which sites a lookup searches, in what order,
--    for which categories. Stage 1 = tier 1 (critics' own review sites),
--    stage 2 = tier 2 (competitions' own results), stage 3 = the open web minus
--    the blocked list (mainly producers' own awards pages). Edit these rows to
--    change the plan; research-bottle reads them on every lookup.
alter table public.rating_sources
  add column if not exists search_tier int,
  add column if not exists search_domains text[],
  add column if not exists search_categories text[];
alter table public.spirit_reviews add column if not exists last_checked_at timestamptz;
insert into public.rating_sources (id, name, kind, scale, default_weight, scrape_ok, homepage, tos_notes) values
 ('isc','International Spirits Challenge','competition','medal',0.5,false,'https://www.internationalspiritschallenge.com','Medal results.'),
 ('cmb','Concours Mondial de Bruxelles','competition','medal',0.5,false,'https://concoursmondial.com','Medal results (Grand Gold / Gold / Silver).'),
 ('nyisc','New York International Spirits Competition','competition','critic100',0.5,false,'https://nyispiritscompetition.com','Medal and points.')
on conflict (id) do nothing;
update public.rating_sources r set search_tier = p.tier, search_domains = p.domains, search_categories = p.cats
from (values
  ('wine_enthusiast',          1, array['wineenthusiast.com'],                null::text[]),
  ('drinkhacker',              1, array['drinkhacker.com'],                   null),
  ('whisky_advocate',          1, array['whiskyadvocate.com'],                array['whiskey','bourbon','rye','scotch']),
  ('breaking_bourbon',         1, array['breakingbourbon.com'],               array['bourbon','rye','whiskey']),
  ('whiskey_wash',             1, array['thewhiskeywash.com'],                array['whiskey','bourbon','rye','scotch']),
  ('whiskycast',               1, array['whiskycast.com'],                    array['whiskey','bourbon','rye','scotch']),
  ('iwsc',                     2, array['iwsc.net'],                          null),
  ('sfwsc',                    2, array['daily.sevenfifty.com'],              null),
  ('spirits_masters',          2, array['thespiritsbusiness.com'],            null),
  ('bartender_spirits_awards', 2, array['bartenderspiritsawards.com'],        null),
  ('isc',                      2, array['internationalspiritschallenge.com'], null),
  ('cmb',                      2, array['concoursmondial.com'],               null),
  ('nyisc',                    2, array['nyispiritscompetition.com'],         null)
) as p(id, tier, domains, cats)
where r.id = p.id;

-- 8. Unverified lookup finds count ¾ until confirmed.
create or replace view public.spirit_consensus with (security_invoker = true) as
with w as (
  select r.product_id, r.source_id, r.score_10,
         r.weight * (case when r.verified then 1 else 0.75 end)
                   * power(0.5, greatest(0, extract(year from now())::int
                                            - coalesce(r.review_year, extract(year from now())::int)) / 10.0) as w
  from public.spirit_reviews r
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
       case when sum(w.w) >= 2.5 and count(distinct w.source_id) >= 2 then 'high'
            when sum(w.w) >= 1 then 'medium' else 'low' end as confidence,
       round((sum(w.w * w.score_10) + 7.0) / (sum(w.w) + 1), 2) as rank_score
from w join public.spirit_products p on p.id = w.product_id
group by p.id, p.canonical_name, p.category;
```

Then deploy two Edge Functions (dashboard paste, as for the others; both use the
existing `ANTHROPIC_API_KEY` secret): `supabase/functions/identify-bottle` and
`supabase/functions/research-bottle`. `research-bottle` writes the catalog with
the function's own service-role key, which Supabase provides to every function.

**Building it up from your Mac:**

```bash
python3 ratings.py sfwsc-import --year 2025              # preview ~3,000 SFWSC medals
python3 ratings.py sfwsc-import --year 2025 --apply      # add them (new bottles + medals)
python3 ratings.py field                                 # walk unverified lookup finds: verify / reject
python3 ratings.py reports                               # "Wrong bottle?" reports from the app
```

`sfwsc-import` reads SevenFifty Daily's published SFWSC results PDF (the
competition's own site keeps AI agents out; SevenFifty's allows scripts). macOS
PDFKit does the reading through `scripts/ratings/pdf_rows.js`, which splits the
table by column position — the PDF's text layer runs the columns together. A
medal joins an existing catalog bottle only on a clear name match with no
age/ABV/batch conflict; otherwise it becomes a new bottle (category guessed from
the name). Medals are SFWSC's own tiers (Bronze 5.5 … Double Gold 8.5) at half
weight. Pass `--url` for another year's PDF.

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

## King Soopers ordering (Kroger)

Turns the grocery list into a King Soopers order (King Soopers is a Kroger
banner, same public API). The **🛒 Send to King Soopers** button on the grocery
panel matches each still-needed item to a store product and (Stage B) pushes the
whole list into the user's real Kroger cart to check out in the Kroger app.

**Stage A (shipped): store setup + product matching.** No user login — the
`kroger` Edge Function mints a client-credentials token server-side to look up
stores by ZIP and match products. It's **fail-safe**: with no Kroger credentials
set, the button returns a friendly "not set up yet" message, so deploying is a
no-op until you enable it. **Stage B (later): OAuth login + cart push.**

**Enable it** — register a free app at developer.kroger.com (Public tier,
self-service) and set these Edge Function secrets (Edge Functions → Secrets):

- `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` — from the Kroger app. Server-side
  only, never in the frontend. Unset = the feature shows "not set up yet".
- `KROGER_REDIRECT_URI` (Stage B, for OAuth) — the deployed app URL,
  `https://strockerik.github.io/Strock-Recipes/`. Register this **same** URI in
  the Kroger app's redirect list (the field is marked optional but the login
  flow fails without it).

**One-time SQL (Supabase SQL editor):**

```sql
-- Ordering preferences on the profile row (owner-only RLS already covers it).
-- Shape: { locationId, storeName, zip, productPref: "organic"|"cheapest"|"best", modality: "PICKUP"|"DELIVERY" }
alter table public.profiles
  add column if not exists kroger_prefs jsonb not null default '{}'::jsonb;

-- Per-ingredient product-match cache (re-order memory): cooking a recipe again
-- re-resolves its items to the same product for free. One small row per distinct
-- item ever matched. Owner-only, same pattern as inventory_items.
create table public.kroger_matches (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ingredient_key text not null,
  product_id text,
  upc text,
  description text,
  image_url text,
  updated_at timestamptz not null default now(),
  primary key (user_id, ingredient_key)
);
alter table public.kroger_matches enable row level security;
create policy "owners manage their kroger matches" on public.kroger_matches
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Stage B: per-user Kroger OAuth tokens (one row per user). Owner-only RLS; the
-- frontend never reads this — only the kroger function does, via the user's JWT.
create table public.kroger_tokens (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.kroger_tokens enable row level security;
create policy "owners manage their kroger tokens" on public.kroger_tokens
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

Until this runs (and the secrets are set), the feature fails open — the button
just reports it isn't configured yet. **Stage B** additionally needs
`KROGER_REDIRECT_URI` set and registered as the app's redirect URI (above), plus
the `kroger_tokens` table; without them the "Connect King Soopers" step reports
it isn't set up.

### How ingredients are matched & combined

Before your list goes to the store, the app cleans it up and matches each line to
a product. Here's what it assumes — so you know when to override a pick (you can
always change or remove any item in the review sheet, and substitute in the
Kroger app). The behaviour lives in `app.js` (combining/pantry) and the `kroger`
Edge Function (store search); this is a plain-language summary, and
`testing-skills/benchmark_corpus.py` guards it against regressions.

**Combining — different wording, one line.** These are treated as the same
product and merged:

- Chicken cuts: "boneless/skinless" dropped; "breast or thighs" → breast.
- Yeast: instant / rapid-rise / bread-machine yeast → "instant yeast". *(Active-dry
  and fresh yeast stay separate — they really are different.)*
- Onion: size and raw-prep words ("medium", "thinly sliced", "diced", "grated"…) are
  dropped, but a named variety is kept — "finely diced red onion" → "red onion",
  "chopped yellow onion" → "yellow onion", "chopped onion" → "onion". "Green onion",
  "pearl onion", "onion powder" and dried/frozen onion stay their own thing.
- Milk: "whole/warm/2% milk" → "milk" (nut milks like "almond milk" stay distinct;
  a trailing "…, whole milk" fat note on another item, e.g. yogurt, is left alone).
- Scallion → green onion. Parmesan ≡ Parmigiano-Reggiano. Mozzarella descriptors in
  either order are one product. "Spaghetti pasta" → spaghetti.
- Flexible pasta ("bucatini (or any pasta)", "pasta (spaghetti or bucatini)") →
  one generic "pasta" line; a plain named shape ("spaghetti") is left as-is.
- **Kept separate on purpose:** tomato products (crushed / whole / puree / paste /
  sauce), Pecorino vs Parmesan, active-dry vs instant yeast.

**Serving sizes.** A recipe measured in *people* ("servings", "drinks") scales to
your household size (set in Account). A recipe measured in a *batch/yield* ("1
tart", "1 pizza", "24 cookies", "1 loaf") makes its stated amount — it isn't
multiplied by your household, because one tart already feeds the table.

**Pantry & staples.** Salt, pepper, oil, water, sugar, butter and plain flour are
assumed on hand and skipped. Specialty flours (00, bread/high-gluten, cake, almond…)
*are* bought. Fresh produce and herbs are never treated as "already in your pantry"
(you rebuy them); dried/ground spices are. A processed form ("garlic powder") is
pantry; the fresh form ("garlic cloves") is bought.

**Quantities.** Each cart line shows the amount in parentheses and how many recipes
it's for — "(5 lb) Ground Beef · for 3 recipes". Produce you buy whole is shown in
purchase units: garlic cloves → "≈ N bulbs", tomato slices → "≈ N tomatoes".
**Citrus** is counted in whole fruit from its peel + juice — one lime covers both its
juice and its peel in a recipe (so they don't double up), and it's summed across
recipes: "(17) limes". Lines that resolve to the same product are added once.

**Store matching — the plainest form of what you asked for.** Unless the recipe is
specific, the app prefers the basic product: raw produce over processed ("carrots",
not "cut & peeled baby carrots"); real spirits over sauces ("vodka", not "vodka
sauce"); baking chocolate as chips; a bare "cheese" as shredded cheddar; a "zest"
ingredient as the whole fruit; "tomatoes for sauce" as canned crushed; raw meat over
deli/lunchmeat. If the recipe *does* say canned, shredded, sliced, etc., that form is
matched. A couple of these are sensible **defaults** for genuinely ambiguous items, not
fixed facts — a bare "cheese" → shredded cheddar, and baking "chocolate" → chips; if you
meant mozzarella or a chocolate bar, just change that line in the review sheet.

**Left off the list.** Things the recipe makes itself (a component it builds from
other listed ingredients — e.g. a "Dry Mix" or "Pie Crust" the recipe assembles),
plain water, and "alternative to…" / "substitute for…" fallbacks (the primary
ingredient is already on the list).

## Edge Function deployment (AI)

There are **five** Edge Functions, each deployed via the Supabase dashboard (Edge
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
- **`kroger`** — 🛒 Send to King Soopers (grocery list → store product matches;
  Stage B adds cart push). Same deploy: paste in
  `supabase/functions/kroger/index.ts`, Deploy. **Not an AI function** — it uses
  the `KROGER_*` secrets (see "King Soopers ordering"), not `ANTHROPIC_API_KEY`,
  and has no daily cap (Kroger's own rate limits apply).

Requirements (JWT/deploy rules apply to **all five** functions; the cap note
applies only to the four AI functions):

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

### Offline

Once you've opened the app online, it opens with **no connection** too
(`sw.js`, a service worker): your recipes, grocery list, meal plan and pantry
show as of the last time they synced, under a quiet "You're offline" note.
Cook mode works fully. **Grocery check-offs keep working** — ticks made offline
are saved on the phone and sent when the connection returns. Every other change
(saving a recipe, AI features, King Soopers) needs a connection and says so.

How it stays safe and current:
- The app's own files load **network-first**, so an online visit always gets the
  latest deploy — the cached copy is only the fallback (and it's used after ~4 s
  of a stalled connection, for grocery-store "lie-fi").
- Recipe data is cached **only for a signed-in user's reads**; a different user
  signing in on the device wipes it, and so does signing out.
- If an hour-old login can't refresh because you're offline, the app opens as you
  (read-only) instead of showing the sign-in screen, and swaps in live data as
  soon as the connection is back.
- To retire every cached copy of the app shell, bump `VERSION` in `sw.js`. If the
  service worker ever misbehaves, deploy an `sw.js` whose `activate` handler calls
  `self.registration.unregister()` — that's the kill switch.

### Version number

The app's release number shows as a small pill at the bottom of the page
(**v1.0** as of 2026-11-08). It lives in one place: `APP_VERSION` at the top of
`app.js`. Bump it when a release ships: the minor number for features and
fixes (1.1, 1.2…), the major number for a big change (2.0). It's a label for
people only. It is separate from `VERSION` in `sw.js`, which retires cached
copies and doesn't need to change with each release.

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
`scripts/backup_recipes.py` reads `SUPABASE_URL` and the **secret** key from the
environment (`SUPABASE_SECRET_KEY`) or a `Secret Key: sb_secret_…` line in the
gitignored `notes.md` — falling back to the legacy service-role key until Supabase
retires it (same as `migrate_ingredients.py`).

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

## UI conventions worth not undoing

These came out of the UX review of 2026-10-20 and are load-bearing in more than
one place. `testing-skills/ux_review_smoke_test.py` guards all of them.

**Sheets manage themselves.** Every `.grocery-panel` / `.cook-panel` is watched
by a `MutationObserver` on its `hidden` attribute (see "Sheets: focus, scroll
lock, Escape" in `app.js`). Whatever flips `hidden` — a click handler, a test,
a future panel — the sheet gets focus moved into it, the page behind locked,
focus handed back on close, and Escape closing the innermost one only. Don't
reintroduce per-panel focus or `body.style.overflow` handling; register the
panel with `registerSheet()` instead. A panel that focuses its own field right
after opening still wins: the observer only takes focus if nothing inside has
it.

**Toggles patch their row, they don't rebuild the list.** `renderList()`
replaces every row's markup, which drops keyboard focus to `<body>`. The star,
the grocery checkbox, the 📅 box and the unit toggle all go through
`paintStar` / `paintTrayState` / `rerenderRow` instead. Reach for `renderList()`
only when the *set* of rows changes.

**Three list states, not two.** `dataState` is `loading` | `ready` | `error`.
A failed load must never render the "No recipes yet" invitation — that read as
"your recipes are gone" on a bad connection. `loadData` is wrapped so anything
thrown lands in the error state with a Try again button, rather than leaving
the placeholder rows up forever.

**Small glyphs get an invisible 44px hit area**, never a bigger glyph — see the
`::after` overlay block in `style.css`. The two right-edge row controls (📅 and
★) use 38px instead, because a full 44 would swallow the chevron 12px away.
`viewport_smoke_test.py` measures these.

**`--faint` must stay at 4.5:1 on `--paper`.** It carries every piece of quiet
text in the app and is used ~96 times; it was #8A8276 (3.67:1) until the review.

**Unsaved work is confirmed before it's discarded.** `closeRecipeForm()` asks
unless passed `force` — the ✕ Close button is the only thing that passes it. An
AI-filled form counts as dirty from the moment it's filled, because that's the
screen most worth not losing.

**Failures use `toastError` / `toast(msg, true)`**, never a raw provider string:
Supabase messages are not kitchen language. Server-authored copy from the Edge
Functions (daily-cap notices, the Instagram guidance) goes through
`aiErrorText`, which shows it as written rather than prefixing it with "Error:".

## Local preview

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

Use a local server (rather than opening the file directly) so Supabase auth and
its redirects work correctly.
