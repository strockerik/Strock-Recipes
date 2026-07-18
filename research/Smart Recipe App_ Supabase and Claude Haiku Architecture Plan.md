# From Static Site to Smart Recipe App: Architecture & Build Plan

## TL;DR

- **Build it on Supabase** (Postgres + Auth + Row Level Security + one Edge Function), keep the frontend as your existing vanilla HTML/CSS/JS deployed on Cloudflare Pages or GitHub Pages, and use **Claude Haiku 4.5** behind a Supabase Edge Function for recipe extraction. This gives you per-user private recipe books, full CRUD, secure API-key handling, and iPhone PWA support with the least new learning for a hobbyist.
- **Realistic running cost is about $0–$1.20 per month.** At ~10 users adding 3–5 recipes/week, AI extraction costs roughly **$0.0058 per recipe** (~0.58 cent), or about **$1.16/month** at the heavy end (200 recipes); everything else (hosting, database, auth) fits inside permanent free tiers. Your only guaranteed bill is the Anthropic API, which you can cap.
- **For the URL-import feature, parse schema.org Recipe JSON-LD first (free and deterministic), then fall back to the LLM only when that fails.** Photo and pasted-text imports always go to the vision LLM. Plan for Instagram/TikTok to mostly fail — design those as “paste the caption text” instead.

## Key Findings

**1. Supabase is the best fit; PocketBase is the simpler-but-more-hands-on runner-up.** Supabase bundles the four things you need — a real database, user login, per-row data isolation, and a place to hide your API key — into one dashboard with a generous free tier. Per Supabase’s 2026 pricing, the Free plan includes 500 MB database, 50,000 monthly active users, 1 GB file storage, 5 GB egress, and 500,000 Edge Function invocations/month, capped at 2 active projects. For 10 users this is wildly over-provisioned and free indefinitely, with one catch you must manage (see Caveats: free projects pause after 7 days of inactivity).

**2. Your LLM API key must never touch the browser.** This is the single most important security rule. The standard, simplest pattern across every platform is a small server-side function (“Edge Function” on Supabase, “Cloud Function” on Firebase, “API route” on Vercel) that stores the key as a secret and relays requests. Supabase documents this exact pattern — the browser calls `supabase.functions.invoke("extract-recipe", …)` and the function holds `ANTHROPIC_API_KEY` as a secret. Putting the key in client JS would let anyone read it from your site and spend your money.

**3. Claude Haiku 4.5 is the right budget model and it now does everything you need in one call.** Per Anthropic’s launch announcement (Oct 15, 2025): “simply use claude-haiku-4-5 via the Claude API. Pricing is now $1/$5 per million input and output tokens” (model ID `claude-haiku-4-5-20251001`, 200K-token context). It supports vision (images), and — confirmed against Anthropic’s docs — per the Claude API release notes: “Structured outputs are now generally available on the Claude API for Claude Sonnet 4.5, Claude Opus 4.5, and Claude Haiku 4.5… GA includes expanded schema support… with no beta header required. The `output_format` parameter has moved to `output_config.format`.” Image input and structured JSON output combine in a single request. A single recipe photo lands at about 1,568 image tokens (capped), so a realistic extraction costs **~$0.0058 per recipe**.

**4. Per-user privacy is enforced by the database itself with Row Level Security (RLS).** You add one column (`user_id`) to your recipes table and one policy (`auth.uid() = user_id`). After that, even if your frontend code has a bug, Postgres physically refuses to return another user’s rows.  This is more robust than filtering in JavaScript and is the architecture that also lets you add sharing later (you’d add a second policy, not rebuild anything).

**5. iPhone home-screen PWAs can take photos, but use the simple file-input method, not the live camera API.** A standard `<input type="file" accept="image/*" capture="environment">` opens the iPhone camera/photo picker reliably from an installed PWA. The fancier live-video `getUserMedia()` API has a documented history of breaking inside iOS home-screen PWAs (permission not persisted, occasional black screen), so avoid it for a photo-upload feature.

**6. The “no backend” options don’t fit private multi-user data.** Committing JSON to a GitHub repo via a personal access token can’t give 10 people their own private books (a repo token grants all-or-nothing access, and any token shipped to the browser is exposed). Local-first storage can’t sync a user’s book between their phone and laptop. A real backend is clearly the correct choice here.

## Details

### A. Platform comparison for your exact use case

