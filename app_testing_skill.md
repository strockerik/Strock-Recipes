---
name: app-testing
description: Full QA pass for the House Index recipe app — static analysis, cleanup, optimization, headless-browser smoke tests, Edge Function checks, and live AI-extraction tests against the sample recipe photos. Use before committing a feature, after a refactor, or when something "doesn't work."
---

# App Testing Skill — The House Index (Recipes & Cocktails)

A repeatable QA playbook for this specific app. It mirrors what a professional
would do before shipping: read for bugs, clean up dead code, optimize, then
exercise the app end-to-end — including the AI photo extraction against the
local calibration photo set.

Work top to bottom. Each phase says **what to run**, **what to look for**, and
**how to record the result**. Don't skip the cheap static phases just because the
fun part is the photo tests — most regressions are caught for free in Phases 1–3.

## 0. Environment & ground rules

This repo has **no Node/npm/Deno/Docker** in the dev environment. What *is*
available (verified): `python3`, `curl`, `jq`, `sips` (Apple's image tool —
converts HEIC→JPEG), and **Google Chrome** at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (used headless
as the test runner). Plan every test around those tools — never assume a
package manager or a JS test framework is installable.

Architecture recap (so you test the right boundary):

- **Frontend** — `index.html`, `style.css`, `app.js` (all client logic, wrapped
  so element wiring runs after load), `config.js` (Supabase URL + anon key).
  Static, no build step, hosted on GitHub Pages.
- **Backend** — Supabase: Postgres + RLS, Auth, and the `extract-recipe` Edge
  Function (`supabase/functions/extract-recipe/index.ts`, Deno/TS), deployed
  **manually via the dashboard** — pushing to GitHub does *not* redeploy it.
- **Secrets** — service-role key + user ids live in the gitignored `notes.md`
  and `.env.local`. The Anthropic key is a server-side Edge Function secret.

**Cost guard:** Photo/text/URL extraction calls Claude and counts against the
20/day per-user cap (`increment_extraction_usage`). Live extraction tests
(Phase 6) spend real money and burn quota — **never run them without saying so
first.** Every other phase is free.

## 1. Static analysis & syntax

Goal: prove the code at least parses and loads, with no obvious broken
references, before doing anything dynamic.

1. **JS parse/load check** (no Node, so use Chrome as the parser). Point a tiny
   harness at `app.js` with a global `error` listener; `PARSED_OK` in the title
   means it loaded without throwing:

   ```bash
   cat > /tmp/syncheck.html <<'EOF'
   <!doctype html><html><body>
   <script>window.addEventListener('error',e=>{document.title='ERR: '+e.message});</script>
   <script src="file:///FULL/PATH/app.js"></script>
   <script>if(!document.title)document.title='PARSED_OK';</script>
   </body></html>
   EOF
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
     --disable-gpu --no-sandbox --allow-file-access-from-files \
     --virtual-time-budget=4000 --dump-dom file:///tmp/syncheck.html 2>/dev/null \
     | grep -o '<title>[^<]*</title>'
   ```

2. **Edge Function** — there's no local Deno, so type-check it by eye against
   the Anthropic + Supabase shapes. Confirm: every `Deno.env.get` has a fallback
   or `!`, the `body.type` branch handles `image` / `text` / `url` and rejects
   anything else, `ALLOWED_IMAGE_TYPES` / `MAX_IMAGES` are enforced *before* the
   paid call, and the function always returns HTTP 200 with `{recipe}` or
   `{error}` (the browser reads the body either way).

3. **Grep for footguns:**
   ```bash
   grep -nE 'console\.(log|debug)' app.js                 # leftover debug logging
   grep -nE 'innerHTML *=' app.js                         # every one must be esc()'d
   grep -nE 'TODO|FIXME|XXX|HACK' app.js index.html supabase/functions/extract-recipe/index.ts
   grep -n 'is_shared\|household' app.js index.html style.css   # retired sharing model
   ```
   `innerHTML` assignments that interpolate recipe data **must** route user text
   through `esc()` — see Phase 7 (XSS).

Record: PASS/FAIL per item, with the file:line of anything flagged.

## 2. Cleanup pass (dead code, duplication, stale comments)

A human reviewer's job — be systematic, don't eyeball:

