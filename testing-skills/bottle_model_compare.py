#!/usr/bin/env python3
"""research-bottle model comparison — PAID (real Anthropic calls + web searches).

Runs the deployed research-bottle in its dry-run mode (research + vetting,
nothing written) for each bottle × each model, as the test account, and scores
every run against the scores we already know are true for that bottle (the
hand-checked `curated` rows):
  - recall:   known scores the run confirmed (cited page still shows them) or re-found
  - wrong:    a kept score from the same source + year as a known one, but different
  - flagged:  known scores the run called "changed" (with curated truth, likely wrong)
  - new:      scores it kept that we don't have (listed for a look)
  - cost, searches, tokens, time
Needs the ALLOW_MODEL_OVERRIDE secret set to 1 on research-bottle (remove it after).

Run:  python3 testing-skills/bottle_model_compare.py --yes [--models a,b] [--bottles "X|Y"] [--save FILE.json]
"""
import json, re, subprocess, pathlib, sys, time

if "--yes" not in sys.argv:
    sys.exit("This makes paid calls (about 10–70¢ per run). Re-run with --yes.")
REPO = next(d for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents] if (d / "config.js").exists())
cfg = (REPO / "config.js").read_text(); notes = (REPO / "notes.md").read_text()
url = re.search(r"https://[a-z0-9]+\.supabase\.co", cfg).group(0)
anon = re.search(r"eyJ[\w-]+\.[\w-]+\.[\w-]+|sb_publishable_[\w-]+", cfg).group(0)
email = re.search(r"TEST_EMAIL\s*[=:]\s*(\S+)", notes).group(1)
pw = re.search(r"TEST_PASSWORD\s*[=:]\s*(\S+)", notes).group(1)
arg = lambda flag, default: sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default
MODELS = arg("--models", "claude-haiku-5-5,claude-sonnet-5-5").split(",")
BOTTLES = arg("--bottles", "Elijah Craig Small Batch|Green Chartreuse|Smith & Cross").split("|")

def call(method, path, body=None, token=None, timeout=200):
    a = ["curl", "-s", "-m", str(timeout), "-X", method, url + path, "-H", f"apikey: {anon}", "-H", "Content-Type: application/json"]
    if token: a += ["-H", f"Authorization: Bearer {token}"]
    if body is not None: a += ["-d", json.dumps(body)]
    out = subprocess.run(a, capture_output=True, text=True).stdout
    try: return json.loads(out or "null")
    except Exception: return {"error": out[:300]}
tok = call("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": pw})["access_token"]
num = lambda v: None if v is None else float(v)

total = 0.0
summary = []
runs = []          # every run's full reply, for --save
for name in BOTTLES:
    prod = call("GET", "/rest/v1/spirit_products?select=id,canonical_name&canonical_name=eq." + name.replace(" ", "%20").replace("&", "%26"), token=tok)
    if not prod: print(f"\n{name}: not in the catalog — skipped"); continue
    pid = prod[0]["id"]
    for model in MODELS:
        t0 = time.time()
        r = call("POST", "/functions/v1/research-bottle", {"name": name, "product_id": pid, "dry_run": True, "model": model}, tok)
        secs = time.time() - t0
        runs.append({"bottle": name, "model": model, "seconds": round(secs), "reply": r})
        print(f"\n=== {name} · {model} · {secs:.0f}s")
        if not isinstance(r, dict) or not r.get("dry_run"):
            print("   ", r); summary.append((name, model, "error", 0, 0, 0, 0, 0)); continue
        total += r.get("cost") or 0
        print(f"   {r['detail']}")
        if r.get("error"): summary.append((name, model, "failed", r.get("cost", 0), 0, len(r["known"]), 0, 0)); continue
        known = [k for k in r["known"]]
        kept = r["kept"]
        confirmed = set(r["checks"]["confirmed"])
        refound = set()
        wrong = []
        known_urls = {k["id"]: k.get("url") for k in known}
        for k in known:
            for row in kept:
                same_page = known_urls.get(k["id"]) and row["url"] == known_urls[k["id"]] and num(row["score_raw"]) == num(k["score_raw"])
                if (row["source_id"] != k["source_id"] and not same_page) or (row["review_year"] or 0) != (k["review_year"] or 0):
                    continue
                same = (k["medal"] or "").lower() == (row["medal"] or "").lower() and num(k["score_raw"]) == num(row["score_raw"])
                (refound.add(k["id"]) if same else wrong.append((k, row)))
        hit = confirmed | refound
        flagged = r["checks"]["changed"]
        new = [row for row in kept if not any(row["source_id"] == k["source_id"] and (row["review_year"] or 0) == (k["review_year"] or 0) for k in known)]
        print(f"   recall: {len(hit)}/{len(known)} known scores confirmed or re-found ({len(confirmed)} confirmed by citation)")
        for k in known:
            print(f"     {'✓' if k['id'] in hit else '·'} {k['source_id']:22} {k['medal'] or k['score_raw']} {k['review_year'] or ''}")
        for k, row in wrong: print(f"   WRONG: we know {k['source_id']} {k['medal'] or k['score_raw']} {k['review_year']}, it kept {row['medal'] or row['score_raw']} ({row['url']})")
        for c in flagged: print(f"   FLAGGED as changed: {c}")
        for row in new: print(f"   new: {row['source_id']:22} {row['medal'] or row['score_raw']} {row['review_year'] or ''}  {row['url']}")
        summary.append((name, model, "ok", r.get("cost", 0), len(hit), len(known), len(wrong) + len(flagged), len(new)))

print("\n\nbottle                         model                      result  cost   recall  wrong  new")
for name, model, res, cost, hit, known, wrong, new in summary:
    print(f"{name[:30]:30} {model[:26]:26} {res:7} {cost * 100:5.1f}¢  {hit}/{known:<5} {wrong:5}  {new}")
print(f"\ntotal spent ≈ {total * 100:.1f}¢")
if "--save" in sys.argv:
    dest = pathlib.Path(arg("--save", "compare.json")).resolve()
    dest.write_text(json.dumps(runs, indent=1)); print(f"saved every run to {dest}")