|Platform                         |Free tier vs. 10 users                                           |Beginner-friendly?                                               |Auth                                   |Hides API key?                                  |iOS PWA                     |Lock-in / exit                                            |
|---------------------------------|-----------------------------------------------------------------|-----------------------------------------------------------------|---------------------------------------|------------------------------------------------|----------------------------|----------------------------------------------------------|
|**Supabase** (recommended)       |Hugely over-provisioned (500 MB DB, 50k MAU, 500k function calls)|High — clean dashboard, SQL or table UI, lots of tutorials       |Email magic-link / 6-digit OTP built in|Yes — Edge Function + secret                    |Good (use file-input camera)|Low — it’s standard Postgres; `pg_dump` exports everything|
|**PocketBase** (runner-up)       |Effectively unlimited for 10 users; runs on a $4–5/mo VPS        |Medium — one binary, great admin UI, but you self-host & patch it|Built-in email/password + OAuth        |Yes — Go/JS hooks or a tiny proxy               |Good                        |Very low — single SQLite file you own                     |
|**Firebase**                     |50k MAU, 1 GiB Firestore, 2M function calls                      |Medium — powerful but NoSQL data model is a mindset shift        |Excellent, many providers              |Yes — Cloud Function                            |Good                        |Higher — proprietary Firestore; recent free-tier changes  |
|**Vercel + Neon/Postgres + auth**|Generous, but you assemble 3 services                            |Lower — you wire DB + auth + functions yourself                  |Bring-your-own (Auth.js/Clerk)         |Yes — API route                                 |Good                        |Medium                                                    |
|**Replit / Glide / Val Town**    |Varies                                                           |Highest for no-code (Glide) but least control                    |Built-in                               |Glide hides keys; Val Town good for tiny proxies|Varies                      |Glide = high lock-in                                      |

**Why Supabase wins for you:** it’s the only option that gives you database + auth + per-user security + secret-keeping API proxy in *one* product with *one* dashboard and a free tier you’ll never outgrow at this scale — while remaining plain Postgres you can walk away from. PocketBase is genuinely simpler conceptually (one file, one admin screen) and cheaper-feeling, but “self-hosted” means *you* own uptime, TLS certificates, backups, and security patches on a VPS — a real maintenance burden and a documented source of misconfiguration for hobbyists. For a proof-of-concept you want to forget about, managed Supabase is the better trade.

### B. Keeping the API key secret (the critical security point)

Confirmed best practice on all candidates: **never call Anthropic from the browser.** On Supabase the flow is:

