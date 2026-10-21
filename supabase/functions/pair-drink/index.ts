// Supabase Edge Function: pair-drink
//
// "Pair a drink with this meal" — given a kitchen recipe, propose 2-3 drink
// pairings for a chosen kind (cocktail, wine, or beer).
//
//   - Cocktail: when the user has a bar inventory on record, the options step
//     returns THREE picks — ONE drink built to be makeable right now from
//     what's in stock (soda water, bitters, and citrus are assumed always on
//     hand), then TWO chosen purely as the best flavor pairings for the dish
//     regardless of stock. With no inventory recorded it returns 2-3 pure
//     meal pairings. Any option may point at one of the user's OWN saved bar
//     recipes (free to view) or be a new invented idea. This is a two-step
//     flow, mirroring generate-recipe's concepts->full split: mode:"options"
//     proposes the lightweight pairings (NOT capped — some or all may just
//     point at an existing recipe, which costs nothing further to view);
//     mode:"develop" turns a picked INVENTED concept into a full, saveable
//     cocktail recipe (capped). Picking an EXISTING match needs no second
//     call at all.
//   - Wine / beer: a single call proposes 2-3 style/varietal recommendations
//     (never a brand or bottle) — there's nothing to "develop" into a
//     savable recipe, so this one call is the whole interaction and is what
//     counts against the cap (capped, like every recipe-coach turn).
//
// The wine/beer/cocktail pairing knowledge blocks below are copied
// near-verbatim from drink-pairing-research-brief.md's Recommendations
// section (a sourced deep-research brief: WSET, Cicerone/Brewers
// Association, Punch, Wine Enthusiast) — the same technique already used
// for generate-recipe's CUISINE FLAVOR BASES / QUANTITIES blocks, so the
// model isn't relying on its own uncertain recall of pairing facts.
//
// Mirrors generate-recipe/recipe-coach: structured output via forced
// tool_choice, the Anthropic key stays server-side, the caller's Supabase
// JWT is verified, and a per-user daily cap is enforced in its OWN bucket
// (increment_pairing_usage) before any capped call.
//
// Request body (JSON):
//   { kind: "cocktail" | "wine" | "beer",
//     mode: "options" | "develop",   // "develop" is cocktail-only
//     recipe: { name, section, tags, ingredients, method, notes, ... },
//     barRecipes: [{ id, name, tags, ingredientsSummary, missing: string[] }], // cocktail+"options" only
//     barInventory: string[],        // cocktail: in-stock bar ingredients (drives the "from your bar" option)
//     concept: { title, blurb },     // cocktail+"develop" only
//     fromBar: boolean,              // cocktail+"develop": keep the drink to stocked ingredients
//     dietPrefs: { diets, allergies, avoid } }
//
// Response: always HTTP 200 — { options: [...] } | { recipe: {...} } | { error }.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Pairing is a structured, knowledge-block-driven task — Haiku handles it
// well, same reasoning as generate-recipe. Flip to Sonnet if quality testing
// shows weak results. (Haiku 5.5: see generate-recipe's note — rolled back.)
const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
// Soft per-user cap on paid Anthropic calls, enforced via increment_pairing_usage().
// The cocktail "options" step is NOT capped (mirrors generate-recipe's concepts
// step) — only "develop" and every wine/beer call count.
const DAILY_PAIRING_LIMIT = 20;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Curated tag taxonomy — KEEP IN SYNC with extract-recipe/index.ts,
// generate-recipe/index.ts, recipe-coach/index.ts, and the index.html tag
// checkboxes. Needed here for the invented-cocktail RECIPE_SCHEMA.
const KITCHEN_CUISINE_TAGS = ["italian", "american", "mexican", "mediterranean", "british", "finnish", "asian", "french"];
const KITCHEN_PROTEIN_TAGS = ["chicken", "beef", "pork", "seafood", "vegetarian", "vegan"];
const KITCHEN_DISH_TAGS = ["pizza", "pasta", "burger", "taco", "casserole", "soup", "salad", "sandwich", "bread", "breakfast", "dessert", "main-dish", "side-dish", "sauce"];
const BAR_SPIRIT_TAGS = ["rum", "gin", "whiskey", "tequila", "vodka", "brandy", "amaro", "non-alcoholic"];
const BAR_STYLE_TAGS = ["sour", "collins", "highball", "tiki", "frozen", "stirred", "classic", "low-abv"];
const ALL_TAGS = [
  ...KITCHEN_CUISINE_TAGS, ...KITCHEN_PROTEIN_TAGS, ...KITCHEN_DISH_TAGS,
  ...BAR_SPIRIT_TAGS, ...BAR_STYLE_TAGS
];

