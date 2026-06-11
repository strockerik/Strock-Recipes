// Supabase Edge Function: extract-recipe
//
// Accepts a photo (base64) or pasted text, sends it to Claude Haiku 4.5 with a
// structured-output JSON schema, and returns a recipe object shaped to match
// the `recipes` table. The Anthropic API key is read from a server-side
// secret and never exposed to the browser.
//
// Request body (JSON):
//   { type: "image", mediaType: "image/jpeg" | "image/png" | "image/webp", data: "<base64>" }
//   { type: "text", text: "<pasted recipe text>" }
//
// Response body (JSON):
//   { recipe: { name, subtitle, source, section, tags, base_servings,
//                servings_label, ingredients, method, notes } }
//   or { error: "..." }

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Recipe title" },
    subtitle: { type: ["string", "null"], description: "Short tagline or description, or null" },
    source: { type: ["string", "null"], description: "Where the recipe came from (book, site, person), or null" },
    section: { type: "string", enum: ["kitchen", "bar"], description: "'bar' for cocktails/drinks, 'kitchen' for everything else" },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "3-6 lowercase, hyphenated tags describing cuisine, course, diet, method, etc."
    },
    base_servings: { type: "integer", description: "The number of servings/portions the ingredient amounts below are written for" },
    servings_label: { type: "string", description: "Unit for servings, e.g. 'servings', 'pizzas', 'glasses', 'loaves'" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          amount: { type: ["number", "null"], description: "Numeric quantity, with fractions converted to decimals (e.g. 1/2 -> 0.5). Null if not a measured amount (e.g. 'to taste')." },
          unit: { type: ["string", "null"], description: "Unit of measure (g, cup, tbsp, etc.), or null if the item is countable / has no unit" },
          item: { type: "string", description: "The ingredient name, including any prep notes" }
        },
        required: ["amount", "unit", "item"]
      }
    },
    method: {
      type: "array",
      items: { type: "string" },
      description: "Ordered list of method/instruction steps, each a complete sentence or short paragraph"
    },
    notes: { type: ["string", "null"], description: "Any additional notes, tips, or variations, or null" }
  },
  required: ["name", "subtitle", "source", "section", "tags", "base_servings", "servings_label", "ingredients", "method", "notes"]
};

const SYSTEM_PROMPT = `You extract recipes from photos or text into a structured format.

Rules:
- Output amounts as numbers, splitting unit from item (e.g. "2 cups flour" -> amount: 2, unit: "cups", item: "flour").
- Normalize fractions and ranges to decimals (e.g. "1/2" -> 0.5, "1-2 tsp" -> 1.5).
- If an ingredient has no measured amount (e.g. "salt to taste"), set amount and unit to null and put the full description in item.
- Preserve the order of method steps exactly as given.
- Use null for any field that isn't present in the source — never invent information.
- Infer 3-6 sensible lowercase, hyphenated tags (cuisine, course, diet, cooking method, etc.).
- Set section to "bar" only if this is clearly a cocktail or mixed drink; otherwise "kitchen".
- base_servings should be the number the ingredient list is written for (default to 4 if not specified for food, or 1 for a single cocktail).
- servings_label should describe the unit, e.g. "servings", "pizzas", "glasses", "loaves" — default to "servings".`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return jsonResponse({ error: "Server is not configured for AI extraction yet." }, 500);
    }

    // Verify the caller is a logged-in user.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Not authenticated." }, 401);
    }
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData?.user) {
      return jsonResponse({ error: "Not authenticated." }, 401);
    }

    const body = await req.json();
    let userContent;

    if (body.type === "image") {
      if (!body.data || !body.mediaType) {
        return jsonResponse({ error: "Missing image data." }, 400);
      }
      userContent = [
        {
          type: "image",
          source: { type: "base64", media_type: body.mediaType, data: body.data }
        },
        {
          type: "text",
          text: "Extract the recipe from this image into the given schema."
        }
      ];
    } else if (body.type === "text") {
      if (!body.text || !body.text.trim()) {
        return jsonResponse({ error: "Missing recipe text." }, 400);
      }
      userContent = [
        {
          type: "text",
          text: `Extract the recipe from the following text into the given schema:\n\n${body.text}`
        }
      ];
    } else {
      return jsonResponse({ error: "Invalid request type." }, 400);
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        output_config: {
          format: {
            type: "json_schema",
            schema: RECIPE_SCHEMA
          }
        }
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return jsonResponse({ error: "AI extraction failed. Please try again." }, 502);
    }

    const anthropicData = await anthropicRes.json();
    const textBlock = anthropicData.content?.find((c: { type: string }) => c.type === "text");
    if (!textBlock?.text) {
      return jsonResponse({ error: "AI returned an empty response." }, 502);
    }

    let recipe;
    try {
      recipe = JSON.parse(textBlock.text);
    } catch {
      return jsonResponse({ error: "AI returned an unreadable response." }, 502);
    }

    if (!recipe.name || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      return jsonResponse({ error: "AI couldn't find a recipe in that input." }, 422);
    }

    return jsonResponse({ recipe });
  } catch (err) {
    console.error("extract-recipe error:", err);
    return jsonResponse({ error: "Something went wrong." }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" }
  });
}
