#!/usr/bin/env python3
"""Bottles test — Bar tab → 🥃 Bottles, the lookup sheet, and score chips.

Boots the REAL index.html DOM + app.js against a stubbed Supabase that filters
(eq / in / single / counts) over a small spirits catalog, with identify-bottle
and research-bottle replies scripted per test. No backend, no spend.

Part A (unstyled, behaviour):
  - the Bottles tab shows on the Bar tab only (Meal plan still hidden until
    something is planned); leaving the Bar tab leaves Bottles
  - Best rated: ranked by rank_score, category chips filter, "In your bar"
  - a typed name that's a sure match opens the score card: score, confidence,
    every review with its link, AI-found tag on unverified finds
  - an ambiguous name lists candidates; picking one saves the label's spelling
  - not in the catalog → lookups-left count → Look it up → polls the lookup
    row → the score card; closing the sheet mid-lookup ends in a View toast
  - a label photo is resized and sent to identify-bottle; its error is shown
  - Add to my bar links the new bar row to the catalog bottle; Wrong bottle?
    files a report; Escape closes the sheet
  - Bar & Pantry shows the score beside a linked bottle (tap → score card),
    and a bottle typed in by hand is linked when its name is a sure match
Part B (styled, real phone widths 360/390/430 via iframes): the Bottles view
and the score card never scroll sideways, and their controls are 44px targets.

Run: python3 testing-skills/bottles_view_test.py
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
A_HTML = REPO / "test_bottles_a.html"
B_APP = REPO / "test_bottles_b_app.html"
B_FRAMES = REPO / "test_bottles_b.html"

STUB = r"""
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub", USER_ID = "u1";
var T = {
  recipes: [{ id:"r1", user_id:USER_ID, section:"bar", name:"Last Word", subtitle:null, source:null, tags:["gin"],
    base_servings:1, servings_label:"drink", ingredients:[{amount:0.75,unit:"oz",item:"green chartreuse",group:null}],
    method:[{text:"Shake.",group:null}], specs:null, notes:null, is_favorite:false, created_at:"2026-01-01T00:00:00Z" },
    { id:"k1", user_id:USER_ID, section:"kitchen", name:"Toast", subtitle:null, source:null, tags:[], base_servings:1,
    servings_label:"servings", ingredients:[{amount:1,unit:null,item:"bread",group:null}], method:[{text:"Toast.",group:null}],
    specs:null, notes:null, is_favorite:false, created_at:"2026-01-01T00:00:00Z" }],
  inventory_items: [
    { id:"i1", section:"bar", category:"liqueur", name:"Green Chartreuse", status:"in", product_id:"p-green" },
    { id:"i2", section:"bar", category:"rye", name:"Laws San Luis Valley Rye", status:"in", product_id:"p-laws" },
    { id:"i3", section:"pantry", category:"Dry Goods & Baking", name:"rice", status:"in", product_id:null }],
  spirit_consensus: [
    { product_id:"p-green", canonical_name:"Green Chartreuse", category:"liqueur", n_reviews:3, n_sources:3, score_10:8.5, confidence:"medium", rank_score:8.1 },
    { product_id:"p-sc", canonical_name:"Smith & Cross", category:"rum", n_reviews:2, n_sources:2, score_10:8.5, confidence:"medium", rank_score:7.9 },
    { product_id:"p-yellow", canonical_name:"Yellow Chartreuse", category:"liqueur", n_reviews:2, n_sources:2, score_10:8.5, confidence:"low", rank_score:7.6 },
    { product_id:"p-ec", canonical_name:"Elijah Craig Small Batch", category:"bourbon", n_reviews:8, n_sources:4, score_10:7.5, confidence:"high", rank_score:7.4 },
    { product_id:"p-hen", canonical_name:"Hendrick's Gin", category:"gin", n_reviews:2, n_sources:2, score_10:7.5, confidence:"low", rank_score:7.2 }],
  spirit_products: [
    { id:"p-green", canonical_name:"Green Chartreuse", category:"liqueur", producer:"Chartreuse Diffusion", country:"France", age_years:null, abv:55 },
    { id:"p-yellow", canonical_name:"Yellow Chartreuse", category:"liqueur", producer:null, country:"France", age_years:null, abv:40 },
    { id:"p-sc", canonical_name:"Smith & Cross", category:"rum", producer:null, country:null, age_years:null, abv:57 },
    { id:"p-ec", canonical_name:"Elijah Craig Small Batch", category:"bourbon", producer:"Heaven Hill", country:"USA", age_years:null, abv:47 },
    { id:"p-hen", canonical_name:"Hendrick's Gin", category:"gin", producer:null, country:null, age_years:null, abv:44 },
    { id:"p-laws", canonical_name:"Laws San Luis Valley Rye", category:"rye", producer:null, country:null, age_years:null, abv:null }],
  spirit_reviews: [
    { id:"v1", product_id:"p-green", source_id:"wine_enthusiast", score_raw:93, score_10:8.25, medal:null, review_year:2016, url:"https://www.wineenthusiast.com/buying-guide/chartreuse-green/", reviewer:null, origin:"curated", verified:true },
    { id:"v2", product_id:"p-green", source_id:"drinkhacker", score_raw:9.5, score_10:8.75, medal:null, review_year:2019, url:"https://www.drinkhacker.com/2019/05/20/review-yellow-chartreuse-and-green-chartreuse/", reviewer:null, origin:"curated", verified:true },
    { id:"v3", product_id:"p-green", source_id:"other_critic", score_raw:90, score_10:7.5, medal:null, review_year:2020, url:"https://blog.example/green", reviewer:"Some Liqueur Blog", origin:"field", verified:false },
    { id:"v4", product_id:"p-ec", source_id:"sfwsc", score_raw:null, score_10:8.5, medal:"Double Gold", review_year:2022, url:"https://elijahcraig.com/small-batch", reviewer:null, origin:"curated", verified:true }],
  rating_sources: [{ id:"wine_enthusiast", name:"Wine Enthusiast", scale:"wine_enthusiast" }, { id:"drinkhacker", name:"Drinkhacker", scale:"drinkhacker" },
    { id:"other_critic", name:"Other critic", scale:"critic100" }, { id:"sfwsc", name:"San Francisco World Spirits Competition", scale:"sfwsc" }],
  bottle_usage: [{ user_id:USER_ID, usage_date:new Date().toISOString().slice(0,10), kind:"lookup", count:2 }],
  spirit_lookups: [], spirit_reports: []
};
var QUERIES = [], INSERTS = [], UPDATES = [], RPCS = [], INVOKES = [];
var FN = {          // scripted Edge Function replies by name: a function (body) -> data
  "research-bottle": function (b) { return b.product_id ? { status: "fresh", product_id: b.product_id, checked_at: new Date().toISOString() } : { error: "unscripted" }; }
};
var CHECK = {};     // product id -> reply for a check of that bottle (else the default above)
var DEFAULT_RESEARCH = FN["research-bottle"];
function researchReply(b) { return b.product_id && CHECK[b.product_id] ? CHECK[b.product_id](b) : FN["research-bottle"](b); }
var LOOKUP_SCRIPT = {}; // lookup id -> remaining statuses to report on each poll
function makeBuilder(table) {
  var st = { f: [], ins: [], single: false, op: "select", row: null, count: false, head: false };
  function rows() {
    if (table === "spirit_lookups") {
      var id = (st.f.filter(function (f) { return f[0] === "id"; })[0] || [])[1];
      var seq = LOOKUP_SCRIPT[id];
      if (seq && seq.length) { var s = seq.shift(); if (s.onDone) s.onDone(); return [{ id: id, status: s.status, product_id: s.product_id || null, added: s.added == null ? 1 : s.added }]; }
      return [];
    }
    return (T[table] || []).filter(function (r) {
      return st.f.every(function (f) { return r[f[0]] === f[1]; }) && st.ins.every(function (f) { return f[1].indexOf(r[f[0]]) >= 0; });
    });
  }
  function val() {
    if (st.op === "insert") {
      var made = Object.assign({ id: table + "-" + (INSERTS.length + 1) }, st.row);
      INSERTS.push({ table: table, row: st.row });
      if (T[table]) T[table].push(made);
      return { data: st.single ? made : [made], error: null };
    }
    if (st.op === "update") { UPDATES.push({ table: table, patch: st.row, f: st.f.slice() }); rows().forEach(function (r) { Object.assign(r, st.row); }); return { data: null, error: null }; }
    if (table === "profiles") return st.single ? { data: { id: USER_ID, display_name:"T", diet_prefs:null, grocery_prefs:null, kroger_prefs:null }, error: null } : { data: [{ id: USER_ID }], error: null };
    var out = rows();
    if (st.count && st.head) return { data: null, count: out.length, error: null };
    return { data: st.single ? (out[0] || null) : out, error: null };
  }
  var p = new Proxy({}, { get: function (t, k) {
    if (k === "then") return function (f, r) { return Promise.resolve(val()).then(f, r); };
    if (k === "catch") return function (r) { return Promise.resolve(val()).catch(r); };
    return function (a, b) {
      if (k === "select") { if (b && b.count) { st.count = true; st.head = !!b.head; } QUERIES.push({ table: table, op: "select" }); }
      if (k === "eq") st.f.push([a, b]);
      if (k === "in") { st.ins.push([a, b]); QUERIES.push({ table: table, op: "in", col: a, vals: b }); }
      if (k === "single" || k === "maybeSingle") st.single = true;
      if (k === "insert") { st.op = "insert"; st.row = a; }
      if (k === "update") { st.op = "update"; st.row = a; }
      return p;
    };
  }});
  return p;
}
function candidatesFor(q) {
  var C = {
    "green chartreuse": [["p-green", 1.0], ["p-yellow", 0.5]],
    "chartreuse": [["p-green", 0.62], ["p-yellow", 0.62]],
    "elijah craig small batch bourbon": [["p-ec", 0.81]],
    "hendricks": [["p-hen", 1.0]],
    "buffalo trace": T.spirit_products.some(function (p) { return p.id === "p-bt"; }) ? [["p-bt", 1.0]] : []
  }[q] || [];
  return C.map(function (c) { var p = T.spirit_products.filter(function (x) { return x.id === c[0]; })[0];
    return { product_id: p.id, canonical_name: p.canonical_name, category: p.category, age_years: p.age_years, abv: p.abv, batch: null, score: c[1] }; });
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
  rpc: function (name, args) {
    RPCS.push({ name: name, args: args });
    if (name === "spirit_candidates") return Promise.resolve({ data: candidatesFor(args.q), error: null });
    return Promise.resolve({ data: 0, error: null });
  },
  functions: { invoke: function (name, opts) {
    INVOKES.push({ name: name, body: opts && opts.body });
    var f = name === "research-bottle" ? researchReply : FN[name];
    return Promise.resolve({ data: f ? f(opts && opts.body) : {}, error: null });
  } }
}; } };
"""

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
      if (document.querySelector('.item[data-id="k1"]') || tries > 100) { runTests(); return; }
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
function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
function txt(el) { return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; }
async function until(fn, ms) { var w = 0; while (!fn() && w < (ms || 4000)) { await delay(50); w += 50; } return fn(); }
async function toBar() { click($(".tab-bar")); await delay(120); }
async function toBottles() { await toBar(); click($("#mode-bottles")); await until(function () { return $$("#bt-best .bt-row").length > 0; }); }
async function typeLookup(q) {
  var input = $("#bt-view-q"); input.value = q;
  $("#bt-view-search").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await delay(50);
}
function screen() { return (txt($("#bottle-title"))); }
async function resultFor(name) { return until(function () { return txt($(".bt-result-name")) === name; }, 6000); }
// A real 2x2 PNG, so processImage's <img> + canvas path actually runs.
function pngFile() {
  var b64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDj+3NnwAAAABJRU5ErkJggg==";
  var bin = atob(b64), arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], "label.png", { type: "image/png" });
}
function choosePhoto(file) {
  var input = $("#bt-photo-pick");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
"""

