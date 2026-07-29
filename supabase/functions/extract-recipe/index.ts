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
// Soft per-user cap on paid Anthropic calls, enforced via increment_extraction_usage().
const DAILY_EXTRACTION_LIMIT = 20;
function pickModel(type: string) {
  return type === "image" ? MODEL_VISION : MODEL_TEXT;
}
const ANTHROPIC_VERSION = "2023-06-01";
// Front/back of a card, or a few pages — all treated as one recipe, not a batch.
const MAX_IMAGES = 4;
// What Claude's vision API accepts. The browser always uploads JPEG, but this
// endpoint takes client input, so reject anything else before paying for a call.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// ---- Cheap-LLM tier (Groq) --------------------------------------------------
// Optional open-model tier for the mechanical text->JSON extraction paths (text
// and URL), behind a validate-and-escalate wrapper: try Groq first, and if its
// output is missing or fails schema validation, fall back to Claude. Image
// (vision) extraction and every other AI function stay on Claude. If
// GROQ_API_KEY is unset the tier is simply disabled and everything routes to
// Claude exactly as before — so deploying this code is a no-op until the secret
// is added. Groq is OpenAI-compatible with strict JSON-schema constrained
// decoding, which keeps an 8B model's structured output reliable.
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
// gpt-oss-20b is one of only two Groq models with strict json_schema constrained
// decoding (verified live 2026-07 — llama-3.1-8b-instant does NOT support it).
// maxTokens stays well under the free tier's 8000 tokens/min budget (Groq
// reserves max_tokens up front against TPM), and maxInputChars skips Groq for
// long pages/transcripts that wouldn't fit — those escalate straight to Claude.
const GROQ = {
  model: "openai/gpt-oss-20b",
  url: "https://api.groq.com/openai/v1/chat/completions",
  maxTokens: 4096,
  maxInputChars: 12_000
};
// When set (temporarily, for the old-vs-new equivalence comparison), a request
// may pin a provider via body.force_provider = "claude" | "groq", which bypasses
// escalation AND the daily cap and returns that provider's raw output. Leave it
// unset in normal production so this stays out of the user-facing path.
const ALLOW_PROVIDER_OVERRIDE = !!Deno.env.get("ALLOW_PROVIDER_OVERRIDE");

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
    name: { type: "string", description: "Recipe title, written head-noun-first for alphabetical findability: lead with the core dish or main ingredient, then any style/qualifier descriptors after ' - '. E.g. 'Ultra Fluffy Pancakes' -> 'Pancakes - Ultra Fluffy'. See the naming rule under FORMATTING." },
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
          amount: { type: ["number", "null"], description: "Numeric quantity, fractions as decimals (1/2 -> 0.5). Always give a concrete number — estimate vague measures (a knob of butter -> 2, a large handful -> 1). Use null only for a true season-to-taste item (e.g. salt to taste)." },
          unit: { type: ["string", "null"], description: "Unit of measure (g, cup, tbsp, etc.), or null if countable / no unit" },
          item: { type: "string", description: "The ingredient's common name in full, consistent words (no abbreviations or brand names), with NO prep instructions. Product forms that describe what to buy stay ('peeled tomatoes', 'shredded mozzarella'); prep like 'diced', 'chopped', 'minced', 'to taste' does NOT go here." },
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

