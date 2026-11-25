#!/usr/bin/env python3
"""Back up and restore House Index data — a disaster-recovery safety net.

The recipes (including handwritten family ones extracted from photos) live only
in Supabase. This script gives you an off-Supabase copy and a way to put it back.

  backup (default)
      Dump EVERY recipe row faithfully — ids, owners, tags, ingredients, method,
      timestamps — to backups/house-index-YYYY-MM-DD.json, together with the rest
      of the household's data (pantry and bar, meal plan, grocery list, shares,
      profile settings) under "tables". The spirits catalog goes to its own
      compressed file, backups/catalog-YYYY-MM-DD.json.gz. The last 8 of each are
      kept. Read-only on the database; safe to run any time (weekly via
      scripts/launchd/, see README "Archival + restore").

  --restore FILE
      Re-insert recipes from a backup file. DRY RUN by default (prints what it
      would do); pass --apply to actually write. Idempotent: a recipe whose id
      already exists is SKIPPED, so re-running never creates duplicates.

It also restores the app's in-app "Back up" export (rows that carry no id /
user_id): those are inserted as NEW rows owned by --owner <user-uuid>, deduped
by name+section so a second run is a no-op.

--restore puts back recipes only; the other tables in a snapshot are there to
read or to re-insert by hand in the SQL editor.

Credentials are never hard-coded — they come from the environment or the
gitignored notes.md:
  SUPABASE_URL                 e.g. https://xxxx.supabase.co
  SUPABASE_SECRET_KEY          sb_secret_… key (bypasses RLS — admin only), or a
                               "Secret Key: sb_secret_…" line in notes.md

Usage:
  python3 scripts/backup_recipes.py                              # write a snapshot
  python3 scripts/backup_recipes.py --restore FILE               # dry-run a restore
  python3 scripts/backup_recipes.py --restore FILE --apply       # restore for real
  python3 scripts/backup_recipes.py --restore EXPORT --owner <uuid> --apply
"""
import datetime
import glob
import gzip
import json
import os
import re
import ssl
import sys
import urllib.request
import urllib.error

# Columns we snapshot. "*" would also pull anything added later, but pinning the
# list keeps the file shape stable and lets restore re-insert verbatim.
SELECT_COLS = (
    "id,user_id,section,name,subtitle,source,tags,base_servings,"
    "servings_label,ingredients,method,specs,notes,is_favorite,created_at"
)


# The household's own data (backed up beside the recipes) and the spirits
# catalog (its own compressed file), each with a stable order for paging.
HOUSEHOLD_TABLES = {
    "profiles": "id", "recipe_shares": "recipe_id,shared_with_user_id",
    "meal_plan_entries": "id", "grocery_basket_items": "user_id,recipe_id",
    "grocery_manual_items": "id", "grocery_checked_items": "user_id,item_key",
    "inventory_items": "id", "member_requests": "user_id",   # who's approved (v2.3)
}
CATALOG_TABLES = {
    "rating_sources": "id", "spirit_products": "id", "spirit_aliases": "alias_norm",
    "spirit_reviews": "id", "spirit_community": "product_id", "spirit_reports": "id",
    "spirit_lookups": "id",
}
KEEP = 8   # backups of each kind kept in backups/


def _ssl_context():
    """python.org's macOS Python ships no CA certificates until its 'Install
    Certificates' step runs; fall back to the bundle macOS has (a scheduled run
    may use any Python on the machine)."""
    ctx = ssl.create_default_context()
    paths = ssl.get_default_verify_paths()
    if not (paths.cafile or paths.capath) and os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


SSL_CTX = _ssl_context()


# --- credentials --------------------------------------------------------------
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
    # The secret key; the legacy service-role key was retired 2026-11-15.
    m = re.search(r"Secret Key:\s*(sb_secret_\S+)", text)
    if m:
        out["key"] = m.group(1)
    return out


notes = load_notes()
SUPABASE_URL = os.environ.get("SUPABASE_URL") or notes.get("url")
SERVICE_KEY = os.environ.get("SUPABASE_SECRET_KEY") or notes.get("key")

args = sys.argv[1:]
APPLY = "--apply" in args
RESTORE = None
OWNER = None
if "--restore" in args:
    i = args.index("--restore")
    RESTORE = args[i + 1] if i + 1 < len(args) else None
if "--owner" in args:
    i = args.index("--owner")
    OWNER = args[i + 1] if i + 1 < len(args) else None

if not SUPABASE_URL or not SERVICE_KEY:
    sys.exit("Missing SUPABASE_URL / SUPABASE_SECRET_KEY (env, or a 'Secret Key:' line in notes.md).")


