// Supabase Edge Function: identify-bottle
//
// "Look up a bottle" → photograph the label. Claude reads what's printed on it
// (brand, expression, age, ABV/proof, batch, category) and returns it as
// structured JSON; the app then matches that against the spirits catalog with
// spirit_candidates (README "Bottles: looking a bottle up in the app"). Matching
// stays in the app so a typed name never needs this function at all.
//
// Mirrors the other functions: forced tool_choice with a strict schema, the
// Anthropic key stays server-side, the caller's JWT is verified, and a per-user
// daily cap (increment_bottle_usage 'scan') is checked before the paid call. It
// fails open if the cap RPC isn't set up yet, like the others.
//
// Request body (JSON): { image: base64 (no data: prefix), media_type?: "image/jpeg" }
// Response: always HTTP 200 — { label: {...} } | { error }

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// The same vision model extract-recipe uses for photos. Haiku 4.5 misread a
// "BANKS 5 ISLAND BLEND" label as "Barbancourt Island Blend 5" (2026-11-09):
// small or stylised label type needs the stronger eye. About a cent a photo.
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";
const DAILY_SCAN_LIMIT = 40;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
function supabaseClientKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const key = typeof keys.default === "string" ? keys.default : Object.values(keys).find((v) => typeof v === "string");
    if (key) return key as string;
  } catch { /* unset or not JSON — use the legacy key */ }
  return Deno.env.get("SUPABASE_ANON_KEY")!;
}
const SUPABASE_CLIENT_KEY = supabaseClientKey();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// KEEP IN SYNC with app.js BAR_CATEGORIES.
const BAR_CATEGORIES = ["gin", "vodka", "rum", "tequila", "mezcal", "whiskey", "bourbon", "rye", "scotch", "brandy", "liqueur", "vermouth", "amaro", "bitters", "wine", "mixer", "other"];

const LABEL_SCHEMA = {
  type: "object",
  properties: {
    printed_words: { type: "string", description: "The large words on the front label exactly as printed, in reading order — brand, expression, age, proof (e.g. 'BANKS 5 ISLAND BLEND RUM'). A transcription, not a name you know." },
    readable: { type: "boolean", description: "False when the photo isn't a bottle label, or the brand can't be read." },
    full_name: { type: "string", description: "Brand plus expression as a shopper would say it — 'Elijah Craig Small Batch', 'Lagavulin 16 Year Old', 'Green Chartreuse'. Empty when unreadable." },
    brand: { type: ["string", "null"] },
    expression: { type: ["string", "null"], description: "The specific bottling (Small Batch, Reposado, 16 Year Old, Cask Strength…), or null." },
    category: { type: "string", enum: BAR_CATEGORIES, description: "Closest category from the fixed list; bourbon/rye/scotch over plain whiskey when the label says so." },
    age_years: { type: ["integer", "null"], description: "Only an age statement printed on the label." },
    abv: { type: ["number", "null"], description: "Percent alcohol by volume as printed (or proof / 2)." },
    proof: { type: ["number", "null"] },
    batch: { type: ["string", "null"], description: "Batch or barrel code as printed (e.g. 'C925', 'Batch 12'), or null." },
    single_barrel: { type: "boolean" },
    country: { type: ["string", "null"] }
  },
  required: ["printed_words", "readable", "full_name", "brand", "expression", "category", "age_years", "abv", "proof", "batch", "single_barrel", "country"]
};

const LABEL_PROMPT = `You read spirits bottle labels for a home-bar app. Report only what is printed on the label in the photo — never fill in a brand, age, proof or batch from memory. First transcribe the large front-label words exactly as printed (printed_words). Then build full_name ONLY from those words: brand + expression the way a shopper would say it, without filler like "Kentucky Straight" when the brand is clear. Never substitute a brand you know for the one printed — a label reading "BANKS" is Banks, even if another brand makes a similar bottle. If the label is partly hidden, report what you can read. If the photo isn't a spirits label, or the brand can't be read, set readable to false. Call read_label once.`;