// Identical shape to generate-recipe's RECIPE_SCHEMA — used only for the
// cocktail "develop" step, so a picked pairing funnels straight into
// fillRecipeFormFromExtraction() unchanged.
const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Cocktail title, written head-noun-first: lead with the core spirit or drink type, then any style/qualifier after ' - '." },
    subtitle: { type: ["string", "null"], description: "Short appetizing one-line description, or null" },
    source: { type: ["string", "null"], description: "Set to 'AI generated' for generated recipes." },
    section: { type: "string", enum: ["kitchen", "bar"], description: "Always 'bar' here." },
    tags: {
      type: "array",
      items: { type: "string", enum: ALL_TAGS },
      maxItems: 3,
      description: "0-3 tags from this fixed list ONLY — at most one spirit tag and one style tag. Never invent a tag outside this list."
    },
    base_servings: { type: "integer", description: "The number of drinks the amounts are written for" },
    servings_label: { type: "string", description: "Unit for servings, e.g. 'drink', 'drinks'" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          amount: { type: ["number", "null"], description: "Numeric quantity, fractions as decimals (1/2 -> 0.5). Use null only for a true to-taste/garnish item." },
          unit: { type: ["string", "null"], description: "Unit of measure (oz, dash, etc.), or null if countable / no unit" },
          item: { type: "string", description: "The ingredient's common name in full, consistent words (no abbreviations or brand names)." },
          group: { type: ["string", "null"], description: "Short Title-Case sub-component label (e.g. 'Garnish'), or null." }
        },
        required: ["amount", "unit", "item", "group"]
      }
    },
    method: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "One method step." },
          group: { type: ["string", "null"], description: "Same sub-component label as the matching ingredients, or null." }
        },
        required: ["text", "group"]
      },
      description: "Ordered list of method/instruction steps"
    },
    notes: { type: ["string", "null"], description: "Briefly say why this pairs with the dish it was paired with. If any ingredient is genuinely hard to find, mention it here." }
  },
  required: ["name", "subtitle", "source", "section", "tags", "base_servings", "servings_label", "ingredients", "method", "notes"]
};

// Forced tool for the "options" step (both cocktail and wine/beer share this
// shape closely enough to use two near-identical schemas below).
const PAIR_OPTIONS_SCHEMA = {
  type: "object",
  properties: {
    options: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          basis: { type: "string", enum: ["bar", "meal"], description: "\"bar\" for the single option built to be makeable right now from the user's bar inventory; \"meal\" for an option chosen purely as a best flavor pairing for the dish. Include exactly ONE \"bar\" option when a non-empty bar inventory is provided; otherwise every option is \"meal\"." },
          matched_existing_id: { type: ["string", "null"], description: "The id of the best-fitting recipe from the candidate list, if a genuinely good flavor pairing exists among the user's own bar recipes. For a \"bar\" option prefer a candidate the list marks fully in stock; for a \"meal\" option a great flavor match with one missing ingredient beats a mediocre in-stock one. null if none fit — or if there is no candidate list." },
          title: { type: "string", description: "The existing recipe's name (if matched_existing_id is set) or a working title for a new cocktail idea." },
          blurb: { type: "string", description: "One sentence on why this pairs well with the dish — reference the actual dish, not generic praise." }
        },
        required: ["basis", "matched_existing_id", "title", "blurb"]
      }
    }
  },
  required: ["options"]
};

const STYLE_PAIR_SCHEMA = {
  type: "object",
  properties: {
    options: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          recommendation: { type: "string", description: "A specific wine varietal/style or beer style — a TYPE, never a brand or specific bottle." },
          characteristics: { type: "string", description: "Brief tasting profile, e.g. 'crisp, high acid, citrus and grass notes'." },
          blurb: { type: "string", description: "One sentence on why this pairs well with the dish — reference the actual dish, not generic praise." }
        },
        required: ["recommendation", "characteristics", "blurb"]
      }
    }
  },
  required: ["options"]
};

// ---- Pairing knowledge blocks — copied near-verbatim from the "Recommendations"
// section of drink-pairing-research-brief.md (repo root), a sourced deep-research
// brief (WSET, Cicerone/Brewers Association, Punch, Wine Enthusiast, Wine Folly).
// Do not paraphrase further — already condensed once for exactly this purpose. ----

const WINE_PAIRING_BASES = `WINE PAIRING PRINCIPLES
- Match intensity: delicate dish -> delicate wine. Pair to the sauce, not the protein.
- Wine must be at least as sweet as the dish, or the dish strips it.
- Wine should be at least as acidic as the dish.
- Acid and bubbles cut fat. Tannin needs fat/protein/salt to soften.
- Alcohol amplifies chili heat; heat amplifies tannin. Spicy -> low-ABV, low-tannin, off-dry.
- Umami (mushroom, aged cheese, soy) amplifies tannin unless salt is present.
- Regional logic is valid: what grows together goes together.

WINE BY DISH ARCHETYPE
- Grilled/roasted red meat -> Cabernet Sauvignon, Syrah, Nebbiolo. Salt+fat bind tannin.
- Cream/butter sauce, soft rich cheese -> traditional-method sparkling, oaked Chardonnay,
  Chenin Blanc. Acid and carbonation cut the fat; body matches.
- Goat cheese, vinaigrette, green salad -> Sauvignon Blanc, Gruner Veltliner. Acid meets acid.
- Spicy Asian/Mexican -> off-dry Riesling, Gewurztraminer, dry rose. Sweetness tempers heat;
  low alcohol avoids amplifying the burn.
- Fried/fatty -> Champagne or Cava, Muscadet, Chablis. Acid and bubbles scrub the palate.
- Light seafood/shellfish -> Muscadet, Albarino, Chablis. High acid, saline, non-dominating.
- Tomato-forward Italian -> Sangiovese/Chianti, Barbera, Aglianico. The wine's acid must
  meet the tomato's; regional classic.
- Earthy/mushroom -> Pinot Noir, aged Nebbiolo, Gruner Veltliner. Low tannin plus congruent
  earthiness; big tannin turns harsh against umami.
- Cured meat/hard aged cheese -> Fino or Amontillado Sherry, tannic red, sparkling. Salt
  softens tannin.
- Roast chicken/pork -> Chardonnay, Pinot Noir, dry Riesling. Mid-weight body match.
- Dessert -> Sauternes, Moscato d'Asti, Port. The wine must out-sweet the dish. Dark
  chocolate is hard: bitter on bitter.`;

