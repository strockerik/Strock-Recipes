#!/usr/bin/env python3
"""Offline support + Content Security Policy test (no backend, no spend).

Three parts, all in headless Chrome against a local server:
  A. The REAL index.html head (with its CSP <meta>) and body, with the Supabase
     library and config swapped for same-origin stub files (inline script would
     itself violate the policy). Records every securitypolicyviolation while the
     main sheets open and a photo is staged, and checks the service worker
     registers under the policy.
  B. The REAL sw.js against a server that can be switched "offline": a signed-in
     user's reads are served from cache once the network is gone, the app shell
     opens offline, anon reads are never cached, a different user wipes the copy,
     and "clear-data" (sign-out) wipes it.
  C. app.js offline logic with Supabase stubbed: an expired stored session opens
     the app (not the sign-in gate) with the offline banner, a grocery tick made
     offline is kept and queued, and coming back online replays it.
Run from anywhere in the repo:  python3 testing-skills/offline_csp_test.py [--keep]
"""
import functools, http.server, json, pathlib, re, socketserver, subprocess, sys, threading

def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "sw.js").exists():
            return d
    sys.exit("no repo root found")
REPO = find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OFFLINE = {"on": False}
RESULTS = {"latest": None}

# A tiny fake JWT: the service worker only base64-decodes the payload.
def jwt(payload):
    import base64
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"{b({'alg': 'none'})}.{b(payload)}.sig"
USER_A = jwt({"sub": "user-a", "role": "authenticated"})
USER_B = jwt({"sub": "user-b", "role": "authenticated"})
ANON = jwt({"role": "anon"})

# ---------------------------------------------------------------- stub files
SUPABASE_STUB = r"""
// Same-origin stand-in for vendor/supabase + config.js (part A).
window.SUPABASE_URL = "http://localhost/stub"; window.SUPABASE_ANON_KEY = "stub";
window.CSP_VIOLATIONS = [];
document.addEventListener("securitypolicyviolation", (e) => {
  CSP_VIOLATIONS.push(e.violatedDirective + " <- " + (e.blockedURI || "inline") + (e.sourceFile ? " @" + e.sourceFile.split("/").pop() + ":" + e.lineNumber : ""));
});
const RECIPES = [{ id: "r1", user_id: "u1", section: "kitchen", name: "Test Soup", subtitle: null, source: null, tags: ["soup"],
  base_servings: 4, servings_label: "servings", created_at: "2026-01-01T00:00:00Z",
  ingredients: [{ amount: 1, unit: "cup", item: "broth", group: null }], method: [{ text: "Simmer 10 minutes.", group: null }],
  specs: null, notes: null, is_favorite: false }];
function builder(table) {
  let single = false;
  const val = () => {
    if (table === "recipes") return { data: RECIPES, error: null };
    const prof = { id: "u1", display_name: "T", diet_prefs: null, grocery_prefs: null, kroger_prefs: null };
    if (table === "profiles") return { data: single ? prof : [prof], error: null };
    return { data: single ? null : [], error: null };
  };
  const p = new Proxy({}, { get: (t, k) => {
    if (k === "then") return (f, r) => Promise.resolve(val()).then(f, r);
    if (k === "single") return () => { single = true; return p; };
    return () => p;
  }});
  return p;
}
window.supabase = { createClient: () => ({
  from: builder, rpc: () => Promise.resolve({ data: 0, error: null }),
  auth: {
    onAuthStateChange: (cb) => { setTimeout(() => cb("INITIAL_SESSION", { user: { id: "u1", email: "t@example.com" } }), 0); return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    refreshSession: () => Promise.resolve({ data: {}, error: null }),
    signOut: () => Promise.resolve({ error: null })
  },
  functions: { invoke: () => Promise.resolve({ data: {}, error: null }) }
}) };
window.confirm = () => true;
"""

