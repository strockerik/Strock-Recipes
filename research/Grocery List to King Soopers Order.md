# Sending a Whole Grocery List to King Soopers and Whole Foods from "House Index": What's Actually Possible in 2026

## TL;DR
- **King Soopers (Kroger): YES — whole-list cart integration is realistically achievable for a hobbyist.** Kroger runs a free, self-service *public* developer API whose Cart endpoint accepts an **array of items in a single call** (each `{upc, quantity, modality}`), so House Index can push an entire list into a user's real Kroger cart. The catch: each user must log into their own Kroger account via OAuth, and you must first translate ingredient text into Kroger UPCs using the Product Search API.
- **Whole Foods (Amazon): NO — there is no viable programmatic path.** Amazon offers no public consumer grocery cart/ordering API; the Alexa shopping-list API was shut down on July 1, 2024; the legacy "add-to-cart" URL does not work for Fresh/Whole Foods grocery items; and Instacart does not carry Whole Foods. The best you can do is a formatted, tappable list that opens the Amazon/Whole Foods app to a search.
- **The "ideal" aggregator route (Instacart's shoppable-list API) is currently closed to new developers** — Instacart's official developer page states verbatim, "We are currently not accepting new applications. There is no waitlist available at this time." So plan around the Kroger public API for King Soopers and a good-enough paste/deep-link fallback for Whole Foods.

## Key Findings

1. **Kroger has a genuinely usable public API, and registration is open to individuals.** Account creation is self-service with email verification, free, and does not require a business entity — this is the *Public* tier, distinct from the contract-gated *Partner* tier. The Cart API is rate-limited to 5,000 calls/day; the Public Products API has a 10,000-call-per-day limit; and the Public Locations API has a 1,600-call-per-day limit *per endpoint* (three endpoints, each capped at 1,600/day).

2. **Kroger's Cart API is write-only and multi-item.** A single `PUT https://api.kroger.com/v1/cart/add` accepts a JSON body with an `items` array, each element `{ "upc": "...", "quantity": 1, "modality": "PICKUP" | "DELIVERY" }`. It returns 204 No Content on success. Critically, the public API **cannot read the cart back or remove items** — those require the Partner (contract) tier. So House Index can add the full list but can't display or edit the resulting Kroger cart.

3. **Cart writes require per-user OAuth login.** The `cart.basic:write` scope requires the OAuth2 **authorization_code** flow — each user is redirected to a Kroger login/consent screen. Product search and store lookup use the **client_credentials** flow (no user login).

4. **Ingredient→product matching is the hard part, and it's solvable but imperfect.** `GET /v1/products?filter.term={term}&filter.locationId={id}` does a fuzzy search scoped to a store and returns 13-digit productIds, UPCs, pricing, aisle, and stock. Generic terms like "shredded iceberg lettuce" will return multiple candidates, so House Index should present matches for the user to confirm/pick before ordering.

5. **Amazon/Whole Foods is a dead end for automation.** No public consumer cart API exists; the Alexa List Management REST API was discontinued July 1, 2024; the `amazon.com/gp/aws/cart/add.html` URL is affiliate-era tech that is unreliable and not designed for grocery/Fresh items; and Whole Foods is not available through Instacart.

6. **Instacart's Developer Platform is exactly the right tool but is not accepting new applicants.** Its "Create shopping list page" endpoint (`POST /idp/v1/products/products_link`) takes a list of ingredients and returns a shareable URL that opens a shoppable list on Instacart Marketplace — with automatic ingredient-to-product matching, covering Kroger and ~1,800 banners. But it requires a registered business (18+, US/Canada), a review/approval process, and it is presently closed to new sign-ups. (The platform launched March 27, 2024 with launch partners including NYT Cooking, WeightWatchers, and GE Appliances.)

7. **Third-party shoppable-recipe vendors are enterprise-oriented.** Chicory, Northfork, and Whisk/Samsung Food all provide recipe→cart matching across many retailers, but they are sold to publishers/brands/retailers, not hobbyists, and generally require sales contracts. Chicory's official plugin advertises "70+ integrated retailers, including Instacart, Walmart, and Kroger" and a network of "5,200+ major food publishers like Food Network, The Pioneer Woman, and Delish" — but its self-service path (via WP Recipe Maker) requires a Chicory sign-up form for ad-revenue payment (net-60 via PayPal), confirming it targets monetizing recipe blogs, not private hobby apps.

## Details

### A. Kroger / King Soopers (King Soopers is a Kroger banner, so it uses the same API)

**APIs available (Public tier):** Authorization (OAuth2), Products, Locations, Cart, Identity. There is also a Digital Coupons/Catalog and a set of Partner APIs (Cart Partner, Seamless Delivery, Locker), but the Partner tier "is not open for public consumption" and requires a negotiated agreement.

**The Cart flow, end to end:**
1. **Find the store.** `GET /v1/locations?filter.zipCode.near={zip}` → get a `locationId` (King Soopers locations appear under the Kroger chain family). Client-credentials token with no special scope.
2. **Match each ingredient to a product.** For each list line, `GET /v1/products?filter.term={term}&filter.locationId={locationId}&filter.limit=10`. The response includes `productId`, `upc`, item description, brand, size, price, aisle, and `fulfillment` flags (curbside/delivery/instore/shiptohome) and stock level. Client-credentials + `product.compact` scope.
3. **User confirms matches** (recommended — see matching section).
4. **User authorizes.** Redirect the user to `https://api.kroger.com/v1/connect/oauth2/authorize?scope=cart.basic:write%20profile.compact&response_type=code&client_id=...&redirect_uri=...` (PKCE recommended). Exchange the returned code at `POST /v1/connect/oauth2/token` for an access token + refresh token.
5. **Add the whole list at once.** `PUT https://api.kroger.com/v1/cart/add` with `{"items":[{"upc":"0001111041700","quantity":2,"modality":"PICKUP"}, ...]}`. 204 = success.
6. The user opens the Kroger/King Soopers app, where the items are now in their cart, and checks out there.

**Auth split:**
- `client_credentials` grant → Products, Locations (no user login).
- `authorization_code` grant → Cart (`cart.basic:write`), Identity (`profile.compact`); requires user's Kroger login + consent. Refresh tokens are issued only with authorization_code.

**Limits/quirks:** Cart = 5,000 calls/day. Public API is one-way (add only; no read, no remove). No explicitly documented per-call item cap was found. A common setup gotcha: the redirect URI is marked "optional" in the app-registration form but the OAuth flow fails without it.

**Reliability signal:** The most-used open-source Kroger client (`CupOfOwls/kroger-api`) and its companion `kroger-mcp` were actively maintained into mid-2026 and demonstrate real cart adds ("checking that it appears in your account"). No confirmed 2025–2026 reports of silent cart-write failures were found, but no dated "I just got a new key in 2026" confirmations surfaced either — so treat "registration still open" as strongly-supported-but-not-freshly-confirmed.

**Shoppable-recipe partnerships:** Kroger has historically participated in shoppable-recipe programs (e.g., a Whisk/Samsung Food partnership and Chicory's network, which lists Kroger among its retailers). These are business integrations, not something a hobbyist plugs into directly.

### B. Whole Foods / Amazon — honest assessment: not feasible

- **No public consumer ordering/cart API.** Amazon does not expose an Amazon Fresh or Whole Foods consumer cart/checkout API. The **Selling Partner API** is for sellers; the **Product Advertising API (PA-API 5.0)** is for Amazon Associates and requires qualifying affiliate sales, and is about product data/links, not placing a shopper's grocery order. There is an **Amazon Business Cart API** (`POST /cart/{version}/carts/{id}/items` with `productIdentifier`/ASIN arrays) but it is a B2B Amazon Business feature, not consumer Whole Foods/Fresh ordering.
- **Add-to-cart URL is effectively dead for this use.** `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=...&Quantity.1=...` is legacy affiliate tooling; developers report it no longer reliably adds items (a representative GitHub issue was closed "wontfix"), it needs ASINs (not ingredient text), and it is not built for Fresh/Whole Foods grocery SKUs.
- **Alexa shopping list is closed.** Per Amazon's official Alexa Skills Kit deprecation page: "As of July 1, 2024, List skills and the List Management REST API to access Alexa lists, such as the Alexa Shopping and To-Do lists, in your skills or apps are no longer supported." (Users can still manage lists inside the Alexa/Amazon apps, but not via third-party API.)
- **Instacart won't help for Whole Foods** because Whole Foods is Amazon-owned and is not one of Instacart's retailers.

**Best achievable for Whole Foods/Amazon:** produce a clean, categorized list the user can (a) paste into the Amazon/Whole Foods app search, or (b) tap item-by-item via a generated list of Amazon search deep links, or (c) send to Apple Reminders/Google Keep as a checklist to shop from. This is essentially what House Index already does with Web Share/clipboard/.txt, refined.

### C. Third-party / aggregator routes

**Instacart Developer Platform (IDP)** — technically ideal, currently closed:
- `POST /idp/v1/products/products_link` (or the recipe-page endpoint) with `Authorization: Bearer <API key>`. Body: `title` + `line_items[]`, each with `name` (used as the product search term), optional `quantity`, `unit`, `display_text`, `upcs[]`/`product_ids[]` (mutually exclusive), `line_item_measurements[]`, and `filters` (brand/health). Returns `products_link_url`.
- The user taps the URL, picks a store (Kroger/King Soopers included), reviews auto-matched products, and checks out on Instacart. Deep-links into the Instacart app on iOS.
- **Access:** requires a registered business (18+, US/Canada resident), an approval review for the production key, and an Instacart Enterprise Help Desk account. There's an affiliate/commission model. **Currently not accepting new applications, no waitlist.**
- If it reopens, this would be the single best option for House Index because it offloads ingredient matching and covers many retailers — but it explicitly targets businesses, which House Index is not.

**Chicory** — 70+ retailers incl. Kroger/Instacart/Walmart; monetization via in-recipe ads; US only; self-service path is a WordPress/WP Recipe Maker plugin aimed at recipe-blog publishers who want ad revenue (net-60 PayPal payouts). Not a fit for a static private PWA.

**Northfork** — enterprise shoppable-recipe/cart-automation platform (widgets + API) sold to retailers/publishers; contract-based.

**Whisk / Samsung Food** — B2B "Food Genome" NLP matching across many retailers; enterprise partnerships (acquired by Samsung Next). Not a hobbyist API.

**Open-source / community tools:**
- `CupOfOwls/kroger-api` (Python) and `kroger-mcp` — working, MIT-licensed Kroger clients that do exactly product search + multi-item cart add with OAuth token management. Excellent reference implementations to mirror in TypeScript inside a Supabase Edge Function.
- Self-hosted recipe managers (Mealie, Tandoor, Grocy) have shopping lists but **no built-in push to a grocery retailer's cart**; it's a long-requested but unimplemented feature. They mostly export text or integrate with list apps.
- Commercial meal-planners (e.g., Mealime) integrate Kroger/Instacart/Amazon Fresh, showing the pattern is viable — but they use their own partner arrangements.

### D. Practical fallbacks that work today with minimal effort

1. **Kroger Public Cart API (best "real" integration for King Soopers)** — described above.
2. **Formatted paste list** — House Index already builds a combined list; add a "Copy for store search" format (one clean item per line, quantities separable) so the user can paste into a retailer search box. Cheapest, most robust, works for both retailers.
3. **iOS Share Sheet / Shortcuts / Reminders** — keep the existing Web Share export; optionally publish an iOS Shortcut that takes the list and creates a Reminders checklist, or opens the retailer app.
4. **Deep links to search** — generate a tappable list where each item links to a retailer search. For Amazon: `https://www.amazon.com/s?k={item}` (opens the Amazon app to a search on iOS if installed). For Kroger/King Soopers: a `https://www.kingsoopers.com/search?query={item}` style link. These open a *search*, not a pre-filled cart, and are one-item-at-a-time.

### E. Legal / terms & security considerations

- **Kroger:** Public APIs are "available for all clients"; personal/hobby use is consistent with self-service registration and the Acceptable Use Policy. You are acting on the user's behalf only after they explicitly OAuth-authorize your registered app for `cart.basic:write`. Store the client secret server-side only (never in the static frontend).
- **Instacart:** Developer terms require a registered business and an approval process, plus compliance with data/privacy and partner-messaging rules — a poor fit for a no-entity hobby app even when applications reopen.
- **Amazon:** PA-API requires an Associates account with qualifying sales; scraping or driving the consumer site programmatically violates Amazon's terms. Don't.
- **Credential handling / privacy:** For Kroger OAuth, House Index must securely store per-user access + refresh tokens. Put them in a Supabase table protected by Row Level Security (row keyed to the authenticated Supabase user), and perform all token exchanges and cart calls inside an Edge Function so the Kroger `client_secret` and users' tokens never reach the browser. Encrypt refresh tokens at rest if possible, and disclose to your ~10 users that authorizing Kroger lets the app add items to their cart.
- **Browser automation / scraping** (driving kingsoopers.com or amazon.com with a headless browser and the user's password): technically possible but violates ToS, breaks constantly, and would require handling users' retailer passwords — inappropriate here. Avoid.

## Comparison of Integration Options

| Option | What it does | Available to a hobbyist? | Cost | Difficulty for a beginner with Claude Code | Reliability / risk |
|---|---|---|---|---|---|
| **Kroger Public Cart API** | Push entire list into user's real King Soopers cart (add-only) | **Yes** — free self-service registration | Free | **Medium** — OAuth per user + product matching + Edge Function + token storage | Good; official API. Risks: write-only (no read/remove), matching quality, per-user login |
| **Kroger Product Search only** | Show matched products, prices, aisles; user adds manually | Yes | Free | Low–Medium | High; no user OAuth needed for search |
| **Instacart IDP shoppable list** | One link opens whole list, auto-matched, many retailers incl. Kroger | **No** (not accepting new apps; needs a business) | Free API + affiliate model | Low if admitted | High if admitted; but closed now, no WF |
| **Amazon / Whole Foods (any API)** | — | **No** viable consumer path | — | N/A | None works for groceries |
| **Amazon add-to-cart URL** | Legacy pre-fill cart by ASIN | Technically public | Free | Low | Poor; unreliable, needs ASINs, not for Fresh |
| **Alexa Shopping List API** | Write to user's Alexa list | **No** (discontinued July 1 2024) | — | N/A | Gone |
| **Chicory / Northfork / Whisk** | Recipe→cart across many retailers | Mostly no (enterprise/publisher) | Contract / ad-rev | N/A | High but inaccessible to a hobby app |
| **Formatted paste list** | Clean list to paste into store search | Yes | Free | Very low | Very high; manual per item |
| **Search deep links** | Tappable per-item searches in store app | Yes | Free | Low | High; one item at a time, no cart fill |

## The ingredient-text-to-product matching problem

House Index's lines look like "2 cups shredded iceberg lettuce" or "400 g pasta." Kroger's Cart API needs a **UPC**, so you must first resolve each line to a product. Recommended strategy:

1. **Normalize the line** before searching: strip the quantity/unit ("2 cups", "400 g") and keep the core noun phrase ("shredded iceberg lettuce", "pasta"). Optionally drop leading adjectives progressively if a search returns nothing.
2. **Search scoped to the user's store**: `GET /v1/products?filter.term=shredded+iceberg+lettuce&filter.locationId=...&filter.limit=10`. Kroger's fuzzy match is decent for common groceries but will return several candidates of different sizes/brands, and generic culinary terms ("clove garlic") won't map to a specific package.
3. **Convert cooking quantities to package counts.** The API returns package sizes, not "3 cloves." Don't try to be clever; default `quantity` to 1 package and let the user bump it.
4. **Always show a confirmation step.** Present the top match (with image, size, price) plus a "change" affordance per line. This is exactly how Whisk/Instacart handle it, and it turns an unreliable auto-match into a trustworthy flow. For a 10-user private app, a simple "review your matches" screen is enough.
5. **Cache confirmed matches** (ingredient string → productId/UPC) in Supabase so repeat items auto-resolve next time. This dramatically improves the experience over a few weeks of use.
6. **Store-specific:** always re-check availability at the chosen `locationId`, since a UPC cached from one store may be out of stock or not carried at another.

## Implementation sketch (Supabase Edge Function, Kroger path)

- **Secrets:** store `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` as Edge Function env vars. Never expose in the GitHub Pages/Cloudflare frontend.
- **Function `kroger-search`** (client_credentials): mints/caches a product token, loops over list lines calling `/v1/products`, returns candidate matches to the frontend for confirmation.
- **Function `kroger-oauth-start` / `kroger-oauth-callback`**: implements authorization_code + PKCE; on callback, exchanges the code and stores `{user_id, access_token, refresh_token, expires_at}` in a `kroger_tokens` table with RLS so each Supabase user sees only their row.
- **Function `kroger-cart-add`**: loads the user's token (refreshing via `refresh_token` if expired), then `PUT /v1/cart/add` with the confirmed `items[]` array; returns success/failure. Because the API is add-only, show the user a "Now open the King Soopers app to review and check out" message.
- **Frontend (vanilla JS PWA):** three buttons — "Match items" → confirmation UI → "Connect King Soopers" (first time) → "Send list to cart."

**Instacart variant (only if IDP reopens and you accept the business terms):** a single Edge Function calls `POST /idp/v1/products/products_link` with the list as `line_items[]` and returns `products_link_url`; the frontend opens it. Far less code and no per-user OAuth, but currently unavailable.

## Recommendations

**Stage 1 — Ship the zero-risk fallback now (days).** Add a "Copy for store search" export format and a tappable per-item search-link list (Amazon `s?k=`, King Soopers `search?query=`). This immediately improves both retailers with no API, no auth, no approval. Benchmark to move on: users say the paste/search flow is too tedious.

**Stage 2 — Build the Kroger/King Soopers Cart integration (the real win).** Register a free Kroger developer app, implement product search + a confirmation UI + per-user OAuth + `PUT /v1/cart/add` in Supabase Edge Functions, mirroring the open-source `kroger-api` patterns in TypeScript. This delivers true "send my whole list to the cart" for King Soopers. Benchmark to expand: match accuracy is good enough that users trust it without editing more than a couple of lines.

**Stage 3 — Keep Instacart in your back pocket.** Periodically check whether the Instacart Developer Platform reopens to new applicants. If it does and you're willing to form even a minimal entity, it becomes the lowest-maintenance multi-retailer option (and would also cover King Soopers), though it will never cover Whole Foods.

**For Whole Foods specifically:** accept that automated whole-list ordering isn't available; invest only in the formatted-list + Amazon-search-deep-link experience. Re-evaluate only if Amazon ever launches a consumer grocery cart API (no sign of one as of July 2026).

**Do not** attempt browser automation/scraping or storing users' retailer passwords — it violates terms, breaks often, and creates security liability disproportionate to a 10-user hobby app.

## Caveats
- Kroger's developer docs are JavaScript-gated and block automated fetching, so several technical specifics (the literal `/v1/cart/add` path and the 204 status) are corroborated primarily via widely-used open-source clients and Google-indexed doc snippets rather than a live read of the official page. The request shape, scopes, auth split, and rate limits are consistent across multiple sources and are high-confidence.
- I could not find dated 2025–2026 first-person reports confirming new hobbyist key issuance or reporting cart-write failures; "registration open" rests on official self-service wording plus actively maintained 2026 open-source projects.
- No explicit per-call item limit for the Kroger Cart API was found — test with your real list sizes.
- Instacart's "not accepting new applications" status can change; verify directly before planning around it.
- Retailer web search URL patterns (kingsoopers.com/search, amazon.com/s) can change without notice; validate before shipping.