const BEER_PAIRING_BASES = `BEER PAIRING PRINCIPLES
- Match intensity first, then complement, contrast, or cut.
- Carbonation and alcohol balance richness. Hop bitterness and roasted malt balance sweetness.
- Malt sweetness tempers chili heat. Hop bitterness AMPLIFIES chili heat -- avoid high-IBU
  IPA with spicy food.
- Sourness and acidity refresh the palate against cream and fat.

BEER BY DISH ARCHETYPE
- Grilled/charred red meat, BBQ -> porter, dry stout, Scotch ale. Roast malt echoes the char.
- Fried/fatty, burgers, fish and chips -> pilsner, pale ale, moderate IPA. Carbonation plus
  bitterness cut fat.
- Light seafood, sushi, salads -> pilsner, witbier, hefeweizen, kolsch. Witbier is the
  classic with mussels.
- Spicy Asian/Mexican -> witbier, hefeweizen, amber/Vienna lager, abbey dubbel. Residual
  malt sweetness cools the heat.
- Cream sauce/soft cheese -> saison, gose or Berliner Weisse; IPA for blue cheese.
- Roast chicken/pork -> Oktoberfest/Marzen, amber lager, pale ale. Caramel malt complement.
- Tomato-forward Italian -> pilsner, saison, amber ale. Crisp bitterness against the acidity.
- Earthy/mushroom -> brown ale, dunkel, saison. Nutty roast meets earth.
- Dessert/chocolate -> imperial stout, abbey dubbel or strong dark ale, fruit lambic. Match
  the dessert's intensity; roast resonates with cocoa.`;

const COCKTAIL_PAIRING_BASES = `COCKTAIL PAIRING PRINCIPLES
- Less codified than wine or beer -- these are professional conventions, not rules.
- Cocktails are high in alcohol, acid, sugar, and bitterness, which makes them harder to
  pair. The fix is low ABV: build on sherry, vermouth, cider, sparkling wine, or a highball.
- Mid-meal, keep pours small (2-3 oz for spirit-forward) and let dilution do work.
- Drink at least as sweet as the dish, cut with citrus so it isn't cloying.
- Cocktails win where wine fails: vinegar-forward dishes, big chili heat, rich desserts.
- Order: aperitif = dry, bitter, citrusy, low-ABV (sweetness kills appetite). With the meal =
  effervescent and low-ABV. Digestif = sweeter, bitter, herbal, small pour.

COCKTAIL BY DISH ARCHETYPE
- Grilled red meat, braises -> bitter/stirred spirit-forward (Old Fashioned, Manhattan,
  Sazerac). Sweetness lifts umami; bitterness balances char and cleanses fat.
- Fried/fatty, tacos, rich salads -> sour/citrus-forward (Margarita, Whiskey Sour, Daiquiri,
  Tom Collins). Citrus acid cuts fat and mirrors lime already on the plate.
- Oysters, shellfish, herb-roasted chicken, lamb -> herbal/botanical (Martini, G&T, Last
  Word, Julep). Salinity and herb affinity. Note: a Martini amplifies chili heat.
- Spicy, jerk, Caribbean -> tiki/rum or anything with real sweetness. Sugar cools capsaicin.
- Cream sauce, cheese, charcuterie, anything mid-meal -> highball/spritz/effervescent.
  Bubbles plus low ABV keep the palate live across a long meal.
- Dessert -> layer like with like (cherry drink for a cherry tart) and out-sweet the plate;
  or an amaro/bitter digestif as contrast.`;

// A brief hedge for cocktail pairing specifically, per the research brief's
// own Caveat #1 — wine/beer are backed by certification-body curricula,
// cocktail pairing is trade-press consensus only, so the model shouldn't
// state cocktail suggestions with the same certainty.
const COCKTAIL_HEDGE = `Cocktail-food pairing is far less formally codified than wine or beer — frame these as what bartenders/trade sources reach for, not as fixed rules; a brief hedge in the blurb/notes is fine.`;

