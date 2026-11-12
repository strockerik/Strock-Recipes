#!/usr/bin/env python3
"""Real phone-width overflow test — 360 / 390 / 430 CSS px.

WHY THIS EXISTS: headless Chrome floors the top-level layout viewport at ~500px,
so a `--window-size=390` run still lays out at 500 and a control that overflows a
real iPhone passes. That exact blind spot shipped a sort <select> that ran off the
screen on a 390px phone while the 550px check reported 36/36 green.

The fix: render the app inside an <iframe> sized to the phone width. An iframe gets
its own independent layout viewport, so 390 really means 390.

Asserts, for every panel and at every width: the document never scrolls sideways
and no visible control extends past the right edge.
Run: python3 testing-skills/viewport_smoke_test.py
"""
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib

WIDTHS = (360, 390, 430)  # iPhone SE/mini, iPhone 14/15, Pro Max

def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")

REPO = _find_repo()
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
APP_HTML = REPO / "test_vp_app.html"
FRAME_HTML = REPO / "test_vp_frames.html"

APP = r"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUNNING</title><link rel="stylesheet" href="style.css">
<!-- Geometry is measured at rest: under --virtual-time-budget a CSS transition
     never advances, so an element mid-transition (the ＋ button lifting over the
     grocery bar) would be measured at its starting position forever. -->
<style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>
<body><pre id="smoke-results" style="display:none"></pre>
<script>
var SUPABASE_URL="http://localhost/stub", SUPABASE_ANON_KEY="stub", USER_ID="u1";
var FAKE_RECIPES=[{id:"r1",user_id:USER_ID,section:"kitchen",name:"Test Recipe",subtitle:"sub",
  source:null,tags:["italian"],base_servings:4,servings_label:"servings",
  ingredients:[{amount:2,unit:"cup",item:"flour",group:null},{amount:38,unit:null,item:"garlic",group:null}],
  method:[{text:"Mix for 10 minutes.",group:null}],specs:null,notes:null,is_favorite:false,
  created_at:"2026-01-01T00:00:00Z"}];
var FAKE_INVENTORY=[{id:"i1",section:"pantry",category:"Spices",name:"oregano",status:"in"},
                    {id:"i2",section:"pantry",category:"Produce",name:"lemons",status:"out"}];
function builder(tbl){var single=false;var val=function(){
  if(tbl==="recipes") return {data:FAKE_RECIPES,error:null};
  if(tbl==="inventory_items") return {data:FAKE_INVENTORY,error:null};
  // A list select returns rows, .single() returns one. Returning the object for
  // both made loadProfiles' forEach throw, so every run of this harness was
  // silently testing a half-finished load (no tag cloud, no refreshViews).
  if(tbl==="profiles") return single
    ? {data:{id:USER_ID,display_name:"T",diet_prefs:null,grocery_prefs:null,kroger_prefs:null},error:null}
    : {data:[{id:USER_ID,display_name:"T"}],error:null};
  return {data:[],error:null};};
 var p=new Proxy({},{get:function(t,k){
  if(k==="then")return function(f,r){return Promise.resolve(val()).then(f,r)};
  if(k==="catch")return function(r){return Promise.resolve(val()).catch(r)};
  return function(){if(k==="single"||k==="maybeSingle")single=true;return p}}});return p;}
window.supabase={createClient:function(){return{
 from:builder,
 auth:{onAuthStateChange:function(cb){setTimeout(function(){cb("INITIAL_SESSION",{user:{id:USER_ID,email:"t@t.co"}})},0);
        return{data:{subscription:{unsubscribe:function(){}}}}},
   getUser:function(){return Promise.resolve({data:{user:{id:USER_ID}},error:null})},
   getSession:function(){return Promise.resolve({data:{session:{user:{id:USER_ID,email:"t@t.co"}}},error:null})},
   signOut:function(){return Promise.resolve({error:null})}},
 rpc:function(){return Promise.resolve({data:0,error:null})},
 functions:{invoke:function(){return Promise.resolve({data:{},error:null})}}}}};