def sb_request(method, path, body=None):
    req = urllib.request.Request(
        SUPABASE_URL + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "apikey": SERVICE_KEY,   # an sb_secret_ key goes in "apikey" only
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def fetch_recipes():
    # Paged like every other table: one request stops at 1,000 rows, silently.
    return fetch_all("recipes", "name,id", select=SELECT_COLS) or []


def fetch_all(table, order, page=1000, select="*"):
    """Every row of a table, a page at a time (Supabase caps a response at 1,000).
    None if the table isn't in this database."""
    rows, offset = [], 0
    while True:
        try:
            chunk = sb_request("GET", f"/rest/v1/{table}?select={select}&order={order}&limit={page}&offset={offset}") or []
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise
        rows += chunk
        if len(chunk) < page:
            return rows
        offset += page


def prune(out_dir, pattern):
    """Keep the newest KEEP files matching pattern (names sort by date)."""
    for old in sorted(glob.glob(os.path.join(out_dir, pattern)))[:-KEEP]:
        os.remove(old)


# --- backup ------------------------------------------------------------------
def backup():
    recipes = fetch_recipes()
    tables, counts = {}, []
    for t, order in HOUSEHOLD_TABLES.items():
        rows = fetch_all(t, order)
        if rows is not None:
            tables[t] = rows
            counts.append(f"{len(rows)} {t}")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    envelope = {
        "app": "The House Index",
        "version": 2,                       # 2: adds "tables" (v1.9); "recipes" unchanged
        "kind": "snapshot",                 # faithful: rows keep id + user_id
        "exportedAt": now,
        "count": len(recipes),
        "recipes": recipes,
        "tables": tables,
    }
    out_dir = os.path.join(os.path.dirname(__file__), "..", "backups")
    os.makedirs(out_dir, exist_ok=True)
    today = datetime.date.today().isoformat()
    fname = f"house-index-{today}.json"
    with open(os.path.join(out_dir, fname), "w") as f:
        json.dump(envelope, f, ensure_ascii=False, indent=2)
    print(f"Backed up {len(recipes)} recipe(s)" + (f" and {', '.join(counts)}" if counts else "") + f" -> backups/{fname}")

    catalog, ccounts = {}, []
    for t, order in CATALOG_TABLES.items():
        rows = fetch_all(t, order)
        if rows is not None:
            catalog[t] = rows
            ccounts.append(f"{len(rows)} {t}")
    cname = f"catalog-{today}.json.gz"
    with gzip.open(os.path.join(out_dir, cname), "wt", encoding="utf-8") as f:
        json.dump({"app": "The House Index", "kind": "catalog", "exportedAt": now, "tables": catalog}, f, ensure_ascii=False)
    print(f"Backed up the spirits catalog ({', '.join(ccounts)}) -> backups/{cname}")
    prune(out_dir, "house-index-*.json")
    prune(out_dir, "catalog-*.json.gz")


# --- restore -----------------------------------------------------------------
def existing_index():
    """Return (ids_set, name_section_set) of recipes currently in the table."""
    rows = fetch_recipes()
    ids = {r["id"] for r in rows}
    keys = {(r["name"].strip().lower(), r.get("section")) for r in rows}
    return ids, keys


def restore(path):
    try:
        data = json.load(open(path))
    except (OSError, ValueError) as e:
        sys.exit(f"Couldn't read backup file {path!r}: {e}")
    recipes = data.get("recipes") if isinstance(data, dict) else data
    if not isinstance(recipes, list):
        sys.exit("That file doesn't look like a House Index backup (no 'recipes' list).")

    faithful = any(r.get("id") for r in recipes)   # snapshot vs in-app export
    if not faithful and not OWNER:
        sys.exit("This looks like an in-app export (no ids). Re-run with "
                 "--owner <your-user-uuid> so the restored rows have an owner.")

    have_ids, have_keys = existing_index()
    to_insert, skipped = [], 0
    for r in recipes:
        if faithful:
            if r.get("id") in have_ids:
                skipped += 1
                continue
            row = {k: r.get(k) for k in (
                "id", "user_id", "section", "name", "subtitle", "source", "tags",
                "base_servings", "servings_label", "ingredients", "method",
                "specs", "notes", "is_favorite", "created_at") if k in r}
        else:
            key = (str(r.get("name", "")).strip().lower(), r.get("section"))
            if key in have_keys:
                skipped += 1
                continue
            row = {k: r.get(k) for k in (
                "section", "name", "subtitle", "source", "tags", "base_servings",
                "servings_label", "ingredients", "method", "specs", "notes",
                "is_favorite") if k in r}
            row["user_id"] = OWNER
            have_keys.add(key)              # dedupe within this file too
        to_insert.append(row)

    print(f"Restore plan: {len(to_insert)} to insert, {skipped} already present "
          f"(skipped). Source: {'snapshot' if faithful else 'in-app export'}.")
    for r in to_insert:
        print(f"  + {r['name']!r} ({r.get('section')})")

    if not to_insert:
        print("Nothing to do.")
        return
    if not APPLY:
        print("\nDRY RUN — pass --apply to write these rows.")
        return
    # Insert in one batch; Supabase REST accepts an array body.
    sb_request("POST", "/rest/v1/recipes", to_insert)
    print(f"\nApplied: inserted {len(to_insert)} recipe(s).")


def main():
    if RESTORE:
        restore(RESTORE)
    else:
        backup()


if __name__ == "__main__":
    main()