1. Store the key once: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-…` (or paste it in Dashboard → Edge Functions → Secrets).
1. Write a small Edge Function (TypeScript/Deno) that reads `Deno.env.get("ANTHROPIC_API_KEY")`, checks the caller is a logged-in user (`supabase.auth.getUser()` returns 401 if not), calls Anthropic, and returns the JSON.
1. The browser only ever calls your function, never Anthropic. The key never ships to the client.

This is the identical concept on Firebase (Cloud Function) and Vercel (API route holding an env var). Supabase even ships a built-in “OpenAI proxy” Edge Function template you can adapt to Anthropic. 

### C. Recipe extraction approaches

**Photo → vision LLM with structured output.** Send the image plus a JSON schema to Claude Haiku 4.5 using `output_config.format`. Structured Outputs use constrained decoding to *guarantee* the reply matches your schema (no markdown fences, no missing fields), eliminating the fragile “please return JSON” parsing that fails 8–15% of the time without schema enforcement. Best-practice prompt: give the model the exact field names you store (ingredients as amount/unit/item objects, ordered method steps, tags, servings), tell it to use `null` for anything not present rather than inventing, and to normalise fractions (“½” → 0.5).

**URL → recipe: hybrid, JSON-LD first.** This is the recommended approach. The large majority of recipe sites embed a `<script type="application/ld+json">` block of schema.org/Recipe data (it’s what produces Google’s recipe rich-cards), with fields `name`, `recipeIngredient`, `recipeInstructions`, `recipeYield`, etc.  Your Edge Function fetches the page server-side (this also solves the CORS problem — a browser can’t fetch most other sites directly), tries to parse JSON-LD first (free, instant, deterministic), and **only if that’s missing or incomplete** passes the page’s visible text to Haiku for extraction. The `recipe-scrapers` Python package (hhursev, MIT, v15.11.0) demonstrates the pattern at scale — it supports 643 cooking websites out of the box, parsing “Schema markup (including JSON-LD, Microdata, and RDFa formats) or OpenGraph metadata,” plus a wild_mode for any site with schema.org/Recipe data.

**Instagram/TikTok reality:** be honest with users — these are largely unscrapable in 2026. Both use login walls, TLS fingerprinting, rapidly-rotating internal endpoints, and signed/expiring URLs; DIY scraping breaks constantly. Design the social path as **“paste the caption text”** which then goes through the same text→LLM extractor. Don’t promise auto-import from a Reel link.

### D. Is a “no-backend” approach viable? (Honest assessment)

No, not for this. **GitHub-API approach:** an app that commits JSON to a repo needs a token; a fine-grained PAT is still all-or-nothing per repo, so you cannot give User A a private book that User B can’t read, and any token embedded in client code is exposed. It also has no real auth. **Local-first (IndexedDB):** great offline, but a user’s recipes would be trapped on one device with no cross-device sync and no way to ever add sharing. Both fail the core “10 users, each with a private synced book” requirement. A managed backend is clearly better and barely more work given AI coding help.

### E. PWA capabilities on iOS in 2026

- **Add to Home Screen** still works; with `display: standalone` and the right meta tags your app launches full-screen with no Safari chrome.
- **Camera/photo:** use `<input type="file" accept="image/*" capture="environment">`. This reliably opens the camera or photo library from an installed PWA. Avoid `getUserMedia()` live video — it has a long documented history of permission and black-screen bugs specifically inside iOS home-screen PWAs.
- **Offline:** a service worker can cache the app shell so it opens offline and shows already-loaded recipes; but adding/extracting recipes needs connectivity (the API call). Treat offline as “read what you’ve loaded,” not “do everything.”
- **Storage limits / eviction:** iOS can evict PWA local storage if the device is low on space or the app is unused for weeks — another reason the source of truth must be the server database, not the phone.

## Recommended Architecture

### Primary recommendation: Static frontend + Supabase + Claude Haiku 4.5

**Component diagram (text):**

```
 iPhone Home-Screen PWA (your existing HTML/CSS/JS, lightly refactored)
        │
        │  (1) Login: email magic-link / 6-digit code  ┌─────────────────────┐
        ├───────────────────────────────────────────▶ │  Supabase Auth      │
        │                                              └─────────────────────┘
        │  (2) Read/write MY recipes (JWT attached)    ┌─────────────────────┐
        ├───────────────────────────────────────────▶ │ Supabase Postgres   │
        │       every query filtered by RLS            │  recipes / cocktails│
        │       (auth.uid() = user_id)                 │  + Row Level Security│
        │                                              └─────────────────────┘
        │  (3) "Add recipe" → photo / URL / text       ┌─────────────────────┐
        └───────────────────────────────────────────▶ │ Supabase Edge Func  │
                                                       │  "extract-recipe"   │
                                                       │  • verifies user    │
                                                       │  • holds ANTHROPIC  │
                                                       │    _API_KEY (secret)│
                                                       │  • JSON-LD parse 1st│
                                                       │  • else call Claude │
                                                       └──────────┬──────────┘
                                                                  │ (4) vision+JSON schema
                                                                  ▼
                                                       ┌─────────────────────┐
                                                       │  Anthropic API      │
                                                       │  Claude Haiku 4.5   │
                                                       └─────────────────────┘
