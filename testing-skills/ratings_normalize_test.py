#!/usr/bin/env python3
"""Offline checks for the spirits ratings scripts (no network, no Supabase, no spend).

Pins down scripts/ratings/normalize.py — score anchors, 0.5 rounding, medals,
name keys, attribute parsing, hard match rules — plus ratings.py's IWSC page
parser against small synthetic pages and the auto-match decision.

The IWSC fixtures are modelled on how the live pages read as text; if IWSC
changes its markup, run `python3 scripts/ratings/ratings.py inspect <url>` on a
real result page and update both the parser and the fixture here.

Run from anywhere in the repo:  python3 testing-skills/ratings_normalize_test.py
"""
import os, pathlib, sys

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
sys.path.insert(0, str(REPO / "scripts" / "ratings"))
sys.dont_write_bytecode = True
import normalize as N   # noqa: E402
import ratings as R     # noqa: E402

fails = 0
def eq(label, got, want):
    global fails
    ok = got == want
    fails += not ok
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f"   got {got!r}, want {want!r}"))

# --- normalization: score -> /10 (rounded to 0.5) ----------------------------
r = lambda scale, raw: N.round_half(N.to_10(scale, raw))
eq("critic 92 -> 8.0", r("critic100", 92), 8.0)
eq("critic 95 -> 9.0 (8.75 rounds up)", r("critic100", 95), 9.0)
eq("critic 88 -> 7.0", r("critic100", 88), 7.0)
eq("critic 100 -> 10.0", r("critic100", 100), 10.0)
eq("critic 60 clamps to 4.0", r("critic100", 60), 4.0)
eq("IWSC 95 Gold -> 8.0", r("iwsc", 95), 8.0)
eq("IWSC 92 Silver -> 7.5", r("iwsc", 92), 7.5)
eq("IWSC 98 Gold Outstanding -> 9.0", r("iwsc", 98), 9.0)
eq("IWSC 87 Bronze -> 6.5", r("iwsc", 87), 6.5)
eq("Wine Enthusiast 93 -> 8.5 (8.25 rounds up)", r("wine_enthusiast", 93), 8.5)
eq("Murray 94.5 -> 8.0", r("murray", 94.5), 8.0)
eq("Tequila Matchmaker 89 -> 8.5 (8.25 rounds up)", r("tequila_matchmaker", 89), 8.5)
eq("10-pt identity 7 -> 7.0", r("ten", 7), 7.0)
eq("Drinkhacker A- 9.0 -> 8.0 (same as a critic 92)", r("drinkhacker", 9.0), r("critic100", 92))
eq("Drinkhacker A 9.5 -> 9.0 (8.75 rounds up)", r("drinkhacker", 9.5), 9.0)
eq("Drinkhacker B 8.0 -> 7.0 (6.75 rounds up)", r("drinkhacker", 8.0), 7.0)
eq("Breaking Bourbon 4 barrels -> 8.0", r("barrels5", 4), 8.0)
eq("5 stars 4 -> 7.5", r("stars5", 4), 7.5)
eq("round_half 7.74 -> 7.5", N.round_half(7.74), 7.5)
eq("round_half clamps", (N.round_half(-1), N.round_half(12)), (0.0, 10.0))
try:
    N.to_10("nope", 90); eq("unknown scale raises", False, True)
except ValueError:
    eq("unknown scale raises", True, True)

# --- medals -------------------------------------------------------------------
eq("SFWSC Double Gold -> 8.5", N.medal_to_10("sfwsc", "Double Gold"), 8.5)
eq("IWSC 'Spirit Gold Outstanding' -> 9.0", N.medal_to_10("iwsc", "Spirit Gold Outstanding"), 9.0)
eq("IWSC old 'Silver Outstanding' -> 7.5", N.medal_to_10("iwsc", "Silver Outstanding"), 7.5)
eq("packaging award ignored", N.clean_medal("Packaging Gold"), None)
eq("highball award ignored", N.clean_medal("Whisky Highball Bronze"), None)
eq("alt drinks ignored", N.clean_medal("Alternative Drinks Gold"), None)

# --- names + attributes -------------------------------------------------------
eq("norm: marks, YO, Kentucky Straight, whiskey dropped",
   N.norm_name("Knob Creek® 12 YO Kentucky Straight Bourbon Whiskey"), "knob creek 12 year old bourbon")
