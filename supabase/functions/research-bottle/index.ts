// Supabase Edge Function: research-bottle
//
// The web lookup behind Bottles. Two jobs, one pipeline:
//   - FIND: a bottle the catalog doesn't know — search for its critic scores and
//     competition results and save what survives the checks below;
//   - CHECK: a bottle it does know — confirm the scores we hold are still what
//     their pages say, and add any new ones. The app asks for this on every
//     lookup of a known bottle; it runs unless that bottle was checked within
//     VERIFY_FRESH_DAYS (by anyone — the catalog is shared).
// Either way each bottle's research is shared, so the catalog grows and stays
// current with every lookup (README "Bottles: looking a bottle up in the app").
//
// The searches are curated, best sources first, in three stages — each limited
// (allowed_domains) to its own sites, so the critics are always searched:
//   1. critics' own review sites (Wine Enthusiast, Drinkhacker; for whiskey also
//      Whisky Advocate, Breaking Bourbon, The Whiskey Wash, WhiskyCast);
//   2. competitions' own results (IWSC, SFWSC via SevenFifty Daily, The Spirits
//      Business Masters, Bartender Spirits Awards, ISC, Concours Mondial, NYISC);
//   3. everything else minus BLOCKED_DOMAINS — mainly the producer's own awards page.
// The plan lives in rating_sources (search_tier / search_domains /
// search_categories), so it changes with SQL, no redeploy; DEFAULT_SEARCH_PLAN
// below is the fallback until that SQL has run.
//
// What makes a found score trustworthy enough to keep:
//   - its URL was in the search results the model actually received (an
//     invented link can't pass), and when the model cited that page, the cited
//     text has to contain the score or medal;
//   - the site isn't one whose terms forbid this or whose robots.txt keeps AI
//     agents out (BLOCKED_DOMAINS, also passed to the open search), and isn't a
//     retailer repeating awards secondhand;
//   - the page names the same bottle (age, proof and batch don't conflict).
// Kept scores go in as origin "field", verified=false: the consensus view counts
// them at 3/4 weight until a later independent lookup finds the same review
// (which marks it verified) or `ratings.py field` confirms it by hand. A check
// that finds a known score's page now shows something else files a
// spirit_reports row for a person to look at; it never rewrites the score.
//
// Cost control: per-user cap (increment_bottle_usage 'lookup'), a site-wide
// daily cap, "nothing found" remembered for NONE_REMEMBER_DAYS, a bottle not
// re-checked within VERIFY_FRESH_DAYS, and one running lookup per bottle.
//
// The search runs in the background (EdgeRuntime.waitUntil): the response comes
// back at once with a lookup id, and the app polls spirit_lookups — so a dropped
// connection in a store aisle doesn't lose the lookup.
//
// Request body (JSON):
//   { name: string,                 // what to look up ("Buffalo Trace")
//     label?: { brand, expression, category, age_years, abv, proof, batch, country },
//     product_id?: string }         // a catalog bottle: check it (and add what's new)
//
// Response: always HTTP 200 —
//   { status: "running", lookup_id } | { status: "fresh", product_id, checked_at }
//   | { status: "none", cached: true } | { error }

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Judging which page is a primary source (a critic's review vs a retailer
// repeating it) is the hard part, and a bad score lands in everyone's catalog —
// so this one uses Sonnet, not the Haiku the recipe functions use. About
// 20-30 cents a lookup: three search stages (up to 7 searches, $10 per 1,000)
// plus the record call.
const MODEL = "claude-sonnet-5-5";
const ANTHROPIC_VERSION = "2023-06-01";
const DAILY_LOOKUP_LIMIT = 20;
const SITE_DAILY_LOOKUP_LIMIT = 200;
const NONE_REMEMBER_DAYS = 30;
// A bottle checked this recently isn't checked again (0 = check on every lookup).
const VERIFY_FRESH_DAYS = 7;
const RUNNING_STALE_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 90_000;
// For the cost line each lookup writes to spirit_lookups.detail (Sonnet 5.5 list
// prices per million tokens, and web search per search) — update with pricing.
const PRICE_IN_PER_MTOK = 2, PRICE_OUT_PER_MTOK = 10, PRICE_PER_SEARCH = 0.01;

// Terms that forbid collecting their scores (Distiller, Tastings.com/BTI), and
// sites whose robots.txt keeps AI agents out (checked 2026-11-08). The big
// retailers are blocked too: they repeat awards secondhand and crowd out the
// primary pages. Keep this list short — a long one fails the search. Only the
// open stage (3) uses it; stages 1-2 are allow-lists.
const BLOCKED_DOMAINS = [
  "distiller.com", "tastings.com", "tequilamatchmaker.com", "agavematchmaker.com",
  "forbes.com", "thetastingalliance.com", "maisonferrand.com", "wyomingwhiskey.com",
  "totalwine.com", "wine.com", "drizly.com", "caskers.com", "curiada.com",
  "reservebar.com", "wine-searcher.com", "masterofmalt.com", "thewhiskyexchange.com",
  "whiskybase.com", "rumratings.com", "vivino.com"
];
// Never kept even if one slips through (subdomains, mirrors).
const REJECT_HOST = /(^|\.)(distiller|tastings|tequilamatchmaker|agavematchmaker|forbes|thetastingalliance|totalwine|wine|drizly|caskers|curiada|reservebar|wine-searcher|masterofmalt|thewhiskyexchange|whiskybase|rumratings|vivino|amazon|walmart|instacart|liquorbarn|flaviar)\.(com|co\.uk|net)$/i;
const REJECT_SOURCE = /distiller|tastings\.com|beverage testing|tequila matchmaker|whiskybase|rum ?ratings|vivino|customer|community/i;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Same key handling as the other functions: the new publishable/secret keys
// (JSON objects keyed by name) first, the legacy ones as the fallback.
function envKey(newName: string, legacyName: string): string {
  try {
    const keys = JSON.parse(Deno.env.get(newName) || "{}");
    const key = typeof keys.default === "string" ? keys.default : Object.values(keys).find((v) => typeof v === "string");
    if (key) return key as string;
  } catch { /* unset or not JSON — use the legacy key */ }
  return Deno.env.get(legacyName)!;
}
const SUPABASE_CLIENT_KEY = envKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
// The catalog is read-only to signed-in users; this function writes it with
// the service key Supabase provides to every Edge Function.
const SUPABASE_SERVICE_KEY = envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// KEEP IN SYNC with app.js BAR_CATEGORIES.
const BAR_CATEGORIES = ["gin", "vodka", "rum", "tequila", "mezcal", "whiskey", "bourbon", "rye", "scotch", "brandy", "liqueur", "vermouth", "amaro", "bitters", "wine", "mixer", "other"];

// ==== NORMALIZE: port of scripts/ratings/normalize.py ====
// The same rules as the Python reference (and app.js's copy), so a name typed in
// the app, read off a label here, or imported by ratings.py lands on the same
// catalog key. testing-skills/bottle_normalize_parity_test.py runs all three.
const NORM_FOLD: Record<string, string> = { "ø": "o", "Ø": "O", "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe", "ß": "ss", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D" };
function stripMarks(text: unknown): string {
  return String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[øØæÆœŒßłŁđĐþÞðÐ]/g, (c) => NORM_FOLD[c]).replace(/[®™©]/g, "");
}
const NORM_ABBREV: [RegExp, string][] = [
  [/\by\.?\s?o\.?\b/g, "year old"],
  [/\byrs?\b/g, "year"],
  [/\byears?\s+old\b/g, "year old"],
  [/\byear\b(?!\s+old)/g, "year old"],
  [/\bb\.?i\.?b\.?\b/g, "bottled in bond"],
  [/\bs\.?i\.?b\.?\b/g, "single barrel"],
  [/\bcs\b/g, "cask strength"],
  [/\bst\b\.?/g, "saint"],
  [/&/g, " and "]
];
function normName(text: unknown): string {
  let t = stripMarks(text).toLowerCase();
  t = t.replace(/(\d)\s*(yo|y\.o\.|yr|yrs)\b/g, "$1 $2");
  for (const [re, rep] of NORM_ABBREV) t = t.replace(re, rep);
  t = t.replace(/['’`]/g, "");
  t = t.replace(/\b(?:[a-z]\.)+[a-z]\b\.?/g, (m) => m.replace(/\./g, ""));
  t = t.replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  t = t.replace(/[^a-z0-9.%]+/g, " ");
  t = t.replace(/\b(the|kentucky straight|straight|whiskey|whisky|liqueur)\b/g, " ");
  t = t.replace(/\byear old year old\b/g, "year old");
  return t.replace(/\s+/g, " ").trim();
}
function parseAttrs(text: unknown) {
  const t = stripMarks(text).toLowerCase();
  const out = {
    age_years: null as number | null, abv: null as number | null, proof: null as number | null, batch: null as string | null,
    single_barrel: /single\s+barrel|\bsib\b/.test(t),
    store_pick: /store pick|selected by|private (barrel|selection)/.test(t)
  };
  let m = t.match(/\b(\d{1,2})\s*(?:-|\s)?(?:years?\s*old|years?|yrs?|y\.?o\.?)\b/);
  if (m) out.age_years = parseInt(m[1], 10);
  m = t.match(/(\d{2}(?:\.\d{1,2})?)\s*%\s*(?:abv|alc|vol)?/);
  if (m) out.abv = parseFloat(m[1]);
  m = t.match(/\b(\d{2,3}(?:\.\d)?)\s*proof\b/);
  if (m) {
    out.proof = parseFloat(m[1]);
    if (out.abv === null) out.abv = Math.round((out.proof / 2) * 100) / 100;
  }
  m = t.match(/\bbatch\s*(?:no\.?|#)?\s*([a-z]?\d[\w-]*)/) || t.match(/\b([abc]\d{3})\b/);
  if (m) out.batch = m[1].toUpperCase();
  return out;
}
type Attrs = { age_years?: number | null; abv?: number | null; batch?: string | null };
function attrsCompatible(a: Attrs, b: Attrs): boolean {
  if (a.age_years != null && b.age_years != null && a.age_years !== b.age_years) return false;
  if (a.abv != null && b.abv != null && Math.abs(a.abv - b.abv) > 0.3) return false;
  if (a.batch && b.batch && a.batch !== b.batch) return false;
  return true;
}
const SCORE_ANCHORS: Record<string, [number, number][]> = {
  critic100: [[70, 4.0], [80, 5.5], [85, 6.5], [88, 7.0], [90, 7.5], [92, 8.0], [94, 8.5], [96, 9.0], [98, 9.5], [100, 10.0]],
  wine_enthusiast: [[80, 5.5], [83, 6.0], [87, 7.0], [90, 7.5], [94, 8.5], [98, 9.5], [100, 10.0]],
  iwsc: [[80, 5.0], [85, 6.0], [90, 7.0], [95, 8.0], [98, 9.0], [100, 9.5]],
  murray: [[80, 5.0], [85, 6.0], [90, 7.0], [94, 8.0], [96, 8.5], [97.5, 9.0], [99, 9.5], [100, 10.0]],
  tequila_matchmaker: [[75, 5.0], [80, 6.0], [85, 7.0], [88, 8.0], [90, 8.5], [92, 9.5], [100, 10.0]],
  drinkhacker: [[4.0, 4.0], [6.0, 5.0], [7.0, 6.0], [8.0, 6.75], [8.5, 7.25], [9.0, 8.0], [9.5, 8.75], [10.0, 9.5]],
  ten: [[0, 0.0], [10, 10.0]],
  barrels5: [[0, 0.0], [5, 10.0]],
  stars5: [[1, 3.0], [2, 4.5], [3, 6.0], [4, 7.5], [5, 9.0]]
};
const MEDAL_SCORES: Record<string, Record<string, number>> = {
  sfwsc: { "bronze": 5.5, "silver": 6.5, "gold": 7.5, "double gold": 8.5, "platinum": 8.5, "best in show": 9.0 },
  iwsc: { "bronze": 6.0, "silver": 7.0, "silver outstanding": 7.5, "gold": 8.0, "gold outstanding": 9.0, "trophy": 9.0 },
  default: { "bronze": 6.0, "silver": 7.0, "gold": 8.0, "double gold": 8.5, "grand gold": 8.5, "platinum": 9.0 }
};
function to10(scale: string, raw: number): number {
  const table = SCORE_ANCHORS[scale];
  if (!table) throw new Error(`unknown scale ${scale}`);
  if (raw <= table[0][0]) return table[0][1];
  if (raw >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (x0 <= raw && raw <= x1) return y0 + (y1 - y0) * (raw - x0) / (x1 - x0);
  }
  throw new Error("unreachable");
}
function cleanMedal(medal: unknown): string | null {
  if (!medal) return null;
  let m = String(medal).trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(packaging|design|label|mixer|whisky highball|highball|rtd|alternative drinks)\b/.test(m)) return null;
  m = m.replace(/^spirits?\s+/, "");
  return m || null;
}
function medalTo10(scale: string, medal: unknown): number | null {
  const m = cleanMedal(medal);
  if (!m) return null;
  const table = MEDAL_SCORES[scale] || MEDAL_SCORES.default;
  return table[m] ?? null;
}
const CATEGORY_WORDS: [string, string][] = [
  ["bourbon", "bourbon"], ["rye", "rye"],
  ["scotch", "scotch"], ["islay", "scotch"], ["speyside", "scotch"],
  ["mezcal", "mezcal"], ["tequila", "tequila"], ["rum", "rum"], ["rhum", "rum"], ["cachaca", "rum"],
  ["gin", "gin"], ["vodka", "vodka"],
  ["cognac", "brandy"], ["armagnac", "brandy"], ["brandy", "brandy"], ["calvados", "brandy"], ["pisco", "brandy"],
  ["vermouth", "vermouth"], ["amaro", "amaro"], ["liqueur", "liqueur"], ["cordial", "liqueur"],
  ["creme de", "liqueur"], ["schnapps", "liqueur"],
  ["whisk", "whiskey"], ["single malt", "whiskey"]
];
// Whole words only ("ginger" is not gin), except "whisk" (whiskey, whisky). The
// LAST type word wins, parentheses dropped; a generic whiskey gives way to
// bourbon / rye / scotch anywhere in the name (see normalize.py).
function guessCategory(text: unknown): string {
  const t = " " + stripMarks(text).toLowerCase().replace(/\([^)]*\)/g, " ") + " ";
  const hits: [number, string][] = [];
  for (const [word, cat] of CATEGORY_WORDS) {
    const re = new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (word === "whisk" ? "" : "\\b"), "g");
    for (const m of t.matchAll(re)) hits.push([m.index ?? 0, cat]);
  }
  if (!hits.length) return "other";
  hits.sort((a, b) => a[0] - b[0]);
  const cat = hits[hits.length - 1][1];
  if (cat === "whiskey") {
    const specific = hits.filter(([, c]) => c === "bourbon" || c === "rye" || c === "scotch");
    if (specific.length) return specific[specific.length - 1][1];
  }
  return cat;
}
// ==== END NORMALIZE ====

// The curated search plan: which sites each stage may search, best first.
// Normally read from rating_sources (search_tier / search_domains /
// search_categories — README "Bottles" SQL), so the plan can be changed with SQL;
// this copy is the fallback until that SQL has run. Tier 1 = critics' own
// review sites (searched first), tier 2 = competitions' own results.
type PlanSource = { id: string; name: string; search_tier: number | null; search_domains: string[] | null; search_categories: string[] | null };
const WHISKEY_CATS = ["whiskey", "bourbon", "rye", "scotch"];
const DEFAULT_SEARCH_PLAN: PlanSource[] = [
  { id: "wine_enthusiast", name: "Wine Enthusiast", search_tier: 1, search_domains: ["wineenthusiast.com"], search_categories: null },
  { id: "drinkhacker", name: "Drinkhacker", search_tier: 1, search_domains: ["drinkhacker.com"], search_categories: null },
  { id: "whisky_advocate", name: "Whisky Advocate", search_tier: 1, search_domains: ["whiskyadvocate.com"], search_categories: WHISKEY_CATS },
  { id: "breaking_bourbon", name: "Breaking Bourbon", search_tier: 1, search_domains: ["breakingbourbon.com"], search_categories: ["bourbon", "rye", "whiskey"] },
  { id: "whiskey_wash", name: "The Whiskey Wash", search_tier: 1, search_domains: ["thewhiskeywash.com"], search_categories: WHISKEY_CATS },
  { id: "whiskycast", name: "WhiskyCast", search_tier: 1, search_domains: ["whiskycast.com"], search_categories: WHISKEY_CATS },
  { id: "iwsc", name: "IWSC", search_tier: 2, search_domains: ["iwsc.net"], search_categories: null },
  { id: "sfwsc", name: "San Francisco World Spirits Competition (results via SevenFifty Daily)", search_tier: 2, search_domains: ["daily.sevenfifty.com"], search_categories: null },
  { id: "spirits_masters", name: "The Spirits Business Masters", search_tier: 2, search_domains: ["thespiritsbusiness.com"], search_categories: null },
  { id: "bartender_spirits_awards", name: "Bartender Spirits Awards", search_tier: 2, search_domains: ["bartenderspiritsawards.com"], search_categories: null },
  { id: "isc", name: "International Spirits Challenge", search_tier: 2, search_domains: ["internationalspiritschallenge.com"], search_categories: null },
  { id: "cmb", name: "Concours Mondial de Bruxelles", search_tier: 2, search_domains: ["concoursmondial.com"], search_categories: null },
  { id: "nyisc", name: "New York International Spirits Competition", search_tier: 2, search_domains: ["nyispiritscompetition.com"], search_categories: null }
];
function planFor(category: string, sources: PlanSource[]) {
  const fits = (s: PlanSource) => !s.search_categories || !s.search_categories.length || s.search_categories.includes(category);
  const tier = (n: number) => sources.filter((s) => s.search_tier === n && Array.isArray(s.search_domains) && s.search_domains.length && fits(s));
  return { critics: tier(1), competitions: tier(2) };
}
const domainsOf = (list: PlanSource[]) => [...new Set(list.flatMap((s) => s.search_domains || []))].slice(0, 20);

// Where a found score is filed. A known site's domain decides first (the plan's
// domains, then this list); then the name the model gave; anything else goes to
// a catch-all at half weight.
const DOMAIN_SOURCES: Record<string, string> = {
  "wineenthusiast.com": "wine_enthusiast", "drinkhacker.com": "drinkhacker",
  "whiskyadvocate.com": "whisky_advocate", "whiskycast.com": "whiskycast",
  "breakingbourbon.com": "breaking_bourbon", "thewhiskeywash.com": "whiskey_wash",
  "bartenderspiritsawards.com": "bartender_spirits_awards", "thespiritsbusiness.com": "spirits_masters",
  "iwsc.net": "iwsc", "daily.sevenfifty.com": "sfwsc", "internationalspiritschallenge.com": "isc",
  "concoursmondial.com": "cmb", "nyispiritscompetition.com": "nyisc"
};
const NAME_SOURCES: [RegExp, string][] = [
  [/san francisco world spirits|\bsfwsc\b/i, "sfwsc"],
  [/\biwsc\b|international wine (?:&|and) spirits? competition/i, "iwsc"],
  [/international spirits challenge/i, "isc"],
  [/concours mondial|brussels/i, "cmb"],
  [/new york international spirits/i, "nyisc"],
  [/ultimate (?:spirits|beverage) challenge/i, "usc"],
  [/wine enthusiast/i, "wine_enthusiast"], [/whisky advocate/i, "whisky_advocate"],
  [/drinkhacker/i, "drinkhacker"], [/whiskycast/i, "whiskycast"],
  [/breaking bourbon/i, "breaking_bourbon"], [/whiskey wash/i, "whiskey_wash"],
  [/bartender spirits awards/i, "bartender_spirits_awards"],
  [/spirits business|(?:gin|rum|whisk(?:e)?y|tequila|vodka|liqueur|brandy|cognac)[^,]*masters/i, "spirits_masters"],
  [/jim murray|whisk(?:e)?y bible/i, "murray"], [/spirit journal|pacult/i, "spirit_journal"]
];
const SCALE_FOR: Record<string, (src: string) => string> = {
  points_100: (src) => ["wine_enthusiast", "iwsc", "murray", "tequila_matchmaker"].includes(src) ? src : "critic100",
  out_of_10: (src) => (src === "drinkhacker" ? "drinkhacker" : "ten"),
  stars_5: () => "stars5",
  barrels_5: () => "barrels5"
};
const SCALE_RANGE: Record<string, [number, number]> = { points_100: [50, 100], out_of_10: [0, 10], stars_5: [0, 5], barrels_5: [0, 5] };
const DH_GRADES: Record<string, string> = { "10": "A+", "9.5": "A", "9": "A-", "8.5": "B+", "8": "B", "7.5": "B-", "7": "C+", "6": "C+" };

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
type SourceRow = { scale: string; default_weight: number; search_domains?: string[] | null };
function sourceFor(review: FoundReview, sourceRows: Map<string, SourceRow>): string {
  const host = hostOf(review.url);
  const onDomain = (d: string) => host === d || host.endsWith("." + d);
  for (const [id, s] of sourceRows) if ((s.search_domains || []).some(onDomain)) return id;
  for (const [domain, id] of Object.entries(DOMAIN_SOURCES)) if (onDomain(domain)) return id;
  for (const [re, id] of NAME_SOURCES) if (re.test(review.source_name)) return id;
  return review.kind === "competition" || review.scale === "medal" ? "other_competition" : "other_critic";
}
// The strings a page has to show for a score to count as "cited".
function tokensFor(scale: string, score: number | null, medal: string | null, source: string): string[] {
  if (scale === "medal") return medal ? [String(medal).toLowerCase()] : [];
  if (score == null) return [];
  const n = Number(score);
  const toks = new Set([String(n), n.toFixed(1)]);
  if (source === "drinkhacker" && DH_GRADES[String(n)]) toks.add(DH_GRADES[String(n)].toLowerCase());
  return [...toks];
}
const scoreTokens = (r: FoundReview, source: string) => tokensFor(r.scale, r.score, r.medal, source);

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    bottle: {
      type: "object",
      properties: {
        canonical_name: { type: "string", description: "The bottle's full market name as a shopper would say it, e.g. 'Buffalo Trace Kentucky Straight Bourbon', 'Lagavulin 16 Year Old'." },
        category: { type: "string", enum: BAR_CATEGORIES, description: "The closest category from the fixed list." },
        producer: { type: ["string", "null"], description: "Distillery or producer, or null if not stated." },
        country: { type: ["string", "null"] },
        age_years: { type: ["integer", "null"], description: "Age statement in years, or null for none." },
        abv: { type: ["number", "null"], description: "Alcohol by volume in percent (proof / 2), or null." }
      },
      required: ["canonical_name", "category", "producer", "country", "age_years", "abv"]
    },
    reviews: {
      type: "array",
      description: "Every NEW qualifying score you found (not ones listed as already known). An empty list is a valid answer.",
      items: {
        type: "object",
        properties: {
          source_name: { type: "string", description: "The critic, publication or competition — 'Wine Enthusiast', 'San Francisco World Spirits Competition', 'Whisky Advocate'." },
          kind: { type: "string", enum: ["critic", "competition"] },
          url: { type: "string", description: "The page that states this score, copied exactly from your search results." },
          year: { type: ["integer", "null"], description: "Year of the review or competition, or null if the page doesn't say." },
          scale: { type: "string", enum: ["points_100", "out_of_10", "stars_5", "barrels_5", "medal"] },
          score: { type: ["number", "null"], description: "The score on that scale; null for a medal." },
          medal: { type: ["string", "null"], description: "The medal exactly as awarded (e.g. 'Double Gold') for scale 'medal'; else null." },
          reviewer: { type: ["string", "null"], description: "The reviewer's name if the page gives one." },
          bottle_as_named: { type: "string", description: "The bottle's name exactly as that page prints it." }
        },
        required: ["source_name", "kind", "url", "year", "scale", "score", "medal", "reviewer", "bottle_as_named"]
      }
    },
    checks: {
      type: "array",
      description: "One entry per score listed as already known (empty when none were listed).",
      items: {
        type: "object",
        properties: {
          review_ref: { type: "string", description: "The [r…] reference of the known score." },
          status: { type: "string", enum: ["confirmed", "changed", "unchecked"], description: "confirmed = a page in your results still shows that exact score; changed = its page now shows a different score; unchecked = you couldn't see its page." },
          url: { type: ["string", "null"], description: "The page you checked it on, exactly as in your search results." },
          now_says: { type: ["string", "null"], description: "For 'changed': the score or medal the page shows now, as printed (e.g. '91' or 'Silver')." }
        },
        required: ["review_ref", "status", "url", "now_says"]
      }
    }
  },
  required: ["bottle", "reviews", "checks"]
};
type FoundReview = {
  source_name: string; kind: string; url: string; year: number | null; scale: string;
  score: number | null; medal: string | null; reviewer: string | null; bottle_as_named: string;
};
type FoundCheck = { review_ref: string; status: string; url: string | null; now_says: string | null };

