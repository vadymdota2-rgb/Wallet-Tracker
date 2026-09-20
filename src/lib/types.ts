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
  /** Торгует ли кошелёк на Hyperliquid — по базе сделок, без похода в сеть. */
  hlActive?: boolean;
  /** Покупки на BSC, ещё не проданные. Приходят вместе с позициями.
   *  Не `spot` — так уже названо место кошелька в спотовом рейтинге. */
  holds?: SpotHold[];
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
  /** Кандидаты логотипа. */
  icon?: string[];
  /** Хвост адреса — дописывается, когда тикер в списке не один. */
  tag?: string;
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
  /** Сколько монет окна в притоке и сколько в оттоке. */
  up: number;
  dn: number;
  /** Накопленный поток по всему рынку за окно — линия тренда. */
  tr: number[];
  rows: FlowCoin[];
}

/** Какие монеты показывать: все, только приток или только отток. */
export type FlowSide = "all" | "in" | "out";

/**
 * Строка поиска по потоку. Те же поля, что у FlowCoin, но без показателей,
 * которые считаются только для выгрузки.
 */
export type FlowRow = Omit<FlowCoin, "top" | "c1" | "c6" | "c24">;

/** Ключи окна: часы. Сервер отдаёт "1" | "6" | "24" | "168" | "720". */
export type Flow = Record<string, FlowWindow | undefined>;

/** Монета в разделе «Лонг / Шорт»: сколько денег зашло в каждую сторону. */
/** Крипта или «не крипта» — акции и золото с рынков HIP-3. */
export type CoinClass = "crypto" | "rwa";

export interface LsRow {
  sym: string;
  cls?: CoinClass;
  /** Кандидаты логотипа от сервера — по полному имени инструмента. */
  icon?: string[];
  /** Имя инструмента так, как его пишет биржа: «xyz:SP500». Копируется. */
  full?: string;
  long: number;
  short: number;
  net: number;
  /** Доля денег в лонге, в процентах. */
  pct: number;
  w: number;
}

export interface LsTotals {
  long: number;
  short: number;
  net: number;
  pct: number;
  coins: number;
  rows: LsRow[];
}

/** Итог по окну целиком плюс отдельно по каждому классу инструментов. */
export interface LsWindow extends LsTotals {
  crypto?: LsTotals;
  rwa?: LsTotals;
}

export type Ls = Record<string, LsWindow | undefined>;

/** Покупка на BSC, ещё не проданная полностью. */
export interface SpotHold {
  token: string;
  sym: string;
  /** Кандидаты логотипа от сервера — по адресу токена, а не по тикеру. */
  icon?: string[];
  /** Сколько вложено в то, что осталось на руках. */
  cost: number;
  value: number;
  pnl: number;
  pct: number;
  entry: number;
  price: number;
  buys: number;
  /** Продано больше, чем мы видели купленным: часть истории до наблюдения. */
  partial?: boolean;
  /** Секунды эпохи: первая покупка того, что ещё держит. */
  since: number;
}

/** Ответ /api/token: почасовые цены токена, пары [секунды, цена]. */
export interface TokenHist {
  ok: boolean;
  addr?: string;
  hist?: [number, number][];
}

/** Ответ /api/wallet: позиции и остаток одного кошелька. */
export interface WalletLive {
  ok: boolean;
  addr?: string;
  pos?: Position[];
  holds?: SpotHold[];
  equity?: Equity;
  bal?: number;
  d1?: number;
  error?: string;
}

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

