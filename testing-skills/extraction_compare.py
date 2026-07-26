#!/usr/bin/env python3
"""
Old-vs-new extraction equivalence check for the Groq cheap tier.

For each input in extraction_corpus.json, calls the DEPLOYED extract-recipe twice
via the force_provider affordance — once "claude" (OLD baseline), once "groq"
(NEW) — then grades the two structured recipes pairwise and prints a table plus
the overall cheap-model equivalence rate. Raw outputs are archived to
ai_test_runs/compare-<ts>/ (git-ignored).

Prereqs (see README "AI provider routing"):
  - extract-recipe deployed with the Groq tier code
  - GROQ_API_KEY set (Edge Functions -> Secrets)
  - ALLOW_PROVIDER_OVERRIDE=1 set (temporarily, for this test)
  - TEST_EMAIL / TEST_PASSWORD in gitignored notes.md
Groq calls are free-tier; Claude calls cost ~a cent each. force_provider skips
the daily cap, so this can't exhaust quota. Groq calls are paced to respect the
free-tier 8000 tokens/min limit.

Run from the repo root:  python3 testing-skills/extraction_compare.py
"""
import json, subprocess, sys, re, time, pathlib

def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "config.js").exists() and (d / "notes.md").exists():
            return d
    sys.exit("run from the repo root (needs config.js + notes.md)")
REPO = find_repo()

def grep1(pattern, path):
    m = re.search(pattern, (REPO / path).read_text())
    return m.group(0) if m else None

SB = grep1(r"https://[a-z0-9]+\.supabase\.co", "config.js")
ANON = grep1(r"eyJ[A-Za-z0-9._-]+", "config.js")
notes = (REPO / "notes.md").read_text()
EMAIL = (re.search(r"^TEST_EMAIL=(.*)$", notes, re.M) or [None, None])[1]
PASS = (re.search(r"^TEST_PASSWORD=(.*)$", notes, re.M) or [None, None])[1]
if not all([SB, ANON, EMAIL, PASS]):
    sys.exit("missing SB/ANON/TEST_EMAIL/TEST_PASSWORD")

def curl(url, headers, body):
    args = ["curl", "-s", "-m", "60", url]
    for h in headers:
        args += ["-H", h]
    args += ["-H", "content-type: application/json", "-d", body]
    out = subprocess.run(args, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"error": f"non-json: {out[:200]}"}

# ---- sign in ----
tok = curl(f"{SB}/auth/v1/token?grant_type=password", [f"apikey: {ANON}"],
           json.dumps({"email": EMAIL, "password": PASS})).get("access_token")
if not tok:
    sys.exit("sign-in failed — check TEST_EMAIL/TEST_PASSWORD")
HDRS = [f"Authorization: Bearer {tok}", f"apikey: {ANON}"]
FN = f"{SB}/functions/v1/extract-recipe"

corpus = json.loads((REPO / "testing-skills" / "extraction_corpus.json").read_text())
OUT = REPO / "ai_test_runs" / ("compare-" + time.strftime("%Y-%m-%d-%H%M"))
OUT.mkdir(parents=True, exist_ok=True)

# ---- normalization + grading helpers ----
PREP = {"minced","diced","chopped","fresh","freshly","melted","shredded","crushed",
        "grated","sliced","peeled","to","taste","large","small","packed","softened"}
def norm_item(s):
    s = re.sub(r"\(.*?\)", "", str(s or "")).lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    words = [w for w in s.split() if w not in PREP]
    words = [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words]  # crude singularize
    return " ".join(words).strip()

def item_set(r):
    return {norm_item(i.get("item")) for i in (r.get("ingredients") or []) if norm_item(i.get("item"))}

def jaccard(a, b):
    if not a and not b: return 1.0
    if not a or not b: return 0.0
    return len(a & b) / len(a | b)

def call(item, provider):
    body = {"type": item["type"], "force_provider": provider}
    if item["type"] == "text": body["text"] = item["text"]
    else: body["url"] = item.get("url")
    return curl(FN, HDRS, json.dumps(body))

rows = []
print(f"run dir: ai_test_runs/{OUT.name}\n")
for it in corpus:
    lbl = it["label"]
    c = call(it, "claude")
    time.sleep(2)
    g = call(it, "groq")
    # Pace Groq >60s apart: gpt-oss-20b reserves the full max_tokens (4096)
    # against the free-tier 8000 tokens/min, so only ~one call fits per rolling
    # minute. Tighter spacing 429s (which in prod would just escalate to Claude).
    time.sleep(62)
    (OUT / f"{lbl}.claude.json").write_text(json.dumps(c, indent=2))
    (OUT / f"{lbl}.groq.json").write_text(json.dumps(g, indent=2))

    cr, gr = c.get("recipe"), g.get("recipe")
    g_valid = bool(g.get("valid")) and gr is not None
    if not cr:
        verdict = "BASELINE-ERR"; jac = 0.0; note = c.get("error", "")[:40]
    elif not gr:
        verdict = "escalates"; jac = 0.0; note = "groq " + (g.get("error", "no recipe")[:30])
    else:
        cs, gs = item_set(cr), item_set(gr)
        jac = jaccard(cs, gs)
        sect_ok = cr.get("section") == gr.get("section")
        dcount = abs(len(cs) - len(gs))
        if not g_valid:
            verdict = "escalates"; note = "groq invalid→Claude"
        elif sect_ok and jac >= 0.7 and dcount <= 1:
            verdict = "equivalent"; note = ""
        elif jac >= 0.5:
            verdict = "minor-diff"; note = ("section!" if not sect_ok else f"jac {jac:.2f}")
        else:
            verdict = "DIVERGENT"; note = f"jac {jac:.2f}" + ("" if sect_ok else " section!")
        note = note or (f"missing: {sorted(cs - gs)}" if (cs - gs) else "")
    rows.append((lbl, cr, gr, g_valid, jac, verdict, note))
    print(f"  {lbl:20} claude={'ok' if cr else 'ERR':3}  groq={'ok' if gr else '—':3} "
          f"valid={str(g_valid):5} jac={jac:.2f}  -> {verdict}  {note}")

# ---- summary ----
n = len(rows)
groq_ok = sum(1 for r in rows if r[3])
equiv = sum(1 for r in rows if r[5] == "equivalent")
minor = sum(1 for r in rows if r[5] == "minor-diff")
esc = sum(1 for r in rows if r[5] == "escalates")
div = sum(1 for r in rows if r[5] == "DIVERGENT")
avg_j = sum(r[4] for r in rows if r[2]) / max(sum(1 for r in rows if r[2]), 1)
print("\n" + "=" * 64)
print(f"inputs: {n}   groq valid: {groq_ok}/{n} ({100*groq_ok//n}%)   avg ingredient Jaccard: {avg_j:.2f}")
print(f"equivalent: {equiv}   minor-diff: {minor}   escalates(→Claude): {esc}   DIVERGENT: {div}")
if div:
    print("\nReview DIVERGENT cases in", OUT.name, "— they are where Groq's output differs materially.")
else:
    print("\nNo divergent cases: every Groq result is equivalent to Claude or safely escalates.")
