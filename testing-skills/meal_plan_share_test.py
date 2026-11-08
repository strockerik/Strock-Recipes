#!/usr/bin/env python3
"""Send-the-meal-plan test — the 📤 Send plan button on the Meal plan page.

Boots the REAL index.html DOM + app.js against a stubbed Supabase holding a
week of planned meals, taps Send plan with the share sheet stubbed, and reads
the .html file the app hands over.

Part A (unstyled, behaviour):
  - the page: 7 days with gaps shown, meals link to their recipe cards, one
    merged shopping list in aisle order (a recipe planned twice is bought
    twice, staples left off, pantry stock set aside), each recipe's
    ingredients at its planned servings (one list per size when they differ),
    no methods, no script, names escaped, source links kept
  - the window: past meals and deleted recipes stay out
  - the real grocery basket is never touched
  - delivery: file share; plain-text twin when files can't be shared; a
    cancelled sheet stays cancelled (no second sheet, no download); desktop
    downloads the file
  - a single recipe's 📤 Send still works through the shared helper
Part B (styled, real phone widths 360/390/430 via iframes — see
viewport_smoke_test.py for why): the Meal plan header's two buttons fit, and
the sent page never scrolls sideways and keeps 44px check-off rows.

No backend, no spend. Run: python3 testing-skills/meal_plan_share_test.py
(--save FILE writes the sent page out, to open in a browser.)
"""
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib

WIDTHS = (360, 390, 430)

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
A_HTML = REPO / "test_plan_share_a.html"
B_APP = REPO / "test_plan_share_b_app.html"
B_FRAMES = REPO / "test_plan_share_b.html"