eq("norm: 12yo glued", N.norm_name("Laphroaig 10yo"), "laphroaig 10 year old")
eq("norm: Year Old stays single", N.norm_name("Glenmorangie 14 Year Old"), "glenmorangie 14 year old")
eq("norm: apostrophe", N.norm_name("Maker's Mark 101"), "makers mark 101")
eq("norm: BiB", N.norm_name("Old Fitzgerald BiB"), "old fitzgerald bottled in bond")
eq("norm: St. -> saint, no stray dot", N.norm_name("St. George Pear"), "saint george pear")
eq("norm: St. Germain == St-Germain", N.norm_name("St. Germain"), N.norm_name("St-Germain"))
eq("norm: initials J.M == JM", N.norm_name("Rhum J.M Blanc"), N.norm_name("Rhum JM Blanc"))
eq("norm: No. 1", N.norm_name("Pimm's No. 1"), "pimms no 1")
eq("norm: decimal ABV kept", N.norm_name("Booker's 62.25%"), "bookers 62.25%")
eq("norm: 12 y.o.", N.norm_name("Macallan 12 y.o."), "macallan 12 year old")
eq("norm: folds ø/æ", N.norm_name("Skærbæk Ørsted Gin"), "skaerbaek orsted gin")
a = N.parse_attrs("Knob Creek 12 YO Kentucky Straight Bourbon Whiskey")
eq("attrs: age 12", a["age_years"], 12)
a = N.parse_attrs("Larceny Barrel Proof C925 124.2 proof")
eq("attrs: batch C925", a["batch"], "C925")
eq("attrs: proof -> abv", a["abv"], 62.1)
a = N.parse_attrs("Booker's Batch 2024-01 62.25% ABV")
eq("attrs: batch 2024-01", a["batch"], "2024-01")
eq("attrs: abv 62.25", a["abv"], 62.25)
eq("attrs: single barrel", N.parse_attrs("Baker's Single Barrel")["single_barrel"], True)
eq("hard rule: ages differ", N.attrs_compatible({"age_years": 9}, {"age_years": 12}), False)
eq("hard rule: one side silent", N.attrs_compatible({"age_years": 9}, {"age_years": None}), True)
eq("hard rule: abv within 0.3", N.attrs_compatible({"abv": 50.0}, {"abv": 50.2}), True)
eq("hard rule: abv off", N.attrs_compatible({"abv": 50.0}, {"abv": 57.0}), False)
sb_ = lambda a, b: N.same_bottle(N.norm_name(a), N.norm_name(b))
eq("same bottle: category word dropped", sb_("Elijah Craig Small Batch Bourbon", "Elijah Craig Small Batch"), True)
eq("same bottle: Reposado is not Plata", sb_("Gran Centenario Reposado", "Gran Centenario Plata"), False)
eq("same bottle: Barrel Proof is not Small Batch", sb_("Elijah Craig Barrel Proof C924", "Elijah Craig Small Batch"), False)
eq("same bottle: a named edition is another bottle", sb_("Hendrick's Gin Oasium", "Hendrick's Gin"), False)
eq("same bottle: 18 Year is not the NAS", sb_("Elijah Craig 18 Year", "Elijah Craig Small Batch"), False)
eq("same bottle: Single Village Mezcal wording", sb_("Del Maguey Vida Single Village Mezcal", "Del Maguey Vida"), True)
eq("category: bourbon", N.guess_category("Knob Creek 9 Kentucky Straight Bourbon"), "bourbon")
eq("category: Scotch single malt -> scotch", N.guess_category("Bowmore 12 Single Malt Scotch"), "scotch")
eq("category: American single malt -> whiskey", N.guess_category("Westland American Single Malt Whiskey"), "whiskey")
eq("category: 'ginger' is not gin", N.guess_category("10AC Honey Ginger Whiskey"), "whiskey")
eq("category: cordial -> liqueur", N.guess_category("Alpenglow Cordial"), "liqueur")
eq("category: crème de -> liqueur", N.guess_category("Giffard Crème de Cassis"), "liqueur")
eq("category: the last type word wins (cream liqueur)", N.guess_category("Magnum Scotch Malt Cream Liqueur"), "liqueur")
eq("category: bourbon-barrel gin is gin", N.guess_category("Bourbon Barrel Aged Gin"), "gin")
eq("category: parentheses don't count", N.guess_category("13th Colony Barrel Aged Gin (Rye Whiskey Barrels)"), "gin")
eq("category: Straight Rye Whiskey is rye", N.guess_category("Elijah Craig Straight Rye Whiskey"), "rye")
eq("category: Speyside single malt is scotch", N.guess_category("Glenfarclas 12 Speyside Single Malt"), "scotch")
eq("split words rejoin into the longer cell",
   R.rejoin_split_words(["1933 Macleod's 1", "5 Year Old Single Malt S", "cotch Highlands, Scotland", "United Kingdom", "Gold"],
                        "1933 Macleod's 15 Year Old Single Malt Scotch Highlands, Scotland United Kingdom Gold")[:3],
   ["1933 Macleod's", "15 Year Old Single Malt Scotch", "Highlands, Scotland"])
eq("whole words at an edge stay put",
   R.rejoin_split_words(["771", "Blanco Tequila", "Los Altos, Jalisco", "Mexico", "Gold"], "771 Blanco Tequila Los Altos, Jalisco Mexico Gold"),
   ["771", "Blanco Tequila", "Los Altos, Jalisco", "Mexico", "Gold"])
eq("category: whisky -> whiskey", N.guess_category("Kilbeggan Irish Whiskey"), "whiskey")
eq("relevant: brand present", N.query_relevant("Knob Creek 9", "Knob Creek Bourbon 9 YO"), True)
eq("relevant: other brand", N.query_relevant("Knob Creek 9", "Laphroaig Quarter Cask"), False)

# --- auto-match decision ------------------------------------------------------
eq("decide: clear winner", R.decide([{"product_id": "a", "score": 0.9}, {"product_id": "b", "score": 0.5}])[2], "auto")
eq("decide: too close", R.decide([{"product_id": "a", "score": 0.80}, {"product_id": "b", "score": 0.75}])[2], "pending")
eq("decide: too weak", R.decide([{"product_id": "a", "score": 0.40}])[2], "pending")
eq("decide: nothing", R.decide([])[2], "pending")

