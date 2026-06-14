// Supabase Edge Function: extract-recipe
//
// Accepts a photo (base64) or pasted text, sends it to Claude Haiku 4.5, and
// returns a recipe object shaped to match the `recipes` table. Structured
// output is produced via tool-use with a forced tool_choice (reliable and
// widely supported) rather than the newer structured-outputs API.
//
// The Anthropic API key is read from a server-side secret and never reaches the
// browser. The caller's Supabase JWT is verified before any paid API call.
//
// Request body (JSON):
//   { type: "image", images: [{ mediaType: "image/jpeg" | "image/png" | "image/webp", data: "<base64>" }, ...] }
//   { type: "text", text: "<pasted recipe text>" }
//   { type: "url", url: "<public recipe page>" }
//
// Multiple images are treated as different pages or sides of the SAME recipe
// (e.g. the front and back of a card) and combined into one result.
//
// Response: always HTTP 200 with either { recipe: {...} } or { error: "..." },
// so the browser's functions.invoke() can read our message directly.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Text and URL extraction is easy — Haiku handles it cheaply (~half a cent).
// Photos, especially messy handwritten recipe cards, need the stronger vision
// model to read reliably; the extra cost (~1-2 cents) is worth it there.
const MODEL_TEXT = "claude-haiku-4-5-20251001";
const MODEL_VISION = "claude-sonnet-4-6";
function pickModel(type: string) {
  return type === "image" ? MODEL_VISION : MODEL_TEXT;
}
const ANTHROPIC_VERSION = "2023-06-01";
// Front/back of a card, or a few pages — all treated as one recipe, not a batch.
const MAX_IMAGES = 4;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Curated tag taxonomy. Kitchen recipes pick from cuisine/protein/dish (one
// per category that applies); bar recipes pick from spirit/style. 0-3 tags
// total, only what genuinely applies — never invent a tag outside this list.
const KITCHEN_CUISINE_TAGS = ["italian", "american", "mexican", "mediterranean", "british", "finnish", "asian", "french"];
const KITCHEN_PROTEIN_TAGS = ["chicken", "beef", "pork", "seafood", "vegetarian", "vegan"];
const KITCHEN_DISH_TAGS = ["pizza", "pasta", "burger", "taco", "casserole", "soup", "salad", "sandwich", "bread", "breakfast", "dessert", "main-dish", "side-dish", "sauce"];
const BAR_SPIRIT_TAGS = ["rum", "gin", "whiskey", "tequila", "vodka", "brandy", "amaro", "non-alcoholic"];
const BAR_STYLE_TAGS = ["sour", "collins", "highball", "tiki", "frozen", "stirred", "classic", "low-abv"];
const ALL_TAGS = [
  ...KITCHEN_CUISINE_TAGS, ...KITCHEN_PROTEIN_TAGS, ...KITCHEN_DISH_TAGS,
  ...BAR_SPIRIT_TAGS, ...BAR_STYLE_TAGS
];

// JSON schema for the recipe, used as the tool's input_schema.
const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Recipe title" },
    subtitle: { type: ["string", "null"], description: "Short tagline or description, or null" },
    source: { type: ["string", "null"], description: "Where the recipe came from (book, site, person), or null" },
    section: { type: "string", enum: ["kitchen", "bar"], description: "'bar' for cocktails/drinks, 'kitchen' for everything else" },
    tags: {
      type: "array",
      items: { type: "string", enum: ALL_TAGS },
      maxItems: 3,
      description: "0-3 tags from this fixed list ONLY, whichever genuinely apply: for a kitchen recipe, at most one cuisine tag, one protein/diet tag, and one dish-type tag; for a bar recipe, at most one spirit tag and one style tag. Omit any category that doesn't clearly fit — never invent a tag outside this list."
    },
    base_servings: { type: "integer", description: "The number of servings/portions the ingredient amounts are written for" },
    servings_label: { type: "string", description: "Unit for servings, e.g. 'servings', 'pizzas', 'glasses', 'loaves'" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          amount: { type: ["number", "null"], description: "Numeric quantity, fractions as decimals (1/2 -> 0.5). Null if not a measured amount (e.g. 'to taste')." },
          unit: { type: ["string", "null"], description: "Unit of measure (g, cup, tbsp, etc.), or null if countable / no unit" },
          item: { type: "string", description: "The ingredient's common name in full, consistent words (no abbreviations or brand names), followed by any prep notes" },
          group: { type: ["string", "null"], description: "Short Title-Case label of the sub-recipe / component this belongs to (e.g. 'Dough', 'Sauce', 'Syrup'), or null if the recipe is one straightforward preparation. See SUB-RECIPES." }
        },
        required: ["amount", "unit", "item", "group"]
      }
    },
    method: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "One method/instruction step, a complete sentence or short paragraph" },
          group: { type: ["string", "null"], description: "Same sub-recipe label as the matching ingredients (e.g. 'Dough'), or null. See SUB-RECIPES." }
        },
        required: ["text", "group"]
      },
      description: "Ordered list of method/instruction steps"
    },
    notes: { type: ["string", "null"], description: "Any additional notes, tips, or variations, or null" }
  },
  required: ["name", "subtitle", "source", "section", "tags", "base_servings", "servings_label", "ingredients", "method", "notes"]
};

