// Supabase Edge Function: recipe-coach
//
// An in-recipe AI assistant with two conversational modes:
//   - "troubleshoot": the cook describes a dish that went wrong; the AI asks
//     clarifying questions, then diagnoses the cause and how to prevent it.
//   - "tweak": the cook asks for an improvement (less sweet, more balance, a
//     missing element, better technique); the AI suggests concrete changes and
//     can return a full revised recipe to apply.
//
// Mirrors extract-recipe: structured output via a forced tool_choice, the
// Anthropic key stays server-side, the caller's Supabase JWT is verified, and
// a per-user daily cap is enforced before any paid call — in the coach's OWN
// bucket (increment_coach_usage), separate from the import cap.
//
// Request body (JSON):
//   { mode: "troubleshoot" | "tweak",
//     recipe: { name, subtitle, section, tags, base_servings, servings_label,
//               ingredients, method, notes },
//     messages: [{ role: "user" | "assistant", content: "<text>" }, ...],
//     context?: { pantry: string[], bar: string[], out: string[],   // inventory names
//                 recipes: [{ name, section }] } }                  // the cook's other recipes
//
// With `context`, the coach knows what's in stock and which other recipes the
// cook has. The index is names only; when a question needs another recipe's
// details the model calls the server-side `get_recipe` tool, which reads that
// row with the caller's JWT (so row-level security decides what it can see).
//
// Response: always HTTP 200 with either { result: {...} } or { error: "..." }.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Reasoning quality is the whole point here (real culinary diagnosis), and these
// calls are low-volume + short, so the stronger model costs little in practice.
const MODEL_COACH = "claude-sonnet-4-6";
// Per-user daily cap on paid coach calls, tracked in its OWN bucket
// (increment_coach_usage) so coaching and recipe imports are limited separately.
// Each conversational turn — including an "emphasize this in the recipe" request —
// counts as one. A typical troubleshooting session is a few turns.
const DAILY_COACH_LIMIT = 20;
const ANTHROPIC_VERSION = "2023-06-01";
// Defensive caps on conversational input so a runaway client can't send a novel.
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 6000;
// Caps on the kitchen context (inventory names + recipe index) and on lookups.
const MAX_STOCK_ITEMS = 200;
const MAX_RECIPE_INDEX = 300;
const MAX_NAME_CHARS = 80;
const MAX_RECIPE_LOOKUPS = 2;      // get_recipe calls per cook message
const MAX_LOOKUP_CHARS = 8000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Curated tag taxonomy — kept in sync with extract-recipe so a revised recipe
// validates against the same fixed list the app's tag picker uses.
const KITCHEN_CUISINE_TAGS = ["italian", "american", "mexican", "mediterranean", "british", "finnish", "asian", "french"];
const KITCHEN_PROTEIN_TAGS = ["chicken", "beef", "pork", "seafood", "vegetarian", "vegan"];
const KITCHEN_DISH_TAGS = ["pizza", "pasta", "burger", "taco", "casserole", "soup", "salad", "sandwich", "bread", "breakfast", "dessert", "main-dish", "side-dish", "sauce"];
const BAR_SPIRIT_TAGS = ["rum", "gin", "whiskey", "tequila", "vodka", "brandy", "amaro", "non-alcoholic"];
const BAR_STYLE_TAGS = ["sour", "collins", "highball", "tiki", "frozen", "stirred", "classic", "low-abv"];
const ALL_TAGS = [
  ...KITCHEN_CUISINE_TAGS, ...KITCHEN_PROTEIN_TAGS, ...KITCHEN_DISH_TAGS,
  ...BAR_SPIRIT_TAGS, ...BAR_STYLE_TAGS
];