// Groq's strict json_schema mode (OpenAI-compatible) requires every object to set
// additionalProperties:false and list all properties as required, and it ignores
// validation keywords like maxItems — so derive a strict-safe copy of
// RECIPE_SCHEMA rather than hand-maintaining a second schema. If Groq ever
// rejects a keyword, extend the skip list here; a rejected schema just makes the
// wrapper escalate to Claude, so it fails safe either way.
// deno-lint-ignore no-explicit-any
function strictify(node: any): any {
  if (Array.isArray(node)) return node.map(strictify);
  if (node && typeof node === "object") {
    // deno-lint-ignore no-explicit-any
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "maxItems" || k === "minItems") continue; // unsupported in strict mode
      out[k] = strictify(v);
    }
    if (out.type === "object" && out.properties) out.additionalProperties = false;
    return out;
  }
  return node;
}
const RECIPE_SCHEMA_STRICT = strictify(RECIPE_SCHEMA);

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
- If a narrative describes the process loosely, rewrite it as clean ordered steps and a proper ingredient list, normalizing vague amounts ("about 2 tbsp" -> 2 tbsp, "a couple cloves" -> 2, "a knob of butter" -> 2 tbsp, "a large handful" -> ~1 cup, "a splash" -> 1 tbsp).
- Whenever you infer, complete, or guess anything that was NOT clearly in the source — a missing step, an estimated amount, an added ingredient — add ONE short line at the very end of \`notes\` beginning with "AI added: " naming each thing, so the cook knows to double-check (e.g. "AI added: estimated cocktail proportions and the final baking step."). Never introduce an ingredient or amount the source didn't clearly have without flagging it here; if you are unsure whether something was on the card, leave it out rather than slip it in silently.
- Invent only what's needed to make the recipe complete. Do not fabricate a specific source, author, or backstory — leave source null if unknown.

FORMATTING
- name: write it HEAD-NOUN-FIRST so the alphabetical list sorts and scans well. Lead with the core dish or main ingredient — the word someone would actually look for — and move marketing / style / attribution words ("Ultra Fluffy", "Restaurant-Style", "The Best", "Easy", "Grandma's", "Famous") to AFTER a " - ". Examples: "Ultra Fluffy Pancakes" -> "Pancakes - Ultra Fluffy"; "Restaurant-Style Taco Beef" -> "Taco Beef - Restaurant-Style"; "Grandma's Apple Pie" -> "Apple Pie - Grandma's". BUT leave a title that already starts with its key word alone ("Chicken Tikka Masala", "Beef Bourguignon", "Banana Bread"), and never reorder an established proper cocktail name ("Negroni", "Aperol Spritz", "Piña Colada") — there the name itself IS the title. Keep it concise; don't invent flavour text.
- Split amount, unit, and item: "2 cups flour" -> amount 2, unit "cups", item "flour".
- Item names: write the ingredient's common name in full words, not the card's shorthand — expand abbreviations ("grnd beef" -> "ground beef", "GR PEPPER" -> "green pepper"), drop brand names (use "ketchup" not "Heinz ketchup"), and use the same name every time the same ingredient appears (don't call it "cheddar" in one recipe and "shredded cheese" in another unless the card is genuinely specific). Do NOT put prep instructions in the item: "carrots, diced" becomes item "carrots" (put the dicing in a method step if it matters); likewise drop "chopped", "minced", "room temperature", "for garnish". Product forms that describe what to BUY do stay ("peeled tomatoes", "floury potatoes", "shredded cheese"). This is spelling/phrasing normalization only — never change what the ingredient actually is.
- Normalize fractions and ranges to decimals ("1/2" -> 0.5, "1-2 tsp" -> 1.5). Keep oven temperatures (e.g. "415°") in the relevant method step, never as an ingredient.
- Only a genuine season-to-taste item (e.g. "salt to taste") gets amount and unit null; everything else should have an estimated concrete amount and unit (and flag estimates in the "AI added:" note).
- Preserve the given order of steps; slot any completed steps into their natural position.
- section: "bar" only for a cocktail or mixed drink, otherwise "kitchen".
- base_servings: the number the amounts are written for (default 4 for food, 1 for a single cocktail). servings_label: the unit, e.g. "servings", "pizzas", "glasses", "loaves".
- tags: 0-3 tags, ONLY from the fixed list in the schema. For kitchen: at most one cuisine (${KITCHEN_CUISINE_TAGS.join(", ")}), one protein/diet (${KITCHEN_PROTEIN_TAGS.join(", ")}), and one dish type (${KITCHEN_DISH_TAGS.join(", ")}). For bar: at most one spirit (${BAR_SPIRIT_TAGS.join(", ")}) and one style (${BAR_STYLE_TAGS.join(", ")}). Skip any category that doesn't clearly apply — do not force a tag, and never use a word outside these lists.

SUB-RECIPES (sections)
- If the recipe is made of distinct components prepared separately — e.g. a dough and a sauce, a cake and a frosting, a cocktail and its own syrup or infusion — label every ingredient AND every step of each component with a short Title-Case \`group\` (e.g. "Dough", "Sauce", "Syrup"). Use the EXACT same label across an ingredient and the steps that make it, so they line up.
- Keep each component's ingredients together and its steps together, in the order you'd make them. A final "assemble/bake/build" stage that combines the components can be its own group (e.g. "Assembly", "Bake") or null.
- If the recipe is a single straightforward preparation with no separable sub-recipe, set \`group\` to null on every ingredient and step — do NOT invent sections.`;

// ---------- URL import helpers ----------

// Cap on page text / transcript sent to the model. ~20k chars ≈ 5k tokens is
// generous for a recipe (the recipe is usually early in the body, and clean
// JSON-LD sites skip this path entirely via the tier-1 mapper). Tunable — raise
// if long recipes start getting cut off; lower to shave Haiku input cost.
const MAX_PAGE_CHARS = 20_000;

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

// Cloudflare and similar bot-protection services serve a small JS-challenge
// page ("Just a moment...") instead of the real content — sometimes with a
// non-200 status, sometimes with 200. Either way the fetch "succeeded" but
// there's nothing to extract, so give a specific, actionable error.
function looksLikeBotChallenge(html: string): boolean {
  const head = html.slice(0, 4000);
  return /Just a moment|Enable JavaScript and cookies to continue|Checking your browser before accessing|cf-browser-verification|cf_chl_opt/i.test(head);
}

// Some recipe sites are client-rendered apps (React/Vite/Next): the server
// sends an near-empty shell (a root mount point + bundled <script> tags) and
// the real content is fetched by the browser's JS after load, which a
// server-side fetch never runs.
function looksLikeEmptyAppShell(html: string): boolean {
  const hasAppRoot = /<div[^>]+id=["'](root|app|__next)["']/i.test(html);
  const text = htmlToText(html);
  return hasAppRoot && text.length < 200;
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

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'");
}

// Title + description + site name from <title> / og: / meta tags — a dependable
// fallback to give the model a head start on pages whose body text is thin, and
// the source attribution for structured (tier-1) parses.
function pageMeta(html: string): { title: string; description: string; siteName: string } {
  const pick = (re: RegExp) => { const m = html.match(re); return m ? decodeEntities(m[1].trim()) : ""; };
  const title =
    pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description =
    pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const siteName = pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i);
  return { title, description, siteName };
}

// ---------- Tier-1: deterministic schema.org Recipe → RECIPE_SCHEMA ----------
// When a site's JSON-LD Recipe is complete enough, map it directly and skip
// the model entirely: instant, free, no daily-cap consumption, and immune to
// model mis-parses. Anything that doesn't pass the acceptance gate falls
// through to the existing AI path (the JSON-LD stringified into the prompt),
// so the worst case is exactly today's behavior.

// schema.org values arrive as string | {"@value"} | {name} | arrays — flatten
// to one plain string.
function schemaText(v: unknown): string {
  if (typeof v === "string") return decodeEntities(v).trim();
  if (Array.isArray(v)) return v.map(schemaText).filter(Boolean).join(", ");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return schemaText(o["@value"] ?? o["name"] ?? o["text"] ?? "");
  }
  return "";
}