const RESEARCH_PROMPT = `You find expert ratings for ONE spirits bottle, for a home-bar app whose score has to be reliable. You work in three search stages — critics, then competitions, then everything else — and then record what you found.

What counts:
- A critic's or publication's OWN review page with a score.
- A competition's OWN results page or announcement, or the PRODUCER'S own awards page listing its medals.

What never counts:
- Retailer or marketplace listings, even when they quote a score — find the critic's own page instead, or leave it out.
- Distiller, Tastings.com / the Beverage Testing Institute, Tequila Matchmaker, and user or community ratings (Whiskybase, RumRatings, Vivino, customer stars).
- A different bottle: another age statement, a cask-strength, barrel-proof or single-barrel edition, a store pick, a limited release, a finish, or another proof. When unsure it's the same bottle, leave it out.
- Packaging, design, label and "best value" awards.

How to work, in every stage:
- Search only for what the stage asks. The search tool is limited to that stage's sites.
- For each score you find, write one short line that quotes where the page states the score or medal, so the page is cited. Say plainly when a stage found nothing.
- If scores we already have are listed, check them as you go: does a page in your results still show that exact score?
- Never guess a score. Nothing found is a valid, useful answer.`;

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

type Research = {
  bottle?: { canonical_name?: string; category?: string; producer?: string | null; country?: string | null; age_years?: number | null; abv?: number | null };
  reviews: FoundReview[];
  checks: FoundCheck[];
  resultUrls: Set<string>;
  cited: Map<string, string[]>;
  searches: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
};
type Known = { id: string; ref: string; source_id: string; source: string; scale: string; score_raw: number | null; medal: string | null; review_year: number | null; url: string | null };

