#!/usr/bin/env python3
"""
Headless-Chrome smoke test for UNIT ABBREVIATION on recipe display.

Boots the real index.html + app.js against a stubbed Supabase client whose
`recipes` table returns one bar recipe stored in VERBOSE units ("fluid ounces",
"Milliliters", "Tablespoons") plus a custom unit ("dash"). Expands the recipe
and asserts the rendered ingredient amounts are abbreviated (fl oz / ml / tbsp)
in Original, US, and Metric views, while the custom unit passes through.
No backend, no spend.
"""
import http.server, socketserver, threading, subprocess, sys, os, json, re, pathlib

def _find_repo():
    for base in [pathlib.Path.cwd(), pathlib.Path(__file__).resolve().parent]:
        for d in [base, *base.parents]:
            if (d / "index.html").exists() and (d / "app.js").exists():
                return d
    sys.exit("could not locate repo root")
REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST_HTML = REPO / "test_units.html"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub", USER_ID = "u1";
var FAKE_RECIPES = [{
  id: "r1", user_id: USER_ID, section: "bar", name: "Paper Plane",
  subtitle: "unit test", source: null, tags: ["sour"],
  base_servings: 1, servings_label: "drink",
  ingredients: [
    { amount: 0.75, unit: "fluid ounces", item: "bourbon", group: null },
    { amount: 120,  unit: "Milliliters",  item: "stock",   group: null },
    { amount: 2,    unit: "Tablespoons",  item: "syrup",   group: null },
    { amount: 1,    unit: "dash",         item: "bitters", group: null }
  ],
  method: [{ text: "Shake.", group: null }], specs: null, notes: null, is_favorite: false
}];
function makeBuilder(table) {
  var val = function () {
    if (table === "recipes") return { data: FAKE_RECIPES, error: null };
    if (table === "profiles") return { data: { id: USER_ID, display_name: "T", diet_prefs: null, grocery_prefs: null }, error: null };
    return { data: [], error: null };
  };
  var p = new Proxy({}, { get: function (t, k) {
    if (k === "then") return function (f, r) { return Promise.resolve(val()).then(f, r); };
    if (k === "catch") return function (r) { return Promise.resolve(val()).catch(r); };
    return function () { return p; };
  }});
  return p;
}
window.supabase = { createClient: function () { return {
  from: function (tbl) { return makeBuilder(tbl); },
  auth: {
    onAuthStateChange: function (cb) { setTimeout(function () { cb("INITIAL_SESSION", { user: { id: USER_ID } }); }, 0); return { data: { subscription: { unsubscribe: function () {} } } }; },
    getUser: function () { return Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); },
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: USER_ID } } }, error: null }); },
    signInWithPassword: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({ error: null }); }
  },
  functions: { invoke: function () { return Promise.resolve({ data: {}, error: null }); } }
}; } };
</script></head>
<body>
<pre id="smoke-results" style="display:none"></pre>
<script>
var RESULTS = [];
function assert(n, c, d) { RESULTS.push({ name: n, pass: !!c, detail: d || "" }); }
function finish() { document.getElementById("smoke-results").textContent = JSON.stringify(RESULTS);
  document.title = "TESTDONE " + RESULTS.filter(function (r) { return r.pass; }).length + "/" + RESULTS.length; }
function click(el) { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
function amtText() {
  return Array.prototype.slice.call(document.querySelectorAll('.item[data-id="r1"] .ing-amt'))
    .map(function (s) { return s.textContent; }).join(" | ");
}
var VERBOSE = ["fluid ounce", "fluid ounces", "milliliter", "milliliters", "tablespoon", "tablespoons"];
function noVerbose(txt) { var t = txt.toLowerCase(); return VERBOSE.every(function (w) { return t.indexOf(w) < 0; }); }

function runTests() {
  try {
    var barTab = document.querySelector('.tab[data-section="cocktails"]'); if (barTab) click(barTab);
    var head = document.querySelector('.item[data-id="r1"] .item-head');
    assert("recipe row present", !!head, "head=" + !!head);
    if (head) click(head);  // expand detail

    // Original view
    var t = amtText();
    assert("original: shows 'fl oz' not 'fluid ounces'", /\bfl oz\b/.test(t) && t.toLowerCase().indexOf("fluid ounce") < 0, t);
    assert("original: shows 'ml' not 'milliliters'", /\bml\b/.test(t) && t.toLowerCase().indexOf("milliliter") < 0, t);
    assert("original: shows 'tbsp' not 'tablespoons'", /\btbsp\b/.test(t) && t.toLowerCase().indexOf("tablespoon") < 0, t);
    assert("original: custom unit 'dash' passes through", /\bdash\b/.test(t), t);
    assert("original: no verbose unit anywhere", noVerbose(t), t);

    // US view
    var us = document.querySelector('.item[data-id="r1"] .unit-toggle-btn[data-unit="us"]'); if (us) click(us);
    var tu = amtText();
    assert("US view renders", !!tu, tu);
    assert("US: no verbose unit anywhere", noVerbose(tu), tu);
    assert("US: fl oz (non-convertible) stays 'fl oz'", /\bfl oz\b/.test(tu), tu);

    // Metric view
    var mt = document.querySelector('.item[data-id="r1"] .unit-toggle-btn[data-unit="metric"]'); if (mt) click(mt);
    var tm = amtText();
    assert("Metric view renders", !!tm, tm);
    assert("Metric: no verbose unit anywhere", noVerbose(tm), tm);
  } catch (e) { assert("no exception", false, String(e && e.stack || e)); }
  finish();
}

fetch("index.html").then(function (r) { return r.text(); }).then(function (txt) {
  var doc = new DOMParser().parseFromString(txt, "text/html");
  var frag = document.createDocumentFragment();
  Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) {
    if (n.tagName === "SCRIPT") return;
    frag.appendChild(document.importNode(n, true));
  });
  document.body.appendChild(frag);
  var s = document.createElement("script"); s.src = "app.js";
  s.onload = function () {
    var tries = 0;
    (function wait() {
      var bt = document.querySelector('.tab[data-section="cocktails"]'); if (bt) click(bt);
      if (document.querySelector('.item[data-id="r1"]') || tries > 60) { runTests(); return; }
      tries++; setTimeout(wait, 50);
    })();
  };
  s.onerror = function () { assert("app.js loaded", false, "load error"); finish(); };
  document.head.appendChild(s);
}).catch(function (e) { assert("boot", false, String(e)); finish(); });
</script>
</body></html>"""

def main():
    keep = "--keep" in sys.argv
    TEST_HTML.write_text(HTML); os.chdir(REPO)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        out = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--virtual-time-budget=10000", "--dump-dom", f"http://127.0.0.1:{port}/test_units.html"],
            capture_output=True, text=True, timeout=90).stdout
    finally:
        httpd.shutdown()
        if not keep and TEST_HTML.exists(): TEST_HTML.unlink()
    m = re.search(r'<pre id="smoke-results"[^>]*>(.*?)</pre>', out, re.S)
    if not m or not m.group(1).strip():
        print("NO RESULTS — dump head:\n", out[:2000]); sys.exit(1)
    results = json.loads(re.sub(r"&quot;", '"', m.group(1)).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    npass = sum(1 for r in results if r["pass"])
    for r in results:
        print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "   >> " + r["detail"]))
    print(f"\n{npass}/{len(results)} passed")
    sys.exit(0 if npass == len(results) else 2)

if __name__ == "__main__":
    main()