CSP_DRIVER = r"""
// Runs after app.js (part A): exercise the surfaces most likely to load something.
(async () => {
  const R = [];
  const report = (R, done) => fetch("/__results", { method: "POST", body: JSON.stringify({ done: !!done, R }) }).catch(() => {});
  const ok = (n, c, d) => { R.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) }); report(R); };
  const later = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => el && el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  const $ = (s) => document.querySelector(s);
  try {
    for (let i = 0; i < 60 && !$('.item[data-id="r1"]'); i++) await later(50);
    ok("A: app booted under the CSP", !!$('.item[data-id="r1"]'));
    click($('.item[data-id="r1"] .item-head')); await later(50);
    click($("#add-recipe")); await later(30); click($("#close-recipe-form")); await later(30);
    click($("#add-recipe-ai")); await later(30);
    // Stage a photo: the preview is a data: image, the downscale reads a blob: URL.
    const cv = document.createElement("canvas"); cv.width = cv.height = 8;
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "a.png", { type: "image/png" }));
    const inp = $("#ai-photo-input"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
    await later(400);
    ok("A: photo staged (data:/blob: images allowed)", !!$(".ai-photo-thumb img"));
    click($("#close-ai-import")); await later(30);
    click($("#open-guide")); await later(30); click($("#close-guide")); await later(30);
    click($("#account-btn")); await later(30); click($("#close-account")); await later(30);
    const cook = $(".cook-btn"); click(cook); await later(30); click($("#cook-close")); await later(30);
    let reg = null;
    for (let i = 0; i < 40 && !reg; i++) { reg = await navigator.serviceWorker.getRegistration(); if (!reg) await later(100); }
    ok("A: service worker registers under the CSP", !!reg, reg ? reg.scope : "none");
    ok("A: no Content-Security-Policy violations", CSP_VIOLATIONS.length === 0, CSP_VIOLATIONS.join(" | "));
  } catch (e) { ok("A: no exception", false, e && e.stack || e); }
  report(R, true);
})();
"""

SW_PAGE = r"""<!doctype html><meta charset="utf-8"><title>sw</title><pre id="results"></pre><script>
const USER_A = "%USER_A%", USER_B = "%USER_B%", ANON = "%ANON%";
(async () => {
  const R = [];
  // Publish after every step, so a stall shows exactly where it stopped.
  const report = (R, done) => fetch("/__results", { method: "POST", body: JSON.stringify({ done: !!done, R }) }).catch(() => {});
  const ok = (n, c, d) => { R.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) }); report(R); };
  const step = (n) => ok("step: " + n, true);
  const later = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (url, token) => {
    try { const r = await fetch(url, token ? { headers: { Authorization: "Bearer " + token } } : {}); return r.ok ? await r.text() : "HTTP " + r.status; }
    catch { return null; }   // a network error — what an app sees offline with no copy
  };
  const net = (state) => fetch("/__" + state).catch(() => null);
  try {
    step("registering");
    await navigator.serviceWorker.register("sw.js");
    step("registered");
    await navigator.serviceWorker.ready;
    step("ready");
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await later(100);
    ok("B: service worker controls the page", !!navigator.serviceWorker.controller);
    // Online: user A reads two tables; an anon read happens too.
    const recipesOnline = await get("/rest/v1/recipes?select=*", USER_A);
    await get("/rest/v1/meal_plan_entries?select=*", USER_A);
    await get("/rest/v1/inventory_items?select=*", ANON);
    await later(300); // let the background cache writes land
    await net("offline");
    ok("B: offline, a signed-in read is served from the copy", (await get("/rest/v1/recipes?select=*", USER_A)) === recipesOnline, recipesOnline);
    ok("B: offline, a second table is served too", (await get("/rest/v1/meal_plan_entries?select=*", USER_A)) !== null);
    ok("B: offline, an anon read was never cached", (await get("/rest/v1/inventory_items?select=*", ANON)) === null);
    ok("B: offline, an unseen read is a network error (no fake data)", (await get("/rest/v1/never_seen?select=*", USER_A)) === null);
    ok("B: offline, the page itself opens from cache", ((await get("index.html")) || "").includes("The House Index"));
    ok("B: offline, app.js opens from cache", ((await get("app.js")) || "").includes("supabaseClient"));
    // A different user signs in on this device: user A's copy must go.
    await net("online");
    await get("/rest/v1/profiles?select=*", USER_B);
    await later(300);
    await net("offline");
    ok("B: after user B reads, user A's copy is gone", (await get("/rest/v1/recipes?select=*", USER_A)) === null);
    ok("B: user B's own read is cached", (await get("/rest/v1/profiles?select=*", USER_B)) !== null);
    // Sign-out: the page posts clear-data.
    navigator.serviceWorker.controller.postMessage({ type: "clear-data" });
    await later(300);
    ok("B: clear-data (sign-out) wipes the copy", (await get("/rest/v1/profiles?select=*", USER_B)) === null);
    await net("online");
  } catch (e) { ok("B: no exception", false, e && e.stack || e); }
  report(R, true);
})();
</script>"""