// The recipe shape the app's edit form consumes (matches extract-recipe's
// RECIPE_SCHEMA), used for the optional `revised_recipe` so the client can feed
// it straight into fillRecipeFormFromExtraction().
const RECIPE_PROPERTIES = {
  name: { type: "string", description: "Recipe title, head-noun-first: lead with the core dish or main ingredient, then style/qualifier after ' - ' (e.g. 'Pancakes - Ultra Fluffy')." },
  subtitle: { type: ["string", "null"], description: "Short tagline or description, or null" },
  source: { type: ["string", "null"], description: "Where the recipe came from, or null" },
  section: { type: "string", enum: ["kitchen", "bar"], description: "'bar' for cocktails/drinks, 'kitchen' otherwise" },
  tags: {
    type: "array",
    items: { type: "string", enum: ALL_TAGS },
    maxItems: 3,
    description: "0-3 tags from the fixed list ONLY, whichever genuinely apply; carry over the recipe's existing tags unless a change makes one wrong."
  },
  base_servings: { type: "integer", description: "Number of servings the ingredient amounts are written for" },
  servings_label: { type: "string", description: "Unit for servings, e.g. 'servings', 'pizzas', 'glasses'" },
  ingredients: {
    type: "array",
    items: {
      type: "object",
      properties: {
        amount: { type: ["number", "null"], description: "Numeric quantity, fractions as decimals (1/2 -> 0.5); null only for a true season-to-taste item." },
        unit: { type: ["string", "null"], description: "Unit of measure (g, cup, tbsp, etc.), or null if countable / no unit" },
        item: { type: "string", description: "The ingredient's common name in full, consistent words, with NO prep instructions." },
        group: { type: ["string", "null"], description: "Short Title-Case sub-recipe label (e.g. 'Dough', 'Sauce'), or null." }
      },
      required: ["amount", "unit", "item", "group"]
    }
  },
  method: {
    type: "array",
    items: {
      type: "object",
      properties: {
        text: { type: "string", description: "One method/instruction step." },
        group: { type: ["string", "null"], description: "Same sub-recipe label as the matching ingredients, or null." }
      },
      required: ["text", "group"]
    },
    description: "Ordered list of method/instruction steps"
  },
  notes: { type: ["string", "null"], description: "Additional notes/tips. When you changed the recipe, append one line starting 'AI tweaked: ' naming what changed." }
};
const RECIPE_REQUIRED = ["name", "subtitle", "source", "section", "tags", "base_servings", "servings_label", "ingredients", "method", "notes"];

// The single tool the model is forced to call each turn.
const COACH_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Your conversational turn to the cook — either your clarifying question(s) or, once you're confident, your diagnosis/answer. Warm, concise, jargon-light." },
    needs_more_info: { type: "boolean", description: "true if this turn is asking for more details before you can conclude; false when you're giving real diagnosis/advice." },
    suggestions: { type: "array", items: { type: "string" }, description: "Concrete, actionable bullet points (fixes, changes, technique tips). Empty while you're still gathering information (needs_more_info true)." },
    revised_recipe: {
      type: ["object", "null"],
      properties: RECIPE_PROPERTIES,
      required: RECIPE_REQUIRED,
      description: "A COMPLETE revised recipe (every field) with the changes applied and everything else carried over unchanged, when a rewrite genuinely helps OR the cook asks you to update/emphasize the recipe. null otherwise (and null while still diagnosing)."
    }
  },
  required: ["reply", "needs_more_info", "suggestions", "revised_recipe"]
};

const TROUBLESHOOT_PROMPT = `You are an expert cook and recipe troubleshooter helping someone figure out why a dish they made didn't turn out — and how to get it right next time. You answer by calling the \`respond\` tool every turn.

You are in a back-and-forth conversation. Your job is to reach the REAL cause, not to guess from the first message.

- If the cause is at all ambiguous, ASK 1-3 short, specific clarifying questions BEFORE concluding — about pan size and material, heat level, exact oven/stovetop temperatures, timings, the visual or textural cues they saw, ingredient brands or substitutions, and which step they were on. Put the questions in \`reply\`, set \`needs_more_info\` true, and leave \`suggestions\` empty.
- Once you're confident, give your diagnosis in \`reply\`: the most likely cause(s), a brief explanation of WHY (the underlying food science), and how to do it right next time — plus a rescue if one exists. Set \`needs_more_info\` false and put the concrete fixes as short bullets in \`suggestions\`.
- Keep replies warm, concise, and jargon-light. One idea at a time; don't dump everything at once.
- Default to NOT rewriting the recipe — keep \`revised_recipe\` null while you diagnose.
- BUT if the cook asks you to update or emphasize the recipe based on what went wrong, set \`revised_recipe\` to a COMPLETE revised recipe (every field) that rewrites the relevant METHOD step(s) to emphasize the critical detail(s) they missed — the exact measurement, temperature, timing, or technique cue that caused the failure — wording it so the mistake won't recur (a short "Important:" or "Be precise:" lead-in within the step text is good; do NOT use markdown like ** **). Change only what's needed to make those steps clear; carry everything else over unchanged, and append one line to \`notes\` starting "AI tweaked: " naming what you emphasized. In \`reply\`, briefly say what you changed. Keep \`needs_more_info\` false.`;

