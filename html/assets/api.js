const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/store.js","assets/routes.js","assets/app.js","assets/live.js"])))=>i.map(i=>d[i]);
import{t as e}from"./app.js";import{t}from"./live.js";
let lastError=``;
function n(){try{return window.Telegram?.WebApp?.initData||``}catch{return``}}
async function i(e,t){
  let hdr=new Headers(t&&t.headers),auth=!(t&&t.auth===false);
  if(auth){let a=n();a&&hdr.set(`X-Telegram-Init-Data`,a)}
  t&&t.body&&!hdr.has(`Content-Type`)&&hdr.set(`Content-Type`,`application/json`);
  // Адрес идёт как есть. Раньше при отсутствии подписи сюда дописывался
  // ?tg=<id> из непроверенной части — любой мог назваться кем угодно.
  let o=e;
  // Таймаут меньше интервала опроса, иначе запросы накладываются.
  let s=new AbortController,c=setTimeout(()=>s.abort(),3e4);
  try{
    let res=await fetch(o,{...t,headers:hdr,signal:s.signal});
    if(!res.ok){lastError=res.status===401?`auth`:`server`;return null}
    lastError=``;return await res.json();
  }catch(err){
    lastError=err&&err.name===`AbortError`?`timeout`:`network`;return null;
  }finally{clearTimeout(c)}
}
function hasFlow(n){let f=n&&n.flow;if(!f||typeof f!=`object`)return!1;let row=f[1]||f[`1`]||f[24]||f[`24`]||{};return Array.isArray(row.rows)&&row.rows.length>0||Array.isArray(n.rank&&n.rank.spot&&n.rank.spot.pnl)&&n.rank.spot.pnl.length>0}
function pickPub(dst,src){if(!src)return dst;dst=dst||{};["flow","rank","trades","marketFeed","funding","rot","sonar","coins"].forEach(k=>{if(src[k]!=null)dst[k]=src[k]});return dst}
async function a(){
  let pair=await Promise.all([i(`/api/bootstrap`,{auth:false}),i(`/api/bootstrap`)]);
  let pub=pair[0],boot=pair[1];
  let n=Object.assign({},pub||{},boot||{});
  if(!hasFlow(boot)&&hasFlow(pub))n=pickPub(n,pub);
  if(!hasFlow(n)&&pub)n=pickPub(n,pub);
  n.wallets=boot&&Array.isArray(boot.wallets)&&boot.wallets.length?boot.wallets:(n.wallets||[]);
  n.me=boot&&boot.me||n.me;
  n.live=!0;n.ok=!0;
  if(!hasFlow(n)&&(!n.wallets||!n.wallets.length))return!1;
  let{useApp:app}=await e(async()=>{let{useApp:e}=await import(`./store.js`);return{useApp:e}},__vite__mapDeps([0,1,2,3]));
  t(n,w=>{let me=n.me,cur=app.getState(),wallets=Array.isArray(w)&&w.length?w:cur.wallets;app.setState({wallets,plan:me&&me.plan===`premium`?`premium`:cur.plan,threshold:Number(me&&me.threshold)||cur.threshold,premUntil:Number(me&&me.premUntil)||cur.premUntil,lang:me&&me.lang||cur.lang,syncedAt:Date.now()})});
  try{document.documentElement.classList.add(`hydrated-live`)}catch{}
  return hasFlow(n)||n.wallets.length>0
}
async function o(e,t){return i(`/api/wallets`,{method:`POST`,body:JSON.stringify({addr:e,name:t})})}
async function s(e){return i(`/api/wallets/remove`,{method:`POST`,body:JSON.stringify({addr:e})})}
async function c(e){return i(`/api/wallets/primary`,{method:`POST`,body:JSON.stringify({addr:e})})}
async function l(e,t){return i(`/api/wallets/rename`,{method:`POST`,body:JSON.stringify({addr:e,name:t})})}
async function u(e){return i(`/api/threshold`,{method:`POST`,body:JSON.stringify({usd:e})})}
export{lastError as apiLastError,o as apiAddWallet,c as apiPrimary,s as apiRemoveWallet,l as apiRename,u as apiThreshold,a as pullLive};
// Опрос: нарастающая пауза при неудаче, остановка в фоне.
// Раньше шесть попыток подряд без паузы и опрос при погашенном экране.
try{
  let tries=0,timer=0;
  let tick=()=>{
    if(document.hidden)return;
    a().then(ok=>{
      if(ok){tries=0;return}
      tries=Math.min(tries+1,5);
      setTimeout(tick,Math.min(6e4,4e3*2**tries));  // 8с, 16с, 32с, 60с
    });
  };
  let start=()=>{if(!timer){tick();timer=setInterval(tick,18e4)}};
  let stop=()=>{clearInterval(timer);timer=0};
  document.addEventListener(`visibilitychange`,()=>document.hidden?stop():start());
  start();
}catch{}
