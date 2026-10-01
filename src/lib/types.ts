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
  /** Сервисный аккаунт бота: подписка навсегда, лимита кошельков нет. */
  service?: boolean;
  /** Алерты приходят и в Telegram (true) или только в приложение (false). */
  alertTg?: boolean;
  /** Алертов с последнего открытия истории. */
  unread?: number;
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

export interface CoinHolder {
  w: string;
  v: number;
  t: ServerText;
}

export interface Coin {
  price: number;
  /* Изменения цены: null — «неизвестно», а не «ноль процентов». Истории у
     монеты может не быть вовсе — биржа не ответила, монета только
     появилась, — и ноль на экране читался бы как «цена не двигалась».
     Рядом с графиком, где за сутки восемь процентов, это видно сразу. */
  chg: number | null;
  entry: number;
  hist: number[];
  hists: Record<string, number[] | undefined>;
  real: boolean;
  addr: string;
  /** Список кандидатов на логотип по убыванию доверия. */
  icon: string[] | string;
  spark: number[];
  c1: number | null;
  c6: number | null;
  c24: number | null;
  net: number;
  buy: number;
  sell: number;
  w: number;
  who: CoinHolder[];
}

export type Coins = Record<string, Coin | undefined>;

/** Монета из справочника для поиска на графике. */
export interface SymbolRow {
  /** Тикер, как его ищут: BTC, DOT, NVDA. */
  s: string;
  /** Где торгуется: binance, bybit, hl. */
  v: string[];
  /** Что открывать, если не тикер: xyz:NVDA для акций HIP-3. */
  t?: string;
  /** rwa — акции, индексы, металлы. */
  c?: string;
}

export interface AlertRow {
  t: ServerText;
  sym: string;
  name: string;
  side: string;
  notional: number;
  /** Номер доставки — ключ строки. */
  id?: number;
  /** Когда пришёл, мс. */
  ts?: number;
  /** Текст алерта как в чате, без разметки. */
  text?: string;
  /** Уходил ли в Telegram: false — «только в приложении». */
  tg?: boolean;
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
  trades?: Trades;
  fund?: Fund;
  fundN?: FundN;
  rotSum?: RotSums;
  coins?: Coins;
  marketFeed?: FeedRow[];
  pay?: PayInfo;
  /** Список кусков, которые сервер не успел собрать. */
  partial?: string[];
  /** Первое открытие приложения — неделя премиума в подарок. */
  gift?: { days: number };
  cachedAt?: number;
  error?: string;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
  limit?: number;
}

/** Кому выходят монеты разлока. */
export type UnlockWho = "team" | "investors" | "treasury" | "community" | "foundation" | "mixed" | "emission";

/** Один день разлока монеты: все выдачи этого дня вместе. */
export interface UnlockEvent {
  sym: string;
  name: string;
  /** Полночь UTC дня разлока, в секундах. */
  ts: number;
  tokens: number;
  /** cliff — разовая крупная выдача, monthly — очередная из помесячных. */
  kind: "cliff" | "monthly";
  who: Partial<Record<UnlockWho, number>>;
  /** Документация проекта с условиями вестинга. */
  src: string;
  /** Объём — оценка по открытым сводкам, а не условие из документов. */
  est?: boolean;
  /** Монеты в обороте накануне разлока, по расчёту сервера. */
  circ?: number | null;
  price: number | null;
  usd: number | null;
  /** Доля от монет в обороте, %. */
  pct: number | null;
  mcap: number | null;
}

/** Почему монеты нет в календаре: done — выдавать нечего, burn — сжигание
 *  перекрывает выпуск, undated — выдачи без дат, nodata — надёжного графика нет,
 *  pegged — стейблкоин или токенизированный актив, выпуск под спрос. */
export type UnlockSkip = "done" | "burn" | "undated" | "nodata" | "pegged";
/** Почему у монеты календаря нет эмиссии: fixed — выпуск создан сразу,
 *  notyet — предусмотрена, но не запущена. */
export type UnlockNoEmit = "fixed" | "notyet";

