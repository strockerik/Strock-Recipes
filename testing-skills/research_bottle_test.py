#!/usr/bin/env python3
"""research-bottle offline test: the checks and the writes (no backend, no spend).

research-bottle is what lets in-app lookups grow the SHARED catalog, so its
rules are the trust boundary. This pulls the real function body out of
supabase/functions/research-bottle/index.ts (everything above Deno.serve),
strips the TypeScript, and runs it in headless Chrome against:
  - a scripted Anthropic API (fetch stub): the three curated search stages run
    in order, each limited to its own sites (critics → competitions → open web
    minus the blocked list), then one forced record_scores call; pause_turn is
    resumed, a strict-schema 400 falls back to non-strict, citations and result
    URLs are collected;
  - an in-memory Supabase (a tiny chainable query builder over JS arrays):
    runLookup creates the bottle, saves only vetted scores as unverified field
    rows, confirms (not duplicates) a review the catalog already has, adds the
    label's spelling as an alias, and closes the lookup row; "nothing kept"
    closes it as none. Checking a KNOWN bottle: a still-cited score is stamped
    (and verified if someone else found it), a page showing a different score
    files a report and leaves the score alone, an uncited one is left unchecked.
vet() is driven directly with one finding per rule (invented URL, blocked site,
retailer, other bottle, score missing from the cited text, uncited, duplicate,
out-of-range score, each scale's conversion).

Run from anywhere in the repo:  python3 testing-skills/research_bottle_test.py
"""
import json, pathlib, re, subprocess, sys, tempfile

def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "supabase" / "functions" / "research-bottle").exists():
            return d
    sys.exit("no repo root found")
REPO = find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC = (REPO / "supabase/functions/research-bottle/index.ts").read_text()

def body():
    start = SRC.index("\n", SRC.index('import { createClient }')) + 1
    end = SRC.index("declare const EdgeRuntime")
    return SRC[start:end]

def strip_ts(ts):
    ts = re.sub(r"^type \w+ = \{\n.*?^\};\n", "", ts, flags=re.M | re.S)     # multi-line type aliases
    ts = re.sub(r"^\s*type \w+ = [^\n]*;\n", "", ts, flags=re.M)             # one-line ones
    ts = re.sub(r"^\s*// deno-lint-ignore[^\n]*\n", "", ts, flags=re.M)
    # function vet(...): { kept: Kept[]; ... } {
    ts = re.sub(r"function vet\([^\n]*\{\n", "function vet(found, wantAttrs, sourceRows, bottleKey = \"\") {\n", ts)
    ts = re.sub(r"(const SCALE_FOR)\s*:[^\n]*= \{", r"\1 = {", ts)
    # Signatures this file uses that the generic rules below can't safely reach
    # (an object-type rule would also eat object literals like headers: {...}).
    for a, b in [("plan: { critics: PlanSource[]; competitions: PlanSource[] }", "plan"),
                 (": Promise<{ status: number; data?: any; text?: string }> {", " {"),
                 (": { confirmed: string[]; changed: { id: string; now: string; url: string }[] } {", " {"),
                 ("changed: { id: string; now: string; url: string }[] = []", "changed = []"),
                 ("(s: { id: string } & SourceRow)", "(s)"),
                 ("model: string = MODEL", "model = MODEL")]:
        ts = ts.replace(a, b)
    ts = re.sub(r"(\w+)\s*:\s*Map<[^>]*>(?=[,)])", r"\1", ts)
    ts = re.sub(r"(\w+)\s*:\s*[A-Z]\w*\[\](?=[,)])", r"\1", ts)
    ts = re.sub(r"(\w+)\s*:\s*(?:Known|PlanSource|SourceRow|FoundCheck|FoundReview|Research)(?=[,)])", r"\1", ts)
    ts = re.sub(r"(\w+)\s*:\s*number \| null(?=[,)])", r"\1", ts)
    ts = re.sub(r"\b(const|let) (\w+)\s*:\s*[^=\n]+?\s=(?!>)", r"\1 \2 =", ts)
    ts = re.sub(r"(\w+)\s*:\s*(?:number|string) \| null\s*=", r"\1 =", ts)
    ts = re.sub(r"new (Map|Set)<.*?>\(", r"new \1(", ts)
    ts = re.sub(r"\((\w+): \{[^}]*\}\)", r"(\1)", ts)                          # (b: { type: string })
    ts = re.sub(r"\((\w+): \w+\) =>", r"(\1) =>", ts)                          # (why: string) =>
    ts = re.sub(r"(\w+)\??\s*:\s*(?:unknown|string|number|boolean|any|Db|Attrs|Research|FoundReview|string \| null|Record<string, (?:unknown|string|number)>)(?=[,)])", r"\1", ts)
    ts = re.sub(r"\)\s*:\s*(?:Promise<[^{]*?>|string\[\]|string \| null|number \| null|string|number|boolean|any|Set<string>)\s*\{", ") {", ts)
    ts = re.sub(r"\s+as (?:number|string)(?: \| null)?\b", "", ts)
    ts = re.sub(r"(\w|\]|\))!(?=[\s,);.])", r"\1", ts)                       # non-null assertions
    ts = ts.replace(" as string)", ")")
    return ts

