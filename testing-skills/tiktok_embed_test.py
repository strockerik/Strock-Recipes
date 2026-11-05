#!/usr/bin/env python3
"""TikTok caption fallback test for extract-recipe (no backend, no spend).

TikTok's oEmbed stopped returning captions around 2026-10-18, so extract-recipe
reads them from the public embed page's __FRONTITY_CONNECT_STATE__ JSON. This
pulls the REAL tikTokVideoId + parseTikTokEmbedState + fetchTikTokEmbed out of
the Edge Function, strips their few type annotations, and runs them in headless
Chrome against a synthetic page shaped like TikTok's (and, with --page FILE, a
saved real one). fetchTikTokEmbed's retry-on-429 runs against a stubbed fetch —
nothing goes over the network.
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
    m = re.search(rf"^(?:async )?function {name}\(.*?^}}\n", SRC, re.S | re.M)
    if not m: sys.exit(f"FAIL  {name} not found in extract-recipe")
    return m.group(0)

def const(name):
    m = re.search(rf"^const {name} = .*;\n", SRC, re.M)
    if not m: sys.exit(f"FAIL  const {name} not found in extract-recipe")
    return m.group(0)

def strip(ts):
    for pat, rep in [(r"\(html: string\): \{ caption: string; author: string \} \| null \{", "(html) {"),
                     (r"\(href: string \| null \| undefined\): string \| null \{", "(href) {"),
                     (r"\(entry as any\)", "entry"),
                     (r"\(videoId: string, statuses: string\[\] = \[\]\): Promise<\{ caption: string; author: string \} \| null> \{", "(videoId, statuses = []) {")]:
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

# fetchTikTokEmbed against a scripted fetch: each case is the sequence of
# responses TikTok gives ("throw" = network error), and what should come back.
PAGE = synthetic("One-pot pasta: 2 cups pasta, 2 1/2 cups chicken broth, 1/4 cup cream, 3 tbsp butter")
GOT = {"caption": "One-pot pasta: 2 cups pasta, 2 1/2 cups chicken broth, 1/4 cup cream, 3 tbsp butter", "author": "Test Cook"}
RETRY = [
    ("429, 429, then 200 -> caption", [[429, ""], [429, ""], [200, PAGE]], GOT, "429,429,200", 3),
    ("404 -> null, no retry", [[404, ""]], None, "404", 1),
    ("429 every time -> null after 6 tries", [[429, ""]] * 9, None, "429,429,429,429,429,429", 6),
    ("200 without state -> retried", [[200, "<html>verify</html>"], [200, PAGE]], GOT, "200,nostate,200", 2),
    ("network error -> retried", ["throw", [503, ""], [200, PAGE]], GOT, "neterr,503,200", 3),
    ("post with no caption -> stops", [[200, synthetic("")]], {"caption": "", "author": "Test Cook"}, "200", 1),
]

def safe(obj):
    # Fixtures contain "</script>" — escape "</" so it can't end the inline script.
    return json.dumps(obj).replace("</", "<\\/")

def main():
    real = None
    if "--page" in sys.argv:
        real = pathlib.Path(sys.argv[sys.argv.index("--page") + 1]).read_text(encoding="utf-8", errors="replace")
    js = strip(fn("tikTokVideoId") + fn("parseTikTokEmbedState") + const("TIKTOK_EMBED_ATTEMPTS")
               + const("TIKTOK_EMBED_BUDGET_MS") + fn("fetchTikTokEmbed"))
    page = f"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
{js}
const CASES = {safe(CASES)}; const IDS = {safe(IDS)}; const REAL = {safe(real)}; const RETRY = {safe(RETRY)};
let queue = [], calls = 0, delays = [];
window.fetch = async () => {{
  calls++; const r = queue.shift();
  if (r === "throw" || !r) throw new TypeError("network");
  return {{ status: r[0], ok: r[0] >= 200 && r[0] < 300, text: async () => r[1], body: {{ cancel: async () => {{}} }} }};
}};
window.setTimeout = (f, ms) => {{ delays.push(ms); Promise.resolve().then(f); return 0; }};
(async () => {{
  const retry = [];
  for (const [n, responses, want, wantStatuses, wantCalls] of RETRY) {{
    queue = responses.slice(); calls = 0; delays = []; const statuses = [];
    const got = await fetchTikTokEmbed("7400000000000000001", statuses);
    const growing = delays.every((d, i) => i === 0 || d > delays[i - 1]);
    retry.push({{ n, want, got, statuses: statuses.join(","), wantStatuses, calls, wantCalls, delays: delays.length, growing }});
  }}
  document.getElementById("out").textContent = JSON.stringify({{
    cases: CASES.map(([n, html, want]) => ({{ n, want, got: parseTikTokEmbedState(html) }})),
    ids: IDS.map(([u, want]) => ({{ u, want, got: tikTokVideoId(u) }})),
    retry, real: REAL ? parseTikTokEmbedState(REAL) : undefined }});
}})();
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
    for r in res["retry"]:
        ok = (r["got"] == r["want"] and r["statuses"] == r["wantStatuses"] and r["calls"] == r["wantCalls"]
              and r["delays"] == r["calls"] - 1 and r["growing"])
        fails += not ok; total += 1
        print(("  ok   " if ok else "FAIL  ") + "retry: " + r["n"] + ("" if ok else f"   got {r['got']!r} statuses={r['statuses']} calls={r['calls']} pauses={r['delays']}"))
    if real is not None:
        ok = bool(res["real"] and res["real"]["caption"]); fails += not ok; total += 1
        print(("  ok   " if ok else "FAIL  ") + f"real saved page -> {res['real']!r}"[:160])
    print(f"\n{total - fails}/{total} passed"); sys.exit(0 if not fails else 2)
main()
