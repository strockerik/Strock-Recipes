#!/usr/bin/env python3
"""New Here sign-up flow (no backend, no real accounts, no email).

Boots the REAL index.html DOM + app.js signed out, with a stubbed Supabase auth:
  - the gate opens on sign-in, and a hidden name field doesn't block it
  - New Here switches to the create-profile form, and back
  - name and password are checked before anything is sent
  - signUp gets the name and a link back to this page; a double submit sends one
  - email confirmation on: a "check your email" message with Resend
  - email confirmation off: the session opens the app and saves the chosen name
  - delivery, disabled-sign-up, and rate-limit errors read in plain language
  - approval: a waiting profile stays on its own screen and loads no data; once
    approved it opens; a known member goes straight in; a removed member is held;
    a failed check never locks anyone out
NOTE: runs UNSTYLED — no layout assertions (those live in viewport_smoke_test.py).
Run: python3 testing-skills/signup_flow_test.py
"""
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST_HTML = REPO / "test_signup_flow.html"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<script>
var SUPABASE_URL = "http://localhost/stub", SUPABASE_ANON_KEY = "stub";
var AUTH_CB = null, SIGNUPS = [], SIGNINS = [], RESENDS = [], UPSERTS = [], NEXT = { data: { user: { id: "new" }, session: null }, error: null };
var APPROVAL = { data: true, error: null }, READS = [], RPC_CALLS = [];
function builder(table) {
  var result = { data: [], error: null };
  READS.push(table);
  var p = new Proxy({}, { get: function (t, k) {
    if (k === "then") return function (f, r) { return Promise.resolve(result).then(f, r); };
    if (k === "catch") return function (r) { return Promise.resolve(result).catch(r); };
    return function (row) {
      if (k === "upsert" && table === "profiles") UPSERTS.push(row);
      if (k === "single" || k === "maybeSingle") result = { data: null, error: null };
      return p;
    };
  }});
  return p;
}
window.supabase = { createClient: function () { return {
  from: builder,
  rpc: function (fn) { RPC_CALLS.push(fn);
    if (fn === "is_approved_member") return Promise.resolve(APPROVAL);
    return Promise.resolve({ data: [], error: null }); },
  functions: { invoke: function () { return Promise.resolve({ data: {}, error: null }); } },
  auth: {
    onAuthStateChange: function (cb) { AUTH_CB = cb; setTimeout(function () { cb("INITIAL_SESSION", null); }, 0); return { data: { subscription: { unsubscribe: function () {} } } }; },
    signUp: function (args) { SIGNUPS.push(args); var n = NEXT;
      return new Promise(function (res) { setTimeout(function () { if (n.data && n.data.session) AUTH_CB("SIGNED_IN", n.data.session); res(n); }, 20); }); },
    signInWithPassword: function (args) { SIGNINS.push(args); return Promise.resolve({ data: {}, error: null }); },
    resend: function (args) { RESENDS.push(args); return Promise.resolve({ error: null }); },
    resetPasswordForEmail: function () { return Promise.resolve({ error: null }); },
    refreshSession: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({ error: null }); }
  }
}; } };
</script></head>
<body>
<pre id="smoke-results" style="display:none"></pre>
<script>
var RESULTS = [], JS_ERRORS = [];
window.addEventListener("error", function (e) { JS_ERRORS.push(String(e.message)); });
window.addEventListener("unhandledrejection", function (e) { JS_ERRORS.push("rejection: " + String(e.reason && e.reason.message || e.reason)); });
function assert(n, c, d) { RESULTS.push({ name: n, pass: !!c, detail: String(d == null ? "" : d) }); }
function finish() { document.getElementById("smoke-results").textContent = JSON.stringify(RESULTS);
  document.title = "TESTDONE " + RESULTS.filter(function (r) { return r.pass; }).length + "/" + RESULTS.length; }
