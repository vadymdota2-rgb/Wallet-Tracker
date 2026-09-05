const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/store.js","assets/routes.js","assets/app.js","assets/live.js"])))=>i.map(i=>d[i]);
import{t as e}from"./app.js";import{t}from"./live.js";
function n(){try{return window.Telegram?.WebApp?.initData||``}catch{return``}}
function r(){try{let e=(window.Telegram?.WebApp)?.initDataUnsafe?.user?.id;return e?String(e):``}catch{return``}}
async function i(e,t){
  let hdr=new Headers(t&&t.headers),auth=!(t&&t.auth===false);
  if(auth){let a=n();a&&hdr.set(`X-Telegram-Init-Data`,a)}
  t&&t.body&&!hdr.has(`Content-Type`)&&hdr.set(`Content-Type`,`application/json`);
  let o=auth&&r()&&!n()?`${e}${e.includes(`?`)?`&`:`?`}tg=${encodeURIComponent(r())}`:e;
  let s=new AbortController,c=setTimeout(()=>s.abort(),18e4);
  try{let res=await fetch(o,{...t,headers:hdr,signal:s.signal});return res.ok?await res.json():null}catch{return null}finally{clearTimeout(c)}
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
export{o as apiAddWallet,c as apiPrimary,s as apiRemoveWallet,l as apiRename,u as apiThreshold,a as pullLive};
try{let boot=()=>{a().then(ok=>{if(!ok)setTimeout(boot,8e3)})};boot();setInterval(()=>a(),18e4)}catch{}