# --- IWSC parser on synthetic pages ------------------------------------------
DETAIL = """<html><head><title>Spirit Gold 2022 - Knob Creek 12 YO Kentucky Straight Bourbon Whiskey | IWSC</title>
<meta property="og:title" content="Spirit Gold 2022 - Knob Creek 12 YO Kentucky Straight Bourbon Whiskey"></head>
<body><script>var x = "99 points";</script><nav><a href="/results">Results</a></nav>
<h1>Knob Creek 12 YO Kentucky Straight Bourbon Whiskey</h1>
<div class="medal">Spirit Gold 2022</div><div>95 Points</div>
<dl><dt>Producer</dt><dd>Beam Suntory</dd><dt>ABV</dt><dd>50% ABV</dd></dl>
<p>_Macro/regions.twig, USA</p></body></html>"""
d = R.iwsc_parse_detail(DETAIL)
eq("detail: name", d["name"], "Knob Creek 12 YO Kentucky Straight Bourbon Whiskey")
eq("detail: medal", d["medal"], "Spirit Gold")
eq("detail: year", d["year"], 2022)
eq("detail: points (script text ignored)", d["points"], 95)
eq("detail: producer", d["producer"], "Beam Suntory")
eq("detail: country", d["country"], "USA")
eq("detail: abv", d["abv"], 50.0)
src = {"scale": "iwsc", "default_weight": 0.8}
row, why = R.iwsc_review_row("120667", d, src)
eq("row: score_10 for 95", row["score_10"], 8.0)
eq("row: weight with points", row["weight"], 0.8)

OLD = """<html><head><title>Silver Outstanding 2014 - Knob Creek Bourbon 9 YO</title></head>
<body><h1>Knob Creek Bourbon 9 YO</h1><p>Silver Outstanding 2014</p></body></html>"""
d = R.iwsc_parse_detail(OLD)
row, why = R.iwsc_review_row("53735", d, src)
eq("old medal-only: score_10", row["score_10"], 7.5)
eq("old medal-only: weight 0.5", row["weight"], 0.5)
PKG = "<title>Packaging Gold 2016 - Knob Creek 9 Year Old Bourbon</title>"
row, why = R.iwsc_review_row("73390", R.iwsc_parse_detail(PKG), src)
eq("packaging award skipped", row, None)

SEARCH = """<div class="result"><p>Silver Outstanding 2014</p><p>Beam Suntory</p><h3>Knob Creek Bourbon 9 YO</h3>
<p>_Macro/regions.twig, USA</p><a href="https://www.iwsc.net/results/detail/53735">View details</a></div>
<div class="result"><p>Silver 2013</p><p>Beam Suntory</p><h3>Laphroaig Quarter Cask</h3>
<p>_Macro/regions.twig, Scotland</p><a href="/results/detail/28010">View details</a></div>"""
real_fetch = R.fetch
R.fetch = lambda url, refresh=False: SEARCH if "/results/1?" in url else ""
hits = R.iwsc_search("Knob Creek", max_pages=2)
R.fetch = real_fetch
eq("search: both ids found", [h[0] for h in hits], ["53735", "28010"])
eq("search: relevance filter", [h[0] for h in hits if N.query_relevant("Knob Creek", h[1])], ["53735"])

# --- robots.txt + bot challenges (stubbed urlopen, nothing leaves the machine) --
import email.message, urllib.error
def answer(code, headers=None):
    def fake(req, timeout=None, context=None):
        h = email.message.Message()
        for k, v in (headers or {}).items():
            h[k] = v
        raise urllib.error.HTTPError(req.full_url, code, "stub", h, None)
    return fake
def blocked(code, headers=None, host="example.test"):
    real = R.urllib.request.urlopen
    R.urllib.request.urlopen = answer(code, headers)
    R._robots.clear(); R._blocked.clear()
    try:
        return R.blocked_reason(f"https://{host}/results/detail/1")
    finally:
        R.urllib.request.urlopen = real
eq("robots: Cloudflare challenge -> blocked, says why",
   "Cloudflare" in (blocked(403, {"cf-mitigated": "challenge"}) or ""), True)
eq("robots: plain 403 -> blocked", (blocked(403) or "").endswith("HTTP 403"), True)
eq("robots: 404 (no robots.txt) -> allowed", blocked(404), None)
eq("robots: 503 -> blocked for now", "503" in (blocked(503) or ""), True)
def offline(req, timeout=None, context=None):
    raise urllib.error.URLError("offline")
real = R.urllib.request.urlopen; R.urllib.request.urlopen = offline; R._robots.clear(); R._blocked.clear()
eq("robots: unreachable -> blocked", "couldn't be read" in (R.blocked_reason("https://example.test/x") or ""), True)
R.urllib.request.urlopen = real; R._robots.clear(); R._blocked.clear()
eq("ssl: context verifies certificates", R.SSL_CTX.verify_mode == R.ssl.CERT_REQUIRED, True)

# --- sfwsc-import --apply against a stubbed Supabase: what it would send ----
posts = []
def fake_sb(method, path, body=None, prefer="return=representation"):
    if method == "GET":
        if path.startswith("/rest/v1/spirit_products?select=id,name_norm,age_years"):
            return [{"id": "p-ec", "name_norm": "elijah craig small batch", "age_years": None, "abv": None, "batch": None}] if "offset=0" in path else []
        return []
    if "rpc/spirit_candidates" in path:
        return [{"product_id": "p-ec", "canonical_name": "Elijah Craig Small Batch", "age_years": None, "abv": None, "batch": None, "score": 0.8}]
    posts.append((path, body))
    if path == "/rest/v1/spirit_products":
        return [{"id": "new-" + str(i), "name_norm": b["name_norm"]} for i, b in enumerate(body)]
    return None
