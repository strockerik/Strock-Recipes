#!/usr/bin/env python3
"""Match-quality benchmark over testing-skills/benchmark-recipes.json.

Runs the diverse corpus through faithful Python ports of the shipped grocery /
King-Soopers transforms and asserts the edge-case behaviours we tuned for
(self-made exclusion, serving-size scaling, canonical folds, pantry staples,
store-form hints, plainest-product matching). It is a REGRESSION guard on the
*rules*, not a live store test — the ports below mirror:
  - app.js  : canonicalizeItem / INGREDIENT_ALIASES / normalizeItemName /
              isPantryStaple / servesPeople / combinedGroceryItems exclusions
  - kroger/index.ts : searchTerm store hints + driftPenalty (pickDefault)
Keep them in sync with those files (the code stays the source of truth). Runs
offline, no Chrome, no network.
"""
import json, math, os, re, sys

CORPUS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "benchmark-recipes.json")

# ---------------------------------------------------------------- app.js ports
INGREDIENT_ALIASES = [
    (re.compile(r"\b(?:boneless|skinless)\b", re.I), " "),
    (re.compile(r"\b(?:breasts?|thighs?)\s+or\s+(?:breasts?|thighs?)\b", re.I), "breast"),
    (re.compile(r"\bchicken\s+breasts\b", re.I), "chicken breast"),
    (re.compile(r"\b(?:instant\s+dry|rapid[-\s]?rise|quick[-\s]?rise|bread\s+machine)\s+yeast\b", re.I), "instant yeast"),
    (re.compile(r"\b(?:(?:yellow|medium|large|small|grated|minced|diced|chopped)\s+)+onions?\b", re.I), "onion"),
    (re.compile(r"(?<!,\s)\b(?:(?:whole|warm|hot|cold|lukewarm|2\s*%|1\s*%|skim|nonfat|reduced[-\s]?fat)\s+)+milk\b", re.I), "milk"),
    (re.compile(r"\bscallions?\b", re.I), "green onion"),
    (re.compile(r"\bspaghetti\s+pasta\b", re.I), "spaghetti"),
    (re.compile(r"\bgarlic\s+cloves?\b", re.I), "garlic"),
    (re.compile(r"\bcloves?\s+of\s+garlic\b", re.I), "garlic"),
    (re.compile(r"\b(?:low[-\s]?moisture\s+whole[-\s]?milk|whole[-\s]?milk\s+low[-\s]?moisture)\s+mozzarella\b", re.I), "low-moisture whole-milk mozzarella"),
    (re.compile(r"\bparmigiano(?:[-\s]?reggiano)?\b", re.I), "parmesan"),
    (re.compile(r"\bparmesan\s+cheese\b", re.I), "parmesan"),
    (re.compile(r"\bfresh(?:ly)?[-\s]squeezed\s+(lemon|lime|orange|grapefruit)\s+juice\b", re.I), r"\1"),
    (re.compile(r"\b(lemon|lime|orange|grapefruit)\s+(?:juice\s+and\s+)?zest\b", re.I), r"\1"),
    (re.compile(r"\b(lemon|lime|orange|grapefruit)\s+peel\b", re.I), r"\1"),
    (re.compile(r"\b(citric|malic|ascorbic|lactic|tartaric)\s+acid\s+powder\b", re.I), r"\1 acid"),
]
PASTA_SHAPE_RE = re.compile(r"\b(?:spaghetti|bucatini|vermicelli|angel\s*hair|linguine|fettuccine|tagliatelle|pappardelle|penne|rigatoni|macaroni|fusilli|rotini|orzo|ziti|farfalle|cavatappi|cellentani|lasagn[ae]|noodles?)\b", re.I)

