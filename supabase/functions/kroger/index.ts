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
// Stage B (this file): the per-user OAuth half —
//   - mode "auth-url": { code_challenge, state } -> the Kroger authorize URL the
//       browser redirects to (client_id + redirect_uri live server-side).
//   - mode "connect":  { code, code_verifier } -> exchange the returned code for
//       access + refresh tokens (authorization_code + PKCE), store per-user in
//       `kroger_tokens`.
//   - mode "cart":     { items, modality } -> load the user's token (refresh if
//       expired) and PUT the whole list into their real cart in one call.
//
// Mirrors the other functions: POST + forced JWT auth, always-200 json(), secrets
// server-side only. Fail-safe: with no Kroger credentials set, every mode returns
// a friendly "not configured" error, so deploying this is a no-op until the user
// adds KROGER_CLIENT_ID / KROGER_CLIENT_SECRET (+ KROGER_REDIRECT_URI for Stage B).

import { createClient } from "jsr:@supabase/supabase-js@2";

const KROGER_CLIENT_ID = Deno.env.get("KROGER_CLIENT_ID");
const KROGER_CLIENT_SECRET = Deno.env.get("KROGER_CLIENT_SECRET");
const KROGER_REDIRECT_URI = Deno.env.get("KROGER_REDIRECT_URI"); // the deployed app URL (Stage B OAuth)
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
// We also (a) collapse "A, B, or C" alternatives to the first option and (b) drop
// descriptors that over-constrain a store search — long recipe phrasings like
// "vermicelli, angel hair, or spaghetti pasta" or "yellow baby potatoes" were
// returning no products. Progressive relaxation (searchProduct) handles the rest.
function searchTerm(item: string): string {
  let s = String(item || "").toLowerCase()
    // Fold accents so "tomato purée" searches "tomato puree", not "tomato pur e".
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)/g, " ");
  // Strip noise that over-constrains a store search (canned-good boilerplate,
  // percentages, packing liquid, and over-specific descriptors) FIRST — so a
  // descriptor comma like "boneless, skinless" isn't mistaken for an alternative.
  s = s
    .replace(/\d+\s*%/g, " ")
    .replace(/\bfat[-\s]?free\b/g, " ")
    .replace(/\b(?:packed\s+)?in\s+(?:water|brine|oil|juice)\b/g, " ")
    // Temp words only when they qualify a liquid ("hot beef stock" -> "beef
    // stock"); never a flavor — "hot sauce" must stay "hot sauce".
    .replace(/\b(?:hot|cold|warm|lukewarm|chilled|iced)\s+(?=(?:beef|chicken|vegetable|veg|water|milk|stock|broth|cream)\b)/g, " ")
    .replace(/\bchill?i(?:es)?\b/g, "chili") // British "chilli"/"chillies" -> chili
    .replace(/\b(?:boneless|skinless|baby|fresh|freshly|organic|canned|can|condensed|chunk|sprig|large|extra)\b/g, " ");
  s = s.replace(/[^a-z0-9, ]/g, " ").replace(/\s+/g, " ").replace(/^[\s,]+/, "").trim();
  // Then take the first of an "A, B, or C" / "X or Y" alternative list.
  s = s.split(/\s*,\s*|\s+or\s+/)[0];
  return s.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

