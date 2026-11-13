#!/bin/bash
# Distiller expert scores from the SQLite files in data/Distiller/ (one per spirit:
# distiller_top_rums.db, distiller_top_gins.db …). Reads the files only; the
# scores are the ones you collected, matched to the catalog like any other batch.
#
#   bash distiller.sh            preview each file (writes nothing)
#   bash distiller.sh --apply    write them
#
# Re-running is safe: a score already in (same bottle, same Distiller page) is skipped.
cd "$(dirname "$0")" || exit 1
if [ $# -gt 1 ] || { [ -n "$1" ] && [ "$1" != "--apply" ]; }; then
  echo "Usage: bash distiller.sh   (preview)   |   bash distiller.sh --apply   (write)"; exit 1
fi
APPLY="$1"
found=0
for db in ../../data/Distiller/distiller_top_*.db; do
  [ -f "$db" ] || continue
  found=1
  echo; echo "=== $(basename "$db")"
  python3 ratings.py harvest distiller --db "$db" || exit 1
  spirit=$(basename "$db" .db | sed 's/^distiller_top_//')
  cat=$(python3 -c "import sys; sys.path.insert(0, '.'); sys.dont_write_bytecode = True; import ratings; print(ratings.DISTILLER_SPIRITS.get('$spirit', '$spirit'))")
  python3 ratings.py import-batch "batches/distiller-$cat.json" $APPLY || exit 1
done
[ "$found" = 1 ] || echo "No data/Distiller/distiller_top_*.db files found."