- **Unused functions:** for each `function name(` in `app.js`, grep the codebase
  for other references. Zero other hits = dead, remove it.
  ```bash
  for fn in $(grep -oE 'function ([a-zA-Z0-9_]+)' app.js | awk '{print $2}' | sort -u); do
    n=$(grep -c "\b$fn\b" app.js); echo "$n  $fn"; done | sort -n | head
  ```
  A count of `1` means defined-but-never-called.
- **Unused module-level vars** (e.g. `byId`, `basket`, `activeTags`,
  `sharesByRecipe`, `openShareIds`): same grep approach — each should be read in
  ≥1 place beyond its declaration.
- **Unused CSS classes:** for each `.class` in `style.css`, confirm it appears
  in `index.html` or in an `app.js` template literal / `classList` call.
  ```bash
  for c in $(grep -oE '\.[a-zA-Z][a-zA-Z0-9_-]+' style.css | sort -u | tr -d .); do
    grep -q "$c" index.html app.js || echo "unused? .$c"; done
  ```
  (Manually confirm — the grep is a coarse first pass; some classes are built
  from string concatenation.)
- **Stale comments:** anything mentioning the retired "share with household"
  boolean model, "Pending redeploy" notes that are already deployed, or a model
  name that's been changed. Comments must describe the code as it is now.
- **Duplication:** repeated literal lists (tag taxonomy, unit tables) should
  have one source of truth. The tag list exists in both `index.html` (checkbox
  UI) and the Edge Function schema by necessity — note it, but verify they match.

Record: list each removal/edit; re-run Phase 1 after editing.

## 3. Headless-browser smoke & integration tests

The established pattern for this app (no DOM/test framework, so drive the real
`app.js` in real Chrome against a stubbed Supabase):

1. Copy the **whole** `index.html` to `test_<thing>.html` — *not* a hand-built
   minimal page. `app.js` wires up many elements (recipe form fields, grocery
   panel) unconditionally; a partial page throws
   `Cannot read properties of null (reading 'addEventListener')` and aborts
   before your test runs.
2. Replace the two real script tags (the supabase CDN script and `config.js`)
   with an inline stub: `window.supabase.createClient` returning stubs for
   `auth.onAuthStateChange`, `auth.getSession`, `auth.signInWithPassword`,
   `auth.updateUser`, `auth.signOut`, a chainable `.from()` query builder
   (`.select().eq().order()` → `{data, error}`), and `.rpc()` /
   `.functions.invoke()`.
3. Add a test driver script at the end that exercises one behavior and writes
   the verdict to `document.title` / a `data-results` attribute.
4. Run and read the verdict:
   ```bash
   cd /path/to/repo && python3 -m http.server 8765 &
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
     --disable-gpu --no-sandbox --virtual-time-budget=6000 \
     --dump-dom http://localhost:8765/test_thing.html 2>/dev/null \
     | grep -o '<title>[^<]*</title>'
   ```
5. **Always delete `test_*.html` and kill the http.server afterward** — they
   must never be committed.

Smoke tests worth having (each its own `test_*.html` or one with sub-cases):

- **Auth UI** — `onAuthStateChange('SIGNED_IN')` hides the auth gate and shows
  the recipe list; `SIGNED_OUT` reverses it. `PASSWORD_RECOVERY` fires
  `promptForNewPassword`.
- **Account button** — click `#account-btn`, stub `window.prompt`, assert
  `auth.updateUser({password})` is called and a "Password updated." toast shows.
  (Known-good: this test passed 7/7 previously.)
- **Sign-up paths** — both "confirm email ON" (toast about confirmation) and
  "OFF" (immediate sign-in) branches.

## 4. Functional / business-logic test matrix

These are pure-logic functions in `app.js` — testable in isolation by calling
them from a `test_*.html` after the app loads (or by extracting the function
logic into the harness). Assert exact outputs:

