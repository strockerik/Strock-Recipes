---
name: app-testing
description: Full QA pass for the House Index recipe app — static analysis, cleanup, a circular-reference & efficiency audit, headless-browser smoke tests, Edge Function checks, an AI prompt-contract audit, and live AI tests (photo/text/URL extraction plus coach & tweak acceptance). Use before committing a feature, after a refactor, or when something "doesn't work."
---

# App Testing Skill — The House Index (Recipes & Cocktails)

A repeatable QA playbook for this specific app. It mirrors what a professional
would do before shipping: read for bugs, dead code, **circular references, and
inefficiencies**, clean those up, then exercise the app end-to-end — including the
**AI features** (photo/text/URL extraction, and the coach's troubleshoot/tweak
flows) against the local calibration set, and an audit that the AI features still
ship their **standard focusing prompts**.

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
- **Backend** — Supabase: Postgres + RLS, Auth, and two Edge Functions
  (`supabase/functions/extract-recipe/` for AI import and
  `supabase/functions/recipe-coach/` for the AI coach, Deno/TS), each deployed
  **manually via the dashboard** — pushing to GitHub does *not* redeploy them.
  Tables: `recipes`, `profiles` (display names for share attribution),
  `recipe_shares` (per-user shares — the *only* cross-user read), and
  `meal_plan_entries` (dated B/L/D assignments). RLS-only helpers `owns_recipe`
  and `recipe_shared_with_me` live in the non-exposed `private` schema; the
  `recipes` ↔ `recipe_shares` policies must not recurse.
- **Schema/data changes** — applied by hand in the dashboard SQL editor (no
  CLI). One-time data migrations live in `scripts/` (e.g.
  `migrate_ingredients.py`) and are **user-run only** — see Phase 2.
- **Secrets** — service-role key + user ids live in the gitignored `notes.md`
  and `.env.local`. The Anthropic key is a server-side Edge Function secret.
  **Never** run a script that uses the service-role key against production from
  here.

**Cost guard:** Photo/text/URL extraction calls Claude and counts against the
20/day per-user cap (`increment_extraction_usage`). Live extraction tests
(Phase 6) spend real money and burn quota — **never run them without saying so
first.** Every other phase is free.

## 1. Static analysis & syntax

Goal: prove the code at least parses and loads, with no obvious broken
references, before doing anything dynamic.

