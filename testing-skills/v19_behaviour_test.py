#!/usr/bin/env python3
"""v1.9 behaviour test — the data-safety and correctness changes (no backend, no spend).

Boots the REAL index.html DOM + app.js against an in-memory Supabase that keeps
table state and logs every call, then checks:
  - sign-in screen      (opens on sign-in; signup_flow_test.py covers New Here)
  - names               (from my_people(), not a read of every profile)
  - plan → grocery list (ADDS: other recipes, typed items, check-offs stay; the
                         larger serving count wins, so pressing twice never doubles;
                         Undo puts the list back; days marked listed, then unmarked)
  - clear the list      (no prompt; Undo restores every row)
  - delete a recipe     (no prompt; Undo restores it under its own id with its
                         shares, planned meals and grocery entry)
  - cook mode           (follows the Original | US | Metric toggle)
  - coach history       (kept per account; the old account-less keys are dropped)
  - remove a shared recipe (says so when nothing was removed, v2.3.1; works when it was)
NOTE: runs UNSTYLED — no layout assertions (those live in viewport_smoke_test.py).
Run: python3 testing-skills/v19_behaviour_test.py
"""
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST_HTML = REPO / "test_v19_behaviour.html"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub", USER_ID = "u1";
function dayIso(n) { var d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
// An account-less coach thread from before 1.9: the first sweep drops it.
localStorage.setItem("coach:v1:r9", JSON.stringify({ troubleshoot: { messages: [], updatedAt: Date.now() } }));
var DB = {
  recipes: [
    { id:"r1", user_id:"u1", section:"kitchen", name:"Three Step Stew", subtitle:"slow", source:null, tags:["soup"],
      base_servings:4, servings_label:"servings",
      ingredients:[{ amount:2, unit:"cup", item:"stock", group:null }, { amount:1, unit:"lb", item:"beef", group:null }],
      method:[{ text:"Brown the beef.", group:null }, { text:"Add the stock.", group:null }],
      specs:null, notes:null, is_favorite:false, created_at:"2026-01-01T00:00:00Z" },
    { id:"r2", user_id:"u1", section:"kitchen", name:"Quick Salad", subtitle:null, source:null, tags:["salad"],
      base_servings:2, servings_label:"servings",
      ingredients:[{ amount:1, unit:null, item:"lettuce", group:null }],
      method:[{ text:"Toss the lettuce.", group:null }],
      specs:null, notes:null, is_favorite:false, created_at:"2026-02-01T00:00:00Z" },
    { id:"r3", user_id:"u2", section:"kitchen", name:"Pat's Chili", subtitle:null, source:null, tags:[],
      base_servings:4, servings_label:"servings", ingredients:[{ amount:1, unit:"lb", item:"beans", group:null }],
      method:[{ text:"Simmer.", group:null }], specs:null, notes:null, is_favorite:false, created_at:"2026-03-01T00:00:00Z" }
  ],
  recipe_shares: [{ recipe_id:"r1", shared_with_user_id:"u3", shared_by_user_id:"u1", created_at:"2026-04-01T00:00:00Z" }],
  meal_plan_entries: [
    { id:"e1", user_id:"u1", recipe_id:"r1", plan_date:dayIso(0), slot:"dinner", servings:4, purchased_at:null },
    { id:"e2", user_id:"u1", recipe_id:"r1", plan_date:dayIso(1), slot:"dinner", servings:4, purchased_at:null },
    { id:"e3", user_id:"u1", recipe_id:"r2", plan_date:dayIso(2), slot:"dinner", servings:2, purchased_at:null }
  ],
  grocery_basket_items: [{ user_id:"u1", recipe_id:"r1", servings:2, created_at:"2026-05-01T00:00:00Z" }],
  grocery_manual_items: [{ id:"m1", user_id:"u1", name:"paper towels", source_inventory_id:null, created_at:"2026-05-01T00:00:00Z" }],
  grocery_checked_items: [{ user_id:"u1", item_key:"m1" }],
  inventory_items: [],
  profiles: [{ id:"u1", display_name:"T", diet_prefs:null, grocery_prefs:null, kroger_prefs:null }]
};
var CALLS = [];                       // { table, op, rows, filters, single }
var RPCS = [];
var KEYS = { grocery_basket_items: ["user_id","recipe_id"], grocery_checked_items: ["user_id","item_key"], recipe_shares: ["recipe_id","shared_with_user_id"] };
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function makeBuilder(table) {
  var st = { op: "select", rows: null, patch: null, filters: [], single: false, opts: {} };
  function match(r) { return st.filters.every(function (f) { return f[0] === "eq" ? r[f[1]] === f[2] : f[2].indexOf(r[f[1]]) >= 0; }); }
  function exec() {
    var rows = DB[table] || (DB[table] = []);
    CALLS.push({ table: table, op: st.op, rows: clone(st.rows), patch: clone(st.patch), filters: clone(st.filters), single: st.single });
    if (st.op === "insert" || st.op === "upsert") {
      var list = Array.isArray(st.rows) ? st.rows : [st.rows];
      var keys = KEYS[table] || ["id"];
      list.forEach(function (r0) {
        var r = Object.assign({ user_id: "u1" }, r0);
        if (!r.id && keys[0] === "id") r.id = table + "-" + Math.random().toString(36).slice(2, 7);
        var i = rows.findIndex(function (x) { return keys.every(function (k) { return x[k] === r[k]; }); });
        if (i >= 0) rows[i] = Object.assign(rows[i], r); else rows.push(r);
      });
      return { data: st.single ? list[0] : list, error: null };
    }
    if (st.op === "delete") {
      var gone = rows.filter(match);
      DB[table] = rows.filter(function (r) { return !match(r); });
      if (table === "recipes") gone.forEach(function (g) {     // on delete cascade
        ["recipe_shares", "meal_plan_entries", "grocery_basket_items"].forEach(function (t) {
          DB[t] = DB[t].filter(function (x) { return x.recipe_id !== g.id; });
        });
      });
      return { data: clone(gone), error: null };          // .delete().select() returns what went
    }
    if (st.op === "update") { rows.filter(match).forEach(function (r) { Object.assign(r, st.patch); }); return { data: null, error: null }; }
    var hits = clone(rows.filter(match));
    if (table === "recipes" && !st.single) hits = clone(rows);         // RLS: own + shared-with-me
    return { data: st.single ? (hits[0] || null) : hits, error: null };
  }
  var p = new Proxy({}, { get: function (t, k) {
    if (k === "then") return function (f, r) { return Promise.resolve(exec()).then(f, r); };
    if (k === "catch") return function (r) { return Promise.resolve(exec()).catch(r); };
    return function () {
      var a = arguments;
      if (k === "insert" || k === "upsert") { st.op = k; st.rows = a[0]; st.opts = a[1] || {}; }
      else if (k === "delete") st.op = "delete";
      else if (k === "update") { st.op = "update"; st.patch = a[0]; }
      else if (k === "eq") st.filters.push(["eq", a[0], a[1]]);
      else if (k === "in") st.filters.push(["in", a[0], a[1]]);
      else if (k === "single" || k === "maybeSingle") st.single = true;
      return p;
    };
  }});
  return p;
}
window.supabase = { createClient: function () { return {
  from: function (tbl) { return makeBuilder(tbl); },
  rpc: function (fn, args) {
    RPCS.push({ fn: fn, args: args });
    if (fn === "my_people") return Promise.resolve({ data: [{ id:"u1", display_name:"T" }, { id:"u2", display_name:"Pat" }, { id:"u3", display_name:"Sam" }], error: null });
    return Promise.resolve({ data: 0, error: null });
  },
  auth: {
    onAuthStateChange: function (cb) { setTimeout(function () { cb("INITIAL_SESSION", { user: { id: USER_ID, email: "t@t.co" } }); }, 0); return { data: { subscription: { unsubscribe: function () {} } } }; },
    getUser: function () { return Promise.resolve({ data: { user: { id: USER_ID } }, error: null }); },
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: USER_ID, email: "t@t.co" } } }, error: null }); },
    signOut: function () { return Promise.resolve({ error: null }); }
  },
  functions: { invoke: function (name) {
    if (name === "recipe-coach") return Promise.resolve({ data: { result: { reply: "Use less dressing.", needs_more_info: false, suggestions: [], revised_recipe: null } }, error: null });
    return Promise.resolve({ data: {}, error: null });
  } }
}; } };
</script></head>
<body>
<pre id="smoke-results" style="display:none"></pre>
<script>
var RESULTS = [], JS_ERRORS = [], ASKED = 0;
window.confirm = function () { ASKED++; return true; };
window.addEventListener("error", function (e) { JS_ERRORS.push(String(e.message)); });
window.addEventListener("unhandledrejection", function (e) { JS_ERRORS.push("rejection: " + String(e.reason && e.reason.message || e.reason)); });
function assert(n, c, d) { RESULTS.push({ name: n, pass: !!c, detail: String(d == null ? "" : d) }); }
function finish() { document.getElementById("smoke-results").textContent = JSON.stringify(RESULTS);
  document.title = "TESTDONE " + RESULTS.filter(function (r) { return r.pass; }).length + "/" + RESULTS.length; }
