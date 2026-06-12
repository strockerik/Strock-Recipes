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
//   { type: "image", mediaType: "image/jpeg" | "image/png" | "image/webp", data: "<base64>" }
//   { type: "text", text: "<pasted recipe text>" }
//   { type: "url", url: "<public recipe page>" }
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

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
      items: { type: "string" },
      description: "3-6 lowercase, hyphenated tags describing cuisine, course, diet, method, etc."
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

const SYSTEM_PROMPT = `You extract recipes into a structured format by calling the save_recipe tool. The source may be a clean printed recipe, a sloppy handwritten card, a screenshot of a text message, or a casual narrative. Your goal is always a complete, cookable recipe.

READING THE SOURCE
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
- Normalize fractions and ranges to decimals ("1/2" -> 0.5, "1-2 tsp" -> 1.5). Keep oven temperatures (e.g. "415°") in the relevant method step, never as an ingredient.
- If an ingredient has no measurable amount even after inference (e.g. "salt to taste"), set amount and unit to null and put the full description in item.
- Preserve the given order of steps; slot any completed steps into their natural position.
- section: "bar" only for a cocktail or mixed drink, otherwise "kitchen".
- base_servings: the number the amounts are written for (default 4 for food, 1 for a single cocktail). servings_label: the unit, e.g. "servings", "pizzas", "glasses", "loaves".
- tags: 3-6 lowercase, hyphenated (cuisine, course, diet, method, etc.).`;

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
      if (!body.data || !body.mediaType) return json({ error: "No image was received." });
      userContent = [
        { type: "image", source: { type: "base64", media_type: body.mediaType, data: body.data } },
        { type: "text", text: "Extract the recipe from this image by calling save_recipe." }
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
