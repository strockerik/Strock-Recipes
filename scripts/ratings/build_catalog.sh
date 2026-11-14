#!/bin/bash
# The 2026-11-12 catalog build: every harvested batch in scripts/ratings/batches/,
# in the order that lets each one join the bottles the earlier ones added.
# Run the README "Bottles" setup SQL steps 9 and 10 first (new sources, scales,
# and the "high needs a critic" confidence rule).
#
#   bash build_catalog.sh            preview every import (writes nothing)
#   bash build_catalog.sh --apply    write them (re-running skips what's already in)
#
# A preview can't see the bottles an earlier batch would add, so later previews
# show more "new" bottles than an --apply run will actually create.
cd "$(dirname "$0")" || exit 1
APPLY="$1"
if [ $# -gt 1 ] || { [ -n "$1" ] && [ "$1" != "--apply" ]; }; then
  echo "Usage: bash build_catalog.sh   (preview)   |   bash build_catalog.sh --apply   (write)"; exit 1
fi
i() {
  [ -f "batches/$1.json" ] || { echo "=== $1: no batches/$1.json yet (python3 ratings.py harvest $1)"; return; }
  echo; echo "=== $1"
  python3 ratings.py import-batch "batches/$1.json" ${2:-} $APPLY || exit 1
}
i bsa                 # Bartender Spirits Awards 2019-, medals with points
i disc                # Denver International Spirits Competition 2017-
i lonecaner           # The Lone Caner: core-range rums (limited releases only join)
i ginisin             # The GIN is IN: the site's own star ratings
i whiskyfun           # Whiskyfun: official bottlings (limited releases only join)
i ssel --join-only    # Spirits Selection: only deepens bottles already in the catalog
i curated             # hand-checked critic scores for popular bottles the rest miss