const TWEAK_PROMPT = `You are an expert cook helping someone ADJUST, SCALE, or do the MATH on a recipe they already have. That covers: improving balance (too sweet/salty, fixing what's missing, better technique); scaling up or down — to a serving count OR to how much of a core ingredient they have (e.g. "I have 8 limes"); converting units; computing ingredient yields (e.g. how much peel/juice a lime gives); and swapping ingredients. You answer by calling the \`respond\` tool every turn.

You are in a back-and-forth conversation.
- If the request is genuinely vague (e.g. "it's missing something"), ask ONE focused clarifying question first — \`reply\` holds the question, \`needs_more_info\` true, \`suggestions\` empty, \`revised_recipe\` null. A scaling/quantity question is NOT vague; answer it directly.
- For an improvement request, give concrete advice in \`reply\` and short bullets in \`suggestions\`: exact amount changes, additions, technique fixes, and briefly why each helps. Respect the cook's recipe — change the minimum needed.
- For a SCALING or QUANTITY question, do the arithmetic: recompute EVERY amount proportionally, update \`base_servings\`/\`servings_label\` to match, and set \`revised_recipe\` to the fully scaled recipe; in \`reply\` show the key numbers (e.g. "8 limes ≈ 48 g peel, so ~0.5× the batch — here it is halved"). For a YIELD/CONVERSION question, STATE the typical yield you assumed (e.g. "~6 g peel and ~30 ml juice per lime") so they can adjust, and compute from it.
- When you return a changed recipe, set \`revised_recipe\` to a COMPLETE recipe (every field), carrying over everything you did NOT change unchanged, and append one line to \`notes\` starting "AI adjusted: " naming what changed (e.g. "AI adjusted: scaled to 8 limes (~0.5x)"). Otherwise \`revised_recipe\` null. Set \`needs_more_info\` false whenever you give a real answer.
- Keep replies warm and concise.`;

// Appended to either mode prompt when the client sent kitchen context.
const KITCHEN_PROMPT = `

THE COOK'S KITCHEN: below the recipe you are given what the cook has in their pantry and bar, and a list of their other saved recipes.
- When you suggest a substitution, addition, or adjustment, prefer things they have IN STOCK, and say so ("you have sherry vinegar — use that"). Everyday staples (salt, pepper, oil, water, sugar, flour, butter) can be assumed even if unlisted. The list is not exhaustive, so don't refuse a sensible suggestion just because an item isn't listed — but if it needs something marked OUT, point that out.
- The recipe list is names only. If the cook refers to another of their recipes, or borrowing from one would genuinely help (its sauce, its dough, its ratios), call \`get_recipe\` with the exact name from the list to read it, then answer. Don't look recipes up when the question doesn't need them.
- Don't recite the inventory or recipe list back; use them quietly.`;

type KitchenContext = { pantry: string[]; bar: string[]; out: string[]; recipes: { name: string; section: string }[] };

function cleanNames(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const s = x.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// Sanitize the client's kitchen context; null when nothing usable was sent.
function sanitizeContext(raw: unknown): KitchenContext | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const recipes: KitchenContext["recipes"] = [];
  if (Array.isArray(c.recipes)) {
    for (const r of c.recipes) {
      const name = typeof r?.name === "string" ? r.name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) : "";
      if (name) recipes.push({ name, section: r?.section === "bar" ? "bar" : "kitchen" });
      if (recipes.length >= MAX_RECIPE_INDEX) break;
    }
  }
  const ctx = {
    pantry: cleanNames(c.pantry, MAX_STOCK_ITEMS),
    bar: cleanNames(c.bar, MAX_STOCK_ITEMS),
    out: cleanNames(c.out, MAX_STOCK_ITEMS),
    recipes
  };
  return ctx.pantry.length || ctx.bar.length || ctx.out.length || ctx.recipes.length ? ctx : null;
}