const SYSTEM_PROMPT = `You extract recipes into a structured format by calling the save_recipe tool. The source may be a clean printed recipe, a sloppy handwritten card, a screenshot of a text message, or a casual narrative. Your goal is always a complete, cookable recipe.

READING THE SOURCE
- You may receive multiple images. Treat them as different pages or sides of ONE recipe (e.g. the front and back of a card, or consecutive pages of a cookbook) — read them together as a single continuous source and call save_recipe exactly ONCE with one combined recipe, never one call per image. A back-of-card image often holds the method while the front holds ingredients (or vice versa); merge them in the right order. If the images clearly show more than one distinct, unrelated recipe, extract only the most complete one and ignore the rest — never output more than one recipe.
- Read handwriting carefully, including messy cursive, and transcribe what is ACTUALLY written. Scan the entire image — including the bottom edge, margins, and cramped corners — for amounts, oven temperatures, and especially bake times, which are often squeezed in at the very end of a card.
- Transcribe faithfully; do NOT "correct" the card to match a recipe you already know. If you recognize the dish, you must still use the card's own ingredients and amounts: never drop an ingredient that is written (e.g. flour in a pancake batter), and never add an ingredient the card lacks just because the dish usually has it (e.g. baking powder). Cooking knowledge is only for resolving a genuinely illegible word to its most plausible reading — not for substituting your own version of the recipe.
- Copy amounts exactly as written, including the unit: "3 tsp" is 3 teaspoons, not 3 tablespoons; "1/4 to 1/3 stick" stays in that range, not rounded up to 1/2.
- Ignore anything that is not part of the recipe: card labels ("Recipe for", "From the kitchen of"), people's names and attributions ("one of Bets' favorite recipes"), decorative or religious captions ("Give us this day our daily bread…"), illustrations and clip-art, copyright or publisher lines (e.g. "© 1984 Michael Hague"), card/page numbers and product codes, and — in screenshots — phone UI such as the status bar, clock, contact name, and messaging-app chrome.
- Keep genuine cooking annotations (e.g. a scribbled "add cheese!") as a note or ingredient, not noise.

FILLING GAPS — this is wanted, do not refuse
- If the method is cut off or missing, complete it with the standard steps for this dish so it can be cooked start to finish.
- If ingredients are listed with no amounts (common on cocktail cards and casual notes), supply sensible amounts for one standard batch (or one drink for a single cocktail).
- If a narrative describes the process loosely, rewrite it as clean ordered steps and a proper ingredient list, normalizing vague amounts ("about 2 tbsp" -> 2 tbsp, "a couple cloves" -> 2).
- Whenever you infer, complete, or guess anything that was NOT clearly in the source — a missing step, an estimated amount, an added ingredient — add ONE short line at the very end of \`notes\` beginning with "AI added: " naming each thing, so the cook knows to double-check (e.g. "AI added: estimated cocktail proportions and the final baking step."). Never introduce an ingredient or amount the source didn't clearly have without flagging it here; if you are unsure whether something was on the card, leave it out rather than slip it in silently.
- Invent only what's needed to make the recipe complete. Do not fabricate a specific source, author, or backstory — leave source null if unknown.

FORMATTING
- Split amount, unit, and item: "2 cups flour" -> amount 2, unit "cups", item "flour".
- Item names: write the ingredient's common name in full words, not the card's shorthand — expand abbreviations ("grnd beef" -> "ground beef", "GR PEPPER" -> "green pepper"), drop brand names (use "ketchup" not "Heinz ketchup"), and use the same name every time the same ingredient appears (don't call it "cheddar" in one recipe and "shredded cheese" in another unless the card is genuinely specific). Prep notes ("diced", "room temperature", "for garnish") stay, after the ingredient name. This is spelling/phrasing normalization only — never change what the ingredient actually is.
- Normalize fractions and ranges to decimals ("1/2" -> 0.5, "1-2 tsp" -> 1.5). Keep oven temperatures (e.g. "415°") in the relevant method step, never as an ingredient.
- If an ingredient has no measurable amount even after inference (e.g. "salt to taste"), set amount and unit to null and put the full description in item.
- Preserve the given order of steps; slot any completed steps into their natural position.
- section: "bar" only for a cocktail or mixed drink, otherwise "kitchen".
- base_servings: the number the amounts are written for (default 4 for food, 1 for a single cocktail). servings_label: the unit, e.g. "servings", "pizzas", "glasses", "loaves".
- tags: 0-3 tags, ONLY from the fixed list in the schema. For kitchen: at most one cuisine (${KITCHEN_CUISINE_TAGS.join(", ")}), one protein/diet (${KITCHEN_PROTEIN_TAGS.join(", ")}), and one dish type (${KITCHEN_DISH_TAGS.join(", ")}). For bar: at most one spirit (${BAR_SPIRIT_TAGS.join(", ")}) and one style (${BAR_STYLE_TAGS.join(", ")}). Skip any category that doesn't clearly apply — do not force a tag, and never use a word outside these lists.

SUB-RECIPES (sections)
- If the recipe is made of distinct components prepared separately — e.g. a dough and a sauce, a cake and a frosting, a cocktail and its own syrup or infusion — label every ingredient AND every step of each component with a short Title-Case \`group\` (e.g. "Dough", "Sauce", "Syrup"). Use the EXACT same label across an ingredient and the steps that make it, so they line up.
- Keep each component's ingredients together and its steps together, in the order you'd make them. A final "assemble/bake/build" stage that combines the components can be its own group (e.g. "Assembly", "Bake") or null.
- If the recipe is a single straightforward preparation with no separable sub-recipe, set \`group\` to null on every ingredient and step — do NOT invent sections.`;

