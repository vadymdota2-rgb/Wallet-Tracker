/**
 * Запросы к whale_api.py через nginx.
 *
 * Подпись Telegram уходит заголовком `X-Telegram-Init-Data`. Подстановки
 * `?tg=<id>` здесь нет и быть не должно: сервер её больше не принимает, а
 * когда принимал — по одному номеру в адресе открывался чужой аккаунт.
 */
import { initData } from "./telegram";
import { forget, peek, remember } from "./memo";
import type {
  Bootstrap, Deal, DigestActReply, DigestCommentsReply, DigestReply, DigestTranslation, FlowRow, LiqMapReply,
  LiqCoinsReply, FngReply, DomReply, EtfReply, HalvingReply, FundRow, LsRow, MutationResult,
  RotSide, SymbolRow, TokenHist, Trades, UnlocksReply, WalletLive,
  BtcBigReply, BtcFlowReply, BtcRankReply, BtcWalletReply,
} from "./types";

const TIMEOUT_MS = 15000;

/** Код последнего ответа: 0 — сети не было. Нужен опросу, чтобы не долбиться. */
export let lastStatus = 0;

interface Opts {
  method?: string;
  body?: unknown;
  /** Запрос без подписи — для публичных данных. */
  anon?: boolean;
  signal?: AbortSignal;
  /** Своё время ожидания — для тяжёлых ответов, которые сервер считает. */
  timeout?: number;
}

