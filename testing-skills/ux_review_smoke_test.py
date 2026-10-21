#!/usr/bin/env python3
"""UX-review fixes smoke test — the behaviours the 2026-10-20 review changed.

Boots the REAL index.html DOM + app.js against a stubbed Supabase and asserts
the fixes hold. The recipes query FAILS on its first call and succeeds on the
second, so the failed-load state and its Try again button are covered too.

Covers:
  - load states      (failed load is NOT "no recipes yet"; retry recovers)
  - filter sheet     (scope moved in behind 🏷; active scope surfaces as a chip)
  - row patching     (star / cart / plan toggles don't rebuild the whole list)
  - staging wording  ("Stage for plan", badge counts the tray, tab appears)
  - sheets           (focus moves in, page locks, Escape closes only the top one)
  - cook mode        (last-step tap is inert; Done ✓ lands on a done screen)
  - undo             (deleting a recipe offers it back)
  - persistence      (unit system survives a reload)

NOTE: harnesses run UNSTYLED — no assertions here depend on CSS. Layout and
geometry live in viewport_smoke_test.py.
No backend, no spend. Run: python3 testing-skills/ux_review_smoke_test.py
"""
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST_HTML = REPO / "test_ux_review.html"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub", USER_ID = "u1";
var FAKE_RECIPES = [
  { id:"r1", user_id:USER_ID, section:"kitchen", name:"Three Step Stew", subtitle:"slow", source:null,
    tags:["soup"], base_servings:4, servings_label:"servings",
    ingredients:[{ amount:2, unit:"cup", item:"stock", group:null },
                 { amount:1, unit:"lb",  item:"beef",  group:null }],
    method:[{ text:"Brown the beef.", group:null },
            { text:"Add the stock.",  group:null },
            { text:"Simmer gently.",  group:null }],
    specs:null, notes:null, is_favorite:false, created_at:"2026-01-01T00:00:00Z" },
  { id:"r2", user_id:USER_ID, section:"kitchen", name:"Quick Salad", subtitle:null, source:null,
    tags:["salad"], base_servings:2, servings_label:"servings",
    ingredients:[{ amount:1, unit:null, item:"lettuce", group:null }],
    method:[{ text:"Toss.", group:null }],
    specs:null, notes:null, is_favorite:false, created_at:"2026-02-01T00:00:00Z" }
];

