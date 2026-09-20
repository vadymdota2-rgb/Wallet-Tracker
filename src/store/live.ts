/**
 * Данные с сервера. Один источник — /api/bootstrap: в ответе и общее, и
 * личное. Прошлая версия слала два запроса (анонимный и подписанный) и
 * сливала ответы, отчего сбой авторизации выглядел как норма — экран
 * показывал публичные данные, будто всё в порядке.
 */
import { create } from "zustand";
import type {
  AlertRow, Bootstrap, Coins, FeedRow, Flow, Fund, FundN, Ls, Me, Rank, RotSums, Cortex, Trades,
  Wallet, PayInfo,
} from "../lib/types";
import { tgUserId } from "../lib/telegram";

export type Status = "boot" | "ready" | "stale" | "offline" | "anon";

const EMPTY_RANK: Rank = {
  spot: { pnl: [], roi: [], win: [], act: [] },
  perp: { pnl: [], roi: [], win: [], act: [] },
};

const EMPTY_CORTEX: Cortex = {
  /* Столько исходов нужно для приёмки — то же число, что отдаёт API и что
     стоит в ORACLE_MIN_ACCEPT у бота. Здесь оно однажды отстало на четырёх
     сотнях и показывало полную полосу под необученной моделью до первого
     ответа сервера. */
  need: 1200,
  ready: { spot: 0, perp: 0 },
  trained: false,
  trainedSpot: false,
  trainedPerp: false,
  acc: null,
  accSpot: null,
  accPerp: null,
  list: [],
  hist: { hit: 0, of: 0, won: 0, tp: 0, sl: 0, missed: 0, broken: 0, avg: 0, items: [] },
};

/**
 * Блок Cortex из ответа — или ничего, если сервер его не собрал.
 *
 * Отличаем «не пришёл» от «пришёл пустым»: пустой — это законное состояние
 * (бот посчитал, ничего не прошло отбор), и показывать вместо него прошлый
 * ответ значит врать. Признак настоящего блока — поле need: оно есть всегда,
 * даже когда нет ни сигналов, ни модели.
 */
function cortexOf(c: unknown): Cortex | null {
  if (!c || typeof c !== "object") return null;
  return typeof (c as Cortex).need === "number" ? (c as Cortex) : null;
}

const EMPTY_ME: Me = {
  plan: "free",
  limit: 1,
  threshold: 10000,
  alertsToday: 0,
  alerts30d: 0,
  premUntil: 0,
};

interface LiveState {
  status: Status;
  syncedAt: number;
  /** Куски, которые сервер не успел собрать. Показываем честно. */
  partial: string[];

  me: Me;
  wallets: Wallet[];
  alerts: AlertRow[];
  feed: FeedRow[];
  marketFeed: FeedRow[];
  flow: Flow;
  ls: Ls;
  rank: Rank;
  cortex: Cortex;
  trades: Trades;
  fund: Fund;
  fundN: FundN;
  rotSum: RotSums;
  coins: Coins;
  /** Цены подписки и доступные способы оплаты — приходят с сервера. */
  pay: PayInfo;

  apply(data: Bootstrap): void;
  /** Позиции и остаток одного кошелька, пришедшие отдельным запросом. */
  patchWallet(addr: string, live: Partial<Wallet>): void;
  setStatus(s: Status): void;
  patchWallets(w: Wallet[]): void;
  patchMe(p: Partial<Me>): void;
}

/**
 * Снимок последней выдачи в localStorage.
 *
 * Без него каждый вход начинался с пустого экрана и ждал сервер. Теперь
 * прошлые данные рисуются сразу, а свежие подменяют их через секунду-две.
 * Снимок помечен номером пользователя: на общем телефоне чужой не подойдёт.
 */
const SNAP = "wt-snapshot-v1";
/* Пока сервер не ответил, показываем цены прошлого запуска, а их нет —
   значит и кнопок оплаты нет: выдумывать ценник нельзя. */
const EMPTY_PAY: PayInfo = { stars: 0, usdt: 0, ton: false, days: 30 };

const SNAP_TTL = 24 * 3600_000;

type Snapshot = Pick<
  LiveState,
  "syncedAt" | "me" | "wallets" | "alerts" | "feed" | "marketFeed" | "flow" | "ls"
  | "rank" | "cortex" | "trades" | "fund" | "fundN" | "rotSum" | "coins" | "pay"
> & { uid: string };