function buildKitchenBlock(ctx: KitchenContext) {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(nothing recorded)");
  const kitchen = ctx.recipes.filter((r) => r.section !== "bar").map((r) => r.name);
  const bar = ctx.recipes.filter((r) => r.section === "bar").map((r) => r.name);
  return [
    "THE COOK'S KITCHEN (live from their app):",
    `Pantry, in stock: ${list(ctx.pantry)}`,
    `Bar, in stock: ${list(ctx.bar)}`,
    `Marked OUT: ${list(ctx.out)}`,
    "",
    "Their other saved recipes (names only — use get_recipe to read one):",
    `Kitchen: ${kitchen.length ? kitchen.join("; ") : "(none)"}`,
    `Bar: ${bar.length ? bar.join("; ") : "(none)"}`
  ].join("\n");
}

const GET_RECIPE_TOOL = {
  name: "get_recipe",
  description: "Read one of the cook's other saved recipes (full ingredients, method, notes) by name. Use only when the answer needs that recipe's details.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "The recipe's name, exactly as it appears in the list of the cook's saved recipes." } },
    required: ["name"]
  }
};

// Fetch a recipe by name with the caller's own client, so RLS limits it to
// recipes this user can see. Exact (case-insensitive) match first, then a
// contains match. Returns the text handed back to the model.
// deno-lint-ignore no-explicit-any
async function lookupRecipe(client: any, rawName: unknown): Promise<string> {
  const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_NAME_CHARS) : "";
  if (!name) return "No recipe name was given.";
  const pattern = name.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  try {
    let { data } = await client.from("recipes").select("*").ilike("name", pattern).limit(1);
    if (!data?.length) {
      ({ data } = await client.from("recipes").select("*").ilike("name", `%${pattern}%`).limit(1));
    }
    const r = data?.[0];
    if (!r) return `No saved recipe named "${name}" was found.`;
    return JSON.stringify({
      name: r.name, subtitle: r.subtitle, section: r.section, tags: r.tags,
      base_servings: r.base_servings, servings_label: r.servings_label,
      ingredients: r.ingredients, method: r.method, notes: r.notes
    }).slice(0, MAX_LOOKUP_CHARS);
  } catch (err) {
    console.error("recipe-coach: get_recipe failed:", err);
    return "That recipe couldn't be read right now.";
  }
}

function buildSystemPrompt(mode: string, recipe: unknown, hasKitchen: boolean) {
  const base = (mode === "tweak" ? TWEAK_PROMPT : TROUBLESHOOT_PROMPT) + (hasKitchen ? KITCHEN_PROMPT : "");
  let recipeJson = "";
  try {
    recipeJson = JSON.stringify(recipe, null, 2).slice(0, 12_000);
  } catch {
    recipeJson = "(recipe could not be read)";
  }
  const heading = mode === "tweak" ? "The recipe to improve" : "The recipe the cook made";
  return `${base}\n\n${heading} (for context — the cook can see it on screen):\n${recipeJson}`;
}

