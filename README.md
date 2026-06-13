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
  rows, even if the frontend had a bug.
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
  paste the caption text for those. Text and link extractions cost roughly half
  a cent (Haiku); photo extractions a couple of cents (Sonnet, needed to read
  messy handwriting). The AI completes cut-off recipes, infers proportions when
  only ingredients are given, and ignores non-recipe clutter on the card or
  screenshot — anything it guesses shows up as an "AI added:" line in Notes.
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

The grocery selection lives in the current session, so fully closing the app
resets the checked recipes — build the list and send it to Keep.

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
