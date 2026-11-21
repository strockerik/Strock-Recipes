"""Pure helpers for the spirits ratings catalog — no network, no database.

Everything here is deterministic so testing-skills/ratings_normalize_test.py can
pin it down:
  norm_name(text)        -> lowercase, mark-free, abbreviation-expanded match key
  parse_attrs(text)      -> age / ABV / proof / batch / single barrel pulled from a name
  to_10(scale, raw)      -> one source score on the House Index 0-10 scale (unrounded)
  round_half(x)          -> nearest 0.5 (halves round up), clamped to 0..10
  medal_to_10(scale, m)  -> medal-only result on the 0-10 scale
  attrs_compatible(a, b) -> False when two names disagree on a hard attribute

A score means what its source says (owner's rule, 2026-11-21): 8/10 is 8.0, 79.5
points is 7.95, 4.5 of 5 stars is 9.0. No source's numbers are bent up or down for
being harsh, generous or less credible; how much a source counts is its WEIGHT in
the consensus. (Until then each source had its own curve, which turned an 8/10
into a 6.75 and a 79.5 into a 5.4.)
"""
import re
import unicodedata

# ---------------------------------------------------------------------------
# Score scales. Keys match rating_sources.scale in the database.
# Each table is a list of (source_score, house_score) pairs: a straight line.
# ---------------------------------------------------------------------------
_OUT_OF_100 = [(0, 0.0), (100, 10.0)]
_OUT_OF_10 = [(0, 0.0), (10, 10.0)]
_OUT_OF_5 = [(0, 0.0), (5, 10.0)]
ANCHORS = {
    "critic100": _OUT_OF_100,           # Whisky Advocate, BTI, USC, Distiller expert
    "wine_enthusiast": _OUT_OF_100,
    "iwsc": _OUT_OF_100,
    "murray": _OUT_OF_100,
    "tequila_matchmaker": _OUT_OF_100,
    "competition100": _OUT_OF_100,      # Bartender Spirits Awards, Denver, TAG
    "critic100_harsh": _OUT_OF_100,     # Whiskyfun, The Lone Caner
    "drinkhacker": _OUT_OF_10,
    "ten": _OUT_OF_10,                  # Bourbon Culture, Whiskey Wash, RumX
    "barrels5": _OUT_OF_5,              # Breaking Bourbon
    "stars5": _OUT_OF_5,                # The GIN is IN, Fat Rum Pirate
}

# A medal with no published points has no number to read, so it gets one ladder for
# every competition, with Gold at 8 (owner's choice, 2026-11-21: scores above 8 should
# stay rare, and most entries to a competition win something). A competition that
# publishes points is read from its points. How much it counts is its weight.
MEDALS = {
    "default": {"bronze": 6.0, "silver": 7.0, "silver outstanding": 7.5, "gold": 8.0,
                "gold outstanding": 8.5, "double gold": 9.0, "grand gold": 9.0,
                "platinum": 9.5, "trophy": 9.5, "best in show": 9.5},
}


def _interp(table, x):
    if x <= table[0][0]:
        return table[0][1]
    if x >= table[-1][0]:
        return table[-1][1]
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    raise AssertionError("unreachable")


def to_10(scale, raw):
    """Map one raw score onto 0-10 (unrounded). Unknown scale -> ValueError."""
    if scale not in ANCHORS:
        raise ValueError(f"unknown scale {scale!r}; add it to ANCHORS")
    return _interp(ANCHORS[scale], float(raw))


def round_half(x):
    """Nearest 0.5, halves rounding up (8.25 -> 8.5, 8.75 -> 9.0), clamped 0..10."""
    import math
    return max(0.0, min(10.0, math.floor(x * 2 + 0.5) / 2))


def medal_to_10(scale, medal):
    """Medal text -> 0-10, or None if it isn't a medal we score."""
    m = clean_medal(medal)
    if not m:
        return None
    table = MEDALS.get(scale, MEDALS["default"])
    return table.get(m)