```

Frontend hosting: **Cloudflare Pages** (unlimited bandwidth, free) or stay on **GitHub Pages** — either works since the heavy lifting moved to Supabase.

### Simpler runner-up: PocketBase on a small VPS

One binary that bundles database + auth + admin UI + file storage; add one small server route to proxy Anthropic. Cheaper-feeling and you fully own the data (single SQLite file), but you take on server maintenance, backups, TLS, and security hardening. Choose this only if owning the box appeals to you more than never thinking about it.

## Cost Breakdown

**Per-recipe AI extraction cost (Claude Haiku 4.5):**

|Component                                           |Tokens|Rate     |Cost         |
|----------------------------------------------------|------|---------|-------------|
|Input: image (~1,568, capped) + prompt/schema (~700)|~2,268|$1.00 / M|$0.00227     |
|Output: structured recipe JSON                      |~700  |$5.00 / M|$0.00350     |
|**Total per recipe**                                |      |         |**≈ $0.0058**|

URL imports that succeed via JSON-LD parsing cost **$0** (no LLM call). Text/photo and JSON-LD-failure cases cost ~$0.0058 each.

**Monthly total for 10 users:**

|Item                                     |Provider                       |Monthly cost          |
|-----------------------------------------|-------------------------------|----------------------|
|Static frontend hosting                  |Cloudflare Pages / GitHub Pages|$0 (free tier)        |
|Database (Postgres)                      |Supabase Free                  |$0                    |
|Auth (magic link / OTP)                  |Supabase Free (50k MAU)        |$0                    |
|Serverless function (API proxy)          |Supabase Free (500k calls)     |$0                    |
|LLM extraction — light (10×3/wk ≈ 130/mo)|Anthropic                      |~$0.75                |
|LLM extraction — heavy (10×5/wk ≈ 200/mo)|Anthropic                      |~$1.16                |
|**Total**                                |                               |**≈ $0–$1.20 / month**|

Cost levers if you ever need them: the **Batch API halves token cost**  (not needed at this volume, and it’s not interactive), and **prompt caching** drops cached input to $0.10/M. Neither is necessary — your bill is already nominal. Set a spend cap / billing alert on the Anthropic account so a bug can’t run up a surprise.

*(If you choose PocketBase instead of Supabase, add ~$4–5/month for a VPS.)*

## Text-Based Wireframes (mobile-first, clean & light)

Design notes reflected throughout: **white/very-light background, generous whitespace, one accent colour, large tap targets, no dark theme.** Kitchen and Bar are preserved as top tabs.

**1. Sign-in**

```
┌──────────────────────────┐
│        🍳  Recipes        │   ← logo, lots of white space
│                          │
│  Sign in to your book    │
│ ┌──────────────────────┐ │
│ │ you@email.com        │ │   ← single email field
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │   Email me a code →  │ │   ← magic link / 6-digit OTP
│ └──────────────────────┘ │
│                          │
│  No password to remember │   ← reassuring helper text
└──────────────────────────┘
```

**2. Recipe list (Kitchen / Bar tabs preserved)**

```
┌──────────────────────────┐
│ My Recipes          ⚙︎    │  ← settings gear top-right
│ ┌─────────┐ ┌─────────┐  │
│ │ KITCHEN │ │   BAR   │  │  ← two tabs, Kitchen active
│ └─────────┘ └─────────┘  │
│ 🔍 Search…               │  ← search box
│ #weeknight #soup #veg →  │  ← tag chips, horizontal scroll
│ ┌──────────────────────┐ │
│ │ Tomato Soup          │ │  ← card: name + subtitle
│ │ cosy & quick · 4 srv │ │
│ ├──────────────────────┤ │
│ │ Roast Chicken        │ │
│ │ Sunday dinner · 6 srv│ │
│ └──────────────────────┘ │
│        ┌──────────┐      │
│        │  + Add   │      │  ← floating add button
│        └──────────┘      │
│ [ Kitchen ][ Bar ][ List]│  ← bottom nav incl. Grocery List
└──────────────────────────┘
```

**3. Add recipe — choose input mode**

```
┌──────────────────────────┐
│ ← Add a recipe           │
│                          │
│ ┌──────────────────────┐ │
│ │ 📷  Take / pick photo│ │  ← opens iPhone camera/library
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ 🔗  Paste a link     │ │  ← URL field appears
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │ ✍︎  Paste text       │ │  ← textarea (for IG/TikTok captions)
│ └──────────────────────┘ │
│                          │
│ Tip: links from Instagram│
│ may not work — paste the │
│ caption text instead.    │
└──────────────────────────┘
```

**4. AI extraction — progress**

```
┌──────────────────────────┐
│   Reading your recipe…   │
│        ◐ (spinner)       │
│  Pulling out ingredients │
│  and steps with AI       │
│                          │
│  [ Cancel ]              │
└──────────────────────────┘
```

**5. Review / confirm (editable BEFORE saving — critical screen)**

```
┌──────────────────────────┐
│ ← Check & save           │
│ ⚠ Please review — AI can │
│   make mistakes.         │
│ Name                     │
│ ┌──────────────────────┐ │
│ │ Tomato Soup          │ │  ← every field editable
│ └──────────────────────┘ │
│ Section: (•)Kitchen ( )Bar│
│ Servings: [ 4 ]  Tags:+   │
│ Ingredients              │
│  [1] [cup] [diced tomato]🗑│ ← amount/unit/item, deletable rows
│  [2] [tbsp][olive oil]   🗑│
│  + add ingredient        │
│ Method                   │
│  1. [Sauté onions…]      🗑│
│  2. [Add tomatoes…]      🗑│
│  + add step              │
│ ┌──────────────────────┐ │
│ │   ✓  Save to my book │ │
│ └──────────────────────┘ │
└──────────────────────────┘
```

**6. Recipe detail (with Edit / Delete)**

```
┌──────────────────────────┐
│ ← Tomato Soup       ⋮    │  ← ⋮ menu = Edit / Delete
│ cosy & quick             │
│ Source: Grandma's card   │
│ #soup #weeknight         │
│ Servings: [−] 4 [+]      │  ← scaling control
│ ── Ingredients ──        │
│ • 1 cup diced tomato     │  ← amounts rescale live
│ • 2 tbsp olive oil       │
│ ── Method ──             │
│ 1. Sauté onions…         │
│ 2. Add tomatoes…         │
│ ┌────────┐ ┌───────────┐ │
│ │ ✎ Edit │ │ + to List │ │  ← add ingredients to grocery list
│ └────────┘ └───────────┘ │
└──────────────────────────┘
```

Tapping ⋮ → **Delete** shows a confirm dialog (“Delete Tomato Soup? This can’t be undone.”).

**7. Edit form** — identical layout to the Review screen (5), pre-filled with saved values; **Save** updates, **Cancel** discards.

**8. Grocery list (multi-recipe, checkboxes, export)**

```
┌──────────────────────────┐
│ ← Grocery List           │
│ From: Tomato Soup,        │
│       Roast Chicken       │
│ ☑ 1 cup diced tomato     │  ← checkbox per item
│ ☑ 2 tbsp olive oil       │
│ ☐ 1 whole chicken        │
│ ☐ 200 g potatoes         │
│ ┌──────────────────────┐ │
│ │  Share → Google Keep │ │  ← Web Share API on mobile
│ └──────────────────────┘ │
│ [ Copy ]   [ Download ]  │  ← fallbacks
└──────────────────────────┘
```

**9. Settings**

```
┌──────────────────────────┐
│ ← Settings               │
│ Signed in as you@mail.com │
│ Default servings: [ 4 ]  │
│ Measurement: (•)Metric    │
│              ( )US        │
│ ──────────────────────── │
│ Export my data (JSON)    │  ← honest exit path
│ Sign out                 │
└──────────────────────────┘
```

## Data Model

Use **one row per recipe with a `section` field** (“kitchen” or “bar”) rather than two tables — simpler queries, preserves both your sections, and cocktail-only fields just sit empty for kitchen recipes. Store the structured arrays as `jsonb` so they map directly onto your existing JS object shape.

**`profiles` table** (one row per user; mirrors `auth.users`)

|column          |type     |notes          |
|----------------|---------|---------------|
|id              |uuid (PK)|= auth.users.id|
|display_name    |text     |optional       |
|default_servings|int      |settings       |
|units           |text     |‘metric’ / ‘us’|

**`recipes` table**

|column        |type                |notes                                                    |
|--------------|--------------------|---------------------------------------------------------|
|id            |uuid (PK)           |`gen_random_uuid()`                                      |
|user_id       |uuid (FK→auth.users)|**the privacy key**; indexed                             |
|section       |text                |‘kitchen’ or ‘bar’                                       |
|name          |text                |                                                         |
|subtitle      |text                |                                                         |
|source        |text                |e.g. “Grandma’s card”, original URL                      |
|tags          |text[]              |for chip filtering                                       |
|base_servings |int                 |for scaling                                              |
|servings_label|text                |e.g. “servings”, “glasses”                               |
|ingredients   |jsonb               |`[{amount, unit, item}, …]`                              |
|method        |jsonb               |`["step 1", "step 2", …]`                                |
|specs         |jsonb               |cocktail specs (glass, garnish, method); null for kitchen|
|notes         |text                |                                                         |
|created_at    |timestamptz         |default now()                                            |

**Row Level Security (the whole isolation story):**

```sql
alter table recipes enable row level security;
create policy "own recipes" on recipes
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