// deno-lint-ignore no-explicit-any
function collect(out: Research, data: any) {
  out.searches += data.usage?.server_tool_use?.web_search_requests ?? 0;
  out.tokensIn += (data.usage?.input_tokens ?? 0) + (data.usage?.cache_creation_input_tokens ?? 0) + (data.usage?.cache_read_input_tokens ?? 0);
  out.tokensOut += data.usage?.output_tokens ?? 0;
  for (const block of data.content ?? []) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r?.url) out.resultUrls.add(r.url);
    }
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (!c?.url) continue;
        if (!out.cited.has(c.url)) out.cited.set(c.url, []);
        // The page's own words only — the model's sentence around the citation
        // always contains the score, so it proves nothing.
        out.cited.get(c.url)!.push(String(c.cited_text || "").toLowerCase());
      }
    }
  }
}
// deno-lint-ignore no-explicit-any
async function callApi(body: any): Promise<{ status: number; data?: any; text?: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY!, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify(body)
  });
  if (!res.ok) return { status: res.status, text: await res.text() };
  return { status: res.status, data: await res.json() };
}
const webSearch = (o: { allowed?: string[]; blocked?: string[]; max: number }) => ({
  type: "web_search_20250305", name: "web_search", max_uses: o.max,
  ...(o.allowed ? { allowed_domains: o.allowed } : { blocked_domains: o.blocked })
});

