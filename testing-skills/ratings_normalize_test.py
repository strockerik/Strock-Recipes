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

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