// A guard against absurd matches: the picked product's description must share a
// meaningful word (>=4 chars) with the search term. Matching is bidirectional
// substring so store-spelling variants still pass — "cornstarch" <-> "Corn
// Starch", "mayonnaise" <-> "Mayo" — while zero-overlap junk is killed ("Grand
// Marnier" -> "Garnier hair spray").
function relevantMatch(term: string, description: string): boolean {
  const t = term.split(" ").filter((w) => w.length >= 4);
  if (!t.length) return true; // nothing distinctive to check
  const d = String(description || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  return t.some((tw) => d.some((dw) => dw.includes(tw) || tw.includes(dw)));
}

// Search products for a term, relaxing on a miss: if the full term returns
// nothing, drop the leading word and retry (up to a few times) so "yellow baby
// potatoes" -> "potatoes" and "chicken breasts" still resolve. Returns the picked
// product (or null) plus whether the token expired.
// deno-lint-ignore no-explicit-any
async function searchProduct(term: string, locationId: string, token: string, pref: string): Promise<{ product: any | null; unauth?: boolean }> {
  const words = term.split(" ").filter(Boolean);
  const maxTries = Math.min(words.length, 3);
  for (let start = 0; start < maxTries; start++) {
    const q = words.slice(start).join(" ");
    if (!q) break;
    const res = await krogerGet(`/products?filter.term=${encodeURIComponent(q)}&filter.locationId=${encodeURIComponent(locationId)}&filter.limit=10`, token);
    if (res?._unauth) return { product: null, unauth: true };
    if (res && Array.isArray(res.data) && res.data.length) {
      const product = pickDefault(res.data, pref);
      if (product && relevantMatch(q, product.description)) return { product };
    }
  }
  return { product: null };
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

// ---- Stage B: per-user OAuth token helpers ----------------------------------
// POST to Kroger's token endpoint with HTTP Basic client auth. Shared by the
// authorization_code exchange (connect) and the refresh_token rotation (cart).
async function tokenPost(params: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "authorization": `Basic ${btoa(`${KROGER_CLIENT_ID}:${KROGER_CLIENT_SECRET}`)}`
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) { console.error("Kroger token exchange error:", res.status, await res.text()); return null; }
    return await res.json();
  } catch (e) {
    console.error("Kroger token exchange failed:", e);
    return null;
  }
}

