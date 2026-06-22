#!/usr/bin/env python3
"""Back up and restore House Index recipes — a disaster-recovery safety net.

The recipes (including handwritten family ones extracted from photos) live only
in Supabase. This script gives you an off-Supabase copy and a way to put it back.

  backup (default)
      Dump EVERY recipe row faithfully — ids, owners, tags, ingredients, method,
      timestamps — to backups/house-index-YYYY-MM-DD.json. A true snapshot you
      can restore exactly. Read-only on the database; safe to run any time.

  --restore FILE
      Re-insert recipes from a backup file. DRY RUN by default (prints what it
      would do); pass --apply to actually write. Idempotent: a recipe whose id
      already exists is SKIPPED, so re-running never creates duplicates.

It also restores the app's in-app "Back up" export (rows that carry no id /
user_id): those are inserted as NEW rows owned by --owner <user-uuid>, deduped
by name+section so a second run is a no-op.

Credentials are never hard-coded — they come from the environment or the
gitignored notes.md, exactly like migrate_ingredients.py:
  SUPABASE_URL                 e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    service-role key (bypasses RLS — admin only)

Usage:
  python3 scripts/backup_recipes.py                              # write a snapshot
  python3 scripts/backup_recipes.py --restore FILE               # dry-run a restore
  python3 scripts/backup_recipes.py --restore FILE --apply       # restore for real
  python3 scripts/backup_recipes.py --restore EXPORT --owner <uuid> --apply
"""
import datetime
import json
import os
import re
import sys
import urllib.request
import urllib.error

# Columns we snapshot. "*" would also pull anything added later, but pinning the
# list keeps the file shape stable and lets restore re-insert verbatim.
SELECT_COLS = (
    "id,user_id,section,name,subtitle,source,tags,base_servings,"
    "servings_label,ingredients,method,specs,notes,is_favorite,created_at"
)


# --- credentials (same loader as migrate_ingredients.py) ---------------------
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


def fetch_recipes():
    return sb_request("GET", f"/rest/v1/recipes?select={SELECT_COLS}&order=name") or []


# --- backup ------------------------------------------------------------------
def backup():
    recipes = fetch_recipes()
    envelope = {
        "app": "The House Index",
        "version": 1,
        "kind": "snapshot",                 # faithful: rows keep id + user_id
        "exportedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "count": len(recipes),
        "recipes": recipes,
    }
    out_dir = os.path.join(os.path.dirname(__file__), "..", "backups")
    os.makedirs(out_dir, exist_ok=True)
    fname = f"house-index-{datetime.date.today().isoformat()}.json"
    path = os.path.join(out_dir, fname)
    with open(path, "w") as f:
        json.dump(envelope, f, ensure_ascii=False, indent=2)
    print(f"Backed up {len(recipes)} recipe(s) -> backups/{fname}")


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