// ---------- URL import helpers ----------

const MAX_PAGE_CHARS = 50_000; // keep model input (and cost) bounded

// Only plain public http(s) URLs; refuse localhost / private-network targets so
// the function can't be used to probe internal addresses.
function parseAllowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    // Prepend https:// only when there's no scheme at all — a foreign scheme
    // (ftp:, file:, …) must reach the protocol check below and be rejected,
    // not get wrapped into a parseable https URL.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes("[")) return null;
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return null;
    }
  }
  return url;
}

// Recipe sites almost always embed schema.org/Recipe JSON-LD; when present it
// is far cleaner model input than the page text.
function findJsonLdRecipe(html: string): unknown {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const recipe = findRecipeNode(JSON.parse(m[1].trim()));
      if (recipe) return recipe;
    } catch {
      // malformed JSON-LD block — keep looking
    }
  }
  return null;
}

function findRecipeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRecipeNode(child);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
    if (types.some((t) => typeof t === "string" && t.toLowerCase() === "recipe")) return node;
    if (obj["@graph"]) return findRecipeNode(obj["@graph"]);
  }
  return null;
}

// Crude but dependency-free HTML → text, for pages without Recipe JSON-LD.
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe|header|footer|nav)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return json({ error: "Server isn’t configured for AI extraction yet (missing API key)." });
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
    let userContent;

    if (body.type === "image") {
      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length === 0) return json({ error: "No image was received." });
      if (images.length > MAX_IMAGES) return json({ error: `Please send at most ${MAX_IMAGES} photos at a time.` });
      for (const img of images) {
        if (!img?.data || !img?.mediaType) return json({ error: "No image was received." });
      }
      const instruction = images.length > 1
        ? "These images are different pages or sides (e.g. the front and back of a card) of the SAME recipe. Read them together as one source and call save_recipe once with the single combined recipe."
        : "Extract the recipe from this image by calling save_recipe.";
      userContent = [
        ...images.map((img: { mediaType: string; data: string }) => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data }
        })),
        { type: "text", text: instruction }
      ];
    } else if (body.type === "text") {
      if (!body.text || !body.text.trim()) return json({ error: "No text was received." });
      userContent = [
        { type: "text", text: `Extract the recipe from the following text by calling save_recipe:\n\n${body.text}` }
      ];
    } else if (body.type === "url") {
      const url = typeof body.url === "string" ? parseAllowedUrl(body.url.trim()) : null;
      if (!url) return json({ error: "That doesn’t look like a valid link." });
      let html: string;
      try {
        const pageRes = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
          headers: {
            // A browser-ish UA — many recipe sites refuse obvious bots outright.
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml"
          }
        });
        if (!pageRes.ok) throw new Error(`status ${pageRes.status}`);
        html = await pageRes.text();
      } catch (fetchErr) {
        console.error("URL fetch failed:", url.href, fetchErr);
        return json({ error: "Couldn’t load that page — the site may block robots. Copy the recipe text and paste it instead." });
      }
      const jsonLd = findJsonLdRecipe(html);
      const content = (jsonLd ? JSON.stringify(jsonLd) : htmlToText(html)).slice(0, MAX_PAGE_CHARS);
      if (content.length < 80) {
        return json({ error: "Couldn’t find readable recipe text on that page — paste the text instead." });
      }
      userContent = [
        {
          type: "text",
          text: `Extract the recipe from this content from ${url.hostname} by calling save_recipe. If the content names no clearer attribution, use "${url.hostname}" as the source.\n\n${content}`
        }
      ];
    } else {
      return json({ error: "Invalid request." });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: pickModel(body.type),
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [{ name: "save_recipe", description: "Save the extracted recipe.", input_schema: RECIPE_SCHEMA }],
        tool_choice: { type: "tool", name: "save_recipe" },
        messages: [{ role: "user", content: userContent }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      const friendly = anthropicRes.status === 429
        ? "Rate limit or usage limit reached — try again later."
        : "AI extraction failed. Please try again.";
      return json({ error: friendly });
    }

    const anthropicData = await anthropicRes.json();
    const toolBlock = anthropicData.content?.find((c: { type: string }) => c.type === "tool_use");
    const recipe = toolBlock?.input;

    if (!recipe || !recipe.name || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      return json({ error: "AI couldn’t find a recipe in that input. Try a clearer photo or paste the text." });
    }

    return json({ recipe });
  } catch (err) {
    console.error("extract-recipe error:", err);
    return json({ error: "Something went wrong. Please try again." });
  }
});

// Always responds 200 so the browser's functions.invoke() reads { recipe } or { error }.
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "content-type": "application/json" }
  });
}
