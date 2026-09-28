/**
 * Запросы к whale_api.py через nginx.
 *
 * Подпись Telegram уходит заголовком `X-Telegram-Init-Data`. Подстановки
 * `?tg=<id>` здесь нет и быть не должно: сервер её больше не принимает, а
 * когда принимал — по одному номеру в адресе открывался чужой аккаунт.
 */
import { initData } from "./telegram";
import { peek, remember } from "./memo";
import type {
  Bootstrap, Deal, FlowRow, FundRow, LsRow, MutationResult, RotSide, SymbolRow, TokenHist, Trades, UnlocksReply,
  WalletLive,
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
}

async function call<T>(path: string, opts: Opts = {}): Promise<T | null> {
  const headers = new Headers();
  if (!opts.anon) {
    const auth = initData();
    if (auth) headers.set("X-Telegram-Init-Data", auth);
  }
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
const dealsPath = (addr: string, venue: string) =>
  `/api/deals?addr=${encodeURIComponent(addr.toLowerCase())}&venue=${encodeURIComponent(venue)}&n=10`;
export const fetchDeals = (addr: string, venue: string, _signal?: AbortSignal) =>
  cachedGet<{ ok?: boolean; deals?: Deal[] }>(dealsPath(addr, venue), TTL.deals);
export const peekDeals = (addr: string, venue: string) =>
  peek<{ ok?: boolean; deals?: Deal[] } | null>(dealsPath(addr, venue), TTL.deals);

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

export const fetchUnlocks = () =>
  cachedGet<UnlocksReply>("/api/unlocks", UNLOCKS_TTL).then((r) => {
    if (r?.ok && r.items?.length) {
      try {
        localStorage.setItem(
          UNLOCKS_SAVED,
          JSON.stringify({ at: Date.now(), items: r.items, none: r.none, noEmit: r.noEmit }),
        );
      } catch {
        // место кончилось или хранилище закрыто — просто без запаса
      }
    }
    return r;
  });
export const peekUnlocks = () => peek<UnlocksReply | null>("/api/unlocks", UNLOCKS_TTL);

/** Язык хранится в той же строке users, что читает бот: выбор общий. */
export const setLangRemote = (lang: string) =>
  call<MutationResult>("/api/lang", { method: "POST", body: { lang } });
