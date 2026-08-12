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
<title>RUNNING</title><link rel="stylesheet" href="style.css"></head>
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
function builder(tbl){var val=function(){
  if(tbl==="recipes") return {data:FAKE_RECIPES,error:null};
  if(tbl==="inventory_items") return {data:FAKE_INVENTORY,error:null};
  if(tbl==="profiles") return {data:{id:USER_ID,display_name:"T",diet_prefs:null,grocery_prefs:null,kroger_prefs:null},error:null};
  return {data:[],error:null};};
 var p=new Proxy({},{get:function(t,k){
  if(k==="then")return function(f,r){return Promise.resolve(val()).then(f,r)};
  if(k==="catch")return function(r){return Promise.resolve(val()).catch(r)};
  return function(){return p}}});return p;}
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
    APP_HTML.write_text(APP)
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