rows = [["Elijah Craig", "Small Batch Bourbon", "Kentucky", "USA", "Silver", "Elijah Craig Small Batch Bourbon Kentucky USA Silver"],
        ["1792", "Aged 12 Years Straight Bourbon", "", "USA", "Double Gold", "1792 Aged 12 Years Straight Bourbon USA Double Gold"],
        ["Laphroaig", "10 Year Old Islay Single Malt Scotch", "Islay, Scotland", "United Kingdom", "Gold", "x"],
        ["Plain Gin", "London Dry Gin", "", "UK", "Bronze", "x"],
        ["Packaging Co", "Fancy Bottle", "", "USA", "Best Packaging", "x"]]
saved = (R.sb, R.fetch, R.pdf_rows)
R.sb, R.fetch, R.pdf_rows = fake_sb, (lambda url, refresh=False, binary=False: "/dev/null"), (lambda path, headers=None: rows)
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    R.main(["sfwsc-import", "--year", "2025", "--apply"])
R.sb, R.fetch, R.pdf_rows = saved
prod_batches = [b for p, b in posts if p == "/rest/v1/spirit_products"]
eq("import: every product row in a batch has the same keys", all(len({tuple(sorted(r)) for r in b}) == 1 for b in prod_batches), True)
eq("import: only the 3 new bottles are created (the known one joins)", sum(len(b) for b in prod_batches), 3)
revs = [r for p, b in posts if p.startswith("/rest/v1/spirit_reviews") for r in b]
eq("import: one medal per bottle, the joined one on its catalog id", sorted((r["product_id"], r["medal"]) for r in revs)[0], ("new-0", "Double Gold"))
eq("import: the joined bottle's medal points at it", any(r["product_id"] == "p-ec" and r["medal"] == "Silver" for r in revs), True)
eq("import: every review row has the same keys", len({tuple(sorted(r)) for r in revs}), 1)
eq("import: medals saved as bulk origin at half weight", {(r["origin"], r["weight"]) for r in revs}, {("bulk", 0.5)})
eq("import: a non-medal row is skipped", len(revs), 4)

# --- 2026-11-12: new scales, the spirit-type rule, batch harvest + import -------
eq("competition 95 -> 8.0", r("competition100", 95), 8.0)
eq("competition 87 -> 6.5 (a typical BSA silver)", r("competition100", 87), 6.5)
eq("hard grader's 86 -> 7.0 (a critic's 88)", r("critic100_harsh", 86), 7.0)
eq("hard grader's 90 -> 8.0", r("critic100_harsh", 90), 8.0)
eq("Spirits Selection Grand Gold -> 8.0", N.medal_to_10("spirits_selection", "Grand Gold"), 8.0)
eq("Denver Double Gold -> 8.0", N.medal_to_10("denver", "Double Gold"), 8.0)
eq("TAG Platinum -> 8.0", N.medal_to_10("tag", "Platinum"), 8.0)
sb_ = lambda a, b: N.same_bottle(N.norm_name(a), N.norm_name(b))
eq("type rule: Cutwater Gin is not Cutwater Vodka", sb_("Cutwater Gin", "Cutwater Vodka"), False)
eq("type rule: mezcal añejo is not tequila añejo", sb_("Cutwater Mezcal Añejo", "Cutwater Tequila Añejo"), False)
eq("type rule: no type word still matches (Hendrick's / Hendrick's Gin)", sb_("Hendrick's", "Hendrick's Gin"), True)
eq("type rule: rhum = rum", sb_("Rhum J.M Blanc", "J.M Blanc Rum"), True)
eq("type rule: cognac = brandy", sb_("Pierre Ferrand 1840 Cognac", "Pierre Ferrand 1840 Brandy"), True)

PRODS = [{"id": "p-ec", "canonical_name": "Elijah Craig Small Batch", "name_norm": "elijah craig small batch", "category": "bourbon", "age_years": None, "abv": 47, "batch": None},
         {"id": "p-cv", "canonical_name": "Cutwater Vodka", "name_norm": "cutwater vodka", "category": "vodka", "age_years": None, "abv": None, "batch": None},
         {"id": "p-bb", "canonical_name": "Bar Boss Bourbon", "name_norm": "bar boss bourbon", "category": "bourbon", "age_years": None, "abv": None, "batch": None},
         {"id": "p-d1", "canonical_name": "Twin Bottle", "name_norm": "twin bottle", "category": "gin", "age_years": None, "abv": None, "batch": None},
         {"id": "p-d2", "canonical_name": "Bottle Twin", "name_norm": "bottle twin", "category": "gin", "age_years": None, "abv": None, "batch": None},
         {"id": "p-12", "canonical_name": "Glen Test 12", "name_norm": "glen test 12 year old", "category": "scotch", "age_years": 12, "abv": None, "batch": None}]
