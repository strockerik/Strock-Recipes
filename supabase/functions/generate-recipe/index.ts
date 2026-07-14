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
// Two-step flow, selected by `mode`:
//   mode: "concepts" -> return 3 short recipe ideas to choose from (NOT capped)
//   mode: "full"     -> develop the chosen concept into a full recipe (capped)
//
// Request body (JSON):
//   {
//     mode: "concepts" | "full",        // defaults to "full"
//     ingredients: string[],            // main ingredients on hand (>= 1)
//     section: "kitchen" | "bar",       // recipe vs cocktail
//     chips: { groceryRun?, time?, servings?, cuisine?, equipment? },  // optional
//     dietPrefs: { diets: string[], allergies: string[], avoid: string[] },
//     concept: { title, blurb }         // required when mode === "full"
//   }
//
// Response: always HTTP 200 — { concepts: [...] } | { recipe: {...} } | { error }.

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
    notes: { type: ["string", "null"], description: "Tips and variations. If any ingredient beyond what the user listed (plus assumed staples) was added, the note MUST start with a line reading exactly 'Buy: ' followed by a comma-separated list of just those items — see the grocery-run rules in the system prompt. Or null if nothing to buy and no tips." }
  },
  required: ["name", "subtitle", "source", "section", "tags", "base_servings", "servings_label", "ingredients", "method", "notes"]
};

const SYSTEM_PROMPT = `You are a home-cooking recipe developer. From a short list of ingredients the user has on hand, you invent ONE complete, realistic, coherent recipe and return it by calling the save_recipe tool. Produce exactly one recipe — never ask follow-up questions, never return prose.

SEASONING — the user gives you MAIN ingredients only; they do NOT list seasonings.
Season the dish properly on your own: reach for common spices, dried herbs, and
aromatics that fit the cuisine (see CUISINE FLAVOR BASES) without being asked.
These common seasonings never count as "Buy:" items — only genuinely specialty
Tier-3 items do.

PANTRY MODEL — assume a normal kitchen, don't over-shop:
- Tier 1 (assume freely, no need to flag): salt, black pepper, water, a neutral cooking oil, and — for baking context only — basic amounts of flour/sugar.
- Tier 2 (use if a normal cook plausibly has it; it's fine to include): olive oil, butter, eggs, milk, garlic, onion, common dried spices (cumin, paprika, chili powder, oregano, basil, garlic/onion powder), soy sauce, vinegar, stock, canned tomatoes, rice, pasta, sugar, honey, cornstarch.
- Tier 3 (specialty/perishable — proteins beyond what's listed, fresh herbs, specialty cheeses, fish sauce/miso/gochujang, wine, buttermilk, heavy cream, nuts, specific fresh produce not listed): governed by the user's grocery-run choice in the request. This is a HARD LIMIT — count your Tier-3 additions before answering:
  - "Grocery run: NONE" — zero Tier-3 additions, no exceptions. If the dish would otherwise be incomplete, substitute from Tier 1/2 or the user's listed ingredients, or make a simpler version instead. Never add a Tier-3 item just because it would improve the dish.
  - "Grocery run: OK" — up to about 4 Tier-3 items are fine if they meaningfully improve the dish.
  - Not specified — be conservative: at most 1 Tier-3 item, and only if the dish genuinely needs it.
  - Any time you add so much as one Tier-3 item, 'notes' MUST begin with a line reading exactly "Buy: " followed by that item (or comma-separated items) — never bury a shopping need in prose the user might skim past.

QUANTITIES — ground every amount in standard culinary ratios, never guess:
- Vinaigrette 3:1 oil:acid. Pasta ~1 lb : 6 qt salted water; tomato sauce ~1.5 cups per lb dry pasta, cream/oil sauce ~1 cup per lb; finish pasta in the sauce with a splash of pasta water.
- Rice pilaf 2:1 liquid:rice. Braise: liquid covers meat ~1/3-2/3; stew: liquid covers fully; cook to fork-tender. Puréed veg soup ~3:1 liquid:solid.
- Cocktails: a sour is ~2:1:1 spirit:sweet:sour (e.g. 2 oz : 0.75 oz : 0.75 oz); stirred/spirit-forward is roughly equal-to-2:1 parts; a highball is ~1 part spirit : 3 parts mixer. Express bar amounts in oz.
- Season in stages, build an aromatic base, balance fat and acid, and finish with something bright. These technique cues are what make a recipe feel tested — include them in the steps.

CUISINE FLAVOR BASES — when a cuisine/style lean is specified, ground the dish in its real flavor grammar (don't just put the word in the title):
- italian: garlic, basil, oregano, tomato, olive oil, Parmesan, crushed red pepper
- mexican: cumin, chili powder or dried chiles, lime, cilantro, garlic, onion
- american: butter, black pepper, thyme, Worcestershire, garlic/onion powder
- asian: soy sauce, ginger, garlic, sesame oil, scallion, rice vinegar
- mediterranean: olive oil, lemon, oregano, garlic, feta, fresh herbs
- french: butter, shallot, dry white wine or stock, Dijon mustard, tarragon or thyme, cream
If no cuisine is specified, let the listed ingredients suggest a coherent direction rather than defaulting to generic "American."

COHERENCE & SAFETY:
- Keep the dish internally consistent — a title, ingredients, and method that genuinely belong to the SAME dish. No stitched-together "Frankenstein" combinations.
- Realistic timing: match stated times to the technique (caramelizing onions ~30-40 min, not 5). Give doneness by sensory cue AND safe temperature where relevant (poultry 165°F, fish 145°F).
- ALLERGIES ARE ABSOLUTE. If the user lists allergies, NEVER include those ingredients or anything containing them, in any amount, including garnish, stock, or substitutions. This overrides everything else. Honor diet constraints (e.g. vegetarian/vegan/gluten-free) fully; treat "dislikes" as strong preferences to avoid when possible.

OUTPUT:
- section must match what was requested (bar → a cocktail with bar tags and oz amounts; kitchen → a dish).
- source is "AI generated". Pick 0-3 tags from the allowed list only. Give concrete amounts and a sensible base_servings/servings_label.
- If the listed ingredients genuinely can't form a coherent dish, make the closest sensible recipe and explain the assumptions in 'notes' (after any required "Buy: " line) — do not invent an implausible dish.`;

