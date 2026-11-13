#!/bin/bash
# The 2026-11-12 expert-review merge: five critic batches, RumX's community medians,
# and your Distiller file. Everything was audited first (see README, "Expert pass"):
#   fatrumpirate     The Fat Rum Pirate, stars read from each review's rating image
#   bourbonculture   The Bourbon Culture, its x/10
#   bevx             BevX, spirit sections only, points read on the competition curve
#   drinkhacker-2026 Gemini's Drinkhacker harvest (20 of 20 pages spot-checked), 5 two-bottle reviews dropped
#   rumx-verified    RumX critics whose score is on the critic's own page (16), plus RumX community medians
#   distiller        data/Distiller/distiller_top_*.db
#
# FIRST run the README Bottles setup SQL steps 11 and 12 (the community table, and the
# three critics as their own sources). Then:
#
#   bash expert_pass.sh            preview each import (writes nothing)
#   bash expert_pass.sh --apply    write them
#
# Re-running is safe: a score already in (same bottle, same page) is skipped.
cd "$(dirname "$0")" || exit 1
if [ $# -gt 1 ] || { [ -n "$1" ] && [ "$1" != "--apply" ]; }; then
  echo "Usage: bash expert_pass.sh   (preview)   |   bash expert_pass.sh --apply   (write)"; exit 1
fi
APPLY="$1"
for b in fatrumpirate bourbonculture bevx; do        # the three WordPress feeds: re-read (cached 30 days)
  echo; echo "=== harvest $b"
  python3 ratings.py harvest "$b" || exit 1
done
for b in fatrumpirate bourbonculture bevx drinkhacker-2026 rumx-verified; do
  [ -f "batches/$b.json" ] || { echo "Missing batches/$b.json"; exit 1; }
  echo; echo "=== import $b"
  python3 ratings.py import-batch "batches/$b.json" $APPLY || exit 1
done
echo; echo "=== distiller"
bash distiller.sh $APPLY
echo; echo "Next: python3 ratings.py dupes   (the new bottles' near-duplicates, for you to merge)"