| Area | Function(s) | Cases to assert |
|---|---|---|
| Fraction display | `fmtAmount` | `0.5→½`, `0.25→¼`, `0.33→⅓`, `1.5→1½`, `2→2`, `0→` (blank/"to taste"), `0.125→⅛` |
| Servings scaling | `scaledIngredients` | double servings doubles amounts; **blank amount stays blank** (to-taste never scales); base servings = no change |
| Grocery combine | `combinedGroceryItems` | two recipes each needing ground beef → one line summing amounts; mismatched units handled by family |
| Unit conversion | `canonicalQuantity`, `shoppableQuantity` | g/kg→oz/lb, ml/l→cups/tbsp/tsp; tiny gram amounts (yeast/spice) left as-is |
| Pantry staples | `isPantryStaple` | salt/pepper/oil/water/sugar/butter → true; "olive oil" still matches; "flour" → false |
| Sections | `groupRuns` | items with mixed `group` labels split into runs in order; all-null → one ungrouped run |
| Sharing labels | `shareButtonLabel`, `shareRecipients` | 0 → "Share", 1 → "Shared with 1 person", 2 → "…2 people" |
| Escaping | `esc` | `<`, `>`, `&`, `"`, `'` all entity-encoded |

For each: PASS only on exact expected value. A wrong fraction or a to-taste
item that scaled is a real user-facing bug.

## 5. Edge Function logic tests (free — no API call)

The detector helpers and validation run *before* the paid Anthropic call, so
test them against saved HTML fixtures with no spend:

1. **`looksLikeBotChallenge`** — save a Cloudflare challenge page and assert
   `true`; assert a normal recipe page → `false`. Trigger strings: "Just a
   moment", "Enable JavaScript and cookies to continue", "Checking your browser
   before accessing", "cf-browser-verification", "cf_chl_opt".
   ```bash
   curl -sL --max-time 20 https://www.liquor.com/recipes/ -o /tmp/liquor.html
   grep -lE 'Just a moment|cf_chl_opt|cf-browser-verification' /tmp/liquor.html \
     && echo "bot-challenge detector would fire"
   ```
2. **`looksLikeEmptyAppShell`** — a JS-only SPA (e.g. an ostarecipes.com-style
   page): assert `<div id="root|app|__next">` present **and** stripped text
   length is tiny → `true`. A normal blog with real article text → `false`.
3. **Input validation** — confirm (by reading the branch) that: missing/empty
   `text`, an `images` array longer than `MAX_IMAGES` (4), a disallowed
   `mediaType`, and an unknown `type` each return an `{error}` **before** any
   fetch to Anthropic.
4. **Daily cap** — logic-review `increment_extraction_usage`: 21st call same
   UTC day returns `-1` (→ "used today's 20…" error); first call next UTC day
   resets to 1. To verify live without the app, in the Supabase SQL editor as
   the test user:
   ```sql
   select public.increment_extraction_usage(20);  -- returns running count, or -1 at the cap
   ```
   Confirm the function **fails open**: if the RPC errors (migration missing),
   the Edge Function logs and proceeds — extraction must not break.

## 6. AI extraction tests — the sample recipe photos  ⚠️ spends quota

The calibration set lives in `data/Recipe Photos/` (gitignored — local only).
Each filename encodes the *hard case* it's meant to stress. This is the
acceptance suite for the model + prompt.

**Prep — convert HEIC and downscale (the browser does this; replicate with sips):**
```bash
cd "data/Recipe Photos"
for f in *.heic; do sips -s format jpeg -Z 1600 "$f" --out "/tmp/${f%.heic}.jpg"; done
for f in *.jpeg; do sips -Z 1600 "$f" --out "/tmp/$f"; done   # downscale longest edge to 1600px
```

**How to run a live extraction** (requires a signed-in user's access token —
get it from the app: sign in, then in the browser console
`(await supabaseClient.auth.getSession()).data.session.access_token`):
```bash
B64=$(base64 -i "/tmp/Pina Colada - No Proportions.jpg" | tr -d '\n')
curl -s -X POST "$SUPABASE_URL/functions/v1/extract-recipe" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"image\",\"images\":[{\"mediaType\":\"image/jpeg\",\"data\":\"$B64\"}]}" \
  | jq '.recipe // .error'
```
(Or — preferred for a true end-to-end test — drive it through the app's
"✨ Add with AI" UI and inspect the pre-filled form.)

**Acceptance checks per photo** (assert the model honored the prompt rules):