// The research: three search stages (each limited to its own sites), then one
// forced record_scores call. pause_turn hands a paused turn straight back.
// deno-lint-ignore no-explicit-any
async function research(name: string, labelLine: string, plan: { critics: PlanSource[]; competitions: PlanSource[] }, known: Known[]): Promise<Research> {
  const out: Research = { reviews: [], checks: [], resultUrls: new Set(), cited: new Map(), searches: 0, tokensIn: 0, tokensOut: 0 };
  const knownText = known.length
    ? `\n\nScores we already have for this bottle — check each is still on its page and still says that:\n` +
      known.map((k) => `- [${k.ref}] ${k.source} · ${knownWhat(k)}${k.review_year ? " · " + k.review_year : ""}${k.url ? " · " + k.url : ""}`).join("\n")
    : "";
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: `Bottle to research: ${name}\n${labelLine}${knownText}` }] }];
  const stages = [];
  if (plan.critics.length) stages.push({
    tool: webSearch({ allowed: domainsOf(plan.critics), max: 3 }),
    text: `Stage 1 of 3 — critics' own reviews. The search reaches only these critics' sites: ${plan.critics.map((s) => s.name).join(", ")}. Look for a scored review of exactly this bottle on each.`
  });
  if (plan.competitions.length) stages.push({
    tool: webSearch({ allowed: domainsOf(plan.competitions), max: 2 }),
    text: `Stage 2 of 3 — competition results. The search reaches only these competitions' results: ${plan.competitions.map((s) => s.name).join(", ")}. Look for medals or points this exact bottle won.`
  });
  stages.push({
    tool: webSearch({ blocked: BLOCKED_DOMAINS, max: 2 }),
    text: `Stage 3 of 3 — what the first stages couldn't reach: the producer's own awards page (it lists the medals the bottle won), and any other independent critic's own scored review. Retailers and community ratings still don't count.`
  });
  for (const st of stages) {
    const last = messages[messages.length - 1];
    if (last.role === "user") last.content.push({ type: "text", text: st.text });
    else messages.push({ role: "user", content: [{ type: "text", text: st.text }] });
    for (let step = 0; step < 4; step++) {
      const r = await callApi({ model: MODEL, max_tokens: 2048, system: RESEARCH_PROMPT, tools: [st.tool], tool_choice: { type: "auto" }, messages });
      if (!r.data) {
        console.error("research-bottle: Anthropic error", r.status, String(r.text).slice(0, 500));
        out.error = r.status === 429 ? "busy" : "api";
        return out;
      }
      collect(out, r.data);
      if (r.data.stop_reason === "refusal") { out.error = "declined"; return out; }
      messages.push({ role: "assistant", content: r.data.content });
      if (r.data.stop_reason !== "pause_turn") break;   // the API paused a long search turn: hand it back
    }
  }
  messages.push({ role: "user", content: [{ type: "text", text: known.length
    ? "Now call record_scores: NEW scores in reviews (not the ones we already have), and one entry in checks for every score we already have."
    : "Now call record_scores with every qualifying score you found (an empty reviews list if nothing qualified)." }] });
  let strict = true;
  for (let step = 0; step < 3; step++) {
    const recordTool = strict
      ? { name: "record_scores", description: "Record the bottle's facts, new scores, and checks of known ones.", input_schema: strictify(REVIEW_SCHEMA), strict: true }
      : { name: "record_scores", description: "Record the bottle's facts, new scores, and checks of known ones.", input_schema: REVIEW_SCHEMA };
    const r = await callApi({
      model: MODEL, max_tokens: 4096, system: RESEARCH_PROMPT,
      tools: [webSearch({ blocked: BLOCKED_DOMAINS, max: 1 }), recordTool],
      tool_choice: { type: "tool", name: "record_scores" }, messages
    });
    if (r.status === 400 && strict) {
      console.error("research-bottle: strict tool schema rejected — retrying without strict:", String(r.text).slice(0, 300));
      strict = false;
      continue;
    }
    if (!r.data) {
      console.error("research-bottle: Anthropic error", r.status, String(r.text).slice(0, 500));
      out.error = r.status === 429 ? "busy" : "api";
      return out;
    }
    collect(out, r.data);
    if (r.data.stop_reason === "refusal") { out.error = "declined"; return out; }
    const call = (r.data.content ?? []).find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "record_scores");
    if (!call) { out.error = r.data.stop_reason === "max_tokens" ? "long" : "no record"; return out; }
    out.bottle = call.input?.bottle;
    out.reviews = Array.isArray(call.input?.reviews) ? call.input.reviews : [];
    out.checks = Array.isArray(call.input?.checks) ? call.input.checks : [];
    return out;
  }
  out.error = "loop";
  return out;
}
function knownWhat(k: Known): string {
  if (k.medal) return k.medal;
  if (k.score_raw == null) return "?";
  const n = Number(k.score_raw);
  if (k.scale === "drinkhacker" || (k.scale === "ten" && n <= 10)) return `${n}/10`;
  if (k.scale === "stars5") return `${n} of 5 stars`;
  if (k.scale === "barrels5") return `${n} of 5 barrels`;
  return `${n} points`;
}