// Split one recipeIngredient line into {amount, unit, item}. Handles decimals,
// ASCII and unicode fractions, mixed numbers ("1 1/2"), and ranges ("1-2" →
// first number). Lines with no leading quantity keep amount/unit null — the
// review form and grocery engine treat that as a to-taste/garnish line.
const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅕": 0.2, "⅖": 0.4,
  "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875
};
const INGREDIENT_UNITS = new Set([
  "cup", "cups", "c",
  "tablespoon", "tablespoons", "tbsp", "tbs", "tb",
  "teaspoon", "teaspoons", "tsp",
  "ounce", "ounces", "oz",
  "pound", "pounds", "lb", "lbs",
  "gram", "grams", "g", "kilogram", "kilograms", "kg",
  "milliliter", "milliliters", "millilitre", "millilitres", "ml",
  "liter", "liters", "litre", "litres", "l",
  "quart", "quarts", "qt", "pint", "pints", "pt", "gallon", "gallons", "gal",
  "clove", "cloves", "can", "cans", "jar", "jars", "slice", "slices",
  "stick", "sticks", "pinch", "pinches", "dash", "dashes", "package", "packages",
  "pkg", "bunch", "bunches", "head", "heads", "sprig", "sprigs", "stalk", "stalks",
  "piece", "pieces", "sheet", "sheets", "strip", "strips", "wedge", "wedges",
  "handful", "handfuls", "bottle", "bottles", "bag", "bags", "box", "boxes", "envelope", "envelopes"
]);
function parseIngredientLine(raw: string): { amount: number | null; unit: string | null; item: string; group: null } {
  const line = decodeEntities(raw).replace(/\s+/g, " ").trim();
  // Leading quantity: "1", "1.5", "1/2", "1 1/2", "½", "1½", "1-2", "1 to 2".
  // The mixed-number tail (group 2) accepts FRACTIONS only, so "2 10 oz cans"
  // stays amount 2, not 12.
  const num = String.raw`(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])`;
  const frac = String.raw`([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\d+\s*\/\s*\d+)`;
  // \s* (not \s+) before the remainder: sites like BBC Good Food write
  // attached units ("750g beef mince") — the unit-peeling step below sorts
  // "g lean beef mince" into unit + item.
  const m = line.match(new RegExp(`^${num}(?:\\s*${frac})?(?:\\s*(?:-|–|to)\\s*${num})?\\s*(.+)$`));
  if (!m) return { amount: null, unit: null, item: line, group: null };
  const toNum = (s: string | undefined): number => {
    if (!s) return 0;
    if (UNICODE_FRACTIONS[s] != null) return UNICODE_FRACTIONS[s];
    if (s.includes("/")) {
      const [a, b] = s.split("/").map((x) => Number(x.trim()));
      return b ? a / b : 0;
    }
    return Number(s) || 0;
  };
  const amount = toNum(m[1]) + toNum(m[2]); // "1 1/2" / "1½" → 1.5; a range keeps the first number
  let rest = m[4] ? m[4].trim() : "";
  if (!rest || amount <= 0) return { amount: null, unit: null, item: line, group: null };
  // A leading unit word (with optional trailing "." as in "tbsp.")
  const unitMatch = rest.match(/^([A-Za-z]+)\.?\s+(.+)$/);
  let unit: string | null = null;
  if (unitMatch && INGREDIENT_UNITS.has(unitMatch[1].toLowerCase())) {
    unit = unitMatch[1].toLowerCase();
    rest = unitMatch[2].trim();
  }
  // "of" after a unit ("2 cups of flour") is noise
  rest = rest.replace(/^of\s+/i, "");
  return { amount, unit, item: rest, group: null };
}

// recipeYield arrives as number | "4 servings" | "Makes 12" | array — first
// sensible integer wins.
function parseYield(v: unknown): number {
  const s = schemaText(v);
  const m = s.match(/\d+/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : 4;
}

// recipeInstructions: string | string[] | HowToStep[] | HowToSection[] (each
// section carrying itemListElement of steps). Sections become the app's
// sub-recipe groups.
function parseInstructions(v: unknown): { text: string; group: string | null }[] {
  const out: { text: string; group: string | null }[] = [];
  const addText = (raw: string, group: string | null) => {
    const cleaned = htmlToText(raw).replace(/\s+/g, " ").trim();
    if (cleaned) out.push({ text: cleaned, group });
  };
  const walk = (node: unknown, group: string | null) => {
    if (typeof node === "string") {
      // A single blob may hold every step — split on newlines when present.
      node.split(/\r?\n+/).forEach((part) => addText(part, group));
      return;
    }
    if (Array.isArray(node)) { node.forEach((child) => walk(child, group)); return; }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      const types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
      if (types.some((t) => typeof t === "string" && t.toLowerCase() === "howtosection")) {
        const name = schemaText(o["name"]) || null;
        walk(o["itemListElement"], name);
        return;
      }
      const text = schemaText(o["text"] ?? o["name"] ?? "");
      if (text) addText(text, group);
    }
  };
  walk(v, null);
  return out;
}

// The mapper + acceptance gate. Returns a complete RECIPE_SCHEMA-shaped object
// or null (→ caller falls through to the AI path).
function schemaOrgToRecipe(node: unknown, url: URL, meta: { siteName: string }): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;

  const name = schemaText(o["name"]);
  if (!name) return null;

  const ingredients = (Array.isArray(o["recipeIngredient"]) ? o["recipeIngredient"] : [])
    .map((line: unknown) => schemaText(line))
    .filter(Boolean)
    .map(parseIngredientLine);
  const method = parseInstructions(o["recipeInstructions"]);

  // Acceptance gate: enough structure to trust, and enough of the ingredient
  // lines parsed a quantity (short lines — "lime wedge", "salt" — are fine
  // without one). Anything less falls back to the model.
  if (ingredients.length < 3 || method.length < 2) return null;
  const okLines = ingredients.filter((ing) => ing.amount != null || ing.item.split(/\s+/).length <= 4).length;
  if (okLines / ingredients.length < 0.6) return null;

  const categoryText = [schemaText(o["recipeCategory"]), schemaText(o["keywords"]), name].join(" ");
  const section = /\b(cocktail|drink|beverage|mocktail)\b/i.test(categoryText) ? "bar" : "kitchen";

  // Tags: only exact hits against the app's fixed taxonomy, max 3.
  const tagSource = [schemaText(o["recipeCuisine"]), schemaText(o["recipeCategory"]), schemaText(o["keywords"])].join(",");
  const tags = [...new Set(
    tagSource.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter((t) => ALL_TAGS.includes(t))
  )].slice(0, 3);

  const description = schemaText(o["description"]);
  const subtitle = description
    ? (description.length > 140 ? description.slice(0, 140).replace(/\s+\S*$/, "") + "…" : description)
    : null;

  const author = schemaText((o["author"] as Record<string, unknown>)?.["name"] ?? o["author"]);
  const source = meta.siteName || author || url.hostname.replace(/^www\./, "");

  return {
    name,
    subtitle,
    source,
    section,
    tags,
    base_servings: parseYield(o["recipeYield"]),
    servings_label: "servings",
    ingredients,
    method,
    notes: null
  };
}