/** Одна завершённая сделка из истории кошелька. */
export interface Deal {
  /** Тикер монеты. */
  sym: string;
  /** Кандидаты логотипа, по убыванию доверия. */
  icon?: string[];
  /** Объём закрытия в долларах. */
  v: number;
  /** Цена входа. Нет знаков после запятой у токена — нет и цены. */
  buy?: number | null;
  /** Цена выхода. */
  sell?: number | null;
  /** Результат в долларах. */
  pnl: number;
  /** Фьючерсы: доходность от маржи. У спота знаменатель недостоверен. */
  roi?: number | null;
  /** Фьючерсы: закрывали лонг. `null` — переворот, сторона неизвестна. */
  long?: boolean | null;
  /** Фьючерсы: позицию вынесло по ликвидации. */
  liq?: boolean;
  lev?: number | null;
  /** Секунды. */
  ts: number;
}
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
  /** Покупка или продажа — у спота. Слово из `side` переводится, а флаг нет. */
  buy?: boolean;
  /** Полный адрес кошелька: по сокращённому `w` подписаться нельзя. */
  wa?: string;
  /** Крипта или акции с металлами — считает сервер, у него карта площадок. */
  cls?: CoinClass;
  /** Лонг или шорт — у позиций. Подпись переводится, флаг нет. */
  long?: boolean;
  /** Кандидаты логотипа от сервера: он знает полное имя инструмента. */
  icon?: string[];
  w: string;
  t: ServerText;
}
export interface Trades {
  spot: TradeRow[];
  perp: TradeRow[];

}

export interface FeedRow {
  t: ServerText;
  sym: string;
  w: string;
  act: ServerText;
  v: number;
  up: boolean;
}

/** Строка фандинга: монета на конкретной бирже. */
export interface FundRow {
  sym: string;
  /** Биржа: hl, bingx, binance, gate. */
  ex: string;
  /** Ставка за одну выплату, в процентах. */
  rate: number;
  /** Она же в сутки — единственное, чем биржи можно сравнивать. */
  day?: number;
  /** Годовые из ответов прошлой версии сервера: из них суточные выводятся. */
  apr?: number;
  /** Выплат в сутки: у Hyperliquid 24, у остальных обычно 3. */
  per: number;
  /** Открытый интерес в долларах, если биржа его отдаёт. */
  oi: number;
  /** Суточный оборот в долларах, если биржа отдаёт его вместо интереса. */
  vol: number;
  /** Когда биржа спишет следующую выплату, в секундах эпохи. */
  next?: number;
}

/** Первые страницы досок фандинга по биржам. */
export type Fund = Record<string, FundRow[] | undefined>;
/** Сколько перекосов на каждой бирже всего — по ним считаются страницы. */
export type FundN = Record<string, number | undefined>;

/** Монета в столбце «откуда» или «куда»: сколько из неё вышло или в неё зашло. */
export interface RotSide {
  sym: string;
  usd: number;
}

/**
 * Ротация за окно. Суммы считает сервер по всем парам «продал одно — купил
 * другое», а не по тем монетам, что доехали: в выгрузке лежат верхние
 * шестьдесят, и сложить по ним итог значило бы назвать частью целое.
 */
export interface RotSum {
  /** Сколько всего переложено из монеты в монету. */
  usd: number;
  /** Сколько всего переходов монета → монета. */
  pairs: number;
  /** Сколько кошельков так делали. */
  w: number;
  /** Из каких монет деньги уходили. */
  src: RotSide[];
  /** В какие приходили. */
  dst: RotSide[];
  /**
   * Сколько монет в столбце. Это же число — подпись в заголовке и число
   * страниц: сколько написано, столько и листается.
   */
  msrc?: number;
  mdst?: number;
}
export type RotSums = Record<string, RotSum | undefined>;

export interface Signal {
  sym: string;
  side: Side;
  /** Вероятность модели в процентах, а не выдумка по величине потока. */
  conf: number;
  /** true — считала модель, false — осталась формула: на экране это разные слова. */
  model: boolean;
  net: number;
  w: number;
  entry: number;
  stop: number;
  stopPct: number;
  t1: number;
  t2: number;
  lev: number;
  /** Доля депозита под риском, в процентах: решение модели, не настройка. */
  share: number;
  /** Горизонт, который модель выбрала для этого сигнала, в секундах. */
  h: number;
  /** Адрес контракта у спота: по нему достаётся история цены. У перпа здесь
   *  имя монеты, и адресом оно не является. */
  addr?: string;
  /** Вклад признаков в эту оценку: имя и сдвиг вероятности в процентных
   *  пунктах, знаком в сторону сигнала. */
  why: { k: string; v: number }[];
  venue: Venue;
}