# Shared: fake data (dates relative to the day the test runs) + Supabase stub.
STUB = r"""
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub", USER_ID = "u1";
function dayIso(n) { var d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function R(id, name, base, source, ingredients, method) {
  return { id:id, user_id:USER_ID, section:"kitchen", name:name, subtitle:null, source:source, tags:[],
    base_servings:base, servings_label:"servings", ingredients:ingredients,
    method:method.map(function (t) { return { text:t, group:null }; }),
    specs:null, notes:"SECRETNOTE", is_favorite:false, created_at:"2026-01-01T00:00:00Z" };
}
function I(amount, unit, item, group) { return { amount:amount, unit:unit, item:item, group:group || null }; }
var FAKE_RECIPES = [
  R("r1", "Creamy One-Pot Pasta", 4, "https://www.tiktok.com/@cook/video/7460496337373596970",
    [I(1,"lb","pasta"), I(2.5,"cup","chicken broth"), I(0.5,"cup","parmesan"), I(2,"tbsp","olive oil"), I(1,"tsp","salt")],
    ["Toast the pasta in oil SECRETSTEP1.", "Simmer in broth."]),
  R("r2", "Taco Night <b>&</b>", 4, "Grandma",
    [I(1,"lb","ground beef"), I(8,null,"corn tortillas"), I(0.5,"cup","parmesan"),
     I(2,null,"tomatoes","Salsa"), I(1,null,"jalapeño","Salsa")],
    ["Brown the beef SECRETSTEP2."]),
  R("r3", "Lemon Rice Bowl", 2, null,
    [I(1,"cup","rice"), I(1,null,"lemon")], ["Cook the rice SECRETSTEP3."])
];
var FAKE_PLAN = [
  { id:"e0", recipe_id:"r1", plan_date:dayIso(0), slot:"dinner", servings:4, purchased_at:null },
  { id:"e1", recipe_id:"r2", plan_date:dayIso(1), slot:"dinner", servings:8, purchased_at:null },
  { id:"e2", recipe_id:"r3", plan_date:dayIso(2), slot:"lunch",  servings:2, purchased_at:null },
  { id:"e3", recipe_id:"r1", plan_date:dayIso(3), slot:"dinner", servings:4, purchased_at:null },
  { id:"e4", recipe_id:"gone", plan_date:dayIso(4), slot:"dinner", servings:4, purchased_at:null },
  { id:"e5", recipe_id:"r2", plan_date:dayIso(5), slot:"dinner", servings:4, purchased_at:null },
  { id:"ep", recipe_id:"r3", plan_date:dayIso(-1), slot:"dinner", servings:2, purchased_at:null }
];
var FAKE_INVENTORY = [{ id:"i1", section:"pantry", category:"Dry Goods", name:"rice", status:"in" }];
var INSERTS = [], DELETES = [];
function makeBuilder(table) {
  var single = false;
  var val = function () {
    if (table === "recipes") return { data: FAKE_RECIPES, error: null };
    if (table === "meal_plan_entries") return { data: FAKE_PLAN, error: null };
    if (table === "inventory_items") return { data: FAKE_INVENTORY, error: null };
    if (table === "profiles") return single
      ? { data: { id: USER_ID, display_name:"T", diet_prefs:null, grocery_prefs:{ skipStaples:true }, kroger_prefs:null }, error: null }
      : { data: [{ id: USER_ID, display_name: "T" }], error: null };
    return { data: [], error: null };
  };
  var p = new Proxy({}, { get: function (t, k) {
    if (k === "then") return function (f, r) { return Promise.resolve(val()).then(f, r); };
    if (k === "catch") return function (r) { return Promise.resolve(val()).catch(r); };
    return function () {
      if (k === "insert") INSERTS.push({ table: table, row: arguments[0] });
      if (k === "delete") DELETES.push(table);
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
    refreshSession: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({ error: null }); }
  },
  rpc: function () { return Promise.resolve({ data: 0, error: null }); },
  functions: { invoke: function () { return Promise.resolve({ data: {}, error: null }); } }
}; } };
// Share sheet stub — each test sets SHARE_MODE before tapping.
var SHARES = [], DOWNLOADS = [], SHARE_MODE = "file";
Object.defineProperty(navigator, "canShare", { configurable: true, get: function () {
  return SHARE_MODE === "desktop" ? undefined : function (d) { return SHARE_MODE !== "text" && !!(d && d.files); }; } });
Object.defineProperty(navigator, "share", { configurable: true, get: function () {
  return SHARE_MODE === "desktop" ? undefined : function (d) {
    SHARES.push(d);
    return SHARE_MODE === "cancel" ? Promise.reject(new DOMException("cancelled", "AbortError")) : Promise.resolve();
  }; } });
HTMLAnchorElement.prototype.click = function () { DOWNLOADS.push(this.download); };
"""

# Boot the real page body (no scripts) + app.js, then run `runTests`.
BOOT = r"""
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
      if (document.querySelector('.item[data-id="r1"]') || tries > 100) { runTests(); return; }
      tries++; setTimeout(wait, 50);
    })();
  };
  s.onerror = function () { assert("app.js loaded", false, "load error"); finish(); };
  document.head.appendChild(s);
}).catch(function (e) { assert("boot", false, String(e)); finish(); });
"""

HELPERS = r"""
var RESULTS = [], JS_ERRORS = [];
window.addEventListener("error", function (e) { JS_ERRORS.push(String(e.message)); });
window.addEventListener("unhandledrejection", function (e) { JS_ERRORS.push("rejection: " + String(e.reason && e.reason.message || e.reason)); });
function assert(n, c, d) { RESULTS.push({ name: n, pass: !!c, detail: String(d == null ? "" : d) }); }
function click(el) { if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function $(s) { return document.querySelector(s); }
function txt(el) { return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; }
async function until(fn, ms) { var w = 0; while (!fn() && w < (ms || 4000)) { await delay(50); w += 50; } return fn(); }
async function openPlan() {
  click($("#mode-mealplan"));
  await until(function () { return !!$("#mp-send-plan"); });
  await delay(150);
}
async function sendPlanFile() {
  SHARES = []; SHARE_MODE = "file";
  click($("#mp-send-plan"));
  await until(function () { return SHARES.length > 0; });
  var f = SHARES[0] && SHARES[0].files && SHARES[0].files[0];
  return f ? { file: f, html: await f.text() } : null;
}
"""