/** Ответ /api/unlocks целиком. */
export interface UnlocksReply {
  ok?: boolean;
  items?: UnlockEvent[];
  none?: Record<string, UnlockSkip>;
  noEmit?: Record<string, UnlockNoEmit>;
  /** В стейкинге: монет, % оборота, дата снимка; null — стейкинга у монеты
   *  нет. Монеты нет в словаре — данных нет. */
  stake?: Record<string, UnlockStake | null>;
  /** Выпуск монеты: t — всего создано (0 — нет долей без графика),
   *  m — потолок (0 — нет или неизвестен). */
  supply?: Record<string, { t: number; m: number }>;
  /** Суточный объём спотовых торгов по всем биржам, $. */
  vol?: Record<string, number>;
  /** Прошлые разлоки: n — сколько, med — медиана изменения цены за неделю, %,
   *  down — сколько раз падала, btc — медиана против BTC, %. */
  react?: Record<string, { n: number; med: number; down: number; btc: number | null }>;
  /** Эмиссия по факту сети: d — дней измерения, r — прирост в месяц
   *  (отрицательный — сжигание больше выпуска). */
  measured?: Record<string, { d: number; r: number }>;
}

export interface UnlockStake {
  n: number;
  p: number | null;
  at: string;
  /** От чего доля: оборота или всего выпуска. */
  of?: "circ" | "supply";
  /** Доходность стейкинга, % в год; нет поля — неизвестна. */
  y?: number;
}

/* --- Дайджест ------------------------------------------------------------ */

/** Строка раздела дайджеста: монета и числа того раздела, откуда она. */
export interface DigestCoin {
  sym: string;
  icon?: string[];
  /** Поток или перевес денег, $ — у NetFlow и лонг/шорта. */
  net?: number;
  /** Кошельков в потоке. */
  w?: number;
  addr?: string;
  /** Размер сделки или позиции, $. */
  v?: number;
  buy?: boolean;
  long?: boolean;
  /** Кошелёк сделки. */
  wa?: string;
  cls?: CoinClass;
  /** Доля денег в лонге, %. */
  pct?: number;
}

export interface DigestLs {
  long: DigestCoin[];
  short: DigestCoin[];
}

export interface DigestFund {
  sym: string;
  ex: string;
  /** Ставка в сутки, %. */
  day: number;
}

export interface DigestUnlock {
  sym: string;
  name: string;
  ts: number;
  tokens: number;
  usd: number | null;
  pct: number | null;
  kind: "cliff" | "monthly";
}

/** Раздел про фьючерсы без подписки: сервер отдаёт только отметку. */
export interface DigestLocked {
  locked: true;
}

export interface DigestItem {
  id: number;
  /** Дата выпуска по UTC, YYYY-MM-DD. */
  day: string;
  at: number;
  /** Окно выпуска: сутки до `to`, в секундах. */
  from: number;
  to: number;
  flow?: { net?: number; buy?: number; sell?: number; up?: number; dn?: number; in: DigestCoin[]; out: DigestCoin[] };
  spot?: DigestCoin[];
  rot?: { usd?: number; pairs?: number; w?: number; src: RotSide[]; dst: RotSide[] };
  /** Выпуски до разделения — один список; новые — крипта и акции с металлами. */
  ls?: DigestLs | { crypto: DigestLs; rwa: DigestLs } | DigestLocked;
  perp?: DigestCoin[] | { crypto: DigestCoin[]; rwa: DigestCoin[] } | DigestLocked;
  fund?: { hi: DigestFund[]; lo: DigestFund[] } | DigestLocked;
  unl?: DigestUnlock[];
  likes: number;
  comments: number;
  /** Сколько человек раскрывали выпуск — каждый считается один раз. */
  views?: number;
  liked: boolean;
}

export interface DigestReply {
  ok: boolean;
  items: DigestItem[];
  /** Автору закрыты комментарии. */
  muted?: boolean;
  /** Владелец бота: удаляет любые комментарии. */
  mod?: boolean;
  error?: string;
}

export interface DigestComment {
  id: number;
  /** Пусто у анонимного: имя не уходит с сервера. */
  name: string;
  anon?: boolean;
  text: string;
  at: number;
  mine: boolean;
}

