const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/store.js","assets/routes.js","assets/app.js","assets/live.js"])))=>i.map(i=>d[i]);
import{t as e}from"./app.js";import{t}from"./live.js";
function n(){try{return window.Telegram?.WebApp?.initData||``}catch{return``}}
async function i(e,t){
  let hdr=new Headers(t&&t.headers),auth=!(t&&t.auth===false);
  if(auth){let a=n();a&&hdr.set(`X-Telegram-Init-Data`,a)}
  t&&t.body&&!hdr.has(`Content-Type`)&&hdr.set(`Content-Type`,`application/json`);
  /* Подстановка ?tg=<id> убрана: сервер её больше не принимает, а раньше
     она позволяла открыть любой чужой аккаунт по одному номеру в адресе. */
  let s=new AbortController,c=setTimeout(()=>s.abort(),15e3);
  try{let res=await fetch(e,{...t,headers:hdr,signal:s.signal});
    if(!res.ok){lastStatus=res.status;return null}
    lastStatus=200;return await res.json()}
  catch{lastStatus=0;return null}
  finally{clearTimeout(c)}
}
let lastStatus=0;
function hasFlow(n){let f=n&&n.flow;if(!f||typeof f!=`object`)return!1;let row=f[1]||f[`1`]||f[24]||f[`24`]||{};return Array.isArray(row.rows)&&row.rows.length>0||Array.isArray(n.rank&&n.rank.spot&&n.rank.spot.pnl)&&n.rank.spot.pnl.length>0}
async function a(){
  /* Раньше здесь шли ДВА запроса /api/bootstrap — анонимный и подписанный —
     и результаты сливались. Ответ на подписанный уже содержит и общие
     данные, и личные, так что второй запрос был лишней нагрузкой, а слияние
     маскировало сбой авторизации: экран показывал публичные данные, будто
     всё в порядке. */
  let n=await i(`/api/bootstrap`);
  if(!n)return!1;
  n.wallets=Array.isArray(n.wallets)?n.wallets:[];
  n.live=!0;n.ok=!0;
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
/* Прежний цикл дёргал boot() каждые 8 секунд при неудаче И параллельно
   держал интервал на 3 минуты — при затяжном сбое запросы накладывались.
   Теперь одна цепочка: успех — следующий опрос через 3 минуты, неудача —
   пауза растёт вдвое до минуты. На 401/403 смысла долбиться нет: подписи
   нет и не появится, ждём дольше. */
try{
  let delay=8e3,timer=0;
  const tick=async()=>{
    let ok=await a();
    if(ok){delay=8e3;timer=setTimeout(tick,18e4);return}
    if(lastStatus===401||lastStatus===403)delay=6e4;
    else delay=Math.min(6e4,delay*2);
    timer=setTimeout(tick,delay);
  };
  tick();
  document.addEventListener(`visibilitychange`,()=>{
    if(document.visibilityState===`visible`){clearTimeout(timer);timer=setTimeout(tick,300)}
  });
}catch{}