A_PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>""" + STUB + r"""</script></head>
<body><pre id="smoke-results" style="display:none"></pre>
<script>""" + HELPERS + r"""
function finish() { document.getElementById("smoke-results").textContent = JSON.stringify(RESULTS);
  document.title = "TESTDONE"; }
function weekday(n) { var d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + n);
  return d.toLocaleDateString(undefined, { weekday: "short" }); }

async function runTests() {
  try {
    assert("the Meal plan tab shows for a scheduled week", !$(".mode-tabs").hidden, "");
    await openPlan();
    var btn = $("#mp-send-plan");
    assert("Send plan sits next to Create grocery list",
      !!btn && btn.parentElement === $("#mp-make-grocery").parentElement, btn ? btn.outerHTML.slice(0, 120) : "missing");
    assert("Send plan is enabled when meals are planned", btn && !btn.disabled, "");
    assert("its visible text is its accessible name (no aria-label override)",
      btn && !btn.hasAttribute("aria-label") && /Send plan/.test(txt(btn)), btn ? txt(btn) : "");

    var basketBefore = localStorage.getItem("hi:u1:basket");
    var sent = await sendPlanFile();
    assert("tapping it hands one .html file to the share sheet",
      !!sent && sent.file.type === "text/html" && /^meal-plan-\d{4}-\d{2}-\d{2}\.html$/.test(sent.file.name),
      sent ? sent.file.name + " " + sent.file.type : "no share");
    assert("the file is named for the first day", !!sent && sent.file.name === "meal-plan-" + dayIso(0) + ".html", sent ? sent.file.name : "");
    assert("the share has a title", /Meal plan/.test(SHARES[0] && SHARES[0].title), SHARES[0] && SHARES[0].title);
    if (!sent) throw new Error("no file to inspect");
    var html = sent.html;
    var doc = new DOMParser().parseFromString(html, "text/html");
    var all = function (s) { return Array.prototype.slice.call(doc.querySelectorAll(s)); };

    // ---- the page as a whole ----
    assert("no script in the page", all("script").length === 0, all("script").length);
    assert("no method steps anywhere", !/SECRETSTEP/.test(html), (html.match(/SECRETSTEP\d/g) || []).join());
    assert("no recipe notes either", !/SECRETNOTE/.test(html), "");
    assert("the title names the week", /^Meal plan, week of /.test(doc.title), doc.title);
    assert("three jump links: week, shopping list, recipes",
      all(".jump a").map(function (a) { return a.getAttribute("href"); }).join() === "#week,#shop,#recipes",
      all(".jump a").map(function (a) { return a.getAttribute("href"); }).join());
    var lede = txt(doc.querySelector(".hero .lede"));
    assert("the summary counts meals by type, recipes and things to buy",
      /^4 dinners and 1 lunch — 3 recipes, \d+ things to buy\.$/.test(lede), lede);

    // ---- the week ----
    var days = all(".day");
    assert("seven days, starting today", days.length === 7 && txt(days[0].querySelector(".wd")) === weekday(0),
      days.length + " " + (days[0] ? txt(days[0].querySelector(".wd")) : ""));
    assert("gaps show as Nothing planned (incl. the deleted recipe's night)",
      all(".day .none").length === 2 && !!days[4].querySelector(".none") && !!days[6].querySelector(".none"),
      all(".day .none").length);
    assert("yesterday's meal is left out", !days.some(function (d) { return /yesterday/i.test(txt(d)); }) && all(".meals li").length === 5,
      all(".meals li").length + " meals");
    assert("slot labels show because the week has a lunch",
      txt(days[2].querySelector(".slot")) === "Lunch" && txt(days[0].querySelector(".slot")) === "Dinner",
      txt(days[2]));
    var links = all(".meals a");
    assert("every meal links to a recipe card on the page",
      links.length === 5 && links.every(function (a) { return !!doc.getElementById(a.getAttribute("href").slice(1)); }),
      links.map(function (a) { return a.getAttribute("href"); }).join());
    assert("the same recipe on two nights links to the same card",
      links[0].getAttribute("href") === links[3].getAttribute("href"), links[0].getAttribute("href") + " vs " + links[3].getAttribute("href"));

    // ---- the shopping list ----
    var shopText = txt(doc.querySelector("#shop"));
    var aisles = all(".aisle h3").map(txt);
    var ORDER = ["Produce", "Bakery", "Meat & Seafood", "Dairy & Eggs", "Frozen", "Canned & Jarred", "Dry Goods & Baking", "Condiments, Sauces & Spices", "Beverages", "Alcohol", "Other"];
    assert("aisles follow the store-walk order",
      aisles.length >= 4 && aisles.every(function (a, i) { return i === 0 || ORDER.indexOf(a) > ORDER.indexOf(aisles[i - 1]); }),
      aisles.join(" > "));
    // A line's own words, without its "for <recipes>" note (a recipe called
    // "Lemon Rice Bowl" must not make the lemon line look like rice).
    function itemText(li) { var c = li.querySelector("label > span").cloneNode(true); var sm = c.querySelector("small"); if (sm) sm.remove(); return txt(c); }
    function line(re) { return all(".shop li").filter(function (li) { return re.test(itemText(li)); }).map(txt); }
    assert("a recipe planned twice is bought twice (1 lb pasta x 2 nights)", line(/pasta/i).some(function (t) { return /^2 lb pasta/.test(t); }), line(/pasta/i).join(" | "));
    assert("servings are summed across nights (beef: 8 + 4 servings of a 4-serving recipe = 3 lb)",
      line(/ground beef/i).some(function (t) { return /^3 lb ground beef/.test(t); }), line(/ground beef/i).join(" | "));
    assert("a shared ingredient is merged into one line naming both recipes",
      line(/parmesan/i).length === 1 && /for Creamy One-Pot Pasta, Taco Night/.test(line(/parmesan/i)[0]), line(/parmesan/i).join(" | "));
    assert("staples are left off when the cook skips them", line(/\bsalt\b|olive oil/i).length === 0, line(/\bsalt\b|olive oil/i).join());
    assert("…and the page says so", /Salt, pepper, oil, sugar, butter and flour are left off/.test(shopText), "");
    assert("pantry stock is set aside, not silently dropped",
      line(/\brice\b/i).length === 0 && /Already at home \(from the pantry list\): rice/.test(shopText), shopText.slice(-200));
    assert("every line is a real checkbox", all(".shop li").length > 0 && all(".shop li").every(function (li) {
      return !!li.querySelector("label > input[type=checkbox] + span"); }), all(".shop li").length);

    // ---- the recipes ----
    var cards = all(".card");
    assert("one card per recipe, in the order it's first cooked",
      cards.map(function (c) { return txt(c.querySelector("h3")); }).join(" | ") === "Creamy One-Pot Pasta | Taco Night <b>&</b> | Lemon Rice Bowl",
      cards.map(function (c) { return txt(c.querySelector("h3")); }).join(" | "));
    assert("recipe names are escaped, not markup", cards[1] && !cards[1].querySelector("h3 b"), cards[1] ? cards[1].querySelector("h3").innerHTML : "");
    assert("a card says when it's cooked", txt(cards[0].querySelector(".when")) === weekday(0) + " dinner · " + weekday(3) + " dinner",
      txt(cards[0].querySelector(".when")));
    var meta0 = txt(cards[0].querySelector(".meta"));
    assert("same servings both nights: one list, '4 servings each time'", /^4 servings each time/.test(meta0) && cards[0].querySelectorAll(".for").length === 0, meta0);
    assert("an imported recipe links to its original for the method",
      /Full recipe on tiktok\.com/.test(meta0) && cards[0].querySelector(".meta a").getAttribute("href") === "https://www.tiktok.com/@cook/video/7460496337373596970", meta0);
    var ing0 = Array.prototype.slice.call(cards[0].querySelectorAll(".pts li")).map(txt);
    assert("ingredients are scaled to the planned servings, not summed", ing0[0] === "1 lb pasta", ing0.join(" | "));
    assert("staples stay in the recipe itself", /olive oil/.test(txt(cards[0])) && /salt/.test(txt(cards[0])), "");
    var fors = Array.prototype.slice.call(cards[1].querySelectorAll(".for")).map(txt);
    assert("different servings on different nights: one list per size",
      fors.length === 2 && fors[0] === "8 servings — " + weekday(1) + " dinner" && fors[1] === "4 servings — " + weekday(5) + " dinner", fors.join(" | "));
    var lists = cards[1].querySelectorAll("ul.pts");
    assert("…each scaled to its own size (2 lb beef, then 1 lb)",
      /2 lb ground beef/.test(txt(cards[1])) && /1 lb ground beef/.test(txt(cards[1])), txt(cards[1]).slice(0, 220));
    assert("ingredient groups keep their headings", cards[1].querySelectorAll("h4.grp").length === 2 && txt(cards[1].querySelector("h4.grp")) === "Salsa",
      cards[1].querySelectorAll("h4.grp").length);
    assert("a plain-text source stays as text", /Source: Grandma/.test(txt(cards[1].querySelector(".meta"))), txt(cards[1].querySelector(".meta")));

    // ---- side effects ----
    assert("the real grocery basket is untouched",
      localStorage.getItem("hi:u1:basket") === basketBefore && !INSERTS.some(function (i) { return i.table === "grocery_basket_items"; })
        && DELETES.indexOf("grocery_basket_items") === -1 && $("#grocery-bar").hidden,
      JSON.stringify(INSERTS) + " " + DELETES.join());

    // ---- delivery fallbacks ----
    SHARES = []; DOWNLOADS = []; SHARE_MODE = "text";
    click($("#mp-send-plan")); await until(function () { return SHARES.length > 0; });
    var t = SHARES[0] && SHARES[0].text || "";
    assert("no file sharing: a plain-text version is shared instead",
      SHARES.length === 1 && !SHARES[0].files && /THE WEEK/.test(t) && /SHOPPING LIST/.test(t) && /RECIPES \(ingredients only\)/.test(t), t.slice(0, 120));
    assert("…with the same content and still no methods",
      /2 lb pasta/.test(t) && /Full recipe: https:\/\/www\.tiktok\.com/.test(t) && /nothing planned/.test(t) && !/SECRETSTEP/.test(t), "");

    SHARES = []; DOWNLOADS = []; SHARE_MODE = "cancel";
    click($("#mp-send-plan")); await delay(400);
    assert("a cancelled share sheet stays cancelled (no second sheet, no download)",
      SHARES.length === 1 && DOWNLOADS.length === 0, SHARES.length + " shares, " + DOWNLOADS.length + " downloads");

    SHARES = []; DOWNLOADS = []; SHARE_MODE = "desktop";
    click($("#mp-send-plan")); await until(function () { return DOWNLOADS.length > 0; });
    assert("desktop: the page downloads instead", DOWNLOADS.length === 1 && DOWNLOADS[0] === "meal-plan-" + dayIso(0) + ".html", DOWNLOADS.join());
    assert("…and says what to do with it", /Saved the meal plan page/.test(txt($(".toast"))), txt($(".toast")));

    // ---- a single recipe's Send still works through the shared helper ----
    SHARE_MODE = "file"; SHARES = [];
    click($("#mode-recipes")); await delay(200);
    // Re-query after each tap: opening a recipe re-renders its row.
    click($('.item[data-id="r1"] .item-head')); await delay(200);
    click($('.item[data-id="r1"] .detail-more-btn')); await delay(150);
    click($("#detail-more-menu .send-recipe-btn"));
    await until(function () { return SHARES.length > 0; });
    var rf = SHARES[0] && SHARES[0].files && SHARES[0].files[0];
    var rhtml = rf ? await rf.text() : "";
    assert("a single recipe still sends as its own page, method included",
      !!rf && rf.name === "creamy-one-pot-pasta.html" && /<h2>Ingredients<\/h2>/.test(rhtml) && /<h2>Method<\/h2>/.test(rhtml) && /SECRETSTEP1/.test(rhtml)
        && /<li><b>1 lb<\/b> pasta<\/li>/.test(rhtml), rf ? rf.name : "no file");

    // ---- an empty week ----
    FAKE_PLAN = [];
    await openPlan();
    var b2 = $("#mp-send-plan");
    assert("with nothing planned this week, Send plan is disabled", b2 && b2.disabled, b2 ? b2.outerHTML.slice(0, 100) : "missing");
  } catch (e) {
    assert("no exception", false, String(e && e.stack || e));
  }
  assert("no uncaught JS errors", JS_ERRORS.length === 0, JS_ERRORS.join(" | ").slice(0, 400));
  finish();
}
""" + BOOT + r"""
</script></body></html>"""

# Part B: the styled app inside a phone-width iframe; it sends the plan and
# reports header geometry + the captured page back to the frames page, which
# renders that page in its own phone-width iframe and measures it.
B_APP_PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUNNING</title><link rel="stylesheet" href="style.css">
<script>""" + STUB + r"""</script></head>
<body><script>""" + HELPERS + r"""
function finish() { parent.postMessage({ w: innerWidth, results: RESULTS, html: window.SENT_HTML || "" }, "*"); }
async function runTests() {
  try {
    await openPlan();
    var W = document.documentElement.clientWidth;
    ["#mp-send-plan", "#mp-make-grocery"].forEach(function (s) {
      var r = $(s).getBoundingClientRect();
      assert(s + " fits on screen", r.left >= 0 && r.right <= W + 0.5, "left " + r.left.toFixed(1) + " right " + r.right.toFixed(1) + " of " + W);
      assert(s + " is a 44px touch target", r.height >= 44, r.height.toFixed(1));
    });
    var a = $("#mp-send-plan").getBoundingClientRect(), b = $("#mp-make-grocery").getBoundingClientRect();
    assert("the two buttons don't overlap", a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5, "");
    assert("the app page doesn't scroll sideways", document.documentElement.scrollWidth <= W, document.documentElement.scrollWidth + " > " + W);
    var sent = await sendPlanFile();
    window.SENT_HTML = sent ? sent.html : "";
    assert("the plan was sent", !!sent, "");
  } catch (e) { assert("no exception", false, String(e && e.stack || e)); }
  assert("no uncaught JS errors", JS_ERRORS.length === 0, JS_ERRORS.join(" | ").slice(0, 300));
  finish();
}
""" + BOOT + r"""
</script></body></html>"""

