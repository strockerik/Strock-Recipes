#!/usr/bin/env python3
"""One-time migration: quantify vague recipe ingredient amounts.

Prep notes (e.g. "carrots, diced") are intentionally LEFT IN PLACE — the recipe
and Cook views need them, and the grocery list already strips them at display
time (app.js `displayGroceryName`). This script only touches ingredients with a
vague, unmeasured amount ("a decent knob of butter", "a large handful of frozen
peas"): it asks Claude Haiku for a concrete amount + unit and a clean item name.
Every other ingredient is left exactly as stored.

Safe by default: runs as a DRY RUN that only prints a before/after diff.
Pass --apply to actually PATCH the changed rows. Idempotent — re-running after
an --apply changes nothing (the amounts are no longer null).

Credentials (never hard-code): read from environment, falling back to the
gitignored notes.md for the Supabase values.
  SUPABASE_URL                 e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service-role key (bypasses RLS — admin only)
  ANTHROPIC_API_KEY            required only for the vague-amount quantify step

Usage:
  python3 scripts/migrate_ingredients.py            # dry run (no writes)
  python3 scripts/migrate_ingredients.py --apply    # apply changes
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error

# --- prep-strip rule (mirror of app.js displayGroceryName) -------------------
PREP_WORDS = (
    "to taste|diced|chopped|finely chopped|roughly chopped|minced|grated|"
    "finely grated|freshly grated|shredded|sliced|thinly sliced|cubed|crushed|"
    "melted|softened|room temperature|at room temperature|sifted|divided|"
    "drained|rinsed|optional|peeled|seeded|deseeded|halved|quartered|crumbled|"
    "beaten|packed|cooked|uncooked|toasted|warmed|chilled"
)
PREP_CLAUSE_RE = re.compile(
    r",\s*(?:" + PREP_WORDS + r"|plus more\b.*|for\b.*|to top\b.*|to serve\b.*|to garnish\b.*)[^,]*",
    re.IGNORECASE,
)
VAGUE_RE = re.compile(r"\b(knob|handful|splash|drizzle|pinch|few|couple|some)\b", re.IGNORECASE)
SEASON_RE = re.compile(r"^\s*(salt|pepper|salt and (black )?pepper)[ ,].*(to taste)?\s*$", re.IGNORECASE)


def strip_prep(item: str) -> str:
    s = (item or "").strip()
    s = re.split(r"\s[—–-]\s", s)[0]          # drop a trailing dash note
    s = PREP_CLAUSE_RE.sub("", s)             # drop known prep clauses
    s = re.sub(r"\s+", " ", s).strip()
    return s.rstrip(", ").strip()


def is_vague(ing: dict) -> bool:
    return ing.get("amount") is None and bool(VAGUE_RE.search(ing.get("item") or "")) \
        and not SEASON_RE.match(ing.get("item") or "")


# --- credentials -------------------------------------------------------------
def load_notes():
    out = {}
    path = os.path.join(os.path.dirname(__file__), "..", "notes.md")
    try:
        text = open(path).read()
    except OSError:
        return out
    m = re.search(r"Project URL:\s*(\S+)", text)
    if m:
        out["url"] = m.group(1)
    m = re.search(r"Service Role:\s*(\S+)", text)
    if m:
        out["key"] = m.group(1)
    return out


notes = load_notes()
SUPABASE_URL = os.environ.get("SUPABASE_URL") or notes.get("url")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or notes.get("key")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
APPLY = "--apply" in sys.argv[1:]

if not SUPABASE_URL or not SERVICE_KEY:
    sys.exit("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env or notes.md).")


def sb_request(method, path, body=None):
    req = urllib.request.Request(
        SUPABASE_URL + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": "Bearer " + SERVICE_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def quantify(item: str):
    """Ask Claude Haiku for {amount, unit, item} for a vague ingredient."""
    if not ANTHROPIC_KEY:
        return None
    prompt = (
        "Give a concrete shopping quantity for this loosely-described recipe "
        "ingredient. Reply ONLY with JSON: {\"amount\": number, \"unit\": "
        "string-or-null, \"item\": clean-name-without-prep}. Example: "
        "\"a decent knob of butter\" -> {\"amount\": 2, \"unit\": \"tbsp\", "
        "\"item\": \"butter\"}. Ingredient: " + json.dumps(item)
    )
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 200,
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
        method="POST",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        text = "".join(b.get("text", "") for b in data.get("content", []))
        m = re.search(r"\{.*\}", text, re.S)
        return json.loads(m.group(0)) if m else None
    except (urllib.error.URLError, ValueError) as e:
        print(f"  ! quantify failed for {item!r}: {e}")
        return None


def main():
    recipes = sb_request("GET", "/rest/v1/recipes?select=id,name,ingredients")
    changed = 0
    for r in recipes:
        ings = r.get("ingredients") or []
        new_ings = []
        diffs = []
        recipe_changed = False
        for ing in ings:
            orig = ing.get("item") or ""
            if is_vague(ing):
                q = quantify(orig)
                if q:
                    ni = dict(ing)
                    ni["amount"] = q.get("amount", ni.get("amount"))
                    ni["unit"] = q.get("unit", ni.get("unit"))
                    ni["item"] = strip_prep(q.get("item") or orig)
                    diffs.append(f"    ~ {orig!r} -> {ni['amount']} {ni['unit'] or ''} {ni['item']!r}")
                    new_ings.append(ni)
                    recipe_changed = True
                else:
                    diffs.append(f"    ! could not quantify {orig!r} (left as-is)")
                    new_ings.append(ing)
            else:
                new_ings.append(ing)  # untouched — prep notes stay
        if diffs:
            print(f"\n{r['name']}:")
            print("\n".join(diffs))
        if recipe_changed:
            changed += 1
            if APPLY:
                sb_request("PATCH", f"/rest/v1/recipes?id=eq.{r['id']}", {"ingredients": new_ings})
                print("    -> applied")
    mode = "APPLIED" if APPLY else "DRY RUN (no writes — pass --apply to write)"
    print(f"\n{mode}: {changed} recipe(s) would change of {len(recipes)} total.")
    if not ANTHROPIC_KEY:
        print("Note: ANTHROPIC_API_KEY not set — vague amounts were left unquantified.")


if __name__ == "__main__":
    main()