// deno-lint-ignore no-explicit-any
function strictify(node: any): any {
  if (Array.isArray(node)) return node.map(strictify);
  if (node && typeof node === "object") {
    // deno-lint-ignore no-explicit-any
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "maxItems" || k === "minItems") continue;
      out[k] = strictify(v);
    }
    if (out.type === "object" && out.properties) out.additionalProperties = false;
    return out;
  }
  return node;
}

// deno-lint-ignore no-explicit-any
async function readLabel(image: string, mediaType: string): Promise<{ input?: any; error?: string }> {
  const send = (strict: boolean) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY!, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: LABEL_PROMPT,
      tools: [strict
        ? { name: "read_label", description: "Return what the label says.", input_schema: strictify(LABEL_SCHEMA), strict: true }
        : { name: "read_label", description: "Return what the label says.", input_schema: LABEL_SCHEMA }],
      tool_choice: { type: "tool", name: "read_label" },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: "Read this bottle's label and call read_label." }
        ]
      }]
    })
  });
  let res = await send(true);
  if (res.status === 400) {
    console.error("strict tool schema rejected — retrying without strict:", (await res.text()).slice(0, 300));
    res = await send(false);
  }
  if (!res.ok) {
    console.error("Anthropic API error:", res.status, await res.text());
    return { error: res.status === 429 ? "Rate limit or usage limit reached — try again later." : "Couldn’t read that label. Please try again." };
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") return { error: "The AI declined that photo — try another." };
  const toolBlock = data.content?.find((c: { type: string }) => c.type === "tool_use");
  return { input: toolBlock?.input };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    if (!ANTHROPIC_API_KEY) return json({ error: "Server isn’t configured for label reading yet (missing API key)." });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Please sign in first." });
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_CLIENT_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Please sign in first." });

    const body = await req.json().catch(() => ({}));
    const image = typeof body.image === "string" ? body.image : "";
    if (!image) return json({ error: "No photo was sent." });
    if (image.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "That photo is too large — try again." });
    const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.media_type) ? body.media_type : "image/jpeg";

    const { data: usage, error: usageError } = await supabaseClient
      .rpc("increment_bottle_usage", { usage_kind: "scan", daily_limit: DAILY_SCAN_LIMIT });
    if (!usageError && usage === -1) {
      return json({ error: `You’ve read today’s ${DAILY_SCAN_LIMIT} labels — it resets at midnight UTC. Type the name instead; that’s always free.` });
    }
    if (usageError) console.error("bottle_usage check failed:", usageError);

    const { input, error } = await readLabel(image, mediaType);
    if (error) return json({ error });
    if (!input || typeof input !== "object") return json({ error: "Couldn’t read that label. Please try again." });
    if (!input.readable || !String(input.full_name || "").trim()) {
      return json({ error: "Couldn’t make out a label in that photo — try straight on, closer, or type the name." });
    }
    const label = {
      full_name: String(input.full_name).trim().slice(0, 200),
      printed_words: String(input.printed_words || "").trim().slice(0, 300),
      brand: input.brand || null,
      expression: input.expression || null,
      category: BAR_CATEGORIES.includes(input.category) ? input.category : "other",
      age_years: Number.isInteger(input.age_years) && input.age_years > 0 && input.age_years < 80 ? input.age_years : null,
      abv: typeof input.abv === "number" && input.abv > 0 && input.abv < 100 ? input.abv
        : (typeof input.proof === "number" && input.proof > 0 && input.proof < 200 ? Math.round(input.proof / 2 * 100) / 100 : null),
      proof: typeof input.proof === "number" && input.proof > 0 && input.proof < 200 ? input.proof : null,
      batch: input.batch ? String(input.batch).trim().slice(0, 40) : null,
      single_barrel: input.single_barrel === true,
      country: input.country || null
    };
    return json({ label });
  } catch (err) {
    console.error("identify-bottle error:", err);
    return json({ error: "Something went wrong. Please try again." });
  }
});

// Always responds 200 so the browser's functions.invoke() reads the body either way.
function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, "content-type": "application/json" } });
}