type Kept = { row: Record<string, unknown>; key: string };

// Every check from the header, applied to the new scores the model recorded.
function vet(found: Research, wantAttrs: Attrs, sourceRows: Map<string, SourceRow>): { kept: Kept[]; dropped: Record<string, number> } {
  const kept: Kept[] = [];
  const dropped: Record<string, number> = {};
  const drop = (why: string) => { dropped[why] = (dropped[why] || 0) + 1; };
  const thisYear = new Date().getUTCFullYear();
  const seen = new Set<string>();
  for (const r of found.reviews.slice(0, 20)) {
    if (!r || typeof r.url !== "string") { drop("malformed"); continue; }
    if (!found.resultUrls.has(r.url)) { drop("url not in search results"); continue; }
    const host = hostOf(r.url);
    if (!host || REJECT_HOST.test(host) || BLOCKED_DOMAINS.some((d) => host === d || host.endsWith("." + d))) { drop("excluded site"); continue; }
    if (REJECT_SOURCE.test(r.source_name || "")) { drop("excluded source"); continue; }
    if (!attrsCompatible(parseAttrs(r.bottle_as_named || ""), wantAttrs)) { drop("different bottle"); continue; }
    const source = sourceFor(r, sourceRows);
    const src = sourceRows.get(source);
    if (!src) { drop("unknown source"); continue; }
    let score10: number | null = null, weight = Number(src.default_weight) || 0.5;
    let raw: number | null = null, medal: string | null = null;
    if (r.scale === "medal") {
      score10 = medalTo10(src.scale, r.medal);
      medal = r.medal;
      weight = 0.5;
    } else if (SCALE_FOR[r.scale] && r.score != null && Number.isFinite(Number(r.score))) {
      raw = Number(r.score);
      const [lo, hi] = SCALE_RANGE[r.scale];
      if (raw < lo || raw > hi) { drop("score out of range"); continue; }
      const scale = SCALE_FOR[r.scale](source);
      score10 = to10(scale, raw);
    }
    if (score10 == null) { drop("no usable score"); continue; }
    const year = Number.isInteger(r.year) && r.year! >= 1990 && r.year! <= thisYear ? r.year : null;
    // When the model cited this page, the cited text must show the score.
    const cites = found.cited.get(r.url);
    if (cites && cites.length) {
      const toks = scoreTokens(r, source);
      if (!toks.some((t) => cites.some((c) => c.includes(t)))) { drop("score not in cited text"); continue; }
    }
    const dedupe = `${source}|${year ?? ""}|${raw ?? ""}|${(medal || "").toLowerCase()}`;
    if (seen.has(dedupe)) { drop("duplicate"); continue; }
    seen.add(dedupe);
    const reviewer = source.startsWith("other_") ? String(r.source_name || "").slice(0, 120) : (r.reviewer ? String(r.reviewer).slice(0, 120) : null);
    kept.push({
      key: dedupe,
      row: {
        source_id: source, url: r.url, review_year: year, reviewer, medal,
        score_raw: raw, score_10: Math.round(score10 * 100) / 100, weight,
        source_name: String(r.bottle_as_named || "").slice(0, 200) || "(unnamed)"
      }
    });
  }
  return { kept, dropped };
}