# One scripted model reply per call: what research() should do with each.
WS = lambda *urls: {"type": "web_search_tool_result", "tool_use_id": "s1", "content": [{"type": "web_search_result", "url": u, "title": "t", "encrypted_content": "x"} for u in urls]}
CITE = lambda url, cited, text="x": {"type": "text", "text": text, "citations": [{"type": "web_search_result_location", "url": url, "cited_text": cited}]}
REC = lambda reviews, name="Buffalo Trace Kentucky Straight Bourbon": {"type": "tool_use", "id": "t1", "name": "record_scores", "input": {
    "bottle": {"canonical_name": name, "category": "bourbon", "producer": "Buffalo Trace", "country": "USA", "age_years": None, "abv": 45},
    "reviews": reviews}}
WE = "https://www.wineenthusiast.com/buying-guide/buffalo-trace/"
DH = "https://www.drinkhacker.com/2020/01/01/review-buffalo-trace/"
BR = "https://www.buffalotracedistillery.com/awards"
def R(url, source, scale, score=None, medal=None, year=2022, named="Buffalo Trace Kentucky Straight Bourbon", kind="critic"):
    return {"source_name": source, "kind": kind, "url": url, "year": year, "scale": scale, "score": score, "medal": medal, "reviewer": None, "bottle_as_named": named}

SCRIPTS = {}

def safe(o):
    return json.dumps(o).replace("</", "<\\/")