// ---------- TikTok ----------
// TikTok's official, keyless oEmbed endpoint returns the video's caption
// (`title`) and creator (`author_name`) — the legitimate channel for reading a
// post server-side. Recipe TikToks usually carry the recipe in the caption;
// there is no free, ToS-clean transcript source, so caption-only is the honest
// ceiling here (thin captions get paste guidance instead).
function tikTokUrl(raw: string): URL | null {
  const url = raw ? parseAllowedUrl(raw) : null;
  if (!url) return null;
  const h = url.hostname.toLowerCase().replace(/^www\./, "");
  return h === "tiktok.com" || h.endsWith(".tiktok.com") ? url : null;
}

async function fetchTikTokOEmbed(videoUrl: string): Promise<{ title?: string; author_name?: string } | null> {
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// vm.tiktok.com / tiktok.com/t/ short links sometimes need resolving to the
// canonical /video/ URL before oEmbed accepts them — one redirect-following
// GET, reading the final URL.
async function resolveTikTokShortLink(shortUrl: string): Promise<string | null> {
  try {
    const res = await fetch(shortUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }
    });
    return res.url || null;
  } catch {
    return null;
  }
}

// ---------- YouTube / video helpers ----------
// Cooking videos carry the recipe in the description (usually the ingredient
// list) and the spoken captions (the method) — not in page text or JSON-LD.
// The reliable pipeline (verified against YouTube's current bot hardening):
//   1. GET the watch page (browser UA + consent cookie) for shortDescription/
//      author/captionTracks as a scrape fallback if the Innertube call fails.
//   2. POST youtubei/v1/player with the ANDROID client context (no API key
//      needed) — this is the one client that still returns BOTH videoDetails
//      and working captionTracks (the WEB client withholds captions, and
//      caption baseUrls embedded in the page HTML are proof-of-origin-gated).
//   3. GET the chosen track's baseUrl (with &fmt=srv3 stripped) → XML → text.
function isYouTube(url: URL): boolean {
  const h = url.hostname.toLowerCase().replace(/^www\./, "");
  return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be" || h.endsWith(".youtube.com");
}

// watch?v=ID, youtu.be/ID, /shorts/ID, /live/ID, /embed/ID — IDs are 11 chars.
function youTubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const id = host === "youtu.be"
    ? url.pathname.slice(1).split("/")[0]
    : url.searchParams.get("v") ||
      (url.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})/)?.[2] ?? "");
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// The description is stored JSON-escaped in the page (\n, \", é); wrap it
// back into a JSON string to decode it.
function decodeJsonString(raw: string): string {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

function extractYouTube(html: string): { title: string; description: string; author: string } | null {
  const dm = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!dm) return null;
  const am = html.match(/"author":"((?:[^"\\]|\\.)*)"/);
  return {
    title: pageMeta(html).title,
    description: decodeJsonString(dm[1]),
    author: am ? decodeJsonString(am[1]) : ""
  };
}

type YtCaptionTrack = { baseUrl?: string; languageCode?: string; kind?: string };
type YtVideo = {
  title: string;
  author: string;
  description: string;
  captionTracks: YtCaptionTrack[];
  playable: boolean;
};

// Innertube player call. The ANDROID client returns caption tracks whose
// baseUrl actually serves content (mirrors what youtube-transcript-api ships
// today) and needs no API key. Returns null on any network/shape failure so
// the caller can fall back to the page scrape.
async function fetchYouTubeVideo(videoId: string): Promise<YtVideo | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
        videoId
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const vd = data?.videoDetails;
    const status = data?.playabilityStatus?.status;
    if (!vd?.title && status !== "OK") return null; // deleted/nonexistent → let scrape try
    return {
      title: vd?.title || "",
      author: vd?.author || "",
      description: vd?.shortDescription || "",
      captionTracks: data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [],
      playable: status === "OK"
    };
  } catch {
    return null;
  }
}

// Prefer human captions over auto-generated (kind === "asr"), English over
// not, then whatever exists.
function pickCaptionTrack(tracks: YtCaptionTrack[]): string {
  const en = (t: YtCaptionTrack) => (t.languageCode || "").toLowerCase().startsWith("en");
  const manual = (t: YtCaptionTrack) => t.kind !== "asr";
  const pick =
    tracks.find((t) => t.baseUrl && manual(t) && en(t)) ||
    tracks.find((t) => t.baseUrl && en(t)) ||
    tracks.find((t) => t.baseUrl && manual(t)) ||
    tracks.find((t) => t.baseUrl);
  return pick?.baseUrl || "";
}

// Caption-track list scraped from the watch page — fallback when the Innertube
// call fails (its baseUrls are often proof-of-origin-gated, but trying costs
// one cheap GET).
function captionTracksFromHtml(html: string): YtCaptionTrack[] {
  const tm = html.match(/"captionTracks":(\[.*?\])/);
  if (!tm) return [];
  try { return JSON.parse(tm[1]) as YtCaptionTrack[]; } catch { return []; }
}