// Lightweight schema for the "pick an option" step — just enough to show a card.
const CONCEPTS_SCHEMA = {
  type: "object",
  properties: {
    concepts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short dish/cocktail name, head-noun-first (e.g. 'Chicken Thighs - Skillet Lemon')" },
          blurb: { type: "string", description: "One appetizing sentence describing the idea and what makes it different from the others" }
        },
        required: ["title", "blurb"]
      }
    }
  },
  required: ["concepts"]
};

const CONCEPTS_PROMPT = `You help a home cook decide what to make. From their main ingredients you propose exactly THREE distinct ideas by calling the propose_recipes tool — nothing else, no prose.

Make the three genuinely different from each other: vary the technique and/or cuisine (e.g. a quick skillet, a roast/braise, a soup or salad; or Italian vs Mexican vs Asian) so the choice is meaningful — not three variations of the same dish.

Respect the request:
- Honor the grocery-run limit exactly (NONE = ideas buildable from the listed ingredients + common staples/seasonings only; OK = a few specialty items allowed).
- Honor any cuisine/style, time, and equipment preference.
- Honor dietary constraints, and treat allergies as absolute — never propose an idea that requires an allergen.
- The user lists MAIN ingredients only; assume they have common seasonings and staples.

Each concept is just a title + one appetizing one-line blurb. Do NOT write ingredients or steps here — that comes after they pick one.`;

function listOrNone(arr: unknown): string {
  return Array.isArray(arr) && arr.length ? arr.join(", ") : "none";
}

