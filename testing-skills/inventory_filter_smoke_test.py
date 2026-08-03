#!/usr/bin/env python3
"""Bar & Pantry "Only what's out" filter smoke test.

Boots the REAL index.html DOM + app.js against a stubbed Supabase with a mixed
in/out inventory across two categories and both sections, then asserts the
restock filter behaves:
  - shows a live count of out-of-stock items for the current section
  - narrows the list to just those items, hiding in-stock ones
  - force-expands a collapsed category (it would otherwise hide the very rows
    the filter exists to surface)
  - keeps each row's 🛒 restock affordance
  - carries across the Pantry/Bar tabs, and toggles back off
No backend, no spend. Run: python3 testing-skills/inventory_filter_smoke_test.py
"""
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST_HTML = REPO / "test_inventory_filter.html"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub", USER_ID = "u1";
var FAKE_INVENTORY = [
  { id:"i1", section:"pantry", category:"Spices",  name:"oregano",   status:"in"  },
  { id:"i2", section:"pantry", category:"Spices",  name:"thyme",     status:"in"  },
  { id:"i3", section:"pantry", category:"Spices",  name:"cumin",     status:"out" },
  { id:"i4", section:"pantry", category:"Produce", name:"lemons",    status:"out" },
  { id:"i5", section:"pantry", category:"Produce", name:"apples",    status:"in"  },
  { id:"i6", section:"bar",    category:"gin",     name:"Tanqueray", status:"out" }
];
function makeBuilder(table) {
  var val = function () {
    if (table === "inventory_items") return { data: FAKE_INVENTORY, error: null };
    if (table === "profiles") return { data: { id: USER_ID, display_name:"T", diet_prefs:null, grocery_prefs:null, kroger_prefs:null }, error: null };
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
    onAuthStateChange: function (cb) { setTimeout(function () { cb("INITIAL_SESSION", { user: { id: USER_ID, email: "t@t.co" } }); }, 0); return { data: { subscription: { unsubscribe: function () {} } } }; },
    getUser: function () { return Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); },
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: USER_ID, email: "t@t.co" } } }, error: null }); },
    signOut: function () { return Promise.resolve({ error: null }); }
  },
  rpc: function () { return Promise.resolve({ data: 0, error: null }); },
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
function click(el) { if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function names() { return [].slice.call(document.querySelectorAll(".inv-row-name")).map(function (e) { return e.textContent.trim(); }); }

async function runTests() {
  try {
    document.querySelector("#inventory-panel").hidden = false; await delay(120);
    var opener = document.querySelector("#open-inventory");
    if (opener) { click(opener); await delay(250); }

    var btn = document.querySelector("#inv-out-filter");
    assert("filter button present", !!btn, "");
    assert("filter shows the out count (2 in pantry)", /2/.test(btn.textContent), btn.textContent);
    assert("unfiltered list shows in + out (5 pantry items)", names().length === 5, names().join(","));

    // Collapse a category first — filtering must still reveal its out-of-stock row.
    click(document.querySelector('[data-inv-cat="Produce"]')); await delay(140);
    click(document.querySelector("#inv-out-filter")); await delay(180);

    assert("filter reads pressed", document.querySelector("#inv-out-filter").getAttribute("aria-pressed") === "true", "");
    var n = names();
    assert("only out items listed", n.length === 2, n.join(","));
    assert("out items are cumin + lemons", n.indexOf("cumin") >= 0 && n.indexOf("lemons") >= 0, n.join(","));
    assert("in-stock items hidden", n.indexOf("oregano") < 0 && n.indexOf("apples") < 0, n.join(","));
    assert("collapsed category force-expanded while filtering", !document.querySelector(".inv-group.is-collapsed"), "");
    assert("each filtered row keeps its restock button",
           document.querySelectorAll(".inv-row .inv-restock").length === 2,
           String(document.querySelectorAll(".inv-row .inv-restock").length));

    click(document.querySelector("#inv-tab-bar")); await delay(200);
    var bn = names();
    assert("filter carries to the Bar tab (1 out)", bn.length === 1 && /Tanqueray/.test(bn[0]), bn.join(","));

    click(document.querySelector("#inv-out-filter")); await delay(180);
    assert("toggling off reads unpressed",
           document.querySelector("#inv-out-filter").getAttribute("aria-pressed") === "false", "");
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
      if (document.querySelector("#inv-out-filter") || tries > 80) { runTests(); return; }
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
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    httpd = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        out = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--virtual-time-budget=15000", "--dump-dom",
             f"http://127.0.0.1:{port}/{TEST_HTML.name}"],
            capture_output=True, text=True, timeout=90).stdout
    finally:
        httpd.shutdown()
        if TEST_HTML.exists() and not keep: TEST_HTML.unlink()
    m = re.search(r'<pre id="smoke-results"[^>]*>(.*?)</pre>', out, re.S)
    if not m or not m.group(1).strip():
        print("NO RESULTS:\n", out[:1800]); sys.exit(1)
    raw = m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    res = json.loads(raw)
    for r in res:
        print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "  >> " + r["detail"]))
    print(f"\n{sum(1 for r in res if r['pass'])}/{len(res)} passed")
    sys.exit(0 if all(r["pass"] for r in res) else 2)

if __name__ == "__main__":
    main()
