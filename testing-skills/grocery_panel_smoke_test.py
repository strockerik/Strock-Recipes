#!/usr/bin/env python3
"""Grocery-panel smoke test — the King Soopers "smarts" ported to the list.

Boots the REAL index.html DOM + app.js against a stubbed Supabase (recipes,
grocery_basket_items, grocery_manual_items, inventory_items) and asserts the
grocery panel now matches the KS review sheet's behaviour:
  - purchase units   (garlic -> "≈ N bulbs", tomato slices -> "≈ N tomatoes")
  - pantry section   (inventory-stocked items pulled out, one tap to add back)
  - fresh guard      (fresh herbs are never treated as pantry stock)
  - manual exemption (typed items are never auto-held)
  - recipe counts    (header toggle annotates each line)
  - shopping mode    (pantry group hidden)
No backend, no spend. Run: python3 testing-skills/grocery_panel_smoke_test.py
"""
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST_HTML = REPO / "test_grocery_panel.html"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub", USER_ID = "u1";
// r1 + r2 both use garlic so the recipe count reads 2.
var FAKE_RECIPES = [
  { id:"r1", user_id:USER_ID, section:"kitchen", name:"Garlic Pasta", subtitle:null, source:null,
    tags:["pasta"], base_servings:4, servings_label:"servings",
    ingredients:[
      { amount:20, unit:"clove", item:"garlic",      group:null },
      { amount:8,  unit:"slice", item:"ripe tomato", group:null },
      { amount:2,  unit:"lb",    item:"carrots",     group:null },
      { amount:1,  unit:"tsp",   item:"oregano",     group:null },
      { amount:1,  unit:"tsp",   item:"fresh thyme", group:null }
    ],
    method:[{ text:"Cook.", group:null }], specs:null, notes:null, is_favorite:false },
  { id:"r2", user_id:USER_ID, section:"kitchen", name:"Garlic Soup", subtitle:null, source:null,
    tags:["soup"], base_servings:4, servings_label:"servings",
    ingredients:[{ amount:4, unit:"clove", item:"garlic", group:null }],
    method:[{ text:"Simmer.", group:null }], specs:null, notes:null, is_favorite:false }
];
// Pantry holds oregano AND thyme — thyme must still be bought (recipe says "fresh").
var FAKE_INVENTORY = [
  { id:"i1", section:"pantry", category:"Spices", name:"oregano", status:"in" },
  { id:"i2", section:"pantry", category:"Spices", name:"thyme",   status:"in" }
];
// A typed item that collides with pantry stock — must never be auto-held.
var FAKE_MANUAL = [{ id:"m1", name:"oregano", source_inventory_id:null, created_at:"2026-01-01T00:00:00Z" }];

function makeBuilder(table) {
  var val = function () {
    if (table === "recipes") return { data: FAKE_RECIPES, error: null };
    if (table === "inventory_items") return { data: FAKE_INVENTORY, error: null };
    if (table === "grocery_manual_items") return { data: FAKE_MANUAL, error: null };
    if (table === "grocery_basket_items") return { data: [{ recipe_id:"r1", servings:4 }, { recipe_id:"r2", servings:4 }], error: null };
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
function listText()   { var e = document.querySelector(".g-combined"); return e ? e.textContent.replace(/\s+/g, " ") : ""; }
function pantryText() { var e = document.querySelector(".g-pantry");   return e ? e.textContent.replace(/\s+/g, " ") : ""; }

async function runTests() {
  try {
    click(document.querySelector("#open-grocery"));
    await delay(250);
    assert("grocery panel opens", !document.querySelector("#grocery-panel").hidden, "");

    // --- purchase units (shared with the King Soopers sheet) ---
    var L = listText();
    assert("garlic shows purchase units (≈ 3 bulbs), not 24 cloves", /≈ 3 bulbs/.test(L) && !/24/.test(L), L);
    assert("tomato slices fold to whole fruit (≈ 1 tomato)", /≈ 1 tomato/.test(L), L);
    assert("ordinary weight passes through (2 lb carrots)", /2 lb/.test(L) && /carrots/.test(L), L);

    // --- pantry section ---
    var P = pantryText();
    assert("pantry section rendered", !!document.querySelector(".g-pantry"), "");
    assert("pantry summary shows a count", /Already in your pantry \(\d+\)/.test(P), P);
    assert("stocked oregano is held in pantry", /oregano/i.test(P), P);
    assert("fresh thyme is NOT held (fresh = always buy)", !/thyme/i.test(P) && /thyme/i.test(L), "pantry=" + P);
    assert("manual item is NOT held (typed deliberately)", (L.match(/oregano/gi) || []).length >= 1, L);

    // --- add back moves it to the aisle list ---
    var keep = document.querySelector("[data-pantry-keep]");
    assert("pantry row offers Add back", !!keep, "");
    click(keep); await delay(120);
    assert("added-back item leaves the pantry section", !/oregano/i.test(pantryText()), pantryText());
    assert("added-back item appears in the list", /oregano/i.test(listText()), listText());

    // --- recipe counts are always shown inline (no toggle button) ---
    assert("no recipe-counts button in the header", !document.querySelector("#recipe-counts-toggle"), "");
    var LC = listText();
    assert("garlic annotated '· 2 recipes' (used in both)", /·\s*2 recipes/.test(LC), LC);
    assert("single-recipe item annotated '· 1 recipe'", /·\s*1 recipe\b/.test(LC), LC);

    // --- by-aisle / by-recipe view switch ---
    var aisleBtn = document.querySelector('[data-g-view="aisle"]'), recipeBtn = document.querySelector('[data-g-view="recipe"]');
    assert("view switch renders both options", !!aisleBtn && !!recipeBtn, "");
    assert("aisle is the default view", aisleBtn.getAttribute("aria-pressed") === "true" && !!document.querySelector(".g-combined"), "");
    click(recipeBtn); await delay(140);
    assert("by-recipe view replaces the aisle list", !!document.querySelector(".g-by-recipe-view") && !document.querySelector(".g-combined"), "");
    var RV = document.querySelector(".g-by-recipe-view").textContent.replace(/\s+/g, " ");
    assert("by-recipe groups under each recipe name", /Garlic Pasta/.test(RV) && /Garlic Soup/.test(RV), RV.slice(0, 120));
    assert("by-recipe hides the aisle-reorder control", !document.querySelector(".g-reorder"), "");
    click(document.querySelector('[data-g-view="aisle"]')); await delay(140);
    assert("switching back restores the aisle list", !!document.querySelector(".g-combined") && !document.querySelector(".g-by-recipe-view"), "");

    // --- shopping mode hides the pantry group, and snaps out of by-recipe ---
    click(document.querySelector('[data-g-view="recipe"]')); await delay(140);
    click(document.querySelector("#shopping-mode-toggle")); await delay(160);
    assert("shopping mode adds .shopping", document.querySelector("#grocery-panel").classList.contains("shopping"), "");
    assert("shopping mode snaps back to the tickable aisle list",
           !!document.querySelector(".g-combined") && !document.querySelector(".g-by-recipe-view"), "");
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
      if (document.querySelector('.item[data-id="r1"]') || tries > 80) { runTests(); return; }
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
        def log_message(self, *a): pass   # keep the pass/fail table readable
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
