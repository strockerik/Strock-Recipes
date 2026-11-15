#!/usr/bin/env python3
"""Edge Function policy test (static, no backend, no spend).

Guards the v1.9 rules across all seven functions in supabase/functions/:
  - a daily cap that can't be checked refuses the paid call (no "fails open");
  - recipe ideas and cocktail options are capped before their model call;
  - every function that calls a model logs it through logAiCall;
  - nothing reads the legacy anon / service-role keys (retired 2026-11-15);
  - link import reads pages through the size cap and the DNS check.
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[1] / "supabase" / "functions"
FNS = {p.parent.name: p.read_text() for p in sorted(ROOT.glob("*/index.ts"))}
PAID = ["extract-recipe", "generate-recipe", "identify-bottle", "pair-drink", "recipe-coach", "research-bottle"]
fails = 0
def ok(label, cond, detail=""):
    global fails
    fails += not cond
    print(("PASS " if cond else "FAIL ") + label + ("" if cond else f"   >> {detail}"))

ok("all seven functions found", len(FNS) == 7, sorted(FNS))
for name in PAID:
    src = FNS[name]
    # Every `if (usageError …)` / `if (ideasError …)` branch must return.
    open_branches = re.findall(r"if \((?:usage|ideas|options)Error\) console\.error\([^;]*\);", src)
    ok(f"{name}: no cap check fails open", not open_branches, open_branches)
    caps = len(re.findall(r"\.rpc\(\"increment_\w+_usage\"", src))
    closed = len(re.findall(r"return json\(\{ error: LIMIT_CHECK_FAILED \}\)", src))
    ok(f"{name}: every cap check has a refusal ({caps} caps, {closed} refusals)", caps >= 1 and closed == caps, (caps, closed))
    ok(f"{name}: model calls are logged", "async function logAiCall" in src and src.count("logAiCall(") >= 2)
for name, src in FNS.items():
    ok(f"{name}: no legacy key fallback", "SUPABASE_ANON_KEY" not in src and "SUPABASE_SERVICE_ROLE_KEY" not in src)

def before(src, first, second):
    i, j = src.find(first), src.find(second)
    return 0 <= i < j
gen, pair = FNS["generate-recipe"], FNS["pair-drink"]
ok("recipe ideas are capped before the model call",
   before(gen, 'usage_kind: "ideas"', 'runTool(CONCEPTS_PROMPT'))
ok("cocktail options are capped before the model call",
   before(pair, 'usage_kind: "pair_options"', 'runTool(buildCocktailOptionsPrompt'))

ext = FNS["extract-recipe"]
ok("link import reads the page through the size cap", "html = await readCapped(pageRes);" in ext and "await pageRes.text()" not in ext)
ok("link import resolves the host before fetching", before(ext, "await resolvesPublic(url.hostname)", "const pageRes = await fetch(url"))
ok("…and re-checks where a redirect landed", "resolvesPublic(landed.hostname)" in ext)
ok("carrier-grade NAT (100.64/10) is refused as a literal address", "(a === 100 && b >= 64 && b <= 127)" in ext)
rb = FNS["research-bottle"]
ok("research-bottle refreshes scores where a lookup writes them (order: research_bottle_test)",
   rb.count("await refreshScores(admin);") == 2)

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