PAGE = r"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const Deno = { env: { get: (k) => (k === "ANTHROPIC_API_KEY" ? "test" : "") } };
__BODY__
const SCRIPTS = __SCRIPTS__;
let queue = [], sent = [];
window.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  const r = queue.shift() || { status: 500, body: {} };
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) };
};
// A tiny Supabase stand-in: chainable filters over in-memory tables.
function makeDb(tables) {
  let seq = 0;
  const from = (t) => {
    const st = { t, f: [], op: "select", row: null, single: false, limit: null, opts: {} };
    const rows = () => (tables[t] || (tables[t] = []));
    const match = (r) => st.f.every(([c, v, k]) => k === "eq" ? r[c] === v : k === "gte" ? r[c] >= v : true);
    const exec = () => {
      if (st.op === "insert") {
        const made = (Array.isArray(st.row) ? st.row : [st.row]).map((r) => ({ id: "id" + (++seq), ...r }));
        if (t === "spirit_products" && made.some((m) => rows().some((r) => r.name_norm === m.name_norm)))
          return { data: null, error: { message: "duplicate key" } };
        rows().push(...made);
        return { data: st.single ? made[0] : made, error: null };
      }
      if (st.op === "upsert") {
        const key = (st.opts.onConflict || "id").split(",");
        for (const r of st.row) {
          if (rows().some((e) => key.every((k) => e[k] === r[k]))) continue;
          rows().push({ id: "id" + (++seq), ...r });
        }
        return { data: null, error: null };
      }
      if (st.op === "update") { rows().filter(match).forEach((r) => Object.assign(r, st.row)); return { data: null, error: null }; }
      let out = rows().filter(match);
      if (st.limit != null) out = out.slice(0, st.limit);
      return { data: st.single ? (out[0] || null) : out, error: null, count: out.length };
    };
    const b = {
      select() { return b; }, eq(c, v) { st.f.push([c, v, "eq"]); return b; }, gte(c, v) { st.f.push([c, v, "gte"]); return b; },
      order() { return b; }, limit(n) { st.limit = n; return b; }, single() { st.single = true; return b; }, maybeSingle() { st.single = true; return b; },
      insert(r) { st.op = "insert"; st.row = r; return b; }, update(r) { st.op = "update"; st.row = r; return b; },
      upsert(r, o) { st.op = "upsert"; st.row = r; st.opts = o || {}; return b; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); }
    };
    return b;
  };
  return { from, tables };
}
const SOURCES = [
  { id: "wine_enthusiast", name: "Wine Enthusiast", scale: "wine_enthusiast", default_weight: 1.0 }, { id: "drinkhacker", name: "Drinkhacker", scale: "drinkhacker", default_weight: 1.0 },
  { id: "whiskey_wash", name: "The Whiskey Wash", scale: "ten", default_weight: 0.8 }, { id: "sfwsc", name: "San Francisco World Spirits Competition", scale: "sfwsc", default_weight: 0.5 },
  { id: "iwsc", name: "IWSC", scale: "iwsc", default_weight: 0.8 }, { id: "other_critic", name: "Other critic", scale: "critic100", default_weight: 0.5 },
  { id: "other_competition", name: "Other competition", scale: "medal", default_weight: 0.5 }, { id: "usc", name: "Ultimate Spirits Challenge", scale: "critic100", default_weight: 0.8 }
].map((x) => Object.assign({ kind: /^(wine_enthusiast|drinkhacker|whiskey_wash|other_critic)$/.test(x.id) ? "critic" : "competition" }, x));
const srcMap = new Map(SOURCES.map((s) => [s.id, s]));
const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail === undefined ? "" : JSON.stringify(detail) });
(async () => {
  try {
    // ---- research(): the curated stages ----
    const END = (content, extra) => ({ status: 200, body: Object.assign({ stop_reason: "end_turn", content: content || [] }, extra || {}) });
    const RECORD = (content) => ({ status: 200, body: { stop_reason: "tool_use", content } });
    const PLAN = planFor("bourbon", DEFAULT_SEARCH_PLAN);
    queue = [END([{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }, WS(__WE__), CITE(__WE__, "rating 92 ... buffalo trace")], { usage: { server_tool_use: { web_search_requests: 2 } } }),
             END([WS(__BR__), CITE(__BR__, "2024 double gold")]), END([]), RECORD([REC([__R__(__WE__, "Wine Enthusiast", "points_100", 92)])])];
    sent = [];
    let r = await research("Buffalo Trace", "", PLAN, []);
    const aD = (i) => (sent[i] && sent[i].tools[0].allowed_domains) || [];
    ok("stage 1 searches only the critics, whiskey critics included for a bourbon",
      sent[0].tools.length === 1 && ["wineenthusiast.com", "drinkhacker.com", "whiskyadvocate.com", "breakingbourbon.com", "thewhiskeywash.com", "whiskycast.com"].every((d) => aD(0).includes(d)) && !aD(0).includes("iwsc.net") && !sent[0].tools[0].blocked_domains, aD(0));
    ok("stage 2 searches only competitions' results", ["iwsc.net", "daily.sevenfifty.com", "thespiritsbusiness.com", "concoursmondial.com"].every((d) => aD(1).includes(d)) && !aD(1).includes("wineenthusiast.com"), aD(1));
    ok("stage 3 is the open web minus the blocked list", !sent[2].tools[0].allowed_domains && sent[2].tools[0].blocked_domains.includes("distiller.com"), sent[2].tools[0]);
    ok("each stage asks for its own thing, in order", /Stage 1 of 3/.test(JSON.stringify(sent[0].messages)) && /Stage 2 of 3/.test(JSON.stringify(sent[1].messages.slice(-1))) && /Stage 3 of 3/.test(JSON.stringify(sent[2].messages.slice(-1))), "");
    ok("the record call is forced, strict, and carries every stage's results", sent.length === 4 && sent[3].tool_choice.name === "record_scores" && sent[3].tools[1].strict === true && sent[3].messages.length === 7, sent.map((x) => x.messages.length));
    ok("result URLs and cited text collected across stages", r.resultUrls.has(__WE__) && r.resultUrls.has(__BR__) && (r.cited.get(__WE__) || [])[0] === "rating 92 ... buffalo trace", [...r.resultUrls]);
    ok("searches counted", r.searches === 2, r.searches);
    ok("record_scores input returned", r.reviews.length === 1 && r.bottle.canonical_name === "Buffalo Trace Kentucky Straight Bourbon" && Array.isArray(r.checks), r.reviews);
    const RUM = planFor("rum", DEFAULT_SEARCH_PLAN);
    ok("a rum's critic stage skips the whiskey-only critics", RUM.critics.map((x) => x.id).join() === "wine_enthusiast,drinkhacker", RUM.critics.map((x) => x.id));
    queue = [{ status: 200, body: { stop_reason: "pause_turn", content: [WS(__WE__)] } }, END([CITE(__WE__, "rating 92")]), END(), END(), RECORD([REC([])])]; sent = [];
    r = await research("Buffalo Trace", "", PLAN, []);
    ok("a paused stage is resumed with its content sent back, then the next stage runs", sent.length === 5 && sent[1].messages[sent[1].messages.length - 1].role === "assistant" && /Stage 2 of 3/.test(JSON.stringify(sent[2].messages.slice(-1))), sent.map((x) => x.messages.length));
    queue = [END(), END(), END(), { status: 400, body: { error: { message: "strict schema" } } }, RECORD([REC([])])]; sent = [];
    r = await research("Buffalo Trace", "", PLAN, []);
    ok("a strict-schema 400 on the record call retries once without strict", sent.length === 5 && sent[3].tools[1].strict === true && !("strict" in sent[4].tools[1]) && !r.error, sent.map((x) => x.tools[1] && x.tools[1].name));
    queue = [END(), END(), END(), { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: 'tool_choice: type "tool" and "any" are not supported for this model.' } } }, RECORD([REC([])])]; sent = [];
    r = await research("Buffalo Trace", "", PLAN, [], "claude-sonnet-5-5");
    ok("a model that refuses a forced tool gets record_scores offered instead", sent.length === 5 && sent[3].tool_choice.type === "tool" && sent[4].tool_choice.type === "auto" && !r.error && sent[4].model === "claude-sonnet-5-5", sent.map((x) => x.tool_choice && x.tool_choice.type));
    ok("the run adds up its cost at the model's prices", typeof r.cost === "number", r.cost);
    queue = [{ status: 529, body: { error: { message: "overloaded" } } }]; sent = [];
    r = await research("Buffalo Trace", "", PLAN, []);
    ok("an API error comes back as an error with its HTTP status and message, not findings", /^api \(HTTP 529: overloaded\)/.test(r.error) && r.reviews.length === 0, r);
    const KNOWN = [{ id: "rv1", ref: "r1", source_id: "wine_enthusiast", source: "Wine Enthusiast", scale: "wine_enthusiast", score_raw: 92, medal: null, review_year: 2022, url: __WE__ }];
    queue = [END(), END(), END(), RECORD([REC([])])]; sent = [];
    await research("Buffalo Trace", "", PLAN, KNOWN);
    ok("a known bottle's scores are listed for checking, and the record asks for checks", /\[r1\] Wine Enthusiast · 92 points · 2022/.test(JSON.stringify(sent[0].messages[0])) && /one entry in checks/.test(JSON.stringify(sent[3].messages.slice(-1))), JSON.stringify(sent[0].messages[0]).slice(0, 300));

    // ---- vetChecks(): checks of scores we already have ----
    const chk = (status, url, cites, now) => vetChecks({ checks: [{ review_ref: "r1", status, url, now_says: now || null }], resultUrls: new Set([__WE__, __DH__]), cited: new Map(Object.entries(cites)) }, KNOWN);
    let c = chk("confirmed", __WE__, { [__WE__]: ["rating 92 points"] });
    ok("check confirmed: the cited page still shows 92", c.confirmed.join() === "rv1" && !c.changed.length, c);
    c = chk("confirmed", __WE__, { [__WE__]: ["a fine bourbon"] });
    ok("check not confirmed when the cited text doesn't show the score", !c.confirmed.length, c);
    c = chk("changed", __WE__, { [__WE__]: ["rating 89 points"] }, "89");
    ok("check changed: the page shows 89 and not 92 → flagged", c.changed.length === 1 && c.changed[0].now === "89" && !c.confirmed.length, c);
    c = chk("changed", __WE__, { [__WE__]: ["rating 92 points, previously 89"] }, "89");
    ok("not 'changed' while the page still shows the old score", !c.changed.length, c);
    c = chk("confirmed", __WE__, {});
    ok("unchecked when the page wasn't cited", !c.confirmed.length && !c.changed.length, c);
    c = vetChecks({ checks: [{ review_ref: "r1", status: "confirmed", url: "https://invented.example", now_says: null }], resultUrls: new Set([__WE__]), cited: new Map([["https://invented.example", ["92"]]]) }, KNOWN);
    ok("a check on a page outside the search results doesn't count", !c.confirmed.length, c);

    // ---- vet(): one finding per rule ----
    const base = (reviews, urls, cites) => ({ reviews, resultUrls: new Set(urls), cited: new Map(Object.entries(cites || {})), searches: 1 });
    const one = (rev, urls, cites, want) => vet(base([rev], urls, cites), want || {}, srcMap);
    let v = one(__R__(__WE__, "Wine Enthusiast", "points_100", 92), [__WE__], { [__WE__]: ["rating 92"] });
    ok("kept: WE 92, cited → wine_enthusiast scale (8.0, as normalize.py)", v.kept.length === 1 && v.kept[0].row.source_id === "wine_enthusiast" && v.kept[0].row.score_10 === 8 && v.kept[0].row.weight === 1, v);
    v = one(__R__("https://invented.example/review", "Wine Enthusiast", "points_100", 92), [__WE__]);
    ok("dropped: URL not in the search results", !v.kept.length && v.dropped["url not in search results"] === 1, v.dropped);
    v = one(__R__("https://distiller.com/spirits/buffalo-trace", "Distiller", "points_100", 90), ["https://distiller.com/spirits/buffalo-trace"]);
    ok("dropped: a blocked site", !v.kept.length && v.dropped["excluded site"] === 1, v.dropped);
    v = one(__R__("https://www.totalwine.com/p/buffalo-trace", "Wine Enthusiast", "points_100", 92), ["https://www.totalwine.com/p/buffalo-trace"]);
    ok("dropped: a retailer quoting a score", !v.kept.length && v.dropped["excluded site"] === 1, v.dropped);
    v = one(__R__("https://www.example.org/community", "Whiskybase community", "points_100", 85), ["https://www.example.org/community"]);
    ok("dropped: community ratings", !v.kept.length && v.dropped["excluded source"] === 1, v.dropped);
    v = one(__R__(__WE__, "Wine Enthusiast", "points_100", 95, null, 2022, "Buffalo Trace 12 Year Old"), [__WE__], null, { age_years: null });
    ok("kept: an age on one side only isn't a conflict", v.kept.length === 1, v.dropped);
    v = one(__R__(__WE__, "Wine Enthusiast", "points_100", 95, null, 2022, "Buffalo Trace 12 Year Old"), [__WE__], null, { age_years: 8 });
    ok("dropped: a different age is a different bottle", !v.kept.length && v.dropped["different bottle"] === 1, v.dropped);
    v = one(__R__(__WE__, "Wine Enthusiast", "points_100", 96), [__WE__], { [__WE__]: ["rating 92 points"] });
    ok("dropped: cited page doesn't show that score", !v.kept.length && v.dropped["score not in cited text"] === 1, v.dropped);
    v = one(__R__(__WE__, "Wine Enthusiast", "points_100", 92), [__WE__], {});
    ok("kept: in the results but uncited (counts ¾ as unverified)", v.kept.length === 1, v.dropped);
    v = one(__R__(__DH__, "Drinkhacker", "out_of_10", 9.0), [__DH__], { [__DH__]: ["a- / $30"] });
    ok("kept: Drinkhacker 9.0 cited as its letter grade A- → 8.0", v.kept.length === 1 && v.kept[0].row.score_10 === 8 && v.kept[0].row.source_id === "drinkhacker", v);
    v = one(__R__(__BR__, "San Francisco World Spirits Competition", "medal", null, "Double Gold", 2024, "Buffalo Trace Bourbon", "competition"), [__BR__], { [__BR__]: ["2024 double gold, san francisco"] });
    ok("kept: SFWSC Double Gold from the brand's page → sfwsc 8.5 at half weight", v.kept.length === 1 && v.kept[0].row.source_id === "sfwsc" && v.kept[0].row.score_10 === 8.5 && v.kept[0].row.weight === 0.5, v);
    v = one(__R__("https://thewhiskeywash.com/reviews/bt/", "The Whiskey Wash", "points_100", 86), ["https://thewhiskeywash.com/reviews/bt/"]);
    ok("kept: Whiskey Wash's old 100-point review reads on the critic100 scale (6.67)", v.kept.length === 1 && v.kept[0].row.score_10 === 6.67, v);
    v = one(__R__("https://smallblog.example/bt", "Some Bourbon Blog", "points_100", 88), ["https://smallblog.example/bt"]);
    ok("kept: an unknown critic → other_critic, publication as reviewer, half weight", v.kept.length === 1 && v.kept[0].row.source_id === "other_critic" && v.kept[0].row.reviewer === "Some Bourbon Blog" && v.kept[0].row.weight === 0.5, v);
    v = one(__R__(__WE__, "Wine Enthusiast", "points_100", 140), [__WE__]);
    ok("dropped: score out of range", !v.kept.length && v.dropped["score out of range"] === 1, v.dropped);
    v = one(__R__(__BR__, "SFWSC", "medal", null, "Packaging Gold", 2024, "Buffalo Trace", "competition"), [__BR__]);
    ok("dropped: a packaging award", !v.kept.length && v.dropped["no usable score"] === 1, v.dropped);
    v = vet(base([__R__(__WE__, "Wine Enthusiast", "points_100", 92), __R__(__WE__ + "?x", "Wine Enthusiast", "points_100", 92)], [__WE__, __WE__ + "?x"]), {}, srcMap);
    ok("dropped: the same review twice", v.kept.length === 1 && v.dropped.duplicate === 1, v.dropped);
    v = one(__R__(__WE__, "Wine Enthusiast", "points_100", 92, null, 2099), [__WE__]);
    ok("a future year is dropped to null, not kept as-is", v.kept.length === 1 && v.kept[0].row.review_year === null, v.kept);

    // ---- the listing-page rule, merged entries, blogs ----
    const LIST = "https://www.iwsc.net/results/search/2024/184";
    TITLES[LIST] = "IWSC 2024 results";
    const bk = normName("Buffalo Trace");
    const lst = (cites, rev) => vet({ reviews: [rev || __R__(LIST, "IWSC", "medal", null, "Silver", 2024, "Buffalo Trace Bourbon", "competition")], resultUrls: new Set([LIST]), cited: new Map(Object.entries(cites)), titles: new Map([[LIST, TITLES[LIST]]]), searches: 1 }, {}, srcMap, bk);
    v = lst({});
    ok("a results list that doesn't name the bottle, uncited → dropped", !v.kept.length && v.dropped["listing page without a cited line naming the bottle"] === 1, v.dropped);
    v = lst({ [LIST]: ["elijah craig toasted barrel — silver"] });
    ok("…cited, but the cited line names another bottle → dropped", !v.kept.length, v.dropped);
    v = lst({ [LIST]: ["buffalo trace kentucky straight bourbon · silver 2024"] });
    ok("…a cited line naming the bottle with its medal → kept", v.kept.length === 1 && v.kept[0].row.medal === "Silver", v);
    const BSA = "https://bartenderspiritsawards.com/en/winner-brands/spirits/2026/buffalo-trace";
    v = vet({ reviews: [__R__(BSA, "Bartender Spirits Awards", "medal", null, "Gold", 2026, "Buffalo Trace", "competition"), __R__(BSA, "Bartender Spirits Awards", "points_100", 94, null, 2026, "Buffalo Trace", "competition")],
      resultUrls: new Set([BSA]), cited: new Map(), titles: new Map([[BSA, "Buffalo Trace - Bartender Spirits Awards"]]), searches: 1 }, {}, new Map([...srcMap, ["bartender_spirits_awards", { scale: "critic100", default_weight: 0.5 }]]), bk);
    ok("one competition entry's medal and points become one score", v.kept.length === 1 && v.kept[0].row.score_raw === 94 && v.kept[0].row.medal === "Gold" && v.dropped["medal merged into its points"] === 1, v);
    const blog = (i, year, score) => __R__("https://blog" + i + ".example/bt", "Blog " + i, "points_100", score, null, year);
    v = vet({ reviews: [blog(1, 2019, 84), blog(2, 2025, 88), blog(3, 2023, 86)], resultUrls: new Set([1, 2, 3].map((i) => "https://blog" + i + ".example/bt")), cited: new Map(), titles: new Map(), searches: 1 }, {}, srcMap);
    ok("at most two independent reviewers, the most recent", v.kept.length === 2 && v.kept.map((k) => k.row.review_year).join() === "2025,2023" && v.dropped["more than two independent reviewers"] === 1, v.kept.map((k) => k.row.review_year));
    v = vet({ reviews: [__R__("https://blog9.example/bt", "Blog 9", "out_of_10", 8.5, null, 2024)], resultUrls: new Set(["https://blog9.example/bt"]), cited: new Map(), titles: new Map(), searches: 1 }, {}, srcMap);
    ok("a blog's 8.5/10 reads like an 85/100 (6.5), not as 8.5", v.kept.length === 1 && v.kept[0].row.score_10 === 6.5 && v.kept[0].row.score_raw === 8.5, v.kept);
    const BAND = [{ id: "rb", ref: "r1", source_id: "wine_enthusiast", source: "Wine Enthusiast", scale: "wine_enthusiast", score_raw: 98, medal: null, review_year: 2007, url: __WE__ }];
    c = vetChecks({ checks: [{ review_ref: "r1", status: "changed", url: __WE__, now_says: "96-100" }], resultUrls: new Set([__WE__]), cited: new Map([[__WE__, ["rating 96-100"]]]) }, BAND);
    ok("a known band midpoint (98) is confirmed by a page printing 96-100, not flagged", c.confirmed.join() === "rb" && !c.changed.length, c);

    // ---- blogs only fill gaps ----
    const gapDb = (tables) => makeDb(Object.assign({ rating_sources: SOURCES.slice(), spirit_products: [], spirit_aliases: [], spirit_reviews: [], spirit_lookups: [] }, tables));
    const BLOG = "https://someblog.example/buffalo-trace";
    queue = [END([WS(__WE__, BLOG), CITE(__WE__, "rating 92")]), END(), END(),
      RECORD([REC([__R__(__WE__, "Wine Enthusiast", "points_100", 92), __R__(BLOG, "Some Blog", "points_100", 99)])])];
    let ev = await evaluate(gapDb({}), "Buffalo Trace", {}, null);
    ok("a blog is left out when a named critic scored the bottle in the same lookup", ev.kept.length === 1 && ev.kept[0].row.source_id === "wine_enthusiast" && ev.dropped["independent reviewer (a named critic has scored it)"] === 1, ev.dropped);
    queue = [END([WS(BLOG)]), END(), END(), RECORD([REC([__R__(BLOG, "Some Blog", "points_100", 88)])])];
    ev = await evaluate(gapDb({}), "Buffalo Trace", {}, null);
    ok("…but fills the gap when no named critic has", ev.kept.length === 1 && ev.kept[0].row.source_id === "other_critic", ev.kept);
    queue = [END([WS(BLOG)]), END(), END(), RECORD([REC([__R__(BLOG, "Some Blog", "points_100", 88)])])];
    ev = await evaluate(gapDb({ spirit_products: [{ id: "pk", category: "bourbon" }], spirit_reviews: [{ id: "x1", product_id: "pk", source_id: "drinkhacker", score_raw: 9, medal: null, review_year: 2020, url: __DH__, match_status: "auto" }] }), "Buffalo Trace", {}, "pk");
    ok("…and is left out when the catalog already has a named critic's score", !ev.kept.length, ev.dropped);

    // ---- runLookup(): the writes ----
    const db = makeDb({ rating_sources: SOURCES.slice(), spirit_products: [], spirit_aliases: [], spirit_reviews: [],
      spirit_lookups: [{ id: "L1", status: "running", name_norm: "buffalo trace" }] });
    queue = [END([WS(__WE__, __BR__), CITE(__WE__, "rating 92")]), END(), END(),
      RECORD([REC([__R__(__WE__, "Wine Enthusiast", "points_100", 92), __R__(__BR__, "San Francisco World Spirits Competition", "medal", null, "Double Gold", 2024, "Buffalo Trace Bourbon", "competition"),
           __R__("https://invented.example/x", "Whisky Advocate", "points_100", 99)])])];
    await runLookup(db, "L1", "user-1", "Buffalo Trace", { abv: 45 }, null);
    const T = db.tables;
    const prod = T.spirit_products[0];
    ok("a new bottle is created from the canonical name, by this user", T.spirit_products.length === 1 && prod.canonical_name === "Buffalo Trace Kentucky Straight Bourbon" && prod.name_norm === "buffalo trace bourbon" && prod.created_by === "user-1" && prod.category === "bourbon" && !!prod.researched_at, prod);
    ok("only vetted scores are saved, as unverified field rows", T.spirit_reviews.length === 2 && T.spirit_reviews.every((x) => x.origin === "field" && x.verified === false && x.added_by === "user-1" && x.product_id === prod.id && x.match_status === "auto"), T.spirit_reviews);
    ok("source_ref is url#product:year:reviewer", T.spirit_reviews.some((x) => x.source_ref === __WE__ + "#" + prod.id + ":2022:"), T.spirit_reviews.map((x) => x.source_ref));
    ok("both spellings point at the bottle", ["buffalo trace", "buffalo trace bourbon"].every((k) => T.spirit_aliases.some((a) => a.alias_norm === k && a.product_id === prod.id)), T.spirit_aliases);
    const L1 = T.spirit_lookups.find((l) => l.id === "L1");
    ok("the lookup closes as found with the count and a detail line", L1.status === "found" && L1.added === 2 && L1.product_id === prod.id && /1 url not in search results/.test(L1.detail) && !!L1.finished_at, L1);

    // A second, independent lookup of the same bottle confirms instead of copying.
    T.spirit_lookups.push({ id: "L2", status: "running", name_norm: "buffalo trace" });
    queue = [END([WS(__WE__), CITE(__WE__, "rating 92")]), END(), END(), RECORD([REC([__R__(__WE__, "Wine Enthusiast", "points_100", 92)])])];
    await runLookup(db, "L2", "user-2", "Buffalo Trace", {}, prod.id);
    const we = T.spirit_reviews.filter((x) => x.source_id === "wine_enthusiast");
    ok("another user re-finding a review marks it verified, adds no copy", we.length === 1 && we[0].verified === true && we[0].seen_count === 2, we);
    ok("…and that lookup closes found with 0 added", T.spirit_lookups.find((l) => l.id === "L2").added === 0, T.spirit_lookups.find((l) => l.id === "L2"));

    // The same user re-finding their own unverified find doesn't verify it.
    T.spirit_reviews.find((x) => x.source_id === "sfwsc").verified = false;
    T.spirit_lookups.push({ id: "L3", status: "running", name_norm: "buffalo trace" });
    queue = [END([WS(__BR__)]), END(), END(), RECORD([REC([__R__(__BR__, "San Francisco World Spirits Competition", "medal", null, "Double Gold", 2024, "Buffalo Trace Bourbon", "competition")])])];
    await runLookup(db, "L3", "user-1", "Buffalo Trace", {}, prod.id);
    ok("the same user re-finding their own find can't verify it", T.spirit_reviews.find((x) => x.source_id === "sfwsc").verified === false, T.spirit_reviews.find((x) => x.source_id === "sfwsc"));

    // Nothing kept → none; the bottle (if known) is marked researched.
    T.spirit_lookups.push({ id: "L4", status: "running", name_norm: "obscure rye" });
    queue = [END([WS("https://www.totalwine.com/p/obscure")]), END(), END(), RECORD([REC([__R__("https://www.totalwine.com/p/obscure", "Wine Enthusiast", "points_100", 95, null, 2023, "Obscure Rye")], "Obscure Rye")])];
    await runLookup(db, "L4", "user-1", "Obscure Rye", {}, null);
    const L4 = T.spirit_lookups.find((l) => l.id === "L4");
    ok("nothing kept → the lookup closes as none, no bottle created", L4.status === "none" && T.spirit_products.length === 1, { L4, n: T.spirit_products.length });

    // A known score re-found under another source label confirms it, no copy.
    T.spirit_reviews.push({ id: "usc1", product_id: prod.id, source_id: "usc", score_raw: 93, medal: null, review_year: 2020, url: __BR__, origin: "curated", verified: true, seen_count: 1, match_status: "auto" });
    T.spirit_lookups.push({ id: "L5b", status: "running", name_norm: "buffalo trace bourbon" });
    const nBefore = T.spirit_reviews.length;
    queue = [END([WS(__BR__)]), END(), END(), RECORD([REC([__R__(__BR__, "Tried & True Award", "points_100", 93, null, 2020, "Buffalo Trace Bourbon", "competition")])])];
    await runLookup(db, "L5b", "user-4", "Buffalo Trace Kentucky Straight Bourbon", {}, prod.id);
    const usc1 = T.spirit_reviews.find((x) => x.id === "usc1");
    ok("a known score read off the same page under another label is a confirmation, not a copy", T.spirit_reviews.length === nBefore && usc1.seen_count === 2 && !!usc1.last_checked_at, { n: T.spirit_reviews.length - nBefore, usc1 });
    T.spirit_reviews.splice(T.spirit_reviews.indexOf(usc1), 1);

    // Checking a KNOWN bottle: confirm one score, flag one changed, find nothing new.
    T.spirit_reviews.find((x) => x.source_id === "sfwsc").verified = false;
    T.spirit_reviews.find((x) => x.source_id === "sfwsc").added_by = "user-1";
    const weRow = T.spirit_reviews.find((x) => x.source_id === "wine_enthusiast");
    weRow.last_checked_at = null;
    T.spirit_lookups.push({ id: "L6", status: "running", name_norm: "buffalo trace bourbon" });
    const reportsBefore = (T.spirit_reports || []).length;
    queue = [END([WS(__WE__, __BR__), CITE(__WE__, "rating 92 points"), CITE(__BR__, "2024: silver medal")]), END(), END(),
      RECORD([Object.assign(REC([]), { input: Object.assign(REC([]).input, { checks: [
        { review_ref: "r1", status: "confirmed", url: __WE__, now_says: null },
        { review_ref: "r2", status: "changed", url: __BR__, now_says: "Silver" }] }) })])];
    sent = [];
    await runLookup(db, "L6", "user-3", "Buffalo Trace Kentucky Straight Bourbon", {}, prod.id);
    const L6 = T.spirit_lookups.find((l) => l.id === "L6");
    ok("a check lists the bottle's known scores for the model", /\[r1\] Wine Enthusiast · 92 points/.test(JSON.stringify(sent[0].messages[0])) && /\[r2\] San Francisco World Spirits Competition · Double Gold/.test(JSON.stringify(sent[0].messages[0])), JSON.stringify(sent[0].messages[0]).slice(0, 400));
    ok("a known bottle with nothing new still closes found (0 added) and is stamped researched", L6.status === "found" && L6.added === 0 && L6.product_id === prod.id && /checked 2: 1 confirmed, 1 changed/.test(L6.detail), L6);
    ok("the confirmed score is stamped last_checked_at", !!weRow.last_checked_at, weRow);
    const sf = T.spirit_reviews.find((x) => x.source_id === "sfwsc");
    const reps = (T.spirit_reports || []).slice(reportsBefore);
    ok("a page now showing a different medal files a report…", reps.length === 1 && reps[0].review_id === sf.id && reps[0].kind === "wrong_score" && /now shows Silver/.test(reps[0].note) && reps[0].user_id === "user-3", reps);
    ok("…and the stored score is left alone", sf.medal === "Double Gold" && sf.score_10 === 8.5, sf);
    T.spirit_lookups.push({ id: "L7", status: "running", name_norm: "buffalo trace bourbon" });
    queue = [END([WS(__BR__), CITE(__BR__, "2024: silver medal")]), END(), END(),
      RECORD([Object.assign(REC([]), { input: Object.assign(REC([]).input, { checks: [{ review_ref: "r2", status: "changed", url: __BR__, now_says: "Silver" }] }) })])];
    await runLookup(db, "L7", "user-3", "Buffalo Trace Kentucky Straight Bourbon", {}, prod.id);
    ok("the same change isn't reported twice while a report is open", (T.spirit_reports || []).slice(reportsBefore).length === 1, (T.spirit_reports || []).length);

    // The API failing → failed, nothing written.
    T.spirit_lookups.push({ id: "L5", status: "running", name_norm: "x" });
    const before = T.spirit_reviews.length;
    queue = [{ status: 529, body: {} }];
    await runLookup(db, "L5", "user-1", "Some Bottle", {}, null);
    ok("an API failure closes the lookup as failed and writes nothing", T.spirit_lookups.find((l) => l.id === "L5").status === "failed" && T.spirit_reviews.length === before, T.spirit_lookups.find((l) => l.id === "L5"));
  } catch (e) {
    ok("test run", false, String(e && e.stack || e));
  }
  document.getElementById("out").textContent = JSON.stringify(results);
})();
</script>"""

def main():
    js = strip_ts(body())
    page = (PAGE.replace("__BODY__", js).replace("__SCRIPTS__", safe(SCRIPTS))
            .replace("__WE__", json.dumps(WE)).replace("__DH__", json.dumps(DH)).replace("__BR__", json.dumps(BR))
            .replace("__R__", "R"))
    # R(), WS(), CITE(), REC() exist in Python only for building SCRIPTS — give the page JS versions.
    helpers = """