That single policy makes each book private. **To add sharing later** you don’t rebuild — you add a `shared_with` table and a second SELECT policy like `auth.uid() = any(select shared_user from shares where recipe_id = id)`. The architecture already supports it.

## AI Extraction Pipeline Design

**Flow:**

1. **User picks input** (photo / URL / pasted text) in the PWA.
1. **Browser calls the Edge Function** `extract-recipe` with the user’s JWT attached.
1. **Function authenticates** the user (`getUser()` → 401 if not logged in).
1. **Branch by input type:**
- *URL:* fetch the page server-side → try to parse `application/ld+json` schema.org/Recipe → if found and complete, map fields and **skip the LLM ($0)**; if missing/partial, extract visible text and continue to step 5.
- *Photo:* pass the image directly to Claude.
- *Text:* pass the pasted text to Claude.
1. **Call Claude Haiku 4.5** with `output_config.format` set to your recipe JSON schema (vision + structured output in one request — confirmed supported on Haiku 4.5).
1. **Validate** the returned JSON against the schema (Structured Outputs guarantees shape; you still sanity-check that there’s at least a name and one ingredient).
1. **Return JSON to the browser** → populate the **editable Review screen** (wireframe 5).
1. **User confirms** → browser inserts the row into `recipes` (RLS stamps it to their `user_id`).

