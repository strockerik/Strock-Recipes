#!/usr/bin/env python3
"""
Reusable headless-Chrome smoke test for the AI recipe GENERATOR input UI.

Boots the REAL index.html DOM + app.js against a stubbed Supabase client
(fake signed-in user + fake bar inventory), then drives the generator through
real DOM clicks and asserts on the result. No backend, no spend.

Covers the "Clear all" + "From your bar" pick-row feature:
  1. bar mode shows in-stock spirits as pick chips (out-of-stock excluded)
  2. tapping a pick adds exactly that ingredient chip
  3. tapping the same pick again removes it (toggle)
  4. "Clear all" empties the ingredient list
  5. Clear-all + pick-row are hidden/absent in kitchen mode

Run from the repo root:  python3 <this> [--keep]
"""
import http.server, socketserver, threading, subprocess, sys, os, json, re, time, pathlib

# Locate the repo root (the dir with index.html + app.js) — works whether this
# is run from the repo root, from testing-skills/, or anywhere in between.
def _find_repo():
    for base in [pathlib.Path.cwd(), pathlib.Path(__file__).resolve().parent]:
        for d in [base, *base.parents]:
            if (d / "index.html").exists() and (d / "app.js").exists():
                return d
    sys.exit("could not locate repo root (needs index.html + app.js)")
REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST_HTML = REPO / "test_generator.html"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>
// ---- config.js stand-in (app.js reads these as globals) ----
var SUPABASE_URL = "http://localhost/stub";
var SUPABASE_ANON_KEY = "stub-anon-key";
var USER_ID = "test-user-0001";

// ---- fake bar inventory: rum + campari + gin in stock, vodka OUT ----
var FAKE_INVENTORY = [
  { id: "i1", section: "bar", category: "rum",   name: null,      status: "in"  },
  { id: "i2", section: "bar", category: "amaro", name: "Campari", status: "in"  },
  { id: "i3", section: "bar", category: "gin",   name: null,      status: "in"  },
  { id: "i4", section: "bar", category: "vodka", name: null,      status: "out" },
  // pantry: two foods in stock, a sauce (left out: seasonings are assumed) and an out item
  { id: "p1", section: "pantry", category: "Frozen", name: "chicken thighs", status: "in" },
  { id: "p2", section: "pantry", category: "Canned & Jarred", name: "black beans", status: "in" },
  { id: "p3", section: "pantry", category: "Condiments, Sauces & Spices", name: "soy sauce", status: "in" },
  { id: "p4", section: "pantry", category: "Dry Goods & Baking", name: "rice", status: "out" }
];
var INVOKES = [];