const WS = (...urls) => ({ type: "web_search_tool_result", tool_use_id: "s1", content: urls.map((u) => ({ type: "web_search_result", url: u, title: TITLES[u] || "Buffalo Trace Kentucky Straight Bourbon review", encrypted_content: "x" })) });
const TITLES = {};
const CITE = (url, cited, text) => ({ type: "text", text: text || "x", citations: [{ type: "web_search_result_location", url, cited_text: cited }] });
const REC = (reviews, name) => ({ type: "tool_use", id: "t1", name: "record_scores", input: { bottle: { canonical_name: name || "Buffalo Trace Kentucky Straight Bourbon", category: "bourbon", producer: "Buffalo Trace", country: "USA", age_years: null, abv: 45 }, reviews } });
const R = (url, source, scale, score, medal, year, named, kind) => ({ source_name: source, kind: kind || "critic", url, year: year === undefined ? 2022 : year, scale, score: score === undefined ? null : score, medal: medal || null, reviewer: null, bottle_as_named: named || "Buffalo Trace Kentucky Straight Bourbon" });
"""
    page = page.replace("const SCRIPTS =", helpers + "\nconst SCRIPTS =", 1)
    with tempfile.TemporaryDirectory() as tmp:
        f = pathlib.Path(tmp) / "t.html"; f.write_text(page)
        proc = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000",
                               "--enable-logging=stderr", "--v=0", "--dump-dom", f.as_uri()], capture_output=True, text=True, timeout=120)
    m = re.search(r'<pre id="out">(.*?)</pre>', proc.stdout, re.S)
    if not m or not m.group(1).strip():
        errs = [l for l in proc.stderr.splitlines() if "Uncaught" in l or "SyntaxError" in l][:5]
        print("FAIL  the function's code did not run in Chrome" + ("\n  " + "\n  ".join(errs) if errs else ""))
        if "--dump" in sys.argv: pathlib.Path("research_bottle_page.html").write_text(page)
        sys.exit(2)
    res = json.loads(m.group(1).replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    fails = 0
    for r in res:
        fails += not r["pass"]
        print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "   >> " + r["detail"][:400]))
    print(f"\n{len(res) - fails}/{len(res)} passed"); sys.exit(0 if not fails else 2)

main()