ALIASES = [{"alias_norm": "ec small batch", "product_id": "p-ec"}]
row = lambda name, **kw: {"name": name, "year": kw.pop("year", 2025), "score_raw": kw.pop("score_raw", 90), "category": kw.pop("category", None), **kw}
B = {"source_id": "bartender_spirits_awards", "scale": "competition100", "weight": 0.5, "origin": "bulk", "rows": [
    row("Elijah Craig Small Batch Bourbon", category="bourbon"),            # same words -> p-ec
    row("EC Small Batch", category="bourbon", year=2024),                    # alias -> p-ec
    row("Cutwater Gin", category="gin"),                                     # type rule: new, not p-cv
    row("Bar Boss Whiskey", category="whiskey"),                             # says whiskey: new, not p-bb
    row("Twin Bottle Gin", category="gin"),                                  # exact-ish? words {twin, bottle}: p-d1 AND p-d2 share them -> ambiguous
    row("Glen Test 18", category="scotch"),                                  # age conflict with the 12: new
    row("Hoyo 19 Hole (Blanco)", category="tequila"), row("Hoyo 19 Hole (Extra Anejo)", category="tequila"),  # two bottles
    row("Nelson Brothers Rye", category="rye", year=2023), row("Nelson Brother's Rye", category="rye", year=2023),  # one bottle, one score a year
    row("Plain Gin", category="gin"),                                        # 'plain' is its own word: a new bottle
    row("Gin", category="gin"),                                              # bare type word
    row("No Score", category="gin", score_raw=None),
]}
P = R.plan_batch(B, PRODS, ALIASES, have={("p-ec", 2019)})
joined = {r["name"]: pid for r, pid, how in P["joined"]}
eq("plan: same distinguishing words join the catalog bottle", joined.get("Elijah Craig Small Batch Bourbon"), "p-ec")
eq("plan: an alias joins too", joined.get("EC Small Batch"), "p-ec")
eq("plan: 'Cutwater Gin' doesn't join Cutwater Vodka", "Cutwater Gin" in joined, False)
eq("plan: 'Bar Boss Whiskey' doesn't join Bar Boss Bourbon", "Bar Boss Whiskey" in joined, False)
eq("plan: two catalog bottles with the same words = ambiguous, left out", P["skipped"].get("ambiguous (two catalog bottles share its words)"), 1)
eq("plan: an 18-year doesn't join the 12", "Glen Test 18" in joined, False)
newnames = sorted(p["canonical_name"] for p in P["new"].values())
eq("plan: parenthesized products stay two bottles", [n for n in newnames if n.startswith("Hoyo")], ["Hoyo 19 Hole Blanco", "Hoyo 19 Hole Extra Anejo"])
eq("plan: two spellings of one new bottle make one bottle", sum(1 for n in newnames if n.startswith("Nelson")), 1)
eq("plan: ...and one score that year", P["skipped"].get("already held (same bottle, same year)"), 1)
eq("plan: a bare type word is left out", P["skipped"].get("only generic words (a bare 'Gin')"), 1)
eq("plan: a row with no score is left out", P["skipped"].get("no usable score"), 1)
eq("plan: a joined bottle's new spelling becomes an alias for it", ("elijah craig small batch bourbon", "p-ec") in P["aliases"], True)
eq("plan: scores land on competition100 (90 -> 7.0)", {round(sc, 2) for _, _, sc in P["reviews"]}, {7.0})
J = R.plan_batch(B, PRODS, ALIASES, have=set(), join_only=True)
eq("plan --join-only: no new bottles", (len(J["new"]), len(J["joined"])), (0, 2))
eq("plan --join-only: says why the rest were left out", J["skipped"].get("not in the catalog (--join-only)", 0) >= 6, True)
eq("plan: a score the source already holds that year isn't added twice",
   len(R.plan_batch({**B, "rows": [row("Elijah Craig Small Batch", category="bourbon", year=2019)]}, PRODS, ALIASES, {("p-ec", 2019)})["reviews"]), 0)

# import-batch --apply against a stubbed Supabase
posts = []
def fake_sb2(method, path, body=None, prefer="return=representation"):
    if method == "GET":
        if path.startswith("/rest/v1/rating_sources"):
            return [{"id": "bartender_spirits_awards", "name": "Bartender Spirits Awards"}]
        if path.startswith("/rest/v1/spirit_products?select=") and "offset=0" in path:
            return PRODS
        if path.startswith("/rest/v1/spirit_aliases?select=") and "offset=0" in path:
            return ALIASES
        return []
    posts.append((path, body))
    if path == "/rest/v1/spirit_products":
        return [{"id": "new-" + str(i), "name_norm": b["name_norm"]} for i, b in enumerate(body)]
    return None
import json as _json, tempfile
tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); _json.dump(B, tmp); tmp.close()
saved = R.sb; R.sb = fake_sb2
with contextlib.redirect_stdout(io.StringIO()):
    R.main(["import-batch", tmp.name, "--apply"])
