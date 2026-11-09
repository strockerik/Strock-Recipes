#!/usr/bin/env python3
"""The three copies of the bottle-name rules must agree (no backend, no spend).

scripts/ratings/normalize.py is the reference. app.js (typed names, label reads,
same-bottle checks) and supabase/functions/research-bottle/index.ts (catalog
keys and score conversion for in-app lookups) each carry a port between
"==== NORMALIZE" markers. A name normalised differently in two places lands on
two catalog keys — the same bottle twice — so this pulls both ports out, strips
the TypeScript types, runs them in headless Chrome over a corpus of awkward
names, and compares every output with Python's.

Run from anywhere in the repo:  python3 testing-skills/bottle_normalize_parity_test.py
"""
import json, pathlib, re, subprocess, sys, tempfile

def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "app.js").exists() and (d / "supabase" / "functions").exists():
            return d
    sys.exit("no repo root found")
REPO = find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
sys.path.insert(0, str(REPO / "scripts" / "ratings"))
sys.dont_write_bytecode = True
import normalize as N  # noqa: E402

def block(path, label):
    src = (REPO / path).read_text()
    m = re.search(r"// ==== NORMALIZE: port of scripts/ratings/normalize\.py ====\n(.*?)// ==== END NORMALIZE ====", src, re.S)
    if not m: sys.exit(f"FAIL  no NORMALIZE block in {label}")
    return m.group(1)

def strip_ts(ts):
    ts = re.sub(r"^\s*type \w+ = [^\n]*;\n", "", ts, flags=re.M)
    ts = re.sub(r"(const \w+)\s*:\s*[^=\n]+=", r"\1 =", ts)
    ts = re.sub(r"(\w+)\s*:\s*(?:unknown|string|number|boolean|Attrs)(?=[,)])", r"\1", ts)
    ts = re.sub(r"\)\s*:\s*(?:string \| null|number \| null|string|number|boolean|Set<string>)\s*\{", ") {", ts)
    ts = re.sub(r"\s+as (?:number|string) \| null", "", ts)
    if re.search(r":\s*(?:unknown|string|number|boolean|Record<|Attrs)\b|\bas (?:number|string)\b", ts):
        sys.exit("FAIL  TS type-strip left annotations — extend strip_ts()")
    return ts

NAMES = [
    "Knob Creek® 12 YO Kentucky Straight Bourbon Whiskey", "Knob Creek 9 yo", "Laphroaig 10yo", "Macallan 12 y.o.",
    "Glenmorangie 14 Year Old", "Lagavulin 16 Years Old", "Old Fitzgerald BiB", "E.H. Taylor Small Batch B.I.B.",
    "W.L. Weller Special Reserve", "Maker's Mark 101", "Maker’s Mark Cask Strength", "Booker's Batch 2024-01 62.25% ABV",
    "Larceny Barrel Proof C925 124.2 proof", "Elijah Craig Barrel Proof C924", "Stagg Jr Batch 17 128.7 Proof",
    "Rhum J.M Blanc 50%", "Rhum JM - White", "Pimm’s No. 1", "Pimm's No. 1 Cup", "St. George Spiced Pear Liqueur",
    "St-Germain", "St. Germain", "Hendrick's Gin", "Hendricks", "Skærbæk Ørsted Gin", "Château du Tariquet Bas-Armagnac VSOP",
    "Hennessy V.S.O.P", "Fortaleza Añejo", "Cimarrón Blanco", "Pierre Ferrand Dry Curaçao", "Del Maguey Vida Puebla",
    "Del Maguey Vida de Muertos Single Village Mezcal", "Mezcal Vago Elote 50.5%", "Ron Zacapa Centenario 23",
    "1792 Small Batch Straight Bourbon", "1792 Aged 12 Years Straight Bourbon", "10th Mountain Whiskey & Spirit Company Bourbon",
    "Smith & Cross", "Plantation 3 Stars", "291 Small Batch Colorado Rye", "Laws San Luis Valley Rye",
    "Wyoming Whiskey Small Batch Bourbon", "Gran Centenario Plata", "Gran Centenario Reposado", "Amaro Montenegro",
    "Montenegro", "Green Chartreuse", "Yellow Chartreuse 40%", "Baker's Single Barrel 7 Year 107 proof",
    "Blanton's Single Barrel SiB", "Russell's Reserve Single Barrel Store Pick", "Four Roses Private Selection OESK",
    "The Glenlivet 12", "Redbreast 12 Cask Strength", "Wild Turkey 101", "Bulleit Rye 95% Rye Mash", "Ardbeg Uigeadail",
    "Bruichladdich The Classic Laddie", "Nikka From the Barrel 51.4%", "Ocho Plata 2024 Los Patos", "", "   ",
    "10AC Honey Ginger Whiskey", "Westland American Single Malt Whiskey", "Alpenglow Cordial", "Giffard Crème de Cassis",
    "Novo Fogo Cachaça", "Rummikub Gin", "Pisco Portón", "Ginger Liqueur",
    "Magnum Scotch Malt Cream Liqueur", "Bourbon Barrel Aged Gin", "13th Colony Barrel Aged Gin (Rye Whiskey Barrels)",
    "Elijah Craig Straight Rye Whiskey", "Glenfarclas 12 Speyside Single Malt", "Rum Barrel Finished Bourbon",
]
PAIRS = [
    ("Elijah Craig Small Batch Bourbon", "Elijah Craig Small Batch"), ("Gran Centenario Reposado", "Gran Centenario Plata"),
    ("Hendrick's Gin Oasium", "Hendrick's Gin"), ("Montenegro", "Amaro Montenegro"), ("Hendricks", "Hendrick's Gin"),
    ("Del Maguey Vida Single Village Mezcal", "Del Maguey Vida"), ("Plantation White", "Plantation 3 Stars"),
    ("Lagavulin 16 Year Old Single Malt Scotch", "Lagavulin 16"), ("Elijah Craig 18 Year", "Elijah Craig Small Batch"),
]
GRID = {"critic100": [60, 70, 85, 87.5, 92, 95, 100, 104], "wine_enthusiast": [79, 87, 93, 98], "iwsc": [80, 92, 95, 98],
        "murray": [94.5, 97.5], "tequila_matchmaker": [89], "drinkhacker": [3, 6, 8, 8.5, 9, 9.5, 10],
        "ten": [7, 8.5], "barrels5": [2.5, 4], "stars5": [4, 5]}