// Sanitize the client's conversation into Anthropic's messages array: only
// user/assistant roles, string content, trimmed and length-capped, and it must
// end with a user turn (we never ask the model to answer its own message).
function sanitizeMessages(raw: unknown): { role: string; content: string }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { role: string; content: string }[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = typeof m?.content === "string" ? m.content.trim().slice(0, MAX_MESSAGE_CHARS) : "";
    if (!role || !content) continue;
    out.push({ role, content });
  }
  if (out.length === 0 || out[out.length - 1].role !== "user") return null;
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return json({ error: "Server isn’t configured for AI yet (missing API key)." });
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
    const mode = body.mode === "tweak" ? "tweak" : body.mode === "troubleshoot" ? "troubleshoot" : null;
    if (!mode) return json({ error: "Invalid request." });
    if (!body.recipe || typeof body.recipe !== "object") return json({ error: "No recipe was provided." });
    const messages = sanitizeMessages(body.messages);
    if (!messages) return json({ error: "No question was received." });
    const kitchen = sanitizeContext(body.context);
    const canLookup = !!kitchen?.recipes.length;

    // Enforce the coach's own per-user daily cap right before the paid call.
    // Fails open (logs and proceeds) if the SQL migration hasn't been run yet.
    const { data: usageResult, error: usageError } = await supabaseClient
      .rpc("increment_coach_usage", { daily_limit: DAILY_COACH_LIMIT });
    if (!usageError && usageResult === -1) {
      return json({ error: `You’ve used today’s ${DAILY_COACH_LIMIT} AI coaching requests — it resets at midnight UTC. Try again tomorrow.` });
    }
    if (usageError) console.error("coach_usage check failed:", usageError);

    // Cache the system prefix (mode prompt + the recipe JSON + the kitchen
    // context, all constant across a session's turns) together with the tool
    // schemas that render ahead of it. A troubleshoot/tweak session is several
    // turns within minutes, so turns 2+ read this prefix at ~10% instead of
    // re-billing it every turn. The growing `messages` history sits after this
    // breakpoint, so it never invalidates the cache. Sonnet 4.6's min cacheable
    // prefix is 2048 tokens, which the tool schema + a real recipe clears.
    const system: Record<string, unknown>[] = [{ type: "text", text: buildSystemPrompt(mode, body.recipe, !!kitchen) }];
    if (kitchen) system.push({ type: "text", text: buildKitchenBlock(kitchen) });
    system[system.length - 1].cache_control = { type: "ephemeral" };

    const respondTool = { name: "respond", description: "Reply to the cook with a clarifying question or your advice.", input_schema: COACH_SCHEMA };
    const tools = canLookup ? [respondTool, GET_RECIPE_TOOL] : [respondTool];

    // One cook message = one counted request, however many lookups it takes.
    // Each round the model either reads another recipe (get_recipe) or answers
    // (respond); once the lookup budget is spent it is forced to answer.
    // deno-lint-ignore no-explicit-any
    const convo: any[] = [...messages];
    // deno-lint-ignore no-explicit-any
    let result: any = null;
    for (let lookups = 0; ; lookups++) {
      const mayLookup = canLookup && lookups < MAX_RECIPE_LOOKUPS;
      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: MODEL_COACH,
          max_tokens: 4096,
          system,
          tools,
          tool_choice: mayLookup
            ? { type: "any", disable_parallel_tool_use: true }
            : { type: "tool", name: "respond" },
          messages: convo
        })
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        console.error("Anthropic API error:", anthropicRes.status, errText);
        const friendly = anthropicRes.status === 429
          ? "Rate limit or usage limit reached — try again later."
          : "The AI coach failed. Please try again.";
        return json({ error: friendly });
      }

      const anthropicData = await anthropicRes.json();
      if (anthropicData.stop_reason === "max_tokens") {
        console.error("recipe-coach: response truncated at max_tokens");
        return json({ error: "That answer got too long — try narrowing the question." });
      }
      const toolBlock = anthropicData.content?.find((c: { type: string }) => c.type === "tool_use");
      if (mayLookup && toolBlock?.name === "get_recipe") {
        const found = await lookupRecipe(supabaseClient, toolBlock.input?.name);
        convo.push({ role: "assistant", content: anthropicData.content });
        convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolBlock.id, content: found }] });
        continue;
      }
      result = toolBlock?.name === "respond" ? toolBlock.input : null;
      break;
    }

    if (!result || typeof result.reply !== "string" || !result.reply.trim()) {
      return json({ error: "The AI coach couldn’t form a reply. Please try again." });
    }

    // Normalize for the client: troubleshoot mode never carries a revised recipe.
    return json({
      result: {
        reply: result.reply,
        needs_more_info: !!result.needs_more_info,
        suggestions: Array.isArray(result.suggestions) ? result.suggestions.filter((s: unknown) => typeof s === "string" && s.trim()) : [],
        revised_recipe: result.revised_recipe && typeof result.revised_recipe === "object"
          ? result.revised_recipe
          : null
      }
    });
  } catch (err) {
    console.error("recipe-coach error:", err);
    return json({ error: "Something went wrong. Please try again." });
  }
});

// Always responds 200 so the browser's functions.invoke() reads { result } or { error }.
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "content-type": "application/json" }
  });
}