def clean_medal(medal):
    """'Spirit Gold Outstanding' -> 'gold outstanding'; 'Packaging Gold' -> None."""
    if not medal:
        return None
    m = re.sub(r"\s+", " ", medal.strip().lower())
    # Non-liquid awards are about the bottle or the mix, not the spirit
    if re.match(r"(packaging|design|label|mixer|whisky highball|highball|rtd|alternative drinks)\b", m):
        return None
    m = re.sub(r"^spirits?\s+", "", m)
    return m or None


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------
_ABBREV = [
    (r"\by\.?\s?o\.?\b", "year old"),
    (r"\byrs?\b", "year"),
    (r"\byears?\s+old\b", "year old"),
    (r"\byear\b(?!\s+old)", "year old"),
    (r"\bb\.?i\.?b\.?\b", "bottled in bond"),
    (r"\bs\.?i\.?b\.?\b", "single barrel"),
    (r"\bcs\b", "cask strength"),
    (r"\bst\b\.?", "saint"),
    (r"&", " and "),
]
_NOISE = r"\b(the|kentucky straight|straight|whiskey|whisky|liqueur)\b"


# Letters NFKD leaves whole (ø, æ, ß, ł…): fold them by hand so "Skærbæk" and
# "Skaerbaek" share a key. The JS/TS ports carry the same table.
_FOLD = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe",
                       "ß": "ss", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "þ": "th",
                       "Þ": "Th", "ð": "d", "Ð": "D"})


def strip_marks(text):
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).translate(_FOLD)
    return re.sub(r"[®™©]", "", text)


def norm_name(text):
    """Match key: 'Knob Creek® 9 YO Kentucky Straight Bourbon' -> 'knob creek 9 year old bourbon'."""
    t = strip_marks(text).lower()
    t = re.sub(r"(\d)\s*(yo|y\.o\.|yr|yrs)\b", r"\1 \2", t)  # '12yo' -> '12 yo'
    for pat, rep in _ABBREV:
        t = re.sub(pat, rep, t)
    t = re.sub(r"['’`]", "", t)            # maker's -> makers
    t = re.sub(r"\b(?:[a-z]\.)+[a-z]\b\.?", lambda m: m.group(0).replace(".", ""), t)  # j.m -> jm
    t = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", t)   # keep only decimal points (62.25%)
    t = re.sub(r"[^a-z0-9.%]+", " ", t)
    t = re.sub(_NOISE, " ", t)
    t = re.sub(r"\byear old year old\b", "year old", t)
    return re.sub(r"\s+", " ", t).strip()


def parse_attrs(text):
    """Pull the discriminating attributes out of a product name."""
    t = strip_marks(text).lower()
    out = {"age_years": None, "abv": None, "proof": None, "batch": None,
           "single_barrel": bool(re.search(r"single\s+barrel|\bsib\b", t)),
           "store_pick": bool(re.search(r"store pick|selected by|private (barrel|selection)", t))}
    m = re.search(r"\b(\d{1,2})\s*(?:-|\s)?(?:years?\s*old|years?|yrs?|y\.?o\.?)\b", t)
    if m:
        out["age_years"] = int(m.group(1))
    m = re.search(r"(\d{2}(?:\.\d{1,2})?)\s*%\s*(?:abv|alc|vol)?", t)
    if m:
        out["abv"] = float(m.group(1))
    m = re.search(r"\b(\d{2,3}(?:\.\d)?)\s*proof\b", t)
    if m:
        out["proof"] = float(m.group(1))
        if out["abv"] is None:
            out["abv"] = round(out["proof"] / 2, 2)
    m = re.search(r"\bbatch\s*(?:no\.?|#)?\s*([a-z]?\d[\w-]*)", t) or \
        re.search(r"\b([abc]\d{3})\b", t)                      # e.g. A224, C925 barrel-proof codes
    if m:
        out["batch"] = m.group(1).upper()
    return out


def attrs_compatible(a, b):
    """Hard rules: ages must match, ABV within 0.3, batch codes must match — when both sides state them."""
    if a.get("age_years") is not None and b.get("age_years") is not None \
            and a["age_years"] != b["age_years"]:
        return False
    if a.get("abv") is not None and b.get("abv") is not None \
            and abs(a["abv"] - b["abv"]) > 0.3:
        return False
    if a.get("batch") and b.get("batch") and a["batch"] != b["batch"]:
        return False
    return True


# Words that say what a spirit IS rather than WHICH bottle it is: "Elijah Craig
# Small Batch Bourbon" and "Elijah Craig Small Batch" are one bottle, but
# "Gran Centenario Reposado" and "... Plata" are not, and neither are "Hendrick's
# Gin" and "Hendrick's Gin Oasium". Longest phrases first.
_GENERIC = ["single malt scotch", "single malt", "single village", "london dry", "blended scotch",
            "kentucky", "tennessee", "american", "irish", "canadian", "japanese", "scotch", "bourbon",
            "gin", "rum", "rhum", "tequila", "vodka", "mezcal", "brandy", "cognac", "amaro", "spirits",
            "distillery", "distilling", "company", "co", "and", "of"]
