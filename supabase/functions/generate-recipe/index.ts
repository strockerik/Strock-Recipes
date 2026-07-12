// Supabase Edge Function: generate-recipe
//
// Invents ONE complete recipe from a list of ingredients the user has on hand
// (plus assumed pantry staples), honoring stored dietary preferences and hard
// allergen exclusions. Structured output via tool-use with a forced tool_choice,
// reusing the exact same save_recipe schema as extract-recipe so the browser can
// funnel the result straight into fillRecipeFormFromExtraction().
//
// The Anthropic API key is a server-side secret and never reaches the browser.
// The caller's Supabase JWT is verified before any paid API call.
//
// Request body (JSON):
//   {
//     ingredients: string[],            // what the user has on hand (>= 1)
//     section: "kitchen" | "bar",       // recipe vs cocktail
//     chips: { time?, servings?, cuisine?, equipment? },   // all optional
//     dietPrefs: { diets: string[], allergies: string[], avoid: string[] }
//   }
//
// Response: always HTTP 200 with either { recipe: {...} } or { error: "..." }.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Generation from a text ingredient list is cheap — Haiku handles it well. Flip
// this one const to Sonnet if quality testing shows incoherent "Frankenstein" output.
const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
// Soft per-user cap on paid Anthropic calls, enforced via increment_generation_usage().
const DAILY_GENERATION_LIMIT = 20;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Curated tag taxonomy — KEEP IN SYNC with extract-recipe/index.ts,
// recipe-coach/index.ts, and the index.html tag checkboxes (4th copy).
const KITCHEN_CUISINE_TAGS = ["italian", "american", "mexican", "mediterranean", "british", "finnish", "asian", "french"];
const KITCHEN_PROTEIN_TAGS = ["chicken", "beef", "pork", "seafood", "vegetarian", "vegan"];
const KITCHEN_DISH_TAGS = ["pizza", "pasta", "burger", "taco", "casserole", "soup", "salad", "sandwich", "bread", "breakfast", "dessert", "main-dish", "side-dish", "sauce"];
const BAR_SPIRIT_TAGS = ["rum", "gin", "whiskey", "tequila", "vodka", "brandy", "amaro", "non-alcoholic"];
const BAR_STYLE_TAGS = ["sour", "collins", "highball", "tiki", "frozen", "stirred", "classic", "low-abv"];
const ALL_TAGS = [
  ...KITCHEN_CUISINE_TAGS, ...KITCHEN_PROTEIN_TAGS, ...KITCHEN_DISH_TAGS,
  ...BAR_SPIRIT_TAGS, ...BAR_STYLE_TAGS
];

// JSON schema for the recipe, used as the tool's input_schema — identical shape
// to extract-recipe so the frontend maps it with zero changes.
const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Recipe title, written head-noun-first for alphabetical findability: lead with the core dish or main ingredient, then any style/qualifier after ' - '. E.g. 'Pancakes - Ultra Fluffy'." },
    subtitle: { type: ["string", "null"], description: "Short appetizing one-line description, or null" },
    source: { type: ["string", "null"], description: "Set to 'AI generated' for generated recipes." },
    section: { type: "string", enum: ["kitchen", "bar"], description: "'bar' for cocktails/drinks, 'kitchen' for everything else" },
    tags: {
      type: "array",
      items: { type: "string", enum: ALL_TAGS },
      maxItems: 3,
      description: "0-3 tags from this fixed list ONLY, whichever genuinely apply: for a kitchen recipe, at most one cuisine tag, one protein/diet tag, and one dish-type tag; for a bar recipe, at most one spirit tag and one style tag. Never invent a tag outside this list."
    },
    base_servings: { type: "integer", description: "The number of servings/portions the ingredient amounts are written for" },
    servings_label: { type: "string", description: "Unit for servings, e.g. 'servings', 'pizzas', 'glasses', 'drinks'" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          amount: { type: ["number", "null"], description: "Numeric quantity, fractions as decimals (1/2 -> 0.5). Give a concrete number derived from standard culinary ratios. Use null only for a true season-to-taste item." },
          unit: { type: ["string", "null"], description: "Unit of measure (g, cup, tbsp, oz, etc.), or null if countable / no unit" },
          item: { type: "string", description: "The ingredient's common name in full, consistent words (no abbreviations or brand names), with NO prep instructions. Product forms that describe what to buy stay ('shredded mozzarella'); prep like 'diced', 'chopped' does NOT go here." },
          group: { type: ["string", "null"], description: "Short Title-Case label of the sub-recipe / component this belongs to (e.g. 'Sauce', 'Dough'), or null if the recipe is one straightforward preparation." }
        },
        required: ["amount", "unit", "item", "group"]
      }
    },
    method: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "One method step, a complete sentence or short paragraph, with technique and sensory/doneness cues" },
          group: { type: ["string", "null"], description: "Same sub-recipe label as the matching ingredients, or null." }
        },
        required: ["text", "group"]
      },
      description: "Ordered list of method/instruction steps"
    },
    notes: { type: ["string", "null"], description: "Tips, variations, and — importantly — any specialty items the user likely needs to BUY (not on-hand). Or null." }
  },
  required: ["name", "subtitle", "source", "section", "tags", "base_servings", "servings_label", "ingredients", "method", "notes"]
};