MEDALS = [("sfwsc", "Double Gold"), ("iwsc", "Spirit Gold Outstanding"), ("iwsc", "Silver Outstanding"),
          ("default", "Gold"), ("cmb", "Grand Gold"), ("sfwsc", "Packaging Gold"), ("iwsc", "Whisky Highball Bronze"), ("other_competition", "Bronze")]
ATTR_KEYS = ["age_years", "abv", "proof", "batch", "single_barrel", "store_pick"]

def safe(o):
    return json.dumps(o).replace("</", "<\\/")

def main():
    js = block("app.js", "app.js")
    ts = strip_ts(block("supabase/functions/research-bottle/index.ts", "research-bottle"))
    page = f"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const NAMES = {safe(NAMES)}, PAIRS = {safe(PAIRS)}, GRID = {safe(GRID)}, MEDALS = {safe(MEDALS)};
function runApp() {{ {js}
  return {{ norm: NAMES.map(normName), attrs: NAMES.map(parseAttrs), same: PAIRS.map(([a, b]) => sameBottle(normName(a), normName(b))) }}; }}
function runFn() {{ {ts}
  return {{ norm: NAMES.map(normName), attrs: NAMES.map(parseAttrs), cat: NAMES.map(guessCategory),
    same: PAIRS.map(([a, b]) => sameBottle(normName(a), normName(b))),
    to10: Object.entries(GRID).map(([s, xs]) => xs.map((x) => to10(s, x))),
    medal: MEDALS.map(([s, m]) => medalTo10(s, m)) }}; }}
let out;
try {{ out = {{ app: runApp(), fn: runFn() }}; }} catch (e) {{ out = {{ error: String(e && e.stack || e) }}; }}
document.getElementById("out").textContent = JSON.stringify(out);
</script>"""
    with tempfile.TemporaryDirectory() as tmp:
        f = pathlib.Path(tmp) / "t.html"; f.write_text(page)
        dom = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000",
                              "--dump-dom", f.as_uri()], capture_output=True, text=True, timeout=90).stdout
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m or not m.group(1).strip(): print("FAIL  code did not run in Chrome"); sys.exit(2)
    res = json.loads(m.group(1).replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    if "error" in res: print("FAIL  " + res["error"][:500]); sys.exit(2)
    fails = total = 0
    def check(label, got, want):
        nonlocal fails, total
        total += 1
        if got != want:
            fails += 1
            print(f"FAIL  {label}: got {got!r}, want {want!r}")
    for i, name in enumerate(NAMES):
        want_n = N.norm_name(name)
        check(f"app.js normName({name!r})", res["app"]["norm"][i], want_n)
        check(f"research-bottle normName({name!r})", res["fn"]["norm"][i], want_n)
        want_a = {k: N.parse_attrs(name)[k] for k in ATTR_KEYS}
        for side in ("app", "fn"):
            got_a = {k: res[side]["attrs"][i][k] for k in ATTR_KEYS}
            check(f"{side} parseAttrs({name!r})", got_a, want_a)
        check(f"research-bottle guessCategory({name!r})", res["fn"]["cat"][i], N.guess_category(name))
    for i, (a, b) in enumerate(PAIRS):
        check(f"app.js sameBottle({a!r}, {b!r})", res["app"]["same"][i], N.same_bottle(N.norm_name(a), N.norm_name(b)))
        check(f"research-bottle sameBottle({a!r}, {b!r})", res["fn"]["same"][i], N.same_bottle(N.norm_name(a), N.norm_name(b)))
    for (scale, xs), got in zip(GRID.items(), res["fn"]["to10"]):
        for x, g in zip(xs, got):
            check(f"research-bottle to10({scale}, {x})", round(g, 6), round(N.to_10(scale, x), 6))
    for (scale, medal), got in zip(MEDALS, res["fn"]["medal"]):
        check(f"research-bottle medalTo10({scale}, {medal!r})", got, N.medal_to_10(scale, medal))
    print(f"{total - fails}/{total} agree" + ("" if not fails else f" — {fails} DIFFER"))
    sys.exit(0 if not fails else 2)

main()