// ---- chainable, thenable Supabase query-builder stub ----
function makeBuilder(table) {
  var resolveVal = function () {
    if (table === "inventory_items") return { data: FAKE_INVENTORY, error: null };
    if (table === "profiles") return { data: { id: USER_ID, display_name: "Test User", diet_prefs: null, grocery_prefs: null }, error: null };
    return { data: [], error: null };
  };
  var proxy = new Proxy({}, {
    get: function (t, prop) {
      if (prop === "then") return function (onF, onR) { return Promise.resolve(resolveVal()).then(onF, onR); };
      if (prop === "catch") return function (onR) { return Promise.resolve(resolveVal()).catch(onR); };
      return function () { return proxy; };
    }
  });
  return proxy;
}
window.supabase = {
  createClient: function () {
    return {
      from: function (table) { return makeBuilder(table); },
      auth: {
        onAuthStateChange: function (cb) {
          setTimeout(function () { cb("INITIAL_SESSION", { user: { id: USER_ID } }); }, 0);
          return { data: { subscription: { unsubscribe: function () {} } } };
        },
        getUser: function () { return Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); },
        getSession: function () { return Promise.resolve({ data: { session: { user: { id: USER_ID } } }, error: null }); },
        signInWithPassword: function () { return Promise.resolve({ data: {}, error: null }); },
        signUp: function () { return Promise.resolve({ data: {}, error: null }); },
        signOut: function () { return Promise.resolve({ error: null }); },
        resetPasswordForEmail: function () { return Promise.resolve({ data: {}, error: null }); },
        updateUser: function () { return Promise.resolve({ data: {}, error: null }); }
      },
      functions: { invoke: function (name, opts) {
        INVOKES.push({ name: name, body: opts && opts.body });
        return Promise.resolve({ data: { concepts: [{ title: "Idea A", blurb: "a" }, { title: "Idea B", blurb: "b" }, { title: "Idea C", blurb: "c" }] }, error: null });
      } }
    };
  }
};
</script></head>
<body>
<pre id="smoke-results" style="display:none"></pre>
<script>
// ---- test runner: inject real index.html DOM, load real app.js, drive it ----
var RESULTS = [];
function assert(name, cond, detail) { RESULTS.push({ name: name, pass: !!cond, detail: detail || "" }); }
function finish() {
  document.getElementById("smoke-results").textContent = JSON.stringify(RESULTS);
  var passed = RESULTS.filter(function (r) { return r.pass; }).length;
  document.title = "TESTDONE " + passed + "/" + RESULTS.length;
}
function q(sel) { return document.querySelector(sel); }
function click(el) { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
function openBar() {
  var barTab = document.querySelector('.tab[data-section="cocktails"]'); if (barTab) click(barTab);
  var gen = q("#add-recipe-generate"); if (gen) click(gen);
}
function openKitchen() {
  var kTab = document.querySelector('.tab[data-section="recipes"]'); if (kTab) click(kTab);
  var gen = q("#add-recipe-generate"); if (gen) click(gen);
}
function picks() { return Array.prototype.slice.call(document.querySelectorAll('#gen-bar-picks-row [data-gen-barpick]')); }
function pickByText(txt) { return picks().filter(function (b) { return (b.getAttribute("data-gen-barpick") || "").toLowerCase() === txt.toLowerCase(); })[0]; }
function chipCount() { return document.querySelectorAll('#gen-ing-chips .gen-chip').length; }

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn) { for (var i = 0; i < 80 && !fn(); i++) await delay(25); return fn(); }
function lastBody() { return (INVOKES[INVOKES.length - 1] || {}).body || {}; }
async function runTests() {
  try {
    // (1) bar mode: pick row visible with the 3 in-stock spirits, vodka(out) excluded
    openBar();
    var labels = picks().map(function (b) { return b.getAttribute("data-gen-barpick"); });
    assert("bar pick-row visible", !q("#gen-bar-picks").hidden, "hidden=" + q("#gen-bar-picks").hidden);
    assert("3 in-stock spirits offered", labels.length === 3, "labels=" + JSON.stringify(labels));
    assert("includes Rum + Campari + Gin",
      labels.indexOf("Rum") >= 0 && labels.indexOf("Amaro (Campari)") >= 0 && labels.indexOf("Gin") >= 0,
      JSON.stringify(labels));
    assert("out-of-stock Vodka excluded", labels.indexOf("Vodka") < 0, JSON.stringify(labels));
    assert("no ingredients selected yet", chipCount() === 0, "chips=" + chipCount());
    assert("Clear-all hidden when empty", q("#gen-chips-head").hidden, "hidden=" + q("#gen-chips-head").hidden);

    // (2) tap Rum -> exactly one chip, pick highlighted, Clear-all shows
    click(pickByText("Rum"));
    assert("tap Rum adds one chip", chipCount() === 1, "chips=" + chipCount());
    assert("Rum pick highlighted", pickByText("Rum").classList.contains("is-on"), pickByText("Rum").className);
    assert("Clear-all now visible", !q("#gen-chips-head").hidden, "hidden=" + q("#gen-chips-head").hidden);

    // tap Campari -> two chips (select just rum + campari, the user's scenario)
    click(pickByText("Amaro (Campari)"));
    assert("tap Campari -> two chips", chipCount() === 2, "chips=" + chipCount());

    // (3) tap Rum again -> toggles off, back to one chip, pick de-highlighted
    click(pickByText("Rum"));
    assert("re-tap Rum removes it", chipCount() === 1, "chips=" + chipCount());
    assert("Rum pick de-highlighted", !pickByText("Rum").classList.contains("is-on"), pickByText("Rum").className);
    assert("Campari still highlighted", pickByText("Amaro (Campari)").classList.contains("is-on"), "");

    // (4) Clear all -> empty
    click(q("#gen-clear"));
    assert("Clear-all empties list", chipCount() === 0, "chips=" + chipCount());
    assert("Clear-all hides itself again", q("#gen-chips-head").hidden, "hidden=" + q("#gen-chips-head").hidden);
    assert("all picks de-highlighted after clear",
      picks().every(function (b) { return !b.classList.contains("is-on"); }), "");

    // (5) kitchen mode: pick row hidden (bar-only feature)
    openKitchen();
    assert("kitchen mode hides bar pick-row", q("#gen-bar-picks").hidden, "hidden=" + q("#gen-bar-picks").hidden);

    // (6) the start step: three choices; "Dinner from what I have" is one tap
    assert("Generate opens on the three choices", !q("#gen-start").hidden && q("#gen-custom").hidden && q("#gen-submit").hidden, "");
    assert("the kitchen asks what to make", q("#generate-title").textContent === "What should we make?", q("#generate-title").textContent);
    assert("the one-tap line says pantry, about 30 minutes, serves 4",
      /Your pantry · about 30 minutes · serves 4/.test(q("#gen-quick-sub").textContent), q("#gen-quick-sub").textContent);
    assert("the options start folded under Change", q("#gen-opts").hidden && q("#gen-change").getAttribute("aria-expanded") === "false", "");
    click(q("#gen-change"));
    assert("Change opens them (grocery run is the choice itself here)", !q("#gen-opts").hidden && q("#gen-opt-grocery").hidden, "");
    click(q('[data-gen-opt="cuisine"][data-val="italian"]'));
    assert("the summary follows the options", q("#gen-settings-summary").textContent === "Italian · any equipment", q("#gen-settings-summary").textContent);
    INVOKES = [];
    click(q("#gen-quick"));
    await until(function () { return INVOKES.length > 0 && !q("#generate-concepts").hidden; });
    var b = lastBody();
    assert("Dinner from what I have sends the pantry's food (no sauces, nothing out)",
      JSON.stringify(b.ingredients) === '["chicken thighs","black beans"]', JSON.stringify(b.ingredients));
    assert("…as a no-shopping, about-30-minute dinner for the household, honoring Change",
      b.mode === "concepts" && b.section === "kitchen" && b.chips.groceryRun === "none" && b.chips.time === "quick" && b.chips.servings === 4 && b.chips.cuisine === "italian",
      JSON.stringify(b.chips));
    assert("the ideas show", !q("#generate-concepts").hidden && document.querySelectorAll("#gen-concept-list .gen-concept").length === 3, "");
    INVOKES = [];
    click(q("#gen-concepts-reroll"));
    await until(function () { return INVOKES.length > 0; });
    assert("Different ideas asks the same pantry question again",
      JSON.stringify(lastBody().ingredients) === '["chicken thighs","black beans"]' && lastBody().chips.groceryRun === "none", JSON.stringify(lastBody()));
    await until(function () { return !q("#generate-concepts").hidden; });
    click(q("#gen-concepts-back"));
    assert("Start over goes back to the three choices", !q("#generate-form").hidden && !q("#gen-start").hidden, "");
    INVOKES = [];
    click(q("#gen-shop"));
    await until(function () { return INVOKES.length > 0; });
    assert("Something new — I'll shop allows a quick grocery run",
      lastBody().chips.groceryRun === "quick" && JSON.stringify(lastBody().ingredients) === '["chicken thighs","black beans"]', JSON.stringify(lastBody().chips));
    await until(function () { return !q("#generate-concepts").hidden; });
    click(q("#gen-concepts-back"));
    click(q("#gen-mind"));
    assert("I have something in mind opens the ingredient box",
      !q("#gen-custom").hidden && q("#gen-start").hidden && !q("#gen-submit").hidden && !q("#gen-opt-grocery").hidden, "");
    click(q("#gen-custom-back"));
    assert("Back returns to the choices", !q("#gen-start").hidden && q("#gen-custom").hidden, "");

    // (7) the bar's version
    openBar();
    assert("the bar asks what to mix", q("#generate-title").textContent === "What should we mix?" && q("#gen-quick-title").textContent === "A drink from my bar",
      q("#generate-title").textContent + " / " + q("#gen-quick-title").textContent);
    INVOKES = [];
    click(q("#gen-quick"));
    await until(function () { return INVOKES.length > 0; });
    var bb = lastBody();
    assert("A drink from my bar sends the bottles in stock, nothing to buy",
      JSON.stringify(bb.ingredients) === '["Rum","Amaro (Campari)","Gin"]' && bb.section === "bar" && bb.chips.groceryRun === "none" && bb.chips.time === undefined && bb.chips.servings === undefined,
      JSON.stringify(bb));
  } catch (e) {
    assert("no exception during test", false, String(e && e.stack || e));
  }
  finish();
}

