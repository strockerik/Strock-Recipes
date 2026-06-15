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
OFF signs the new account in immediately. The app handles both.

## Adding recipes

Use the app — no editing JS files:

- **✨ Add with AI** — snap or choose a photo of a recipe (cookbook page,
  handwritten card, screenshot), paste a link to a recipe page, or paste text
  (e.g. an Instagram caption); AI fills in the whole form for you to review,
  edit, and save. Photos are downscaled and converted to JPEG in the browser
  before upload, so iPhone HEIC photos work. For links, the Edge Function
  fetches the page server-side and prefers the site's embedded schema.org
  Recipe data (JSON-LD) over raw page text — most recipe blogs have it.
  Login-walled or heavily scripted pages (Instagram, TikTok) won't fetch;
  paste the caption text for those. Two other categories of link can't be
  fetched either, and the app will tell you to paste text instead:
  **bot-protected sites** (e.g. liquor.com) — their Cloudflare-style
  protection blocks any non-browser request outright, no matter the headers —
  and **JS-only "app" sites** (e.g. some recipe-card apps built with
  React/Vite) whose server response is an empty shell with no content until
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
  ingredient rows, method steps, notes).
- Open any recipe to **Edit** or **Delete** it — or tap **▶ Cook** for a
  full-screen guided mode: one step at a time, tap to advance, an ingredients
  toggle scaled to your servings, and the screen stays awake while you cook.

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

-- Owners can create/view/delete shares for recipes they own. The `with check`
-- subquery stops anyone from "sharing" a recipe_id they don't actually own.
create policy "owners manage shares on their recipes"
  on public.recipe_shares for all
  to authenticated
  using (shared_by_user_id = auth.uid())
  with check (
    shared_by_user_id = auth.uid()
    and exists (
      select 1 from public.recipes r
      where r.id = recipe_id and r.user_id = auth.uid()
    )
  );

-- Recipients can see shares directed at them (drives "Shared by X" lookups).
create policy "recipients view shares directed at them"
  on public.recipe_shares for select
  to authenticated
  using (shared_with_user_id = auth.uid());

-- 4. A recipe is visible if you own it (existing policy, unchanged) or it has
-- been explicitly shared with you.
create policy "recipes shared with you are viewable"
  on public.recipes for select
  to authenticated
  using (
    exists (
      select 1 from public.recipe_shares rs
      where rs.recipe_id = recipes.id and rs.shared_with_user_id = auth.uid()
    )
  );

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

> **Note:** recipes previously shared via the old "share with household"
> toggle stop being shared with anyone once this SQL runs (`recipe_shares`
> starts empty) — re-share them with specific people's emails afterward.

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
one line. Weights and volumes are converted to what a US grocery store sells
(grams/kg → oz/lb, ml/l → cups/tbsp/tsp); small gram amounts like yeast or
spices are left as-is. Tap an item to check it off as you shop, or use **Skip
pantry staples** to hide salt, pepper, oil, water, sugar, and butter from the
list. The **By recipe** section below the list still shows each recipe's full
ingredients at your chosen servings, unaffected by the staples toggle.

The grocery selection lives in the current session, so fully closing the app
resets the checked recipes and check-offs — build the list and send it to Keep.

## Add to your iPhone home screen

1. Open the live URL in **Safari**.
2. **Share → Add to Home Screen → Add**.
3. Launching from the home screen opens it full-screen and behaves like a native
   app. Sign in once and your recipes sync to any device you sign in on with the
   same email + password.

## Local preview

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

Use a local server (rather than opening the file directly) so Supabase auth and
its redirects work correctly.