R.sb = saved; os.unlink(tmp.name)
prods = [r for p_, b in posts if p_ == "/rest/v1/spirit_products" for r in b]
revs = [r for p_, b in posts if p_.startswith("/rest/v1/spirit_reviews") for r in b]
als = [r for p_, b in posts if p_.startswith("/rest/v1/spirit_aliases") for r in b]
eq("import-batch: every product row has the same keys", len({tuple(sorted(r)) for r in prods}), 1)
eq("import-batch: every review row has the same keys", len({tuple(sorted(r)) for r in revs}), 1)
eq("import-batch: reviews are bulk, half weight, on their source", {(r["origin"], r["weight"], r["source_id"]) for r in revs}, {("bulk", 0.5, "bartender_spirits_awards")})
eq("import-batch: one review per bottle-year, refs unique", len(revs), len({r["source_ref"] for r in revs}))
eq("import-batch: new bottles' reviews point at the new ids", all(r["product_id"] in {"p-ec"} | {f"new-{i}" for i in range(len(prods))} for r in revs), True)
eq("import-batch: the joined bottle's printed name becomes its alias", any(a["alias_norm"] == "elijah craig small batch bourbon" and a["product_id"] == "p-ec" for a in als), True)

# parsers, on fixtures modelled on the live markup
BTN = """<article class="isotopeGridItem" data-brand="Plymouth Gin" data-country="United Kingdom" data-category="Gin" data-points="91">
<div class="txt"><h1>Plymouth Gin</h1><ul><li><strong>Producer Name:</strong> Pernod Ricard USA</li><li><strong>Country:</strong> United Kingdom</li>
<li><strong>Category:</strong> Gin</li><li class="showOnSearch"><strong>Award:</strong> Gold Medal </li>
<li class="actions"><a href="https://bartenderspiritsawards.com/en/winner-brands/spirits/2026/pernod-1/plymouth-gin-2.htm" title="Go to Product Page">P</a></li></ul></div></article>
<article><div class="imgContainer"><img src="/x/BSA_DoubleGoldMedal_2019.svg">96 Points</div><div class="txt"><h1>Rye Whiskey</h1><ul>
<li><strong>Producer Name:</strong> Nelson Brothers LLC</li><li><strong>Country:</strong> United States</li><li><strong>Category:</strong> Whisky</li>
<li class="showOnSearch"><strong>Award:</strong> Double Gold Medal </li><a href="https://bartenderspiritsawards.com/en/winner-brands/spirits/2019/n-1/rye-2.htm">P</a></ul></div></article>
<article><div class="txt"><h1>Tiki Can</h1><ul><li><strong>Producer Name:</strong> X</li><li><strong>Category:</strong> Ready to drink (RTD)</li>
<li class="showOnSearch"><strong>Award:</strong> Gold Medal </li></ul></div></article>
<article><div class="txt"><h1>Plymouth Gin</h1><ul><li><strong>Award:</strong> Gin of the Year </li></ul></div></article>"""
got = R.btn_rows(BTN, 2026, "bartenderspiritsawards.com")
eq("BSA: medal rows parsed, RTD and special awards skipped", [g["name"] for g in got], ["Plymouth Gin", "Nelson Brothers Rye Whiskey"])
eq("BSA: points from data-points, or the '96 Points' text", [g["score_raw"] for g in got], [91, 96])
eq("BSA: a brandless name gets its producer (LLC dropped), the printed one kept", (got[1]["name"], got[1]["printed"]), ("Nelson Brothers Rye Whiskey", "Rye Whiskey"))
eq("BSA: whisky with a rye word is rye", got[1]["category"], "rye")
eq("with_brand: a brand-number name keeps its own brand", R.with_brand("1800 Añejo", "Avid Marketing Group on behalf of Proximo"), "1800 Añejo")
SSEL = """<div class="card bg-transparent card-product lift"><a class="stretched-link" href="https://results.spiritsselection.com/en/results/2026/255705-rhum-x"></a>
<div class="medal-card"><img src="m.png" alt="Grand Gold Medal" /></div><div class="card-body"><h3 class="h4 card-title"> Rhum Agricole Extra Vieux X </h3>
<span class="d-block"> Valois &amp; cie </span><span class="d-block"> Martinique - Martinique </span><span class="d-block mb-2"> </span>
<span class="d-block fw-bold text-primary"> Grand Gold Medal </span></div><div class="card-footer"><span class="d-block fw-bold"> Agricultural &amp; Sugar Cane Juice Rum </span></div></div>"""
got = R.ssel_rows(SSEL, 2026)
eq("Spirits Selection: card -> name, producer, country, medal, category", [(g["name"], g["producer"], g["country"], g["medal"], g["category"]) for g in got],
   [("Rhum Agricole Extra Vieux X", "Valois & cie", "Martinique", "Grand Gold", "rum")])
PDF = [["Company", "Brand", "Product", "Award", "Score", "Company Brand Product Award Score"],
       ["AGE International", "Blanton's Single Barre", "l Bourbon Blanton's Original Single Barrel Kentucky Straig", "ht Bourbon Whiskey Double Gold", "97",
        "AGE International Blanton's Single Barrel Bourbon Blanton's Original Single Barrel Kentucky Straight Bourbon Whiskey Double Gold 97"],
       ["Augusta Distillery", "Augusta Distillery", "Small Batch", "Gold", "92", "Augusta Distillery Augusta Distillery Small Batch Gold 92"],
       ["Azienda Agricola Bosco de’", "Medici John Gin", "John Gin – Classic", "Silver", "86", "Azienda Agricola Bosco de’ Medici John Gin John Gin – Classic Silver 86"],
       ["Central Penn Distilling, Inc.", "Mason Dixon", "Jalapeno Mule", "Double Gold", "95", "Central Penn Distilling, Inc. Mason Dixon Jalapeno Mule Double Gold 95"],
       ["Sazerac Company, Inc.", "1792", "1792 Single Barrel", "Best of Show-2nd P", "lace (tie) 95", "Sazerac Company, Inc. 1792 1792 Single Barrel Best of Show-2nd Place (tie) 95"]]