var R=[];
function A(n,c,d){R.push({name:n,pass:!!c,detail:d||""})}
function fin(){document.getElementById("smoke-results").textContent=JSON.stringify(R);document.title="DONE"}
function click(e){e&&e.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}))}
function delay(ms){return new Promise(function(r){setTimeout(r,ms)})}
function show(s){var e=document.querySelector(s);if(e)e.hidden=false;return e}
function hide(s){var e=document.querySelector(s);if(e)e.hidden=true}
function ov(label){
  var vw=document.documentElement.clientWidth;
  A(label+": no page h-scroll", document.documentElement.scrollWidth<=vw+1,
    "scrollW="+document.documentElement.scrollWidth+" vw="+vw);
  var spill=[].slice.call(document.querySelectorAll("button,input,select,a,textarea"))
    .filter(function(el){ if(el.offsetParent===null) return false;
      var r=el.getBoundingClientRect(); return r.right>vw+1 || r.left<-1; });
  A(label+": nothing off-edge", spill.length===0,
    spill.map(function(e){var r=e.getBoundingClientRect();
      return (e.id||e.className)+"@"+Math.round(r.left)+".."+Math.round(r.right)}).slice(0,4).join(" | "));
}
async function run(){try{
  ov("main list");
  // Overflow alone is NOT enough: a flex child with min-width:0 silently shrinks
  // instead of spilling, so a control crowding the search bar passes an overflow
  // check while the field becomes unusable (and iOS, which renders native form
  // controls wider than Chrome, then genuinely overflows). Assert the primary
  // input keeps a usable share of its row.
  var si=document.querySelector("#search"), row=document.querySelector(".search-row");
  if(si&&row){
    var sw=si.getBoundingClientRect().width, rw=row.getBoundingClientRect().width;
    A("search keeps >=85% of its row (is "+Math.round(sw)+"/"+Math.round(rw)+"px)",
      sw >= rw*0.85, "a sibling control is squeezing the search field");
    A("search field >=260px wide (is "+Math.round(sw)+"px)", sw >= 260,
      "too narrow to read a placeholder on a phone");
  }

  // ---- geometry the stylesheet owns; this is the only styled harness ----
  // Search sticks under the header instead of scrolling away with the list.
  var sticky=document.querySelector("#search-sticky");
  if(sticky){
    var scs=getComputedStyle(sticky);
    A("search row is sticky", scs.position==="sticky", "position="+scs.position);
    A("search sticks below the measured header", parseFloat(scs.top)>40, "top="+scs.top);
  }

  // Finger-sized targets. A row is name/tags, the star and one "+ List" now;
  // both are real 40px boxes. The open recipe's servings buttons keep the
  // invisible 44px ::after box.
  var row=document.querySelector(".item .item-row"), listBtn=document.querySelector(".item .list-btn");
  A("rows carry only the star and + List", !!listBtn && !document.querySelector(".item .pick, .item .plan-pick, .item .serv-control, .item .chevron"), "");
  if(listBtn){
    var lb=listBtn.getBoundingClientRect();
    A("+ List is at least 40px tall (is "+Math.round(lb.height)+")", lb.height>=40, "");
    A("+ List text fits its button", listBtn.scrollWidth<=listBtn.clientWidth+1, listBtn.scrollWidth+">"+listBtn.clientWidth);
    A("+ List stays inside the row", lb.right<=row.getBoundingClientRect().right+0.5, "");
  }
  var star=document.querySelector(".item .star-btn");
  if(star){
    var sb=star.getBoundingClientRect();
    A("the star is a 40px target (is "+Math.round(sb.width)+"x"+Math.round(sb.height)+")", Math.round(sb.width)>=40 && Math.round(sb.height)>=40, "");
    if(listBtn){ var lb2=listBtn.getBoundingClientRect(); A("star and + List don't overlap", sb.right<=lb2.left+0.5, Math.round(sb.right)+" vs "+Math.round(lb2.left)); }
  }
  var nameEl=document.querySelector(".item .item-name");
  A("the recipe name keeps most of the row (>=55%)", !!nameEl && nameEl.parentElement.getBoundingClientRect().width>=row.getBoundingClientRect().width*0.55,
    nameEl ? Math.round(nameEl.parentElement.getBoundingClientRect().width)+"/"+Math.round(row.getBoundingClientRect().width) : "");

  // The bottom grocery bar is gone; + List says so with a toast instead.
  var fab=document.querySelector("#add-fab"), gbar=document.querySelector("#grocery-bar");
  // Not offsetParent: it's always null for a position:fixed element, which
  // silently skipped this check until 2026-11-08.
  function fabShown(){ return !!fab && getComputedStyle(fab).display!=="none"; }
  A("the ＋ button shows at phone width", fabShown(), "display="+(fab&&getComputedStyle(fab).display));
  A("no bottom grocery bar", !gbar, "");
  if(listBtn){ click(listBtn); await delay(160); }
  var ta=document.querySelector(".toast-action.show");
  A("+ List shows the View toast", !!ta && /View/.test(ta.textContent), "");
  if(ta && fabShown()){
    var fr=fab.getBoundingClientRect(), tr=ta.getBoundingClientRect();
    var hitT = fr.bottom > tr.top && fr.top < tr.bottom && fr.right > tr.left && fr.left < tr.right;
    A("the View toast clears the ＋ button", !hitT, "fab="+Math.round(fr.top)+".."+Math.round(fr.bottom)+" toast="+Math.round(tr.top)+".."+Math.round(tr.bottom));
    A("the View toast fits the screen", tr.left>=0 && tr.right<=document.documentElement.clientWidth+0.5, Math.round(tr.left)+".."+Math.round(tr.right));
  }

  // The open recipe: Start cooking, the pair, the quiet line, servings.
  var head=document.querySelector(".item .item-head");
  if(head){ click(head); await delay(160); }
  var det=document.querySelector(".item .item-detail");
  if(det){
    var cook=det.querySelector(".cook-btn");
    if(cook) A("Start cooking is a big target (is "+Math.round(cook.getBoundingClientRect().height)+")", cook.getBoundingClientRect().height>=48, "");
    var pair=[].slice.call(det.querySelectorAll(".detail-actions-pair .ghost-btn"));
    A("list + plan sit side by side", pair.length===2 && Math.abs(pair[0].getBoundingClientRect().top-pair[1].getBoundingClientRect().top)<1, pair.length);
    A("…and their words fit", pair.every(function(b){ return b.scrollWidth<=b.clientWidth+1 && b.getBoundingClientRect().height>=44; }),
      pair.map(function(b){ return b.scrollWidth+">"+b.clientWidth+"/"+Math.round(b.getBoundingClientRect().height); }).join(" "));
    var quiet=[].slice.call(det.querySelectorAll(".detail-quiet .link-btn"));
    A("the quiet line's links are 44px tall", quiet.length>=3 && quiet.every(function(b){ return b.getBoundingClientRect().height>=44; }), quiet.length);
    var sv=det.querySelector(".detail-serv-btn");
    if(sv){ var af=getComputedStyle(sv,"::after"); A("servings buttons have a 44px hit area", Math.round(parseFloat(af.width))>=44 && Math.round(parseFloat(af.height))>=44, af.width+"x"+af.height); }
    ov("open recipe");
    var pn=det.querySelector(".plan-night-btn");
    if(pn){
      click(pn); await delay(120);
      var nights=[].slice.call(document.querySelectorAll("#place-sheet .ps-night"));
      A("Plan a night: seven tall rows", nights.length===7 && nights.every(function(n){ return n.getBoundingClientRect().height>=56; }), nights.length);
      ov("plan a night");
      hide("#place-sheet");
    }
    click(head); await delay(120);
  }
  if(listBtn){ click(document.querySelector(".item .list-btn")); await delay(160); }

  // The release number in the footer: shown, small, and never stuck under the
  // grocery bar or the ＋ button once you scroll to the bottom of the page.
  var ver=document.querySelector("#app-version");
  function verChecks(state){
    if(!ver){ A("version badge present", false, "missing"); return; }
    // Instant: html has scroll-behavior: smooth, so a plain scrollTo is still animating when measured.
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    var vr=ver.getBoundingClientRect();
    A("version reachable at the page bottom ("+state+")",
      !ver.hidden && vr.height>0 && vr.left>=0 && vr.top>=0 && vr.bottom<=window.innerHeight+1,
      "top="+Math.round(vr.top)+" bottom="+Math.round(vr.bottom)+" vh="+window.innerHeight+" scrollY="+Math.round(window.scrollY));
    if(fabShown()){
      var fr=fab.getBoundingClientRect();
      var hit = vr.bottom > fr.top && vr.top < fr.bottom && vr.right > fr.left && vr.left < fr.right;
      A("version isn't under the ＋ button ("+state+")", !hit, "ver="+Math.round(vr.left)+".."+Math.round(vr.right)+" fab="+Math.round(fr.left)+".."+Math.round(fr.right));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  if(ver){
    A("version reads v"+APP_VERSION+" (app.js APP_VERSION)", ver.querySelector(".app-version-num").textContent==="v"+APP_VERSION && ver.title.indexOf("version "+APP_VERSION)>=0,
      ver.querySelector(".app-version-num").textContent+" / "+ver.title);
    A("version is discreet (<=12px text)", parseFloat(getComputedStyle(ver).fontSize)<=12, getComputedStyle(ver).fontSize);
  }
  verChecks("list page");
  show("#grocery-panel"); await delay(70); ov("grocery");
  click(document.querySelector('[data-grocery-view="recipe"]')); await delay(70); ov("grocery by-recipe");
  click(document.querySelector('[data-grocery-view="aisle"]')); await delay(50);
  click(document.querySelector("#export-more-toggle")); await delay(50); ov("grocery export open");
  click(document.querySelector("#shopping-mode-toggle")); await delay(70); ov("grocery shopping mode");
  click(document.querySelector("#shopping-mode-toggle")); await delay(50); hide("#grocery-panel");
  show("#inventory-panel"); await delay(70); ov("inventory");
  click(document.querySelector("#inv-out-filter")); await delay(70); ov("inventory out-filter");
  hide("#inventory-panel");
  show("#kroger-panel"); show("#kroger-store-step"); await delay(60); ov("king soopers");
  hide("#kroger-panel");
  var P=[["#generate-panel","generator"],["#recipe-form-panel","recipe form"],["#ai-import-panel","AI import"],
         ["#account-panel","account"],["#guide-panel","guide"],["#backup-panel","backup"],
         ["#coach-panel","coach"],["#place-sheet","place sheet"],["#prompt-panel","describe"]];
  for(var i=0;i<P.length;i++){var el=show(P[i][0]); if(el){await delay(60); ov(P[i][1]); hide(P[i][0]);}}
}catch(e){A("no exception",false,String(e&&e.stack||e))}fin()}

fetch("index.html").then(function(r){return r.text()}).then(function(t){
  var doc=new DOMParser().parseFromString(t,"text/html"),f=document.createDocumentFragment();
  Array.prototype.slice.call(doc.body.childNodes).forEach(function(n){
    if(n.tagName==="SCRIPT")return; f.appendChild(document.importNode(n,true))});
  document.body.appendChild(f);
  var s=document.createElement("script"); s.src="app.js";
  s.onload=function(){var i=0;(function w(){
    if(document.querySelector("#account-btn")||i>60){setTimeout(run,500);return} i++;setTimeout(w,50)})()};
  s.onerror=function(){A("app.js load",false,"err");fin()};
  document.head.appendChild(s);
}).catch(function(e){A("boot",false,String(e));fin()});
</script></body></html>"""

FRAMES = """<!doctype html><meta charset=utf-8><title>RUN</title><body style="margin:0">
<pre id="out" style="display:none"></pre>__FRAMES__
<script>
var res=[];
function poll(){
  var fs=[].slice.call(document.querySelectorAll("iframe"));
  var done=fs.every(function(f){try{var p=f.contentDocument.getElementById("smoke-results");
    return p&&p.textContent.trim().length>2}catch(e){return false}});
  if(!done) return setTimeout(poll,300);
  fs.forEach(function(f){res.push({w:f.dataset.w,
    r:JSON.parse(f.contentDocument.getElementById("smoke-results").textContent)})});
  document.getElementById("out").textContent=JSON.stringify(res);
  document.title="FRAMESDONE";
}
setTimeout(poll,1500);
</script></body>"""


def main():
    keep = "--keep" in sys.argv
    version = re.search(r'const APP_VERSION = "([^"]+)"', (REPO / "app.js").read_text()).group(1)
    APP_HTML.write_text(APP.replace("<head>", f'<head><script>var APP_VERSION = "{version}";</script>', 1))
    frames = "".join(
        f'<iframe data-w="{w}" src="{APP_HTML.name}" style="width:{w}px;height:900px;border:0"></iframe>'
        for w in WIDTHS)
    FRAME_HTML.write_text(FRAMES.replace("__FRAMES__", frames))
    os.chdir(REPO)
    socketserver.TCPServer.allow_reuse_address = True
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    httpd = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        out = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--window-size=1400,1000", "--virtual-time-budget=40000", "--dump-dom",
             f"http://127.0.0.1:{port}/{FRAME_HTML.name}"],
            capture_output=True, text=True, timeout=150).stdout
    finally:
        httpd.shutdown()
        if not keep:
            for p in (APP_HTML, FRAME_HTML):
                if p.exists(): p.unlink()
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', out, re.S)
    if not m or not m.group(1).strip():
        print("NO RESULTS:\n", out[:1500]); sys.exit(1)
    raw = m.group(1)
    for a, b in (("&quot;", '"'), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">")):
        raw = raw.replace(a, b)
    data = json.loads(raw)
    total = passed = 0
    for row in data:
        fails = [r for r in row["r"] if not r["pass"]]
        total += len(row["r"]); passed += len(row["r"]) - len(fails)
        print(f"  {row['w']}px: {len(row['r'])-len(fails)}/{len(row['r'])}"
              + ("" if not fails else "   ← OVERFLOW"))
        for f in fails:
            print(f"      FAIL {f['name']}  >> {f['detail']}")
    print(f"\n{passed}/{total} passed across widths {', '.join(str(w) for w in WIDTHS)}")
    sys.exit(0 if passed == total else 2)


if __name__ == "__main__":
    main()