const SYSTEM_PROMPT = `You are a home-cooking recipe developer. From a short list of ingredients the user has on hand, you invent ONE complete, realistic, coherent recipe and return it by calling the save_recipe tool. Produce exactly one recipe — never ask follow-up questions, never return prose.

PANTRY MODEL — assume a normal kitchen, don't over-shop:
- Tier 1 (assume freely, no need to flag): salt, black pepper, water, a neutral cooking oil, and — for baking context only — basic amounts of flour/sugar.
- Tier 2 (use if a normal cook plausibly has it; it's fine to include): olive oil, butter, eggs, milk, garlic, onion, common dried spices (cumin, paprika, chili powder, oregano, basil, garlic/onion powder), soy sauce, vinegar, stock, canned tomatoes, rice, pasta, sugar, honey, cornstarch.
- Tier 3 (do NOT assume): specific proteins, fresh herbs, specialty cheeses, fish sauce/miso/gochujang, wine, buttermilk, heavy cream, nuts, specific produce. Build the recipe from the user's listed ingredients + Tier 1/2. Use AT MOST 1-2 Tier-3 items the user did NOT list, and only if the dish needs them — list those in 'notes' as "You'll need to buy: …".

QUANTITIES — ground every amount in standard culinary ratios, never guess:
- Vinaigrette 3:1 oil:acid. Pasta ~1 lb : 6 qt salted water; tomato sauce ~1.5 cups per lb dry pasta, cream/oil sauce ~1 cup per lb; finish pasta in the sauce with a splash of pasta water.
- Rice pilaf 2:1 liquid:rice. Braise: liquid covers meat ~1/3-2/3; stew: liquid covers fully; cook to fork-tender. Puréed veg soup ~3:1 liquid:solid.
- Cocktails: a sour is ~2:1:1 spirit:sweet:sour (e.g. 2 oz : 0.75 oz : 0.75 oz); stirred/spirit-forward is roughly equal-to-2:1 parts; a highball is ~1 part spirit : 3 parts mixer. Express bar amounts in oz.
- Season in stages, build an aromatic base, balance fat and acid, and finish with something bright. These technique cues are what make a recipe feel tested — include them in the steps.

COHERENCE & SAFETY:
- Keep the dish internally consistent — a title, ingredients, and method that genuinely belong to the SAME dish. No stitched-together "Frankenstein" combinations.
- Realistic timing: match stated times to the technique (caramelizing onions ~30-40 min, not 5). Give doneness by sensory cue AND safe temperature where relevant (poultry 165°F, fish 145°F).
- ALLERGIES ARE ABSOLUTE. If the user lists allergies, NEVER include those ingredients or anything containing them, in any amount, including garnish, stock, or substitutions. This overrides everything else. Honor diet constraints (e.g. vegetarian/vegan/gluten-free) fully; treat "dislikes" as strong preferences to avoid when possible.

OUTPUT:
- section must match what was requested (bar → a cocktail with bar tags and oz amounts; kitchen → a dish).
- source is "AI generated". Pick 0-3 tags from the allowed list only. Give concrete amounts and a sensible base_servings/servings_label. Put anything the user must buy in 'notes'.
- If the listed ingredients genuinely can't form a coherent dish, make the closest sensible recipe and explain the assumptions in 'notes' — do not invent an implausible dish.`;

function listOrNone(arr: unknown): string {
  return Array.isArray(arr) && arr.length ? arr.join(", ") : "none";
}

