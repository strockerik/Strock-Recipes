# Running an Open-Weights LLM on/near Supabase for "House Index": Feasibility & Implementation Guide

## TL;DR
- **No — you cannot run a real generative open LLM *inside* hosted Supabase.** Supabase Edge Functions ship exactly one native model (the `gte-small` embedding model); the `Supabase.ai.Session` generative path (Llama/Mistral) requires *your own* Ollama/Llamafile server, and Supabase's promised managed hosted LLM API is still invite-only/early-access as of mid-2026 — not GA. The realistic pattern is: Edge Function → external open-model API (Groq/DeepInfra/Cloudflare) for the cheap tier, Anthropic for the hard tier.
- **At your volume (~130–200 ops/month, ~$1/month), a hybrid open-model tier saves roughly $0.50–$0.90/month and is not worth building for cost reasons.** Build it only for the non-cost payoffs (learning, speed, a free-tier safety net, avoiding single-vendor lock-in). The break-even where engineering effort pays back is roughly 100–300× your current volume.
- **Do this instead:** keep Claude for vision OCR and the Hero Ingredient generator; move the truly mechanical "small tasks" (ingredient parsing, unit conversion, grocery dedup, kitchen/bar split) to *plain deterministic code* (zero AI cost, zero latency); and if you want a cheap LLM tier, add ONE config-driven provider (Groq or Cloudflare Workers AI free tier) behind a validate-and-escalate wrapper.

---

## Key Findings

1. **Supabase hosts exactly one model natively: `gte-small` (384-dim text embeddings), and it is genuinely GA on hosted Edge Functions.** It runs on CPU via a Rust/ONNX (Ort) runtime, costs nothing extra beyond CPU time, and typically finishes in <1s even cold. It is English-only and truncates inputs beyond 512 tokens. On the MTEB leaderboard it averages 61.36 (across 56 tasks), close to OpenAI's text-embedding-3-small at 62.26 — a genuinely useful, free option for *semantic recipe search* stored in pgvector, but not for extraction or generation.

2. **Generative LLMs on Supabase are self-host-only today.** `new Supabase.ai.Session('mistral')` works only when you point the `AI_INFERENCE_API_HOST` secret at your own Ollama or Llamafile server. The docs (last modified May 8, 2026) still say the managed hosted LLM API is "progressively rolling out" and gated behind an early-access form; a review of Supabase's 2026 changelogs found no GA announcement. So "run Llama on Supabase's GPUs" is not a shippable option for you right now.

