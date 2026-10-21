#!/usr/bin/env python3
"""Logic matrix + regression probes for The House Index (no backend, no spend).

Boots the REAL index.html + app.js in headless Chrome against a stubbed Supabase
client, exposes the closure's pure helpers on window.__T (injected just before
initAuth()), and asserts:
  - the app_testing_skill.md Phase-4 matrix (fmtAmount, scaling, unit
    conversion, shoppable rounding, normalize/display names, aisles, staples,
    groupRuns, esc, aisle-order merge, timer parsing) with exact values;
  - regression probes for bugs fixed 2026-10-20 — fractional cook timers
    ("1/2 hour"), sub-gram grocery amounts, bar "oz" as fluid ounces (Metric +
    grocery), coach Send/thread state after close or mode switch mid-reply,
    coach Apply keeping Source, and double-tap Save inserting once;
  - Phase-7 XSS: injection payloads in every recipe field render as text.
Run from anywhere in the repo:  python3 testing-skills/logic_regression_test.py [--keep]
"""
import json, os, re, subprocess, sys, pathlib, http.server, socketserver, threading, functools
def _find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d / "index.html").exists() and (d / "app.js").exists():
            return d
    sys.exit("no repo root found")
REPO = _find_repo()
PAGE = REPO / "test_review.html"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title>
<link rel="stylesheet" href="style.css">
<script>
var SUPABASE_URL="x", SUPABASE_ANON_KEY="y", USER_ID="u1";
var FAKE_RECIPES=[
 {id:"r1",user_id:USER_ID,section:"kitchen",name:"Weeknight Chili",subtitle:null,source:"https://example.com/chili",tags:["american"],
  base_servings:4,servings_label:"servings",created_at:"2026-01-01T00:00:00Z",
  ingredients:[{amount:2/3,unit:"cup",item:"onion",group:null},{amount:1,unit:"lb",item:"ground beef",group:null}],
  method:[{text:"Brown the beef.",group:null},{text:"Simmer 1 1/2 hours.",group:null}],specs:null,notes:null,is_favorite:false},
 {id:"r2",user_id:USER_ID,section:"bar",name:"Gin Sour",subtitle:null,source:null,tags:["gin"],
  base_servings:1,servings_label:"drink",created_at:"2026-01-02T00:00:00Z",
  ingredients:[{amount:2,unit:"oz",item:"gin",group:null},{amount:0.75,unit:"oz",item:"lemon juice",group:null}],
  method:[{text:"Shake hard.",group:null}],specs:null,notes:null,is_favorite:false},
 {id:"r3",user_id:USER_ID,section:"kitchen",name:"<img src=x onerror=\"window.XSS=1\">",subtitle:"<script>window.XSS=2<\/script>",source:"javascript:window.XSS=3",tags:["american"],
  base_servings:2,servings_label:"<b>srv</b>",created_at:"2026-01-03T00:00:00Z",
  ingredients:[{amount:1,unit:"<i>u</i>",item:"<svg onload=window.XSS=4>",group:"<img src=y onerror=window.XSS=5>"}],
  method:[{text:"<img src=z onerror=window.XSS=6>",group:null}],specs:null,notes:"<iframe src=javascript:window.XSS=7>",is_favorite:false}];
window.CALLS={invoke:[],insert:[],update:[]};
window.INVOKE_IMPL=null;
function snap(x){return JSON.parse(JSON.stringify(x));}
function makeBuilder(table){
  var single=false;
  var val=function(){
    if(table==="recipes")return{data:FAKE_RECIPES,error:null};
    var prof={id:USER_ID,display_name:"T",diet_prefs:null,grocery_prefs:null,kroger_prefs:null};
    if(table==="profiles")return{data:single?prof:[prof],error:null};
    return{data:[],error:null};};
  var p=new Proxy({},{get:function(t,k){
    if(k==="then")return function(f,r){return new Promise(function(res){setTimeout(function(){res(val());},30);}).then(f,r);};
    if(k==="catch")return function(r){return Promise.resolve(val()).catch(r);};
    if(k==="insert")return function(row){CALLS.insert.push([table,snap(row)]);return p;};
    if(k==="update")return function(row){CALLS.update.push([table,snap(row)]);return p;};
    if(k==="single")return function(){single=true;return p;};
    return function(){return p;};}});
  return p;}