def canonicalizeItem(name):
    s = re.sub(r"[\"“”]", "", str(name or ""))
    s = re.sub(r"([a-z])/([a-z])", r"\1 \2", s, flags=re.I)
    if re.search(r"\bor\b", s, re.I) and (re.search(r"\bpasta\b", s, re.I) or PASTA_SHAPE_RE.search(s)):
        return "pasta"
    for rx, to in INGREDIENT_ALIASES:
        s = rx.sub(to, s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*,\s*", ", ", s)
    s = re.sub(r",\s*,", ",", s)
    s = re.sub(r"(^[\s,]+)|([\s,]+$)", "", s)
    return s.strip()

PREP_WORDS = ("to taste|diced|finely diced|roughly diced|chopped|finely chopped|roughly chopped|minced|finely minced|"
    "grated|finely grated|freshly grated|shredded|sliced|thinly sliced|finely sliced|cubed|crushed|melted|softened|"
    "room temperature|at room temperature|very cold|sifted|divided|drained|rinsed|optional|peeled|seeded|deseeded|"
    "halved|quartered|crumbled|beaten|packed|cooked|uncooked|toasted|warmed|chilled")
PREP_CLAUSE_RE = re.compile(r",\s*(?:" + PREP_WORDS + r"|plus more\b.*|for\b.*|to top\b.*|to serve\b.*|to garnish\b.*)[^,]*", re.I)

def normalizeItemName(name):
    s = canonicalizeItem(str(name)).lower().strip()
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.split(r"\s[—–-]\s", s)[0]
    s = PREP_CLAUSE_RE.sub(" ", s)
    s = re.sub(r",\s*(?:whole[-\s]?milk|full[-\s]?fat|low[-\s]?fat|reduced[-\s]?fat|non[-\s]?fat|fat[-\s]?free|part[-\s]?skim|2\s*%|1\s*%|skim)\s*$", "", s)
    s = re.sub(r"\b(?:black|white|freshly ground|ground)\s+pepper\b", "pepper", s)
    s = re.sub(r"\b(?:kosher|sea|maldon|flaky|fine|table)\s+salt\b", "salt", s)
    s = re.sub(r"\bextra[-\s]?virgin\s+olive oil\b", "olive oil", s)
    s = re.sub(r"\bevoo\b", "olive oil", s)
    s = re.sub(r"\bconfectioners'?\s+sugar\b", "powdered sugar", s)
    s = re.sub(r"\bgarbanzos?\b", "chickpea", s)
    s = re.sub(r"\bfreshly\s+squeezed\b", " ", s)
    s = re.sub(r"\bfresh\b", " ", s)
    s = re.sub(r"\bcloves\b", "clove", s)
    s = re.sub(r"\begg\s+(?:yolks?|whites?)\b", "eggs", s)
    s = re.sub(r"\beggs\b", "egg", s)
    s = re.sub(r"\b(?:heavy\s+)?whipping cream\b", "heavy cream", s)
    s = re.sub(r"\b(carrot|onion|shallot|pepper|mushroom)s\b", r"\1", s)
    s = re.sub(r"\b(potato|tomato)es\b", r"\1", s)
    return re.sub(r"\s+", " ", s.replace(",", " ")).strip()

PANTRY_STAPLE_RE = re.compile(r"\b(?:salt|pepper|oil|water|sugar|butter|flour)\b", re.I)
def isPantryStaple(name_lower):
    n = re.sub(r"\b(?:bell|red|green|chili|chilli|sweet|cayenne|lemon|jalape\w*)\s+pepper", " ", name_lower)
    n = re.sub(r"\b(?:almond|coconut|oat|rice|chickpea|nut|cake|bread|pastry|potato|corn|semolina|tapioca|spelt|rye|00|high[-\s]?gluten|pizza)\s+flour", " ", n)
    n = re.sub(r"\bpuff pastry\b", " ", n)
    n = re.sub(r"\ball[-\s]?butter\b", " ", n)
    n = re.sub(r"\b(?:peanut|almond|apple|cocoa|shea|nut|cashew)\s+butter\b", " ", n)
    n = re.sub(r"\b(?:packed\s+)?in\s+(?:water|brine|oil|juice)\b", " ", n)
    return bool(PANTRY_STAPLE_RE.search(n))

PEOPLE_SERVING_RE = re.compile(r"\b(?:serving|servings|portion|portions|serves|person|people|drink|drinks|glass|glasses|bowl|bowls|cocktail|cocktails)\b", re.I)
def servesPeople(label):
    l = (label or "").strip()
    return (not l) or bool(PEOPLE_SERVING_RE.search(l))

ALT_RE = re.compile(r"\b(?:alternative to|substitute for|instead of|in place of|as a substitute)\b", re.I)

def clove_to_count(unit):  # canonicalQuantity: clove -> bare count
    return None if (unit or "").lower() in ("clove", "cloves") else (unit or None)

# Citrus: peel + juice -> whole-fruit count (max juice/peel per recipe, sum across).
CITRUS_YIELD = {"lime": (24, 6), "lemon": (36, 10), "orange": (90, 20), "grapefruit": (150, 32)}
WEIGHT_TO_G = {"g": 1, "gram": 1, "grams": 1, "kg": 1000, "oz": 28.3495, "ounce": 28.3495, "lb": 453.592, "pound": 453.592}
VOLUME_TO_ML = {"ml": 1, "l": 1000, "liter": 1000, "cup": 236.588, "tbsp": 14.787, "tsp": 4.929, "fl oz": 29.5735}
def _canon_qty(amount, unit):
    u = (unit or "").lower()
    if u in WEIGHT_TO_G: return (amount * WEIGHT_TO_G[u] if amount is not None else None, "weight")
    if u in VOLUME_TO_ML: return (amount * VOLUME_TO_ML[u] if amount is not None else None, "volume")
    return (amount, None)
def combine_citrus(recipes_list):
    """Return {fruit: count} summed across the given recipes."""
    total = {}
    for rec in recipes_list:
        rc = {}
        for ing in rec:
            raw = str(ing.get("item", "")).lower()
            nk = normalizeItemName(ing["item"])
            if nk not in CITRUS_YIELD:
                continue
            amt, fam = _canon_qty(ing.get("amount"), ing.get("unit"))
            d = rc.setdefault(nk, {"juiceMl": 0, "peelG": 0, "whole": 0})
            if re.search(r"\bjuice\b", raw) and fam == "volume" and amt is not None:
                d["juiceMl"] += amt
            elif re.search(r"\b(?:peel|zest|rind)\b", raw) and fam == "weight" and amt is not None:
                d["peelG"] += amt
            else:
                d["whole"] += amt if (fam is None and amt is not None) else 1
        for f, d in rc.items():
            juice_ml, peel_g = CITRUS_YIELD[f]
            n = d["whole"] + max(-(-d["juiceMl"] // juice_ml), -(-d["peelG"] // peel_g))
            total[f] = total.get(f, 0) + int(n)
    return total

# ---------------------------------------------------------------- kroger ports
def searchTerm_hint(item):
    r = str(item or "").lower()
    if re.search(r"\bchocolate\b", r) and not re.search(r"\b(?:chips?|bar|bars|candy|cocoa|syrup|milk|hot)\b", r):
        k = re.search(r"\b(dark|semi[-\s]?sweet|bittersweet|white)\b", r)
        return (re.sub(r"[-\s]", "", k.group(1)) + " " if k else "") + "chocolate chips"
    if re.search(r"\btomato(?:es)?\b", r) and re.search(r"\bfor (?:the )?sauce\b|\bfor pizza\b", r) \
            and not re.search(r"\btomato\s+(?:paste|puree|sauce)\b", r) and not re.search(r"\b(?:cherry|grape|snacking|sun[-\s]?dried)\b", r):
        return "crushed tomatoes"
    if re.search(r"\bcheese\b", r) and not re.search(r"\b(?:cream|cottage|feta|parmesan|parmigiano|pecorino|romano|cheddar|mozzarella|swiss|gouda|brie|blue|goat|ricotta|provolone|american|monterey|colby|gruyere|string|nacho|queso|mascarpone|velveeta)\b", r):
        return "shredded cheddar cheese"
    return None  # (falls through to the generic term builder in the real fn)

# Minimal mirror of the kroger searchTerm noise-strip (only what the condensed
# adversarial checks need): condensed is soup-only, never blanket.
def kroger_strip(item):
    s = str(item or "").lower()
    s = re.sub(r"\bcondensed\s+soup\b", "soup", s)
    s = re.sub(r"\b(?:boneless|skinless|baby|fresh|freshly|organic|canned|can|chunk|sprigs?|large|extra)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()

RAW_MEAT_RE = re.compile(r"\b(?:chicken|beef|pork|turkey|steak|sausage|ground)\b")
DELI_ASKED_RE = re.compile(r"\b(?:deli|lunch|jerky|smoked|cured|rotisserie)\b")
DELI_WORDS = ["lunchmeat", "lunch meat", "deli", "jerky", "snack", "rotisserie", "thin sliced"]
PRODUCE_RE = re.compile(r"\b(?:carrot|potato|tomato|onion|lettuce|spinach|celery|pepper|cucumber|broccoli|cauliflower|zucchini|squash|mushroom|cabbage|kale|corn|apple|pear|banana|orange|lemon|lime|berry|berries|strawberr(?:y|ies)|blueberr(?:y|ies)|grape|peach|plum|mango|avocado|beet|radish|eggplant|asparagus|arugula|yam)(?:e?s)?\b")
DRIFT_WORDS = ["sauce", "mix", "seasoning", "seasoned", "flavored", "blend"]
PRODUCE_PROC_WORDS = ["baby", "peeled", "cut", "sliced", "shredded", "snacking", "canned", "jarred", "frozen", "dried", "cheesy", "creamy", "gouda", "candied", "glazed", "marinated"]
def _hasw(s, w): return re.search(r"\b" + w.replace(" ", r"\s+") + r"\b", s) is not None
def driftPenalty(description, q):
    d = str(description or "").lower(); words = list(DRIFT_WORDS)
    if PRODUCE_RE.search(q): words += PRODUCE_PROC_WORDS
    if RAW_MEAT_RE.search(q) and not DELI_ASKED_RE.search(q): words += DELI_WORDS
    return sum(1 for w in words if _hasw(d, w) and not _hasw(q, w))
def best_pick(cands, q):
    return sorted(range(len(cands)), key=lambda i: (driftPenalty(cands[i], q), i))[0]

# ---------------------------------------------------------------- combine model
def recipe_group_labels(rec):
    return {normalizeItemName(i["group"]) for i in rec["ingredients"] if i.get("group")}

def shopping_keys(rec):
    """nameKeys that survive to the shopping list for one recipe (staples kept —
    they're skipped only when 'skip staples' is on, which we test separately)."""
    groups = recipe_group_labels(rec)
    keys = []
    for ing in rec["ingredients"]:
        item = ing.get("item") or ""
        if not item or ALT_RE.search(item):
            continue
        nk = normalizeItemName(item)
        if nk in groups or nk in ("water", "liquid"):
            continue
        keys.append(nk)
    return keys

# ---------------------------------------------------------------- assertions
def main():
    corpus = json.load(open(CORPUS))
    recs = {r["name"]: r for r in corpus["recipes"]}
    checks = []
    def chk(name, cond, detail=""):
        checks.append((name, bool(cond), detail))

    # 1. Self-made ingredients excluded, their group inputs kept.
    for rname, made, kept in [
        ("Baked Macaroni and Cheese", "cheese sauce", "sharp cheddar"),
        ("Buttermilk Pancakes", "dry mix", "buttermilk"),
        ("Apple Pie", "pie crust", "granny smith apples"),
        ("Chicken Tikka Masala", "spice blend", "garam masala"),
    ]:
        keys = shopping_keys(recs[rname])
        chk(f"self-made '{made}' excluded ({rname})", made not in keys, ",".join(keys))
        chk(f"group input '{kept}' kept ({rname})", kept in keys, ",".join(keys))

    # 2. Serving-size: batch/yield recipes don't scale to household; people do.
    for rname, expect_people in [
        ("Chocolate Chip Cookies", False), ("Pizza - Margherita", False), ("Banana Bread", False),
        ("Homemade Croissants", False), ("Apple Pie", False), ("Dinner Rolls", False),
        ("Spaghetti and Meatballs", True), ("Boulevardier", True), ("Chili con Carne", True),
    ]:
        chk(f"servesPeople({recs[rname]['servings_label']!r}) == {expect_people} ({rname})",
            servesPeople(recs[rname]["servings_label"]) == expect_people)

    # 3. Canonical folds.
    chk("Parmigiano-Reggiano -> parmesan", canonicalizeItem("Parmigiano-Reggiano") == "parmesan")
    chk("parmesan cheese -> parmesan", canonicalizeItem("parmesan cheese") == "parmesan")
    chk("flexible 'bucatini (or any pasta)' -> pasta", canonicalizeItem("bucatini (or any pasta)") == "pasta")
    chk("flexible 'pasta (spaghetti or bucatini)' -> pasta", canonicalizeItem("pasta (spaghetti or bucatini)") == "pasta")
    chk("standalone 'spaghetti' kept", canonicalizeItem("spaghetti") == "spaghetti")
    chk("scallions -> green onion", canonicalizeItem("scallions") == "green onion")
    chk("boneless skinless chicken thighs -> chicken thighs", canonicalizeItem("boneless skinless chicken thighs") == "chicken thighs")
    chk("active dry yeast stays distinct", canonicalizeItem("active dry yeast") == "active dry yeast")
    chk("instant yeast unchanged", canonicalizeItem("instant yeast") == "instant yeast")
    chk("pecorino romano kept (not parmesan)", "parmesan" not in canonicalizeItem("pecorino romano"))

    # 4. Garlic: clove-unit line and 'garlic cloves' line share a combine key + count.
    chk("garlic combine key match",
        normalizeItemName("garlic") == normalizeItemName("garlic cloves") == "garlic")
    chk("clove unit -> bare count", clove_to_count("clove") is None and clove_to_count("cup") == "cup")

    # 4b. Egg singular/plural combine; egg noodles/eggplant untouched.
    chk("egg == eggs combine key", normalizeItemName("egg") == normalizeItemName("eggs") == "egg")
    chk("egg yolks -> egg", normalizeItemName("egg yolks") == "egg")
    chk("egg noodles untouched", normalizeItemName("egg noodles") == "egg noodles")
    chk("eggplant untouched", "egg" in normalizeItemName("eggplant") and normalizeItemName("eggplant") == "eggplant")

    # 5. Pantry staples.
    for item, staple in [("“00” flour", False), ("high-gluten flour", False), ("cake flour", False),
                         ("bread flour", False), ("all-purpose flour", True), ("salt", True),
                         ("butter", True), ("granulated sugar", True), ("olive oil", True)]:
        chk(f"isPantryStaple({item!r}) == {staple}", isPantryStaple(normalizeItemName(item)) == staple)

    # 6. Store-form search hints.
    chk("dark chocolate -> chips", searchTerm_hint("dark chocolate") == "dark chocolate chips")
    chk("tomatoes for the sauce -> crushed", searchTerm_hint("whole San Marzano tomatoes, for the sauce") == "crushed tomatoes")
    chk("bare 'cheese, if wanted' -> shredded cheddar", searchTerm_hint("cheese, if wanted") == "shredded cheddar cheese")
    chk("specific cheese untouched (feta)", searchTerm_hint("feta cheese") is None)

    # 7. Plainest-product matching (driftPenalty ordering).
    chk("vodka picks liquor over sauce",
        best_pick(["Sauz Creamy Calabrian Vodka Sauce", "Smirnoff Vodka"], "vodka") == 1)
    chk("carrots pick whole over baby/cut/peeled",
        best_pick(["Kroger Cut and Peeled Baby Carrots", "Kroger Whole Carrots"], "carrots") == 1)
    chk("floury potatoes pick plain over cheesy gouda",
        best_pick(["Cheesy Bliss Gouda Potatoes", "Kroger Russet Potatoes"], "potatoes") == 1)
    chk("canned chicken NOT penalized when recipe wants canned",
        best_pick(["Swanson Canned White Chicken Breast In Water", "Fresh Chicken Breast"], "white chicken breast") == 0)

    # 7b. Citrus peel/zest/fresh-squeezed juice -> the whole fruit (buy limes,
    #     not bottled juice / lime peel / peeled eggs). Plain juice stays bottled.
    chk("lime peel -> lime", canonicalizeItem("lime peel") == "lime")
    chk("fresh-squeezed lime juice -> lime", canonicalizeItem("fresh-squeezed lime juice") == "lime")
    chk("lemon juice and zest -> lemon", canonicalizeItem("lemon juice and zest") == "lemon")
    chk("lime zest -> lime", canonicalizeItem("lime zest") == "lime")
    chk("plain lemon juice stays bottled", canonicalizeItem("lemon juice") == "lemon juice")
    chk("lime peel & fresh-squeezed lime juice share a key",
        normalizeItemName("lime peel") == normalizeItemName("fresh-squeezed lime juice") == "lime")
    # 7c. Culinary acids: powder dropped (pantry match), citric != malic.
    chk("citric acid powder -> citric acid", canonicalizeItem("citric acid powder") == "citric acid")
    chk("malic acid powder -> malic acid", canonicalizeItem("malic acid powder") == "malic acid")
    chk("citric acid != malic acid", normalizeItemName("citric acid powder") != normalizeItemName("malic acid powder"))

    # 7d. Citrus -> whole-fruit count (max juice/peel per recipe, sum across; plain
    #     bottled juice not counted).
    super_juice = [{"amount": 200, "unit": "ml", "item": "fresh-squeezed lime juice"},
                   {"amount": 100, "unit": "g", "item": "lime peel"}]
    chk("Lime Super Juice -> 17 limes (max 9/17, not 26)", combine_citrus([super_juice]).get("lime") == 17)
    chk("peel-only counts (100 g -> 17 limes)", combine_citrus([[{"amount": 100, "unit": "g", "item": "lime peel"}]]).get("lime") == 17)
    chk("juice-only counts (200 ml -> 9 limes)", combine_citrus([[{"amount": 200, "unit": "ml", "item": "fresh-squeezed lime juice"}]]).get("lime") == 9)
    chk("count 'lemon juice and zest' -> 1 lemon", combine_citrus([[{"amount": 1, "unit": None, "item": "lemon juice and zest"}]]).get("lemon") == 1)
    chk("cross-recipe sum (1 lemon + 1 lemon = 2)",
        combine_citrus([[{"amount": 1, "unit": None, "item": "lemon"}], [{"amount": 1, "unit": None, "item": "lemon juice and zest"}]]).get("lemon") == 2)
    chk("plain bottled 'lime juice' NOT counted as fruit",
        combine_citrus([[{"amount": 200, "unit": "ml", "item": "lime juice"}]]).get("lime") is None)

    # 8. Alternatives dropped from the list.
    bb = shopping_keys(recs["Beef Bourguignon"])
    chk("'pancetta, alternative to bacon' dropped", not any("alternative" in k for k in bb) and "pancetta" not in bb, ",".join(bb))

    # 9. ADVERSARIAL — rules must NOT over-fire (anti-overfitting guards). Each
    #    input looks like it might trigger a rule but shouldn't.
    chk("condensed milk NOT stripped to plain milk", "condensed milk" in kroger_strip("sweetened condensed milk"))
    chk("evaporated milk untouched", "evaporated milk" in kroger_strip("evaporated milk"))
    chk("condensed SOUP still simplified", kroger_strip("cream of celery condensed soup") == "cream of celery soup")
    chk("red onion stays a variety (not folded)", canonicalizeItem("red onion") == "red onion")
    chk("white/sweet onion varieties stay", canonicalizeItem("sweet onion") == "sweet onion" and canonicalizeItem("white onion") == "white onion")
    chk("yellow/size onion still folds", canonicalizeItem("grated yellow onion") == "onion" and canonicalizeItem("medium onion") == "onion")
    chk("onion powder untouched", canonicalizeItem("onion powder") == "onion powder")
    chk("almond milk untouched", canonicalizeItem("almond milk") == "almond milk")
    chk("chocolate BAR not sent to chips", searchTerm_hint("dark chocolate bar") is None)
    chk("named cheese (mozzarella) not sent to cheddar", searchTerm_hint("mozzarella cheese") is None)
    chk("standalone chicken thighs not folded to breast", canonicalizeItem("chicken thighs") == "chicken thighs")
    chk("standalone spaghetti not folded to pasta", canonicalizeItem("spaghetti") == "spaghetti")
    chk("plain 'lime juice' not treated as whole fruit", combine_citrus([[{"amount": 100, "unit": "ml", "item": "lime juice"}]]).get("lime") is None)

    # ---- report ----
    for name, ok, detail in checks:
        print(("  ok   " if ok else "FAIL  ") + name + ("" if ok else "  >> " + detail))
    npass = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{npass}/{len(checks)} checks passed  (corpus: {len(corpus['recipes'])} recipes)")
    sys.exit(0 if npass == len(checks) else 2)

if __name__ == "__main__":
    main()