| Photo | Hard case | Must-pass assertions |
|---|---|---|
| `Pannakakku - Sloppy.heic` | Messy handwriting; faithful transcription | Reads name "Pannukakku/Pannakakku"; **keeps flour** and does **not** invent baking powder; bake time/temp captured from the card edge; amounts copied as written. |
| `Chicken and Rice - Sloppy.heic` | Messy cursive legibility | Plausible reading of every ingredient; no dropped ingredient; numbers/units transcribed (tsp ≠ tbsp). |
| `Chicken Enchilada Casserole - Incomplete.jpeg` | Cut-off recipe → gap-fill | Completes into a cookable recipe; anything inferred is flagged with an "AI added:" line in Notes; `casserole`/`chicken`/`mexican` tags reasonable. |
| `BBQ Pork - Narrative.jpeg` | Prose → clean steps | Loose narrative becomes ordered `method` steps; ingredients extracted into rows with amounts; `pork` tag. |
| `Pina Colada - No Proportions.jpeg` | Ingredients only, no amounts | Infers sensible proportions; `section:"bar"`; `rum` + a style tag; inferred amounts flagged "AI added:" in Notes. |

**Cross-cutting assertions for every photo result:**
- Valid against `RECIPE_SCHEMA` (all required keys; `section` ∈ {kitchen,bar};
  ≤3 tags, all from `ALL_TAGS`; method is `{text,group}` objects).
- No non-recipe clutter leaked in (no "From the kitchen of", card numbers,
  copyright lines, phone UI from screenshots).
- Exactly **one** recipe returned even when a card has front+back.

**Multi-image (front/back) test:** pass two images of the same card in one
`images` array and assert a single merged recipe (ingredients from one side +
method from the other), not two recipes.

**Text & URL fixtures (cheaper — Haiku):**
- *Text:* the honey-garlic-salmon Instagram caption in `notes.md` →
  `type:"text"`. Assert 4 servings, the sauce ingredients, `salmon`/`seafood`
  + `asian` tags, ordered steps, emoji/"tag me" chatter stripped.
- *URL (should fail gracefully):* a Cloudflare site (liquor.com) → the
  bot-protection `{error}` message; a JS-only SPA → the "loads its recipe with
  JavaScript" `{error}`. Neither should 500 or hang.

Record a table: photo → PASS/PARTIAL/FAIL + the specific rule violated. Track
results over time; a prompt change that fixes one card shouldn't regress another.

## 7. Security & regression checks

- **RLS is the real guard, not the UI.** Confirm a second account cannot read,
  edit, delete, or favorite another user's recipe even via direct REST. The
  only cross-user read is an explicit `recipe_shares` row. Check the
  `recipes` ↔ `recipe_shares` policies don't recurse infinitely.
- **No service-role key in git.** `git grep -i 'service_role'` should hit only
  docs, never a committed key; `notes.md` and `.env.local` stay gitignored.
- **Anon key exposure is intentional** — fine in `config.js`, but only because
  RLS constrains it. Don't "fix" it.
- **XSS:** every recipe field rendered via `innerHTML` must pass through
  `esc()`. Add a recipe named `<img src=x onerror=alert(1)>` and confirm it
  renders as text, never executes.
- **Edge Function auth:** an unauthenticated call (no/!invalid bearer) must be
  rejected before any Anthropic spend.

## 8. Other tests worth adding

Ideas to grow the suite as the app evolves:

- **PWA / offline:** `manifest.json` valid; icons present at declared sizes;
  app loads from the home-screen shell.
- **Session persistence:** reload keeps you signed in; sign-out clears
  `byId`/grocery selection (`clearData`, `pruneStaleState`).
- **Grocery → Keep:** `groceryText()` output format; "Skip pantry staples"
  toggle hides staples in the combined list but **not** in "By recipe".
- **Cook mode:** one step at a time; ingredients toggle scales to chosen
  servings; wake-lock requested; works for sectioned recipes.
- **Servings round-trip:** scale up, edit, save — base amounts unchanged
  (scaling is display-only, never persisted).
- **Empty/edge states:** zero recipes, a recipe with no tags, an ingredient
  with a blank amount, a 1-step recipe, a recipe shared then unshared.
- **Network resilience:** Edge Function timeout path (`Promise.race` in
  `app.js:1208`) shows a friendly message, not a spinner forever.
- **Accessibility smoke:** buttons have labels, form inputs have associated
  text, focus order is sane.
- **Performance:** with ~200 recipes, `renderList`/filter stays snappy; no
  N² work in `combinedGroceryItems`.

## Reporting

Finish every run with a short table: phase → PASS/FAIL/SKIPPED, plus a bullet
list of bugs found (file:line), cleanups made, and any photo regressions. State
plainly what was *not* run (e.g. "Phase 6 skipped — would spend quota"). If
tests fail, show the actual output; don't smooth it over.