**Recommended model:** Claude Haiku 4.5 ($1/$5 per M tokens; ~$0.0058/recipe). It’s Anthropic’s cheapest current-generation model,  supports vision and Structured Outputs, and is more than capable of recipe extraction. GPT-4o-mini ($0.15/$0.60 per M) is a cheaper-on-paper alternative but is widely reported to count images as far more tokens than expected,  narrowing the real gap; Haiku’s guaranteed-schema output and quality make it the cleaner choice for a beginner. Keep the model name in a config constant so you can swap it in one line.

**Prompt strategy:** system prompt names every target field, instructs the model to (a) output amounts as numbers and split unit from item, (b) normalise fractions/ranges, (c) preserve step order, (d) use `null`/empty rather than guessing, (e) infer 3–6 sensible tags. Provide the JSON schema via `output_config.format` so the reply is always parseable. Note that Structured Outputs inject a small additional system prompt, slightly raising input token count (already accounted for in the cost estimate).

**Error handling:**

- *LLM returns thin/empty result* → show the Review screen anyway with whatever was found plus an “AI couldn’t read much — fill in the rest” banner; never block the user from manual entry.
- *URL fetch fails / blocked / paywalled* → message: “Couldn’t open that link — try a photo or paste the text.”
- *Timeout or API error* → friendly retry button; nothing is saved until the user confirms, so a failure never corrupts data.
- *Cost guard* → Anthropic spend cap + a soft per-user daily extraction limit in the function.

## Build Roadmap (hobbyist + AI coding assistant)

Effort assumes you’re directing an AI assistant (Claude Code or web Claude) to generate most code, with you testing on your phone. “Sessions” = focused evenings.

**Phase 0 — Setup (1 session).** Create Supabase project; create `profiles` + `recipes` tables; turn on RLS + the ownership policy; enable email magic-link auth. No code yet — all dashboard.

**Phase 1 — Auth + read-only list (1–2 sessions).** Wire sign-in into your existing frontend; load and display the current user’s recipes in the Kitchen/Bar tabs. Confirm two test accounts can’t see each other’s data. *Milestone: private books work.*

**Phase 2 — Full CRUD (2–3 sessions).** Add/edit/delete recipes through the UI (wireframes 5–7). Port your existing tag filtering, search, and servings scaling to run against the database. *Milestone: no more editing JS files.*

**Phase 3 — AI extraction (2–3 sessions).** Build the `extract-recipe` Edge Function with the secret key; add photo + paste-text input and the Review screen; integrate Claude with the JSON schema. *Milestone: snap a cookbook page → reviewed recipe saved.*

**Phase 4 — URL import + JSON-LD (1–2 sessions).** Add server-side fetch + JSON-LD parse with LLM fallback. *Milestone: paste a recipe link → it imports.*

**Phase 5 — Grocery list + PWA polish (1–2 sessions).** Multi-recipe checkbox list with Web Share/copy/download; service worker + manifest + icons for Add-to-Home-Screen; light-theme final pass. *Milestone: installable, shippable PoC.*

**Total: roughly 8–13 sessions.** Phases 0–2 alone give a usable private multi-user CRUD app; the AI features layer on top without rework.

## Migration Path (importing your existing recipes.js / cocktails.js)