export interface HistItem {
  /** 1 — дошло до цели, −1 — стоп, 0 — за сутки ни то ни другое. */
  outcome?: number;
  sym: string;
  long: boolean;
  ret: number;
  t: ServerText;
  win: boolean;
  venue: Venue;
}

/** Обученная модель: то, что показывает экран состояния. */
export interface CortexModel {
  at: number;
  samples: number;
  test: number;
  trees: number;
  auc: number;
  logloss: number;
  /** Потери постоянного прогноза: без них logloss ни о чём не говорит. */
  base: number;
  acc: number;
  brier: number;
  /** Средний AUC скользящей проверки — устойчивость, а не разовая удача. */
  wf: number;
  /** Доля роста в тесте: с ней видно, что «точность 60%» может быть угадыванием. */
  up: number;
  /** Признаки, на которые модель опирается чаще прочих, и их доля в процентах. */
  top: { k: string; v: number }[];
  /** Стоп и цели назвала модель, а не формула от волатильности. */
  levels?: boolean;
  /** Горизонт этой модели в секундах. */
  h?: number;
}

export interface CortexTry {
  at: number;
  samples: number;
  auc: number;
  logloss: number;
  base: number;
  wf: number;
  ok: boolean;
  /** Горизонт этой попытки в секундах. */
  h?: number;
}

/**
 * Один горизонт одной площадки: модель, последняя попытка и сколько исходов
 * на него набралось.
 *
 * Моделей у площадки две — шестичасовая и суточная, — и живут они врозь.
 * Пока экран показывал одну карточку на площадку, принятая шестичасовая
 * закрывала собой проваленную суточную: человек читал «модель принята», не
 * зная, что половина сигналов всё равно считается формулой.
 */
export interface CortexHz {
  /** Горизонт в секундах: 21600 или 86400. */
  h: number;
  /** Размеченных исходов на этом горизонте. Порог свой: 1% против 2%. */
  ready: number;
  model: CortexModel | null;
  try: CortexTry | null;
}

export interface Cortex {
  need: number;
  ready: { spot: number; perp: number };
  trained: boolean;
  trainedSpot: boolean;
  trainedPerp: boolean;
  acc: number | null;
  accSpot: number | null;
  accPerp: number | null;
  model?: { spot: CortexModel | null; perp: CortexModel | null };
  /** Последняя попытка обучения — принятая или нет. */
  try?: { spot: CortexTry | null; perp: CortexTry | null };
  /** Разбор по горизонтам — для экрана состояния. */
  hz?: { spot: CortexHz[]; perp: CortexHz[] };
  /** Когда бот в последний раз считал сигналы. null — не считал ни разу. */
  at?: number | null;
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
  /** Сигналов в работе: горизонт ещё не прошёл, итога пока нет. */
  open?: number;
  /** Секунд до закрытия ближайшего из них. */
  next?: number;
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

/** Чем и почём продаётся подписка — числа приходят с сервера. */
export interface PayInfo {
  stars: number;
  usdt: number;
  /** Настроен ли кошелёк: без него кнопку USDT показывать нечестно. */
  ton: boolean;
  days: number;
}

export interface Bootstrap {
  ok: boolean;
  live: boolean;
  me?: Me;
  wallets?: Wallet[];
  feed?: FeedRow[];
  alerts?: AlertRow[];
  flow?: Flow;
  ls?: Ls;
  rank?: Rank;
  cortex?: Cortex;
  /** Прежнее имя того же поля. Приложение обновляется само, а whale_api на
   *  машине перезапускают руками: пока этого не сделали, свежая сборка
   *  читает старый ключ и вкладка не пустеет. Убрать после перезапуска. */
  sonar?: Cortex;
  trades?: Trades;
  fund?: Fund;
  fundN?: FundN;
  rotSum?: RotSums;
  coins?: Coins;
  marketFeed?: FeedRow[];
  pay?: PayInfo;
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
