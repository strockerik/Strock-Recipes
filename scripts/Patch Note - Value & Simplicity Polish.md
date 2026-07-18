# Patch note — Value & Simplicity polish (5 items)

Companion to *UX Review — Value & Simplicity*. Five small, independent fixes — apply in order, each is safe on its own. All in `app.js` except #3 which also touches `style.css`. No backend or data changes.

Line numbers reference the reviewed `app.js` (~3554 lines); if they've drifted, the quoted `Find` strings are unique — search for those.

---

## 1. Don't show two servings steppers on one open recipe  *(polish)*

**Why:** When a recipe is both in the grocery list *and* expanded, the servings stepper renders twice — once on the collapsed row (`.serv-control`, shown only when `picked`) and again in the detail (`servControl` / `.detail-serv`). Same shared value, ~40px apart. Show it once.

**File:** `app.js`, in `renderDetail(it, servings)` (≈1046).

The detail currently always injects the stepper. Gate it on the recipe **not** already being in the basket (when it is, the row stepper above is visible and controls the same value).

**Find** (≈1072):
```js
    return `
    <div class="item-detail">
      <p class="detail-meta">Source: ${esc(it.source || "\u2014")}${ownerNote}</p>
      ${servControl}
```

**Replace** with (also folds in fix #2 — the Source line):
```js
    const sourceLine = it.source || ownerNote
      ? `<p class="detail-meta">${it.source ? `Source: ${esc(it.source)}` : ""}${ownerNote}</p>`
      : "";
    return `
    <div class="item-detail">
      ${sourceLine}
      ${basket.has(it.id) ? "" : servControl}
```

Notes:
- `${basket.has(it.id) ? "" : servControl}` — hides the detail stepper exactly when the row stepper is showing. For recipes not on the list, the detail stepper still appears as today.
- The `servControl` const can stay as-is (unused when basket-hit; harmless). If your linter flags it, wrap its use only.

---

## 2. Hide the “Source: —” line when there’s no source  *(clutter)*

**Handled by #1's replacement above** — `sourceLine` only renders when there's a real `it.source` (or an owner note for shared recipes). A user's own source-less recipe no longer shows a bare `Source: —`.

If you apply this independently of #1, the minimal change is:

**Find:** `<p class="detail-meta">Source: ${esc(it.source || "\u2014")}${ownerNote}</p>`
**Replace:** `${it.source || ownerNote ? `<p class="detail-meta">${it.source ? `Source: ${esc(it.source)}` : ""}${ownerNote}</p>` : ""}`

(Mirrors the pattern already used in the share/export code: `it.source ? `Source: ${it.source}` : ""`.)

---

## 3. Make the grocery checkbox say what it does  *(polish)*

**Why:** The bare left-edge checkbox reads as “select this row.” The dismissible hint explains it once; after that it's back to relying on memory. Give it a persistent affordance.

**File:** `app.js`, in the list-row template inside the render loop (≈1022), **and** `style.css`.

**Find** (≈1023):
```js
          <input type="checkbox" class="pick" ${picked ? "checked" : ""}
                 aria-label="Add ${esc(it.name)} to grocery list">
```

**Replace** with a labeled control (wrap so we can show a cart glyph + state):
```js
          <label class="pick-wrap" title="${picked ? "On your grocery list" : "Add to grocery list"}">
            <input type="checkbox" class="pick" ${picked ? "checked" : ""}
                   aria-label="Add ${esc(it.name)} to grocery list">
            <span class="pick-ico" aria-hidden="true">🛒</span>
          </label>
```

**`style.css`** — add near the `.pick` rules:
```css
.pick-wrap{display:inline-flex;align-items:center;gap:6px;cursor:pointer;}
.pick-wrap .pick-ico{font-size:.9rem;opacity:.45;transition:opacity .15s;}
.pick-wrap .pick:checked + .pick-ico{opacity:1;}
```

The cart sits dim next to an empty box and lights up when checked — the row now reads as “add to shopping,” not “select.” (Keep the one-time `#pick-hint` as extra reinforcement; it no longer has to carry the meaning alone.)

*Alternative if you'd rather not touch row markup:* leave the checkbox and instead make `#pick-hint` non-dismissible (drop the “Got it” button). Lighter, but the persistent glyph is the stronger fix.

---

## 4. Friendlier shopping amounts for by-weight staples  *(worth a look — judgment call)*

**Why:** The list showed `14¼ oz ground beef` (from 400 g). Correct, but nobody buys beef in quarter-ounces — precise-but-impractical units make a smart list feel fussy at the shelf.

**This is a rounding-policy change, not a layout fix — validate against real recipes before shipping.** The logic lives in the grocery amount formatting (search for where combined amounts are converted to store units / the `oz`/`lb` rounding). Two options, least to most invasive:

- **Minimal:** when a combined weight is ≥ ~12 oz, round to the nearest ¼ lb and label in lb (so `14¼ oz → ~1 lb`); keep oz only for small amounts.
- **Fuller:** define friendly pack steps per aisle (meat → ½ lb, produce → count/each, spices → keep small units) and snap up to the next step.

Leave countable/“each” items (onions, lemons, garlic cloves) exactly as they are — those already read well. If in doubt, ship only the ≥12 oz→lb rule; it fixes the case that looks worst.

---

## 5. Don’t shout “Create grocery list” on an empty week  *(polish)*

**Why:** On a Meal plan with nothing scheduled, the solid green `🛒 Create grocery list` button is fully prominent — a primary action for something you can't do yet. The one real next step (stage a recipe) should be unambiguous.

**File:** `app.js`, meal-plan header (≈1685).

**Find:**
```js
          <button id="mp-make-grocery" class="solid-btn small">🛒 Create grocery list</button>
```

**Replace** with a disabled-until-planned variant (`mealPlan` holds the scheduled entries; use whatever the surrounding scope calls the current-window list):
```js
          <button id="mp-make-grocery" class="solid-btn small"${mealPlan.length ? "" : " disabled"}>🛒 Create grocery list</button>
```

**`style.css`** — if not already covered:
```css
.solid-btn:disabled{opacity:.45;cursor:default;}
```

If `mealPlan` in that scope includes history entries, gate instead on “has at least one upcoming entry” (the same list that feeds the `upcoming` render). The intent: enabled only when there's something to roll into a list.

---

## Acceptance checklist
- [ ] #1 A recipe that's on the grocery list shows **one** servings stepper when expanded (the row one); recipes not on the list still show the detail stepper.
- [ ] #2 A recipe with no source shows **no** Source line (shared recipes still show “Shared by …”).
- [ ] #3 The grocery checkbox reads as a shopping action (cart glyph dim→lit) without relying on the hint.
- [ ] #4 (if taken) Large by-weight staples show friendly units (e.g. ~1 lb), counts unchanged.
- [ ] #5 “Create grocery list” is disabled/subdued until at least one meal is scheduled.
- [ ] No console errors; scaling, unit toggle, grocery combining, and sharing all unchanged.