async function call<T>(path: string, opts: Opts = {}): Promise<T | null> {
  const headers = new Headers();
  if (!opts.anon) {
    const auth = initData();
    if (auth) headers.set("X-Telegram-Init-Data", auth);
  }
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    lastStatus = res.status;
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    lastStatus = 0;
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Ответ годен для памяти: пришёл и не отказ. */
const good = (v: unknown): boolean =>
  v !== null && typeof v === "object" && (v as { ok?: boolean }).ok !== false;

/** Сколько живут ответы в памяти. Живые позиции — минуту, остальное дольше:
 *  сервер и сам пересчитывает их не чаще. */
const TTL = {
  wallet: 60_000,
  token: 10 * 60_000,
  board: 3 * 60_000,
  deals: 5 * 60_000,
};

/** GET из памяти: один путь — один ответ, и экран, и подгрузка ждут его же. */
function cachedGet<T>(path: string, ttl: number): Promise<T | null> {
  return remember<T | null>(path, ttl, () => call<T>(path), good);
}

/** Полная выгрузка: личное и общее одним запросом. */
export function fetchBootstrap(signal?: AbortSignal): Promise<Bootstrap | null> {
  return call<Bootstrap>("/api/bootstrap", { signal });
}

/** Только общее — когда подписи нет. */
export function fetchMarket(signal?: AbortSignal): Promise<Bootstrap | null> {
  return call<Bootstrap>("/api/market", { anon: true, signal });
}

/**
 * Позиции и остаток одного кошелька — живьём из Hyperliquid. Отдельно от
 * общей выдачи: она собирается для всех разом, а это — по одному кошельку.
 * При запуске подгрузка проходит по всем кошелькам человека заранее.
 */
const walletPath = (addr: string) => `/api/wallet?addr=${encodeURIComponent(addr)}`;
export function fetchWallet(addr: string, _signal?: AbortSignal): Promise<WalletLive | null> {
  return cachedGet<WalletLive>(walletPath(addr), TTL.wallet);
}

/** Почасовые цены BSC-токена за три месяца — из них строятся свечи. */
const tokenPath = (addr: string) => `/api/token?addr=${encodeURIComponent(addr.toLowerCase())}`;
export function fetchTokenHist(addr: string, _signal?: AbortSignal): Promise<TokenHist | null> {
  return cachedGet<TokenHist>(tokenPath(addr), TTL.token);
}
export const peekTokenHist = (addr: string) => peek<TokenHist | null>(tokenPath(addr), TTL.token);

/** Крупнейшие сделки за окно. Окна те же, что в боте: 1h, 24h, 7d, 30d. */
const bigPath = (win: string) => `/api/big?win=${encodeURIComponent(win)}`;
export function fetchBig(win: string, _signal?: AbortSignal): Promise<Trades | null> {
  return cachedGet<Trades>(bigPath(win), TTL.board);
}
export const peekBig = (win: string) => peek<Trades | null>(bigPath(win), TTL.board);

export const addWallet = (addr: string, name: string) =>
  call<MutationResult>("/api/wallets", { method: "POST", body: { addr, name } });

export const removeWallet = (addr: string) =>
  call<MutationResult>("/api/wallets/remove", { method: "POST", body: { addr } });

export const setPrimary = (addr: string) =>
  call<MutationResult>("/api/wallets/primary", { method: "POST", body: { addr } });

export const renameWallet = (addr: string, name: string) =>
  call<MutationResult>("/api/wallets/rename", { method: "POST", body: { addr, name } });

export const setThreshold = (usd: number) =>
  call<MutationResult>("/api/threshold", { method: "POST", body: { usd } });

/**
 * Поток денег по всем монетам окна, а не только по попавшим в выгрузку.
 *
 * В выгрузке лежат сорок монет: держать там все за тридцать дней — это
 * тысячи записей с рядами при каждом запуске. Искать человек хочет среди
 * всех, поэтому поиск уходит на сервер.
 */
const flowPath = (win: string, q: string, offset: number, side: string) =>
  `/api/flow?win=${encodeURIComponent(win)}&q=${encodeURIComponent(q)}` +
  `&offset=${offset}&side=${encodeURIComponent(side)}`;
type Page<R> = { ok?: boolean; rows?: R[]; total?: number };
export const fetchFlow = (
  win: string,
  q: string,
  offset = 0,
  side = "all",
  _signal?: AbortSignal,
) => cachedGet<Page<FlowRow>>(flowPath(win, q, offset, side), TTL.board);
export const peekFlow = (win: string, q: string, offset = 0, side = "all") =>
  peek<Page<FlowRow> | null>(flowPath(win, q, offset, side), TTL.board);

/** Страница раздела «Лонг / Шорт». Те же правила, что у потока. */
const lsPath = (win: string, q: string, offset: number, side: string, cls: string) =>
  `/api/ls?win=${encodeURIComponent(win)}&q=${encodeURIComponent(q)}` +
  `&offset=${offset}&side=${encodeURIComponent(side)}&cls=${encodeURIComponent(cls)}`;
export const fetchLs = (
  win: string,
  q: string,
  offset = 0,
  side = "all",
  cls = "crypto",
  _signal?: AbortSignal,
) => cachedGet<Page<LsRow>>(lsPath(win, q, offset, side, cls), TTL.board);
export const peekLs = (win: string, q: string, offset = 0, side = "all", cls = "crypto") =>
  peek<Page<LsRow> | null>(lsPath(win, q, offset, side, cls), TTL.board);

/**
 * Страница доски фандинга. Первая приходит с общей выгрузкой, остальные —
 * отсюда: перекосов на крупной бирже под тысячу.
 */
export const fetchFund = (ex: string, offset = 0, limit = 20, _signal?: AbortSignal) =>
  cachedGet<{ ok?: boolean; ex?: string; rows?: FundRow[]; total?: number }>(
    `/api/fund?ex=${encodeURIComponent(ex)}&offset=${offset}&limit=${limit}`,
    TTL.board,
  );

/**
 * Страница столбцов ротации. Первая приходит с общей выгрузкой, остальные —
 * отсюда: монет в окне сотни, и возить их все каждому запуску незачем.
 */
export const fetchRot = (win: string, offset = 0, limit = 15, _signal?: AbortSignal) =>
  cachedGet<{ ok?: boolean; src?: RotSide[]; dst?: RotSide[]; msrc?: number; mdst?: number }>(
    `/api/rot?win=${encodeURIComponent(win)}&offset=${offset}&limit=${limit}`,
    TTL.board,
  );

/**
 * Последние сделки кошелька из рейтинга.
 *
 * Отдельным запросом, а не в общей выгрузке: история нужна тем, кто её
 * открыл, а тянуть по десять сделок на каждого из ста трейдеров при каждом
 * запуске — это сто запросов к базе ради экрана, куда заходят изредка.
 */
const dealsPath = (addr: string, venue: string, n: number) =>
  `/api/deals?addr=${encodeURIComponent(addr.toLowerCase())}&venue=${encodeURIComponent(venue)}&n=${n}`;
/** Ответ истории. `cap` — бесплатному отдано столько, дальше за подпиской. */
export type DealsReply = { ok?: boolean; deals?: Deal[]; cap?: number };
export const fetchDeals = (addr: string, venue: string, n: number, _signal?: AbortSignal) =>
  cachedGet<DealsReply>(dealsPath(addr, venue, n), TTL.deals);
export const peekDeals = (addr: string, venue: string, n: number) =>
  peek<DealsReply | null>(dealsPath(addr, venue, n), TTL.deals);

/** Приглашения: ссылка человека и сколько друзей по ней пришло. */
export interface RefInfo {
  ok: boolean;
  code?: string;
  /** Пусто, если сервер не узнал имя бота: тогда и звать некуда. */
  link?: string;
  invited?: number;
  days?: number;
  bonus?: number;
}
const REF_TTL = 10 * 60_000;
export const fetchRef = () => cachedGet<RefInfo>("/api/ref", REF_TTL);
export const peekRef = () => peek<RefInfo | null>("/api/ref", REF_TTL);

/** Присылать ли в Telegram, что вышел новый выпуск дайджеста. */
/** Токен проекта: подписан ли человек на уведомление о запуске. */
export const fetchTokenState = () => call<{ ok: boolean; on?: boolean }>("/api/token");
export const setTokenNotify = (on: boolean) =>
  call<{ ok: boolean; on?: boolean }>("/api/token/notify", { method: "POST", body: { on } });

export const setDigestNotify = (on: boolean) =>
  call<{ ok: boolean; notify?: boolean }>("/api/digest/notify", { method: "POST", body: { on } });

/** Событие воронки продаж: сервер пишет его раз в сутки на человека. Ответ
 *  не нужен — замер не должен ничего задерживать. */
export const trackEvent = (ev: "paywall", src: string) =>
  void call<{ ok?: boolean }>("/api/ev", { method: "POST", body: { ev, src } });

/**
 * Право на забвение. Сервер удаляет те же таблицы, что команда /forgetme в
 * боте, и намеренно не возвращает свежую выгрузку: после удаления
 * возвращать нечего.
 */
export const forgetMe = () => call<MutationResult>("/api/forget", { method: "POST", body: {} });

/** История открыта — счётчик новых обнуляется. `upto` — время последнего
 *  показанного алерта: пришедший позже останется непрочитанным. */
export const markAlertsSeen = (upto: number) =>
  call<MutationResult>("/api/alerts/seen", { method: "POST", body: { upto } });

/** Куда слать алерты: в Telegram и сюда (true) или только сюда (false). */
export const setAlertMode = (tg: boolean) =>
  call<MutationResult>("/api/alerts/mode", { method: "POST", body: { tg } });

/** Справочник монет для поиска на графике: всё, что торгуется на Binance,
 *  Bybit и Hyperliquid. Меняется редко — держим шесть часов. */
const SYMBOLS_TTL = 6 * 3600_000;
export const fetchSymbols = () =>
  cachedGet<{ ok?: boolean; items?: SymbolRow[] }>("/api/symbols", SYMBOLS_TTL);
export const peekSymbols = () =>
  peek<{ ok?: boolean; items?: SymbolRow[] } | null>("/api/symbols", SYMBOLS_TTL);

/** Календарь разлоков: сервер пересчитывает цены раз в час. */
const UNLOCKS_TTL = 30 * 60_000;
/* Последний календарь лежит и на устройстве: память ответов живёт до
   закрытия приложения, и после каждого запуска экран ждал сеть с пустым
   списком. Разлоки расписаны на месяцы вперёд — вчерашний список годится,
   чтобы открыться сразу, а свежий тем временем догружается. */
const UNLOCKS_SAVED = "wt-unlocks-v1";
const UNLOCKS_SAVED_MAX_AGE = 7 * 24 * 3600_000;

export function savedUnlocks(): UnlocksReply | null {
  try {
    const raw = localStorage.getItem(UNLOCKS_SAVED);
    if (!raw) return null;
    const v = JSON.parse(raw) as UnlocksReply & { at?: number };
    if (!v?.at || !Array.isArray(v.items) || Date.now() - v.at > UNLOCKS_SAVED_MAX_AGE) return null;
    return v;
  } catch {
    return null;
  }
}

/* Подписчику ответ полнее (реакция цены на прошлые разлоки), поэтому у него
   свой адрес в памяти ответов: купил премиум — получает полный, а не
   бесплатный из кэша. `p` сервер не читает. */
const unlocksPath = (premium: boolean) => (premium ? "/api/unlocks?p=1" : "/api/unlocks");
export const fetchUnlocks = (premium = false) =>
  cachedGet<UnlocksReply>(unlocksPath(premium), UNLOCKS_TTL).then((r) => {
    if (r?.ok && r.items?.length) {
      try {
        localStorage.setItem(
          UNLOCKS_SAVED,
          JSON.stringify({ at: Date.now(), items: r.items, none: r.none, noEmit: r.noEmit, stake: r.stake, supply: r.supply, vol: r.vol, react: r.react, reactN: r.reactN, measured: r.measured }),
        );
      } catch {
        // место кончилось или хранилище закрыто — просто без запаса
      }
    }
    return r;
  });
export const peekUnlocks = (premium = false) => peek<UnlocksReply | null>(unlocksPath(premium), UNLOCKS_TTL);

/** Язык хранится в той же строке users, что читает бот: выбор общий. */
export const setLangRemote = (lang: string) =>
  call<MutationResult>("/api/lang", { method: "POST", body: { lang } });

/* Дайджест. Выпуск выходит раз в сутки, поэтому список держится в памяти
   пять минут; лайки и комментарии экран меняет у себя сразу, не дожидаясь
   нового списка. */
const DIGEST_TTL = 5 * 60_000;
export const fetchDigest = () => cachedGet<DigestReply>("/api/digest", DIGEST_TTL);
export const peekDigest = () => peek<DigestReply | null>("/api/digest", DIGEST_TTL);
export const fetchDigestComments = (id: number, before = 0) =>
  call<DigestCommentsReply>(`/api/digest/comments?id=${id}${before ? `&before=${before}` : ""}`);
export const likeDigest = (id: number) =>
  call<DigestActReply>("/api/digest/like", { method: "POST", body: { id } });
/* Просмотр выпуска: шлётся один раз с телефона — какие уже отмечены, помнит
   само устройство, а сервер всё равно считает каждого человека один раз. */
const DG_SEEN = "wt-dg-seen";
export function viewDigest(id: number): Promise<DigestActReply | null> | null {
  let seen: number[] = [];
  try {
    seen = JSON.parse(localStorage.getItem(DG_SEEN) || "[]");
  } catch {
    seen = [];
  }
  if (Array.isArray(seen) && seen.includes(id)) return null;
  return call<DigestActReply>("/api/digest/view", { method: "POST", body: { id } }).then((r) => {
    if (r?.ok) {
      try {
        localStorage.setItem(DG_SEEN, JSON.stringify([id, ...(Array.isArray(seen) ? seen : [])].slice(0, 60)));
      } catch {
        // без памяти — отметим ещё раз, сервер не задвоит
      }
    }
    return r;
  });
}
export const commentDigest = (id: number, text: string, anon: boolean) =>
  call<DigestActReply>("/api/digest/comment", { method: "POST", body: { id, text, anon } });
export const translateComment = (cid: number, lang: string) =>
  call<DigestTranslation>(`/api/digest/translate?cid=${cid}&lang=${encodeURIComponent(lang)}`);
export const uncommentDigest = (cid: number, mute = false) =>
  call<DigestActReply>("/api/digest/uncomment", { method: "POST", body: { cid, mute } });

/* Карта ликвидаций: сервер пересчитывает раз в пять минут — чаще спрашивать
   незачем. */
const liqPath = (sym: string, range: string) =>
  `/api/liqmap?sym=${encodeURIComponent(sym)}&range=${encodeURIComponent(range)}`;
/* Карта и список монет лежат и на устройстве: открыть экран нужно сразу, с
   прошлой картой, а свежая догружается поверх. Сервер собирает карту с
   десятков бирж, и первый расчёт бывает дольше обычных пятнадцати секунд —
   поэтому ждём до тридцати и один раз повторяем. */
const LIQ_TTL = 2 * 60_000;
const LIQ_SAVED = "wt-liqmap-v1";
const LIQ_SAVED_KEEP = 10;
const LIQ_SAVED_MAX_AGE = 3 * 24 * 3600_000;
const LIQ_COINS_SAVED = "wt-liqcoins-v1";

type Saved<T> = { at: number; v: T };

function readSaved<T>(key: string): Record<string, Saved<T>> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, Saved<T>>) : {};
  } catch {
    return {};
  }
}