3. **Edge Function limits make in-function inference impractical anyway.** Hosted Edge Functions cap you at ~256 MB memory, a 2-second CPU-time hard limit (async I/O waiting doesn't count), a 400-second wall-clock limit, and no GPU. That's fine for *orchestrating* an external API call (the waiting is I/O, not CPU) but fatally small for running a model in-process.

4. **You cannot run PostgresML/pgml inside Supabase's managed Postgres.** Supabase's managed platform uses a fixed allowlist of ~64 extensions (pgvector, pg_net, pg_cron, pgmq, etc.); self-hosting unlocks 450+ (Pigsty ships up to 531), but that defeats the purpose for you. `pgml` is not on the managed list. The AI-relevant extensions you *do* get — pgvector (vector search), pg_net (HTTP from SQL), pg_cron (scheduling), pgmq (queues) — let you *call out* to model APIs or store embeddings, not host a model.

5. **The cheap-open-model API market is mature, fast, and extremely cheap.** For text tasks, Llama 3.1 8B Instant runs $0.05/$0.08 per 1M tokens on Groq (its lowest-cost tracked model) and the same on DeepInfra; GPT-OSS-20B is $0.075/$0.30; GPT-OSS-120B is as low as $0.037/$0.10 on DeepInfra. Several providers have genuinely free tiers (Groq, Cerebras 1M tokens/day, OpenRouter `:free` models, Cloudflare 10k neurons/day).

6. **Cloudflare Workers AI is the best "it pairs with my stack" option** if your frontend is on Cloudflare Pages: 10,000 neurons/day free forever (Cloudflare estimates ≈1,300 LLM responses), then $0.011/1,000 neurons, and it now has vision-capable models (Llama 3.2 11B Vision, Llama 4 Scout, Moondream 3 with explicit OCR, LLaVA, Gemma). But it's a separate API call from Supabase either way — being "on Cloudflare" doesn't remove the cross-service hop.

7. **Small open models CAN reliably produce schema-valid JSON — but only with schema-constrained decoding, which not all providers offer.** Groq and Fireworks offer true `strict` JSON-schema constrained decoding; that's what makes an 8B model dependable for your tag/normalize tasks. Without constrained decoding, small models (especially <4B) fail in specific ways ("schema echo," under-extraction).

8. **For handwriting OCR, cheap open vision models are materially worse than Claude.** In a controlled OCR study, Llama-3.2-11B-Vision held 93%+ word accuracy on real handwritten documents while smaller Qwen2.5-VL variants fell far behind — and Claude Haiku is generally stronger still. (Caveat: that specific study was a low-resource Manchu-script case, not generic English handwriting — the ordering is indicative, not a precise English number.) Your photo-of-a-recipe-card task is exactly the one to keep on Claude.

9. **Several of your "AI small tasks" don't need AI at all.** Ingredient parsing, unit conversion, grocery-list dedup, and kitchen-vs-bar tagging are solvable with deterministic libraries/rules at zero cost and zero latency.

---

## Details

### A. What Supabase actually supports (mid-2026)

**Native inference API (`Supabase.ai`).** There are two very different things behind one API:
- **Embeddings (`gte-small`)** — GA everywhere (local, hosted, self-hosted). Runs on CPU through a native Ort/ONNX runtime, no external dependency. Per Supabase's own blog: "Generating embeddings in an Edge Function doesn't cost anything extra: we still charge on CPU usage. A typical embedding generation request should run in less than a 1s, even from a cold start. Typically it won't use more than 100-200ms of CPU time." English-only, 512-token cap, 384 dimensions. Great for recipe semantic search in pgvector.
- **Generative LLMs (`Supabase.ai.Session('mistral')` etc.)** — you must run your *own* Ollama/Llamafile server and set `AI_INFERENCE_API_HOST`. The managed, Supabase-hosted GPU LLM API is still early-access/invite-only; docs use future tense ("a hosted LLM API *will be* provided"). **Verdict: not a production option for a hobbyist.**

**Edge Function runtime limits (hosted):**
- Memory: ~256 MB per function.
- CPU time: **2 seconds hard limit** (compute only; I/O waiting excluded). This is why calling an external LLM API is fine (mostly I/O) but running a model is not.
- Wall clock: **400 seconds**; request idle timeout 150s (504 if no response).
- Bundle size: 20 MB (CLI-bundled) or 5 MB (dashboard/API).
- No GPU. Cold starts exist; design for short, idempotent calls.

**Other Supabase AI surface area:** the AI Assistant in the dashboard is a build-time helper, not a runtime inference product. Relevant Postgres extensions on the managed allowlist: **pgvector** (store/search embeddings), **pg_net** (async HTTP from SQL — can call an LLM API from a trigger), **pg_cron** (schedule jobs), **pgmq** (queue). None host a model. **pgml/PostgresML is NOT installable on managed Supabase.**

### B. Alternative architectures for a cheap small-model tier

**B1. Hosted open-model APIs (recommended path).** Pay-per-token, OpenAI-compatible, no infra. Representative small-model pricing (USD per 1M tokens, input/output), mid-2026:

| Provider | Representative small model | Price in/out (per 1M) | Free tier | Notes |
|---|---|---|---|---|
| Groq | Llama 3.1 8B Instant | $0.05 / $0.08 | Yes (30 RPM, 14,400 req/day, 500k tok/day on 8B) | Fastest (500+ tok/s); **strict JSON-schema** constrained decoding |
| Groq | GPT-OSS-20B | $0.075 / $0.30 | Yes | Fast + cheap middle tier |
| Groq | GPT-OSS-120B | $0.15 / $0.60 | Yes | Near-frontier open reasoning |
| DeepInfra | Llama 3.1 8B | $0.05 / $0.08 | $1 credit | Usually cheapest; postpaid, no free *tier* |
| DeepInfra | GPT-OSS-120B | $0.037 / $0.10 | — | Cheapest 120B |
| DeepInfra | Qwen2.5-72B | ~$0.20 blended | — | Strong JSON/instruction following |
| Fireworks | Llama/Qwen/etc. | varies | $1 credit | **Strict JSON-schema + BNF grammar** mode |
| Together AI | Llama 3.1 8B | $0.18 / $0.20 | credits | Broad catalog |
| Cerebras | GPT-OSS-120B etc. | subscription tiers | **1M tokens/day free** | ~3,000 tok/s, fastest throughput |
| OpenRouter | many `:free` IDs | $0 (rate-limited) | 20 RPM, 50–1000/day | One key, many providers; 5.5% credit fee on paid |
| Cloudflare Workers AI | Llama/Qwen/Gemma/GPT-OSS + vision | neurons; $0.011/1k | **10,000 neurons/day free** | Pairs with Cloudflare Pages; vision models incl. OCR |

Setup difficulty with Claude Code: **low.** All are OpenAI-compatible except Anthropic — usually a base-URL + key change. Latency: Groq/Cerebras are near-instant; DeepInfra/Together are slower but fine for a recipe app. At your ~150–200 calls/month, **every one of these is effectively free** (free tiers alone cover you many times over).

**B2. Cloudflare Workers AI specifically.** Neuron-based billing per Cloudflare docs: "Workers AI is included in both the Free and Paid Workers plans and is priced at $0.011 per 1,000 Neurons ... 10,000 Neurons per day at no charge ... limits reset daily at 00:00 UTC." Catalog ~81 models incl. Llama 3.x/4, Qwen, Gemma, Mistral, GPT-OSS, plus vision models: **Llama 3.2 11B Vision (`@cf/meta/llama-3.2-11b-vision-instruct`), Llama 4 Scout (multimodal), Moondream 3 (`@cf/moondream/moondream3.1-9B-A2B`, explicit OCR + structured output), LLaVA-1.5-7B, Gemma 3/4, Mistral Small 3.1**. It integrates with Supabase like any other API (fetch from the Edge Function). Being on Cloudflare Pages gives unified billing/dashboard but no architectural shortcut — it's still a cross-service HTTP call.

**B3. Self-hosting on a VPS/GPU (NOT recommended for you).** Ollama/vLLM on a rented GPU box, or serverless GPU (Modal, RunPod, Replicate, Beam, Baseten). A dedicated GPU VPS is roughly $200–$500+/month and always-on; absurd for ~150 calls. Serverless GPU scales to zero and bills per second, but cold starts are the killer: RunPod serverless commonly ~10–30s+ cold (FlashBoot gets ~200ms for a minority of requests); Modal's alpha GPU snapshots can cut this ~10×. For a recipe app queried a few times a day, you'd hit a cold start almost every time. **Skip it.**

**B4. In-browser via WebGPU/WebLLM/Transformers.js on the iPhone PWA (mostly not viable).** Good news: iOS 26 / Safari 26 shipped full WebGPU on iPhone (Metal-backed), so it's *technically* on. Bad news for a PWA: practical model ceiling is ~1–3B params, weights are a **2–5 GB one-time download** cached in IndexedDB, and mobile Safari has tight memory/buffer limits that make 7B+ unreliable on a phone. For *tiny* tasks you'd be better served by plain JS. WebLLM is a fun experiment, not a dependable tier for 10 users on iPhones with varying storage. (The "27B in 4GB on a phone" claims circulating in 2026 are vendor marketing, not something to build on.)

**B5. Non-LLM alternatives (do this for the mechanical tasks).**
- **Ingredient string → {amount, unit, item}:** the `ingredient-parser-nlp` Python package (CRF-based) reports on its own PyPI page "A data set of 75,000 example sentences is used to train and evaluate the model ... Sentence-level results: Accuracy: 95.86% ... Word-level results: Accuracy 98.41%." NYT's `ingredient-phrase-tagger` (CRF) and `PyIng` (LSTM) are the same lineage. In a Deno/TS Edge Function you'd write a regex/lookup parser (numbers + Unicode fractions → amount; match against a unit vocabulary → unit; remainder → item). This handles the overwhelming majority of real recipe lines.
- **Unit conversion:** pure lookup table (g↔oz, ml↔cup, tsp↔tbsp, etc.). Zero AI.
- **Grocery-list dedup/merge ("2 cloves garlic" + "1 clove garlic" → "3 cloves garlic"):** normalize item name (lowercase, singularize, alias map) + sum amounts when units match; keep separate when units differ. Deterministic.
- **Kitchen vs. bar categorization:** keyword/heuristic classifier (spirit/liqueur/bitters/mixer vocab → bar; else kitchen). A `gte-small` embedding + nearest-centroid is a fancier fallback, still free on Supabase.
- **Tag suggestion & subtitle:** genuinely generative/fuzzy — a cheap LLM is a reasonable fit, but a keyword+category heuristic covers a lot.
- **Search query understanding:** `gte-small` embeddings + pgvector similarity gives you semantic search with no external LLM.

### C. Hybrid routing design

**Established patterns.** Two families: (1) **routing/classification** — decide up front which model handles a request (cheapest is a rule-based task label, which you already have since your app knows the task type); (2) **cascade/fallback** — send to the cheap model first, and *escalate* to the strong model when output fails validation or confidence is low. Tooling exists (RouteLLM for research-grade routing, LiteLLM as a proxy with fallback/budget, vLLM Semantic Router, OpenRouter/Portkey/Cloudflare AI Gateway), but **for 10 users you do not need any framework** — a `switch` on task type plus a try/validate/escalate block is the entire design. Published case studies report 40–85% blended cost cuts from routing at scale, but those assume high volume and quality monitoring; the pattern's value for you is architectural cleanliness and a free fallback, not dollars.

**Recommended tier map for your tasks:**

| Task | Recommended tier | Why |
|---|---|---|
| (a) Photo/handwriting OCR → JSON | **Claude (Haiku 4.5, vision)** | Handwriting OCR is where cheap VLMs collapse; keep quality high |
| (b) URL extraction | **JSON-LD parse first (free) → cheap LLM fallback** | Deterministic schema.org covers most recipe sites; LLM only on misses |
| (c) Pasted messy text → JSON | **Cheap open model w/ strict JSON schema (Groq)** | Text-only structured extraction is an 8B-class task |
| (d) Hero Ingredient generator | **Claude (Haiku or Sonnet)** | Most creative/quality-sensitive; the one users judge |
| (e) Tags/subtitle/normalize/dedup/convert/categorize | **Deterministic code first; cheap LLM only for tags/subtitle** | Most are pure code; only fuzzy bits touch an LLM |

**Quality / structured output.** Independent 2026 testing found 14/23 providers passed schema-conformant structured output on every model/endpoint, including Anthropic, Fireworks, Groq, Mistral, and Alibaba (Qwen). Prefer providers with **`strict: true` constrained decoding** (Groq, Fireworks) for your JSON tasks — with schema enforcement, even small-model invalid-JSON rates drop below ~1%. Anthropic implements structured output via forced tool-use with an `input_schema` (JSON Schema), which Claude Code can wire up. Beware `<4B` models: they show elevated "schema echo"/under-extraction failures — stay in the 8B–32B class (or GPT-OSS-20B/120B) for extraction.

**Vision specifics.** For your card/cookbook OCR: for *printed* pages, Qwen2.5-VL-7B, Llama 3.2 11B Vision, Pixtral, or Cloudflare's Moondream 3 (explicit OCR) are usable and cheap. For *handwriting*, quality drops sharply (in a controlled study Llama-3.2-11B-Vision held 93%+ word accuracy on real handwritten documents while smaller Qwen-VL variants trailed badly), so keep handwriting on Claude. A cost-saving pre-processing alternative: dedicated OCR (Apple's on-device Vision framework — free, on the iPhone; Mistral OCR at ~$2/1,000 pages, batch ~$1; Google Cloud Vision; Tesseract) to extract text, then feed the text to a cheap *text-only* LLM for structuring. Apple Vision on-device is the sleeper option — free, private, already on every user's iPhone — though it too is weak on messy handwriting.