_GENERIC_RE = re.compile(r"\b(" + "|".join(re.escape(g) for g in _GENERIC) + r")\b")


def bottle_words(key):
    """The words of a norm_name() key that pick out the bottle."""
    return frozenset(_GENERIC_RE.sub(" ", key or "").split())


# A spirit type both names state has to agree: "Cutwater Gin" and "Cutwater
# Vodka" share every other word but are two bottles, as are "Cutwater Mezcal
# Anejo" and "... Tequila Anejo" (2026-11-12). Rum/rhum and brandy/cognac are one
# type each; a name with no type word ("Hendrick's") still matches "Hendrick's Gin".
_TYPE_GROUPS = {"gin": "gin", "vodka": "vodka", "rum": "rum", "rhum": "rum", "tequila": "tequila",
                "mezcal": "mezcal", "brandy": "brandy", "cognac": "brandy", "bourbon": "bourbon",
                "scotch": "scotch", "tennessee": "tennessee"}


def spirit_types(key):
    return frozenset(_TYPE_GROUPS[w] for w in (key or "").split() if w in _TYPE_GROUPS)


def same_bottle(key_a, key_b):
    """Strict: two keys name one bottle only when their distinguishing words are
    identical and the spirit types they state (if both state one) overlap."""
    a, b = bottle_words(key_a), bottle_words(key_b)
    if not a or a != b:
        return False
    ta, tb = spirit_types(key_a), spirit_types(key_b)
    return not (ta and tb and not ta & tb)


# Whole words only — "ginger" is not gin — except "whisk" (whiskey, whisky).
# The LAST type word in the name wins, because that's the noun: "Bourbon Cream
# Liqueur" is a liqueur, "Bourbon Barrel Aged Gin" a gin; parentheses are
# dropped first ("Barrel Aged Gin (Rye Whiskey Barrels)"). A generic whiskey
# then gives way to bourbon / rye / scotch anywhere in the name ("Straight Rye
# Whiskey" is rye). "Single malt" alone is whiskey — American, Japanese and
# Irish single malts exist; sfwsc_entries() makes it scotch when the region
# says Scotland.
_CATEGORY_WORDS = [
    ("bourbon", "bourbon"), ("rye", "rye"),
    ("scotch", "scotch"), ("islay", "scotch"), ("speyside", "scotch"),
    ("mezcal", "mezcal"), ("tequila", "tequila"), ("rum", "rum"), ("rhum", "rum"), ("cachaca", "rum"),
    ("gin", "gin"), ("vodka", "vodka"),
    ("cognac", "brandy"), ("armagnac", "brandy"), ("brandy", "brandy"), ("calvados", "brandy"), ("pisco", "brandy"),
    ("vermouth", "vermouth"), ("amaro", "amaro"), ("liqueur", "liqueur"), ("cordial", "liqueur"),
    ("creme de", "liqueur"), ("schnapps", "liqueur"),
    ("whisk", "whiskey"), ("single malt", "whiskey"),
]
_PREFIX_WORDS = {"whisk"}


def guess_category(text):
    """Best guess at the app's BAR_CATEGORIES bucket from a product name."""
    t = " " + re.sub(r"\([^)]*\)", " ", strip_marks(text).lower()) + " "
    hits = []                                         # (position, category)
    for word, cat in _CATEGORY_WORDS:
        pat = r"\b" + re.escape(word) + ("" if word in _PREFIX_WORDS else r"\b")
        hits += [(m.start(), cat) for m in re.finditer(pat, t)]
    if not hits:
        return "other"
    hits.sort()
    cat = hits[-1][1]
    if cat == "whiskey":
        specific = [c for _, c in hits if c in ("bourbon", "rye", "scotch")]
        if specific:
            return specific[-1]
    return cat


def query_relevant(query, text, need=0.6):
    """True when most of the query's word tokens appear in text (cheap search-result filter).
    Numbers are ignored so 'Knob Creek 9' still matches 'Knob Creek 9 Year Old'."""
    q = [w for w in norm_name(query).split() if len(w) > 1 and not w[0].isdigit()]
    if not q or not text:
        return True                                   # nothing to judge by: let it through
    words = set(norm_name(text).split())
    return sum(w in words for w in q) / len(q) >= need
