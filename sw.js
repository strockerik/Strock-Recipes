/* The House Index — service worker: open offline, with your last-synced data.
 *
 * Two caches, two jobs:
 *  - SHELL: the app's own files (page, script, styles, Supabase library, icons,
 *    fonts). Network-first for our files, so an online visit always gets the
 *    latest deploy and nobody is stranded on an old version; the cached copy is
 *    only the fallback. Fonts (self-hosted since v1.9) never change, so they're
 *    cache-first.
 *  - DATA: GET reads from the Supabase REST API (recipes, grocery list, plan,
 *    inventory, prefs). Network-first; the cached copy answers when the network
 *    is gone or too slow (lie-fi in a grocery store). Only a signed-in user's
 *    reads are stored, and the cache belongs to one user at a time.
 *
 * Writes, auth, and the Edge Functions (AI, King Soopers) always go straight to
 * the network: there is nothing sensible to serve for them offline. A write that
 * succeeds re-reads that table's saved copies, so an offline open shows it.
 *
 * Kill switch: if this ever misbehaves, replace this file with one whose
 * activate handler calls self.registration.unregister() and deploy.
 */
const VERSION = "v3"; // bump to retire every old shell cache on the next visit (v3: v2.3.1, copies refreshed after writes)
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = "data-v1";
const META_KEY = "/__sw-meta/user"; // which user the DATA cache belongs to
const DATA_CACHE_MAX = 80;          // entries; old date-ranged meal-plan reads age out
const SHELL_TIMEOUT_MS = 4000;      // serve the cached shell if the network stalls
const DATA_TIMEOUT_MS = 6000;

// Everything index.html loads, read from the page itself at install time so a
// renamed vendor file never needs a matching edit here.
async function shellUrls() {
  const urls = new Set(["./", "index.html", "manifest.json", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"]);
  try {
    const html = await (await fetch("index.html", { cache: "no-cache" })).text();
    for (const m of html.matchAll(/<(?:script[^>]+src|link[^>]+rel="stylesheet"[^>]+href)="([^"]+)"/g)) {
      if (!/^https?:/.test(m[1])) urls.add(m[1]);
    }
    // The font files style.css names, so a first visit already works offline.
    const css = await (await fetch("style.css", { cache: "no-cache" })).text();
    for (const m of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) urls.add(m[1]);
  } catch { /* offline during install — the runtime cache fills in later */ }
  return [...urls];
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One by one, so a single missing file can't fail the whole install.
    for (const url of await shellUrls()) {
      try { await cache.add(new Request(url, { cache: "no-cache" })); } catch { /* skip */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("shell-") && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// The page posts "clear-data" on sign-out, so a signed-out phone keeps nothing.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-data") event.waitUntil(caches.delete(DATA_CACHE));
});

// The user id (JWT `sub`) on a request, or null for the anon/publishable key —
// whose reads must never be cached: RLS answers them with empty lists, which
// would overwrite a good offline copy.
function userIdFromRequest(request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return json && json.role === "authenticated" && json.sub ? String(json.sub) : null;
  } catch { return null; }
}

// Race the network against a timer. Resolves to the network response, or to
// null if the timer wins or the network fails; the network keeps going in the
// background either way (so the cache still gets refreshed).
function networkWithin(ms, networkPromise) {
  return Promise.race([
    networkPromise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

async function storeData(request, response, userId) {
  const cache = await caches.open(DATA_CACHE);
  const owner = await cache.match(META_KEY);
  const ownerId = owner ? await owner.text() : null;
  if (ownerId !== userId) {
    // A different person is signed in on this device now: drop the old copy.
    await caches.delete(DATA_CACHE);
    const fresh = await caches.open(DATA_CACHE);
    await fresh.put(META_KEY, new Response(userId));
    await fresh.put(request.url, response);
    return;
  }
  await cache.put(request.url, response);
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - 1 - DATA_CACHE_MAX))) {
    if (!old.url.endsWith(META_KEY)) await cache.delete(old);
  }
}

// The app fires several reads at once; serialize the writes so two of them can't
// both see "new user" and wipe each other's fresh copies.
let storeQueue = Promise.resolve();
function queueStore(request, response, userId) {
  storeQueue = storeQueue.then(() => storeData(request, response, userId)).catch(() => {});
  return storeQueue;
}

async function handleData(event) {
  const { request } = event;
  const userId = userIdFromRequest(request);
  const network = fetch(request).then((response) => {
    if (response.ok && userId) event.waitUntil(queueStore(request, response.clone(), userId));
    return response;
  });
  const fast = await networkWithin(DATA_TIMEOUT_MS, network);
  if (fast) return fast;
  const cached = await (await caches.open(DATA_CACHE)).match(request.url);
  // No copy: let the real network outcome (or its error) through.
  return cached || network;
}

// A write that reached the server makes this device's saved copies of that table
// stale: adding a recipe to the list at home, then opening the list in a store
// with no signal, used to show the list from before the add. Re-read each saved
// copy of the table (same user, same Accept, so a single-row read stays one row);
// a copy that can't be re-read is dropped rather than kept stale.
async function refreshTable(table, userId, headers) {
  const cache = await caches.open(DATA_CACHE);
  const owner = await cache.match(META_KEY);
  if (!owner || (await owner.text()) !== userId) return;
  for (const key of await cache.keys()) {
    if (!new URL(key.url).pathname.endsWith(`/rest/v1/${table}`)) continue;
    const old = await cache.match(key);
    const single = ((old && old.headers.get("content-type")) || "").includes("vnd.pgrst.object");
    try {
      const fresh = await fetch(key.url, {
        headers: { ...headers, Accept: single ? "application/vnd.pgrst.object+json" : "application/json" }
      });
      if (fresh.ok) { await cache.put(key.url, fresh); continue; }
    } catch { /* fall through: drop the stale copy */ }
    await cache.delete(key);
  }
}

async function handleWrite(event, table) {
  const { request } = event;
  const userId = userIdFromRequest(request);
  const headers = {};
  for (const h of ["Authorization", "apikey"]) if (request.headers.get(h)) headers[h] = request.headers.get(h);
  const response = await fetch(request);   // offline: rejects, exactly as without a worker
  if (response.ok && userId) {
    storeQueue = storeQueue.then(() => refreshTable(table, userId, headers)).catch(() => {});
    event.waitUntil(storeQueue);
  }
  return response;
}

async function handleShell(event) {
  const { request } = event;
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(request, copy)));
    }
    return response;
  });
  const fast = await networkWithin(SHELL_TIMEOUT_MS, network);
  if (fast) return fast;
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" })
    || (request.mode === "navigate" ? await cache.match("index.html") : undefined);
  return cached || network;
}

async function handleFont(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then((response) => {
    if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
    return response;
  });
  if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
  return network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET") {
    // Writes to a table (not /rpc/) pass straight through, then refresh its copies.
    const table = ["POST", "PATCH", "PUT", "DELETE"].includes(request.method)
      && url.pathname.match(/\/rest\/v1\/([A-Za-z0-9_]+)$/);
    if (table) event.respondWith(handleWrite(event, table[1]));
    return;
  }
  if (url.pathname.includes("/rest/v1/")) { event.respondWith(handleData(event)); return; }
  if (url.origin === self.location.origin && url.pathname.includes("/fonts/")) { event.respondWith(handleFont(event)); return; }
  if (url.origin === self.location.origin && !url.pathname.endsWith("/sw.js")) event.respondWith(handleShell(event));
  // Anything else (auth, Edge Functions, other hosts) goes to the network untouched.
});