export interface DigestCommentsReply {
  ok: boolean;
  items: DigestComment[];
  more: boolean;
}

/** Ответ на лайк, комментарий или удаление: отказ приходит с причиной. */
export interface DigestActReply {
  ok: boolean;
  error?: "empty" | "too_long" | "links" | "too_fast" | "day_limit" | "muted" | "not_found" | "forbidden" | "no_user" | "db";
  liked?: boolean;
  likes?: number;
  views?: number;
  item?: DigestComment;
  wait?: number;
  max?: number;
}

/** Перевод комментария: same — он уже на языке читателя. */
export interface DigestTranslation {
  ok: boolean;
  text?: string;
  src?: string;
  same?: boolean;
  error?: string;
}

/* --- Карта ликвидаций ---------------------------------------------------- */

/** Уровень карты: цена середины корзины и оценка ликвидаций по плечам, $. */
export interface LiqBucket {
  p: number;
  /** Лонги — по плечам в порядке LiqMapReply.levs. */
  L: number[];
  S: number[];
}

export interface LiqMapReply {
  ok: boolean;
  error?: string;
  sym: string;
  range: string;
  /** Цена сейчас — закрытие последней свечи. */
  px: number;
  step: number;
  lo: number;
  /** Биржи, что ответили: модель складывает их. */
  ex: string[];
  levs: number[];
  buckets: LiqBucket[];
  /** Накоплено от цены до ±2 / ±5 / ±10 %. */
  cum: Record<string, { L: number; S: number }>;
  /** Путь цены за окно (≤60 точек), последняя — цена сейчас. */
  path?: number[];
  /** Открытый интерес всех ответивших бирж, $. */
  oi?: number;
  /** Свечи окна для графика цены на карте: [откр, макс, мин, закр]. */
  ohlc?: [number, number, number, number][];
  at: number;
}

/** Индекс страха и жадности: дни [начало суток UTC, индекс 0–100, закрытие BTC]. */
export interface FngReply {
  ok: boolean;
  error?: string;
  days: [number, number, number][];
  at: number;
}

/** Индекс альтсезона на день: [значение 0–100, начало суток UTC]. */
export type AltPoint = [number, number];

/**
 * Доминация и альтсезон. Дни идут подряд от t0: [капитализация рынка $ млн,
 * доля BTC %, доля ETH %, стейблкоины $ млн, ETH/BTC (0 — ещё нет)].
 */
export interface DomReply {
  ok: boolean;
  error?: string;
  t0: number;
  rows: [number, number, number, number, number][];
  alt: {
    /** [начало суток UTC, индекс] с марта 2024. */
    pts?: [number, number][];
    now?: AltPoint | null;
    d1?: AltPoint | null;
    d7?: AltPoint | null;
    d30?: AltPoint | null;
    hi?: AltPoint | null;
    lo?: AltPoint | null;
    /** 100 крупнейших монет без стейблкоинов: [тикер, имя, рост за 90 дней %]. */
    top?: [string, string, number][];
  };
  at: number;
}

/**
 * Спотовые ETF одной монеты. Дни — торговые, по возрастанию: [начало суток
 * UTC, поток всех фондов $ тыс., поток в монетах, закрытие цены, потоки
 * фондов $ тыс. в порядке funds (null — фонд в тот день не отчитался)].
 */
export interface EtfCoin {
  funds: { t: string; n: string; aum: number; vol: number; prem: number | null; fee: number | null; cum: number; cumc: number }[];
  days: [number, number, number, number, (number | null)[]][];
  share: number | null;
  shareHist: [number, number][];
  best: [number, number] | null;
  worst: [number, number] | null;
}

/** Держатель биткоина: [имя, тип, подтип, флаг, тикер, BTC, изменение за 7 дней, цена входа $]. */
export type BtcHolder = [string, string, string, string, string, number, number, number];