// The model's checks of scores we already have, held to the same evidence rule:
// "confirmed" needs a cited page in the results that still shows the score;
// "changed" needs a cited page showing the new value and not the old one.
function vetChecks(found: Research, known: Known[]): { confirmed: string[]; changed: { id: string; now: string; url: string }[] } {
  const confirmed: string[] = [], changed: { id: string; now: string; url: string }[] = [];
  for (const c of found.checks || []) {
    const k = known.find((x) => x.ref === c.review_ref);
    if (!k) continue;
    const url = c.url || k.url;
    if (!url || !found.resultUrls.has(url)) continue;
    const cites = found.cited.get(url) || [];
    if (!cites.length) continue;
    const old = tokensFor(k.medal ? "medal" : "points", k.score_raw, k.medal, k.source_id);
    const showsOld = old.some((t) => cites.some((x) => x.includes(t)));
    if (c.status === "confirmed" && showsOld) confirmed.push(k.id);
    else if (c.status === "changed" && c.now_says && !showsOld && cites.some((x) => x.includes(String(c.now_says).toLowerCase()))) {
      changed.push({ id: k.id, now: String(c.now_says).slice(0, 60), url });
    }
  }
  return { confirmed: [...new Set(confirmed)], changed };
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function finishLookup(admin: Db, lookupId: string, patch: Record<string, unknown>) {
  const { error } = await admin.from("spirit_lookups").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", lookupId);
  if (error) console.error("research-bottle: couldn't close lookup", lookupId, error.message);
}

// The background half: research, vet, write, close the lookup row. With a known
// bottle (productId) it's also a check of the scores the catalog already holds.
async function runLookup(admin: Db, lookupId: string, userId: string, name: string, label: Record<string, unknown>, productId: string | null) {
  try {
    const labelBits = [
      label.brand && `brand ${label.brand}`, label.expression && `expression ${label.expression}`,
      label.category && `category ${label.category}`, label.age_years && `${label.age_years} years old`,
      label.abv && `${label.abv}% ABV`, label.proof && `${label.proof} proof`, label.batch && `batch ${label.batch}`,
      label.country && `from ${label.country}`
    ].filter(Boolean);
    const labelLine = labelBits.length ? `From the label: ${labelBits.join(", ")}.` : "";

    // The plan and the scales: rating_sources (falls back to the built-in plan
    // until the search_* columns exist).
    let { data: srcData, error: srcError } = await admin.from("rating_sources")
      .select("id,name,scale,default_weight,search_tier,search_domains,search_categories");
    if (srcError) ({ data: srcData } = await admin.from("rating_sources").select("id,name,scale,default_weight"));
    const sourceRows = new Map<string, SourceRow & { name?: string }>((srcData || []).map((s: { id: string } & SourceRow) => [s.id, s]));
    const planned = (srcData || []).filter((s: PlanSource) => s.search_tier != null);
    const planSources: PlanSource[] = planned.length ? planned : DEFAULT_SEARCH_PLAN;

    let category = BAR_CATEGORIES.includes(String(label.category)) && label.category !== "other" ? String(label.category) : guessCategory(name);
    let known: Known[] = [];
    if (productId) {
      const { data: prod } = await admin.from("spirit_products").select("category").eq("id", productId).maybeSingle();
      if (prod?.category && prod.category !== "other") category = prod.category;
      const { data: revs } = await admin.from("spirit_reviews")
        .select("id,source_id,score_raw,medal,review_year,url,match_status").eq("product_id", productId);
      known = (revs || []).filter((r: { match_status: string }) => r.match_status !== "rejected").slice(0, 25)
        .map((r: Known, i: number) => ({
          ...r, ref: "r" + (i + 1),
          source: (sourceRows.get(r.source_id)?.name as string) || r.source_id,
          scale: sourceRows.get(r.source_id)?.scale || "critic100"
        }));
    }
    const found = await research(name, labelLine, planFor(category, planSources), known);
    const cost = (found.tokensIn * PRICE_IN_PER_MTOK + found.tokensOut * PRICE_OUT_PER_MTOK) / 1e6 + found.searches * PRICE_PER_SEARCH;
    const costLine = `≈${(cost * 100).toFixed(1)}¢ (${found.tokensIn} in / ${found.tokensOut} out tokens, ${found.searches} searches)`;
    if (found.error) {
      await finishLookup(admin, lookupId, { status: "failed", detail: `research ${found.error}; ${costLine}` });
      return;
    }
    const want: Attrs = {
      age_years: (label.age_years as number) ?? parseAttrs(name).age_years,
      abv: (label.abv as number) ?? parseAttrs(name).abv,
      batch: (label.batch as string) ?? parseAttrs(name).batch
    };
    const { kept, dropped } = vet(found, want, sourceRows);
    const checks = vetChecks(found, known);
    let detail = `${costLine}; ${found.reviews.length} found, ${kept.length} kept` +
      (Object.keys(dropped).length ? `; dropped ${Object.entries(dropped).map(([k, v]) => `${v} ${k}`).join(", ")}` : "") +
      (known.length ? `; checked ${known.length}: ${checks.confirmed.length} confirmed, ${checks.changed.length} changed` : "");

    // Known scores the check confirmed: stamp them, and count it as the
    // independent confirmation an unverified find needs (if someone else found it).
    const now = new Date().toISOString();
    for (const id of checks.confirmed) {
      const { data: rv } = await admin.from("spirit_reviews").select("id,origin,added_by,verified,seen_count").eq("id", id).maybeSingle();
      if (!rv) continue;
      const patch: Record<string, unknown> = { last_checked_at: now, seen_count: (rv.seen_count || 1) + 1 };
      if (!rv.verified && rv.added_by !== userId) patch.verified = true;
      await admin.from("spirit_reviews").update(patch).eq("id", id);
    }
    // A page that now shows a different score is flagged for a person, never
    // rewritten automatically (a search can land on the wrong bottle's page).
    for (const ch of checks.changed) {
      const { data: open } = await admin.from("spirit_reports").select("id").eq("review_id", ch.id).eq("status", "open").limit(1);
      if (open && open.length) continue;
      await admin.from("spirit_reports").insert({
        user_id: userId, product_id: productId, review_id: ch.id, kind: "wrong_score", status: "open",
        note: `Automatic check ${now.slice(0, 10)}: the page now shows ${ch.now} (${ch.url})`.slice(0, 300)
      });
    }

    // The bottle: the one asked about, else an exact key match, else a new one.
    const key = normName(name);
    let pid = productId;
    if (!pid) {
      const { data: hit } = await admin.from("spirit_products").select("id").eq("name_norm", key).limit(1);
      if (hit && hit.length) pid = hit[0].id;
    }
    if (!pid) {
      const { data: alias } = await admin.from("spirit_aliases").select("product_id").eq("alias_norm", key).limit(1);
      if (alias && alias.length) pid = alias[0].product_id;
    }
    if (!kept.length) {
      if (pid) {
        await admin.from("spirit_products").update({ researched_at: now }).eq("id", pid);
        await finishLookup(admin, lookupId, { status: "found", product_id: pid, added: 0, detail });
      } else {
        await finishLookup(admin, lookupId, { status: "none", product_id: null, detail });
      }
      return;
    }
    if (!pid) {
      const b = found.bottle || {};
      const canonical = String(b.canonical_name || name).trim().slice(0, 200);
      const attrs = parseAttrs(canonical);
      const cat = BAR_CATEGORIES.includes(String(b.category)) ? b.category : guessCategory(canonical);
      const row = {
        canonical_name: canonical, name_norm: normName(canonical), category: cat,
        producer: b.producer || null, country: b.country || (label.country as string) || null,
        age_years: b.age_years ?? attrs.age_years ?? want.age_years ?? null,
        abv: b.abv ?? attrs.abv ?? want.abv ?? null,
        batch: attrs.batch, is_single_barrel: attrs.single_barrel, is_store_pick: attrs.store_pick,
        created_by: userId, researched_at: now
      };
      const { data: made, error } = await admin.from("spirit_products").insert(row).select("id").single();
      if (error) {
        // The canonical name already exists (another spelling of a known bottle).
        const { data: again } = await admin.from("spirit_products").select("id").eq("name_norm", row.name_norm).limit(1);
        if (!again || !again.length) throw new Error("couldn't create product: " + error.message);
        pid = again[0].id;
      } else {
        pid = made.id;
      }
    } else {
      await admin.from("spirit_products").update({ researched_at: now }).eq("id", pid);
    }
    // Every spelling seen points at the bottle, so the next scan matches at once.
    const aliasKeys = [...new Set([key, normName(found.bottle?.canonical_name || "")].filter((k) => k && k.length >= 2))];
    if (aliasKeys.length) {
      await admin.from("spirit_aliases").upsert(aliasKeys.map((k) => ({ alias_norm: k, product_id: pid })), { onConflict: "alias_norm", ignoreDuplicates: true });
    }

    // Already in the catalog (curated, bulk, or an earlier lookup)? Then this
    // lookup is independent confirmation: mark it verified, don't add a copy.
    const { data: existing } = await admin.from("spirit_reviews")
      .select("id,source_id,review_year,score_raw,medal,origin,added_by,verified,seen_count").eq("product_id", pid);
    const byKey = new Map<string, { id: string; origin: string; added_by: string | null; verified: boolean; seen_count: number }>();
    for (const e of existing || []) {
      const raw = e.score_raw == null ? "" : String(Number(e.score_raw));
      byKey.set(`${e.source_id}|${e.review_year ?? ""}|${raw}|${(e.medal || "").toLowerCase()}`, e);
    }
    const fresh = [];
    let confirmed = 0;
    for (const k of kept) {
      const rawKey = k.row.score_raw == null ? "" : String(Number(k.row.score_raw));
      const match = byKey.get(`${k.row.source_id}|${k.row.review_year ?? ""}|${rawKey}|${String(k.row.medal || "").toLowerCase()}`);
      if (match) {
        if (checks.confirmed.includes(match.id)) continue;      // already stamped above
        const patch: Record<string, unknown> = { seen_count: (match.seen_count || 1) + 1, last_checked_at: now };
        if (!match.verified && match.added_by !== userId) patch.verified = true;
        await admin.from("spirit_reviews").update(patch).eq("id", match.id);
        confirmed++;
        continue;
      }
      fresh.push({
        ...k.row, product_id: pid, origin: "field", added_by: userId, verified: false,
        match_status: "auto", match_score: 1, last_checked_at: now,
        source_ref: `${k.row.url}#${pid}:${k.row.review_year ?? ""}:${k.row.reviewer ?? ""}`
      });
    }
    if (fresh.length) {
      const { error } = await admin.from("spirit_reviews").upsert(fresh, { onConflict: "source_id,source_ref", ignoreDuplicates: true });
      if (error) throw new Error("couldn't save reviews: " + error.message);
    }
    if (confirmed) detail += `; ${confirmed} re-found`;
    await finishLookup(admin, lookupId, { status: "found", product_id: pid, added: fresh.length, detail });
  } catch (err) {
    console.error("research-bottle: lookup failed", lookupId, err);
    await finishLookup(admin, lookupId, { status: "failed", detail: String(err).slice(0, 300) });
  }
}

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    if (!ANTHROPIC_API_KEY) return json({ error: "Server isn’t configured for bottle lookups yet (missing API key)." });
    if (!SUPABASE_SERVICE_KEY) return json({ error: "Server isn’t configured for bottle lookups yet (missing service key)." });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Please sign in first." });
    const userClient = createClient(SUPABASE_URL, SUPABASE_CLIENT_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Please sign in first." });
    const userId = userData.user.id;
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (name.length < 2) return json({ error: "Which bottle? Type its name or photograph the label." });
    let key = normName(name);
    if (!key) return json({ error: "Which bottle? Type its name or photograph the label." });
    const label = body.label && typeof body.label === "object" ? body.label : {};
    let productId: string | null = typeof body.product_id === "string" ? body.product_id : null;

    // 1. A bottle the catalog knows: re-checked unless it was checked within
    //    VERIFY_FRESH_DAYS (by anyone — the result is shared).
    if (!productId) {
      const { data: hit } = await admin.from("spirit_products").select("id").eq("name_norm", key).limit(1);
      if (hit && hit.length) productId = hit[0].id;
    }
    if (productId) {
      const { data: prod } = await admin.from("spirit_products").select("id,name_norm,researched_at").eq("id", productId).maybeSingle();
      if (!prod) productId = null;
      else {
        key = prod.name_norm || key;    // two people checking one bottle share one lookup
        if (prod.researched_at && Date.now() - Date.parse(prod.researched_at) < VERIFY_FRESH_DAYS * 864e5) {
          return json({ status: "fresh", product_id: prod.id, checked_at: prod.researched_at });
        }
      }
    }

    // 2. Running right now, or (for a bottle the catalog doesn't know) recently came up empty?
    const { data: recent } = await admin.from("spirit_lookups")
      .select("id,status,created_at").eq("name_norm", key).order("created_at", { ascending: false }).limit(5);
    for (const l of recent || []) {
      const age = Date.now() - Date.parse(l.created_at);
      if (l.status === "running" && age < RUNNING_STALE_MS) return json({ status: "running", lookup_id: l.id });
      if (l.status === "running") await finishLookup(admin, l.id, { status: "failed", detail: "stale" });
      if (!productId && l.status === "none" && age < NONE_REMEMBER_DAYS * 864e5) return json({ status: "none", cached: true });
    }

    // 3. Caps: site-wide first (no user is charged for it), then the user's own.
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const { count: today } = await admin.from("spirit_lookups").select("id", { count: "exact", head: true }).gte("created_at", since.toISOString());
    if ((today ?? 0) >= SITE_DAILY_LOOKUP_LIMIT) return json({ error: "Bottle lookups are paused for today — try again tomorrow." });
    const { data: usage, error: usageError } = await userClient.rpc("increment_bottle_usage", { usage_kind: "lookup", daily_limit: DAILY_LOOKUP_LIMIT });
    if (!usageError && usage === -1) {
      return json({ error: `You’ve used today’s ${DAILY_LOOKUP_LIMIT} bottle lookups — it resets at midnight UTC. Try again tomorrow.` });
    }
    if (usageError) console.error("bottle_usage check failed:", usageError);

    // 4. Claim it: one running lookup per bottle (a unique index enforces it).
    const { data: claimed, error: claimError } = await admin.from("spirit_lookups")
      .insert({ user_id: userId, query: name, name_norm: key, product_id: productId }).select("id").single();
    if (claimError) {
      const { data: other } = await admin.from("spirit_lookups").select("id").eq("name_norm", key).eq("status", "running").limit(1);
      if (other && other.length) return json({ status: "running", lookup_id: other[0].id });
      console.error("research-bottle: couldn't start lookup", claimError);
      return json({ error: "Couldn’t start the lookup — try again." });
    }

    const work = runLookup(admin, claimed.id, userId, name, label, productId);
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
    else await work;
    return json({ status: "running", lookup_id: claimed.id, remaining: typeof usage === "number" && usage >= 0 ? DAILY_LOOKUP_LIMIT - usage : null });
  } catch (err) {
    console.error("research-bottle error:", err);
    return json({ error: "Something went wrong. Please try again." });
  }
});

// Always responds 200 so the browser's functions.invoke() reads the body either way.
function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...corsHeaders, "content-type": "application/json" } });
}