function click(el) { if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function $(s) { return document.querySelector(s); }
function txt(el) { return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; }
async function until(fn, ms) { var w = 0; while (!fn() && w < (ms || 4000)) { await delay(50); w += 50; } return fn(); }
function undoToast(re) { var t = $(".toast-action"); return t && t.classList.contains("show") && (!re || re.test(txt(t))) ? t : null; }
async function pressUndo(re) {
  var t = await until(function () { return undoToast(re); }); click(t && t.querySelector(".toast-action-btn")); await delay(250); return t;
}
function basketRow(id) { return DB.grocery_basket_items.filter(function (r) { return r.recipe_id === id; })[0]; }
function calls(table, op) { return CALLS.filter(function (c) { return c.table === table && c.op === op; }); }
async function toPlan() { click($("#mode-mealplan")); await until(function () { return !!$("#mp-make-grocery"); }); await delay(100); }

async function runTests() {
  try {
    // ---------- sign-in screen ----------
    assert("the sign-in screen offers New Here", txt($("#auth-new")) === "New Here", txt($("#auth-new")));
    assert("…and opens on sign-in", txt($("#auth-submit")) === "Sign in" && $("#auth-name").hidden, txt($("#auth-submit")));
    assert("the sign-in password has no 8-character minimum", !$("#auth-password").hasAttribute("minlength"), "");

    // ---------- names ----------
    assert("names come from my_people()", RPCS.some(function (r) { return r.fn === "my_people"; }), JSON.stringify(RPCS));
    assert("…not from a read of every profile", !CALLS.some(function (c) { return c.table === "profiles" && c.op === "select" && !c.single; }), "");
    click($("#toggle-shared"));
    await until(function () { return !!document.querySelector('.item[data-id="r3"]'); });
    assert("a shared recipe names its owner", /Shared by Pat/.test(txt(document.querySelector('.item[data-id="r3"]'))), txt(document.querySelector('.item[data-id="r3"]')));
    click($("#toggle-shared"));
    await until(function () { return !!document.querySelector('.item[data-id="r1"]'); });

    // ---------- the plan goes onto the grocery list ----------
    await toPlan();
    var delsBefore = calls("grocery_basket_items", "delete").length + calls("grocery_checked_items", "delete").length;
    click($("#mp-make-grocery"));
    await until(function () { return undoToast(/from the plan/); });
    assert("adding the plan writes one upsert with the planned servings",
      calls("grocery_basket_items", "upsert").length === 1 &&
      JSON.stringify(calls("grocery_basket_items", "upsert")[0].rows) === JSON.stringify([{ recipe_id:"r1", servings:8 }, { recipe_id:"r2", servings:2 }]),
      JSON.stringify(calls("grocery_basket_items", "upsert").map(function (c) { return c.rows; })));
    assert("…and deletes nothing (the old version wiped the list)",
      calls("grocery_basket_items", "delete").length + calls("grocery_checked_items", "delete").length === delsBefore, "");
    assert("typed items and check-offs stay", DB.grocery_manual_items.length === 1 && DB.grocery_checked_items.length === 1, JSON.stringify([DB.grocery_manual_items, DB.grocery_checked_items]));
    assert("the toast says what changed", /Added 1 recipe, raised servings on 1 from the plan/.test(txt(undoToast())), txt(undoToast()));
    assert("the planned days are marked listed", DB.meal_plan_entries.every(function (e) { return !!e.purchased_at; }), JSON.stringify(DB.meal_plan_entries));
    await pressUndo(/from the plan/);
    await until(function () { return !basketRow("r2"); });
    assert("Undo removes the recipe it added", !basketRow("r2"), JSON.stringify(DB.grocery_basket_items));
    assert("…and puts the raised serving count back", basketRow("r1") && basketRow("r1").servings === 2, JSON.stringify(basketRow("r1")));
    assert("…and unmarks the days", DB.meal_plan_entries.every(function (e) { return !e.purchased_at; }), JSON.stringify(DB.meal_plan_entries));
    await toPlan(); click($("#mp-make-grocery")); await until(function () { return undoToast(/from the plan/); });
    await delay(150); await toPlan(); click($("#mp-make-grocery")); await delay(300);
    assert("pressing it twice never doubles", basketRow("r1").servings === 8 && basketRow("r2").servings === 2, JSON.stringify(DB.grocery_basket_items));
    assert("…the second press says it's already there", /already on your grocery list/i.test(txt($(".toast"))), txt($(".toast")));

    // ---------- clearing the list ----------
    ASKED = 0;
    click($("#clear-grocery"));
    await until(function () { return undoToast(/cleared/); });
    assert("clearing asks nothing first", ASKED === 0, "asked=" + ASKED);
    assert("…and empties the list", DB.grocery_basket_items.length === 0 && DB.grocery_manual_items.length === 0 && DB.grocery_checked_items.length === 0, JSON.stringify(DB.grocery_basket_items));
    await pressUndo(/cleared/);
    await until(function () { return DB.grocery_manual_items.length === 1; });
    assert("Undo puts back every recipe, typed item and check-off",
      DB.grocery_basket_items.length === 2 && DB.grocery_manual_items[0].id === "m1" && DB.grocery_checked_items[0].item_key === "m1",
      JSON.stringify([DB.grocery_basket_items, DB.grocery_manual_items, DB.grocery_checked_items]));

    // ---------- deleting a recipe ----------
    ASKED = 0;
    $("#recipe-form-panel").hidden = false; await delay(60);
    $("#rf-id").value = "r1";
    click($("#delete-recipe"));
    await until(function () { return undoToast(/deleted/); });
    assert("deleting asks nothing first (Undo is complete now)", ASKED === 0, "asked=" + ASKED);
    assert("the recipe and what cascades with it are gone",
      !DB.recipes.some(function (r) { return r.id === "r1"; }) && !DB.recipe_shares.length && !DB.meal_plan_entries.some(function (e) { return e.recipe_id === "r1"; }) && !basketRow("r1"), "");
    await pressUndo(/deleted/);
    await until(function () { return DB.recipes.some(function (r) { return r.id === "r1"; }); });
    await delay(200);
    var back = DB.recipes.filter(function (r) { return r.id === "r1"; })[0];
    assert("Undo restores the recipe under its own id", !!back && back.name === "Three Step Stew" && back.created_at === "2026-01-01T00:00:00Z", JSON.stringify(back));
    assert("…with who it was shared with", DB.recipe_shares.length === 1 && DB.recipe_shares[0].shared_with_user_id === "u3", JSON.stringify(DB.recipe_shares));
    assert("…its planned meals", ["e1", "e2"].every(function (id) { return DB.meal_plan_entries.some(function (e) { return e.id === id; }); }), JSON.stringify(DB.meal_plan_entries));
    assert("…and its grocery-list entry", !!basketRow("r1") && basketRow("r1").servings === 8, JSON.stringify(DB.grocery_basket_items));

    // ---------- cook mode follows the units toggle ----------
    $("#recipe-form-panel").hidden = true;
    await until(function () { return !!document.querySelector('.item[data-id="r1"] .item-head'); });
    click(document.querySelector('.item[data-id="r1"] .item-head'));
    await until(function () { return !!document.querySelector('.item[data-id="r1"] .unit-toggle-btn[data-unit="metric"]'); });
    click(document.querySelector('.item[data-id="r1"] .unit-toggle-btn[data-unit="metric"]'));
    await delay(150);
    click(document.querySelector('.item[data-id="r1"] .cook-btn'));
    await until(function () { return txt($("#cook-ingredients")).length > 0; });
    var drawer = txt($("#cook-ingredients")), pills = txt($("#cook-step-ingredients"));
    assert("cook mode's ingredient list is in metric too", /\d\s*(?:[¼⅓½⅔¾]\s*)?ml/.test(drawer) && /\d\s*(?:g|kg)/.test(drawer) && !/cup|lb/.test(drawer), drawer);
    assert("…and so are the step's ingredient pills", /\d\s*(g|kg)\b/.test(pills) && !/\blb\b/.test(pills), pills);
    var close = $("#cook-close") || $(".cook-close"); click(close); await delay(150);

    // ---------- coach history is kept per account ----------
    assert("the old account-less coach thread is dropped", localStorage.getItem("coach:v1:r9") === null, "");
    click(document.querySelector('.item[data-id="r2"] .item-head'));
    await until(function () { return !!document.querySelector('.item[data-id="r2"] .coach-btn'); });
    click(document.querySelector('.item[data-id="r2"] .coach-btn'));
    await until(function () { return !$("#coach-panel").hidden; });
    $("#coach-input").value = "It came out soggy.";
    click($("#coach-send"));
    await until(function () { return /less dressing/.test(txt($("#coach-thread"))); });
    assert("a coach thread is saved under the account", !!localStorage.getItem("hi:u1:coach:r2") && localStorage.getItem("coach:v1:r2") === null,
      Object.keys(localStorage).filter(function (k) { return /coach/.test(k); }).join(","));

    // ---------- removing a recipe shared with you ----------
    async function removeShared() {
      click($("#toggle-shared"));
      await until(function () { return !!document.querySelector('.item[data-id="r3"]'); });
      var row = document.querySelector('.item[data-id="r3"]');
      if (!row.querySelector(".detail-more-btn")) click(row.querySelector(".item-head"));
      await until(function () { return !!document.querySelector('.item[data-id="r3"] .detail-more-btn'); });
      click(document.querySelector('.item[data-id="r3"] .detail-more-btn'));
      await until(function () { return !!$(".remove-shared-btn"); });
      click($(".remove-shared-btn"));
      await delay(400);
      return txt($(".toast"));
    }
    var refused = await removeShared();
    assert("Remove that deletes nothing says so", /Couldn.t remove that/.test(refused), refused);
    assert("…and doesn't claim success", !/Removed from your shared/.test(refused), refused);
    DB.recipe_shares.push({ recipe_id:"r3", shared_with_user_id:"u1", shared_by_user_id:"u2", created_at:"2026-04-02T00:00:00Z" });
    click($("#toggle-shared")); await delay(200);
    var removed = await removeShared();
    assert("Remove that works says so", /Removed from your shared recipes/.test(removed), removed);
    assert("…and the share row is gone", !DB.recipe_shares.some(function (r) { return r.recipe_id === "r3" && r.shared_with_user_id === "u1"; }), JSON.stringify(DB.recipe_shares));
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
      if (document.querySelector('.item[data-id="r1"]') || tries > 80) { setTimeout(runTests, 200); return; }
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
             "--virtual-time-budget=60000", "--dump-dom",
             f"http://127.0.0.1:{port}/{TEST_HTML.name}"],
            capture_output=True, text=True, timeout=150).stdout
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
