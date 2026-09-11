/**
 * Запросы к whale_api.py через nginx.
 *
 * Подпись Telegram уходит заголовком `X-Telegram-Init-Data`. Подстановки
 * `?tg=<id>` здесь нет и быть не должно: сервер её больше не принимает, а
 * когда принимал — по одному номеру в адресе открывался чужой аккаунт.
 */
import { initData } from "./telegram";
import type { Bootstrap, MutationResult, TokenHist, Trader, Trades, WalletLive } from "./types";

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
 * общей выдачи: ходить туда за каждым кошельком при каждом открытии
 * приложения незачем, смотрят их, только когда откроют сам кошелёк.
 */
export function fetchWallet(addr: string, signal?: AbortSignal): Promise<WalletLive | null> {
  return call<WalletLive>(`/api/wallet?addr=${encodeURIComponent(addr)}`, { signal });
}

/** Почасовые цены BSC-токена за три месяца — из них строятся свечи. */
export function fetchTokenHist(addr: string, signal?: AbortSignal): Promise<TokenHist | null> {
  return call<TokenHist>(`/api/token?addr=${encodeURIComponent(addr)}`, { signal });
}

/** Крупнейшие сделки за окно. Окна те же, что в боте: 1h, 24h, 7d, 30d. */
export function fetchBig(win: string, signal?: AbortSignal): Promise<Trades | null> {
  return call<Trades>(`/api/big?win=${encodeURIComponent(win)}`, { signal });
}

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
 * Страница доски трейдеров глубже первой сотни.
 *
 * В общей выгрузке лежит только начало доски: тысяча строк на каждую доску
 * и каждое окно — это мегабайты при каждом запуске, а так глубоко смотрят
 * единицы. Остальное подтягивается отсюда по мере прокрутки.
 *
 * Доска спотовая: у фьючерсов рейтинг считается на лету и кэша страниц для
 * него нет.
 */
export interface RankPage {
  ok?: boolean;
  rows?: Trader[];
  /** Сколько строк доступно этому пользователю с учётом подписки. */
  total?: number;
  /** Дальше есть строки, но их закрывает подписка. */
  locked?: boolean;
}

export const fetchRankPage = (
  kind: string,
  win: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) =>
  call<RankPage>(
    `/api/rank?kind=${encodeURIComponent(kind)}&win=${encodeURIComponent(win)}` +
      `&offset=${offset}&limit=${limit}`,
    { signal },
  );

/**
 * Право на забвение. Сервер удаляет те же таблицы, что команда /forgetme в
 * боте, и намеренно не возвращает свежую выгрузку: после удаления
 * возвращать нечего.
 */
export const forgetMe = () => call<MutationResult>("/api/forget", { method: "POST", body: {} });

/** Язык хранится в той же строке users, что читает бот: выбор общий. */
export const setLangRemote = (lang: string) =>
  call<MutationResult>("/api/lang", { method: "POST", body: { lang } });