A_PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>""" + STUB + r"""</script></head>
<body><pre id="smoke-results" style="display:none"></pre>
<script>""" + HELPERS + r"""
function finish() { document.getElementById("smoke-results").textContent = JSON.stringify(RESULTS); document.title = "TESTDONE"; }
async function runTests() {
  try {
    // ---- tabs ----
    assert("Kitchen: no Bottles tab (and no view row with nothing planned)", $("#mode-bottles").hidden && $(".mode-tabs").hidden, "");
    await toBar();
    assert("Bar: the view row shows with Bottles", !$(".mode-tabs").hidden && !$("#mode-bottles").hidden, "");
    assert("Bar: no Meal plan tab (meal planning is Kitchen-only)", $("#mode-mealplan").hidden, "");
    assert("Bar: no 📅 stage controls on cocktails", !document.querySelector('.item[data-id="r1"] .plan-pick'), "");
    click($("#mode-bottles"));
    await until(function () { return $$("#bt-best .bt-row").length > 0; });
    assert("Bottles view shows; the recipe list hides", !$("#bottles-view").hidden && $("#recipe-list") ? $("#recipe-list").hidden : true, "");
    assert("Bottles tab is the selected one", $("#mode-bottles").getAttribute("aria-selected") === "true" && $("#mode-recipes").getAttribute("aria-selected") === "false", "");

    // ---- Best rated ----
    var names = $$("#bt-best .bt-row-name").map(txt);
    assert("Best rated is ranked by rank_score", names.join("|") === "Green Chartreuse|Smith & Cross|Elijah Craig Small Batch", names.join("|"));
    assert("…listing only medium- and high-confidence bottles", QUERIES.some(function (q) { return q.op === "in" && q.col === "confidence" && q.vals.join() === "medium,high"; }) && names.indexOf("Yellow Chartreuse") < 0, names.join("|"));
    assert("the total counts every scored bottle", /5 bottles scored/.test(txt($("#bt-total"))), txt($("#bt-total")));
    var greenRow = $$("#bt-best .bt-row").filter(function (r) { return /Green Chartreuse/.test(txt(r)); })[0];
    assert("owned bottles say In your bar (others don't)", /In your bar/.test(txt(greenRow)) && !/In your bar/.test(txt($$("#bt-best .bt-row")[1])), txt(greenRow));
    assert("a row reads score, category, reviews and confidence", /8\.5/.test(txt(greenRow)) && /Liqueur · 3 reviews · medium confidence/.test(txt(greenRow)), txt(greenRow));
    QUERIES = [];
    click($('[data-bt-filter="rum"]'));
    await until(function () { return $$("#bt-best .bt-row").length === 1; });
    assert("the Rum chip asks the catalog for rum only", QUERIES.some(function (q) { return q.op === "in" && q.col === "category" && q.vals.join() === "rum"; }), JSON.stringify(QUERIES));
    assert("…shows only rum, and marks the chip pressed", txt($("#bt-best .bt-row-name")) === "Smith & Cross" && $('[data-bt-filter="rum"]').getAttribute("aria-pressed") === "true", "");
    click($('[data-bt-filter="all"]'));
    await until(function () { return $$("#bt-best .bt-row").length === 3; });

    // ---- a sure match: straight to the score card, then a check ----
    CHECK["p-green"] = function () { return { status: "running", lookup_id: "V1" }; };
    LOOKUP_SCRIPT.V1 = [{ status: "running" }, { status: "found", product_id: "p-green", added: 1, onDone: function () {
      T.spirit_reviews.push({ id:"v10", product_id:"p-green", source_id:"wine_enthusiast", score_raw:96, score_10:9.0, medal:null, review_year:2025, url:"https://www.wineenthusiast.com/buying-guide/green-chartreuse-2025/", reviewer:null, origin:"field", verified:false });
      T.spirit_consensus[0].n_reviews = 4;
      T.spirit_products.filter(function (p) { return p.id === "p-green"; })[0].researched_at = new Date().toISOString();
    } }];
    await typeLookup("Green Chartreuse");
    await resultFor("Green Chartreuse");
    var checkCall = INVOKES.filter(function (i) { return i.name === "research-bottle"; })[0];
    assert("a lookup of a known bottle shows its score at once and starts a check", !!checkCall && checkCall.body.product_id === "p-green" && /Checking for newer reviews/.test(txt($("#bt-check"))) && txt($(".bt-big")) === "8.5/10", checkCall ? JSON.stringify(checkCall.body) : "no check");
    CHECK["p-green"] = null;
    assert("typed sure match opens the sheet on the score card", !$("#bottle-panel").hidden && screen() === "Expert score", screen());
    assert("the score card shows the score out of 10 and its confidence", txt($(".bt-big")) === "8.5/10" && /Medium confidence/.test(txt($(".bt-conf"))), txt($(".bt-scorecard")));
    assert("…and how many reviews from how many sources", /3 reviews from 3 sources/.test(txt($(".bt-score-why"))), txt($(".bt-score-why")));
    assert("the facts line: category, producer, ABV", /Liqueur · Chartreuse Diffusion · 55% ABV/.test(txt($(".bt-result-facts"))), txt($(".bt-result-facts")));
    var srcs = $$(".bt-sources a.bt-src");
    assert("every review is listed with a link that opens a new tab", srcs.length === 3 && srcs.every(function (a) { return a.target === "_blank" && /noopener/.test(a.rel); }), srcs.length);
    assert("reviews read in the source's own terms", srcs.some(function (a) { return /Wine Enthusiast/.test(txt(a)) && /93 points · 2016/.test(txt(a)); }) && srcs.some(function (a) { return /Drinkhacker/.test(txt(a)) && /9\.5\/10/.test(txt(a)); }), srcs.map(txt).join(" | "));
    var field = srcs.filter(function (a) { return /Some Liqueur Blog/.test(txt(a)); })[0];
    assert("an unverified lookup find is named by its publication and tagged AI-found", !!field && /AI-found/.test(txt(field)), field ? txt(field) : "missing");
    assert("the footnote explains the ¾ weight when AI finds are shown", /count ¾ until/.test(txt($(".bottle-body"))), "");
    assert("an owned bottle says In your bar instead of offering Add", !!$(".bt-actions .bt-owned") && !$('[data-bt="add"]'), "");
    assert("the typed name itself never called the label reader", !INVOKES.some(function (i) { return i.name === "identify-bottle"; }), JSON.stringify(INVOKES));
    await until(function () { return /Updated/.test(txt($("#bt-check"))); }, 15000);
    assert("when the check finds something new, the card updates in place and says so", /Updated — 1 new review found just now/.test(txt($("#bt-check"))) && $$(".bt-sources a.bt-src").length === 4 && /96 points · 2025/.test(txt($(".bt-sources"))), txt($("#bt-check")) + " / " + $$(".bt-sources a.bt-src").length);

    // ---- several close matches: pick one ----
    RPCS = [];
    click($('[data-bt="again"]'));
    await until(function () { return !!$("[data-bt-form]"); });
    var f = $("[data-bt-form]"); f.elements.q.value = "Chartreuse";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(function () { return $$(".bt-cand").length === 2; });
    assert("an ambiguous name asks Which one is it?", screen() === "Which one is it?" && $$(".bt-cand").length === 2, screen());
    assert("candidates show their score and whether you own them", /8\.5/.test(txt($$(".bt-cand")[0])) && /in your bar/.test(txt($$(".bt-cand")[0])), txt($$(".bt-cand")[0]));
    click($$(".bt-cand")[1]);
    await resultFor("Yellow Chartreuse");
    var conf = RPCS.filter(function (r) { return r.name === "spirit_confirm_alias"; })[0];
    assert("picking one teaches the catalog that spelling", !!conf && conf.args.p_product === "p-yellow" && conf.args.p_alias_norm === "chartreuse", JSON.stringify(conf));
    await until(function () { return /Up to date/.test(txt($("#bt-check"))); });
    assert("a bottle checked recently comes back Up to date (nothing re-run)", /Up to date — reviews checked today/.test(txt($("#bt-check"))), txt($("#bt-check")));

    // ---- not in the catalog → look it up → polled to a result ----
    click($('[data-bt="again"]'));
    await until(function () { return !!$("[data-bt-form]"); });
    f = $("[data-bt-form]"); f.elements.q.value = "Buffalo Trace";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(function () { return screen() === "Not in the catalog yet"; });
    assert("no candidates → Not in the catalog yet", screen() === "Not in the catalog yet", screen());
    await until(function () { return /left today/.test(txt($("#bt-left"))); });
    assert("it says how many lookups are left today", /18 of 20 lookups left today/.test(txt($("#bt-left"))), txt($("#bt-left")));
    FN["research-bottle"] = function () { return { status: "running", lookup_id: "L1" }; };
    LOOKUP_SCRIPT.L1 = [{ status: "running" }, { status: "found", product_id: "p-bt", onDone: function () {
      T.spirit_products.push({ id:"p-bt", canonical_name:"Buffalo Trace Kentucky Straight Bourbon", category:"bourbon", producer:"Buffalo Trace", country:"USA", age_years:null, abv:45 });
      T.spirit_consensus.push({ product_id:"p-bt", canonical_name:"Buffalo Trace Kentucky Straight Bourbon", category:"bourbon", n_reviews:1, n_sources:1, score_10:8.0, confidence:"low", rank_score:7.3 });
      T.spirit_reviews.push({ id:"v9", product_id:"p-bt", source_id:"wine_enthusiast", score_raw:92, score_10:8.0, medal:null, review_year:2022, url:"https://www.wineenthusiast.com/buying-guide/buffalo-trace/", reviewer:null, origin:"field", verified:false });
    } }];
    click($('[data-bt="research"]'));
    await until(function () { return screen() === "Looking it up"; });
    var inv = INVOKES.filter(function (i) { return i.name === "research-bottle" && !i.body.product_id; })[0];
    assert("Look it up calls research-bottle with the name", !!inv && inv.body.name === "Buffalo Trace", JSON.stringify(inv));
    assert("while it works: a status line and a note that closing is fine", !!$(".bt-researching[role=status]") && /keeps going/.test(txt($(".bottle-body"))), "");
    await until(function () { return txt($(".bt-result-name")) === "Buffalo Trace Kentucky Straight Bourbon"; }, 15000);
    assert("the polled lookup lands on the new bottle's score card", txt($(".bt-big")) === "8.0/10" && /AI-found/.test(txt($(".bt-sources"))), txt($(".bt-scorecard")));
    assert("…saying it was just looked up", /Looked up just now/.test(txt($("#bt-check"))), txt($("#bt-check")));

    // ---- Add to my bar (not owned) ----
    INSERTS = [];
    click($('[data-bt="add"]'));
    await until(function () { return !!$(".bt-actions .bt-owned"); });
    var add = INSERTS.filter(function (i) { return i.table === "inventory_items"; })[0];
    assert("Add to my bar saves a bar row linked to the catalog bottle", !!add && add.row.section === "bar" && add.row.product_id === "p-bt" && add.row.category === "bourbon" && add.row.name === "Buffalo Trace Kentucky Straight Bourbon", JSON.stringify(add));
    assert("…and the button turns into In your bar", /In your bar/.test(txt($(".bt-actions"))), txt($(".bt-actions")));

    // ---- Wrong bottle? ----
    INSERTS = [];
    click($('[data-bt="report"]'));
    await until(function () { return INSERTS.some(function (i) { return i.table === "spirit_reports"; }); });
    var rep = INSERTS.filter(function (i) { return i.table === "spirit_reports"; })[0];
    assert("Wrong bottle? files a report for this bottle", !!rep && rep.row.product_id === "p-bt" && rep.row.kind === "wrong_bottle", JSON.stringify(rep));

    // ---- closing mid-lookup → toast with View ----
    click($('[data-bt="again"]'));
    await until(function () { return !!$("[data-bt-form]"); });
    FN["research-bottle"] = function () { return { status: "running", lookup_id: "L2" }; };
    LOOKUP_SCRIPT.L2 = [{ status: "running" }, { status: "found", product_id: "p-sc" }];
    T.spirit_products.push({ id:"p-x", canonical_name:"placeholder", category:"other" });
    f = $("[data-bt-form]"); f.elements.q.value = "Obscure Rum 12";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(function () { return screen() === "Not in the catalog yet"; });
    click($('[data-bt="research"]'));
    await until(function () { return screen() === "Looking it up"; });
    click($("#close-bottle"));
    assert("the sheet closes mid-lookup", $("#bottle-panel").hidden, "");
    await until(function () { var t = $(".toast-action"); return t && t.classList.contains("show"); }, 15000);
    var ta = $(".toast-action");
    assert("…and the finished lookup reports by a toast with View", !!ta && /Obscure Rum 12: expert scores found/.test(txt(ta)) && /View/.test(txt(ta.querySelector("button"))), ta ? txt(ta) : "none");
    click(ta && ta.querySelector("button"));
    await resultFor("Smith & Cross");
    assert("View opens the score card", !$("#bottle-panel").hidden && txt($(".bt-result-name")) === "Smith & Cross", txt($(".bt-result-name")));
    FN["research-bottle"] = DEFAULT_RESEARCH;

    // ---- a label photo ----
    CHECK["p-ec"] = function () { return { error: "You’ve used today’s 20 bottle lookups — it resets at midnight UTC. Try again tomorrow." }; };
    FN["identify-bottle"] = function () { return { label: { full_name: "Elijah Craig Small Batch Bourbon", brand: "Elijah Craig", expression: "Small Batch", category: "bourbon", age_years: null, abv: 47, proof: 94, batch: null, single_barrel: false, country: "USA" } }; };
    INVOKES = [];
    click($('[data-bt="again"]'));
    await until(function () { return !!$("[data-bt-form]"); });
    choosePhoto(pngFile());
    await resultFor("Elijah Craig Small Batch");
    var idf = INVOKES.filter(function (i) { return i.name === "identify-bottle"; })[0];
    assert("a photo is re-encoded and sent to identify-bottle", !!idf && typeof idf.body.image === "string" && idf.body.image.length > 20 && idf.body.media_type === "image/jpeg" && !/^data:/.test(idf.body.image), idf ? idf.body.image.slice(0, 30) : "no call");
    assert("the label's name, matched by its words, opens the score card", txt($(".bt-big")) === "7.5/10" && /Double Gold · 2022/.test(txt($(".bt-sources"))), txt($(".bt-scorecard")));
    await until(function () { return /Couldn’t check/.test(txt($("#bt-check"))); });
    assert("a check that hits the daily cap says so, keeping the score shown", /Couldn’t check for newer reviews: You’ve used today’s 20 bottle lookups/.test(txt($("#bt-check"))) && txt($(".bt-big")) === "7.5/10", txt($("#bt-check")));
    FN["identify-bottle"] = function () { return { error: "Couldn’t make out a label in that photo — try straight on, closer, or type the name." }; };
    click($('[data-bt="again"]'));
    await until(function () { return !!$("[data-bt-form]"); });
    choosePhoto(pngFile());
    await until(function () { return !!$(".bt-msg"); });
    assert("a photo the AI can't read says so, back on the start screen", /Couldn’t make out a label/.test(txt($(".bt-msg"))) && !!$("[data-bt-form]"), txt($(".bt-msg")));

    // ---- Escape ----
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await delay(50);
    assert("Escape closes the sheet", $("#bottle-panel").hidden, "");

    // ---- Bar & Pantry: score chips + linking ----
    click($("#open-inventory"));
    await until(function () { return !!$('[data-inv-score="p-green"]'); });
    var chip = $('[data-inv-score="p-green"]');
    assert("a linked bar bottle shows its score beside it", !!chip && txt(chip) === "8.5" && /Expert score 8\.5 out of 10 for Green Chartreuse/.test(chip.getAttribute("aria-label")), chip ? chip.outerHTML : "none");
    var lawsRow = $$("#inventory-content .inv-row").filter(function (r) { return /Laws/.test(txt(r)); })[0];
    assert("a linked bottle with no scores shows no chip", !!lawsRow && !lawsRow.querySelector(".inv-score"), lawsRow ? txt(lawsRow) : "no row");
    var before = INVOKES.length;
    click(chip);
    await resultFor("Green Chartreuse");
    await delay(200);
    assert("tapping the chip opens that bottle's score card", !$("#bottle-panel").hidden, "");
    assert("browsing to a card spends nothing, and says when it was last checked", INVOKES.length === before && /Reviews last checked today/.test(txt($("#bt-check"))) && !!$('[data-bt="verify"]'), txt($("#bt-check")));
    click($('[data-bt="verify"]'));
    await until(function () { return /Up to date/.test(txt($("#bt-check"))); });
    var vc = INVOKES.slice(before).filter(function (i) { return i.name === "research-bottle"; })[0];
    assert("Check for newer reviews runs a check of that bottle", !!vc && vc.body.product_id === "p-green" && /Up to date/.test(txt($("#bt-check"))), vc ? JSON.stringify(vc.body) : "none");
    click($("#close-bottle"));
    UPDATES = []; RPCS = [];
    $("#inv-category").value = "gin"; $("#inv-name").value = "Hendricks";
    $("#inv-add").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(function () { return UPDATES.some(function (u) { return u.table === "inventory_items" && u.patch.product_id; }); });
    var link = UPDATES.filter(function (u) { return u.table === "inventory_items" && u.patch.product_id; })[0];
    assert("a bottle typed in by hand is linked to its catalog entry on a sure match", !!link && link.patch.product_id === "p-hen", JSON.stringify(link));
    await until(function () { return !!$('[data-inv-score="p-hen"]'); });
    assert("…and its score appears beside it", txt($('[data-inv-score="p-hen"]')) === "7.5", $$(".inv-score").map(function (c) { return c.dataset.invScore + "=" + txt(c); }).join());
    assert("the bottle added from the score card shows its score too", txt($('[data-inv-score="p-bt"]')) === "8.0", "");
    $("#close-inventory") && click($("#close-inventory"));

    // ---- leaving the Bar tab leaves Bottles ----
    click($(".tab-kitchen"));
    await delay(120);
    assert("switching to Kitchen leaves Bottles for the recipe list", $("#bottles-view").hidden && $("#mode-bottles").hidden, "");

    // ---- meal planning is Kitchen-only, even with something staged ----
    var pick = document.querySelector('.item[data-id="k1"] .plan-pick');
    assert("Kitchen rows keep their 📅 stage box", !!pick, "");
    click(pick);
    await delay(150);
    assert("staging a kitchen recipe shows the Meal plan tab and the staged pill", !$("#mode-mealplan").hidden && !$("#staged-count").hidden, "");
    click($("#mode-mealplan"));
    await delay(200);
    click($(".tab-bar"));
    await delay(150);
    assert("switching to Bar from Meal plan lands on Recipes", !$("#meal-plan-view").hidden === false && $("#mode-recipes").getAttribute("aria-selected") === "true", "");
    assert("Bar: Meal plan tab and staged pill stay hidden with a plan", $("#mode-mealplan").hidden && $("#staged-count").hidden, "");
    click($(".tab-kitchen"));
    await delay(150);
    assert("back on Kitchen, the plan is still there", !$("#mode-mealplan").hidden && !$("#staged-count").hidden, "");
  } catch (e) { assert("no exception", false, String(e && e.stack || e)); }
  assert("no uncaught JS errors", JS_ERRORS.length === 0, JS_ERRORS.join(" | ").slice(0, 400));
  finish();
}
""" + BOOT + r"""
</script></body></html>"""

B_APP_PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUNNING</title><link rel="stylesheet" href="style.css">
<script>""" + STUB + r"""</script></head>
<body><script>""" + HELPERS + r"""
function finish() { parent.postMessage({ w: innerWidth, results: RESULTS }, "*"); }
function fits(name, el) {
  var W = document.documentElement.clientWidth, r = el && el.getBoundingClientRect();
  assert(name + " fits on screen", !!r && r.left >= -0.5 && r.right <= W + 0.5, r ? r.left.toFixed(1) + ".." + r.right.toFixed(1) + " of " + W : "missing");
}
function tall(name, els) {
  var short = els.filter(function (e) { return e.getBoundingClientRect().height < 44; });
  assert(name + " are 44px touch targets", els.length > 0 && !short.length, els.length + " found, " + short.length + " short: " + short.slice(0, 3).map(function (e) { return (e.className || e.tagName) + "@" + e.getBoundingClientRect().height.toFixed(0); }).join(", "));
}
function noSideScroll(name) {
  var W = document.documentElement.clientWidth, bad = [];
  $$("body *").forEach(function (el) {
    if (el.closest("[hidden]") || !el.getClientRects().length) return;
    var r = el.getBoundingClientRect();
    if (r.width && r.right > W + 0.5) bad.push((el.id || el.className || el.tagName) + "@" + r.right.toFixed(0));
  });
  assert(name + ": nothing runs past the right edge", !bad.length && document.documentElement.scrollWidth <= W, bad.slice(0, 5).join(", ") + " scrollW=" + document.documentElement.scrollWidth);
}
async function runTests() {
  try {
    await toBottles();
    fits("Look up a bottle", $("#bt-open"));
    tall("the lookup button, search, chips and rows", [$("#bt-open"), $("#bt-view-q"), $("#bt-view-search button")].concat($$(".bt-chip"), $$("#bt-best .bt-row")));
    noSideScroll("Bottles view");
    await typeLookup("Green Chartreuse");
    await resultFor("Green Chartreuse");
    await delay(200);
    fits("the score card", $(".bt-scorecard"));
    tall("score card actions and review rows", $$(".bt-actions > *").concat($$(".bt-sources .bt-src"), [$(".bt-report")]));
    noSideScroll("score card");
    click($('[data-bt="again"]'));
    await until(function () { return !!$("[data-bt-form]"); });
    fits("the photo target", $(".bt-photo-target"));
    tall("start-screen buttons", [$(".bt-photo-target"), $('[data-bt="pick"]'), $("[data-bt-form] .search"), $("[data-bt-form] button")]);
    noSideScroll("start screen");
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
window.addEventListener("message", function (e) {
  rows.push({ w: e.data.w, r: e.data.results || [] });
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
        capture_output=True, text=True, timeout=240).stdout


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
        out_a = chrome(f"http://127.0.0.1:{port}/{A_HTML.name}", 60000)
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
        fails = [r for r in row["r"] if not r["pass"]]
        total += len(row["r"]); passed += len(row["r"]) - len(fails)
        print(f"  {row['w']}px: {len(row['r']) - len(fails)}/{len(row['r'])}")
        for f in fails:
            print(f"      FAIL {f['name']}  >> {f['detail']}")
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if passed == total else 2)


if __name__ == "__main__":
    main()