// The shared constraint block (grocery-run, cuisine, time, servings, equipment,
// diet) used by both the concepts step and the full-recipe step.
function buildConstraintLines(
  section: string,
  chips: Record<string, unknown>,
  diets: unknown[],
  allergies: unknown[],
  avoid: unknown[]
): string[] {
  const lines: string[] = [];
  if (chips.groceryRun === "none") lines.push(`Grocery run: NONE — use ONLY the listed ingredients plus Tier 1/2 staples and common seasonings.`);
  else if (chips.groceryRun === "quick") lines.push(`Grocery run: OK — a few extra specialty items are fine if they meaningfully improve the dish.`);
  if (chips.cuisine) lines.push(section === "bar" ? `Style lean: ${chips.cuisine}.` : `Cuisine lean: ${chips.cuisine}.`);
  if (chips.time === "quick") lines.push(`Keep it quick — about 30 minutes, weeknight-friendly.`);
  if (chips.time === "involved") lines.push(`A more involved, worth-the-effort dish is welcome.`);
  if (chips.servings) lines.push(`Make it for ${Number(chips.servings)} ${section === "bar" ? "drinks" : "servings"} (set base_servings accordingly).`);
  if (chips.equipment) lines.push(`Preferred method/equipment: ${chips.equipment}.`);
  lines.push("");
  lines.push(`Dietary constraints:`);
  lines.push(`- Diets that MUST be satisfied: ${listOrNone(diets)}`);
  lines.push(`- ALLERGIES — never include, in any form, including garnish or substitutions: ${listOrNone(allergies)}`);
  lines.push(`- Dislikes to avoid when possible: ${listOrNone(avoid)}`);
  return lines;
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

// One forced-tool Anthropic call. Returns the tool_use input, or a friendly
// { error } string on any API/shape failure (both steps share this).
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
    return { error: res.status === 429 ? "Rate limit or usage limit reached — try again later." : "AI generation failed. Please try again." };
  }
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    console.error("generate-recipe: response truncated at max_tokens");
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
    const mode = body.mode === "concepts" ? "concepts" : "full";
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
    const ingList = ingredients.map((i: string) => `- ${i}`).join("\n");
    const constraints = buildConstraintLines(section, chips, diets, allergies, avoid);

    // ---- Step 1: propose 3 concepts (NOT counted against the daily cap) ----
    if (mode === "concepts") {
      const conceptText = [
        section === "bar"
          ? `Propose 3 distinct cocktail ideas from these on-hand ingredients:`
          : `Propose 3 distinct recipe ideas from these main ingredients:`,
        ingList,
        "",
        ...constraints,
        "",
        `Call propose_recipes with exactly 3 ideas.`
      ].join("\n");
      const { input, error } = await runTool(CONCEPTS_PROMPT, "propose_recipes", CONCEPTS_SCHEMA, conceptText);
      if (error) return json({ error });
      const concepts = Array.isArray(input?.concepts)
        ? input.concepts.filter((c: { title?: string; blurb?: string }) => c?.title && c?.blurb).slice(0, 3)
        : [];
      if (concepts.length === 0) return json({ error: "Couldn’t come up with ideas from those — try different or a couple more ingredients." });
      return json({ concepts });
    }

    // ---- Step 2: develop the chosen concept into a full recipe (capped) ----
    const concept = body.concept && typeof body.concept === "object" ? body.concept : null;

    // Enforce the per-user daily cap right before the paid call. Fails open.
    const { data: usageResult, error: usageError } = await supabaseClient
      .rpc("increment_generation_usage", { daily_limit: DAILY_GENERATION_LIMIT });
    if (!usageError && usageResult === -1) {
      return json({ error: `You’ve used today’s ${DAILY_GENERATION_LIMIT} AI recipe generations — it resets at midnight UTC. Try again tomorrow.` });
    }
    if (usageError) console.error("generation_usage check failed:", usageError);

    const fullText = [
      section === "bar"
        ? `Invent ONE cocktail (bar recipe) using these on-hand ingredients:`
        : `Invent ONE kitchen recipe using these main ingredients:`,
      ingList,
      "",
      ...(concept?.title
        ? [`The user picked this idea — develop it into the full recipe: "${String(concept.title)}"${concept.blurb ? ` — ${String(concept.blurb)}` : ""}.`, ""]
        : []),
      ...constraints,
      "",
      `Call save_recipe once with the finished recipe.`
    ].join("\n");

    const { input: recipe, error: fullError } = await runTool(SYSTEM_PROMPT, "save_recipe", RECIPE_SCHEMA, fullText);
    if (fullError) return json({ error: fullError });

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
