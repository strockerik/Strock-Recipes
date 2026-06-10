/* ============================================================
   RECIPE DATABASE
   ------------------------------------------------------------
   To add a recipe: copy the TEMPLATE at the bottom of this file,
   paste it above the closing ];  fill it in, save, and replace
   this file on GitHub. The site updates automatically.

   Notes on fields:
   - id:            short, unique, lowercase, no spaces (used internally)
   - baseServings:  the number the ingredient amounts are written for
   - servingsLabel: what one "serving unit" is ("servings", "pizzas", "loaves"...)
   - ingredients:   amount = number or null (null = "to taste"-style items
                    that don't scale). unit can be null for countable items.
   ============================================================ */

const RECIPES = [
  {
    id: "ny-pizza",
    name: "Standard NY-Style Pizza",
    subtitle: "Ooni dough + Charlie Anderson sauce",
    source: "Ooni (dough) / Charlie Anderson Cooking (sauce)",
    tags: ["pizza", "italian-american", "dough", "tomato-sauce", "oven-baked", "vegetarian-adaptable"],
    baseServings: 4,
    servingsLabel: "pizzas (12\u2033)",
    ingredients: [
      { amount: 600, unit: "g", item: "\u201C00\u201D flour" },
      { amount: 360, unit: "g", item: "lukewarm water" },
      { amount: 18, unit: "g", item: "salt (dough)" },
      { amount: 7, unit: "g", item: "instant dry yeast" },
      { amount: 1, unit: "can (28 oz)", item: "crushed or whole peeled tomatoes" },
      { amount: 2, unit: "g", item: "salt (sauce), plus more to taste" },
      { amount: 12, unit: "g", item: "sugar" },
      { amount: 2, unit: "tsp", item: "dried oregano" },
      { amount: null, unit: null, item: "low-moisture whole-milk mozzarella, for topping" },
      { amount: null, unit: null, item: "grated pecorino, for topping" }
    ],
    method: [
      "Dough: dissolve the yeast in the lukewarm water and let it sit briefly until dissolved.",
      "In a large bowl, combine flour and salt. Add the yeast-water mixture and mix until a shaggy dough forms.",
      "Knead by hand ~10 minutes (or 5\u201310 minutes with a dough hook) until smooth, firm, and elastic.",
      "Cover and rise in a warm spot ~2 hours, until doubled.",
      "Divide into 4 equal ~250 g balls, shape tight, cover, and rise 30\u201360 minutes (or cold-ferment in the fridge).",
      "Sauce: blend the tomatoes, salt, sugar, and oregano until smooth. Refrigerate; keeps up to 3 days.",
      "Bake: preheat oven to 550\u00B0F with a steel/stone on the second-highest rack for ~90 minutes.",
      "Stretch one ball to a 12\u2033 round on a semolina-dusted peel. Top with sauce, then cheese.",
      "Bake on the hot steel 4\u20135 minutes until the cheese is melted and just browning. Cool on a rack before slicing."
    ],
    notes: "Don\u2019t overload the center with sauce."
  },
  {
    id: "detroit-pizza",
    name: "Detroit-Style Pizza",
    subtitle: "Buddy\u2019s clone",
    source: "Charlie Anderson Cooking",
    tags: ["pizza", "detroit-style", "american", "dough", "tomato-sauce", "oven-baked", "pepperoni", "comfort-food", "copycat"],
    baseServings: 1,
    servingsLabel: "pan (8\u2033\u00D710\u2033)",
    ingredients: [
      { amount: 180, unit: "g", item: "all-purpose flour" },
      { amount: 117, unit: "g", item: "water" },
      { amount: 3.6, unit: "g", item: "salt (dough)" },
      { amount: 0.9, unit: "g", item: "instant dry yeast" },
      { amount: 1, unit: "can (28 oz)", item: "tomatoes (for sauce; ~143 g used per pizza)" },
      { amount: 5, unit: "g", item: "salt (sauce)" },
      { amount: 1.5, unit: "tsp", item: "dried oregano" },
      { amount: 0.75, unit: "tsp", item: "dried thyme" },
      { amount: 0.25, unit: "tsp", item: "garlic powder" },
      { amount: 0.25, unit: "tsp", item: "red pepper flakes" },
      { amount: 182, unit: "g", item: "Wisconsin brick cheese, shredded (or 40% Muenster / 40% Monterey Jack / 20% mild white cheddar)" },
      { amount: null, unit: null, item: "pepperoni" }
    ],
    method: [
      "Combine flour, water, salt, and yeast; mix until fully incorporated. Cover and rest 20 minutes.",
      "Knead 5\u20137 minutes, ball up, cover, and rise 1\u20133 hours (grown by ~50\u2013100%).",
      "Oil a Detroit-style steel pan. Add the dough and stretch toward the edges (it will spring back).",
      "Cover, rest 30 minutes, then stretch fully to the edges. Cover and rise again until roughly doubled, 1\u20132 hours.",
      "Sauce: blend all sauce ingredients until smooth. Refrigerate; keeps up to 3 days.",
      "Preheat oven to its highest setting, rack in the middle.",
      "Layer pepperoni directly on the dough, then cheese all the way to the edges, then stripes of sauce on top.",
      "Bake at 550\u00B0F for 12\u201315 minutes until well browned, especially at the edges.",
      "Remove from the pan immediately and cool briefly on a rack before cutting."
    ],
    notes: "Cheese to the edges fries against the pan and forms the signature crispy frico edge."
  },
  {
    id: "smash-burger",
    name: "Classic Smash Burger",
    subtitle: null,
    source: "Certified Angus Beef",
    tags: ["burger", "american", "beef", "stovetop", "quick"],
    baseServings: 4,
    servingsLabel: "double burgers",
    ingredients: [
      { amount: 1.5, unit: "lb", item: "ground beef (80/20)" },
      { amount: 0.5, unit: "cup", item: "mayonnaise" },
      { amount: 1, unit: "tbsp", item: "yellow mustard" },
      { amount: 1, unit: "tbsp", item: "grated yellow onion" },
      { amount: 2, unit: "tsp", item: "hot sauce" },
      { amount: 1, unit: "tsp", item: "Worcestershire sauce" },
      { amount: 4, unit: null, item: "hamburger buns" },
      { amount: 2, unit: "tbsp", item: "butter, room temperature" },
      { amount: 1.5, unit: "tsp", item: "kosher salt" },
      { amount: 0.5, unit: "tsp", item: "black pepper" },
      { amount: 4, unit: "slices", item: "American cheese" },
      { amount: 2, unit: "cups", item: "shredded iceberg lettuce" },
      { amount: 8, unit: "slices", item: "ripe tomato" }
    ],
    method: [
      "Whisk mayo, mustard, grated onion, hot sauce, and Worcestershire; refrigerate. This is the burger sauce.",
      "Divide the beef into 8 equal ~3 oz portions; refrigerate until ready to cook.",
      "Butter the cut sides of the buns and toast until golden; set aside.",
      "Heat a cast-iron skillet or griddle over high heat.",
      "Place a beef ball on the hot surface, cover with parchment, and smash to ~\u00BC\u2033 thick.",
      "Season with salt and pepper. Sear 2\u20133 minutes until well browned.",
      "Flip, immediately top half the patties with American cheese, sear 1 more minute, then stack a plain patty on each cheesed one.",
      "Build: bottom bun, sauce, lettuce, tomato, double patty stack, more sauce, top bun."
    ],
    notes: null
  },
  {
    id: "taco-beef",
    name: "Restaurant-Style Simmered Taco Beef",
    subtitle: "Low and slow, velvety fine crumb",
    source: "Personal method",
    tags: ["taco", "american", "beef", "stovetop", "slow-simmer", "meal-prep", "quick-prep"],
    baseServings: 8,
    servingsLabel: "servings (2 lbs total)",
    ingredients: [
      { amount: 2, unit: "lb", item: "ground beef (85/15)" },
      { amount: 2, unit: "packs", item: "taco seasoning" },
      { amount: 2, unit: "tbsp", item: "tomato paste" },
      { amount: 2, unit: "cups", item: "vegetable broth (start with 1\u00BD, add the rest as needed)" },
      { amount: 1, unit: "tsp", item: "sugar (optional, to balance acidity)" }
    ],
    method: [
      "Brown the beef over medium-high heat, breaking it into very fine crumbles with a potato masher or stiff whisk.",
      "Tilt the pan and spoon out most of the grease, leaving 1\u20132 tablespoons.",
      "Fry the tomato paste in a cleared spot for ~60 seconds until deep brick red, then stir into the meat.",
      "Add both packs of taco seasoning; stir 1 minute to toast the spices.",
      "Add 1\u00BD cups broth (meat mostly submerged). Cover and simmer on low 30\u201345 minutes, topping up with the last \u00BD cup if needed. Aim for \u201Csaucy,\u201D not soupy.",
      "Uncover for the last 5\u201310 minutes to thicken and glaze. Taste; add a pinch of sugar if too tangy."
    ],
    notes: "Tomato paste adds body and umami; broth beats water; the long simmer gives a tender, fine texture that holds in a shell."
  },
  {
    id: "chantilly-frosting",
    name: "Berry Chantilly Cake Frosting",
    subtitle: "Whole Foods copycat",
    source: "Copycat",
    tags: ["dessert", "frosting", "cake", "copycat", "no-bake", "vegetarian"],
    baseServings: 1,
    servingsLabel: "batch (frosts one layer cake)",
    ingredients: [
      { amount: 8, unit: "oz", item: "cream cheese, softened" },
      { amount: 8, unit: "oz", item: "mascarpone, softened slightly but kept cool" },
      { amount: 2, unit: "cups", item: "powdered sugar, sifted" },
      { amount: 2, unit: "cups", item: "heavy whipping cream, very cold" },
      { amount: 1, unit: "tsp", item: "pure vanilla extract" },
      { amount: 0.5, unit: "tsp", item: "almond extract" }
    ],
    method: [
      "Beat cream cheese and mascarpone with the paddle on medium-high until completely smooth, 3\u20134 minutes.",
      "On low, gradually add powdered sugar, vanilla, and almond extract; beat on medium until smooth.",
      "Switch to the whisk. On low, slowly stream the cold cream down the side of the bowl so it emulsifies.",
      "Whip on medium-high to stiff peaks, 1\u20132 minutes. Stop the moment it holds its shape \u2014 over-whipping curdles the mascarpone."
    ],
    notes: "For a full Chantilly cake: vanilla sponge, berry syrup brushed on each layer, this frosting, and fresh blueberries, raspberries, and strawberries. The almond extract is the \u201Csecret\u201D bakery note."
  },
  {
    id: "ricotta-pesto-pasta",
    name: "Ricotta & Cherry Tomato Pesto Pasta",
    subtitle: null,
    source: "Instagram \u2014 chefmarco_nyc",
    tags: ["pasta", "italian", "mediterranean", "vegetarian-adaptable", "quick", "chefmarco_nyc", "pesto"],
    baseServings: 3,
    servingsLabel: "servings",
    ingredients: [
      { amount: 400, unit: "g", item: "pasta" },
      { amount: 150, unit: "g", item: "guanciale, pancetta, or bacon" },
      { amount: null, unit: null, item: "a handful of cherry tomatoes (whole, for the pan)" },
      { amount: 150, unit: "g", item: "ricotta" },
      { amount: 50, unit: "g", item: "Parmigiano Reggiano, grated" },
      { amount: 100, unit: "g", item: "cherry tomatoes (for the pesto)" },
      { amount: 10, unit: "g", item: "basil leaves" },
      { amount: 2, unit: "cloves", item: "garlic (1\u20132, to taste)" },
      { amount: 50, unit: "g", item: "almonds (or other favorite nuts)" },
      { amount: null, unit: null, item: "olive oil \u2014 a generous amount" },
      { amount: null, unit: null, item: "salt, to taste" }
    ],
    method: [
      "Blend ricotta, Parmigiano, cherry tomatoes, basil, garlic, almonds, olive oil, and salt until smooth. Adjust to taste.",
      "Render the guanciale over medium heat until crisp, then add whole cherry tomatoes and cook until blistered.",
      "Cook the pasta in well-salted water until very al dente, reserving plenty of pasta water.",
      "Off the heat, stir the pesto into the pan with the guanciale and tomatoes.",
      "Add the pasta and toss, loosening with reserved pasta water drop by drop until silky.",
      "Serve immediately."
    ],
    notes: "Add pasta water gradually off the heat \u2014 easier to add more than to fix a watery sauce. Skip the guanciale for a vegetarian version."
  },
  {
    id: "burrata-sausage-pasta",
    name: "Burrata, Sausage & Bell Pepper Pasta",
    subtitle: null,
    source: "Instagram \u2014 chefmarco_nyc",
    tags: ["pasta", "italian", "pork", "air-fryer", "oven-option", "chefmarco_nyc", "quick"],
    baseServings: 3,
    servingsLabel: "servings",
    ingredients: [
      { amount: 400, unit: "g", item: "pasta" },
      { amount: 200, unit: "g", item: "Italian sausage" },
      { amount: 150, unit: "g", item: "burrata" },
      { amount: 2, unit: null, item: "bell peppers (average size)" },
      { amount: null, unit: null, item: "a handful of parsley" },
      { amount: 1, unit: "clove", item: "garlic" },
      { amount: null, unit: null, item: "extra-virgin olive oil \u2014 a generous amount" }
    ],
    method: [
      "Roast the peppers and sausage in an air fryer (or oven) until the peppers are softened and lightly charred and the sausage is cooked through. Slice both.",
      "Cook the pasta until very al dente, reserving plenty of pasta water.",
      "Warm a generous amount of olive oil with the garlic clove until fragrant.",
      "Add sausage, peppers, and pasta; toss over heat with splashes of pasta water until lightly glossy.",
      "Off the heat, tear the burrata over the top and stir gently so it half-melts in.",
      "Finish with chopped parsley and serve immediately."
    ],
    notes: "Pasta water is essential for the sauce. Customize with more garlic, fresh mint, eggplant, or other Mediterranean vegetables."
  },
  {
    id: "amatriciana",
    name: "Amatriciana",
    subtitle: "Classic Roman flavors",
    source: "Instagram \u2014 giallolovesitaly \u00D7 chefmarco_nyc",
    tags: ["pasta", "italian", "roman", "pork", "classic", "chefmarco_nyc"],
    baseServings: 4,
    servingsLabel: "servings",
    ingredients: [
      { amount: 400, unit: "g", item: "bucatini (or any pasta)" },
      { amount: 500, unit: "g", item: "peeled tomatoes" },
      { amount: 90, unit: "g", item: "Pecorino Romano, grated" },
      { amount: 200, unit: "g", item: "guanciale, diced" },
      { amount: null, unit: null, item: "salt and black pepper, to taste" }
    ],
    method: [
      "Cube the guanciale. Start it in a dry pan over medium heat \u2014 its own fat does the cooking.",
      "Once the fat renders, lower the heat and fry until crispy to your liking.",
      "Remove ~90% of the guanciale and some fat (reserve), then add the tomatoes (pureed or hand-crushed) to the pan.",
      "Season lightly \u2014 pecorino and guanciale are both salty. Stir in some pecorino and simmer ~20 minutes.",
      "Cook the pasta 2\u20133 minutes shy of the package time. Drain, reserving water.",
      "Finish the pasta in the sauce with a generous scoop of pasta water, ~2 minutes.",
      "Serve topped with more pecorino and the reserved crispy guanciale."
    ],
    notes: null
  },
  {
    id: "vodka-sauce",
    name: "Vodka Pasta Sauce",
    subtitle: null,
    source: "Instagram \u2014 chefmarco_nyc",
    tags: ["pasta", "sauce", "italian", "vegetarian", "vodka", "slow-simmer", "chefmarco_nyc"],
    baseServings: 4,
    servingsLabel: "servings",
    ingredients: [
      { amount: 400, unit: "g", item: "pasta" },
      { amount: 1, unit: null, item: "onion, diced" },
      { amount: null, unit: null, item: "butter (for the onion, plus optional knob to finish)" },
      { amount: null, unit: null, item: "tomato paste, to taste" },
      { amount: null, unit: null, item: "vodka \u2014 a little less than a glass" },
      { amount: 1, unit: "can", item: "tomato puree" },
      { amount: null, unit: null, item: "heavy cream, to taste" },
      { amount: null, unit: null, item: "Parmigiano Reggiano, to taste" }
    ],
    method: [
      "Cook the diced onion in butter over medium heat until translucent.",
      "Stir in tomato paste to taste.",
      "Turn up the heat and add the vodka. Cook it off \u2014 keep going until you can no longer smell alcohol.",
      "Add the tomato puree and simmer ~30 minutes.",
      "Just before the pasta is ready, lower the heat and stir in heavy cream.",
      "Drain the pasta very al dente (3\u20134 minutes early) and finish it in the sauce a couple of minutes.",
      "Off the heat, finish with Parmigiano (and a knob of butter, if you like). Serve immediately."
    ],
    notes: "Your nose is the guide on the vodka \u2014 cook until the alcohol smell is gone."
  },
  {
    id: "cacio-e-pepe",
    name: "Cacio e Pepe",
    subtitle: null,
    source: "Instagram/TikTok \u2014 chefmarco_nyc",
    tags: ["pasta", "italian", "roman", "vegetarian", "quick", "3-ingredient", "chefmarco_nyc"],
    baseServings: 2,
    servingsLabel: "servings",
    ingredients: [
      { amount: 320, unit: "g", item: "pasta (spaghetti or bucatini)" },
      { amount: 200, unit: "g", item: "Pecorino Romano, finely grated" },
      { amount: null, unit: null, item: "black pepper \u2014 a lot is the minimum" }
    ],
    method: [
      "Toast the pepper briefly in a dry pan over low heat, then add a splash of pasta water.",
      "Cook the pasta in salted water until al dente, reserving plenty of starchy water.",
      "Kill the heat and let the pan cool ~10 seconds before the cheese goes in \u2014 this prevents clumping.",
      "Add the pasta and pecorino off the heat; toss vigorously, adding splashes of pasta water to emulsify into a creamy sauce.",
      "Serve immediately with extra pepper and pecorino."
    ],
    notes: "If pecorino is too sharp, cut it with Parmigiano Reggiano or Grana Padano. Speed and constant motion are everything."
  },
  {
    id: "weeknight-bolognese",
    name: "Weeknight Bolognese Sauce",
    subtitle: "Large batch \u2014 freezes well",
    source: "TikTok/Instagram \u2014 chefmarco_nyc",
    tags: ["sauce", "italian", "beef", "pork", "slow-simmer", "meal-prep", "chefmarco_nyc"],
    baseServings: 8,
    servingsLabel: "servings",
    ingredients: [
      { amount: null, unit: null, item: "olive oil \u2014 a splash" },
      { amount: 2, unit: "cups", item: "vegetable broth" },
      { amount: 300, unit: "g", item: "pancetta" },
      { amount: 700, unit: "g", item: "ground beef" },
      { amount: 100, unit: "g", item: "tomato paste" },
      { amount: 3, unit: "stalks", item: "celery" },
      { amount: 3, unit: null, item: "onions (3\u20134)" },
      { amount: 2, unit: null, item: "carrots (2\u20133)" },
      { amount: 1, unit: "L", item: "milk" },
      { amount: null, unit: null, item: "salt, to taste (added at the end)" }
    ],
    method: [
      "Finely dice celery, onions, and carrots for the soffritto.",
      "Heat a splash of olive oil in a Dutch oven; cook the pancetta until it renders and starts to crisp.",
      "Add the soffritto and cook gently until softened.",
      "Add the beef, breaking it up well, and brown all over.",
      "Stir in the tomato paste and cook a minute or two to deepen.",
      "Add the broth, cover, and simmer low and slow at least an hour, stirring occasionally.",
      "Stir in the milk and simmer uncovered until thick and rich.",
      "Salt only at the end \u2014 pancetta and reduction both concentrate saltiness.",
      "Use with tagliatelle, lasagna, baked pasta, and beyond."
    ],
    notes: "Freeze in portions for future meals."
  },
  {
    id: "cottage-pie",
    name: "Cottage Pie",
    subtitle: "\u201CIt\u2019s quite difficult to mess this up\u2026\u201D",
    source: "Cookbook clipping",
    tags: ["main-dish", "british", "beef", "comfort-food", "oven-baked"],
    baseServings: 4,
    servingsLabel: "servings",
    ingredients: [
      { amount: 1, unit: "tbsp", item: "olive oil" },
      { amount: 1, unit: null, item: "medium onion, chopped" },
      { amount: 2, unit: null, item: "carrots, diced" },
      { amount: 1, unit: null, item: "small red chilli, finely chopped" },
      { amount: 450, unit: "g", item: "minced (ground) beef" },
      { amount: 1, unit: "tbsp", item: "flour" },
      { amount: 450, unit: "ml", item: "hot beef stock" },
      { amount: 3, unit: "tbsp", item: "tomato pur\u00E9e" },
      { amount: 2, unit: "tbsp", item: "Worcestershire sauce" },
      { amount: null, unit: null, item: "a large handful of frozen peas" },
      { amount: 1, unit: "kg", item: "floury potatoes, peeled and chopped" },
      { amount: 4, unit: "tbsp", item: "milk (4\u20135)" },
      { amount: null, unit: null, item: "a decent knob of butter" },
      { amount: null, unit: null, item: "salt and pepper" }
    ],
    method: [
      "Preheat the oven to 200\u00B0C / 400\u00B0F.",
      "Soften the onion and carrot in oil, 3\u20134 minutes; add the chilli for 2 more.",
      "Add the beef and brown all over, breaking it up.",
      "Stir in the flour a little at a time, then add hot stock and tomato pur\u00E9e; boil, then reduce to a simmer.",
      "Add Worcestershire and peas, season, cover, and cook ~15 minutes until thickened.",
      "Meanwhile, boil the potatoes until soft, ~20 minutes. Drain; mash with milk and butter; season.",
      "Spoon the meat into an ovenproof dish, top with mash, and fork a corrugated pattern.",
      "Bake until golden, ~25 minutes."
    ],
    notes: "Swap in lamb and it\u2019s a shepherd\u2019s pie. As long as it\u2019s meaty and juicy with potato on top, it\u2019s a success."
  },
  {
    id: "bertha-bread",
    name: "Bertha Bread",
    subtitle: "Handwritten family recipe",
    source: "Family recipe",
    tags: ["bread", "baking", "family-recipe", "vegetarian", "oven-baked", "heirloom"],
    baseServings: 3,
    servingsLabel: "loaves",
    ingredients: [
      { amount: 8.5, unit: "cups", item: "flour (8\u20139)" },
      { amount: 0.25, unit: "cup", item: "sugar" },
      { amount: 0.25, unit: "cup", item: "Crisco" },
      { amount: 1, unit: "tbsp", item: "salt" },
      { amount: 1.5, unit: "tsp", item: "yeast (1 package)" },
      { amount: 4, unit: "cups", item: "warm water" }
    ],
    method: [
      "Combine flour, sugar, Crisco, salt, and yeast in a large bowl.",
      "Add the warm water and mix/knead until a smooth dough forms.",
      "Let rise until doubled.",
      "Roll out and shape into 3 loaves.",
      "Let the loaves rise again until doubled.",
      "Bake at 350\u00B0F for about 30 minutes."
    ],
    notes: "Oven temperature confirmed at 350\u00B0F (an earlier note had a different temperature crossed out)."
  },
  {
    id: "crack-chicken",
    name: "Crack Chicken Skillet",
    subtitle: null,
    source: "spicysouthernkitchen.com",
    tags: ["main-dish", "american", "chicken", "bacon", "comfort-food", "copycat", "low-carb-adaptable"],
    baseServings: 4,
    servingsLabel: "servings",
    ingredients: [
      { amount: 4, unit: null, item: "boneless, skinless chicken breasts" },
      { amount: 8, unit: "oz", item: "cream cheese (1 package)" },
      { amount: 1, unit: "packet", item: "Ranch seasoning" },
      { amount: 0.5, unit: "cup", item: "water" },
      { amount: 2, unit: "tsp", item: "cornstarch" },
      { amount: 1, unit: "cup", item: "shredded cheddar cheese" },
      { amount: 6, unit: "slices", item: "bacon" },
      { amount: 2, unit: null, item: "green onions, sliced" }
    ],
    method: [
      "Cook the bacon until crisp; crumble and set aside.",
      "Season and cook the chicken in a large skillet over medium heat until browned and cooked through; set aside (or shred in-pan later).",
      "Whisk the water and cornstarch until smooth.",
      "On lower heat, melt the cream cheese with the Ranch seasoning into a smooth sauce (loosen with a splash of liquid if needed).",
      "Stir in the slurry and simmer until slightly thickened.",
      "Return the chicken (whole or shredded) and coat in the sauce.",
      "Top with cheddar, cover to melt, then finish with bacon and green onions."
    ],
    notes: "Serve over rice, mashed potatoes, or pasta. Slow-cooker friendly: cook chicken low and slow in the sauce, shred, then stir in cheddar, bacon, and green onions."
  }

  /* ── TEMPLATE — copy from here, paste ABOVE this comment ──
  ,{
    id: "my-new-recipe",                     // unique, lowercase, no spaces
    name: "My New Recipe",
    subtitle: null,                          // or "A short tagline"
    source: "Where it came from",
    tags: ["main-dish", "quick"],            // any tags you like — new ones appear in filters automatically
    baseServings: 4,
    servingsLabel: "servings",
    ingredients: [
      { amount: 2, unit: "cups", item: "example ingredient" },
      { amount: 1, unit: null, item: "whole thing, like an onion" },
      { amount: null, unit: null, item: "salt, to taste" }   // null amount = doesn't scale
    ],
    method: [
      "Step one.",
      "Step two."
    ],
    notes: null                              // or "Any tips."
  }
  ── END TEMPLATE ── */
];