// First read of `recipes` fails; every later one succeeds. That's the whole
// point of finding #02 — a dropped connection must not read as an empty book.
var recipesReads = 0;
var INSERTS = [];                   // {table, row} per .insert() call
function makeBuilder(table) {
  var single = false;                 // set when .single()/.maybeSingle() is chained
  var val = function () {
    if (table === "recipes") {
      recipesReads++;
      if (recipesReads === 1) return { data: null, error: { message: "TypeError: Failed to fetch" } };
      return { data: FAKE_RECIPES, error: null };
    }
    if (table === "profiles") {
      // A list select returns rows; .single() returns one. Returning the object
      // for both makes loadProfiles' forEach throw, which is a stub bug, not an
      // app bug.
      return single
        ? { data: { id: USER_ID, display_name:"T", diet_prefs:null, grocery_prefs:null, kroger_prefs:null }, error: null }
        : { data: [{ id: USER_ID, display_name: "T" }], error: null };
    }
    return { data: [], error: null };
  };
  var p = new Proxy({}, { get: function (t, k) {
    if (k === "then") return function (f, r) { return Promise.resolve(val()).then(f, r); };
    if (k === "catch") return function (r) { return Promise.resolve(val()).catch(r); };
    return function () {
      if (k === "insert") INSERTS.push({ table: table, row: arguments[0] });
      if (k === "single" || k === "maybeSingle") single = true;
      return p;
    };
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
var JS_ERRORS = [];
window.addEventListener("error", function (e) { JS_ERRORS.push(String(e.message)); });
window.addEventListener("unhandledrejection", function (e) { JS_ERRORS.push("rejection: " + String(e.reason && e.reason.message || e.reason)); });
function assert(n, c, d) { RESULTS.push({ name: n, pass: !!c, detail: String(d == null ? "" : d) }); }
function finish() { document.getElementById("smoke-results").textContent = JSON.stringify(RESULTS);
  document.title = "TESTDONE " + RESULTS.filter(function (r) { return r.pass; }).length + "/" + RESULTS.length; }
function click(el) { if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
function key(k) { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function $(s) { return document.querySelector(s); }
function row(id) { return document.querySelector('.item[data-id="' + id + '"]'); }
function txt(el) { return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; }
async function until(fn, ms) {
  var waited = 0;
  while (!fn() && waited < (ms || 4000)) { await delay(50); waited += 50; }
  return fn();
}

async function runTests() {
  try {
    // ---------- 1. a failed load is not an empty book ----------
    var empty = $("#empty-state");
    assert("failed load shows an error state, not the first-run invitation",
      !empty.hidden && empty.classList.contains("is-error") && !/No recipes yet/i.test(txt(empty)), txt(empty));
    assert("failed load says the recipes are safe", /safe/i.test(txt(empty)), txt(empty));
    assert("failed load offers Try again", !!$("#empty-retry"), "");
    assert("failed load renders no skeleton rows", !$(".list-skeleton"), "");

    click($("#empty-retry"));
    await until(function () { return !!row("r1") && !!row("r2"); });
    assert("Try again recovers the list", !!row("r1") && !!row("r2"),
      "rows=" + document.querySelectorAll(".item").length
      + " count=" + txt($("#result-count"))
      + " empty=" + $("#empty-state").hidden + "/" + txt($("#empty-state")).slice(0, 60)
      + " errs=" + JS_ERRORS.join(";").slice(0, 200));
    assert("error state cleared after a successful retry",
      !$("#empty-state").classList.contains("is-error"), "");

    // ---------- 2. the Meal plan tab only shows when there's a plan ----------
    assert("mode tabs hidden with nothing planned or staged", $(".mode-tabs").hidden, "");

    // ---------- 3. scope lives in the filter sheet now ----------
    assert("the permanent scope row is gone", !$(".scope-bar"), "");
    assert("filter sheet starts closed", $("#tag-filters").hidden, "");
    click($("#toggle-filters"));
    await delay(80);
    var sheet = $("#tag-filters");
    assert("🏷 opens the filter sheet", !sheet.hidden, "");
    assert("scope buttons are inside the filter sheet",
      sheet.contains($("#scope-all")) && sheet.contains($("#toggle-favorites")) && sheet.contains($("#toggle-shared")), "");
    assert("tag cloud renders inside the sheet", !!$("#filter-tag-cloud .tag-chip"), "");
    assert("All uses aria-pressed, not aria-selected",
      $("#scope-all").getAttribute("aria-pressed") === "true" && !$("#scope-all").hasAttribute("aria-selected"), "");

    click($("#toggle-favorites"));
    await delay(120);
    var af = $("#active-filters");
    assert("active scope surfaces as a chip outside the sheet",
      !af.hidden && !!af.querySelector("[data-scope-off]"), txt(af));
    assert("the 🏷 button marks that something is filtering",
      $("#toggle-filters").classList.contains("has-filters"), "");
    click(af.querySelector("[data-scope-off]"));
    await delay(120);
    assert("dismissing the chip resets the scope to All",
      $("#active-filters").hidden && $("#scope-all").getAttribute("aria-pressed") === "true", "");
    click($("#toggle-filters")); await delay(60);

    // ---------- 4. toggles patch their row, they don't rebuild the list ----------
    row("r2").dataset.sentinel = "kept";
    var star = row("r1").querySelector(".star-btn");
    click(star);
    await delay(120);
    assert("starring repaints only its own row",
      row("r2").dataset.sentinel === "kept", "r2 was rebuilt");
    assert("the star reflects its new state",
      row("r1").querySelector(".star-btn").getAttribute("aria-pressed") === "true", "");

    var pick = row("r1").querySelector(".pick");
    pick.focus();
    click(pick);                       // the click itself ticks the box
    await until(function () { return row("r1").classList.contains("has-serv"); });
    assert("ticking the cart adds the servings stepper",
      row("r1").classList.contains("has-serv") && !!row("r1").querySelector(".serv-control"), "");
    assert("ticking the cart leaves the other rows alone",
      row("r2").dataset.sentinel === "kept", "r2 was rebuilt");
    assert("focus stays on the control you just used",
      document.activeElement === row("r1").querySelector(".pick"),
      document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : "none");

    // ---------- 5. the grocery bar and the header count ----------
    assert("grocery bar is up", !$("#grocery-bar").hidden, "");
    assert("body is flagged so the ＋ button can clear the bar",
      document.body.classList.contains("has-grocery-bar"), "");
    assert("header cart carries the count",
      !$("#grocery-top-count").hidden && txt($("#grocery-top-count")) === "1", txt($("#grocery-top-count")));
    assert("header cart's label includes the count",
      /1 added/.test($("#open-grocery-top").getAttribute("aria-label")), $("#open-grocery-top").getAttribute("aria-label"));

    // ---------- 6. staging says staging ----------
    click(row("r1").querySelector(".item-head"));
    await delay(140);
    var planBtn = row("r1").querySelector(".add-to-plan-btn");
    assert("the detail button says Stage, not In meal plan",
      /Stage for plan/.test(txt(planBtn)) && !/In meal plan/.test(txt(planBtn)), txt(planBtn));
    click(planBtn);
    await delay(160);
    planBtn = row("r1").querySelector(".add-to-plan-btn");
    assert("staged state reads as staged", /Staged for plan/.test(txt(planBtn)), txt(planBtn));
    assert("the row's calendar box agrees", row("r1").querySelector(".plan-pick").checked, "");
    assert("the badge counts what's staged",
      !$("#mealplan-count").hidden && txt($("#mealplan-count")) === "1", txt($("#mealplan-count")));
    assert("the Meal plan tab comes back once something is staged", !$(".mode-tabs").hidden, "");

    // ---------- 7. the unit choice is remembered ----------
    var metric = row("r1").querySelector('.unit-toggle-btn[data-unit="metric"]');
    click(metric);
    await delay(140);
    assert("metric is remembered for next launch",
      localStorage.getItem("hi:u1:unitSystem") === '"metric"', localStorage.getItem("hi:u1:unitSystem"));

    // ---------- 8. sheets take focus, lock the page, and answer Escape ----------
    click($("#open-inventory"));
    await delay(140);
    assert("the inventory sheet opens", !$("#inventory-panel").hidden, "");
    assert("the page behind a sheet is locked",
      document.body.style.overflow === "hidden", document.body.style.overflow);
    assert("focus moves into the sheet",
      $("#inventory-panel").contains(document.activeElement),
      document.activeElement ? (document.activeElement.id || document.activeElement.className) : "none");
    key("Escape");
    await delay(120);
    assert("Escape closes the sheet", $("#inventory-panel").hidden, "");
    assert("the page unlocks again", document.body.style.overflow === "", document.body.style.overflow);

    // Stacked sheets: Escape takes the top one only.
    click($("#open-grocery-top")); await delay(140);
    $("#kroger-panel").hidden = false; await delay(100);
    key("Escape"); await delay(120);
    assert("Escape closes the top sheet only",
      $("#kroger-panel").hidden && !$("#grocery-panel").hidden,
      "kroger=" + $("#kroger-panel").hidden + " grocery=" + $("#grocery-panel").hidden);
    assert("the page stays locked while a sheet is still open",
      document.body.style.overflow === "hidden", document.body.style.overflow);
    key("Escape"); await delay(120);
    assert("Escape then closes the one underneath", $("#grocery-panel").hidden, "");

    // Pair-a-drink was missing from the old Escape handler entirely.
    $("#pair-panel").hidden = false; await delay(100);
    key("Escape"); await delay(120);
    assert("Escape now closes the Pair a drink sheet", $("#pair-panel").hidden, "");

    // ---------- 9. cook mode's last step is no longer a trapdoor ----------
    click(row("r1").querySelector(".cook-btn"));
    await delay(180);
    assert("cook mode opens", !$("#cook-panel").hidden, "");
    click($("#cook-next")); await delay(90);
    click($("#cook-next")); await delay(90);
    assert("on the last step the button offers Done", /Done/.test(txt($("#cook-next"))), txt($("#cook-next")));
    click($("#cook-body"));
    await delay(120);
    assert("tapping the last step does NOT exit cook mode",
      !$("#cook-panel").hidden && $("#cook-done").hidden, "");
    assert("tapping the last step leaves you on it",
      /Step 3 of 3/.test(txt($("#cook-step-num"))), txt($("#cook-step-num")));
    click($("#cook-next"));
    await delay(140);
    assert("Done ✓ lands on a finish screen",
      !$("#cook-done").hidden && $("#cook-panel").classList.contains("is-done"), "");
    assert("the finish screen names the recipe", /Three Step Stew/.test(txt($("#cook-done-sub"))), txt($("#cook-done-sub")));
    click($("#cook-done-back"));
    await delay(120);
    assert("← Last step goes back to the final step",
      $("#cook-done").hidden && /Step 3 of 3/.test(txt($("#cook-step-num"))), txt($("#cook-step-num")));
    click($("#cook-next")); await delay(120);
    click($("#cook-done-close"));
    await delay(140);
    assert("Done cooking leaves cook mode", $("#cook-panel").hidden, "");
    assert("leaving cook mode unlocks the page", document.body.style.overflow === "", document.body.style.overflow);

    // ---------- 10. the review form doesn't throw work away ----------
    window.confirm = function () { return false; };     // "no, don't discard"
    $("#recipe-form-panel").hidden = false;
    await delay(120);
    $("#rf-name").value = "Half typed";
    $("#rf-name").dispatchEvent(new Event("input", { bubbles: true }));
    await delay(60);
    click($("#recipe-form-panel"));                      // tap the dim backdrop
    await delay(120);
    assert("a stray backdrop tap can't discard a half-typed recipe",
      !$("#recipe-form-panel").hidden, "form closed anyway");
    key("Escape");
    await delay(120);
    assert("Escape can't discard it either", !$("#recipe-form-panel").hidden, "form closed anyway");
    window.confirm = function () { return true; };       // "yes, discard"
    click($("#recipe-form-panel"));
    await delay(120);
    assert("confirming does close it", $("#recipe-form-panel").hidden, "");

    // The explicit Close button never asks — it's already an explicit choice.
    var asked = 0;
    window.confirm = function () { asked++; return true; };
    $("#recipe-form-panel").hidden = false; await delay(100);
    $("#rf-name").value = "Another"; $("#rf-name").dispatchEvent(new Event("input", { bubbles: true }));
    await delay(50);
    click($("#close-recipe-form"));
    await delay(120);
    assert("the Close button closes without a prompt",
      $("#recipe-form-panel").hidden && asked === 0, "asked=" + asked);

    // ---------- 11. deleting offers it back ----------
    window.confirm = function () { return true; };
    $("#recipe-form-panel").hidden = false; await delay(80);
    $("#rf-id").value = "r2";
    click($("#delete-recipe"));
    await until(function () { var t = $(".toast-action"); return t && t.classList.contains("show"); });
    var undo = $(".toast-action");
    assert("deleting a recipe offers an Undo",
      !!undo && undo.classList.contains("show") && /Undo/.test(txt(undo.querySelector(".toast-action-btn"))), txt(undo));
    assert("the Undo toast names the recipe", /Quick Salad/.test(txt(undo)), txt(undo));

    // The restore has to be a valid insert. toBackupRow is an *export* shape and
    // carries no user_id; copyToMyBook adds it, and so must this.
    INSERTS.length = 0;
    click(undo.querySelector(".toast-action-btn"));
    await until(function () { return INSERTS.some(function (i) { return i.table === "recipes"; }); });
    var restore = INSERTS.filter(function (i) { return i.table === "recipes"; }).pop();
    assert("Undo re-inserts the recipe", !!restore, "no insert issued");
    assert("the restored row carries user_id (an insert fails without it)",
      !!restore && restore.row && restore.row.user_id === USER_ID,
      restore ? JSON.stringify(Object.keys(restore.row)) : "");
    assert("the restored row keeps its name and ingredients",
      !!restore && restore.row.name === "Quick Salad" && Array.isArray(restore.row.ingredients),
      restore ? String(restore.row.name) : "");
    assert("the restored row keeps created_at, so Newest order doesn't change",
      !!restore && restore.row.created_at === "2026-02-01T00:00:00Z",
      restore ? String(restore.row.created_at) : "");

    // ---------- 12. the toast is announced ----------
    assert("toasts are a live region now",
      !!document.querySelector('.toast[role="status"]') || !!document.querySelector('.toast-action[role="status"]'), "");
  } catch (e) {
    assert("no exception", false, String(e && e.stack || e));
  }
  assert("no uncaught JS errors", JS_ERRORS.length === 0, JS_ERRORS.join(" | ").slice(0, 400));
  finish();
}

fetch("index.html").then(function (r) { return r.text(); }).then(function (t) {
  var doc = new DOMParser().parseFromString(t, "text/html");
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
      if (document.querySelector("#empty-retry") || document.querySelector('.item[data-id="r1"]') || tries > 80) { runTests(); return; }
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
             "--virtual-time-budget=30000", "--dump-dom",
             f"http://127.0.0.1:{port}/{TEST_HTML.name}"],
            capture_output=True, text=True, timeout=120).stdout
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