function $(s) { return document.querySelector(s); }
function txt(el) { return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function submit() { $("#auth-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
function fill(name, email, pw) { $("#auth-name").value = name; $("#auth-email").value = email; $("#auth-password").value = pw; }
function status() { return txt($("#auth-status")); }
async function errorCase(label, err, re) {
  $("#auth-new").click(); fill("Ana", "ana@example.test", "longenough1");
  NEXT = { data: { user: null, session: null }, error: err };
  submit(); await delay(80);
  assert(label, re.test(status()), status());
  assert("…and stays on the form to try again", !$("#auth-name").hidden && txt($("#auth-submit")) === "Create profile", txt($("#auth-submit")));
  $("#auth-back").click();
}

async function runTests() {
  try {
    assert("signed out shows the gate", !$("#auth-gate").hidden, "");
    assert("opens on sign-in", txt($("#auth-submit")) === "Sign in" && $("#auth-name").hidden, txt($("#auth-submit")));
    assert("New Here is a visible button", $("#auth-new").tagName === "BUTTON" && !$("#auth-new").hidden && txt($("#auth-new")) === "New Here", txt($("#auth-new")));
    assert("the hidden name field isn't required on sign-in", !$("#auth-name").required, "");
    assert("the whole form is valid for sign-in", (fill("", "me@example.test", "short"), $("#auth-form").checkValidity()), "");
    submit(); await delay(40);
    assert("a short existing password still signs in", SIGNINS.length === 1 && SIGNUPS.length === 0, SIGNINS.length);

    $("#auth-new").click();
    assert("New Here shows the name field", !$("#auth-name").hidden && $("#auth-name").required, "");
    assert("…with a Create profile button", txt($("#auth-submit")) === "Create profile", txt($("#auth-submit")));
    assert("…a new-password field", $("#auth-password").getAttribute("autocomplete") === "new-password", "");
    assert("…no Forgot password or New Here", $("#auth-forgot").hidden && $("#auth-new").hidden, "");
    assert("…and a way back", !$("#auth-back").hidden, "");
    $("#auth-back").click();
    assert("the way back restores sign-in", txt($("#auth-submit")) === "Sign in" && $("#auth-name").hidden && !$("#auth-new").hidden && $("#auth-password").getAttribute("autocomplete") === "current-password", "");

    $("#auth-new").click(); fill("   ", "ana@example.test", "longenough1"); submit(); await delay(30);
    assert("a blank name is refused", SIGNUPS.length === 0 && /name/i.test(status()), status());
    fill("Ana", "ana@example.test", "short"); submit(); await delay(30);
    assert("a short password is refused", SIGNUPS.length === 0 && /8 characters/.test(status()), status());

    fill("  Ana   Lee ", "ana@example.test", "longenough1");
    submit(); submit(); await delay(80);
    assert("a double submit sends one sign-up", SIGNUPS.length === 1, SIGNUPS.length);
    var a = SIGNUPS[0] || { options: { data: {} } };
    assert("the name is tidied and sent", a.options.data.display_name === "Ana Lee", a.options.data.display_name);
    assert("the email link returns to this page", a.options.emailRedirectTo === location.origin + location.pathname, a.options.emailRedirectTo);
    assert("email confirmation: says to check the inbox", /Check ana@example\.test/.test(status()), status());
    assert("…offers Resend", /Resend confirmation/.test(status()), status());
    assert("…returns to sign-in with the password cleared", txt($("#auth-submit")) === "Sign in" && $("#auth-password").value === "", "");
    assert("…and the gate stays up", !$("#auth-gate").hidden, "");
    $("#auth-status button").click(); await delay(30);
    assert("Resend sends a sign-up confirmation", RESENDS.length === 1 && RESENDS[0].type === "signup", JSON.stringify(RESENDS));

    await errorCase("undeliverable email reads plainly", { message: "Email address \"x\" cannot be used as it is not authorized", code: "email_address_not_authorized" }, /couldn’t send your email/);
    await errorCase("a provider failure reads plainly", { message: "Error sending confirmation email" }, /couldn’t send your email/);
    await errorCase("disabled sign-ups read plainly", { message: "Signups not allowed for this instance", code: "signup_disabled" }, /turned off/);
    await errorCase("the hourly email limit reads plainly", { message: "email rate limit exceeded", code: "over_email_send_rate_limit" }, /in an hour/);
    await errorCase("an existing email reads plainly", { message: "User already registered", code: "user_already_exists" }, /already has a profile/);

    // ---------- a new profile waits for approval ----------
    APPROVAL = { data: false, error: null }; READS.length = 0;
    var waitingUser = { id: "u9", email: "bo@example.test", user_metadata: { display_name: "Bo Diaz" } };
    $("#auth-new").click(); fill("Bo Diaz", "bo@example.test", "longenough2");
    NEXT = { data: { user: waitingUser, session: { user: waitingUser } }, error: null };
    submit(); await delay(400);
    assert("a waiting profile stays behind the gate", !$("#auth-gate").hidden, "");
    assert("…sees the waiting screen", !$("#auth-waiting").hidden && $("#auth-entry").hidden, "");
    assert("…by name", /Thanks, Bo Diaz/.test(txt($("#auth-waiting-msg"))), txt($("#auth-waiting-msg")));
    assert("…with no account menu", $("#account-area").hidden, "");
    assert("…and loads no data", READS.length === 0, READS.join(","));
    assert("…and creates no profile row yet", UPSERTS.length === 0, JSON.stringify(UPSERTS));

    $("#auth-waiting-check").click(); await delay(120);
    assert("Check again says not yet", /Not approved yet/.test(txt($("#auth-waiting-status"))) && !$("#auth-gate").hidden, txt($("#auth-waiting-status")));

    APPROVAL = { data: true, error: null };
    $("#auth-waiting-check").click(); await delay(500);
    assert("once approved, the app opens", $("#auth-gate").hidden && !$("#account-area").hidden, "");
    assert("…the data loads", READS.indexOf("recipes") >= 0, READS.join(","));
    assert("the chosen name is saved to the profile", UPSERTS.some(function (r) { return r.id === "u9" && r.display_name === "Bo Diaz"; }), JSON.stringify(UPSERTS));
    assert("…and the device remembers the approval", localStorage.getItem("hi:u9:member") === "true", "");

    // ---------- removed, then signed out ----------
    APPROVAL = { data: false, error: null };
    AUTH_CB("SIGNED_IN", { user: waitingUser }); await delay(300);
    assert("a member whose approval is removed is held", !$("#auth-gate").hidden && !$("#auth-waiting").hidden, "");
    assert("…and the device forgets the approval", localStorage.getItem("hi:u9:member") === null, "");
    $("#auth-waiting-signout").click(); AUTH_CB("SIGNED_OUT", null); await delay(150);
    assert("Sign out returns to the sign-in form", !$("#auth-entry").hidden && $("#auth-waiting").hidden && txt($("#auth-submit")) === "Sign in", "");

    // ---------- known member: straight in ----------
    localStorage.setItem("hi:u7:member", "true"); APPROVAL = { data: true, error: null }; READS.length = 0;
    var before = RPC_CALLS.length;
    AUTH_CB("INITIAL_SESSION", { user: { id: "u7", email: "m@example.test" } });
    assert("a known member skips the waiting screen", $("#auth-gate").hidden, "");
    await delay(300);
    assert("…loads, and is still re-checked", READS.indexOf("recipes") >= 0 && RPC_CALLS.slice(before).indexOf("is_approved_member") >= 0, "");
    AUTH_CB("SIGNED_OUT", null); await delay(120);

    // ---------- a failed check doesn't lock anyone out ----------
    APPROVAL = { data: null, error: { message: "Could not find the function", code: "PGRST202" } }; READS.length = 0;
    AUTH_CB("INITIAL_SESSION", { user: { id: "u8", email: "n@example.test" } }); await delay(300);
    assert("a failed approval check opens the app", $("#auth-gate").hidden && READS.indexOf("recipes") >= 0, "");
    assert("…without remembering an approval", localStorage.getItem("hi:u8:member") === null, "");
    assert("the version reads 2.3", /v2\.3/.test(txt($("#app-version"))), txt($("#app-version")));
  } catch (e) {
    assert("no exception", false, String(e && e.stack || e));
  }
  assert("no uncaught JS errors", JS_ERRORS.length === 0, JS_ERRORS.join(" | ").slice(0, 400));
  finish();
}

fetch("index.html").then(function (r) { return r.text(); }).then(function (t) {
  var doc = new DOMParser().parseFromString(t, "text/html");
  var frag = document.createDocumentFragment();
  Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) {
    if (n.tagName === "SCRIPT") return;
    frag.appendChild(document.importNode(n, true));
  });
  document.body.appendChild(frag);
  var s = document.createElement("script"); s.src = "app.js";
  s.onload = function () { setTimeout(runTests, 200); };
  s.onerror = function () { assert("app.js loaded", false, "load error"); finish(); };
  document.head.appendChild(s);
}).catch(function (e) { assert("boot", false, String(e)); finish(); });
</script>
</body></html>"""

def main():
    keep = "--keep" in sys.argv
    TEST_HTML.write_text(HTML); os.chdir(REPO)
    socketserver.TCPServer.allow_reuse_address = True
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    httpd = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        out = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--virtual-time-budget=30000", "--dump-dom",
             f"http://127.0.0.1:{port}/{TEST_HTML.name}"],
            capture_output=True, text=True, timeout=120).stdout
    finally:
        httpd.shutdown()
        if TEST_HTML.exists() and not keep: TEST_HTML.unlink()
    m = re.search(r'<pre id="smoke-results"[^>]*>(.*?)</pre>', out, re.S)
    if not m or not m.group(1).strip():
        print("NO RESULTS:\n", out[:1800]); sys.exit(1)
    raw = m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    res = json.loads(raw)
    for r in res:
        print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "  >> " + r["detail"]))
    print(f"\n{sum(1 for r in res if r['pass'])}/{len(res)} passed")
    sys.exit(0 if all(r["pass"] for r in res) else 2)

if __name__ == "__main__":
    main()