// Fetch a caption track and flatten it to plain text. The track serves XML
// (<text …>chunk</text>) once &fmt=srv3 is stripped; entities arrive
// double-escaped (&amp;#39;), hence decoding twice. Returns "" if unavailable.
async function fetchTranscriptFromUrl(baseUrl: string): Promise<string> {
  if (!baseUrl) return "";
  // "&exp=xpe" marks tracks that require a proof-of-origin token — the fetch
  // would come back empty, so don't bother.
  if (baseUrl.includes("&exp=xpe")) return "";
  try {
    const res = await fetch(baseUrl.replace("&fmt=srv3", ""), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "";
    const xml = await res.text();
    const chunks = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]);
    return decodeEntities(decodeEntities(chunks.join(" "))).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

const TAG_SET = new Set(ALL_TAGS);

// Shape check mirroring the RECIPE_SCHEMA contract — the escalation trigger for
// the Groq tier. Kept dependency-free (no Ajv) to match the repo. A miss means
// fall back to Claude. Intentionally lenient on optional fields; strict on the
// things that make a recipe cookable and on tag-taxonomy validity.
// deno-lint-ignore no-explicit-any
function isValidRecipe(r: any): boolean {
  if (!r || typeof r !== "object") return false;
  if (typeof r.name !== "string" || !r.name.trim()) return false;
  if (r.section !== "kitchen" && r.section !== "bar") return false;
  if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) return false;
  for (const ing of r.ingredients) {
    if (!ing || typeof ing !== "object") return false;
    if (typeof ing.item !== "string" || !ing.item.trim()) return false;
    if (!("amount" in ing) || !("unit" in ing)) return false;
  }
  if (!Array.isArray(r.method)) return false;
  if (Array.isArray(r.tags) && !r.tags.every((t: unknown) => typeof t === "string" && TAG_SET.has(t as string))) return false;
  return true;
}