// The options-step system prompt. Branches on whether the user has a bar
// inventory: with one, the first pick is built to be makeable right now from
// what's in stock and the other two are the best flavor pairings for the
// dish; without one, all picks are pure meal pairings.
function buildCocktailOptionsPrompt(hasInventory: boolean): string {
  const structure = hasInventory
    ? `Propose exactly 3 DISTINCT options, in this order:
1. ONE "from your bar" option (basis:"bar"): the BEST cocktail the user can make RIGHT NOW from their BAR INVENTORY (listed in the context below). Treat soda water, bitters, and citrus (lemon/lime) as ALWAYS on hand even if not listed. Aim for a genuine, well-composed cocktail that both suits the dish and shows off the spirits in stock — e.g. if the makings of a proper classic (a Negroni, a Manhattan, a sour) are on hand, choose that over a plain two-ingredient highball. Prefer a saved candidate recipe that's marked fully in stock and pairs at least decently; if none fits, invent one that uses ONLY stocked ingredients plus those three assumed staples. Reach for the simplest drink (a highball, a spirit + soda) only when the inventory genuinely can't support anything better. This option must be genuinely makeable with what's on hand — never call for a spirit or mixer the user doesn't have.
2. TWO "pairs with the meal" options (basis:"meal"): the two cocktails that pair BEST with this specific dish, chosen purely for flavor affinity — ignore what's in stock. Each may point at a saved candidate or be a new idea.`
    : `The user has no bar inventory on record, so propose exactly 2-3 DISTINCT "pairs with the meal" options (basis:"meal") — the cocktails that pair BEST with this specific dish, chosen for flavor affinity. Each may point at a saved candidate or be a new idea.`;

  return `You help a home cook pick a cocktail to serve with a meal they're making. You answer by calling the propose_pairings tool — nothing else, no prose.

${structure}

For any option:
- To point at one of the user's saved bar recipes (the candidate list below — each with its id, name, tags, ingredients, and which ingredients, if any, are missing), set matched_existing_id to its id and title to its name.
- To suggest a new drink, set matched_existing_id to null, give a working title, and describe the idea in the blurb — do NOT write ingredients or a method here; that only happens if the user picks it.
- The blurb is one sentence on why it suits THIS dish — reference the actual dish, not generic praise. For the "bar" option, make clear it's built from what's on hand.
- Make the options genuinely different from each other (vary style/technique/spirit — a sour, a stirred spirit-forward drink, a highball — not variations of one drink).

${COCKTAIL_HEDGE}

${COCKTAIL_PAIRING_BASES}`;
}

const COCKTAIL_DEVELOP_PROMPT = `You are a home-bartending recipe developer. The user picked a cocktail idea to pair with a dish they're making; develop it into ONE complete, realistic cocktail recipe and return it by calling the save_recipe tool. Produce exactly one recipe — never ask follow-up questions, never return prose.

The dish it's pairing with is in the context below — keep the cocktail genuinely suited to it, which is why it was picked.

QUANTITIES — ground every amount in standard culinary ratios, never guess: a sour is ~2:1:1 spirit:sweet:sour (e.g. 2oz:0.75oz:0.75oz); stirred/spirit-forward is roughly equal-to-2:1 parts; a highball is ~1 part spirit : 3 parts mixer. Express bar amounts in oz.

ALLERGIES ARE ABSOLUTE. If the user lists allergies, NEVER include those ingredients or anything containing them, in any amount, including garnish or substitutions.

OUTPUT: section is "bar". source is "AI generated". Pick 0-3 tags from the allowed list only (at most one spirit tag and one style tag). Give concrete oz amounts and a sensible base_servings/servings_label (e.g. 1, "drink"). In notes, briefly say why this pairs with the dish.

${COCKTAIL_HEDGE}`;

function buildStylePrompt(kind: "wine" | "beer"): string {
  const label = kind === "wine" ? "wine" : "beer";
  const example = kind === "wine" ? `a dry Sauvignon Blanc` : `a Belgian witbier`;
  const varyBy = kind === "wine" ? "body/grape family" : "style family";
  const bases = kind === "wine" ? WINE_PAIRING_BASES : BEER_PAIRING_BASES;
  return `You help a home cook pick a ${label} to serve with a meal they're making. You answer by calling the propose_drink_styles tool — nothing else, no prose.

Given the dish (in the context below), propose exactly 2-3 DISTINCT ${label} pairings. Each option's "recommendation" is a specific ${label} TYPE (e.g. "${example}") — never a brand or specific bottle. "characteristics" is a brief tasting profile. "blurb" is one sentence on why it pairs well with THIS dish specifically — reference the actual dish, not generic praise.

Make the options genuinely different from each other (vary ${varyBy} — don't return three near-identical picks).

${bases}`;
}

function listOrNone(arr: unknown): string {
  return Array.isArray(arr) && arr.length ? arr.join(", ") : "none";
}

// Injects the kitchen recipe as context, mirroring recipe-coach's
// buildSystemPrompt idiom (JSON-stringified, length-capped) — appended to
// whichever system prompt is in play, not resent as a user message.
function recipeContextBlock(recipe: unknown): string {
  let json = "";
  try {
    json = JSON.stringify(recipe, null, 2).slice(0, 12_000);
  } catch {
    json = "(recipe could not be read)";
  }
  return `The dish to pair a drink with (for context):\n${json}`;
}