got = R.disc_rows(PDF, 2026, "u")
eq("Denver: names rebuilt from the full line", [g["name"] for g in got],
   ["Blanton's Original Single Barrel Kentucky Straight Bourbon Whiskey", "Augusta Distillery Small Batch", "John Gin – Classic"])
eq("Denver: medal and points", [(g["medal"], g["score_raw"]) for g in got], [("Double Gold", 97), ("Gold", 92), ("Silver", 86)])
OLD = [["Company", "Brand", "Name", "Award", "Company Brand Name Award"], ["ARTEK Beverage", "Lariat", "Lariat Vodka", "Gold", "ARTEK Beverage Lariat Lariat Vodka Gold"]]
eq("Denver (medal-only years): no score, medal kept", [(g["name"], g["medal"], g["score_raw"]) for g in R.disc_rows(OLD, 2019, "u", "Company|Brand|Name|Award")], [("Lariat Vodka", "Gold", None)])
eq("Lone Caner: the last NN/100 is the verdict", R.score_100("the ISWC gave it 95 points… (#1151)(85/100)"), 85.0)
eq("categories: an añejo with no type word is tequila", R.refine_category("Casa Obsidiana Anejo", "other"), "tequila")
eq("categories: a known brand fills in ('Diageo SMIRNOFF')", R.refine_category("Diageo SMIRNOFF", "other"), "vodka")
SAZ = [{"id": "p-saz", "canonical_name": "Sazerac Rye 18 Year Old", "name_norm": N.norm_name("Sazerac Rye 18 Year Old"), "category": "rye", "age_years": 18, "abv": None, "batch": None}]
PS = R.plan_batch({"source_id": "denver_isc", "scale": "competition100", "rows": [
    {"name": "Sazerac 18-Year-Old Rye-2025", "year": 2025, "score_raw": 96, "category": "rye"},
    {"name": "Benromach 2012", "year": 2025, "score_raw": 90, "category": "scotch"}]}, SAZ, [], set())
eq("plan: a trailing release year ('Rye-2025' judged in 2025) still joins the bottle", [pid for _, pid, _ in PS["joined"]], ["p-saz"])
eq("plan: a vintage year ('Benromach 2012') stays its own bottle", list(PS["new"]), ["benromach 2012"])
eq("mojibake: Mac Roman read of UTF-8 repaired", (R.fix_mojibake("Jose Cuervo¬Æ Reserva De La Familia¬Reposado"), R.fix_mojibake("Jim Beamå¨ Rye")),
   ("Jose Cuervo® Reserva De La Familia Reposado", "Jim Beam® Rye"))
eq("Lone Caner: an indie or vintage bottling is a limited release", [bool(R.RUM_LIMITED.search(n)) for n in
   ["Colours of Rum Clarendon 1995 29YO No.16 Jamaica Rum", "Velier Courcelles 1972", "Appleton Estate 12 Year Old Rare Casks", "Smith & Cross Traditional Jamaica Rum"]],
   [True, True, False, False])
eq("cocktails: a canned mule is skipped, Old Fashioned bitters are not", (R.is_cocktail("Jalapeno Mule"), R.is_cocktail("Old Fashioned Aromatic Bitters")), (True, False))

# a hand-checked batch from several sources
MB = {"source_id": "*", "ref": "url", "origin": "curated", "rows": [
    {"name": "Knob Creek 9 Year Old Small Batch Bourbon", "category": "bourbon", "source_id": "drinkhacker", "scale": "drinkhacker", "score_raw": 9.0, "year": 2020, "url": "https://dh/kc", "weight": 1.0},
    {"name": "Knob Creek 9 Year Old Small Batch Bourbon", "category": "bourbon", "source_id": "whisky_advocate", "scale": "critic100", "score_raw": 92, "year": 2020, "url": "https://wa/kc", "weight": 1.0},
    {"name": "Knob Creek 12 Year Old Small Batch Bourbon", "category": "bourbon", "source_id": "drinkhacker", "scale": "drinkhacker", "score_raw": 9.0, "year": 2020, "url": "https://dh/kc", "weight": 1.0}]}
PM = R.plan_batch(MB, [], [], {("drinkhacker", "p-x", "https://dh/kc")})
eq("mixed batch: two critics' scores land on one new bottle", (len(PM["new"]), len(PM["reviews"])), (2, 3))
rr = [R.review_row(MB, row, pid, sc) for row, pid, sc in PM["reviews"]]
eq("mixed batch: each review keeps its own source, scale and curated origin", sorted((r["source_id"], r["score_10"], r["origin"]) for r in rr),
   [("drinkhacker", 8.0, "curated"), ("drinkhacker", 8.0, "curated"), ("whisky_advocate", 8.0, "curated")])
eq("mixed batch: one page reviewing two bottles gives two distinct refs", len({r["source_ref"] for r in rr}), 3)

