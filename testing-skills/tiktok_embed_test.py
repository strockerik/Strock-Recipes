#!/usr/bin/env python3
"""TikTok caption fallback test for extract-recipe (no backend, no spend).

TikTok's oEmbed stopped returning captions around 2026-10-18, so extract-recipe
reads them from the public embed page's __FRONTITY_CONNECT_STATE__ JSON. This
pulls the REAL tikTokVideoId + parseTikTokEmbedState out of the Edge Function,
strips their few type annotations, and runs them in headless Chrome against a
synthetic page shaped like TikTok's (and, with --page FILE, a saved real one).
Run from anywhere in the repo:  python3 testing-skills/tiktok_embed_test.py [--page embed.html]
"""
import json, pathlib, re, subprocess, sys, tempfile

def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "supabase" / "functions").exists():
            return d
    sys.exit("no repo root found")
REPO = find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC = (REPO / "supabase/functions/extract-recipe/index.ts").read_text()

def fn(name):
    m = re.search(rf"^function {name}\(.*?^}}\n", SRC, re.S | re.M)
    if not m: sys.exit(f"FAIL  {name} not found in extract-recipe")
    return m.group(0)

def strip(ts):
    for pat, rep in [(r"\(html: string\): \{ caption: string; author: string \} \| null \{", "(html) {"),
                     (r"\(href: string \| null \| undefined\): string \| null \{", "(href) {"),
                     (r"\(entry as any\)", "entry")]:
        ts = re.sub(pat, rep, ts)
    if re.search(r":\s*(?:string|any|unknown)\b|\bas any\b", ts): sys.exit("FAIL  type-strip left annotations — extend strip()")
    return ts

def synthetic(caption, author="Test Cook", uid="testcook"):
    state = {"frontity": {"title": "TikTok Embed"}, "source": {"data": {"/embed/v2/7400000000000000001": {"videoData": {
        "itemInfos": {"id": "7400000000000000001", "text": caption},
        "authorInfos": {"uniqueId": uid, "nickName": author}}}}}}
    return ('<html><head><script id="slardar-config">{}</script>'
            f'<script id="__FRONTITY_CONNECT_STATE__" type="application/json">{json.dumps(state)}</script></head></html>')

CASES = [
    ("caption + author read from state", synthetic("Easy pasta 🍝 1 lb spaghetti, 4 cloves garlic, 1/2 cup olive oil… #recipe"), {"caption": "Easy pasta 🍝 1 lb spaghetti, 4 cloves garlic, 1/2 cup olive oil… #recipe", "author": "Test Cook"}),
    ("falls back to uniqueId when no nickname", synthetic("x" * 90, author=""), {"caption": "x" * 90, "author": "testcook"}),
    ("no state script -> null", "<html><body>nothing</body></html>", None),
    ("malformed JSON -> null", '<script id="__FRONTITY_CONNECT_STATE__">{not json</script>', None),
]
IDS = [("https://www.tiktok.com/@cook/video/7412345678901234567?is_from_webapp=1", "7412345678901234567"),
       ("https://www.tiktok.com/embed/v2/7412345678901234567", "7412345678901234567"),
       ("https://vm.tiktok.com/ZMabc123/", None), (None, None)]

def safe(obj):
    # Fixtures contain "</script>" — escape "</" so it can't end the inline script.
    return json.dumps(obj).replace("</", "<\\/")

def main():
    real = None
    if "--page" in sys.argv:
        real = pathlib.Path(sys.argv[sys.argv.index("--page") + 1]).read_text(encoding="utf-8", errors="replace")
    js = strip(fn("tikTokVideoId") + fn("parseTikTokEmbedState"))
    page = f"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
{js}
const CASES = {safe(CASES)}; const IDS = {safe(IDS)}; const REAL = {safe(real)};
document.getElementById("out").textContent = JSON.stringify({{
  cases: CASES.map(([n, html, want]) => ({{ n, want, got: parseTikTokEmbedState(html) }})),
  ids: IDS.map(([u, want]) => ({{ u, want, got: tikTokVideoId(u) }})),
  real: REAL ? parseTikTokEmbedState(REAL) : undefined }});
</script>"""
    with tempfile.TemporaryDirectory() as tmp:
        f = pathlib.Path(tmp) / "t.html"; f.write_text(page)
        dom = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000",
                              "--dump-dom", f.as_uri()], capture_output=True, text=True, timeout=90).stdout
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m or not m.group(1).strip(): print("FAIL  code did not run in Chrome"); sys.exit(2)
    res = json.loads(m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    fails = 0; total = 0
    for r in res["cases"]:
        ok = r["got"] == r["want"]; fails += not ok; total += 1
        print(("  ok   " if ok else "FAIL  ") + r["n"] + ("" if ok else f"   got {r['got']!r}"))
    for r in res["ids"]:
        ok = r["got"] == r["want"]; fails += not ok; total += 1
        print(("  ok   " if ok else "FAIL  ") + f"video id of {r['u']!r} -> {r['got']!r}")
    if real is not None:
        ok = bool(res["real"] and res["real"]["caption"]); fails += not ok; total += 1
        print(("  ok   " if ok else "FAIL  ") + f"real saved page -> {res['real']!r}"[:160])
    print(f"\n{total - fails}/{total} passed"); sys.exit(0 if not fails else 2)
main()