window.supabase={createClient:function(){return{
  from:function(t){return makeBuilder(t);},
  rpc:function(){return Promise.resolve({data:0,error:null});},
  auth:{onAuthStateChange:function(cb){setTimeout(function(){cb("INITIAL_SESSION",{user:{id:USER_ID,email:"t@example.com"}});},0);return{data:{subscription:{unsubscribe:function(){}}}};},
    getUser:function(){return Promise.resolve({data:{user:{id:USER_ID}},error:null});},
    getSession:function(){return Promise.resolve({data:{session:{user:{id:USER_ID,email:"t@example.com"}}},error:null});},
    signOut:function(){return Promise.resolve({error:null});}},
  functions:{invoke:function(n,o){CALLS.invoke.push([n,snap(o&&o.body)]);
    if(window.INVOKE_IMPL)return window.INVOKE_IMPL(n,o);
    return Promise.resolve({data:{},error:null});}}};}};
window.confirm=function(){return true;};
window.ERRS=[];window.addEventListener("error",function(e){ERRS.push(e.message);});window.addEventListener("unhandledrejection",function(e){ERRS.push("rej: "+(e.reason&&e.reason.message||e.reason));});
</script></head><body>
<pre id="smoke-results" style="display:none"></pre>
<script>
var R=[];
function ok(n,c,d){R.push({name:n,pass:!!c,detail:d===undefined?"":String(d)});}
function eq(n,got,want){ok(n,JSON.stringify(got)===JSON.stringify(want),"got "+JSON.stringify(got)+" want "+JSON.stringify(want));}
function finish(){document.getElementById("smoke-results").textContent=JSON.stringify(R);document.title="DONE";}
function later(ms){return new Promise(function(r){setTimeout(r,ms);});}
function click(el){el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}));}
function $(s){return document.querySelector(s);}
async function openDetail(id){click($('.item[data-id="'+id+'"] .item-head'));await later(40);}