function writeSaved<T>(key: string, all: Record<string, Saved<T>>): void {
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // место кончилось или хранилище закрыто — просто без запаса
  }
}

async function callTwice<T>(path: string): Promise<T | null> {
  const first = await call<T>(path, { timeout: 30_000 });
  if (good(first)) return first;
  return call<T>(path, { timeout: 30_000 });
}

/** Последняя карта этой монеты и окна с устройства — любой свежести до трёх суток. */
export function savedLiqMap(sym: string, range: string): { at: number; v: LiqMapReply } | null {
  const hit = readSaved<LiqMapReply>(LIQ_SAVED)[`${sym}|${range}`];
  return hit && Date.now() - hit.at < LIQ_SAVED_MAX_AGE && hit.v?.ok ? hit : null;
}

export const fetchLiqMap = (sym: string, range: string) =>
  remember<LiqMapReply | null>(liqPath(sym, range), LIQ_TTL, () => callTwice<LiqMapReply>(liqPath(sym, range)), good)
    .then((r) => {
      if (r?.ok) {
        const all = readSaved<LiqMapReply>(LIQ_SAVED);
        all[`${sym}|${range}`] = { at: Date.now(), v: r };
        const keys = Object.keys(all).sort((a, b) => (all[b]?.at ?? 0) - (all[a]?.at ?? 0));
        for (const k of keys.slice(LIQ_SAVED_KEEP)) delete all[k];
        writeSaved(LIQ_SAVED, all);
      }
      return r;
    });