// A usable recipe from the model: a name and at least one ingredient.
// deno-lint-ignore no-explicit-any
const isRecipe = (r: any) => !!r && !!r.name && Array.isArray(r.ingredients) && r.ingredients.length > 0;

// ==== ALLERGEN NET ====
// MIRROR: this block is byte-identical in generate-recipe and pair-drink (each
// function deploys as one file); testing-skills/allergen_net_test.py checks the
// copies match and runs the cases. Change both or neither.
//
// An allergy is often a CATEGORY ("shellfish", "tree nuts", "dairy") that never
// appears word-for-word in an ingredient list, so a literal match let "shrimp"
// through a shellfish allergy. Each family lists its foods (including hidden
// sources: Worcestershire = anchovy, orgeat = almond, Clamato = clam), and its
// `except` patterns strip free-from forms first ("coconut milk", "peanut
// butter", "gluten-free pasta") so a safe recipe isn't rejected after a paid call.
// Keys and foods are lowercase; plain JSON so the test can parse them. Each
// ingredient line is scanned on its own, so an except pattern can never erase
// part of another ingredient.
const ALLERGEN_ALIASES: Record<string, string[]> = {
  "shellfish": ["shellfish"], "crustacean": ["crustacean"], "mollusc": ["mollusc"], "mollusk": ["mollusc"],
  "fish": ["fish"], "seafood": ["fish", "shellfish"],
  "tree nut": ["tree nut"], "nut": ["tree nut", "peanut"], "peanut": ["peanut"], "groundnut": ["peanut"],
  "dairy": ["dairy"], "milk": ["dairy"], "cow's milk": ["dairy"], "lactose": ["dairy"], "casein": ["dairy"], "whey": ["dairy"],
  "egg": ["egg"],
  "gluten": ["gluten"], "wheat": ["gluten"], "celiac": ["gluten"], "coeliac": ["gluten"],
  "soy": ["soy"], "soya": ["soy"], "soybean": ["soy"],
  "sesame": ["sesame"], "sesame seed": ["sesame"]
};
const ALLERGEN_FAMILIES: Record<string, { foods: string[]; except: string[] }> = {
  "shellfish": {
    "foods": ["shellfish", "shrimp", "prawn", "crab", "lobster", "crawfish", "crayfish", "langoustine", "scallop", "clam", "clamato", "mussel", "oyster", "cockle", "squid", "calamari", "octopus"],
    "except": ["\\boyster mushrooms?\\b", "\\bcrab ?apples?\\b"]
  },
  "crustacean": {
    "foods": ["crustacean", "shrimp", "prawn", "crab", "lobster", "crawfish", "crayfish", "langoustine"],
    "except": []
  },
  "mollusc": {
    "foods": ["mollusc", "mollusk", "scallop", "clam", "clamato", "mussel", "oyster", "cockle", "squid", "calamari", "octopus"],
    "except": ["\\boyster mushrooms?\\b"]
  },
  "fish": {
    "foods": ["fish", "salmon", "tuna", "cod", "halibut", "tilapia", "trout", "anchovy", "sardine", "mackerel", "haddock", "snapper", "sea bass", "swordfish", "mahi mahi", "catfish", "pollock", "herring", "bonito", "fish sauce", "worcestershire"],
    "except": ["\\bvegan fish sauce\\b"]
  },
  "tree nut": {
    "foods": ["tree nut", "almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "macadamia", "brazil nut", "pine nut", "chestnut", "praline", "marzipan", "frangipane", "nutella", "orgeat", "frangelico", "nocino"],
    "except": ["\\bwater chestnuts?\\b"]
  },
  "peanut": {
    "foods": ["peanut", "groundnut", "satay"],
    "except": []
  },
  "dairy": {
    "foods": ["dairy", "milk", "butter", "buttermilk", "cheese", "cream", "sour cream", "ice cream", "yogurt", "yoghurt", "ghee", "whey", "casein", "half-and-half", "half and half", "creme fraiche", "crème fraîche", "parmesan", "mozzarella", "cheddar", "ricotta", "feta", "mascarpone", "gouda", "brie", "paneer", "baileys", "irish cream"],
    "except": [
      "\\b(?:coconut|almond|oat|soy|soya|rice|cashew|hemp|macadamia|hazelnut|pea|flax|plant[- ]based|plant|vegan|non[- ]dairy|dairy[- ]free)(?: (?!and\\b|or\\b|with\\b|plus\\b)[a-z'-]+){0,2} +(?:milk|cream|yogh?urt|butter|cheese|creamer|parmesan|mozzarella|cheddar|ricotta|feta|ghee)s?\\b",
      "\\b(?:peanut|almond|cashew|nut|sunflower|seed|apple|cocoa|shea|pumpkin|soy) +butter\\b",
      "\\bbutter ?(?:beans?|lettuce)\\b",
      "\\bcream of (?:tartar|coconut)\\b",
      "\\bcream (?:soda|sherry)\\b"
    ]
  },
  "egg": {
    "foods": ["egg", "egg white", "egg yolk", "eggnog", "mayonnaise", "mayo", "aioli", "meringue", "hollandaise", "bearnaise", "béarnaise"],
    "except": ["\\b(?:vegan|plant[- ]based|egg[- ]free|eggless) +(?:mayo|mayonnaise|aioli|eggs?)\\b", "\\begg replacer\\b", "\\b(?:flax|chia) eggs?\\b"]
  },
  "gluten": {
    "foods": ["gluten", "wheat", "flour", "bread", "breadcrumb", "bread crumb", "panko", "crouton", "pasta", "spaghetti", "penne", "linguine", "fettuccine", "macaroni", "lasagna", "lasagne", "orzo", "rigatoni", "noodle", "ramen", "udon", "couscous", "barley", "rye", "farro", "semolina", "spelt", "bulgur", "seitan", "soy sauce", "malt", "beer", "pastry", "pie crust", "croissant", "bagel", "pita", "naan", "cracker", "phyllo", "filo"],
    "except": [
      "\\b(?:gluten[- ]free|gf) +[\\w'-]+(?: +(?:flour|bread|pasta|noodles?|crumbs?|breadcrumbs?|panko|beer|soy sauce|crackers?|spaghetti|penne|macaroni))?",
      "\\b(?:rice|almond|coconut|corn|chickpea|oat|tapioca|potato|sweet potato|cassava|sorghum|teff|buckwheat|quinoa|millet|arrowroot|glass|cellophane|shirataki|kelp|zucchini|mung bean) +(?:flour|noodles?|pasta|bread|crumbs?|crackers?)\\b",
      "\\b(?:ginger|root) +beers?\\b"
    ]
  },
  "soy": {
    "foods": ["soy", "soya", "soybean", "soy sauce", "tofu", "tempeh", "edamame", "miso", "tamari", "shoyu"],
    "except": []
  },
  "sesame": {
    "foods": ["sesame", "tahini", "benne", "za'atar", "zaatar", "furikake", "halva", "halvah", "gomasio"],
    "except": []
  }
};
// "<anything>-free" is never the allergen itself ("nut-free pesto"). Stripped
// AFTER a family's own `except` patterns, which need the "gluten-free" context.
const FREE_FROM_RE = /\b[\w']+[- ]free\b/gi;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "tree nuts" -> "tree nut", "anchovies" -> "anchovy", "tomatoes" -> "tomato".
function singularOf(term: string): string {
  if (term.length <= 3) return term;
  if (/ies$/.test(term)) return term.slice(0, -3) + "y";
  if (/oes$/.test(term)) return term.slice(0, -2);
  if (/[^s]s$/.test(term)) return term.slice(0, -1);
  return term;
}
// Whole word/phrase, tolerating a plural or possessive ("peanuts", "crab's",
// "anchovies").
const allergenWordRe = (term: string) => {
  const forms = [`${escapeRegExp(term)}(?:es|s|'s)?`];
  if (/[^aeiou]y$/.test(term)) forms.push(`${escapeRegExp(term.slice(0, -1))}ies`);
  return new RegExp(`\\b(?:${forms.join("|")})\\b`, "i");
};
// The families an allergy entry belongs to: "Tree Nuts" -> ["tree nut"]. Empty
// for anything not in the table, which then falls back to a literal match.
function allergenFamilies(raw: string): string[] {
  const term = raw.trim().toLowerCase();
  return ALLERGEN_ALIASES[term] || ALLERGEN_ALIASES[singularOf(term)] || [];
}
// Post-generation safety net: does the recipe actually put an allergen on the
// plate? Scans the NAME and each INGREDIENT line separately — NOT notes, because
// a safe recipe may legitimately mention an allergen in notes to say it was left
// out ("omits peanuts per your allergy"). Returns what to tell the cook — label
// "shrimp (shellfish)" plus the offending line — or null.
function allergyHit(recipe: { name?: string; ingredients?: Array<{ item?: string }> }, allergies: unknown[]): { label: string; item: string } | null {
  // Ingredient lines first: reporting "2 tbsp crushed peanuts" is more useful to
  // the cook (and to the repair prompt) than the recipe title.
  const lines: string[] = [];
  (recipe.ingredients || []).forEach((ing) => { if (ing?.item) lines.push(ing.item); });
  if (recipe.name) lines.push(recipe.name);
  for (const raw of allergies) {
    const term = String(raw).trim().toLowerCase();
    if (!term) continue;
    const families = allergenFamilies(term);
    for (const line of lines) {
      const text = line.toLowerCase();
      if (!families.length) {
        if (allergenWordRe(singularOf(term)).test(text.replace(FREE_FROM_RE, " "))) return { label: term, item: line };
        continue;
      }
      for (const fam of families) {
        const { foods, except } = ALLERGEN_FAMILIES[fam];
        const scoped = except.reduce((h, pat) => h.replace(new RegExp(pat, "gi"), " "), text).replace(FREE_FROM_RE, " ");
        const food = foods.find((f) => allergenWordRe(f).test(scoped));
        if (food) return { label: food === term || food === singularOf(term) ? term : `${food} (${term})`, item: line };
      }
    }
  }
  return null;
}
// When the net trips, the function asks once more with exactly what slipped in,
// instead of failing the cook's (already counted) request outright.
function allergenRepairText(userText: string, hit: { label: string; item: string }): string {
  return `${userText}\n\nIMPORTANT: your previous draft included "${hit.item}" — that is ${hit.label}, and the cook is allergic to it. Write it again with that ingredient removed or replaced by a safe alternative, and nothing else from the allergy list above.`;
}
// The cook-facing message when the repair also fails.
const allergenErrorText = (hit: { label: string; item: string }) => `included ${hit.label} (“${hit.item}”), which is on your allergy list`;
// The allergy list as the prompt states it, each family spelled out so the
// model avoids the specific foods up front instead of tripping allergyHit.
function describeAllergies(allergies: unknown[]): string {
  const parts = allergies.map((a) => String(a).trim()).filter(Boolean).map((a) => {
    const self = [a.toLowerCase(), singularOf(a.toLowerCase())];
    const foods = [...new Set(allergenFamilies(a).flatMap((f) => ALLERGEN_FAMILIES[f].foods))]
      .filter((f) => !self.includes(f));
    return foods.length ? `${a} (includes ${foods.join(", ")})` : a;
  });
  return parts.length ? parts.join("; ") : "none";
}
// ==== END ALLERGEN NET ====

// One forced-tool Anthropic call — identical shape to generate-recipe's runTool.
async function runTool(system: string, toolName: string, schema: unknown, userText: string): Promise<{ input?: any; error?: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system,
      tools: [{ name: toolName, description: "Return the structured result.", input_schema: schema }],
      tool_choice: { type: "tool", name: toolName },
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("Anthropic API error:", res.status, errText);
    return { error: res.status === 429 ? "Rate limit or usage limit reached — try again later." : "AI pairing failed. Please try again." };
  }
  const data = await res.json();
  // Newer models (Haiku 5.5+) run safety classifiers that can decline a request:
  // HTTP 200, stop_reason "refusal", no tool call. Say so plainly instead of the
  // generic "couldn't make a recipe" (harmless on models that never refuse).
  if (data.stop_reason === "refusal") {
    console.error("pair-drink: request declined by the model", data.stop_details?.category ?? "");
    return { error: "The AI declined that request — try a different option." };
  }
  if (data.stop_reason === "max_tokens") {
    console.error("pair-drink: response truncated at max_tokens");
    return { error: "That came out too long — try again." };
  }
  const toolBlock = data.content?.find((c: { type: string }) => c.type === "tool_use");
  return { input: toolBlock?.input };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return json({ error: "Server isn’t configured for AI pairing yet (missing API key)." });
    }

    // Verify the caller is a logged-in user before spending any API budget.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Please sign in first." });
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Please sign in first." });

    const body = await req.json();
    const kind = body.kind === "wine" ? "wine" : body.kind === "beer" ? "beer" : "cocktail";
    const recipe = body.recipe && typeof body.recipe === "object" ? body.recipe : null;
    if (!recipe) return json({ error: "No dish was provided to pair with." });

    const dp = body.dietPrefs && typeof body.dietPrefs === "object" ? body.dietPrefs : {};
    const diets = Array.isArray(dp.diets) ? dp.diets : [];
    const allergies = Array.isArray(dp.allergies) ? dp.allergies : [];
    const avoid = Array.isArray(dp.avoid) ? dp.avoid : [];
    const dietLines = [
      `Dietary constraints:`,
      `- Diets that MUST be satisfied: ${listOrNone(diets)}`,
      `- ALLERGIES — never include, in any form, including garnish or substitutions: ${describeAllergies(allergies)}`,
      `- Dislikes to avoid when possible: ${listOrNone(avoid)}`
    ].join("\n");

    const dishContext = recipeContextBlock(recipe);

    // ---- Cocktail, step 2: develop a picked INVENTED concept (capped) ----
    if (kind === "cocktail" && body.mode === "develop") {
      const concept = body.concept && typeof body.concept === "object" ? body.concept : null;
      if (!concept?.title) return json({ error: "No cocktail idea was picked." });

      const { data: usageResult, error: usageError } = await supabaseClient
        .rpc("increment_pairing_usage", { daily_limit: DAILY_PAIRING_LIMIT });
      if (!usageError && usageResult === -1) {
        return json({ error: `You’ve used today’s ${DAILY_PAIRING_LIMIT} AI pairings — it resets at midnight UTC. Try again tomorrow.` });
      }
      if (usageError) console.error("pairing_usage check failed:", usageError);

      // If this was the "from your bar" pick, keep the finished drink to
      // what's actually in stock (plus the always-on-hand staples).
      const developInventory = Array.isArray(body.barInventory)
        ? body.barInventory.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 60)
        : [];
      const barConstraint = body.fromBar === true && developInventory.length
        ? `\nThis drink is meant to be made from the user's CURRENT BAR — use ONLY these stocked ingredients, plus soda water, bitters, and citrus (always on hand), and nothing else: ${developInventory.join(", ")}.`
        : "";

      const userText = [
        dishContext,
        "",
        `The user picked this cocktail idea to pair with the dish above — develop it into the full recipe: "${String(concept.title)}"${concept.blurb ? ` — ${String(concept.blurb)}` : ""}.`,
        barConstraint,
        "",
        dietLines,
        "",
        `Call save_recipe once with the finished recipe.`
      ].join("\n");

      const first = await runTool(COCKTAIL_DEVELOP_PROMPT, "save_recipe", RECIPE_SCHEMA, userText);
      if (first.error) return json({ error: first.error });
      let cocktailRecipe = first.input;
      if (!isRecipe(cocktailRecipe)) {
        return json({ error: "AI couldn’t develop that pairing — try a different option." });
      }
      // Safety net, with one repair pass (same counted request) before giving up.
      const hit = allergyHit(cocktailRecipe, allergies);
      if (hit) {
        console.error("pair-drink: allergen net tripped on", hit.label, "in", hit.item, "— repairing");
        const retry = await runTool(COCKTAIL_DEVELOP_PROMPT, "save_recipe", RECIPE_SCHEMA, allergenRepairText(userText, hit));
        if (!isRecipe(retry.input) || allergyHit(retry.input, allergies)) {
          return json({ error: `That cocktail ${allergenErrorText(hit)} — please try a different option.` });
        }
        cocktailRecipe = retry.input;
      }
      cocktailRecipe.section = "bar";
      return json({ recipe: cocktailRecipe, ...(hit ? { allergen_repaired: hit } : {}) });
    }

    // ---- Cocktail, step 1: propose 2-3 pairings (NOT capped) ----
    if (kind === "cocktail") {
      const barRecipes = Array.isArray(body.barRecipes) ? body.barRecipes.slice(0, 40) : [];
      const barInventory = Array.isArray(body.barInventory)
        ? body.barInventory.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 60)
        : [];
      const hasInventory = barInventory.length > 0;

      const candidatesText = barRecipes.length
        ? barRecipes.map((r: any) =>
            `- id:${r.id} "${r.name}" [${Array.isArray(r.tags) ? r.tags.join(", ") : ""}] ingredients: ${r.ingredientsSummary || ""}` +
            (Array.isArray(r.missing) && r.missing.length ? ` — MISSING: ${r.missing.join(", ")}` : ` — fully in stock`)
          ).join("\n")
        : "(the user has no saved bar recipes yet)";

      const userText = [
        dishContext,
        "",
        `BAR INVENTORY — what the user has in stock right now (soda water, bitters, and citrus are ALSO always on hand and need not be listed):`,
        hasInventory ? barInventory.join(", ") : "(the user hasn't recorded a bar inventory)",
        "",
        `The user's own saved bar recipes (candidates you may point any option at):`,
        candidatesText,
        "",
        dietLines,
        "",
        hasInventory
          ? `Call propose_pairings with exactly 3 options: first one basis:"bar" makeable from the inventory above, then two basis:"meal" best-flavor pairings.`
          : `Call propose_pairings with 2-3 distinct basis:"meal" cocktail pairing options.`
      ].join("\n");

      const { input, error } = await runTool(buildCocktailOptionsPrompt(hasInventory), "propose_pairings", PAIR_OPTIONS_SCHEMA, userText);
      if (error) return json({ error });
      const options = Array.isArray(input?.options)
        ? input.options
            .filter((o: { title?: string; blurb?: string }) => o?.title && o?.blurb)
            .map((o: { basis?: string }) => ({ ...o, basis: o.basis === "bar" ? "bar" : "meal" }))
            .slice(0, 3)
        : [];
      if (options.length === 0) return json({ error: "Couldn’t come up with cocktail pairings for that dish — try again." });
      return json({ options });
    }

    // ---- Wine or beer: single call, 2-3 style options (capped) ----
    const { data: usageResult, error: usageError } = await supabaseClient
      .rpc("increment_pairing_usage", { daily_limit: DAILY_PAIRING_LIMIT });
    if (!usageError && usageResult === -1) {
      return json({ error: `You’ve used today’s ${DAILY_PAIRING_LIMIT} AI pairings — it resets at midnight UTC. Try again tomorrow.` });
    }
    if (usageError) console.error("pairing_usage check failed:", usageError);

    const userText = [
      dishContext,
      "",
      `Call propose_drink_styles with 2-3 distinct ${kind} pairing options for this dish.`
    ].join("\n");

    const { input, error } = await runTool(buildStylePrompt(kind), "propose_drink_styles", STYLE_PAIR_SCHEMA, userText);
    if (error) return json({ error });
    const options = Array.isArray(input?.options)
      ? input.options.filter((o: { recommendation?: string; blurb?: string }) => o?.recommendation && o?.blurb).slice(0, 3)
      : [];
    if (options.length === 0) return json({ error: "Couldn’t come up with pairings for that dish — try again." });
    return json({ options });
  } catch (err) {
    console.error("pair-drink error:", err);
    return json({ error: "Something went wrong. Please try again." });
  }
});

// Always responds 200 so the browser's functions.invoke() reads the body either way.
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "content-type": "application/json" }
  });
}