// Build a case-insensitive word-boundary matcher for each allergy term so the
// post-generation safety net catches "peanut" in "peanut butter" but not
// coincidental substrings.
function allergyHit(recipe: { name?: string; notes?: string; ingredients?: Array<{ item?: string }> }, allergies: string[]): string | null {
  const haystacks: string[] = [];
  if (recipe.name) haystacks.push(recipe.name);
  if (recipe.notes) haystacks.push(recipe.notes);
  (recipe.ingredients || []).forEach((ing) => { if (ing?.item) haystacks.push(ing.item); });
  const hay = haystacks.join(" \n ").toLowerCase();
  for (const raw of allergies) {
    const term = String(raw).trim().toLowerCase();
    if (!term) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(hay)) return term;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return json({ error: "Server isn’t configured for AI generation yet (missing API key)." });
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
    const ingredients = Array.isArray(body.ingredients)
      ? body.ingredients.map((s: unknown) => String(s).trim()).filter(Boolean)
      : [];
    if (ingredients.length === 0) return json({ error: "Add at least one ingredient to generate from." });

    const section = body.section === "bar" ? "bar" : "kitchen";
    const chips = body.chips && typeof body.chips === "object" ? body.chips : {};
    const dp = body.dietPrefs && typeof body.dietPrefs === "object" ? body.dietPrefs : {};
    const diets = Array.isArray(dp.diets) ? dp.diets : [];
    const allergies = Array.isArray(dp.allergies) ? dp.allergies : [];
    const avoid = Array.isArray(dp.avoid) ? dp.avoid : [];

    const reqLines: string[] = [];
    reqLines.push(section === "bar"
      ? `Invent ONE cocktail (bar recipe) using these on-hand ingredients:`
      : `Invent ONE kitchen recipe using these on-hand ingredients:`);
    reqLines.push(ingredients.map((i: string) => `- ${i}`).join("\n"));
    reqLines.push("");
    if (chips.cuisine) reqLines.push(section === "bar" ? `Style lean: ${chips.cuisine}.` : `Cuisine lean: ${chips.cuisine}.`);
    if (chips.time === "quick") reqLines.push(`Keep it quick — about 30 minutes, weeknight-friendly.`);
    if (chips.time === "involved") reqLines.push(`A more involved, worth-the-effort dish is welcome.`);
    if (chips.servings) reqLines.push(`Make it for ${Number(chips.servings)} ${section === "bar" ? "drinks" : "servings"} (set base_servings accordingly).`);
    if (chips.equipment) reqLines.push(`Preferred method/equipment: ${chips.equipment}.`);
    reqLines.push("");
    reqLines.push(`Dietary constraints:`);
    reqLines.push(`- Diets that MUST be satisfied: ${listOrNone(diets)}`);
    reqLines.push(`- ALLERGIES — never include, in any form, including garnish or substitutions: ${listOrNone(allergies)}`);
    reqLines.push(`- Dislikes to avoid when possible: ${listOrNone(avoid)}`);
    reqLines.push("");
    reqLines.push(`Call save_recipe once with the finished recipe.`);

    const userContent = [{ type: "text", text: reqLines.join("\n") }];

    // Enforce the per-user daily cap right before the paid call. Fails open.
    const { data: usageResult, error: usageError } = await supabaseClient
      .rpc("increment_generation_usage", { daily_limit: DAILY_GENERATION_LIMIT });
    if (!usageError && usageResult === -1) {
      return json({ error: `You’ve used today’s ${DAILY_GENERATION_LIMIT} AI recipe generations — it resets at midnight UTC. Try again tomorrow.` });
    }
    if (usageError) console.error("generation_usage check failed:", usageError);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: [{ name: "save_recipe", description: "Save the generated recipe.", input_schema: RECIPE_SCHEMA }],
        tool_choice: { type: "tool", name: "save_recipe" },
        messages: [{ role: "user", content: userContent }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      const friendly = anthropicRes.status === 429
        ? "Rate limit or usage limit reached — try again later."
        : "AI generation failed. Please try again.";
      return json({ error: friendly });
    }

    const anthropicData = await anthropicRes.json();
    const toolBlock = anthropicData.content?.find((c: { type: string }) => c.type === "tool_use");
    const recipe = toolBlock?.input;

    if (anthropicData.stop_reason === "max_tokens") {
      console.error("generate-recipe: response truncated at max_tokens");
      return json({ error: "That recipe came out too long — try again." });
    }

    if (!recipe || !recipe.name || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      return json({ error: "AI couldn’t make a recipe from those ingredients — try adding one or two more." });
    }

    // Safety net: even with the hard-lock prompt, never hand back a recipe that
    // names an allergen. Reject rather than surface something unsafe.
    const hit = allergyHit(recipe, allergies);
    if (hit) {
      console.error("generate-recipe: allergen safety net tripped on", hit);
      return json({ error: `That recipe included ${hit}, which is on your allergy list — please try generating again.` });
    }

    recipe.section = section; // trust the request over the model for the section split
    return json({ recipe });
  } catch (err) {
    console.error("generate-recipe error:", err);
    return json({ error: "Something went wrong. Please try again." });
  }
});

// Always responds 200 so the browser's functions.invoke() reads { recipe } or { error }.
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "content-type": "application/json" }
  });
}