function readSnap(): Snapshot | null {
  try {
    const raw = localStorage.getItem(SNAP);
    if (!raw) return null;
    const d = JSON.parse(raw) as Snapshot;
    if (!d || typeof d !== "object") return null;
    if (d.uid !== tgUserId()) return null;
    if (!(d.syncedAt > 0) || Date.now() - d.syncedAt > SNAP_TTL) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Стереть снимок с устройства.
 *
 * Данные на сервере удалены, а в localStorage лежит копия: кошельки, порог,
 * рейтинги. Экран говорит «всё удалено» — значит и на телефоне не должно
 * остаться ничего, иначе при следующем входе снимок нарисует кошельки,
 * которых больше нет.
 */
export function dropSnapshot(): void {
  try {
    localStorage.removeItem(SNAP);
  } catch {
    // Хранилище закрыто — стирать нечего.
  }
}

function writeSnap(s: LiveState): void {
  try {
    const snap: Snapshot = {
      uid: tgUserId(),
      syncedAt: s.syncedAt,
      me: s.me, wallets: s.wallets, alerts: s.alerts, feed: s.feed,
      marketFeed: s.marketFeed, flow: s.flow, ls: s.ls, rank: s.rank, cortex: s.cortex,
      trades: s.trades, fund: s.fund, fundN: s.fundN, rotSum: s.rotSum, coins: s.coins,
      pay: s.pay,
    };
    localStorage.setItem(SNAP, JSON.stringify(snap));
  } catch {
    // Переполнилось или хранилище закрыто — снимок не обязателен.
  }
}

/** Общие куски приходят из кэша сервера: пустой — значит ещё не собран, а
 *  не «данных нет». Затирать ими прошлые нельзя, иначе экран, который уже
 *  всё показал, вдруг пустеет. Личные куски наоборот: пустой список
 *  кошельков — это правда, что кошельков нет. */
const some = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : Boolean(v) && Object.keys(v as object).length > 0;

const boards = (r: Rank | undefined): boolean =>
  Boolean(r) && (["spot", "perp"] as const).some((v) =>
    (["pnl", "roi", "win", "act"] as const).some((k) => (r as Rank)[v]?.[k]?.length));

/** Перенести живые куски (позиции, остаток) со старого списка на новый. */
function keepLive(next: Wallet[], prev: Wallet[]): Wallet[] {
  if (!prev.length) return next;
  const was = new Map(prev.map((w) => [w.addr.toLowerCase(), w]));
  return next.map((w) => {
    const old = was.get(w.addr.toLowerCase());
    if (!old || (!old.pos.length && !old.holds?.length && !(old.equity?.total ?? 0))) return w;
    return {
      ...w,
      pos: old.pos,
      holds: old.holds,
      equity: old.equity,
      bal: old.bal || w.bal,
      d1: old.d1 ?? w.d1,
    };
  });
}

const snap = readSnap();

export const useLive = create<LiveState>((set, get) => ({
  status: snap ? "stale" : "boot",
  syncedAt: snap?.syncedAt ?? 0,
  partial: [],

  me: snap?.me ?? EMPTY_ME,
  wallets: snap?.wallets ?? [],
  alerts: snap?.alerts ?? [],
  feed: snap?.feed ?? [],
  marketFeed: snap?.marketFeed ?? [],
  flow: snap?.flow ?? {},
  ls: snap?.ls ?? {},
  rank: snap?.rank ?? EMPTY_RANK,
  cortex: snap?.cortex ?? EMPTY_CORTEX,
  trades: snap?.trades ?? { spot: [], perp: [] },
  fund: snap?.fund ?? {},
  fundN: snap?.fundN ?? {},
  rotSum: snap?.rotSum ?? {},
  coins: snap?.coins ?? {},
  pay: snap?.pay ?? EMPTY_PAY,

  apply: (d) => {
    set((prev) => ({
      status: d.me ? "ready" : "anon",
      syncedAt: Date.now(),
      partial: Array.isArray(d.partial) ? d.partial : [],
      // Личное — как пришло: ноль кошельков это ноль кошельков.
      me: d.me ? { ...EMPTY_ME, ...d.me } : prev.me,
      // Позиции и остаток приходят отдельным запросом по одному кошельку;
      // общий опрос их не знает и не должен обнулять уже показанное.
      wallets: Array.isArray(d.wallets) ? keepLive(d.wallets, prev.wallets) : prev.wallets,
      alerts: Array.isArray(d.alerts) ? d.alerts : prev.alerts,
      feed: Array.isArray(d.feed) ? d.feed : prev.feed,
      // Общее — только если сервер успел его собрать.
      marketFeed: some(d.marketFeed) ? d.marketFeed! : prev.marketFeed,
      flow: some(d.flow) ? d.flow! : prev.flow,
      ls: some(d.ls) ? d.ls! : prev.ls,
      rank: boards(d.rank) ? d.rank! : prev.rank,
      /* `sonar` — прежнее имя поля, см. Bootstrap в types.ts.

         Берём всё, что пришло целым блоком. Прежде условие было «есть
         сигналы или обучена модель», и в тихий час без сигналов и без
         принятой модели — то есть ровно тогда, когда человек смотрит на
         экран состояния, — блок отбрасывался целиком. Вместе с ним
         замирали счётчик исходов, время последнего расчёта, попытки
         обучения и история: приложение показывало вчерашнее состояние и
         ничем это не выдавало. */
      cortex: cortexOf(d.cortex ?? d.sonar) ?? prev.cortex,
      trades: some(d.trades?.spot) || some(d.trades?.perp) ? d.trades! : prev.trades,
      fund: some(d.fund) ? d.fund! : prev.fund,
      fundN: some(d.fundN) ? d.fundN! : prev.fundN,
      rotSum: some(d.rotSum) ? d.rotSum! : prev.rotSum,
      coins: some(d.coins) ? d.coins! : prev.coins,
      pay: d.pay ?? prev.pay,
    }));
    writeSnap(get());
  },

  patchWallet: (addr, live) => {
    const key = addr.toLowerCase();
    set((prev) => ({
      wallets: prev.wallets.map((w) => (w.addr.toLowerCase() === key ? { ...w, ...live } : w)),
    }));
    writeSnap(get());
  },

  setStatus: (status) => set({ status }),
  patchWallets: (wallets) => set({ wallets }),
  // Правка своей же настройки без похода на сервер: экран отвечает сразу,
  // а не через полную выгрузку в четверть мегабайта.
  patchMe: (p) => set((prev) => ({ me: { ...prev.me, ...p } })),
}));

/** Кошелёк по адресу — экраны открываются по нему, а не по индексу. */
export function walletByAddr(list: Wallet[], addr: string | undefined): Wallet | undefined {
  if (!addr) return undefined;
  const key = addr.toLowerCase();
  return list.find((w) => w.addr.toLowerCase() === key);
}
