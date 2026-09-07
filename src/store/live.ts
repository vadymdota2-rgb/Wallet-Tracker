/**
 * Данные с сервера. Один источник — /api/bootstrap: в ответе и общее, и
 * личное. Прошлая версия слала два запроса (анонимный и подписанный) и
 * сливала ответы, отчего сбой авторизации выглядел как норма — экран
 * показывал публичные данные, будто всё в порядке.
 */
import { create } from "zustand";
import type {
  AlertRow, Bootstrap, Coins, FeedRow, Flow, Funding, Me, Rank, Rot, Sonar, Trades, Wallet,
} from "../lib/types";

export type Status = "boot" | "ready" | "stale" | "offline" | "anon";

const EMPTY_RANK: Rank = {
  spot: { pnl: [], roi: [], win: [], act: [] },
  perp: { pnl: [], roi: [], win: [], act: [] },
};

const EMPTY_SONAR: Sonar = {
  need: 400,
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
  rank: Rank;
  sonar: Sonar;
  trades: Trades;
  funding: Funding[];
  rot: Rot;
  coins: Coins;

  apply(data: Bootstrap): void;
  setStatus(s: Status): void;
  patchWallets(w: Wallet[]): void;
}

export const useLive = create<LiveState>((set) => ({
  status: "boot",
  syncedAt: 0,
  partial: [],

  me: EMPTY_ME,
  wallets: [],
  alerts: [],
  feed: [],
  marketFeed: [],
  flow: {},
  rank: EMPTY_RANK,
  sonar: EMPTY_SONAR,
  trades: { spot: [], perp: [], liq: [] },
  funding: [],
  rot: {},
  coins: {},

  apply: (d) =>
    set((prev) => ({
      status: d.me ? "ready" : "anon",
      syncedAt: Date.now(),
      partial: Array.isArray(d.partial) ? d.partial : [],
      me: d.me ? { ...EMPTY_ME, ...d.me } : prev.me,
      wallets: Array.isArray(d.wallets) ? d.wallets : prev.wallets,
      alerts: Array.isArray(d.alerts) ? d.alerts : prev.alerts,
      feed: Array.isArray(d.feed) ? d.feed : prev.feed,
      marketFeed: Array.isArray(d.marketFeed) ? d.marketFeed : prev.marketFeed,
      flow: d.flow ?? prev.flow,
      rank: d.rank ?? prev.rank,
      sonar: d.sonar ?? prev.sonar,
      trades: d.trades ?? prev.trades,
      funding: Array.isArray(d.funding) ? d.funding : prev.funding,
      rot: d.rot ?? prev.rot,
      // Котировки объёмные: пустой словарь прежние не затирает.
      coins: d.coins && Object.keys(d.coins).length ? d.coins : prev.coins,
    })),

  setStatus: (status) => set({ status }),
  patchWallets: (wallets) => set({ wallets }),
}));

/** Кошелёк по адресу — экраны открываются по нему, а не по индексу. */
export function walletByAddr(list: Wallet[], addr: string | undefined): Wallet | undefined {
  if (!addr) return undefined;
  const key = addr.toLowerCase();
  return list.find((w) => w.addr.toLowerCase() === key);
}
