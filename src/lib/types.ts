/**
 * Формы ответов whale_api.py. Списаны с самого сервера, а не угаданы:
 * bootstrap() и loaders в whale_api.py — единственный источник правды.
 *
 * Поля, которые сервер отдаёт готовой русской строкой (`t`, `side`, `act`),
 * помечены как `ServerText`. Показывать их напрямую нельзя: приложение
 * говорит на шестнадцати языках. Их разбирает lib/labels.ts.
 */

/** Строка, собранная сервером по-русски. Только через lib/labels.ts. */
export type ServerText = string;

export type Venue = "spot" | "perp";
export type Side = "buy" | "sell";

export interface Position {
  sym: string;
  long: boolean;
  lev: number;
  size: number;
  entry: number;
  now: number;
  margin: number;
  liq: number;
  pnl: number;
  pct: number;
  funding: number;
  isolated: boolean;
}

export interface Equity {
  total: number;
  spot: number;
  perp: number;
  hip3: number;
  vaults: number;
}

export interface Wallet {
  id: string;
  name: string;
  addr: string;
  short: string;
  primary: boolean;
  score: number;
  bal: number;
  trades: number;
  win: number;
  pf: number;
  net: number;
  dd: number;
  spot: string;
  perp: string;
  d1: number;
  equity: Equity;
  pos: Position[];
}

export interface Me {
  plan: "free" | "premium";
  limit: number;
  threshold: number;
  alertsToday: number;
  alerts30d: number;
  premUntil: number;
}

export interface FlowCoin {
  sym: string;
  token?: string;
  addr?: string;
  net: number;
  buy: number;
  sell: number;
  w: number;
  top: number;
  c1: number;
  c6: number;
  c24: number;
  sp: number[];
}

export interface FlowWindow {
  net: number;
  coins: number;
  buy: number;
  sell: number;
  rows: FlowCoin[];
}

/** Ключи окна: часы. Сервер отдаёт "1" | "6" | "24" | "168" | "720". */
export type Flow = Record<string, FlowWindow | undefined>;

export interface Trader {
  a: string;
  pnl: number;
  roi: number;
  win: number;
  tr: number;
  dd: number;
  days: number;
  /** Средний срок удержания в секундах. */
  hold?: number | null;
  lev?: number | null;
  /** Сколько дней кошелёк держится в топе площадки. */
  top?: number | null;
}

export type RankKind = "pnl" | "roi" | "win" | "act";
export type RankTable = Record<RankKind, Trader[]>;
export interface Rank {
  spot: RankTable;
  perp: RankTable;
  /** Рейтинг по окнам: "30" | "90" | "180" | "365". */
  wins?: Record<string, { spot: RankTable; perp: RankTable } | undefined>;
}

export interface TradeRow {
  sym: string;
  v: number;
  side: ServerText;
  w: string;
  t: ServerText;
}
export interface Trades {
  spot: TradeRow[];
  perp: TradeRow[];
  liq: TradeRow[];
}

export interface FeedRow {
  t: ServerText;
  sym: string;
  w: string;
  act: ServerText;
  v: number;
  up: boolean;
}

export interface Funding {
  sym: string;
  rate: number;
  apr: number;
  oi: number;
  side: ServerText;
}

export interface RotLink {
  from: string;
  to: string;
  usd: number;
  w: number;
}
export type Rot = Record<string, RotLink[] | undefined>;

export interface Signal {
  sym: string;
  side: Side;
  conf: number;
  net: number;
  w: number;
  entry: number;
  lo: number;
  hi: number;
  stop: number;
  stopPct: number;
  t1: number;
  t2: number;
  risk: number;
  lev: number;
  /** Уже ключи, не текст: "flow" | "volume" | "top100" | ... */
  why: string[];
  winH: number;
  venue: Venue;
}

export interface HistItem {
  sym: string;
  long: boolean;
  ret: number;
  t: ServerText;
  win: boolean;
  venue: Venue;
}

export interface Sonar {
  need: number;
  ready: { spot: number; perp: number };
  trained: boolean;
  trainedSpot: boolean;
  trainedPerp: boolean;
  acc: number | null;
  accSpot: number | null;
  accPerp: number | null;
  list: Signal[];
  hist: {
    hit: number;
    of: number;
    won: number;
    tp: number;
    sl: number;
    missed: number;
    broken: number;
    avg: number;
    items: HistItem[];
  };
}

export interface CoinHolder {
  w: string;
  v: number;
  t: ServerText;
}

export interface Coin {
  price: number;
  chg: number;
  entry: number;
  hist: number[];
  hists: Record<string, number[] | undefined>;
  real: boolean;
  addr: string;
  /** Список кандидатов на логотип по убыванию доверия. */
  icon: string[] | string;
  spark: number[];
  c1: number;
  c6: number;
  c24: number;
  net: number;
  buy: number;
  sell: number;
  w: number;
  who: CoinHolder[];
}

export type Coins = Record<string, Coin | undefined>;

export interface AlertRow {
  t: ServerText;
  sym: string;
  name: string;
  side: string;
  notional: number;
}

export interface Bootstrap {
  ok: boolean;
  live: boolean;
  me?: Me;
  wallets?: Wallet[];
  feed?: FeedRow[];
  alerts?: AlertRow[];
  flow?: Flow;
  rank?: Rank;
  sonar?: Sonar;
  trades?: Trades;
  funding?: Funding[];
  rot?: Rot;
  coins?: Coins;
  marketFeed?: FeedRow[];
  /** Список кусков, которые сервер не успел собрать. */
  partial?: string[];
  cachedAt?: number;
  error?: string;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
  limit?: number;
}
