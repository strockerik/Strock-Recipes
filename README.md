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
data/recipes.js, data/cocktails.js      pre-migration backup of the original static data (unused)
```

`config.js` exposes the Supabase URL and **anon** key. That is intentional and
safe — the anon key only permits what RLS allows. The **service-role** key
(which bypasses RLS) must never be committed; it stays in the gitignored
`notes.md` / `.env.local` for one-off local admin tasks only.

## Accounts

- **Sign in** with your email + password.
- **Create account** makes a new private recipe book for a new email.
- **Forgot password?** emails a link that returns to the app and prompts you to
  set a new password (also how you set a password the first time on an account
  that was originally created via magic link).
- **Account** (next to Sign out, once signed in) lets you set a new password
  without signing out.

New-account behavior depends on the Supabase **Authentication → Providers →
Email → "Confirm email"** setting: ON sends one confirmation email at signup;
OFF signs the new account in immediately. The app handles both. To avoid tripping
Supabase's rate limit, the sign-in / create-account / reset buttons disable
themselves while a request is in flight (one request per tap).

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
  (e.g. an Instagram caption); AI fills in the whole form for you to review,
  edit, and save. Photos are downscaled and converted to JPEG in the browser
  before upload, so iPhone HEIC photos work. For links, the Edge Function
  fetches the page server-side and prefers the site's embedded schema.org
  Recipe data (JSON-LD) over raw page text — most recipe blogs have it.
  **YouTube** links work too: the function reads the recipe out of the video's
  description (and falls back to the auto-generated captions if the description
  is just a teaser), so a cooking video whose creator listed the recipe extracts
  like any other page. Login-walled or heavily scripted pages (Instagram,
  TikTok) won't fetch; paste the caption text for those. Two other categories of
  link can't be fetched either, and the app will tell you to paste text instead
  (with a one-tap **📋 Paste text instead** button right on the error):
  **bot-protected sites** (e.g. liquor.com, AllRecipes, Serious Eats) — their
  Cloudflare-style protection blocks any non-browser request outright, no matter
  the headers — and **JS-only "app" sites** (e.g. some recipe-card apps built
  with React/Vite) whose server response is an empty shell with no content until
  client-side JavaScript runs. Both are fundamental limits of fetching a page
  server-side, not bugs to retry. Text and link extractions cost roughly half
  a cent (Haiku); photo extractions a couple of cents (Sonnet, needed to read
  messy handwriting). The AI completes cut-off recipes, infers proportions when
  only ingredients are given, and ignores non-recipe clutter on the card or
  screenshot — anything it guesses shows up as an "AI added:" line in Notes.
  Each account is capped at **20 AI extractions/day** (resets at midnight UTC)
  to keep API costs predictable.
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

## AI extraction limit

Each account can run at most **20 AI extractions/day** (any mix of photo,
text, or link), enforced server-side so it can't be bypassed from the
browser. The count resets at midnight UTC.

**One-time setup (Supabase SQL editor)** — run once:

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

grant execute on function public.increment_extraction_usage(int) to authenticated;
```

If this SQL hasn't been run yet (or the RPC call errors for any reason), the
Edge Function fails open — extraction proceeds without a cap rather than
breaking.

## Edge Function deployment (AI)

`extract-recipe` is deployed via the Supabase dashboard (Edge Functions → the
in-browser editor), with the repo file as the source of truth — keep them in
sync when editing. Requirements:

- Secret `ANTHROPIC_API_KEY` set under Edge Functions → Secrets.
- **Verify JWT: OFF** for this function (it does its own auth check and handles
  the CORS preflight; leaving it on breaks browser calls).
- Set a monthly spend limit on the Anthropic account as a runaway-cost guard.
- After editing the repo's `index.ts`, paste the new contents into the
  dashboard editor and hit Deploy — pushing to GitHub does **not** redeploy it.

VSCode shows errors in `index.ts` ("Cannot find name 'Deno'", "Cannot find
module 'jsr:…'") because its TypeScript server type-checks the file as Node
code. They're cosmetic — the function runs on Supabase's Deno runtime, where
both resolve fine. Installing the official Deno VSCode extension (with
`deno.enablePaths: ["supabase/functions"]`) silences them.

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

The grocery selection lives in the current session, so fully closing the app
resets the checked recipes and check-offs — build the list and send it to Keep.

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

**Everyday, from the app (phone-friendly).** Sign in, then tap **⬇ Back up** in
the header. It exports your recipes as a single JSON file with three options:

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

## Local preview

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

Use a local server (rather than opening the file directly) so Supabase auth and
its redirects work correctly.