// Load the caller's stored Kroger access token (RLS returns only their row),
// refreshing it via the refresh_token when expired. Returns the access token, or
// null when the user hasn't connected / the refresh failed (they must re-auth).
// deno-lint-ignore no-explicit-any
async function getUserAccessToken(client: any): Promise<string | null> {
  const { data: rows } = await client
    .from("kroger_tokens").select("access_token, refresh_token, expires_at").limit(1);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row?.refresh_token) return null;
  const notExpired = row.access_token && row.expires_at && Date.parse(row.expires_at) > Date.now() + 30_000;
  if (notExpired) return row.access_token;
  // Refresh.
  const t = await tokenPost({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  if (!t?.access_token) return null;
  const expiresAt = new Date(Date.now() + (Number(t.expires_in) || 1800) * 1000).toISOString();
  try {
    await client.from("kroger_tokens").upsert({
      user_id: (await client.auth.getUser()).data.user.id,
      access_token: t.access_token,
      refresh_token: t.refresh_token || row.refresh_token, // Kroger may rotate the refresh token
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
  } catch (e) { console.error("kroger_tokens refresh upsert failed:", e); }
  return t.access_token;
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
    const mode = ["stores", "search", "auth-url", "connect", "cart"].includes(body.mode) ? body.mode : null;
    if (!mode) return json({ error: "Unsupported request." });

    // ---- Stage B modes (per-user OAuth; no client-credentials token needed) ----

    // mode "auth-url": build the Kroger login URL (client_id + redirect_uri are
    // server-side); the browser does PKCE and passes us its code_challenge+state.
    if (mode === "auth-url") {
      if (!KROGER_REDIRECT_URI) return json({ error: "King Soopers login isn’t set up yet (missing redirect URI)." });
      const codeChallenge = String(body.code_challenge || "");
      const state = String(body.state || "");
      if (!codeChallenge || !state) return json({ error: "Couldn’t start the King Soopers login." });
      const url = `${KROGER_BASE}/connect/oauth2/authorize?` + new URLSearchParams({
        response_type: "code",
        client_id: KROGER_CLIENT_ID!,
        redirect_uri: KROGER_REDIRECT_URI,
        scope: "cart.basic:write profile.compact",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state
      }).toString();
      return json({ url });
    }

    // mode "connect": exchange the returned code for tokens and store them.
    if (mode === "connect") {
      if (!KROGER_REDIRECT_URI) return json({ error: "King Soopers login isn’t set up yet (missing redirect URI)." });
      const code = String(body.code || "");
      const codeVerifier = String(body.code_verifier || "");
      if (!code || !codeVerifier) return json({ error: "Couldn’t finish the King Soopers login — try again." });
      const t = await tokenPost({ grant_type: "authorization_code", code, redirect_uri: KROGER_REDIRECT_URI, code_verifier: codeVerifier });
      if (!t?.access_token || !t?.refresh_token) return json({ error: "King Soopers login failed — please try connecting again." });
      const expiresAt = new Date(Date.now() + (Number(t.expires_in) || 1800) * 1000).toISOString();
      const { error: upErr } = await supabaseClient.from("kroger_tokens").upsert({
        user_id: userData.user.id,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });
      if (upErr) { console.error("kroger_tokens store failed:", upErr); return json({ error: "Connected, but couldn’t save the link — try again." }); }
      return json({ ok: true });
    }

    // mode "cart": push the whole matched list into the user's real cart at once.
    if (mode === "cart") {
      const accessToken = await getUserAccessToken(supabaseClient);
      if (!accessToken) return json({ error: "not_connected" });
      const modality = body.modality === "DELIVERY" ? "DELIVERY" : "PICKUP";
      const items = (Array.isArray(body.items) ? body.items : [])
        .map((i: any) => ({ upc: String(i?.upc || "").trim(), quantity: Math.max(1, Math.min(Number(i?.quantity) || 1, 99)), modality }))
        .filter((i: any) => i.upc);
      if (!items.length) return json({ error: "No matched items to send." });
      try {
        const res = await fetch(`${KROGER_BASE}/cart/add`, {
          method: "PUT",
          headers: { "authorization": `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ items }),
          signal: AbortSignal.timeout(20_000)
        });
        if (res.status === 401) return json({ error: "not_connected" }); // token revoked upstream
        if (!res.ok) { console.error("Kroger cart error:", res.status, await res.text()); return json({ error: "Couldn’t add to your King Soopers cart — try again." }); }
        return json({ ok: true, added: items.length });
      } catch (e) {
        console.error("Kroger cart failed:", e);
        return json({ error: "Couldn’t reach King Soopers — try again." });
      }
    }

    // ---- Stage A modes (client-credentials token) ----
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
    // TEMP: raised 60 -> 150 for a full-blast ~25-recipe test. LOWER BACK TO 60
    // when done (a normal single/few-recipe list never approaches 60).
    const items = Array.isArray(body.items) ? body.items.slice(0, 150) : [];
    const locationId = String(body.locationId || "").trim();
    const pref = ["organic", "cheapest", "best"].includes(body.productPref) ? body.productPref : "best";
    if (!items.length) return json({ error: "Your grocery list is empty." });
    if (!locationId) return json({ error: "Pick your King Soopers store first." });

    // Load this user's cached matches once (RLS returns only their rows).
    const cache: Record<string, any> = {};
    const { data: cacheRows } = await supabaseClient
      .from("kroger_matches").select("ingredient_key, product_id, upc, description, image_url");
    (cacheRows || []).forEach((r: any) => { cache[r.ingredient_key] = r; });

    // Resolve each item in original order. Cache hits are instant; misses hit
    // the Kroger API and are searched with bounded CONCURRENCY so a big list
    // (a whole recipe book) finishes in seconds instead of timing out.
    const results: any[] = new Array(items.length);
    const toCache: any[] = [];
    const misses: { idx: number; key: string; item: string; term: string }[] = [];
    items.forEach((raw: any, idx: number) => {
      const key = raw?.key ?? "";
      const item = raw?.item ?? "";
      const term = searchTerm(item);
      if (!term) { results[idx] = { key, item, product: null }; return; }
      if (cache[term]) {
        const c = cache[term];
        results[idx] = { key, item, term, cached: true,
          product: { productId: c.product_id, upc: c.upc, description: c.description, imageUrl: c.image_url } };
        return;
      }
      misses.push({ idx, key, item, term });
    });

    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
      while (cursor < misses.length) {
        const m = misses[cursor++];
        let sr = await searchProduct(m.term, locationId, token!, pref);
        if (sr.unauth) { const t = await clientToken(); if (t) { token = t; sr = await searchProduct(m.term, locationId, token, pref); } }
        const product = sr.product;
        results[m.idx] = { key: m.key, item: m.item, term: m.term, product };
        if (product) {
          toCache.push({ ingredient_key: m.term, product_id: product.productId, upc: product.upc,
            description: product.description, image_url: product.imageUrl });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, misses.length) }, () => worker()));

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
