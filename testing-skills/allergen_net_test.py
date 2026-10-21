#!/usr/bin/env python3
"""Allergen safety-net test for generate-recipe + pair-drink (no backend, no spend).

The net (ALLERGEN_ALIASES / ALLERGEN_FAMILIES / allergyHit / describeAllergies)
lives in a block marked `==== ALLERGEN NET ====` that must be byte-identical in
both Edge Functions (each deploys as a single file). This test:
  1. asserts the two copies match;
  2. strips the block's few TypeScript annotations and runs the REAL code in
     headless Chrome (no Deno here) — so there's no Python port to drift;
  3. checks category allergies catch specific foods (shellfish -> shrimp),
     free-from forms don't false-positive (dairy vs coconut milk), and an except
     pattern can never erase the NEXT ingredient (a "Gluten-Free" title must not
     hide a real "flour" line).
Run from anywhere in the repo:  python3 testing-skills/allergen_net_test.py
"""
import json, pathlib, re, subprocess, sys, tempfile

def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "supabase" / "functions").exists():
            return d
    sys.exit("no repo root found")
REPO = find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FILES = ["supabase/functions/generate-recipe/index.ts", "supabase/functions/pair-drink/index.ts"]
BLOCK_RE = re.compile(r"// ==== ALLERGEN NET ====\n.*?// ==== END ALLERGEN NET ====\n", re.S)

def block_of(path):
    m = BLOCK_RE.search((REPO / path).read_text())
    if not m: sys.exit(f"FAIL  no ALLERGEN NET block in {path}")
    return m.group(0)

def strip_types(ts):
    js = ts
    for pat, rep in [
        (r": Record<string, string\[\]> =", " ="),
        (r": Record<string, \{ foods: string\[\]; except: string\[\] \}> =", " ="),
        (r"recipe: \{ name\?: string; ingredients\?: Array<\{ item\?: string \}> \}", "recipe"),
        (r"\): \{ label: string; item: string \} \| null \{", ") {"),
        (r"(\w+): \{ label: string; item: string \}", r"\1"),
        (r"(\w+): string,", r"\1,"),
        (r"\((\w+): string\)", r"(\1)"),
        (r"(\w+): unknown\[\]", r"\1"),
        (r"\): string(?:\[\]| \| null)? \{", ") {"),
        (r"const (\w+): string\[\]", r"const \1"),
    ]:
        js = re.sub(pat, rep, js)
    left = re.findall(r":\s*(?:string|unknown|Record<|Array<)", js)
    if left: sys.exit(f"FAIL  type-strip left annotations behind: {left[:3]} — extend strip_types()")
    return js

# (allergies, recipe name, ingredient items, expected hit or None)
CASES = [
    # categories now caught
    (["shellfish"], "Garlic Shrimp", ["shrimp"], "shrimp (shellfish)"),
    (["Shellfish"], "Stir Fry", ["oyster sauce"], "oyster (shellfish)"),
    (["seafood"], "Caesar", ["Clamato juice"], "clamato (seafood)"),
    (["tree nuts"], "Salad", ["toasted almonds"], "almond (tree nuts)"),
    (["tree nuts"], "Mai Tai", ["orgeat syrup"], "orgeat (tree nuts)"),
    (["nuts"], "Noodles", ["peanut butter"], "peanut (nuts)"),
    (["dairy"], "Cookies", ["unsalted butter"], "butter (dairy)"),
    (["milk"], "Pasta", ["parmesan"], "parmesan (milk)"),
    (["dairy"], "Mudslide", ["Baileys"], "baileys (dairy)"),
    (["fish"], "Bloody Mary", ["worcestershire sauce"], "worcestershire (fish)"),
    (["fish"], "Puttanesca", ["anchovies"], "anchovy (fish)"),
    (["gluten"], "Pancakes", ["all-purpose flour"], "flour (gluten)"),
    (["egg"], "Slaw", ["mayonnaise"], "mayonnaise (egg)"),
    (["soy"], "Bowl", ["firm tofu"], "tofu (soy)"),
    (["sesame"], "Hummus", ["tahini"], "tahini (sesame)"),
    # the cook's own wording comes back for a plain or plural match
    (["peanut"], "Satay", ["peanuts"], "peanut"),
    (["peanuts"], "Brittle", ["salted peanuts"], "peanuts"),
    (["eggs"], "Frittata", ["eggs"], "eggs"),
    # unknown allergies fall back to a literal (plural-tolerant) match
    (["cilantro"], "Salsa", ["fresh cilantro"], "cilantro"),
    (["cashews"], "Curry", ["roasted cashew"], "cashews"),
    (["strawberry"], "Daiquiri", ["strawberries"], "strawberry"),
    # SAFETY: a free-from title or neighbour must not hide a real allergen line
    (["gluten"], "Gluten-Free Pancakes", ["flour", "milk"], "flour (gluten)"),
    (["dairy"], "Dairy-Free Mac", ["butter"], "butter (dairy)"),
    (["dairy"], "Granola", ["toasted almond slivers and butter"], "butter (dairy)"),
    # multi-word plant-based products are not dairy
    (["dairy"], "Pasta", ["vegan parmesan cheese", "dairy-free cream cheese", "plant-based butter", "coconut whipped cream"], None),
    # free-from and look-alike forms are NOT hits
    (["dairy"], "Curry", ["coconut milk", "peanut butter", "cream of coconut", "butter lettuce", "ginger beer"], None),
    (["milk"], "Latte", ["oat milk", "dairy-free cheese"], None),
    (["gluten"], "Pad Thai", ["gluten-free spaghetti", "rice noodles", "tamari", "ginger beer", "corn tortillas", "buckwheat"], None),
    (["gluten"], "Stir Fry", ["gluten-free soy sauce"], None),
    (["shellfish"], "Risotto", ["oyster mushrooms"], None),
    (["tree nuts"], "Stir Fry", ["water chestnuts", "nutmeg", "coconut", "butternut squash"], None),
    (["peanut"], "Peanut-Free Pad Thai", ["rice noodles"], None),
    (["egg"], "Ratatouille", ["eggplant", "vegan mayo"], None),
    (["fish"], "Paella", ["shellfish stock"], None),
    ([], "Anything", ["shrimp"], None),
]