// One Groq (OpenAI-compatible) structured-output call with strict JSON schema.
// A 429 (rate limit) escalates to Claude IMMEDIATELY — the free-tier limit won't
// clear in the time a retry takes, so retrying just wastes a round-trip on the
// exact rapid-fire case where speed matters. Only a 5xx or network/timeout blip
// gets one retry. Returns { recipe } or { error }; the caller decides to escalate.
// deno-lint-ignore no-explicit-any
async function runGroq(userText: string): Promise<{ recipe?: any; error?: string }> {
  if (!GROQ_API_KEY) return { error: "groq disabled" };
  const payload = JSON.stringify({
    model: GROQ.model,
    max_tokens: GROQ.maxTokens,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText }
    ],
    response_format: { type: "json_schema", json_schema: { name: "recipe", strict: true, schema: RECIPE_SCHEMA_STRICT } }
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(GROQ.url, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${GROQ_API_KEY}` },
        body: payload,
        signal: AbortSignal.timeout(15_000)
      });
      if (res.status === 429) {   // rate-limited — escalate now, don't retry
        console.error("Groq rate-limited (429), escalating to Claude");
        return { error: "groq 429" };
      }
      if (res.status >= 500) {   // server blip — retry once
        if (attempt === 0) continue;
        console.error("Groq server error:", res.status);
        return { error: `groq ${res.status}` };
      }
      if (!res.ok) { console.error("Groq error:", res.status, await res.text()); return { error: `groq ${res.status}` }; }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return { error: "groq empty" };
      return { recipe: JSON.parse(content) };
    } catch (e) {
      if (attempt === 0) continue;   // timeout / network — retry once
      console.error("Groq call failed:", e);
      return { error: "groq exception" };
    }
  }
  return { error: "groq failed" };
}

// The Claude extraction call, factored out of the handler so it serves both the
// normal escalation target and the forced-provider comparison path. Returns
// { recipe } or { error } (friendly, already input-specific via noRecipeMessage).
// deno-lint-ignore no-explicit-any
async function runClaude(model: string, userContent: unknown, noRecipeMessage: string): Promise<{ recipe?: any; error?: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      // Billed on actual output, so a generous ceiling costs nothing but headroom.
      model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [{ name: "save_recipe", description: "Save the extracted recipe.", input_schema: RECIPE_SCHEMA }],
      tool_choice: { type: "tool", name: "save_recipe" },
      messages: [{ role: "user", content: userContent }]
    })
  });
  if (!res.ok) {
    console.error("Anthropic API error:", res.status, await res.text());
    return { error: res.status === 429 ? "Rate limit or usage limit reached — try again later." : "AI extraction failed. Please try again." };
  }
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    console.error("extract-recipe: response truncated at max_tokens");
    return { error: "That recipe was too long to read in one go — try fewer photos or split it." };
  }
  const toolBlock = data.content?.find((c: { type: string }) => c.type === "tool_use");
  const recipe = toolBlock?.input;
  if (!recipe || !recipe.name || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    return { error: noRecipeMessage };
  }
  // Save ingredient names in canonical, store-consistent form so grocery lists and
  // King Soopers matching "just work" — same table as app.js's canonicalizeItem.
  for (const ing of recipe.ingredients) {
    if (ing && typeof ing.item === "string") ing.item = canonicalizeItem(ing.item);
  }
  return { recipe };
}

// ---- Generalized ingredient synonym database --------------------------------
// MIRROR of app.js INGREDIENT_ALIASES (that file is the source of truth). Keep the
// two in sync: "worded differently, same store product" folds applied to an item
// name so imports save canonical names.
const INGREDIENT_ALIASES: [RegExp, string][] = [
  [/\b(?:boneless|skinless)\b/gi, " "],
  [/\b(?:breasts?|thighs?)\s+or\s+(?:breasts?|thighs?)\b/gi, "breast"],
  [/\bchicken\s+breasts\b/gi, "chicken breast"],
  [/\b(?:instant\s+dry|rapid[-\s]?rise|quick[-\s]?rise|bread\s+machine)\s+yeast\b/gi, "instant yeast"],
  [/\b(?:(?:yellow|red|white|sweet|spanish|vidalia|medium|large|small|grated|minced|diced|chopped)\s+)+onions?\b/gi, "onion"],
  [/(?<!,\s)\b(?:(?:whole|warm|hot|cold|lukewarm|2\s*%|1\s*%|skim|nonfat|reduced[-\s]?fat)\s+)+milk\b/gi, "milk"],
  [/\bscallions?\b/gi, "green onion"],
  [/\bspaghetti\s+pasta\b/gi, "spaghetti"],
  [/\bgarlic\s+cloves?\b/gi, "garlic"],
  [/\bcloves?\s+of\s+garlic\b/gi, "garlic"],
  [/\b(?:low[-\s]?moisture\s+whole[-\s]?milk|whole[-\s]?milk\s+low[-\s]?moisture)\s+mozzarella\b/gi, "low-moisture whole-milk mozzarella"],
  [/\bparmigiano(?:[-\s]?reggiano)?\b/gi, "parmesan"],
  [/\bparmesan\s+cheese\b/gi, "parmesan"],
];
const PASTA_SHAPE_RE = /\b(?:spaghetti|bucatini|vermicelli|angel\s*hair|linguine|fettuccine|tagliatelle|pappardelle|penne|rigatoni|macaroni|fusilli|rotini|orzo|ziti|farfalle|cavatappi|cellentani|lasagn[ae]|noodles?)\b/i;
function canonicalizeItem(name: string): string {
  // Drop typographic double-quotes; slash between letters only (keep fractions).
  let s = String(name || "").replace(/["“”]/g, "").replace(/([a-z])\/([a-z])/gi, "$1 $2");
  // A flexible pasta line ("bucatini (or any pasta)") folds to plain "pasta".
  if (/\bor\b/i.test(s) && (/\bpasta\b/i.test(s) || PASTA_SHAPE_RE.test(s))) return "pasta";
  for (const [re, to] of INGREDIENT_ALIASES) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ")
    .replace(/,\s*,/g, ",").replace(/(^[\s,]+)|([\s,]+$)/g, "").trim();
}

// Fire-and-forget observability: one row per operation via the log_ai_call RPC.
// Never blocks or throws — logging must not break an extraction.
// deno-lint-ignore no-explicit-any
async function logAiCall(client: any, task: string, model: string, valid: boolean, latencyMs: number, escalated: boolean) {
  try {
    await client.rpc("log_ai_call", {
      p_task: task, p_model: model, p_valid: valid, p_latency_ms: latencyMs, p_escalated: escalated
    });
  } catch (e) {
    console.error("log_ai_call failed:", e);
  }
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
    // Message shown if the model returns no recipe — made input-specific below
    // (a link failure shouldn't advise "try a clearer photo").
    let noRecipeMessage = "AI couldn’t find a recipe in that input. Try a clearer photo or paste the text.";

    if (body.type === "image") {
      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length === 0) return json({ error: "No image was received." });
      if (images.length > MAX_IMAGES) return json({ error: `Please send at most ${MAX_IMAGES} photos at a time.` });
      for (const img of images) {
        if (!img?.data || !img?.mediaType) return json({ error: "No image was received." });
        if (!ALLOWED_IMAGE_TYPES.includes(img.mediaType)) {
          return json({ error: "Unsupported image format — use a JPEG, PNG, GIF, or WebP photo." });
        }
      }
      const multi = images.length > 1;
      // Label each image so the model can keep multi-page sources in order
      // (front then back); a single image needs no label.
      userContent = [];
      images.forEach((img: { mediaType: string; data: string }, i: number) => {
        if (multi) userContent.push({ type: "text", text: `Image ${i + 1} of ${images.length}:` });
        userContent.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      });
      userContent.push({
        type: "text",
        text: multi
          ? "The images above are different pages or sides (e.g. the front and back of a card) of the SAME recipe, in order. Read them together as one source and call save_recipe once with the single combined recipe."
          : "Extract the recipe from this image by calling save_recipe."
      });
    } else if (body.type === "text") {
      if (!body.text || !body.text.trim()) return json({ error: "No text was received." });
      userContent = [
        { type: "text", text: `Extract the recipe from the following text by calling save_recipe:\n\n${body.text}` }
      ];
    } else if (body.type === "url" && typeof body.url === "string" && tikTokUrl(body.url.trim())) {
      // TikTok: the official keyless oEmbed endpoint serves the caption, which
      // is where recipe TikToks carry the recipe. Caption-only is the honest
      // ceiling (no free, ToS-clean transcript source exists); thin captions
      // get paste guidance and the frontend's "Paste text instead" button.
      const url = tikTokUrl(body.url.trim())!;
      let tk = await fetchTikTokOEmbed(url.href);
      if (!tk) {
        // Short links (vm.tiktok.com, /t/) sometimes need resolving first.
        const resolved = await resolveTikTokShortLink(url.href);
        if (resolved && resolved !== url.href) tk = await fetchTikTokOEmbed(resolved);
      }
      const caption = (tk?.title || "").trim();
      const author = (tk?.author_name || "").trim();
      console.error(`extract-recipe tiktok: oembed=${tk ? "ok" : "null"} caption=${caption.length}`);
      if (caption.replace(/\s/g, "").length < 80) {
        return json({ error: "This TikTok’s caption doesn’t contain the recipe (it may only be spoken in the video). Copy the caption — and jot down any spoken steps — then use Paste text here." });
      }
      const sourceHint = author || "TikTok";
      noRecipeMessage = "This TikTok’s caption didn’t contain a full recipe — copy the caption (and any spoken steps) and use Paste text instead.";
      const content = `TIKTOK VIDEO CAPTION:\nCREATOR: ${author}\n\n${caption}`.slice(0, MAX_PAGE_CHARS);
      userContent = [{
        type: "text",
        text: `Extract the recipe from this TikTok video's caption by calling save_recipe. Captions use emoji, hashtags, and casual shorthand — ignore that clutter and reconstruct clean ingredients and ordered method steps. If amounts or steps are missing, fill sensible gaps as instructed and flag them in notes. Use "${sourceHint}" as the source if no clearer attribution is given.\n\n${content}`
      }];
    } else if (body.type === "url") {
      const url = typeof body.url === "string" ? parseAllowedUrl(body.url.trim()) : null;
      if (!url) return json({ error: "That doesn’t look like a valid link." });
      // Instagram is login-walled at the HTTP level — a server-side fetch gets
      // a JS shell with no caption in it (verified 2026-07: the post page, the
      // /embed/ endpoint, and every known keyless API route all gate on login;
      // the official oEmbed needs a Facebook app token). Fail fast with
      // instructions instead of fetching a known dead end; the frontend adds
      // its "Paste text instead" button to this error.
      const socialHost = url.hostname.toLowerCase().replace(/^www\./, "");
      if (socialHost === "instagram.com" || socialHost.endsWith(".instagram.com")) {
        return json({ error: "Instagram doesn’t let servers read posts. Copy the post’s caption and paste it here — and if the steps are only spoken in the video, jot those in too." });
      }
      const onYouTube = isYouTube(url);
      let html = "";
      try {
        const pageRes = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
          headers: {
            // A browser-ish UA — many recipe sites refuse obvious bots outright.
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            // SOCS=CAI skips YouTube's EU consent interstitial, which otherwise
            // replaces the watch page (hiding description and captions).
            ...(onYouTube ? { "Cookie": "SOCS=CAI" } : {})
          }
        });
        html = await pageRes.text();
        // A non-OK status is usually a real "couldn't load it" — unless the
        // body is a bot-challenge page, which the check below handles with a
        // more specific message regardless of status code.
        if (!pageRes.ok && !looksLikeBotChallenge(html)) throw new Error(`status ${pageRes.status}`);
      } catch (fetchErr) {
        console.error("URL fetch failed:", url.href, fetchErr);
        // For YouTube the watch page is only one of two sources — the Innertube
        // API below often works even when the page fetch is blocked.
        if (!onYouTube) {
          return json({ error: "Couldn’t load that page — the site may block robots. Copy the recipe text and paste it instead." });
        }
        html = "";
      }
      if (looksLikeBotChallenge(html)) {
        if (!onYouTube) {
          return json({ error: "This site’s bot-protection is blocking automatic access — copy the recipe text and paste it instead." });
        }
        html = "";
      }
      let content: string;
      let sourceHint = url.hostname;

      if (onYouTube) {
        // Description (usually the ingredient list) + spoken transcript (the
        // method) — always gather BOTH and let the model combine them.
        const videoId = youTubeVideoId(url);
        if (!videoId) {
          return json({ error: "Link a specific video (not a channel or playlist) — or paste the recipe text instead." });
        }
        const vid = await fetchYouTubeVideo(videoId);
        const yt = html ? extractYouTube(html) : null;
        const meta = html ? pageMeta(html) : { title: "", description: "", siteName: "" };

        // Merge sources: Innertube first, page scrape second, og: meta last.
        const title = vid?.title || yt?.title || meta.title;
        const author = vid?.author || yt?.author || "";
        const description = vid?.description || yt?.description || meta.description;
        const tracks = vid?.captionTracks?.length ? vid.captionTracks : captionTracksFromHtml(html);
        if (author) sourceHint = author;

        const transcript = await fetchTranscriptFromUrl(pickCaptionTrack(tracks));

        // Compose within the model-input budget: the description (ingredients
        // live there) gets priority; the transcript fills the rest.
        const head = `VIDEO: ${title}\nCHANNEL: ${author}\n\nDESCRIPTION:\n${description.slice(0, 12_000)}`;
        const transcriptBudget = Math.max(MAX_PAGE_CHARS - head.length - 30, 0);
        content = (transcript
          ? `${head}\n\nSPOKEN TRANSCRIPT:\n${transcript.slice(0, transcriptBudget)}`
          : head).trim();

        // Server-side visibility: YouTube gates caption downloads by IP, so the
        // transcript can be empty from the Edge runtime even when it isn't from
        // a browser. These lengths make that obvious in the function logs.
        console.error(`extract-recipe youtube: id=${videoId} innertube=${vid ? "ok" : "null"} desc=${description.length} transcript=${transcript.length} content=${content.length}`);

        // When captions don't reach us (YouTube IP-gates the download), the
        // recipe is stuck in the video's audio. YouTube's own built-in AI can
        // read that audio, so route the user there and back through Paste text.
        const useYouTubeAi = "In the YouTube app, tap its AI (“Ask”) button and ask for the recipe's ingredients and method, then copy the answer and use “Paste text” here.";

        // A cooking video's method lives in the spoken captions; when they don't
        // reach us the description alone is often just sponsor links, so point
        // the user at YouTube's AI rather than "clearer photo".
        if (!transcript) {
          noRecipeMessage = `We read this video's description but not its spoken audio, where the recipe is. ${useYouTubeAi}`;
        }

        if (content.replace(/\s/g, "").length < 80) {
          if (vid && !vid.playable) {
            return json({ error: "This video is private, age-restricted, or unavailable — paste the recipe text instead." });
          }
          return json({ error: `Couldn't read this video automatically. ${useYouTubeAi}` });
        }
      } else {
        const jsonLd = findJsonLdRecipe(html);
        if (jsonLd) {
          // Tier 1: when the site's own JSON-LD Recipe is complete enough, map
          // it deterministically and return BEFORE the cap RPC and model call —
          // instant, free, no quota, no model mis-parses. A partial/odd node
          // falls through to today's AI path (stringified into the prompt).
          const structured = schemaOrgToRecipe(jsonLd, url, pageMeta(html));
          console.error(`extract-recipe url: host=${url.hostname} jsonld=yes via=${structured ? "structured" : "ai"}`);
          if (structured) {
            return json({ recipe: structured, extracted_via: "structured" });
          }
          content = JSON.stringify(jsonLd).slice(0, MAX_PAGE_CHARS);
        } else {
          // No structured recipe — give the model the page's title/description
          // (often the recipe name + summary) ahead of the stripped body text.
          const meta = pageMeta(html);
          const metaBlock = [meta.title, meta.description].filter(Boolean).join("\n");
          content = ((metaBlock ? metaBlock + "\n\n" : "") + htmlToText(html)).slice(0, MAX_PAGE_CHARS);
        }
        if (content.length < 80) {
          if (looksLikeEmptyAppShell(html)) {
            return json({ error: "This page loads its recipe with JavaScript, so there’s no readable text without it — copy the recipe text and paste it instead." });
          }
          return json({ error: "Couldn’t find readable recipe text on that page — paste the text instead." });
        }
      }

      const promptText = onYouTube
        ? `Extract the recipe from this YouTube cooking video by calling save_recipe. The DESCRIPTION often contains the ingredient list (frequently with exact amounts) plus unrelated clutter — sponsor links, chapter timestamps, social links; ignore the clutter. The SPOKEN TRANSCRIPT is speech-to-text of the video: use it to reconstruct the ordered method steps and any technique details, and to recover ingredients or amounts the description omits. It has no punctuation and may mis-hear words — clean that up. When the description and the spoken amounts disagree, prefer the description. Ignore intros, sponsor reads, and calls to subscribe. Fill remaining gaps as instructed and flag them in notes. Use "${sourceHint}" as the source if no clearer attribution is given.\n\n${content}`
        : `Extract the recipe from this content from ${sourceHint} by calling save_recipe. If the content names no clearer attribution, use "${sourceHint}" as the source.\n\n${content}`;
      userContent = [{ type: "text", text: promptText }];
    } else {
      return json({ error: "Invalid request." });
    }

    // ---- Provider routing setup ----
    const task = `extract_${body.type}`;
    const started = Date.now();
    // Comparison affordance (admin-gated): pin one provider, skip escalation, and
    // skip the daily cap so the old-vs-new equivalence test can't exhaust a
    // user's quota. Ignored entirely unless ALLOW_PROVIDER_OVERRIDE is set.
    const forced = ALLOW_PROVIDER_OVERRIDE && (body.force_provider === "claude" || body.force_provider === "groq")
      ? body.force_provider as "claude" | "groq" : null;
    const userText = (userContent as Array<{ text?: string }>).map((c) => c.text).filter(Boolean).join("\n");
    // Groq handles only the non-image text/URL paths, only when enabled, and only
    // when the input fits the free-tier budget — longer pages/transcripts skip
    // Groq (which would 413) and go straight to Claude.
    const groqEligible = body.type !== "image" && !!GROQ_API_KEY && userText.length <= GROQ.maxInputChars;

    // Enforce the per-user daily cap right before the paid call, so requests
    // that fail validation above never consume quota. Fails open (logs and
    // proceeds) if the SQL migration for this hasn't been run yet. Skipped in
    // forced comparison mode (admin-only, not user traffic).
    if (!forced) {
      const { data: usageResult, error: usageError } = await supabaseClient
        .rpc("increment_extraction_usage", { daily_limit: DAILY_EXTRACTION_LIMIT });
      if (!usageError && usageResult === -1) {
        return json({ error: `You’ve used today’s ${DAILY_EXTRACTION_LIMIT} AI recipe extractions — it resets at midnight UTC. Try again tomorrow, or add this one manually.` });
      }
      if (usageError) console.error("extraction_usage check failed:", usageError);
    }

    // Comparison mode: return the pinned provider's RAW output (no escalation),
    // with a `valid` flag so the harness can see where Groq would have escalated.
    if (forced === "groq") {
      if (!groqEligible) return json({ error: "Groq tier not available for this input." });
      const g = await runGroq(userText);
      const valid = !!g.recipe && isValidRecipe(g.recipe);
      await logAiCall(supabaseClient, task, GROQ.model, valid, Date.now() - started, false);
      if (!g.recipe) return json({ error: g.error || noRecipeMessage });
      return json({ recipe: g.recipe, extracted_via: "groq", valid });
    }
    if (forced === "claude") {
      const c = await runClaude(pickModel(body.type), userContent, noRecipeMessage);
      const valid = !!c.recipe && isValidRecipe(c.recipe);
      await logAiCall(supabaseClient, task, pickModel(body.type), valid, Date.now() - started, false);
      if (c.error) return json({ error: c.error });
      return json({ recipe: c.recipe, extracted_via: "ai", valid });
    }

    // Normal path: cheap Groq tier first (text/URL only) → validate → escalate to
    // Claude on any miss (error, timeout, or schema-invalid output).
    if (groqEligible) {
      const g = await runGroq(userText);
      if (g.recipe && isValidRecipe(g.recipe)) {
        await logAiCall(supabaseClient, task, GROQ.model, true, Date.now() - started, false);
        return json({ recipe: g.recipe, extracted_via: "groq" });
      }
      console.error(`extract-recipe: groq miss (${g.error || "invalid output"}), escalating to Claude`);
    }
    const c = await runClaude(pickModel(body.type), userContent, noRecipeMessage);
    if (c.error) {
      await logAiCall(supabaseClient, task, pickModel(body.type), false, Date.now() - started, groqEligible);
      return json({ error: c.error });
    }
    await logAiCall(supabaseClient, task, pickModel(body.type), isValidRecipe(c.recipe), Date.now() - started, groqEligible);
    return json({ recipe: c.recipe, extracted_via: "ai" });
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