// Boot: fetch real index.html, inject its <body> (scripts inert), load real app.js,
// wait for the stubbed sign-in + inventory load, then run the DOM-driven tests.
fetch("index.html").then(function (r) { return r.text(); }).then(function (txt) {
  var doc = new DOMParser().parseFromString(txt, "text/html");
  // move all body children (except scripts) into our document body
  var frag = document.createDocumentFragment();
  Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) {
    if (n.tagName === "SCRIPT") return;            // don't re-run index.html's scripts
    frag.appendChild(document.importNode(n, true));
  });
  document.body.appendChild(frag);
  var s = document.createElement("script");
  s.src = "app.js";
  s.onload = function () {
    // poll for readiness: inventory loaded => opening bar mode yields 3 picks
    var tries = 0;
    (function waitReady() {
      openBar();
      if (picks().length >= 1 || tries > 60) { runTests(); return; }
      tries++; setTimeout(waitReady, 50);
    })();
  };
  s.onerror = function () { assert("app.js loaded", false, "script load error"); finish(); };
  document.head.appendChild(s);
}).catch(function (e) { assert("harness boot", false, String(e)); finish(); });
</script>
</body></html>"""


def main():
    keep = "--keep" in sys.argv
    TEST_HTML.write_text(HTML)
    os.chdir(REPO)
    Handler = http.server.SimpleHTTPRequestHandler
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)  # ephemeral free port
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True); t.start()
    try:
        url = f"http://127.0.0.1:{port}/test_generator.html"
        out = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--virtual-time-budget=10000", "--dump-dom", url],
            capture_output=True, text=True, timeout=90).stdout
    finally:
        httpd.shutdown()
        if not keep and TEST_HTML.exists():
            TEST_HTML.unlink()
    m = re.search(r'<pre id="smoke-results"[^>]*>(.*?)</pre>', out, re.S)
    if not m or not m.group(1).strip():
        print("NO RESULTS — dump follows (first 2000 chars):\n", out[:2000]); sys.exit(1)
    results = json.loads(re.sub(r"&quot;", '"', m.group(1)).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    npass = sum(1 for r in results if r["pass"])
    for r in results:
        print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "   >> " + r["detail"]))
    print(f"\n{npass}/{len(results)} passed")
    sys.exit(0 if npass == len(results) else 2)


if __name__ == "__main__":
    main()