export const peekLiqMap = (sym: string, range: string) => peek<LiqMapReply | null>(liqPath(sym, range), LIQ_TTL);
/** Свежая карта мимо памяти — для самообновления открытого экрана. */
export function refreshLiqMap(sym: string, range: string): Promise<LiqMapReply | null> {
  forget(liqPath(sym, range));
  return fetchLiqMap(sym, range);
}

/* Страх и жадность: индекс выходит раз в сутки. Последний ответ лежит на
   устройстве — экран открывается сразу, свежий догружается поверх. */
const FNG_SAVED = "wt-fng-v1";
export function savedFng(): FngReply | null {
  const hit = readSaved<FngReply>(FNG_SAVED).all;
  return hit && hit.v?.days?.length ? hit.v : null;
}
export const fetchFng = () =>
  remember<FngReply | null>("/api/fng", 30 * 60_000, () => callTwice<FngReply>("/api/fng"), good).then((r) => {
    if (r?.ok && r.days.length) writeSaved(FNG_SAVED, { all: { at: Date.now(), v: r } });
    return r;
  });
export const peekFng = () => peek<FngReply | null>("/api/fng", 30 * 60_000) ?? savedFng();

/* Доминация и альтсезон: данные меняются за часы, ответ живёт час и лежит
   на устройстве, как страх и жадность. */
