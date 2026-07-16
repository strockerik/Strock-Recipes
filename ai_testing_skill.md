---
name: ai-testing
description: Live, budgeted quality testing of the House Index AI recipe features against REAL Anthropic calls — generate (ingredients → concepts → full), describe (free-text prompt), and extract (text / image / link / YouTube). Runs a fixed, user-authorized number of paid calls using the real prompts + schemas from the Edge Functions, then GRADES each result against a rubric (structure, quantities/ratios, home-cook simplicity, coherence, timing/safety, diet/allergy adherence, extraction fidelity) and reports patterns + prompt fixes. Use after a prompt change, before shipping a generator/extractor change, or to gut-check quality. Unlike app_testing_skill.md's stubbed smoke tests, this spends money and judges whether the recipes are actually GOOD.
---

# AI Recipe Quality Testing — The House Index

Stubbed smoke tests (see `app_testing_skill.md`) prove the plumbing works. They
can't tell you whether a generated marinara is a good marinara. **This skill
does** — by making real Anthropic calls with the exact production prompts and
grading the output. It costs real money, so it runs on a **budget the user sets**.

Work top to bottom. Do **not** run any paid call until the user has authorized a
specific number.

---

## 0. Ground rules (read first — non-negotiable)

- **Budget is a hard cap.** The user authorizes **N calls** (e.g. "test 8
  recipes"). Announce the plan and the exact call count *before* running, and
  **stop at N**. Each call is roughly ½–2¢ (Haiku text ~½¢, Sonnet vision ~1–2¢).
  Note: a **generate** test is **2 calls** (concepts + full); everything else is
  1 call. Convert the user's "N recipes" into a call budget and confirm it.
- **The API key is a secret.** Read `ANTHROPIC_API_KEY` from the gitignored
  `notes.md` or `.env.local` **only**. Never print it, never put it on a command
  line that gets logged/echoed, never commit it. If it isn't in one of those
  files, ask the user to add it there — do not accept it pasted into chat.
- **Never use the Supabase service-role key here.** Lane B (below) signs in as a
  normal user with email+password + the anon key — the ordinary user path.
- **Archive, don't delete, the results.** Each run writes its JSON results to a
  timestamped folder `ai_test_runs/<YYYY-MM-DD-HHMM>/` (git-ignored — persists on
  disk across sessions so future runs can diff against it; contains recipes only,
  no secrets). Delete only transient harness scripts and any converted temp
  images. Never commit anything containing the key. The headline metrics also go
  to the `ai-quality-baseline` memory for a quick reference point.
- **Mirror production models.** Text/URL/generate → `claude-haiku-4-5-20251001`;
  images → `claude-sonnet-4-6`. Same as the Edge Functions.
- **No drift.** Pull the prompts, tag taxonomy, and schema shape from the actual
  Edge Function source at run time (the harness below does this) so you're
  testing what ships, not a stale copy.

---

## 1. Two lanes — pick per test type

| Lane | How | Tests | Needs | Counts against daily cap? |
|---|---|---|---|---|
| **A — Direct Anthropic** | call `api.anthropic.com` with the real prompt+tool | the **prompt/model quality** for generate, describe, text | `ANTHROPIC_API_KEY` | No |
| **B — Deployed function** | sign in → call the Edge Function | the **whole pipeline**: URL fetch, JSON-LD, YouTube, image handling, caps, allergen net | a test user's email+password (from `notes.md`) | Yes (20/day each) |

**Rule of thumb:** use **Lane A** for generate / describe / paste-text (the
output quality is the model+prompt, which Lane A exercises fully and cheaply).
Use **Lane B** for **image / link / YouTube**, because the input preprocessing
(fetch, readability, Innertube) is the *function's* job and can't be faithfully
reproduced in Lane A. Image can also run in Lane A if you feed a base64 photo
directly (it skips the app's downscale but tests the vision prompt).

---

## 2. Setup

```bash
# Load the key WITHOUT printing it. Supports either `ANTHROPIC_API_KEY=sk-...`
# in .env.local/notes.md, or a bare key line.
export ANTHROPIC_API_KEY="$(grep -hoE 'sk-ant-[A-Za-z0-9_-]+' .env.local notes.md 2>/dev/null | head -1)"
[ -n "$ANTHROPIC_API_KEY" ] && echo "key loaded (len ${#ANTHROPIC_API_KEY})" || echo "NO KEY — ask the user to add it to notes.md/.env.local"
```

Work in the scratchpad dir; the harness reads the live Edge Function source for
prompts/tags so there's no drift.

---

## 3. The harness (Lane A) — `run_ai_tests.py`

Writes each result to the archived run folder `ai_test_runs/<timestamp>/*.json`
(git-ignored, kept for comparison) for grading in §5. It
**extracts the real `SYSTEM_PROMPT` / `PROMPT_RECIPE_PROMPT` / `CONCEPTS_PROMPT`
and tag lists** from the `.ts` files, forces the matching tool, and enforces the
call budget.

```python
import os, re, json, sys, time, pathlib, urllib.request

KEY = os.environ.get("ANTHROPIC_API_KEY")
assert KEY, "ANTHROPIC_API_KEY not set (load from notes.md/.env.local)"
BUDGET = int(sys.argv[1]) if len(sys.argv) > 1 else 0           # max paid calls
assert BUDGET > 0, "pass an authorized call budget: python run_ai_tests.py <N>"
MODEL_TEXT, MODEL_VISION, VER = "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "2023-06-01"
OUT = pathlib.Path("ai_test_runs") / time.strftime("%Y-%m-%d-%H%M"); OUT.mkdir(parents=True, exist_ok=True)  # archived, git-ignored
CALLS = 0

GEN = pathlib.Path("supabase/functions/generate-recipe/index.ts").read_text()
EXT = pathlib.Path("supabase/functions/extract-recipe/index.ts").read_text()
def tmpl(src, name):  # a `const NAME = \`...\`;` template literal
    m = re.search(rf"const {name}\s*=\s*`(.*?)`;", src, re.S); return m.group(1) if m else None
def arr(src, name):
    m = re.search(rf"const {name}\s*=\s*\[(.*?)\]", src, re.S)
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []
TAG_GROUPS = ["KITCHEN_CUISINE_TAGS","KITCHEN_PROTEIN_TAGS","KITCHEN_DISH_TAGS","BAR_SPIRIT_TAGS","BAR_STYLE_TAGS"]
ALL_TAGS = sum((arr(GEN, n) for n in TAG_GROUPS), [])
def resolve(src, name):  # pull a prompt and fill its `${GROUP.join(", ")}` tag interpolations
    t = tmpl(src, name)
    if t:
        for g in TAG_GROUPS:
            t = t.replace(f'${{{g}.join(", ")}}', ", ".join(arr(EXT, g) or arr(GEN, g)))
    assert t and "${" not in t, f"prompt {name} missing or has unresolved interpolation"
    return t

def recipe_schema():
    o = {"type":["string","null"]}
    return {"type":"object","required":["name","subtitle","source","section","tags","base_servings","servings_label","ingredients","method","notes"],
      "properties":{"name":{"type":"string"},"subtitle":o,"source":o,
        "section":{"type":"string","enum":["kitchen","bar"]},
        "tags":{"type":"array","maxItems":3,"items":{"type":"string","enum":ALL_TAGS}},
        "base_servings":{"type":"integer"},"servings_label":{"type":"string"},
        "ingredients":{"type":"array","items":{"type":"object","required":["amount","unit","item","group"],
          "properties":{"amount":{"type":["number","null"]},"unit":o,"item":{"type":"string"},"group":o}}},
        "method":{"type":"array","items":{"type":"object","required":["text","group"],
          "properties":{"text":{"type":"string"},"group":o}}},"notes":o}}
CONCEPTS_SCHEMA = {"type":"object","required":["concepts"],"properties":{"concepts":{"type":"array","minItems":3,"maxItems":3,
    "items":{"type":"object","required":["title","blurb"],"properties":{"title":{"type":"string"},"blurb":{"type":"string"}}}}}}

def call(model, system, tool, schema, content, label):
    global CALLS
    if CALLS >= BUDGET:
        print(f"BUDGET REACHED ({BUDGET}) — skipping {label}"); return None
    CALLS += 1
    body = json.dumps({"model":model,"max_tokens":8192,"system":system,
        "tools":[{"name":tool,"description":"Return the structured result.","input_schema":schema}],
        "tool_choice":{"type":"tool","name":tool},
        "messages":[{"role":"user","content":content}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"content-type":"application/json","x-api-key":KEY,"anthropic-version":VER})
    t0=time.time()
    with urllib.request.urlopen(req, timeout=120) as r: data=json.load(r)
    block = next((c for c in data.get("content",[]) if c.get("type")=="tool_use"), None)
    result = block.get("input") if block else None
    rec = {"label":label,"model":model,"stop_reason":data.get("stop_reason"),
           "secs":round(time.time()-t0,1),"result":result}
    (OUT/f"{label}.json").write_text(json.dumps(rec, indent=2))
    print(f"[{CALLS}/{BUDGET}] {label}  ({rec['secs']}s, stop={rec['stop_reason']})")
    return result

def diet_lines(diets, allergies, avoid):
    j=lambda a: ", ".join(a) if a else "none"
    return ["Dietary constraints:", f"- Diets that MUST be satisfied: {j(diets)}",
            f"- ALLERGIES — never include, in any form: {j(allergies)}",
            f"- Dislikes to avoid when possible: {j(avoid)}"]

# ---- test builders (edit the matrix at the bottom) ----
def t_generate(label, ingredients, section="kitchen", chips=None, diet=(None,None,None)):
    chips=chips or {}; diets,allg,avd=[x or [] for x in diet]
    cons = diet_lines(diets,allg,avd)
    ck=lambda: (["Grocery run: NONE — use ONLY listed + staples." ] if chips.get("groceryRun")=="none" else
                ["Grocery run: OK — a few extras fine."] if chips.get("groceryRun")=="quick" else [])
    lead = "Propose 3 distinct recipe ideas from these main ingredients:" if section=="kitchen" else "Propose 3 distinct cocktail ideas from these on-hand ingredients:"
    ctext="\n".join([lead, "\n".join(f"- {i}" for i in ingredients), "", *ck(), *cons, "", "Call propose_recipes with exactly 3 ideas."])
    concepts = call(MODEL_TEXT, resolve(GEN,"CONCEPTS_PROMPT"), "propose_recipes", CONCEPTS_SCHEMA, [{"type":"text","text":ctext}], f"{label}-concepts")
    if not concepts or not concepts.get("concepts"): return
    pick = concepts["concepts"][0]
    lead2 = "Invent ONE kitchen recipe using these main ingredients:" if section=="kitchen" else "Invent ONE cocktail using these on-hand ingredients:"
    ftext="\n".join([lead2, "\n".join(f"- {i}" for i in ingredients), "",
        f'The user picked this idea — develop it: "{pick["title"]}" — {pick["blurb"]}.', "", *ck(), *cons, "", "Call save_recipe once."])
    call(MODEL_TEXT, resolve(GEN,"SYSTEM_PROMPT"), "save_recipe", recipe_schema(), [{"type":"text","text":ftext}], f"{label}-full")

def t_describe(label, prompt, diet=(None,None,None)):
    diets,allg,avd=[x or [] for x in diet]
    text="\n".join(["The home cook asked for:", f'"{prompt}"', "", "Write ONE reliable, classic version of this.", "", *diet_lines(diets,allg,avd), "", "Call save_recipe once."])
    call(MODEL_TEXT, resolve(GEN,"PROMPT_RECIPE_PROMPT"), "save_recipe", recipe_schema(), [{"type":"text","text":text}], label)

def t_text(label, recipe_text):  # extract-recipe, paste-text path
    content=[{"type":"text","text":f"Extract the recipe from the following text by calling save_recipe:\n\n{recipe_text}"}]
    call(MODEL_TEXT, resolve(EXT,"SYSTEM_PROMPT"), "save_recipe", recipe_schema(), content, label)

def t_image(label, jpeg_path):   # extract-recipe vision path (Sonnet)
    import base64
    b64=base64.b64encode(pathlib.Path(jpeg_path).read_bytes()).decode()
    content=[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":b64}},
             {"type":"text","text":"Extract the recipe from this image by calling save_recipe."}]
    call(MODEL_VISION, resolve(EXT,"SYSTEM_PROMPT"), "save_recipe", recipe_schema(), content, label)

# ================= TEST MATRIX (trim to fit the budget) =================
t_generate("gen-weeknight", ["chicken thighs","lemon","garlic"], chips={"groceryRun":"none"})
t_describe("desc-marinara", "a simple marinara sauce that uses garlic and basil")
t_describe("desc-allergy", "chicken pad thai for two", diet=(None, ["peanut"], None))   # SAFETY: peanut must NOT appear
t_text("text-messy", "grandmas chili - brown 1lb ground beef w/ an onion, add a can of kidney beans, "
       "2 cans diced tomato, 2 tbsp chili powder, cumin, simmer 30 min. salt to taste.")
# --- BENCHMARK FIXTURES: always run these sloppy Recipe Photos (Sonnet ~2c each) ---
# They're the hardest, most informative extraction cases — keep them in EVERY run
# so results are comparable over time. Budget for ~3 Sonnet calls.
t_image("img-pina", "data/Recipe Photos/Pina Colada - No Proportions.jpeg")       # must INFER sensible bar proportions, flag "AI added:"
t_image("img-bbq", "data/Recipe Photos/BBQ Pork - Narrative.jpeg")                # casual narrative -> clean structured steps
t_image("img-enchilada", "data/Recipe Photos/Chicken Enchilada Casserole - Incomplete.jpeg")  # cut-off recipe -> complete it, flag gap-fills
print(f"\nDONE — {CALLS} paid call(s). Results in {OUT}/")
```

Run (from repo root, after loading the key):

```bash
# write run_ai_tests.py to the scratchpad, then run it FROM the repo root so it
# reads supabase/functions/** and writes ai_test_runs/<timestamp>/ under the repo
( cd /repo && ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" python3 /path/to/scratchpad/run_ai_tests.py <BUDGET> )
```
(The harness reads `supabase/functions/**` relative to CWD, so run it from the
repo root — or `cd /repo` inside the invocation as shown.)

---

## 4. Lane B — through the deployed function (image / link / YouTube / full path)

Sign in as a test user (email+password from `notes.md`) to get an access token,
then call the function exactly as the browser does. **Each call counts against
the 20/day cap** — budget accordingly.

```bash
SB="https://olzmcwcybleulazvgxeq.supabase.co"
ANON="$(grep -oE 'eyJ[A-Za-z0-9._-]+' config.js | head -1)"   # anon key is public/RLS-bound
EMAIL="$(grep -oE 'TEST_EMAIL=.*' notes.md | cut -d= -f2)"
PASS="$(grep -oE 'TEST_PASSWORD=.*' notes.md | cut -d= -f2)"
TOKEN="$(curl -s "$SB/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')"
[ -n "$TOKEN" ] || echo "sign-in failed — check TEST_EMAIL/TEST_PASSWORD in notes.md"

call_fn () {  # call_fn '<json body>'
  curl -s "$SB/functions/v1/generate-recipe" -H "Authorization: Bearer $TOKEN" \
    -H "apikey: $ANON" -H 'content-type: application/json' -d "$1"
}
# link extraction (real recipe site):
curl -s "$SB/functions/v1/extract-recipe" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON" \
  -H 'content-type: application/json' -d '{"type":"url","url":"https://www.seriouseats.com/..."}'
# YouTube (validated fixture: Brian Lagerstrom smash burger):
#   {"type":"url","url":"https://www.youtube.com/watch?v=7dP7xJEasY4"}
# generate two-step, real path:
#   call_fn '{"mode":"concepts","ingredients":["chicken thighs","lemon"],"section":"kitchen","dietPrefs":{"diets":[],"allergies":[],"avoid":[]}}'
```
Save each JSON response into the same `ai_test_runs/<timestamp>/` folder for the same grading. Never echo `$TOKEN`.

---

## 5. Grading rubric — the point of the whole exercise

Read each `ai_test_runs/<timestamp>/*.json` and grade. Score each dimension **✓ / ⚠ / ✗** and
keep a one-line note. The app's north star is **simple, helpful, home-cook** —
weight simplicity and correctness over cleverness.

1. **Structural validity** — matches the schema: all required fields present;
   `ingredients` non-empty; `amount` numeric or null (null only for true
   season-to-taste); `section` ∈ {kitchen,bar}; ≤3 `tags`, all in `ALL_TAGS`;
   `item` has no prep words ("diced", "chopped"); `stop_reason` ≠ `max_tokens`.
2. **Quantities & ratios** — amounts sane and consistent with the golden ratios
   in the prompt (vinaigrette 3:1, rice pilaf 2:1, pasta sauce ~1.5 cups/lb, sour
   2:1:1, highball 1:3). Classic red flags: "1 tbsp" where "1 tsp" is right; a
   doubled canned-good; no amount on a measured ingredient.
3. **Simplicity / home-cook fit** *(heavily weighted)* — common supermarket
   ingredients; a short ingredient list; clear steps a busy cook can follow.
   **Flag over-building**: gratuitous specialty items, restaurant-fussy
   techniques, or a 15-ingredient list for a weeknight dish. "Not yet perfect" is
   fine; "a burden" is a fail.
4. **Coherence** — title, ingredients, and method belong to the SAME dish; no
   orphan ingredients (listed but never used) or steps referencing missing items;
   no "Frankenstein" mashups.
5. **Timing / technique / safety** — realistic times (caramelized onions ~30–40
   min, not 5); doneness by sensory cue AND safe temp where relevant (poultry
   165°F, fish 145°F); seasons in stages.
6. **Constraint adherence** — honored the diet/cuisine/time/servings inputs;
   `groceryRun:"none"` added **zero** Tier-3 items; a `Buy:` (generate/describe)
   or `AI added:` (extract) note appears **iff** something beyond the source /
   staples was introduced.
7. **Extraction fidelity** *(text/image/link only)* — output faithfully matches
   the SOURCE: no invented ingredients, amounts transcribed correctly, correct
   name, non-recipe clutter ignored. Gap-fills (a cut-off method, an inferred
   cocktail proportion) are allowed **only** when flagged in `notes`.
8. **Tags & naming** — tags genuinely apply; name is head-noun-first
   ("Marinara Sauce - Garlic & Basil", not "Garlic Basil Marinara").

### Allergen safety — a BLOCKER, not a style note
Every run **must** include ≥1 generate/describe test with an allergy set (the
matrix has `desc-allergy` with peanut). Grep every ingredient `item`, `name`, and
`notes` for the allergen as a whole word. **Any hit is a release blocker** — the
server-side `allergyHit` net should have caught it, so a hit means either the net
or the prompt regressed. Report it first, loudly.

```bash
# quick allergen scan over results
python3 - <<'PY'
import json,glob,re
ALLERGEN="peanut"
for f in glob.glob("ai_test_runs/*/*.json"):   # scan the latest run
    d=json.load(open(f)); r=(d.get("result") or {})
    hay=" ".join([r.get("name",""), r.get("notes","") or ""]+[i.get("item","") for i in r.get("ingredients",[])]).lower()
    if re.search(rf"\b{ALLERGEN}\b", hay): print("!! ALLERGEN HIT:", f)
PY
```

---

## 6. Report

Produce a compact table + narrative:

| Test | Input | Structure | Ratios | Simple | Coherent | Safe | Constraints | Fidelity | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| gen-weeknight | chicken/lemon/garlic, no-run | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (0 Tier-3) | — | good |
| desc-marinara | "simple marinara…" | ✓ | ✓ | ⚠ 9 ingredients | ✓ | ✓ | ✓ | — | over-built |
| … | | | | | | | | | |

Then:
- **Patterns** — the systemic issues (e.g. "describe-mode over-seasons; 2/3 added
  optional garnishes not asked for"), not one-off nits.
- **Compare against the baseline** — diff this run against the
  `ai-quality-baseline` memory and the previous `ai_test_runs/<older>/` folder.
  Call out regressions AND improvements explicitly. Track the metrics that move:
  ingredient counts (simplicity), grocery-run "none" Tier-3 leaks, allergen
  safety, and the **benchmark-fixture** behavior below.
- **Concrete prompt fixes** — the specific line to change in
  `generate-recipe/index.ts` / `extract-recipe/index.ts`, mapped to the failing
  dimension. If a fix is obvious and budget remains, apply it and **re-test 1–2**
  to confirm (still within N).
- **Spend** — `CALLS × ~$0.01` (note Sonnet image calls run higher).
- **Blockers** — any allergen hit or schema break, called out at the top.

### Benchmark fixtures — the sloppy Recipe Photos (grade every run against these)
These three are the standing image benchmarks (always in the matrix). Each stress-
tests a specific extraction skill; grade against the expected-good behavior, and
compare the result to prior runs — a regression here is a real signal:
- **Piña Colada — No Proportions** → the source lists ingredients with NO amounts;
  a good extract *infers* sensible bar proportions (≈2 oz rum / 3 oz pineapple /
  1.5 oz cream of coconut) and flags them in `notes` ("AI added: all amounts").
- **BBQ Pork — Narrative** → a casual prose/text-message screenshot; a good extract
  turns it into clean numbered steps with estimated spice amounts, flagged.
- **Chicken Enchilada Casserole — Incomplete** → the method is cut off; a good
  extract completes it sensibly and flags the gap-fill, without inventing a
  different dish.
(The `.heic` fixtures — Pannakakku, Chicken & Rice — are cursive-card benchmarks;
convert to JPEG first, then add them when budget allows.)

---

## 7. Caveats

- **Nondeterminism** — one weak output isn't proof of a bad prompt. For a
  dimension you're unsure about, sample 2–3 (budget permitting) before concluding.
- **Subjectivity** — "simple" and "classic" are judgment calls; the rubric is a
  proxy, and you're the reviewer. When in doubt, ask: *would a busy home cook
  happily make this tonight?*
- **Lane A ≠ full path** — it exercises the prompt+model but NOT the function's
  URL fetch, YouTube pipeline, daily caps, or `allergyHit` net. Those are Lane B
  only. If a Lane A allergen test is clean but you changed the net, verify Lane B.
- **Prompt extraction** assumes the template literals contain no backtick or
  `` `; `` inside them (true today). If extraction returns `None`, the harness
  will error loudly rather than test a stale prompt — fix the regex, don't
  hardcode the prompt.
- **Fixtures** — `.heic` photos in `data/Recipe Photos/` won't decode as
  `image/jpeg`; convert to JPEG first, or use the `.jpeg` fixtures for Lane A
  image tests.