B_FRAMES_PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title></head>
<body><pre id="out"></pre>__FRAMES__
<script>
var rows = [], expected = __N__;
function measure(w, html, results) {
  return new Promise(function (resolve) {
    var f = document.createElement("iframe");
    f.style.cssText = "width:" + w + "px;height:900px;border:0";
    f.onload = function () {
      setTimeout(function () {
        var d = f.contentDocument, W = d.documentElement.clientWidth, bad = [];
        results.push({ name: "sent page doesn't scroll sideways", pass: d.documentElement.scrollWidth <= W,
                       detail: d.documentElement.scrollWidth + " > " + W });
        Array.prototype.forEach.call(d.querySelectorAll("body *"), function (el) {
          var r = el.getBoundingClientRect();
          if (r.width && r.right > W + 0.5) bad.push((el.className || el.tagName) + "@" + r.right.toFixed(0));
        });
        results.push({ name: "nothing on the sent page runs past the right edge", pass: !bad.length, detail: bad.slice(0, 6).join(", ") });
        var labels = Array.prototype.slice.call(d.querySelectorAll(".shop label"));
        var short = labels.filter(function (l) { return l.getBoundingClientRect().height < 44; });
        results.push({ name: "check-off rows are 44px touch targets", pass: labels.length > 0 && !short.length,
                       detail: labels.length + " rows, " + short.length + " short" });
        var day = d.querySelector(".day"), meals = day && day.querySelector(".meals, .none");
        results.push({ name: "the week keeps the day beside its meals", pass: !!meals && meals.getBoundingClientRect().left > day.getBoundingClientRect().left + 40,
                       detail: meals ? meals.getBoundingClientRect().left.toFixed(0) : "no day" });
        resolve();
      }, 300);
    };
    f.srcdoc = html;
    document.body.appendChild(f);
  });
}
window.addEventListener("message", async function (e) {
  var res = e.data.results || [];
  if (e.data.html) await measure(e.data.w, e.data.html, res);
  else res.push({ name: "got a sent page to measure", pass: false, detail: "" });
  rows.push({ w: e.data.w, r: res, html: e.data.html });
  if (rows.length === expected) {
    rows.sort(function (a, b) { return a.w - b.w; });
    document.getElementById("out").textContent = JSON.stringify(rows);
    document.title = "TESTDONE";
  }
});
</script></body></html>"""


def serve():
    os.chdir(REPO)
    socketserver.TCPServer.allow_reuse_address = True
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    httpd = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def chrome(url, budget, extra=()):
    return subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", *extra,
         f"--virtual-time-budget={budget}", "--dump-dom", url],
        capture_output=True, text=True, timeout=180).stdout


def unescape(s):
    for a, b in (("&quot;", '"'), ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&")):
        s = s.replace(a, b)
    return s


def main():
    keep = "--keep" in sys.argv
    A_HTML.write_text(A_PAGE)
    B_APP.write_text(B_APP_PAGE)
    frames = "".join(f'<iframe src="{B_APP.name}" style="width:{w}px;height:900px;border:0"></iframe>' for w in WIDTHS)
    B_FRAMES.write_text(B_FRAMES_PAGE.replace("__FRAMES__", frames).replace("__N__", str(len(WIDTHS))))
    httpd = serve()
    port = httpd.server_address[1]
    try:
        out_a = chrome(f"http://127.0.0.1:{port}/{A_HTML.name}", 30000)
        out_b = chrome(f"http://127.0.0.1:{port}/{B_FRAMES.name}", 40000, ("--window-size=1400,1000",))
    finally:
        httpd.shutdown()
        if not keep:
            for p in (A_HTML, B_APP, B_FRAMES):
                if p.exists(): p.unlink()

    total = passed = 0
    print("Part A — behaviour")
    m = re.search(r'<pre id="smoke-results"[^>]*>(.*?)</pre>', out_a, re.S)
    if not m or not m.group(1).strip():
        print("NO RESULTS (A):\n", out_a[:1500]); sys.exit(1)
    for r in json.loads(unescape(m.group(1))):
        total += 1; passed += r["pass"]
        print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "  >> " + r["detail"]))

    print("\nPart B — phone widths (styled)")
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', out_b, re.S)
    if not m or not m.group(1).strip():
        print("NO RESULTS (B):\n", out_b[:1500]); sys.exit(1)
    for row in json.loads(unescape(m.group(1))):
        if "--save" in sys.argv and row["w"] == 390 and row.get("html"):
            dest = pathlib.Path(sys.argv[sys.argv.index("--save") + 1]).resolve()
            dest.write_text(row["html"]); print(f"  saved the sent page to {dest}")
        fails = [r for r in row["r"] if not r["pass"]]
        total += len(row["r"]); passed += len(row["r"]) - len(fails)
        print(f"  {row['w']}px: {len(row['r']) - len(fails)}/{len(row['r'])}")
        for f in fails:
            print(f"      FAIL {f['name']}  >> {f['detail']}")
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 2)


if __name__ == "__main__":
    main()