export interface EtfReply {
  ok: boolean;
  error?: string;
  coins: Record<string, EtfCoin>;
  holders: {
    /** [тип, сколько держателей, BTC, изменение за 7 дней]. */
    groups?: [string, number, number, number][];
    top?: BtcHolder[];
    movers?: BtcHolder[];
    /** Компании с эфиром: [имя, тип, ETH]. */
    eth?: [string, string, number][];
    /** Казначейства в других монетах: eth, sol, bnb, xrp → [имя, тип, монет]. */
    alts?: Record<string, [string, string, number][]>;
  };
  /**
   * Позиции на CME по отчёту CFTC, в монетах, по неделям: [дата, открытый
   * интерес, управляющие лонг, шорт, хедж-фонды лонг, шорт, дилеры лонг,
   * шорт, мелкие лонг, шорт].
   */
  cme?: Record<string, number[][]>;
  /** Премия Coinbase к Binance, %: по дням и сейчас. */
  cbp?: Record<string, { days: [number, number][]; now: number | null }>;
  at: number;
}

/** Высота последнего блока биткоина, блок следующего халвинга и среднее время блока, с. */
export interface HalvingReply {
  ok: boolean;
  error?: string;
  height: number;
  next: number;
  every: number;
  avg: number;
  at: number;
}

/** Монета, по которой строится карта ликвидаций. */
export interface LiqCoin {
  s: string;
  /** Оборот фьючерсов за сутки, $. */
  v: number;
  ex: string[];
}

export interface LiqCoinsReply {
  ok: boolean;
  coins: LiqCoin[];
  at: number;
}

/* ── Bitcoin: биржевые потоки, крупные выводы, рейтинг ─────────────────── */

/** Поток BTC через биржи за окно. «Покупка» — вывод с биржи, «продажа» — завод. */
export interface BtcFlowWin {
  /** Заведено на биржи, BTC. */
  in: number;
  /** Выведено с бирж, BTC. */
  out: number;
  /** Чистый вывод: out − in. Плюс — монеты уходят с бирж. */
  net: number;
  nin: number;
  nout: number;
  ex: { ex: string; in: number; out: number }[];
  /** Накопленный чистый вывод по окну, 25 точек от нуля. */
  tr: number[];
  /** Сканер работает дольше окна — сумма полная. */
  full: boolean;
}

export interface BtcFlowReply {
  ok: boolean;
  error?: string;
  price: number;
  /** С какого момента есть данные. */
  since: number;
  height: number;
  at: number;
  labels: number;
  wins: Record<string, BtcFlowWin | undefined>;
}

/** Что сканер знает о кошельке помимо движений. */
export interface BtcExtra {
  /** Остаток на адресе по последней проверке, BTC. */
  bal?: number;
  txs?: number;
  /** В базе сервисного аккаунта. */
  base?: boolean;
}

export interface BtcMove extends BtcExtra {
  tx: string;
  t: number;
  a: string;
  ex: string;
  btc: number;
  v: number;
  px: number;
}

export interface BtcBigReply {
  ok: boolean;
  error?: string;
  win: string;
  side: "buy" | "sell";
  min: number;
  tot: Record<"buy" | "sell", { n: number; btc: number; v: number }>;
  full: boolean;
  since: number;
  rows: BtcMove[];
}

export interface BtcTrader extends BtcExtra {
  a: string;
  pnl: number;
  roi: number;
  /** Доля выводов, купленных дешевле нынешней цены, %. */
  win: number;
  tr: number;
  buys: number;
  sells: number;
  /** Накоплено: выведено минус заведено, BTC. */
  btc: number;
  bought: number;
  sold: number;
  /** Средняя цена покупки. */
  avg: number;
  inv: number;
  /** Биржа, с которой больше всего движений. */
  ex: string;
  days: number;
  first: number;
  last: number;
}

export type BtcRankKind = "pnl" | "roi" | "act";

export interface BtcRankReply {
  ok: boolean;
  error?: string;
  days: number;
  price: number;
  n: number;
  full: boolean;
  since: number;
  pnl: BtcTrader[];
  roi: BtcTrader[];
  act: BtcTrader[];
}

export interface BtcWalletReply extends BtcExtra {
  ok: boolean;
  error?: string;
  addr: string;
  price: number;
  /** Адрес сам принадлежит бирже. */
  ex: string;
  book: Omit<BtcTrader, "a"> | null;
  moves: { tx: string; buy: boolean; btc: number; v: number; px: number; t: number; ex: string }[];
}