# Whiskyfun: official bottlings only; core range vs limited; type from the name/region, never the cask
WFP = "".join(f'<td><span class="textegrandfoncegras">{n} <img src="s.jpg"></span> notes… <strong>SGP:552 - {p} points.</strong></td>' for n, p in [
    ("Macallan 12 yo 'Triple Cask Matured' (40%, OB, +/-2023)", 84), ("Oban 14 yo (43%, OB, +/- 2017)", 88),
    ("Highland Park 12 yo (43%, OB, Torino Import, -/+ 1990)", 91), ("Glen Test 2001/2023 (52%, Signatory, cask #12, 300 bottles)", 90),
    ("Hampden 8 yo (46%, OB, Jamaica, ex-bourbon)", 89), ("Benromach 12 yo (46%, OB, cask #4401, 2026)", 87)])
got = {r["name"]: r for r in R.whiskyfun_rows(WFP, "https://www.whiskyfun.com/archivejune23-1.html", 2023)}
eq("Whiskyfun: independent bottlings are left out", "Glen Test 2001/2023" in got, False)
eq("Whiskyfun: 'Triple Cask' and a +/-2017 bottling are core range", (got["Macallan 12 yo 'Triple Cask Matured'"]["join_only"], got["Oban 14 yo"]["join_only"]), (False, False))
eq("Whiskyfun: a 1990 bottling and a numbered cask are limited", (got["Highland Park 12 yo"]["join_only"], got["Benromach 12 yo"]["join_only"]), (True, True))
eq("Whiskyfun: Jamaica makes it rum, an ex-bourbon cask doesn't make it bourbon", got["Hampden 8 yo"]["category"], "rum")
eq("Whiskyfun: the stated ABV is kept for matching", got["Oban 14 yo"]["abv"], 43.0)
eq("Whiskyfun: the archive page's year", R.whiskyfun_year("https://www.whiskyfun.com/archivejune23-1.html", 2026), 2023)

# dupes + merge
DP = [{"id": "a", "canonical_name": "Plantation 3 Stars", "name_norm": "plantation 3 stars", "category": "rum", "age_years": None, "abv": None, "batch": None},
      {"id": "b", "canonical_name": "Plantation 3 Stars White Rum", "name_norm": "plantation 3 stars white rum", "category": "rum", "age_years": None, "abv": None, "batch": None},
      {"id": "c", "canonical_name": "Devils River Cinnamon Bourbon", "name_norm": "devils river cinnamon bourbon", "category": "bourbon", "age_years": None, "abv": None, "batch": None},
      {"id": "d", "canonical_name": "Devils River Bourbon", "name_norm": "devils river bourbon", "category": "bourbon", "age_years": None, "abv": None, "batch": None},
      {"id": "e", "canonical_name": "Devils River Gin", "name_norm": "devils river gin", "category": "gin", "age_years": None, "abv": None, "batch": None}]
nd = {(a["id"], b["id"], x, v) for a, b, x, v in R.near_duplicates(DP)}
eq("dupes: a colour word apart = likely the same bottle", ("b", "a", "white", "likely same") in nd, True)
eq("dupes: a flavour apart = check", ("c", "d", "cinnamon", "check") in nd, True)
eq("dupes: never across categories (the gin isn't the bourbon's twin)", any("e" in (a, b) for a, b, _, _ in nd), False)
calls = []
def fake_sb3(method, path, body=None, prefer="return=representation"):
    calls.append((method, path, body))
    if method == "GET" and path.startswith("/rest/v1/spirit_products?select=id,canonical_name,name_norm&id=in."):
        return [{"id": "a", "canonical_name": "Plantation 3 Stars", "name_norm": "plantation 3 stars"},
                {"id": "b", "canonical_name": "Plantation 3 Stars White Rum", "name_norm": "plantation 3 stars white rum"}]
    if method == "GET" and path.startswith("/rest/v1/spirit_reviews?select=id,product_id"):
        return [{"id": "r1", "product_id": "a", "source_id": "sfwsc", "review_year": 2025, "medal": "Gold", "score_raw": None},
                {"id": "r2", "product_id": "b", "source_id": "sfwsc", "review_year": 2025, "medal": "Gold", "score_raw": None},
                {"id": "r3", "product_id": "b", "source_id": "lone_caner", "review_year": 2024, "medal": None, "score_raw": 85}]
    if method == "PATCH" and "spirit_barcodes" in path:
        sys.exit("relation spirit_barcodes does not exist")
    return None
saved = R.sb; R.sb = fake_sb3
with contextlib.redirect_stdout(io.StringIO()):
    R.main(["merge", "a", "b", "--apply"])
R.sb = saved
eq("merge: the review both bottles hold is deleted, not doubled", ("DELETE", "/rest/v1/spirit_reviews?id=eq.r2", None) in calls, True)
eq("merge: the other reviews move to the kept bottle", any(m == "PATCH" and p_.startswith("/rest/v1/spirit_reviews?product_id=eq.b") and b_ == {"product_id": "a"} for m, p_, b_ in calls), True)
eq("merge: bar bottles follow", any(m == "PATCH" and p_.startswith("/rest/v1/inventory_items?product_id=eq.b") for m, p_, b_ in calls), True)
eq("merge: a missing optional table doesn't stop it; the bottle is deleted last", calls[-2][:2] == ("DELETE", "/rest/v1/spirit_products?id=eq.b") and calls[-1][0] == "POST", True)
eq("merge: the dropped name becomes an alias of the kept bottle", calls[-1][2]["alias_norm"] == "plantation 3 stars white rum" and calls[-1][2]["product_id"] == "a", True)

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