### D. Honest cost-benefit for your specific case

**The money.** Your current Anthropic bill is ~$0.75–$1.20/month for ~130–200 ops. Claude Haiku 4.5 is $1/$5 per 1M tokens. If you moved the *eligible* text tasks (say ~60–70% of ops that aren't vision or creative generation) to a free-tier open model, you'd save on the order of **$0.50–$0.90/month** — and likely land at **$0 for the cheap tier** because Groq/Cerebras/Cloudflare free tiers alone cover 150–200 calls/month many times over. **Blunt truth: the cost saving is a rounding error, and it is not a reason to build this.**

**Non-cost reasons that *are* legitimate:**
- **Learning value** — building a clean provider-router is a genuinely useful skill and this is a low-stakes place to learn it.
- **Speed** — Groq/Cerebras are dramatically faster than frontier models; tag suggestion or query parsing can feel instant.
- **A free safety net / rate-limit resilience** — a fallback provider means an Anthropic hiccup doesn't break the app.
- **Avoiding single-vendor lock-in** — config-driven model selection lets you move any task in one line.
- **Privacy/data locality** — only really achieved with self-hosting or on-device (Apple Vision, WebLLM), NOT with third-party open-model APIs (your data still leaves the device).

**Break-even.** The hybrid architecture starts paying for its complexity somewhere around **100–300× your current volume** — i.e., roughly 15,000–50,000+ ops/month, or a jump from 10 private users to hundreds/thousands of active users, *or* if a single feature (e.g., bulk-importing a whole cookbook via photos) starts driving thousands of vision calls. Below that, effort > savings.

**Staged recommendation:**
1. **Now:** Keep everything on Claude. Move the mechanical small tasks (parse/convert/dedup/categorize) to deterministic code. Add `gte-small` + pgvector for search. This removes most "AI" calls entirely and costs nothing.
2. **Soon (optional, for learning/speed):** Add ONE cheap provider (Groq free tier, `strict` JSON) behind a config-driven router for text extraction (c) and tags (e). Log which model handled each request.
3. **Later (only if volume explodes):** Introduce a validate-and-escalate cascade and consider Cloudflare Workers AI vision for *printed* OCR, keeping Claude for handwriting and the Hero generator.

### E. Concrete implementation guide (Deno / TypeScript, Supabase Edge Function)

**Secrets (server-side only — never in the PWA):**
```
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set GROQ_API_KEY=gsk_...
```
Access via `Deno.env.get('ANTHROPIC_API_KEY')`. The static frontend must NEVER hold these; it calls your Edge Function (authenticated with the user's Supabase JWT), and the function holds the keys.

**Config-driven model map (swap models in one line):**
```ts
// config.ts
export const MODELS = {
  extract_text:  { provider: "groq",      model: "llama-3.1-8b-instant" },
  suggest_tags:  { provider: "groq",      model: "llama-3.1-8b-instant" },
  ocr_photo:     { provider: "anthropic", model: "claude-haiku-4-5" },
  hero_generate: { provider: "anthropic", model: "claude-haiku-4-5" },
} as const;
```

**Provider calls + validate-and-escalate cascade:**
```ts
import Ajv from "npm:ajv";
const ajv = new Ajv();

async function callGroq(model: string, prompt: string, schema: object) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Deno.env.get("GROQ_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      // strict schema-constrained decoding:
      response_format: { type: "json_schema", json_schema: { name: "out", strict: true, schema } },
    }),
    signal: AbortSignal.timeout(15_000), // timeout
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

async function callClaude(model: string, prompt: string, schema: object) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model, max_tokens: 1024,
      tools: [{ name: "emit", input_schema: schema }],
      tool_choice: { type: "tool", name: "emit" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`claude ${r.status}`);
  const j = await r.json();
  return j.content.find((b: any) => b.type === "tool_use").input;
}

// cheap attempt → validate → escalate to Claude on failure
async function extractWithFallback(prompt: string, schema: object, log: (m: string, ok: boolean) => void) {
  const validate = ajv.compile(schema);
  try {
    const out = await callGroq("llama-3.1-8b-instant", prompt, schema);
    if (validate(out)) { log("groq/llama-3.1-8b", true); return out; }
    log("groq/llama-3.1-8b", false); // invalid JSON → escalate
  } catch (_e) {
    log("groq/llama-3.1-8b", false); // error/timeout → escalate
  }
  const out = await callClaude("claude-haiku-4-5", prompt, schema);
  log("claude-haiku-4-5", validate(out)); return out;
}
```

**Logging for quality comparison:** write one row per request to a Postgres table `ai_calls(task, model, valid, latency_ms, escalated, created_at)`. This lets you see the cheap-model success rate per task and decide what to keep cheap.

**Error handling / retries / timeouts:** wrap each provider in a per-request timeout (`AbortSignal.timeout`), retry the cheap provider at most once on a 429/5xx, then escalate. Never retry-loop the expensive model. Fail closed with a clear error to the PWA.

**Security & spend control:**
- All keys in Edge Function secrets; the PWA only ever calls your function with the user's JWT (enforce via RLS + an auth check).
- **Per-user rate limiting:** a `usage` table keyed by `user_id` + day, checked at the top of the function (or Supabase's built-in rate limits / pgmq).
- **Spend cap:** a global monthly counter that hard-stops calls past a threshold; set billing alerts on Anthropic. For your scale, a simple "N ops/user/day" cap is plenty.

---

## Recommendations

1. **Answer the headline question and stop there for cost:** you can't run an open LLM inside hosted Supabase, and at your scale a hybrid tier won't save meaningful money. Don't build it to save $1.
2. **Delete AI from the mechanical tasks immediately.** Implement deterministic ingredient parsing (port `ingredient-parser`-style rules), unit conversion (lookup table), grocery dedup (normalize + sum), and kitchen/bar tagging (keyword rules). This is the single highest-ROI change: it removes latency, cost, and failure modes at once.
3. **Keep Claude for what it's uniquely good at:** photo/handwriting OCR (vision) and the Hero Ingredient generator. These are your quality-defining features.
4. **Add `gte-small` + pgvector for search** — free, native, and turns search into a solved problem.
5. **If (and only if) you want the learning/speed/resilience benefits,** add Groq's free tier behind the config-driven router shown above for task (c) text extraction and (e) tag suggestion, with validate-and-escalate to Claude. Log every call.
6. **Revisit the full hybrid + cheap vision OCR only if you cross ~15,000 ops/month** or open the app to hundreds of users, or if bulk cookbook-photo import starts generating thousands of vision calls.

**Thresholds that change the plan:** cheap-model JSON validity <~90% on a task → keep that task on Claude; monthly ops >~15k → the cascade starts paying off; adding a bulk-photo-import feature → evaluate Mistral OCR (~$2/1k pages) or Apple on-device Vision as a pre-processor feeding a cheap text model.

## Caveats
- **Fast-moving pricing/status.** Open-model prices and free tiers change monthly; treat every dollar figure here as "verify before committing." The Supabase hosted-LLM status ("early access, not GA") is current as of mid-2026 and could flip — check the Supabase changelog and the early-access form before assuming.
- **Free tiers are not guarantees.** Groq/Cerebras/OpenRouter/Cloudflare free allocations have rate limits and can be changed or revoked; don't make a user-facing feature depend on a free tier without a paid fallback.
- **Structured-output enforcement varies.** "OpenAI-compatible" does not always mean strict schema enforcement — only some providers do true constrained decoding. Always validate JSON server-side regardless.
- **Vision-model handwriting quality is genuinely poor on cheap models;** the 93%-vs-worse benchmark cited comes from a specific (Manchu-script) study, so the exact numbers won't transfer to your English recipe cards — test on your own samples before trusting any non-Claude OCR.
- **In-browser LLM claims are hype-adjacent.** iOS 26 WebGPU is real, but shipping a multi-GB model download to 10 iPhone users for tiny tasks is worse than deterministic code; the "27B on a phone" marketing should not drive your design.
- **Self-hosting/serverless GPU is a trap at this scale** — cold starts and idle cost dominate; revisit only at high, steady volume.