const DOM_SAVED = "wt-dom-v1";
export function savedDom(): DomReply | null {
  const hit = readSaved<DomReply>(DOM_SAVED).all;
  return hit && hit.v?.rows?.length ? hit.v : null;
}
export const fetchDom = () =>
  remember<DomReply | null>("/api/dom", 60 * 60_000, () => callTwice<DomReply>("/api/dom"), good).then((r) => {
    if (r?.ok && r.rows.length) writeSaved(DOM_SAVED, { all: { at: Date.now(), v: r } });
    return r;
  });
export const peekDom = () => peek<DomReply | null>("/api/dom", 60 * 60_000) ?? savedDom();

/* ETF и крупные держатели: отчёты фондов выходят раз в сутки — ответ живёт
   час и лежит на устройстве. */
const ETF_SAVED = "wt-etf-v1";
export function savedEtf(): EtfReply | null {
  const hit = readSaved<EtfReply>(ETF_SAVED).all;
  return hit && hit.v?.coins?.btc ? hit.v : null;
}
export const fetchEtf = () =>
  remember<EtfReply | null>("/api/etf", 60 * 60_000, () => callTwice<EtfReply>("/api/etf"), good).then((r) => {
    if (r?.ok && r.coins?.btc) writeSaved(ETF_SAVED, { all: { at: Date.now(), v: r } });
    return r;
  });