Your data is already structured JS arrays, so this is a one-time script, not manual re-entry:

1. **Reshape** each existing object to match the new `recipes` columns (map your current keys to `name`, `subtitle`, `source`, `tags`, `base_servings`, `servings_label`, `ingredients`, `method`, `specs`, `notes`; set `section` to `kitchen` or `bar` depending on which file it came from).
1. **Stamp ownership** — set `user_id` to your own account’s UUID (these are presumably your recipes) so they land in your book.
1. **Load** — either paste the transformed JSON into Supabase’s table editor / SQL `insert`, or have your AI assistant generate a tiny Node script using the Supabase client. Because it’s a one-off admin task you can use the service-role key locally (never in the browser).
1. **Verify** counts and spot-check a few recipes (especially ingredient amount/unit/item splitting) in the UI.
   Keep your original `.js` files as a backup until you’ve confirmed everything imported.

## Recommendations

1. **Start now with Phase 0–2 on Supabase free tier** before touching AI. Getting private books + CRUD working proves the whole architecture with zero spend and minimal new concepts. **Threshold to continue:** if two test accounts correctly can’t see each other’s recipes, the hard part is done.
1. **Add the AI extractor (Phase 3) only after CRUD works**, and put your Anthropic key in an Edge Function secret from the very first call — never test it from the browser “just to see if it works.”
1. **Set an Anthropic spend cap** (e.g. $5/month) and a per-user daily extraction limit in the function on day one. At ~$0.0058/recipe you’d need to process ~860 recipes to spend $5, so this is purely a runaway-bug guard.
1. **Keep the frontend on GitHub Pages or move to Cloudflare Pages** — don’t over-engineer hosting; the app logic now lives in Supabase.
1. **Tell users upfront that Instagram/TikTok links won’t auto-import** and to paste the caption text. This sets honest expectations and avoids a feature that will frustrate everyone.
1. **Revisit the platform choice only if** you outgrow the Supabase free tier (you won’t at 10 users) or you decide you *want* to self-host for control — at which point PocketBase is your migration target, and your Postgres export makes the move clean.

## Caveats / Risks

- **What breaks first: the Supabase free-project pause.** Supabase docs confirm free-tier projects are paused after 7 consecutive days with no database activity; the data, schema, and backups are preserved and the project takes ~30 seconds to wake on the next request. With only 10 occasional users this is a real risk. Mitigations: a tiny scheduled ping to keep it warm, or upgrade to Pro ($25/mo) if the pause becomes annoying. Flag this as the single most likely day-one annoyance.
- **No automatic backups on the free tier.** Add a periodic `pg_dump`/export (can be automated with a free GitHub Action) so a bad migration can’t lose everyone’s recipes. Pro adds 7-day automated backups.
- **AI extraction is good, not perfect.** Handwritten cards, photos at angles, and unusual layouts will produce errors — which is exactly why the **editable Review screen before saving is non-negotiable**. Never auto-save AI output.
- **URL import is brittle by nature.** Sites without JSON-LD, paywalls, and anti-bot blocks will fail; the LLM-text fallback helps but won’t always. Treat URL import as best-effort with a graceful “try a photo instead” path.
- **iOS PWA limitations:** camera works via file-input but not reliably via live `getUserMedia`; local storage can be evicted; push notifications and some APIs remain limited. Keep the server as the source of truth.
- **Maintenance burden:** with managed Supabase it’s low — mainly occasional dependency bumps and watching the Anthropic bill. Choosing PocketBase trades that for VPS patching, TLS renewal, and backups that are entirely on you.
- **If you abandon the project:** your data is fully portable. Supabase is standard Postgres — one `pg_dump` (or the Settings → “Export my data (JSON)” button you’ll build) gives every user their recipes back. There is no proprietary format holding your data hostage, which is a deliberate reason to prefer it over Firebase’s Firestore.
- **Security footgun to avoid:** the documented #1 mistake on AI-built Supabase apps is forgetting to enable RLS or shipping the service-role key to the browser. Security researchers Matan Getz / Matt Palmer found 170 of 1,645 analysed Lovable apps (10.3%, with 303 exposed API endpoints) had Supabase tables readable via the public anon key — disclosed June 4, 2025 as **CVE-2025-48757, rated CVSS 9.3 Critical**. Enable RLS on every table, use only the publishable/anon key client-side, and keep the secret key in the Edge Function.  Verify by signing in as two users and confirming isolation.