def main():
    blocks = [block_of(f) for f in FILES]
    fails = 0
    if blocks[0] != blocks[1]:
        print("FAIL  ALLERGEN NET blocks differ between generate-recipe and pair-drink"); fails += 1
    else:
        print("  ok   ALLERGEN NET block identical in both functions")
    js = strip_types(blocks[0])
    harness = f"""<!doctype html><meta charset="utf-8"><title>RUN</title><pre id="out"></pre><script>
{js}
const CASES = {json.dumps(CASES)};
const out = CASES.map(([allergies, name, items, want]) => {{
  const hit = allergyHit({{ name, ingredients: items.map((item) => ({{ item }})) }}, allergies);
  return {{ allergies, items, want, got: hit ? hit.label : null }};
}});
const paella = allergyHit({{ name: "Paella - Seafood", ingredients: [{{ item: "olive oil" }}, {{ item: "400 g mussels" }}] }}, ["shellfish"]);
const repair = allergenRepairText("ASK", {{ label: "mussel (shellfish)", item: "400 g mussels" }});
const errText = allergenErrorText({{ label: "mussel (shellfish)", item: "400 g mussels" }});
const desc = describeAllergies(["Shellfish", "cilantro"]);
document.getElementById("out").textContent = JSON.stringify({{ out, desc, none: describeAllergies([]), paella, repair, errText }});
</script>"""
    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp) / "allergen.html"
        page.write_text(harness)
        dom = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000",
                              "--dump-dom", page.as_uri()], capture_output=True, text=True, timeout=90).stdout
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m or not m.group(1).strip():
        print("FAIL  block did not run in Chrome (syntax error after type-strip?)"); sys.exit(2)
    res = json.loads(m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    for r in res["out"]:
        ok = r["got"] == r["want"]
        fails += not ok
        print(("  ok   " if ok else "FAIL  ") + f"{r['allergies']} {r['items']} -> {r['got']!r}" + ("" if ok else f"   (want {r['want']!r})"))
    d = res["desc"]
    for label, cond in [("describeAllergies spells out the family", d.startswith("Shellfish (includes shrimp, prawn")),
                        ("describeAllergies keeps unknown allergies as typed", d.endswith("; cilantro")),
                        ("describeAllergies of nothing is 'none'", res["none"] == "none"),
                        ("hit reports the offending ingredient line", res["paella"] == {"label": "mussel (shellfish)", "item": "400 g mussels"}),
                        ("repair prompt keeps the request and names the line", res["repair"].startswith("ASK\n\nIMPORTANT") and '"400 g mussels"' in res["repair"] and "mussel (shellfish)" in res["repair"]),
                        ("cook-facing error quotes the line", "mussel (shellfish) (“400 g mussels”)" in res["errText"])]:
        fails += not cond
        print(("  ok   " if cond else "FAIL  ") + label + ("" if cond else f"   got {d!r}"))
    total = len(res["out"]) + 7
    print(f"\n{total - fails}/{total} passed")
    sys.exit(0 if not fails else 2)

main()
