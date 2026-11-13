#!/bin/bash
# The 2026-11-12 catalog review pass, in order:
#   1. the hand-checked scores the overnight build never wrote (its import stopped
#      on an alias bug, fixed in ratings.py — the bottles were made, the scores weren't);
#   2. the review pass: 38 critic scores for widely stocked bottles that had none or
#      one thin one, plus Banks 5 Island;
#   3. 72 hand-checked same-bottle merges.
#
#   bash catalog_pass.sh            preview (writes nothing)
#   bash catalog_pass.sh --apply    write it
#
# Re-running is safe: scores already in are skipped, and a merge whose bottle is
# already gone is skipped.
cd "$(dirname "$0")" || exit 1
if [ $# -gt 1 ] || { [ -n "$1" ] && [ "$1" != "--apply" ]; }; then
  echo "Usage: bash catalog_pass.sh            (preview, writes nothing)"
  echo "       bash catalog_pass.sh --apply    (write it)"
  echo "Run them as two separate commands."
  exit 1
fi
APPLY="$1"
for f in batches/curated.json batches/review-pass-2026-11-12.json batches/merges-2026-11-12.sh; do
  [ -f "$f" ] || { echo "Missing $f"; exit 1; }
done
echo "=== 1. hand-checked scores (curated)"
python3 ratings.py import-batch batches/curated.json $APPLY || exit 1
echo; echo "=== 2. review pass"
python3 ratings.py import-batch batches/review-pass-2026-11-12.json $APPLY || exit 1
echo; echo "=== 3. same-bottle merges"
bash batches/merges-2026-11-12.sh $APPLY
