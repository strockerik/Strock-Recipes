"""Pure helpers for the spirits ratings catalog — no network, no database.

Everything here is deterministic so testing-skills/ratings_normalize_test.py can
pin it down:
  norm_name(text)        -> lowercase, mark-free, abbreviation-expanded match key
  parse_attrs(text)      -> age / ABV / proof / batch / single barrel pulled from a name
  to_10(scale, raw)      -> one source score on the House Index 0-10 scale (unrounded)
  round_half(x)          -> nearest 0.5 (halves round up), clamped to 0..10
  medal_to_10(scale, m)  -> medal-only result on the 0-10 scale
  attrs_compatible(a, b) -> False when two names disagree on a hard attribute

Why anchors and not score/10: published spirits scores sit almost entirely in
80-97, so dividing by ten would squash everything into 8.0-9.7. Each source gets
a piecewise-linear anchor table instead (interpolate between anchors, clamp at
the ends). These are calibration choices, not published conversions — once a
source has ~200 scores in the database, swap its anchors for a percentile map.
"""
import re
import unicodedata

# ---------------------------------------------------------------------------
# Score scales. Keys match rating_sources.scale in the database.
# Each table is a list of (source_score, house_score) pairs, ascending.
# ---------------------------------------------------------------------------
ANCHORS = {
    # Blind-panel / critic 100-point (Whisky Advocate, BTI, USC, Distiller expert)
    "critic100": [(70, 4.0), (80, 5.5), (85, 6.5), (88, 7.0), (90, 7.5), (92, 8.0),
                  (94, 8.5), (96, 9.0), (98, 9.5), (100, 10.0)],
    # Wine Enthusiast never publishes below 80
    "wine_enthusiast": [(80, 5.5), (83, 6.0), (87, 7.0), (90, 7.5), (94, 8.5),
                        (98, 9.5), (100, 10.0)],
    # IWSC is strict: Gold starts at 95, Silver 90-94, Bronze 85-89
    "iwsc": [(80, 5.0), (85, 6.0), (90, 7.0), (95, 8.0), (98, 9.0), (100, 9.5)],
    # Jim Murray's Whisky Bible runs high
    "murray": [(80, 5.0), (85, 6.0), (90, 7.0), (94, 8.0), (96, 8.5), (97.5, 9.0),
               (99, 9.5), (100, 10.0)],
    # Tequila Matchmaker panel is compressed; ~92 behaves like a perfect score
    "tequila_matchmaker": [(75, 5.0), (80, 6.0), (85, 7.0), (88, 8.0), (90, 8.5),
                           (92, 9.5), (100, 10.0)],
    # Drinkhacker's x/10 runs high and tracks its letter grades (A 9.5, A- 9.0,
    # B+ 8.5, B 8.0, C+ 6.0): line each grade up with the critic 100-point band
    # it corresponds to (A ~95, A- ~92, B+ ~89, B ~87)
    "drinkhacker": [(4.0, 4.0), (6.0, 5.0), (7.0, 6.0), (8.0, 6.75), (8.5, 7.25),
                    (9.0, 8.0), (9.5, 8.75), (10.0, 9.5)],
    # Already a full-range 10-point scale (Whiskey Wash current, Bourbon Culture)
    "ten": [(0, 0.0), (10, 10.0)],
    # Breaking Bourbon barrels, 0.5-5
    "barrels5": [(0, 0.0), (5, 10.0)],
    # Generic 5 stars (Whiskey Wash 2017-era, The GIN is IN's half stars, misc.)
    "stars5": [(1, 3.0), (2, 4.5), (3, 6.0), (4, 7.5), (5, 9.0)],
    # A competition's own points (Bartender Spirits Awards, TAG, International
    # Whisky Competition): 70-90% of entries medal, so its 90 is a critic's 85.
    # Same anchors as IWSC.
    "competition100": [(80, 5.0), (85, 6.0), (90, 7.0), (95, 8.0), (98, 9.0), (100, 9.5)],
    # Single palates who grade hard — Whiskyfun (80-89 "high quality", 90+
    # exceptional) and The Lone Caner (an 86 is "among the most startling, original
    # rums"): the critic curve two points lower. 2026-11-12 research, uncalibrated.
    "critic100_harsh": [(68, 4.0), (78, 5.5), (83, 6.5), (86, 7.0), (88, 7.5), (90, 8.0),
                        (92, 8.5), (94, 9.0), (96, 9.5), (98, 10.0)],
}

# Medal-only results (no points published). Values are on the 0-10 scale.
MEDALS = {
    "sfwsc": {"bronze": 5.5, "silver": 6.5, "gold": 7.5, "double gold": 8.5,
              "platinum": 8.5, "best in show": 9.0},
    # IWSC before points were published, plus its pre-2020 "Outstanding" tiers
    "iwsc": {"bronze": 6.0, "silver": 7.0, "silver outstanding": 7.5,
             "gold": 8.0, "gold outstanding": 9.0, "trophy": 9.0},
    # Also Concours Mondial de Bruxelles' Grand Gold, its top tier.
    "default": {"bronze": 6.0, "silver": 7.0, "gold": 8.0, "double gold": 8.5,
                "grand gold": 8.5, "platinum": 9.0},
    # Spirits Selection by Concours Mondial: medals capped at 30% of entries, on
    # its own point bands (Silver 82-84.9, Gold 85-91.9, Grand Gold 92+).
    "spirits_selection": {"silver": 6.0, "gold": 7.0, "grand gold": 8.0},
    # Denver International Spirits Competition (72% of 2021 entries medalled).
    "denver": {"bronze": 5.5, "silver": 6.5, "gold": 7.0, "double gold": 8.0, "platinum": 8.5},
    # ACSA Craft Spirits: Bronze 70-79, Silver 80-89, Gold 90-100, members only.
    "acsa": {"bronze": 5.0, "silver": 6.0, "gold": 7.0},
    # TAG Global Spirits Awards: Platinum is common (46 of ~250 medals in 2025).
    "tag": {"bronze": 5.5, "silver": 6.0, "gold": 7.0, "double gold": 7.5, "platinum": 8.0},
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
