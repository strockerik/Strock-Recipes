/* ============================================================
   COCKTAIL DATABASE
   ------------------------------------------------------------
   Same format as recipes.js. Copy the TEMPLATE at the bottom to
   add a new cocktail, then replace this file on GitHub.
   For cocktails, baseServings is the number of drinks the spec
   makes (almost always 1), so the servings stepper on the site
   scales the build for a round of drinks.
   ============================================================ */

const COCKTAILS = [
  {
    id: "thats-physics-baby",
    name: "That\u2019s Physics, Baby",
    subtitle: "Verjus Collins \u2014 \u201CVerjus Only\u201D",
    source: "Anette, Denver, CO",
    tags: ["collins", "highball", "sh\u014Dch\u016B", "verjus", "pear", "herbal", "effervescent", "low-abv"],
    baseServings: 1,
    servingsLabel: "drinks",
    ingredients: [
      { amount: 1.25, unit: "oz", item: "sh\u014Dch\u016B" },
      { amount: 0.5, unit: "oz", item: "Yellow Chartreuse" },
      { amount: 0.5, unit: "oz", item: "Pimm\u2019s No. 1" },
      { amount: 1.25, unit: "oz", item: "white verjus (Horizon style)" },
      { amount: 0.5, unit: "oz", item: "pear syrup (see Pear Syrup sub-recipe)" },
      { amount: 2.5, unit: "oz", item: "chilled soda water, to top (2\u20133 oz)" }
    ],
    method: [
      "Add sh\u014Dch\u016B, Yellow Chartreuse, Pimm\u2019s, verjus, and pear syrup to a shaker with ice.",
      "Shake briefly, 5\u20137 seconds.",
      "Strain into a Collins glass over fresh cubed ice.",
      "Top with chilled soda water.",
      "One gentle one-turn stir; garnish and serve immediately."
    ],
    specs: { glass: "Collins", ice: "Fresh cubed in glass", garnish: "Thin pear slice (or expressed lemon peel)", strength: "Light \u2014 lengthened, low-proof Collins" },
    notes: "Too tart \u2192 add 0.1\u20130.25 oz pear syrup. Too sweet \u2192 drop Chartreuse to \u215C oz or pear syrup to ~0.4 oz. Any clean, light sh\u014Dch\u016B works. Verjus gives bright acid without citrus; pear adds round fruit; Chartreuse brings alpine herbal sweetness; Pimm\u2019s layers spice and orange-bitter."
  },
  {
    id: "americano-2",
    name: "Americano 2.0",
    subtitle: "Ginger-soda riff with saline",
    source: "Dante, New York City",
    tags: ["americano", "aperitivo", "bitter", "ginger", "collins", "bubbly", "low-abv", "campari", "vermouth", "salted"],
    baseServings: 1,
    servingsLabel: "drinks",
    ingredients: [
      { amount: 1.25, unit: "oz", item: "Campari" },
      { amount: 1.25, unit: "oz", item: "Mancino Vermouth Rosso (or Carpano Antica)" },
      { amount: 1, unit: "pinch", item: "Maldon sea salt (or 1 dash 10% saline)" },
      { amount: 3.25, unit: "oz", item: "Baladin Ginger Soda (or Fever-Tree Ginger Ale + splash soda water)" },
      { amount: null, unit: null, item: "orange bitters, 3\u20135 drops (optional, to echo D.C. Ama)" },
      { amount: 1, unit: null, item: "orange twist" }
    ],
    method: [
      "Add Campari, vermouth, and salt to a chilled Collins glass.",
      "Add a small splash of ginger soda; stir gently to dissolve the salt.",
      "Fill the glass completely with fresh cubed ice.",
      "Top with the remaining ginger soda; one light stir.",
      "Express the orange twist over the drink, fold, and drop it in."
    ],
    specs: { glass: "Collins (10\u201312 oz)", ice: "Full cubed ice", garnish: "Expressed orange twist", strength: "Low\u2013medium \u2014 lengthened aperitivo highball" },
    notes: "Pre-chill the soda for maximum fizz. 10% saline = 10 g salt in 90 g water; 1 dash \u2248 0.8 mL. Too sweet \u2192 more soda water. Too ginger-forward \u2192 milder soda or \u22120.5 oz. Too bitter \u2192 keep the saline, add 0.25 oz vermouth. Classic Americano alternate: 1 oz Campari + 1 oz sweet vermouth, top with 2\u20133 oz soda."
  },
  {
    id: "house-daiquiri",
    name: "House Daiquiri",
    subtitle: "Split-base: Spanish & French white rum",
    source: "Home bar",
    tags: ["daiquiri", "sour", "rum", "split-base", "shaken", "coupe", "citrus", "optional-bitters", "classic"],
    baseServings: 1,
    servingsLabel: "drinks",
    ingredients: [
      { amount: 1.5, unit: "oz", item: "Spanish white rum" },
      { amount: 0.5, unit: "oz", item: "French white rum" },
      { amount: 1, unit: "oz", item: "fresh lime juice" },
      { amount: 1, unit: "oz", item: "simple syrup (1:1)" },
      { amount: null, unit: null, item: "Angostura bitters, 3 drops (optional)" }
    ],
    method: [
      "Chill a coupe.",
      "Add both rums, lime, syrup, and (if using) Angostura to a shaker.",
      "Fill with ice; shake hard 10\u201312 seconds until very cold and lightly aerated.",
      "Fine-strain into the chilled coupe, no ice. Serve immediately."
    ],
    specs: { glass: "Coupe (5\u20137 oz)", ice: "Fresh cubed for shaking; served up", garnish: "None (optional lime coin)", strength: "Medium\u2013strong \u2014 classic up sour" },
    notes: "If using rich 2:1 syrup, cut to \u00BD\u2013\u00BE oz. Too tart \u2192 +0.25 oz syrup. Too sweet \u2192 syrup to 0.75 oz or lime to 1\u00BC oz. Spanish rum brings clean cane and body; French rum adds grassy top-notes; the 2:1:1 ratio is plush but finishes snappy."
  },
  {
    id: "strawberry-daiquiri",
    name: "Strawberry Daiquiri",
    subtitle: null,
    source: "Home bar",
    tags: ["daiquiri", "sour", "rum", "shaken", "coupe", "citrus", "strawberry", "fruit-forward"],
    baseServings: 1,
    servingsLabel: "drinks",
    ingredients: [
      { amount: 5, unit: null, item: "very ripe fresh strawberries (5\u20136), plus 1 to garnish" },
      { amount: 0.5, unit: "oz", item: "simple syrup" },
      { amount: 2, unit: "oz", item: "white rum" },
      { amount: 1, unit: "oz", item: "fresh lime juice" }
    ],
    method: [
      "Muddle the strawberries and syrup in a shaker until well mashed.",
      "Add the rum, lime, and 6\u20138 ice cubes; shake until well chilled.",
      "Pour through a fine-mesh sieve (not the built-in strainer \u2014 pulp clogs it) into a chilled coupe or martini glass.",
      "Garnish with a strawberry."
    ],
    specs: { glass: "Martini or coupe", ice: "6\u20138 cubes for shaking; served up", garnish: "Strawberry", strength: "Medium \u2014 classic up sour" },
    notes: "A fine-mesh sieve works much better than the shaker\u2019s built-in strainer."
  },
  {
    id: "pear-syrup",
    name: "Pear Syrup",
    subtitle: "Sub-recipe \u2014 used in That\u2019s Physics, Baby",
    source: "Home bar",
    tags: ["sub-recipe", "syrup", "pear"],
    baseServings: 1,
    servingsLabel: "batch (~1 cup / 240 mL)",
    ingredients: [
      { amount: 215, unit: "g", item: "ripe pear, cored & chopped (200\u2013225 g)" },
      { amount: 150, unit: "g", item: "water (\u2154 cup)" },
      { amount: 150, unit: "g", item: "white sugar (\u00BE cup)" },
      { amount: 2, unit: "tsp", item: "lemon juice (or \u215B tsp citric acid)" },
      { amount: 1, unit: "pinch", item: "salt (optional)" }
    ],
    method: [
      "Combine pear, water, and sugar in a small saucepan; bring to a gentle simmer.",
      "Simmer 10\u201312 minutes until the pears soften; lightly mash.",
      "Off the heat, cover and steep 20\u201330 minutes.",
      "Strain through fine mesh or cheesecloth, pressing gently.",
      "Stir in lemon juice (and salt). Top up with water to 240 mL if needed. Chill and bottle."
    ],
    specs: { glass: null, ice: null, garnish: null, strength: "Shelf life: 2 weeks refrigerated in a clean bottle" },
    notes: null
  }

  /* ── TEMPLATE — copy from here, paste ABOVE this comment ──
  ,{
    id: "my-new-cocktail",
    name: "My New Cocktail",
    subtitle: null,
    source: "Venue or home bar",
    tags: ["shaken", "coupe"],
    baseServings: 1,
    servingsLabel: "drinks",
    ingredients: [
      { amount: 2, unit: "oz", item: "base spirit" },
      { amount: 0.75, unit: "oz", item: "fresh lime juice" },
      { amount: null, unit: null, item: "garnish or dash, doesn't scale" }
    ],
    method: [
      "Step one.",
      "Step two."
    ],
    specs: { glass: "Coupe", ice: "Shaken, served up", garnish: "Lime coin", strength: "Medium" },
    notes: null
  }
  ── END TEMPLATE ── */
];