# Part C: app.js offline logic with a stateful Supabase stub (inline is fine — no CSP).
APP_OFFLINE_PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><title>c</title>
<script>
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub";
// An expired session supabase-js still holds in storage, and no network.
localStorage.setItem("sb-localhost-auth-token", JSON.stringify({ access_token: "x.y.z", refresh_token: "r1", expires_at: 1, user: { id: "u1", email: "t@example.com" } }));
var NET = { online: false };
Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: function () { return NET.online; } });
window.CALLS = [];
var AUTH_CB = null;
var RECIPES = [{ id: "r1", user_id: "u1", section: "kitchen", name: "Test Soup", subtitle: null, source: null, tags: [],
  base_servings: 4, servings_label: "servings", created_at: "2026-01-01T00:00:00Z",
  ingredients: [{ amount: 1, unit: "cup", item: "broth", group: null }], method: [{ text: "Simmer.", group: null }],
  specs: null, notes: null, is_favorite: false }];
function builder(table) {
  var op = "select", single = false;
  var val = function () {
    if (op !== "select") {
      CALLS.push([table, op]);
      return NET.online ? { data: null, error: null } : { data: null, error: { message: "TypeError: Failed to fetch" } };
    }
    if (table === "recipes") return { data: RECIPES, error: null };
    if (table === "grocery_basket_items") return { data: [{ recipe_id: "r1", servings: 4 }], error: null };
    var prof = { id: "u1", display_name: "T", diet_prefs: null, grocery_prefs: null, kroger_prefs: null };
    if (table === "profiles") return { data: single ? prof : [prof], error: null };
    return { data: single ? null : [], error: null };
  };
  var p = new Proxy({}, { get: function (t, k) {
    if (k === "then") return function (f, r) { return Promise.resolve(val()).then(f, r); };
    if (k === "single") return function () { single = true; return p; };
    if (k === "upsert" || k === "delete" || k === "insert" || k === "update") return function () { op = k; return p; };
    return function () { return p; };
  }});
  return p;
}
window.supabase = { createClient: function () { return {
  from: builder, rpc: function () { return Promise.resolve({ data: 0, error: null }); },
  auth: {
    // Offline after expiry, supabase-js reports no session on INITIAL_SESSION.
    onAuthStateChange: function (cb) { AUTH_CB = cb; setTimeout(function () { cb("INITIAL_SESSION", null); }, 0); return { data: { subscription: { unsubscribe: function () {} } } }; },
    getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
    refreshSession: function () { CALLS.push(["auth", "refresh"]); setTimeout(function () { AUTH_CB("TOKEN_REFRESHED", { user: { id: "u1", email: "t@example.com" }, access_token: "live" }); }, 0); return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({ error: null }); }
  },
  functions: { invoke: function () { return Promise.resolve({ data: {}, error: null }); } }
}; } };
window.confirm = function () { return true; };
</script></head><body><pre id="results"></pre>
<script>
var R = [];
function report(done) { return fetch("/__results", { method: "POST", body: JSON.stringify({ done: !!done, R: R }) }).catch(function () {}); }
function ok(n, c, d) { R.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) }); report(false); }
function later(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function $(s) { return document.querySelector(s); }
async function run() {
  try {
    for (var i = 0; i < 60 && !$('.item[data-id="r1"]'); i++) await later(50);
    ok("C: offline + expired token opens the app, not the sign-in gate", !!$('.item[data-id="r1"]') && $("#auth-gate").hidden, "gate hidden=" + $("#auth-gate").hidden);
    ok("C: the offline banner shows", !$("#offline-banner").hidden);
    $("#open-grocery-top").click(); await later(100);
    var box = document.querySelector(".g-item-check");
    ok("C: grocery list renders offline", !!box);
    box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); await later(80);
    var key = box.dataset.key;
    var queued = JSON.parse(localStorage.getItem("hi:u1:pendingChecks") || "{}");
    ok("C: a tick made offline stays ticked", document.querySelector('.g-item-check[data-key="' + key + '"]').checked);
    ok("C: ...and is queued, not sent", queued[key] === true && !CALLS.some(function (c) { return c[0] === "grocery_checked_items"; }), JSON.stringify(queued) + " calls=" + JSON.stringify(CALLS));
    // The connection comes back.
    NET.online = true; window.dispatchEvent(new Event("online")); await later(400);
    ok("C: back online, the session is refreshed", CALLS.some(function (c) { return c[0] === "auth"; }));
    ok("C: ...the queued tick is sent", CALLS.some(function (c) { return c[0] === "grocery_checked_items" && c[1] === "upsert"; }), JSON.stringify(CALLS));
    ok("C: ...and the queue is empty", Object.keys(JSON.parse(localStorage.getItem("hi:u1:pendingChecks") || "{}")).length === 0);
    ok("C: ...and the banner is gone", $("#offline-banner").hidden);
    // Signed in for real, the network drops mid-shop: the tick is kept, not reverted.
    NET.online = false;
    var box2 = document.querySelector('.g-item-check[data-key="' + key + '"]');
    box2.checked = false; box2.dispatchEvent(new Event("change", { bubbles: true })); await later(80);
    var q2 = JSON.parse(localStorage.getItem("hi:u1:pendingChecks") || "{}");
    ok("C: a network failure on a live session queues the change instead of reverting", q2[key] === false && !document.querySelector('.g-item-check[data-key="' + key + '"]').checked, JSON.stringify(q2));
  } catch (e) { ok("C: no exception", false, e && e.stack || e); }
  report(true);
}
fetch("index.html").then(function (r) { return r.text(); }).then(function (txt) {
  var doc = new DOMParser().parseFromString(txt, "text/html");
  Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) { if (n.tagName !== "SCRIPT") document.body.appendChild(document.importNode(n, true)); });
  var s = document.createElement("script"); s.src = "app.js"; s.onload = function () { setTimeout(run, 50); }; document.head.appendChild(s);
});
</script></body></html>"""

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/__offline": OFFLINE["on"] = True; return self._send(204, b"")
        if self.path == "/__online": OFFLINE["on"] = False; return self._send(204, b"")
        if OFFLINE["on"]:
            self.close_connection = True   # no response at all: the browser sees a network error
            return
        if self.path.startswith("/rest/v1/"):
            body = json.dumps({"path": self.path, "auth": self.headers.get("Authorization", "")[-12:]}).encode()
            return self._send(200, body, "application/json")
        return super().do_GET()
    def do_POST(self):
        if self.path == "/__results":
            n = int(self.headers.get("Content-Length", 0))
            RESULTS["latest"] = json.loads(self.rfile.read(n) or b"{}")
            return self._send(204, b"")
        return self._send(404, b"")
    def _send(self, code, body, ctype="text/plain"):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers()
        if body: self.wfile.write(body)

def run_page(port, name, timeout=90):
    # Real time, not --virtual-time-budget: a service worker's install fetches
    # don't advance virtual time, so register() never resolves under it.
    import tempfile, time
    RESULTS["latest"] = None
    OFFLINE["on"] = False
    with tempfile.TemporaryDirectory() as profile:
        chrome = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", f"--user-data-dir={profile}",
                                   f"http://127.0.0.1:{port}/{name}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            t0 = time.time()
            while time.time() - t0 < timeout and not (RESULTS["latest"] or {}).get("done"):
                time.sleep(0.2)
        finally:
            chrome.kill(); chrome.wait()
    latest = RESULTS["latest"]
    if not latest:
        return [{"name": f"{name} produced results", "pass": False, "detail": "no report"}]
    results = [r for r in latest["R"] if not r["name"].startswith("step: ")]
    if not latest.get("done"):
        last = latest["R"][-1]["name"] if latest["R"] else "start"
        results.append({"name": f"{name} finished", "pass": False, "detail": f"stalled after: {last}"})
    return results

def main():
    keep = "--keep" in sys.argv
    files = {}
    # Part A page: the real head + body, scripts swapped for same-origin stubs.
    html = (REPO / "index.html").read_text()
    assert "Content-Security-Policy" in html, "index.html has no CSP meta"
    # Swap the library + config for one same-origin stub, placed right after the
    # CSP <meta> so its violation listener exists before the head's own resources
    # (fonts, manifest) load. app.js stays; the driver runs after it.
    html = re.sub(r'\s*<script src="vendor/[^"]+"></script>\s*<script src="config.js"></script>', "", html)
    html = re.sub(r'(<meta http-equiv="Content-Security-Policy"[^>]*>)', r'\1\n  <script src="test_csp_stub.js"></script>', html, count=1)
    html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>\n  <script src="test_csp_driver.js"></script>')
    html = html.replace("</body>", '<pre id="results"></pre></body>')
    files["test_csp_page.html"] = html
    files["test_csp_stub.js"] = SUPABASE_STUB
    files["test_csp_driver.js"] = CSP_DRIVER
    files["test_sw_page.html"] = SW_PAGE.replace("%USER_A%", USER_A).replace("%USER_B%", USER_B).replace("%ANON%", ANON)
    files["test_offline_app.html"] = APP_OFFLINE_PAGE
    for name, text in files.items(): (REPO / name).write_text(text)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(REPO)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    try:
        results = run_page(port, "test_csp_page.html") + run_page(port, "test_sw_page.html") + run_page(port, "test_offline_app.html")
    finally:
        httpd.shutdown()
        if not keep:
            for name in files: (REPO / name).unlink(missing_ok=True)
    fails = 0
    for r in results:
        fails += not r["pass"]
        print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "   >> " + r["detail"][:300]))
    print(f"\n{len(results) - fails}/{len(results)} passed"); sys.exit(0 if not fails else 2)

main()