1. **JS parse/load check** (no Node, so use Chrome as the parser). `app.js` is
   **not** a pure-logic module — it queries and wires DOM elements at top level
   (`authForm.addEventListener`, …), so loading it against a *bare* `<body>`
   always throws `Cannot read properties of null (reading 'addEventListener')`
   before you can confirm anything. (That error actually proves it *parsed* — a
   real `SyntaxError` reads differently — but it's a false negative for "loads
   clean".) So run the check against the **real `index.html` DOM** with Supabase
   stubbed, the same setup as Phase 3 — `PARSED_OK` in the title = parsed and ran
   its top-level wiring with no throw:

   ```bash
   cd /path/to/repo
   python3 - <<'PY'
   import re
   html = open('index.html').read()
   stub = ("<script>window.SUPABASE_URL='x';window.SUPABASE_ANON_KEY='y';"
           "window.supabase={createClient:()=>({auth:{onAuthStateChange(){},"
           "getSession:async()=>({data:{session:null}}),signOut(){}},"
           "from:()=>({select:()=>({eq:()=>({order:async()=>({data:[],error:null})}),"
           "order:async()=>({data:[],error:null}),in:async()=>({data:[],error:null})}),"
           "insert:()=>({select:()=>({single:async()=>({data:{id:1},error:null})})}),"
           "delete:()=>({eq:async()=>({error:null})}),update:()=>({in:async()=>({error:null})}),"
           "upsert:async()=>({error:null})}),rpc:async()=>({data:0,error:null}),"
           "functions:{invoke:async()=>({data:{},error:null})}})};"
           "window.addEventListener('error',e=>{document.title='ERR: '+e.message});</script>")
   html = re.sub(r'<script[^>]*supabase[^>]*></script>', '', html, flags=re.I)
   html = re.sub(r'<script[^>]*src=["\']config\.js["\'][^>]*></script>', stub, html, flags=re.I)
   html = html.replace('</body>', "<script>setTimeout(()=>{if(!document.title.startsWith('ERR'))document.title='PARSED_OK'},50)</script></body>")
   open('test_parse.html','w').write(html)
   PY
   python3 -m http.server 8765 >/dev/null 2>&1 & SRV=$!; sleep 1
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
     --disable-gpu --no-sandbox --virtual-time-budget=5000 \
     --dump-dom http://localhost:8765/test_parse.html 2>/dev/null \
     | grep -o '<title>[^<]*</title>'
   kill $SRV 2>/dev/null; rm -f test_parse.html
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
   grep -nE 'TODO|FIXME|XXX|HACK' app.js index.html supabase/functions/*/index.ts
   grep -n 'is_shared\|household' app.js index.html style.css   # retired sharing model
   ```
   `innerHTML` assignments that interpolate recipe data **must** route user text
   through `esc()` — see Phase 7 (XSS).

Record: PASS/FAIL per item, with the file:line of anything flagged.

## 2. Cleanup, circular references & efficiency

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
  The prep-word / vague-amount rules are deliberately mirrored in two places —
  `app.js` (`PREP_WORDS`, `displayGroceryName`) and `scripts/migrate_ingredients.py`
  (`PREP_WORDS`, `strip_prep`) — because one runs in the browser and the other
  is a one-time DB migration; if you change one, change the other.
- **One-off scripts:** `scripts/migrate_ingredients.py` is **user-run only**
  (it needs the service-role key from the gitignored `notes.md` and writes to
  production — the sandbox blocks prod writes). Never invoke it from here. It is
  idempotent and dry-run by default; `scripts/__pycache__/` is build cruft and
  should be gitignored, not committed.

### Circular references & runaway loops

A circular reference here shows up two ways — a data structure that can't be
serialized, or control flow that re-triggers itself. Check both:

- **`JSON.stringify` targets must be acyclic.** A self-referential object (or a
  DOM node, which has cyclic parent/child links) throws
  `TypeError: Converting circular structure to JSON`. List every call and confirm
  its argument is plain data, never a DOM node or something holding one:
  ```bash
  grep -nE 'JSON\.stringify' app.js
  ```
  Known targets and what each must hold: `saveCoachState` (→ `coachMessages`
  `{role,content}` + `coachLastResult`, both plain), `serializeRecipeForCoach`
  and the `functions.invoke({body})` payloads (plain recipe + `{role,content}`
  messages — **never** the live in-memory recipe object if it ever gains a back-
  reference), `exportRecipesJSON`/`toBackupRow` (plain rows). Confirm each
  `localStorage.setItem(... JSON.stringify ...)` is inside a `try/catch`
  (`saveCoachState`, the meal-plan/grocery persistence) so a serialize failure
  degrades instead of throwing.
- **Recursion needs a base case.** Grep for self- and mutual-recursion and verify
  each terminates:
  ```bash
  for fn in $(grep -oE 'function ([a-zA-Z0-9_]+)' app.js | awk '{print $2}'); do
    grep -qE "\b$fn\b\s*\(" <(grep -A40 "function $fn(" app.js | tail -n +2) && echo "self-call? $fn"; done
  ```
  (Coarse — confirm by reading. The app is largely flat; flag anything that calls
  itself, e.g. a tree walk, without a terminating branch.)
- **Render / event loops must not re-enter themselves.** Confirm no render
  function calls `renderList()`/`refreshViews()` synchronously from inside its own
  render (would loop); confirm `onAuthStateChange` can't recurse — repeat loads
  are guarded by `loadedUserId` + the `TOKEN_REFRESHED` short-circuit, and data
  calls are deferred with `setTimeout(...,0)` to dodge the supabase auth-lock
  deadlock. A handler that writes the same input it listens on (e.g. an `input`
  listener that sets `.value`) is the classic loop — there should be none.
- **RLS policy recursion.** The `recipes` ↔ `recipe_shares` policies and the
  `private`-schema helpers (`owns_recipe`, `recipe_shared_with_me`) must not
  reference each other in a way that recurses (a prior bug). A policy that selects
  from a table whose policy selects back is the smell; the helpers live in
  `private` precisely to break that cycle.

### Inefficiencies (a quick efficiency pass)

Not micro-optimization — just catch the things that bite at ~200 recipes or on a
slow phone:

- **Algorithmic hot paths:** `combinedGroceryItems` and the filter→`renderList`
  path run over every recipe/ingredient — confirm they're roughly linear, not
  nested O(n²) scans (e.g. a `.find()` inside a `.map()` over the same list).
- **Re-render scope:** a full `renderList()` where only one row changed is
  wasteful — favorites/share/unit toggles should re-render the minimum. Note any
  handler that calls `renderList()` when a targeted DOM update would do.
- **DOM queries in loops:** `$()`/`querySelector` or listener attachment **inside**
  a loop or per-render is a smell — the app uses event **delegation** (one
  listener on the list, `e.target.closest(...)`); verify new code follows suit
  rather than binding per row.
- **Redundant awaits:** independent reads should be issued together
  (`loadData` already fires recipes + profiles + shares concurrently and awaits
  after — keep that shape; flag any new serial `await` chain that didn't need to
  be).
- **Unbounded growth:** `coachMessages` is capped to the last 40 on save
  (`COACH_MAX_STORED_MESSAGES`) — verify it; watch that `openItems`, `basket`,
  `servingsByRecipe`, and the meal-plan window are pruned (`pruneStaleState`) and
  don't grow without bound. `localStorage` writes should be small and not on every
  keystroke.

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
  the recipe list; `SIGNED_OUT` reverses it. `PASSWORD_RECOVERY` opens the
  **Account menu's set-password form** (`openAccountPanel("reset", true)`) — there
  is no `window.prompt` anymore.
- **One-action sign-in gate** — opens in sign-in mode (`#auth-submit` reads
  "Sign in", password `autocomplete="current-password"`, `#auth-forgot` visible);
  clicking `#auth-switch` flips to sign-up (button "Create account",
  `autocomplete="new-password"`, forgot link hidden). Submit calls
  `signInWithPassword` in signin mode and `signUp` in signup mode. A
  double-`submit` in one tick fires **exactly one** call (the `authBusy` guard).
- **Password show/hide** — clicking a `[data-pw-toggle]` flips its input between
  `type="password"` and `type="text"`.
- **Friendly errors** — stub `signInWithPassword` to return
  `{message:"Invalid login credentials"}` → status reads "didn't match"; return
  `{message:"Email not confirmed"}` → status shows a **"Resend confirmation
  email"** button whose click calls `auth.resend`.
- **Account menu** — click `#account-btn` → `#account-panel` opens on the menu
  view; **Change password** shows `#account-reset`; a mismatched confirm blocks
  `auth.updateUser` (status "don't match"), matching confirm calls it; Escape
  closes the panel.
- **Sign-up paths** — both "confirm email ON" (status about confirmation) and
  "OFF" (immediate sign-in) branches.

  (Known-good: a 20-assertion headless harness covering all of the above passed
  20/20 — build it the same way: stub `window.supabase.createClient`, drive the
  **real** `index.html` DOM + `app.js`, write results into a `#result` div, run
  with `python3 -m http.server` + Chrome `--headless=new --dump-dom`.)
- **AI recipe coach** (`recipe-coach` Edge Function; conversational, two modes) —
  stub `functions.invoke("recipe-coach", …)` to return a canned `{ result: {
  reply, needs_more_info, suggestions, revised_recipe } }`, and stub `auth.getUser`
  + `.from("recipes")` so one **owned** recipe loads. Expand it (click `.item-head`)
  so `.coach-btn` renders, then assert: the button opens `#coach-panel` in
  troubleshoot mode; **Send** calls invoke with `{ mode, recipe, messages }` (the
  recipe carries the name; `messages` ends with the user turn — snapshot the body
  via `JSON.parse(JSON.stringify(...))` in the stub, since the live array is
  mutated after the call); a `needs_more_info:true` reply renders an AI question
  with **no** suggestions/Apply and keeps the reply box; a second Send posts
  `messages.length === 3` (history kept) and a `needs_more_info:false` reply
  renders `suggestions`; a tweak result with `revised_recipe` shows **Apply
  changes to recipe** (owned only), whose click closes the panel and opens the
  edit form with `#rf-name` === the revised name.
  - **24h persistence** — after a turn, `localStorage["coach:v1:<recipeId>"]` holds
    the thread (per mode) with an `updatedAt`; closing and reopening the panel
    restores it; a pre-seeded entry with `updatedAt` older than 24h is pruned on
    open (thread comes back empty, the key is removed). Storage access is wrapped
    in try/catch (Safari private mode falls back to in-memory).
  - **Emphasize → apply** (troubleshoot) — once a troubleshoot turn concludes on an
    owned recipe, an **✍️ Update recipe to emphasize this** button appears; clicking
    it sends a canned "emphasize the step I got wrong" turn (still `mode:
    "troubleshoot"`), and a reply carrying `revised_recipe` swaps the emphasize
    button for **Apply changes to recipe** → the edit form shows the rewritten step.
  (Known-good: an 18-assertion harness covering all of the above passed 18/18.)
- **Servings round-trip** — open a recipe, tap the detail `＋` stepper, assert
  the ingredient amounts re-render scaled; check the row into the grocery
  basket and assert the grocery total reflects the same scale (and stepping in
  the grocery row updates the detail). Single source of truth = `chosenServings`.
- **Unit toggle** — click `.unit-toggle-btn[data-unit="us"]` in an open detail
  and assert weights flip to oz/lb (the open item re-renders, others unaffected;
  nothing is saved to Supabase).
- **Step reorder** — toggle `#rf-reorder-steps` in the form, assert `▲▼` controls
  appear, click `▼` on a step and assert the textarea order changed; save and
  assert `method` order follows the DOM.
- **Meal plan flow** — stub `meal_plan_entries` insert/select; click `📅 Add to
  Weekly Meal Plan` (tray gains the recipe), open the planner, arm the tray chip,
  tap a day/slot `＋` and assert an `insert` fired; click "Create grocery list"
  and assert the basket fills from planned servings + entries get `purchased_at`.
- **Send a recipe (HTML export)** — stub `navigator.share`/`canShare` (use
  `Object.defineProperty`, both are read-only/absent in headless Chrome) to capture
  the arg; open an owned recipe and click `.send-recipe-btn`. Assert `navigator.share`
  gets a **`File`** whose name ends `.html`, `type === "text/html"`; read it with
  `await file.text()` and assert it starts with `<!DOCTYPE html>`, contains the
  `esc`'d name + **every** ingredient item and method step + the footer/app link, and
  has **no** `undefined`/`[object Object]`, < ~9 KB. **Design match:** the Fraunces/
  Public Sans/IBM Plex Mono fonts `<link>` and the `kicker`/`pts`/`steps`/`closer`
  classes; accent `#3E6B3A` for a Kitchen recipe, `#B5402A` for a **Bar** recipe.
  Also: a method-less cocktail omits `<h2>Method</h2>`; switching the unit toggle to
  US before sending changes amounts (30 ml → tbsp) via `convertForDisplay`; with
  `canShare`→false the fallback shares plain `text` (no `files`, contains
  "INGREDIENTS"). NB: the fixture session **must include `user.email`** —
  `ensureProfile()` splits it, and a missing email throws inside `loadData` so the
  list never renders. (Known-good: a 22-assertion harness passed 22/22.)

## 4. Functional / business-logic test matrix

These are pure-logic functions in `app.js` — testable in isolation by calling
them from a `test_*.html` after the app loads (or by extracting the function
logic into the harness). Assert exact outputs:

| Area | Function(s) | Cases to assert |
|---|---|---|
| Fraction display | `fmtAmount` | `0.5→½`, `0.25→¼`, `0.33→⅓`, `1.5→1½`, `2→2`, `0→` (blank/"to taste"), `0.125→⅛` |
| Servings scaling | `scaledIngredients` | double servings doubles amounts; **blank amount stays blank** (to-taste never scales); base servings = no change |
| Servings single-source | `chosenServings`, `setRecipeServings` | basket value wins if picked; else a detail-view override (`servingsByRecipe`); else `baseServings`. Stepping in the **detail** view updates the **grocery** total and vice-versa; floor is 1. |
| Unit toggle (display only) | `convertForDisplay` | `original`→ passthrough; `us`: 200 g→`7.05 oz`, 700 g→`1.54 lb` (flips to lb at ≥16 oz), 250 ml→`1.06 cup`; `metric`: 1 lb→`453.6 g`, 2 cup→`473 ml`. Non-convertible units (clove/can/slice) and blank amounts pass through unchanged. **Never persisted** — only the open detail re-renders. |
| Grocery combine | `combinedGroceryItems` | two recipes each needing ground beef → one line summing amounts; mismatched units handled by family; combine key uses `normalizeItemName` so "Black Pepper, to taste" + "pepper" merge. |
| Combine-key normalize | `normalizeItemName` | strips parentheticals + prep clauses + dash notes; folds synonyms (kosher salt→salt, EVOO/extra-virgin olive oil→olive oil, scallion→green onion, garbanzo→chickpea); "boneless, skinless chicken" kept (not a prep word). |
| Practical rounding | `canonicalQuantity`, `shoppableQuantity` | rounds **up** so you never under-buy: 450 g→**1 lb**, 90 g→**3.25 oz**, 200 g→**7.25 oz**; `<50 g` stays whole grams (yeast/spice); 1.9 cup→**2 cup**, tbsp→½ steps; counts/cloves→whole number (1.3→2). |
| Grocery display name | `displayGroceryName` | "carrots, diced"→"carrots", "potatoes, peeled and chopped"→"potatoes", "olive oil — a splash"→"olive oil"; **"peeled tomatoes" / "floury potatoes" kept**; recipe detail & cook view show the original (NOT stripped). |
| Grocery aisles | `categorizeGrocery`, `groceryByCategory` | order-priority matters: "frozen peas"→**Frozen** (before Produce), "chicken broth"→**Canned** (before Meat), "peanut butter"→**Dry Goods** (before Dairy's bare "butter"); butter→**Dairy**, bucatini/any pasta shape→**Dry Goods**, guanciale→**Meat**, Campari→**Beverages**; unmatched→**Other** (last). Empty sections skipped. |
| Pantry staples | `isPantryStaple` | salt/pepper/oil/water/sugar/butter/flour → true; "olive oil" still matches; **"bell pepper"/"red pepper" → false** (produce, not the staple); "almond flour" → false (specialty). |
| Sections | `groupRuns` | items with mixed `group` labels split into runs in order; all-null → one ungrouped run |
| Sharing labels | `shareButtonLabel`, `shareRecipients` | 0 → "Share", 1 → "Shared with 1 person", 2 → "…2 people" |
| Escaping | `esc` | `<`, `>`, `&`, `"`, `'` all entity-encoded |

For each: PASS only on exact expected value. A wrong fraction, a to-taste item
that scaled, a prep note that leaked onto the shopping list, or a rounding that
goes *down* (under-buy) is a real user-facing bug.

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
2b. **Link-extraction suite** (the helpers that source URL content:
   `findJsonLdRecipe`/`findRecipeNode`, `extractYouTube`, `pageMeta`,
   `looksLikeBotChallenge`). `curl` real pages to `/tmp/*.html`, then run the
   helper logic over the saved files — **no Anthropic spend.** The sandbox blocks
   serving `/tmp` over http.server and Python's urllib has no CA certs, so the
   reliable recipe here is: **curl the fixtures, then a Python script that
   re-implements the same regex/JSON logic and reads the local files** (ports are
   mechanical — keep them in sync with the TS). Assert:
   - `youtube.com/watch?v=vpRV_Pvlczw` → `extractYouTube` returns a title + a
     >1000-char description containing the recipe ("Butter 125", "apples"). This
     is the regression test for the reported bug (recipe lived in the video
     description, which `htmlToText` had thrown away).
   - `bbcgoodfood.com` + `budgetbytes.com` recipes → `findJsonLdRecipe` returns a
     Recipe node with `name` (+ `recipeIngredient` where present).
   - `allrecipes.com` + `liquor.com` → `looksLikeBotChallenge` → `true` (these
     Cloudflare-wall server fetches; the correct outcome is the paste-text error,
     not extraction — a self-contained build can't beat their bot protection).
   Last run: **all 5 PASS.** Also confirm the **front-end fallback**: in the
   headless-Chrome harness, stub `functions.invoke` to return
   `{data:{error:"…"}}` for a `type:"url"` payload and assert a
   **📋 Paste text instead** button (`.ai-paste-fallback`) appears in the error
   area and clicking it reveals the text box.
3. **Input validation** — confirm (by reading the branch) that: missing/empty
   `text`, an `images` array longer than `MAX_IMAGES` (4), a disallowed
   `mediaType`, and an unknown `type` each return an `{error}` **before** any
   fetch to Anthropic.
4. **Daily caps** — two independent buckets: imports via
   `increment_extraction_usage` (20/day, `extract-recipe`) and coaching via
   `increment_coach_usage` (20/day, `recipe-coach`, each ✨ Ask AI message incl. an
   emphasize request). For each, the 21st call same UTC day returns `-1` (→ "used
   today's 20…" error) and the first call next UTC day resets to 1; the two never
   draw down each other. To verify live without the app, in the Supabase SQL
   editor as the test user:
   ```sql
   select public.increment_extraction_usage(20);  -- returns running count, or -1 at the cap
   select public.increment_coach_usage(20);        -- separate counter
   ```
   Confirm each **fails open**: if its RPC errors (migration missing), the Edge
   Function logs and proceeds — the request must not break.
5. **AI prompt-contract audit** (free, static — read the two Edge Functions). The
   AI features must keep their **standard built-in focusing prompts + forced
   structured output**, so a future edit can't silently turn them into open-ended
   chat. Assert:
   - **extract-recipe:** a non-empty `SYSTEM_PROMPT` is passed as `system`;
     `tool_choice` is `{type:"tool", name:"save_recipe"}` (forced, not "auto"); the
     `RECIPE_SCHEMA.required` list is complete (name, section, ingredients, method,
     tags, …). One Anthropic call per request.
   - **recipe-coach:** both `TROUBLESHOOT_PROMPT` and `TWEAK_PROMPT` exist and are
     selected per mode in `buildSystemPrompt(mode, recipe)` (which also injects the
     recipe into the system prompt); `tool_choice` forces the `respond` tool; and
     `COACH_SCHEMA` requires all four focusing fields. Grep the focusing rules so
     they can't be dropped unnoticed:
     ```bash
     f=supabase/functions/recipe-coach/index.ts
     grep -nq 'tool_choice.*respond'                  "$f" && echo "forced tool ✓"
     grep -nq 'TROUBLESHOOT_PROMPT'                    "$f" && grep -nq 'TWEAK_PROMPT' "$f" && echo "both prompts ✓"
     grep -niq 'clarifying questions BEFORE concluding' "$f" && echo "asks-first rule ✓"
     grep -nq 'needs_more_info'                        "$f" && echo "gating field ✓"
     grep -niq 'suggestions.*empty\|leave .suggestions. empty' "$f" && echo "empty-while-asking ✓"
     ```
     These four behaviors — *forced tool, mode prompt, ask-clarifying-first,
     needs_more_info gating* — are what make the coach focus the user quickly. The
     **live** proof that the model actually obeys them is Phase 6b.

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

## 6b. AI coach & tweak acceptance (live)  ⚠️ spends coach quota

Phase 5's prompt audit proves the focusing prompt *exists*; this proves the model
*obeys* it. Each call counts against the **coach** cap (`increment_coach_usage`,
separate from extraction) — say so before running. Drive it through the **✨ Ask
AI** UI (preferred — true end-to-end) or by `curl` with a signed-in token:

```bash
# USER_JWT from the app console:
#   (await supabaseClient.auth.getSession()).data.session.access_token
REC='{"name":"Apple Tarte Tatin","section":"kitchen","tags":["french","dessert"],
  "base_servings":8,"servings_label":"servings",
  "ingredients":[{"amount":125,"unit":"g","item":"butter","group":null},
                 {"amount":200,"unit":"g","item":"sugar","group":null},
                 {"amount":6,"unit":null,"item":"apples","group":null}],
  "method":[{"text":"Make a caramel with the sugar and butter.","group":null},
            {"text":"Add apples and bake.","group":null}],"notes":null}'
curl -s -X POST "$SUPABASE_URL/functions/v1/recipe-coach" \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d "{\"mode\":\"troubleshoot\",\"recipe\":$REC,
       \"messages\":[{\"role\":\"user\",\"content\":\"my caramel burned and the tart was watery\"}]}" \
  | jq '.result | {needs_more_info, reply, suggestions, has_revised: (.revised_recipe!=null)}'
```

**Scenarios & must-pass assertions** (assert the model honored the prompt):

| Scenario | Input | Must-pass |
|---|---|---|
| Troubleshoot — vague | `troubleshoot`, one vague flop message | **Turn 1 asks first:** `needs_more_info:true`, `reply` is a specific question (pan/heat/temp/timing), `suggestions:[]`, `revised_recipe:null`. This is the proof the prompt focuses the user. |
| Troubleshoot — conclude | add an answer turn, send again | `needs_more_info:false`; `reply` names the likely cause + a brief *why*; `suggestions` are concrete fixes; still `revised_recipe:null` (not asked to rewrite). |
| Troubleshoot — emphasize | after concluding, send the "update my recipe to emphasize the step I got wrong" turn | `revised_recipe` non-null and rewrites the relevant **method** step to call out the exact amount/temp/timing; `notes` gains an `AI tweaked:` line; every other field carried over unchanged; valid `RECIPE_SCHEMA`. |
| Tweak — specific | `tweak`, "it's too sweet" | `suggestions` give concrete changes **with amounts**; if `revised_recipe` is returned it carries everything unchanged except the fix + an `AI tweaked:` note; `section`/tags preserved. |
| Tweak — vague | `tweak`, "it's missing something" | One focused clarifying question first (`needs_more_info:true`, `suggestions:[]`). |

**Cross-cutting (every coach result):**
- Valid against `COACH_SCHEMA`: `reply` a non-empty string, `needs_more_info` a
  boolean, `suggestions` an array of strings, `revised_recipe` an object or null.
- Any `revised_recipe` is valid `RECIPE_SCHEMA` and pre-fills the edit form
  without error (the UI feeds it straight to `fillRecipeFormFromExtraction`).
- A `troubleshoot` reply **never** carries `revised_recipe` unless the user asked
  to update the recipe; `tweak` only when a rewrite genuinely helps.
- The call increments the **coach** counter, not the extraction one.

Record a small table: scenario → PASS/PARTIAL/FAIL + the rule violated. If the
model stops asking clarifying questions or starts rewriting unprompted, that's a
prompt regression — flag it for a prompt fix (separate from this test run).

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
- **Meal-plan persistence:** entries survive a reload (re-read from
  `meal_plan_entries`); the rolling window is exactly today−7…today+6, so a day
  ages out of "upcoming" into "history" and eventually drops off; `loadMealPlan`
  **fails open** to an empty plan if the table is missing. History chips open
  cook mode at the planned servings; a deleted recipe shows "(recipe unavailable)"
  rather than throwing.
- **Recipient remove:** a user who was shared a recipe can Remove it from their
  own book (`removeSharedWithMe` deletes only their `recipe_shares` row) without
  touching the owner's copy or anyone else's share.
- **Empty/edge states:** zero recipes, a recipe with no tags, an ingredient
  with a blank amount, a 1-step recipe, a recipe shared then unshared, a grocery
  list built from a plan with a since-deleted recipe.
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
