// Supabase Edge Function: kroger
//
// Turns the House Index grocery list into a King Soopers (Kroger) order. King
// Soopers is a Kroger banner, so it uses the same public Kroger API.
//
// Stage A (this file): the no-login half — mint a client-credentials token
// server-side and use it for:
//   - mode "stores":  { zip } -> nearby Kroger/King Soopers locations to pick from.
//   - mode "search":  { items, locationId, productPref } -> match each grocery
//       line to a store product (organic-preferred / cheapest / best), caching
//       each pick per-user in `kroger_matches` so re-cooking a recipe re-resolves
//       to the same product for free.
// Stage B (later): mode "connect" (per-user OAuth code->token) and mode "cart"
//   (PUT the confirmed items into the user's real cart). Not in this file yet.
//
// Mirrors the other functions: POST + forced JWT auth, always-200 json(), secrets
// server-side only. Fail-safe: with no Kroger credentials set, every mode returns
// a friendly "not configured" error, so deploying this is a no-op until the user
// adds KROGER_CLIENT_ID / KROGER_CLIENT_SECRET.

import { createClient } from "jsr:@supabase/supabase-js@2";

const KROGER_CLIENT_ID = Deno.env.get("KROGER_CLIENT_ID");
const KROGER_CLIENT_SECRET = Deno.env.get("KROGER_CLIENT_SECRET");
const KROGER_BASE = "https://api.kroger.com/v1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// ---- Client-credentials token (no user login) — minted once, cached in-memory
// across warm invocations until shortly before expiry. Used for Products +
// Locations; the cart (Stage B) needs a per-user token instead.
let ccToken: { value: string; expiresAt: number } | null = null;
async function clientToken(): Promise<string | null> {
  if (ccToken && Date.now() < ccToken.expiresAt - 30_000) return ccToken.value;
  try {
    const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "authorization": `Basic ${btoa(`${KROGER_CLIENT_ID}:${KROGER_CLIENT_SECRET}`)}`
      },
      body: "grant_type=client_credentials&scope=product.compact",
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) { console.error("Kroger token error:", res.status, await res.text()); return null; }
    const data = await res.json();
    if (!data.access_token) return null;
    ccToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 1800) * 1000 };
    return ccToken.value;
  } catch (e) {
    console.error("Kroger token fetch failed:", e);
    return null;
  }
}

