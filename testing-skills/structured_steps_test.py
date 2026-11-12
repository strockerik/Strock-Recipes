#!/usr/bin/env python3
"""Structured-recipe steps test for extract-recipe (no backend, no spend).

A link whose page carries schema.org Recipe data is read straight from it (the
"structured" tier, no AI). This pulls the REAL parseInstructions (and the
helpers it uses) out of the Edge Function, strips the type annotations, and
runs it in headless Chrome: plain step lists, HowToSection groups, and
HowToTip entries, which go to notes rather than into the method (King Arthur
lists five tips after its steps; Cook mode used to walk through them as steps).
Run from anywhere in the repo:  python3 testing-skills/structured_steps_test.py
"""
import json, pathlib, re, subprocess, sys, tempfile

def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "supabase" / "functions").exists():
            return d
    sys.exit("no repo root found")
REPO = find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC = (REPO / "supabase/functions/extract-recipe/index.ts").read_text()

def fn(name):
    m = re.search(rf"^function {name}\(.*?^}}\n", SRC, re.S | re.M)
    if not m: sys.exit(f"FAIL  {name} not found in extract-recipe")
    return m.group(0)

def strip(ts):
    for pat, rep in [(r"\(html: string\): string \{", "(html) {"), (r"\(s: string\): string \{", "(s) {"),
                     (r"\(v: unknown\): string \{", "(v) {"),
                     (r"\(v: unknown, tips: string\[\] = \[\]\): \{ text: string; group: string \| null \}\[\] \{", "(v, tips = []) {"),
                     (r"const out: \{ text: string; group: string \| null \}\[\] = \[\];", "const out = [];"),
                     (r"\(raw: string, group: string \| null\)", "(raw, group)"),
                     (r"\(node: unknown, group: string \| null\)", "(node, group)"),
                     (r" as Record<string, unknown>", "")]:
        ts = re.sub(pat, rep, ts)
    if re.search(r":\s*(?:string|unknown|any)\b|\bas Record\b", ts): sys.exit("FAIL  type-strip left annotations — extend strip()")
    return ts

JS = "\n".join(strip(fn(n)) for n in ["htmlToText", "decodeEntities", "schemaText", "parseInstructions"])

STEP = lambda t: {"@type": "HowToStep", "text": t}
CASES = [
    ("a plain list of strings is the method", ["Mix.", "Bake."], [["Mix.", None], ["Bake.", None]], []),
    ("one blob splits on newlines", "Mix the batter.\nBake 30 minutes.", [["Mix the batter.", None], ["Bake 30 minutes.", None]], []),
    ("HowToSection names become groups",
     [{"@type": "HowToSection", "name": "Sauce", "itemListElement": [STEP("Simmer the tomatoes.")]},
      {"@type": "HowToSection", "name": "Pasta", "itemListElement": [STEP("Boil the pasta.")]}],
     [["Simmer the tomatoes.", "Sauce"], ["Boil the pasta.", "Pasta"]], []),
    ("HowToTip goes to tips, not the method (King Arthur's shape)",
     [STEP("Preheat the oven to 325°F."), STEP("Bake 70 minutes."),
      {"@type": "HowToTip", "text": "Want to make this recipe gluten-free? Use a <b>measure-for-measure</b> flour."},
      {"@type": "HowToTip", "text": "Use very ripe bananas."}],
     [["Preheat the oven to 325°F.", None], ["Bake 70 minutes.", None]],
     ["Want to make this recipe gluten-free? Use a measure-for-measure flour.", "Use very ripe bananas."]),
    ("a tip inside a section is still a tip",
     [{"@type": "HowToSection", "name": "Bread", "itemListElement": [STEP("Knead."), {"@type": ["HowToTip"], "text": "Flour your hands."}]}],
     [["Knead.", "Bread"]], ["Flour your hands."]),
]

PAGE = """<!doctype html><meta charset=utf-8><pre id=out></pre><script>
%s
var CASES = %s, R = [];
CASES.forEach(function (c) {
  var tips = [], got = parseInstructions(c[1], tips).map(function (s) { return [s.text, s.group]; });
  var ok = JSON.stringify(got) === JSON.stringify(c[2]) && JSON.stringify(tips) === JSON.stringify(c[3]);
  R.push({ name: c[0], pass: ok, detail: ok ? "" : JSON.stringify({ method: got, tips: tips }) });
});
document.getElementById("out").textContent = JSON.stringify(R);
</script>""" % (JS, json.dumps(CASES).replace("</", "<\\/"))

def main():
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(PAGE); path = f.name
    try:
        dom = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--dump-dom", f"file://{path}"],
                             capture_output=True, text=True, timeout=60).stdout
    finally:
        pathlib.Path(path).unlink(missing_ok=True)
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m or not m.group(1).strip(): sys.exit("FAIL  page produced no results (JS error?)")
    import html as _h
    res = json.loads(_h.unescape(m.group(1)))
    for r in res: print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "  >> " + r["detail"]))
    n = sum(r["pass"] for r in res)
    print(f"\n{n}/{len(res)} passed")
    sys.exit(0 if n == len(res) else 2)

if __name__ == "__main__":
    main()