async function runTests(){
 var T=window.__T;
 try{
  ok("app booted and rendered the list", !!document.querySelector('.item[data-id="r1"]'), "items="+document.querySelectorAll(".item").length+" gate="+(document.getElementById("auth-gate")||{}).hidden+" errs="+(window.ERRS||[]).join(" | "));
  // ---------- fmtAmount ----------
  eq("fmtAmount 0.5",T.fmtAmount(0.5),"½"); eq("fmtAmount 0.25",T.fmtAmount(0.25),"¼");
  eq("fmtAmount 0.33",T.fmtAmount(0.33),"⅓"); eq("fmtAmount 1.5",T.fmtAmount(1.5),"1 ½");
  eq("fmtAmount 2",T.fmtAmount(2),"2"); eq("fmtAmount null",T.fmtAmount(null),"");
  eq("fmtAmount 0.125",T.fmtAmount(0.125),"⅛"); eq("fmtAmount 2/3",T.fmtAmount(2/3),"⅔");
  // ---------- scaledIngredients ----------
  var it={baseServings:4,ingredients:[{amount:2,unit:"cup",item:"a"},{amount:null,unit:null,item:"salt"}]};
  var s8=T.scaledIngredients(it,8); eq("scale x2 doubles",s8[0].scaled,4); eq("to-taste stays null",s8[1].scaled,null);
  eq("base servings unchanged",T.scaledIngredients(it,4)[0].scaled,2);
  // ---------- convertForDisplay ----------
  var c=function(a,u,s){var r=T.convertForDisplay(a,u,s);return [Math.round(r.amount*100)/100,r.unit];};
  eq("US 200 g",c(200,"g","us"),[7.05,"oz"]); eq("US 700 g",c(700,"g","us"),[1.54,"lb"]);
  eq("US 250 ml",c(250,"ml","us"),[1.06,"cup"]); eq("metric 1 lb",c(1,"lb","metric"),[453.59,"g"]);
  eq("metric 2 cup",c(2,"cup","metric"),[473.18,"ml"]); eq("clove passthrough",c(3,"clove","metric"),[3,"clove"]);
  eq("original passthrough",c(2,"cups","original"),[2,"cups"]);
  // ---------- canonical / shoppable ----------
  var sh=function(a,u){var q=T.canonicalQuantity(a,u);var r=T.shoppableQuantity(q.amount,q.family,q.unit);return [r.amount,r.unit];};
  eq("450 g -> 1 lb",sh(450,"g"),[1,"lb"]); eq("90 g -> 3.25 oz",sh(90,"g"),[3.25,"oz"]);
  eq("200 g -> 7.25 oz",sh(200,"g"),[7.25,"oz"]); eq("12 g stays grams",sh(12,"g"),[12,"g"]);
  eq("1.9 cup -> 2 cup",sh(1.9,"cup"),[2,"cup"]); eq("1.3 count -> 2",sh(1.3,null),[2,null]);
  // ---------- normalizeItemName / displayGroceryName ----------
  eq("norm pepper to taste",T.normalizeItemName("Black Pepper, to taste"),"pepper");
  eq("norm kosher salt",T.normalizeItemName("kosher salt"),"salt");
  eq("norm EVOO",T.normalizeItemName("extra-virgin olive oil"),"olive oil");
  eq("norm scallions",T.normalizeItemName("scallions"),"green onion");
  eq("norm garbanzo",T.normalizeItemName("garbanzo beans"),"chickpea beans");
  eq("norm boneless skinless kept as product",T.normalizeItemName("boneless, skinless chicken breasts"),"chicken breast");
  eq("display carrots, diced",T.displayGroceryName("carrots, diced"),"carrots");
  eq("display potatoes peeled and chopped",T.displayGroceryName("potatoes, peeled and chopped"),"potatoes");
  eq("display olive oil dash note",T.displayGroceryName("olive oil — a splash"),"olive oil");
  eq("display peeled tomatoes kept",T.displayGroceryName("peeled tomatoes"),"peeled tomatoes");
  eq("display onion cut into wedges",T.displayGroceryName("onion, cut into wedges"),"onion");
  // ---------- categorize ----------
  eq("frozen peas",T.categorizeGrocery("frozen peas"),"Frozen"); eq("chicken broth",T.categorizeGrocery("chicken broth"),"Canned & Jarred");
  eq("peanut butter",T.categorizeGrocery("peanut butter"),"Dry Goods & Baking"); eq("butter",T.categorizeGrocery("butter"),"Dairy & Eggs");
  eq("bucatini",T.categorizeGrocery("bucatini"),"Dry Goods & Baking"); eq("guanciale",T.categorizeGrocery("guanciale"),"Meat & Seafood");
  eq("ginger not gin",T.categorizeGrocery("ginger"),"Produce"); eq("unmatched",T.categorizeGrocery("zzz widget"),"Other");
  // ---------- staples ----------
  eq("staple olive oil",T.isPantryStaple("olive oil"),true); eq("not staple bell pepper",T.isPantryStaple("bell pepper"),false);
  eq("not staple almond flour",T.isPantryStaple("almond flour"),false); eq("staple flour",T.isPantryStaple("flour"),true);
  // ---------- misc ----------
  eq("groupRuns",T.groupRuns([{group:"A"},{group:"A"},{group:null},{group:"B"}]).map(function(r){return [r.group,r.items.length];}),[["A",2],[null,1],["B",1]]);
  eq("esc",T.esc("<a href=\"x\">&'"),"&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  var mo=T.mergeAisleOrder(["Dairy & Eggs","Produce"]); ok("aisle merge keeps order + appends + Other last",mo[0]==="Dairy & Eggs"&&mo[1]==="Produce"&&mo[mo.length-1]==="Other"&&mo.length===11,JSON.stringify(mo));
  eq("aisle merge null",T.mergeAisleOrder(null).length,11);
  var pd=function(t){return T.parseDurations(t).map(function(d){return d.seconds;});};
  eq("timer 10 minutes",pd("simmer 10 minutes"),[600]); eq("timer 1.5 hours",pd("roast 1.5 hours"),[5400]);
  eq("timer 30 secs",pd("whisk 30 secs"),[30]); eq("timer two durations",pd("bake 20 minutes, rest 5 minutes"),[1200,300]);
  eq("timer none",pd("stir well"),[]);

  // ================= BUG PROBES (each should PASS once fixed) =================
  eq("PROBE timer '1/2 hour' = 1800s",pd("Bake 1/2 hour"),[1800]);
  eq("PROBE timer '1 1/2 hours' = 5400s",pd("Simmer 1 1/2 hours"),[5400]);
  eq("PROBE timer '½ hour' = 1800s",pd("Rest ½ hour"),[1800]);
  eq("PROBE shoppable 0.3 g saffron never rounds to 0",sh(0.3,"g")[0]>0,true);
  var cb=function(a,u,sys,bar){var r=T.convertForDisplay(a,u,sys,bar);return [Math.round(r.amount*100)/100,r.unit];};
  eq("PROBE bar 'oz' -> metric ml (not grams)",cb(2,"oz","metric",true),[59.15,"ml"]);
  eq("bar 'oz' stays oz in US",cb(2,"oz","us",true),[2,"oz"]);
  eq("kitchen 'oz' is still a weight",cb(2,"oz","metric",false),[56.7,"g"]);
  eq("'fl oz' -> metric ml anywhere",cb(1.5,"fl oz","metric",false),[44.36,"ml"]);

  // ---------- Phase 7: XSS payloads render as text ----------
  await openDetail("r3"); await later(80);
  var row=$('.item[data-id="r3"]');
  ok("XSS: no payload executed",window.XSS===undefined,"XSS="+window.XSS);
  ok("XSS: payload shown as text",row&&row.textContent.indexOf("<img src=x onerror")>=0,row&&row.textContent.slice(0,80));
  ok("XSS: no injected elements",row&&!row.querySelector("img,svg,iframe,script"),"");
  ok("XSS: javascript: source not linked",!row.querySelector('a[href^="javascript"]'));
  click($('.item[data-id="r3"] .item-head')); await later(20);
  // ---------- UI: Gin Sour detail in Metric shows ml ----------
  click(document.querySelector('.tab[data-section="cocktails"]')); await later(40);
  await openDetail("r2");
  click($('.item[data-id="r2"] .unit-toggle-btn[data-unit="metric"]')); await later(40);
  var amts=Array.prototype.map.call(document.querySelectorAll('.item[data-id="r2"] .ing-amt'),function(e){return e.textContent;}).join(" | ");
  ok("PROBE Gin Sour metric view shows ml",/ml/.test(amts)&&!/\bg\b/.test(amts),amts);
  click($('.item[data-id="r2"] .unit-toggle-btn[data-unit="original"]')); await later(20);
  click($('.item[data-id="r2"] .item-head')); await later(20);
  click(document.querySelector('.tab[data-section="recipes"]')); await later(40);
  // ---------- UI: coach send-button after close mid-flight ----------
  var resolveCoach=null;
  window.INVOKE_IMPL=function(n){ if(n==="recipe-coach")return new Promise(function(r){resolveCoach=r;}); return Promise.resolve({data:{},error:null}); };
  await openDetail("r1");
  click($('.coach-btn[data-id="r1"]')); await later(30);
  $("#coach-input").value="why is it bland?"; click($("#coach-send")); await later(30);
  click($("#close-coach")); await later(10);
  click($('.coach-btn[data-id="r1"]')); await later(30);
  ok("PROBE coach Send re-enabled after close+reopen mid-flight",!$("#coach-send").disabled,"disabled="+$("#coach-send").disabled);
  resolveCoach({data:{result:{reply:"late",needs_more_info:false,suggestions:[],revised_recipe:null}},error:null}); await later(30);

  // ---------- UI: coach reply lands in the mode it was asked in ----------
  try{localStorage.clear();}catch(e){}
  click($("#close-coach")); click($('.coach-btn[data-id="r1"]')); await later(30);
  $("#coach-input").value="it burned"; click($("#coach-send")); await later(20); // troubleshoot, in flight
  click($("#coach-mode-tweak")); await later(20);                                   // switch modes mid-flight
  resolveCoach({data:{result:{reply:"TROUBLESHOOT-ANSWER",needs_more_info:false,suggestions:[],revised_recipe:null}},error:null}); await later(40);
  var tweakThread=$("#coach-thread").textContent;
  ok("PROBE troubleshoot reply not dumped into tweak thread",tweakThread.indexOf("TROUBLESHOOT-ANSWER")<0,tweakThread.slice(0,120));
  click($("#close-coach"));

  // ---------- UI: Apply coach revision keeps the recipe's Source ----------
  window.INVOKE_IMPL=function(n){ if(n==="recipe-coach")return Promise.resolve({data:{result:{reply:"Use **sherry vinegar** <img src=q onerror=window.XSS=9>",needs_more_info:false,suggestions:["Add **½ tsp** Dijon"],
     revised_recipe:{name:"Weeknight Chili",subtitle:null,source:null,section:"kitchen",tags:["american"],base_servings:4,servings_label:"servings",
     ingredients:[{amount:1,unit:"cup",item:"onion",group:null}],method:[{text:"Brown it.",group:null}],notes:"AI adjusted: x"}}},error:null});
     return Promise.resolve({data:{},error:null}); };
  try{localStorage.clear();}catch(e){}
  click($('.coach-btn[data-id="r1"]')); await later(30); click($("#coach-mode-tweak")); await later(10);
  $("#coach-input").value="less onion"; click($("#coach-send")); await later(40);
  var aiMsg=document.querySelectorAll("#coach-thread .coach-msg.ai"); aiMsg=aiMsg[aiMsg.length-1];
  ok("PROBE coach **bold** renders as <b>, no raw asterisks",aiMsg&&aiMsg.querySelector("b")&&aiMsg.querySelector("b").textContent==="sherry vinegar"&&aiMsg.textContent.indexOf("**")<0,aiMsg&&aiMsg.innerHTML.slice(0,160));
  ok("coach reply markup stays escaped",aiMsg&&!aiMsg.querySelector("img")&&window.XSS===undefined,aiMsg&&aiMsg.innerHTML.slice(0,160));
  var apply=$(".coach-apply-btn"); ok("coach Apply button shows",!!apply);
  if(apply){click(apply); await later(30);}
  eq("PROBE Apply keeps Source",$("#rf-source").value,"https://example.com/chili");
  click($("#close-recipe-form"));

  // ---------- UI: double-tap Save creates one recipe ----------
  CALLS.insert=[];
  click($("#add-recipe")); await later(20);
  $("#rf-name").value="Double Tap Test"; document.querySelector(".rf-ing-item").value="flour";
  $("#recipe-form").requestSubmit(); $("#recipe-form").requestSubmit(); await later(150);
  eq("PROBE double submit inserts once",CALLS.insert.filter(function(x){return x[0]==="recipes";}).length,1);

  // ---------- UI: bar cocktails on the grocery list ----------
  var barTab=document.querySelector('.tab[data-section="cocktails"]'); click(barTab); await later(30);
  click($('.item[data-id="r2"] .pick')); await later(80);
  for(var i=0;i<7;i++){ click($('.item[data-id="r2"] .serv-btn[data-step="1"]')); }
  await later(250);
  var gin=T.combinedGroceryItems().filter(function(x){return /gin/.test(x.item);})[0];
  ok("PROBE 8 gin sours: gin not listed by weight (lb)",gin && gin.unit!=="lb",JSON.stringify(gin));
 }catch(e){ok("no exception",false,e&&e.stack||e);}
 finish();
}

fetch("index.html").then(function(r){return r.text();}).then(function(txt){
  var doc=new DOMParser().parseFromString(txt,"text/html");
  Array.prototype.slice.call(doc.body.childNodes).forEach(function(n){ if(n.tagName!=="SCRIPT")document.body.appendChild(document.importNode(n,true)); });
  return fetch("app.js");
}).then(function(r){return r.text();}).then(function(src){
  var hook="  initAuth();\n})();";
  var i=src.lastIndexOf(hook); if(i<0){ok("expose hook found",false);finish();return;}
  var expose="  window.__T={fmtAmount,scaledIngredients,convertForDisplay,canonicalQuantity,shoppableQuantity,normalizeItemName,displayGroceryName,"+
    "categorizeGrocery,isPantryStaple,groupRuns,esc,mergeAisleOrder,parseDurations,combinedGroceryItems};\n";
  src=src.slice(0,i)+expose+src.slice(i);
  var s=document.createElement("script"); s.src=URL.createObjectURL(new Blob([src],{type:"text/javascript"}));
  s.onload=function(){ var tries=0;(function w(){ if(document.querySelector('.item[data-id="r1"]')||tries>80){runTests();return;} tries++; setTimeout(w,50);})(); };
  document.head.appendChild(s);
}).catch(function(e){ok("boot",false,e);finish();});
</script></body></html>"""

def main():
    PAGE.write_text(HTML)
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Q, directory=str(REPO)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        out = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=20000",
            "--dump-dom", f"http://127.0.0.1:{httpd.server_address[1]}/{PAGE.name}"], capture_output=True, text=True, timeout=120).stdout
    finally:
        httpd.shutdown()
        if "--keep" not in sys.argv: PAGE.unlink(missing_ok=True)
    m = re.search(r'<pre id="smoke-results"[^>]*>(.*?)</pre>', out, re.S)
    if not m or not m.group(1).strip(): print("NO RESULTS:\n", out[:1500]); sys.exit(1)
    res = json.loads(m.group(1).replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    for r in res: print(("  ok   " if r["pass"] else "FAIL  ") + r["name"] + ("" if r["pass"] else "   >> " + r["detail"][:220]))
    n = sum(r["pass"] for r in res)
    print(f"\n{n}/{len(res)} passed")
    sys.exit(0 if n == len(res) else 2)
main()