export const peekEtf = () => peek<EtfReply | null>("/api/etf", 60 * 60_000) ?? savedEtf();

/* Халвинг: блок раз в десять минут — ответ живёт пять, последний лежит на
   устройстве, и отсчёт в меню виден сразу, даже без сети. */
const HALVING_SAVED = "wt-halving-v1";
export function savedHalving(): HalvingReply | null {
  const hit = readSaved<HalvingReply>(HALVING_SAVED).all;
  return hit && hit.v?.height ? hit.v : null;
}
export const fetchHalving = () =>
  remember<HalvingReply | null>("/api/halving", 5 * 60_000, () => call<HalvingReply>("/api/halving", { timeout: 12_000 }), good).then((r) => {
    if (r?.ok && r.height) writeSaved(HALVING_SAVED, { all: { at: Date.now(), v: r } });
    return r;
  });
export const peekHalving = () => peek<HalvingReply | null>("/api/halving", 5 * 60_000) ?? savedHalving();

/** Все монеты с фьючерсами — список раз в час; последний лежит на устройстве. */
export function savedLiqCoins(): LiqCoinsReply | null {
  const hit = readSaved<LiqCoinsReply>(LIQ_COINS_SAVED).all;
  return hit && Date.now() - hit.at < 7 * 24 * 3600_000 && hit.v?.coins?.length ? hit.v : null;
}
export const fetchLiqCoins = () =>
  remember<LiqCoinsReply | null>("/api/liqcoins", 60 * 60_000, () => callTwice<LiqCoinsReply>("/api/liqcoins"), good)
    .then((r) => {
      if (r?.ok && r.coins.length) writeSaved(LIQ_COINS_SAVED, { all: { at: Date.now(), v: r } });
      return r;
    });
export const peekLiqCoins = () => peek<LiqCoinsReply | null>("/api/liqcoins", 60 * 60_000) ?? savedLiqCoins();

/* Bitcoin: сканер бота пишет блок раз в десять минут — ответы живут минуту,
   рейтинг две. Поток лежит и на устройстве: карточка в NetFlow видна сразу. */
const BTC_TTL = 60_000;
const BTC_FLOW_SAVED = "wt-btcflow-v1";
export function savedBtcFlow(): BtcFlowReply | null {
  const hit = readSaved<BtcFlowReply>(BTC_FLOW_SAVED).all;
  return hit && hit.v?.ok && hit.v.wins ? hit.v : null;
}
export const fetchBtcFlow = () =>
  remember<BtcFlowReply | null>("/api/btc/flow", BTC_TTL, () => call<BtcFlowReply>("/api/btc/flow"), good).then((r) => {
    if (r?.ok && r.wins) writeSaved(BTC_FLOW_SAVED, { all: { at: Date.now(), v: r } });
    return r;
  });
export const peekBtcFlow = () => peek<BtcFlowReply | null>("/api/btc/flow", BTC_TTL) ?? savedBtcFlow();

const btcBigPath = (win: string, side: string, min: number, base = false) =>
  `/api/btc/big?win=${encodeURIComponent(win)}&side=${encodeURIComponent(side)}&min=${min}${base ? "&base=1" : ""}`;
export const fetchBtcBig = (win: string, side: string, min: number, base = false) =>
  cachedGet<BtcBigReply>(btcBigPath(win, side, min, base), BTC_TTL);
export const peekBtcBig = (win: string, side: string, min: number, base = false) =>
  peek<BtcBigReply | null>(btcBigPath(win, side, min, base), BTC_TTL);

const btcRankPath = (win: string) => `/api/btc/rank?win=${encodeURIComponent(win)}`;
export const fetchBtcRank = (win: string) => cachedGet<BtcRankReply>(btcRankPath(win), 2 * BTC_TTL);
export const peekBtcRank = (win: string) => peek<BtcRankReply | null>(btcRankPath(win), 2 * BTC_TTL);

const btcWalletPath = (addr: string) => `/api/btc/wallet?addr=${encodeURIComponent(addr)}`;
export const fetchBtcWallet = (addr: string) => cachedGet<BtcWalletReply>(btcWalletPath(addr), BTC_TTL);
export const peekBtcWallet = (addr: string) => peek<BtcWalletReply | null>(btcWalletPath(addr), BTC_TTL);