async function krogerGet(path: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${KROGER_BASE}${path}`, {
      headers: { "authorization": `Bearer ${token}`, "accept": "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
    if (res.status === 401) { ccToken = null; return { _unauth: true }; } // token stale — caller retries once
    if (!res.ok) { console.error("Kroger GET error:", path, res.status); return null; }
    return await res.json();
  } catch (e) {
    console.error("Kroger GET failed:", path, e);
    return null;
  }
}

// A grocery line -> a compact Kroger search term AND the per-user cache key.
// Deterministic so the same ingredient re-resolves from cache next time. The
// frontend already hands us `item` as a shopper-facing name (prep stripped).
function searchTerm(item: string): string {
  return String(item || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")     // drop parentheticals
    .replace(/[^a-z0-9 ]/g, " ")    // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

// Pull the fields we show/order from a Kroger product node, tolerating the
// API's nested shape. Returns null if there's no usable product.
function shapeProduct(p: any): any | null {
  if (!p || !p.productId) return null;
  const it = Array.isArray(p.items) && p.items[0] ? p.items[0] : {};
  const priceObj = it.price || {};
  const price = typeof priceObj.promo === "number" && priceObj.promo > 0 ? priceObj.promo
    : typeof priceObj.regular === "number" ? priceObj.regular : null;
  let imageUrl = "";
  const img = Array.isArray(p.images) ? (p.images.find((i: any) => i.perspective === "front") || p.images[0]) : null;
  if (img && Array.isArray(img.sizes)) {
    const s = img.sizes.find((z: any) => z.size === "medium") || img.sizes.find((z: any) => z.size === "thumbnail") || img.sizes[0];
    imageUrl = s?.url || "";
  }
  const aisle = Array.isArray(p.aisleLocations) && p.aisleLocations[0]
    ? (p.aisleLocations[0].description || p.aisleLocations[0].bayNumber || "") : "";
  return {
    productId: p.productId,
    upc: p.upc || "",
    description: p.description || "",
    brand: p.brand || "",
    size: it.size || "",
    price,
    imageUrl,
    aisle,
    isOrganic: /\borganic\b/i.test(`${p.description || ""} ${p.brand || ""}`)
  };
}

// Choose the default product per the user's preference. The review sheet lets
// them change it; this is just the auto-pick for a quick ship.
function pickDefault(products: any[], pref: string): any | null {
  const shaped = products.map(shapeProduct).filter(Boolean);
  if (!shaped.length) return null;
  const withPrice = shaped.filter((p) => typeof p.price === "number");
  const cheapest = () => (withPrice.length ? withPrice.slice().sort((a, b) => a.price - b.price)[0] : shaped[0]);
  if (pref === "organic") {
    const org = shaped.filter((p) => p.isOrganic);
    const orgPriced = org.filter((p) => typeof p.price === "number");
    return orgPriced.length ? orgPriced.sort((a, b) => a.price - b.price)[0] : (org[0] || cheapest());
  }
  if (pref === "cheapest") return cheapest();
  return shaped[0]; // "best" — Kroger's own top result
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!KROGER_CLIENT_ID || !KROGER_CLIENT_SECRET) {
      return json({ error: "King Soopers ordering isn’t set up yet (missing Kroger API credentials)." });
    }

    // Verify the caller is a logged-in House Index user (their JWT scopes the
    // kroger_matches cache reads/writes below via RLS).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Please sign in first." });
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Please sign in first." });

    const body = await req.json();
    const mode = body.mode === "search" ? "search" : body.mode === "stores" ? "stores" : null;
    if (!mode) return json({ error: "Unsupported request." });

    let token = await clientToken();
    if (!token) return json({ error: "Couldn’t reach King Soopers right now — try again in a moment." });

    // ---- mode "stores": zip -> nearby locations to pick from ----
    if (mode === "stores") {
      const zip = String(body.zip || "").replace(/[^0-9]/g, "").slice(0, 5);
      if (zip.length !== 5) return json({ error: "Enter a 5-digit ZIP code." });
      let res = await krogerGet(`/locations?filter.zipCode.near=${zip}&filter.limit=10`, token);
      if (res?._unauth) { token = await clientToken(); res = token ? await krogerGet(`/locations?filter.zipCode.near=${zip}&filter.limit=10`, token) : null; }
      if (!res) return json({ error: "Couldn’t look up stores — try again." });
      const stores = (Array.isArray(res.data) ? res.data : []).map((loc: any) => ({
        locationId: loc.locationId,
        name: loc.name || (loc.chain ? `${loc.chain}` : "Store"),
        chain: loc.chain || "",
        address: [loc.address?.addressLine1, loc.address?.city, loc.address?.state].filter(Boolean).join(", ")
      })).filter((s: any) => s.locationId);
      if (!stores.length) return json({ error: "No King Soopers / Kroger stores found near that ZIP." });
      return json({ stores });
    }

    // ---- mode "search": grocery items -> matched products (cache-first) ----
    const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
    const locationId = String(body.locationId || "").trim();
    const pref = ["organic", "cheapest", "best"].includes(body.productPref) ? body.productPref : "best";
    if (!items.length) return json({ error: "Your grocery list is empty." });
    if (!locationId) return json({ error: "Pick your King Soopers store first." });

    // Load this user's cached matches once (RLS returns only their rows).
    const cache: Record<string, any> = {};
    const { data: cacheRows } = await supabaseClient
      .from("kroger_matches").select("ingredient_key, product_id, upc, description, image_url");
    (cacheRows || []).forEach((r: any) => { cache[r.ingredient_key] = r; });

    const results: any[] = [];
    const toCache: any[] = [];
    for (const raw of items) {
      const key = raw?.key ?? "";
      const term = searchTerm(raw?.item ?? "");
      if (!term) { results.push({ key, item: raw?.item ?? "", product: null }); continue; }

      // Cache hit -> reuse the product the user landed on last time.
      if (cache[term]) {
        const c = cache[term];
        results.push({ key, item: raw.item, term, cached: true,
          product: { productId: c.product_id, upc: c.upc, description: c.description, imageUrl: c.image_url } });
        continue;
      }

      let res = await krogerGet(`/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${encodeURIComponent(locationId)}&filter.limit=10`, token);
      if (res?._unauth) { token = await clientToken(); res = token ? await krogerGet(`/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${encodeURIComponent(locationId)}&filter.limit=10`, token) : null; }
      const product = res && Array.isArray(res.data) ? pickDefault(res.data, pref) : null;
      results.push({ key, item: raw.item, term, product });
      if (product) {
        toCache.push({ ingredient_key: term, product_id: product.productId, upc: product.upc,
          description: product.description, image_url: product.imageUrl });
      }
    }

    // Persist newly-resolved matches for next time (best-effort; never blocks).
    if (toCache.length) {
      try {
        await supabaseClient.from("kroger_matches")
          .upsert(toCache.map((m) => ({ ...m, updated_at: new Date().toISOString() })), { onConflict: "user_id,ingredient_key" });
      } catch (e) { console.error("kroger_matches upsert failed:", e); }
    }

    const matched = results.filter((r) => r.product).length;
    return json({ results, matched, total: results.length, storeId: locationId });
  } catch (err) {
    console.error("kroger error:", err);
    return json({ error: "Something went wrong. Please try again." });
  }
});

// Always responds 200 so the browser's functions.invoke() reads the body either way.
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "content-type": "application/json" }
  });
}
