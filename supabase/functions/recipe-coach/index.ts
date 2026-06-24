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
//     messages: [{ role: "user" | "assistant", content: "<text>" }, ...] }
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

const TWEAK_PROMPT = `You are an expert cook helping someone improve a recipe they already have — making it less sweet or salty, fixing balance, adding what's missing, or improving technique. You answer by calling the \`respond\` tool every turn.

You are in a back-and-forth conversation.
- If the request is vague (e.g. "it's missing something"), ask ONE focused clarifying question first (what flavor or texture feels off?) — \`reply\` holds the question, \`needs_more_info\` true, \`suggestions\` empty, \`revised_recipe\` null.
- Otherwise give concrete, specific advice in \`reply\` and as short bullets in \`suggestions\`: name exact amount changes, additions, and method/technique improvements, and briefly say why each helps. Respect the cook's recipe — change the minimum needed.
- When a rewrite would genuinely help and you have enough information, set \`revised_recipe\` to a COMPLETE revised recipe (every field), carrying over everything you are NOT changing unchanged, and append one line to \`notes\` starting "AI tweaked: " naming what you changed. Otherwise set \`revised_recipe\` to null. Set \`needs_more_info\` false whenever you give real suggestions.
- Keep replies warm and concise.`;

function buildSystemPrompt(mode: string, recipe: unknown) {
  const base = mode === "tweak" ? TWEAK_PROMPT : TROUBLESHOOT_PROMPT;
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

    // Enforce the coach's own per-user daily cap right before the paid call.
    // Fails open (logs and proceeds) if the SQL migration hasn't been run yet.
    const { data: usageResult, error: usageError } = await supabaseClient
      .rpc("increment_coach_usage", { daily_limit: DAILY_COACH_LIMIT });
    if (!usageError && usageResult === -1) {
      return json({ error: `You’ve used today’s ${DAILY_COACH_LIMIT} AI coaching requests — it resets at midnight UTC. Try again tomorrow.` });
    }
    if (usageError) console.error("coach_usage check failed:", usageError);

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
        system: buildSystemPrompt(mode, body.recipe),
        tools: [{ name: "respond", description: "Reply to the cook with a clarifying question or your advice.", input_schema: COACH_SCHEMA }],
        tool_choice: { type: "tool", name: "respond" },
        messages
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
    const toolBlock = anthropicData.content?.find((c: { type: string }) => c.type === "tool_use");
    const result = toolBlock?.input;

    if (anthropicData.stop_reason === "max_tokens") {
      console.error("recipe-coach: response truncated at max_tokens");
      return json({ error: "That answer got too long — try narrowing the question." });
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
