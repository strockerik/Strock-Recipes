#!/usr/bin/env python3
# Stage-A smoke test for the King Soopers feature: boots the real app against a
# Supabase stub (fake profile, two manual grocery items) with functions.invoke
# ("kroger") stubbed to return canned stores + product matches. Drives the
# account-panel store picker + preference chips, then the grocery Send flow, and
# asserts the review sheet renders matched + unmatched rows. No backend, no spend.
import http.server, socketserver, subprocess, os, re, json, sys, threading, pathlib
def find_repo():
    for d in [pathlib.Path.cwd(), *pathlib.Path(__file__).resolve().parents]:
        if (d/"index.html").exists() and (d/"app.js").exists(): return d
    sys.exit("no repo")
REPO=find_repo(); CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TEST=REPO/"test_kroger.html"
HTML=r"""<!doctype html><html><head><meta charset="utf-8"><title>RUN</title>
<script>
var SUPABASE_URL="x",SUPABASE_ANON_KEY="y",USER_ID="u1";
var MANUAL=[{id:"m1",name:"chicken thighs",source_inventory_id:null,created_at:"2026-01-01T00:00:00Z"},
            {id:"m2",name:"exotic dragonfruit",source_inventory_id:null,created_at:"2026-01-02T00:00:00Z"}];
function Bld(t){var v=function(){
  if(t==="grocery_manual_items")return{data:MANUAL,error:null};
  if(t==="profiles")return{data:{id:USER_ID,display_name:"T",diet_prefs:null,grocery_prefs:null,kroger_prefs:null},error:null};
  return{data:[],error:null}};
 var p=new Proxy({},{get:function(o,k){if(k==="then")return function(f,r){return Promise.resolve(v()).then(f,r)};
  if(k==="catch")return function(r){return Promise.resolve(v()).catch(r)};return function(){return p}}});return p}
window.supabase={createClient:function(){return{from:function(t){return Bld(t)},
 auth:{onAuthStateChange:function(cb){setTimeout(function(){cb("INITIAL_SESSION",{user:{id:USER_ID,email:"t@t.co"}})},0);return{data:{subscription:{unsubscribe:function(){}}}}},
  getUser:function(){return Promise.resolve({data:{user:{id:USER_ID}},error:null})},
  getSession:function(){return Promise.resolve({data:{session:{user:{id:USER_ID,email:"t@t.co"}}},error:null})},
  signOut:function(){return Promise.resolve({error:null})}},
 functions:{invoke:function(name,opts){var body=(opts&&opts.body)||{};
  if(name==="kroger"){
   if(body.mode==="stores")return Promise.resolve({data:{stores:[
     {locationId:"62000123",name:"King Soopers - Downtown",address:"123 Main St, Denver, CO"},
     {locationId:"62000456",name:"King Soopers - Cap Hill",address:"456 E Colfax, Denver, CO"}]},error:null});
   if(body.mode==="search"){var results=(body.items||[]).map(function(it){var no=/dragon/i.test(it.item);
     return {key:it.key,item:it.item,product:no?null:{productId:"p"+it.key,upc:"1",description:"Kroger "+it.item,price:4.99,size:"1 lb",aisle:"12"}};});
     return Promise.resolve({data:{results:results,matched:results.filter(function(r){return r.product}).length,total:results.length},error:null});}
  }
  return Promise.resolve({data:{},error:null})}}}}};
</script></head><body><pre id="smoke-results" style="display:none"></pre>
<script>
var R=[];function A(n,c,d){R.push({name:n,pass:!!c,detail:d||""})}
function fin(){document.getElementById("smoke-results").textContent=JSON.stringify(R);document.title="DONE"}
function click(e){e&&e.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}))}
function delay(ms){return new Promise(function(r){setTimeout(r,ms)})}
function qa(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
async function run(){try{
 click(document.querySelector("#account-btn")); await delay(30);
 A("pref chips render (3)", qa('#kroger-pref [data-kroger-pref]').length===3, "n="+qa('#kroger-pref [data-kroger-pref]').length);
 A("modality chips render (2)", qa('#kroger-modality [data-kroger-modality]').length===2, "");
 A("no store chosen yet", /no store/i.test(document.querySelector("#kroger-store-current").textContent), document.querySelector("#kroger-store-current").textContent);

 document.querySelector("#kroger-zip").value="80202";
 click(document.querySelector("#kroger-find-store")); await delay(60);
 A("ZIP lookup lists stores (2)", qa('#kroger-store-results [data-store-id]').length===2, "n="+qa('#kroger-store-results [data-store-id]').length);

 click(qa('#kroger-store-results [data-store-id]')[0]); await delay(60);
 A("picking a store saves it", /store:\s*king soopers/i.test(document.querySelector("#kroger-store-current").textContent), document.querySelector("#kroger-store-current").textContent);

 click(document.querySelector('[data-kroger-pref="organic"]')); await delay(30);
 A("preference chip toggles on", document.querySelector('[data-kroger-pref="organic"]').classList.contains("is-on"), "");

 click(document.querySelector("#send-to-kingsoopers")); await delay(120);
 A("review sheet opens", !document.querySelector("#kroger-panel").hidden, "hidden="+document.querySelector("#kroger-panel").hidden);
 var rows=qa('#kroger-review-list .kroger-row');
 A("review lists both items (2 rows)", rows.length===2, "n="+rows.length);
 A("one item unmatched (dragonfruit)", qa('#kroger-review-list .kroger-row.is-unmatched').length===1, "");
 A("matched item has an Add-in-app link", !!document.querySelector('#kroger-review-list .kroger-row:not(.is-unmatched) a[href*="kingsoopers.com/search"]'), "");
}catch(e){A("no exception",false,String(e&&e.stack||e))}fin()}
fetch("index.html").then(function(r){return r.text()}).then(function(t){
 var doc=new DOMParser().parseFromString(t,"text/html"),f=document.createDocumentFragment();
 Array.prototype.slice.call(doc.body.childNodes).forEach(function(n){if(n.tagName==="SCRIPT")return;f.appendChild(document.importNode(n,true))});
 document.body.appendChild(f);var s=document.createElement("script");s.src="app.js";
 s.onload=function(){var i=0;(function w(){if(document.querySelector("#account-btn")||i>60){setTimeout(run,400);return}i++;setTimeout(w,50)})()};
 s.onerror=function(){A("app.js load",false,"err");fin()};document.head.appendChild(s)
}).catch(function(e){A("boot",false,String(e));fin()});
</script></body></html>"""
def main():
    TEST.write_text(HTML); os.chdir(REPO)
    socketserver.TCPServer.allow_reuse_address=True
    httpd=socketserver.TCPServer(("127.0.0.1",0),http.server.SimpleHTTPRequestHandler)
    port=httpd.server_address[1]; threading.Thread(target=httpd.serve_forever,daemon=True).start()
    try:
        out=subprocess.run([CHROME,"--headless=new","--disable-gpu","--no-sandbox","--virtual-time-budget=12000","--dump-dom",
            f"http://127.0.0.1:{port}/test_kroger.html"],capture_output=True,text=True,timeout=90).stdout
    finally:
        httpd.shutdown()
        if TEST.exists(): TEST.unlink()
    m=re.search(r'<pre id="smoke-results"[^>]*>(.*?)</pre>',out,re.S)
    if not m or not m.group(1).strip(): print("NO RESULTS:\n",out[:1600]); sys.exit(1)
    res=json.loads(re.sub(r"&quot;",'"',m.group(1)).replace("&amp;","&").replace("&lt;","<").replace("&gt;",">"))
    for r in res: print(("  ok   " if r["pass"] else "FAIL  ")+r["name"]+("" if r["pass"] else "  >> "+r["detail"]))
    print(f"\n{sum(1 for r in res if r['pass'])}/{len(res)} passed")
    sys.exit(0 if all(r["pass"] for r in res) else 2)
if __name__=="__main__": main()
