/**
 * Расчёт отсчёта до халвинга — отдельно от экрана, чтобы его проверяли
 * тесты (tests/halving.test.ts): здесь нет ни React, ни сети, ни часов —
 * время приходит параметром.
 */

/** Ответ /api/halving (сервер — wt_halving.py). */
export interface HalvingReply {
  ok: boolean;
  error?: string;
  height: number;
  next: number;
  every: number;
  /** Секунд на блок: среднее за эпоху («epoch»), за период сложности
   *  («period») или ровно 600 («nominal»). */
  avg: number;
  src?: "epoch" | "period" | "nominal";
  /** Время последнего блока и оценка момента халвинга (unix, с). */
  tip?: number;
  eta?: number;
  /** Когда сервер собрал ответ (может быть на минуты раньше, чем отдал). */
  at: number;
  /** Время сервера в момент ответа — для поправки на часы телефона. */
  now?: number;
  /** Только на устройстве: на сколько секунд часы сервера впереди. */
  skew?: number;
  /** Время блока прошлого халвинга (начала эпохи), если сервер его знает. */
  prev?: number;
}

/** Сколько ответ живёт в памяти приложения (на сервере — так же, TTL в wt_halving.py). */
export const HALVING_TTL_MS = 5 * 60_000;
/** Награда за блок в эпоху 0 — 50 BTC в сатоши. */
const SUBSIDY0 = 5_000_000_000;
/** Сколько после халвинга карточка говорит «состоялся». */
const JUST_HAPPENED = 14 * 86400;

/**
 * Ответ сервера пригоден для отсчёта. Мусор (обрезанный JSON, старый формат,
 * чужой прокси) не должен рисовать «−3 дня» или полосу на 400 %.
 */
export function validHalving(h: unknown): h is HalvingReply {
  if (!h || typeof h !== "object") return false;
  const r = h as Partial<HalvingReply>;
  const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  // Unix-время в разумных пределах: с 2020 по 2096 год.
  const time = (v: unknown): v is number => typeof v === "number" && v > 1_600_000_000 && v < 4_000_000_000;
  // Необязательные поля, если есть, — тоже числа: строка в eta рисовала
  // «NaN дн», а new Date(NaN) в формате даты роняла всё приложение.
  const opt = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || v === null || ok(v);
  // Среднее — шире, чем пускает сервер (480–720 с): лишь бы не мусор.
  return r.ok === true && int(r.height) && int(r.next) && int(r.every)
    && r.next % r.every === 0 && r.next - r.every <= r.height && r.height < r.next
    && typeof r.avg === "number" && r.avg >= 300 && r.avg <= 1200
    && time(r.at) && opt(r.eta, time) && opt(r.tip, time) && opt(r.now, time) && opt(r.prev, time)
    && opt(r.skew, (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 366 * 86400)
    && opt(r.src, (v) => v === "epoch" || v === "period" || v === "nominal");
}

/**
 * Поправка на часы телефона: на сколько секунд время сервера впереди.
 * Мелочь (задержка сети, пара секунд расхождения) не трогаем — иначе отсчёт
 * дёргался бы при каждом ответе.
 */
export function clockSkew(serverNow: number | undefined, localNow: number): number {
  if (typeof serverNow !== "number" || !Number.isFinite(serverNow)) return 0;
  const d = Math.round(serverNow - localNow);
  return Math.abs(d) > 60 ? d : 0;
}

/** Награда за блок в эпоху n, в сатоши: как в консенсусе, 50 BTC >> n. */
export function subsidySats(epoch: number): number {
  return epoch >= 64 ? 0 : Math.floor(SUBSIDY0 / 2 ** epoch);
}

export interface HalvingView {
  /** Секунд до халвинга (0 — наступает). */
  left: number;
  /** Дни, часы, минуты, секунды. */
  parts: [number, number, number, number];
  /** Оценка текущей высоты. */
  height: number;
  /** Пройдено эпохи, % — для полосы. */
  done: number;
  /** То же для подписи: до десятых, но до халвинга не больше 99,9 —
   *  обычное округление превратило бы 99,96 в «100,0 %». */
  donePct: number;
  /** Момент халвинга, unix-секунды. */
  eta: number;
  /** Награда сейчас и после халвинга, сатоши. */
  reward: number;
  rewardNext: number;
  /** Прошлый халвинг был меньше двух недель назад — его время, иначе null. */
  justHappened: number | null;
}

/** Всё, что рисует карточка, — на момент now (unix-секунды по часам сервера). */
export function halvingView(h: HalvingReply, now: number): HalvingView {
  // Старый ответ (до поля eta) — считаем от момента ответа.
  const tip = h.tip ?? h.at;
  const eta = h.eta ?? h.at + (h.next - h.height) * h.avg;
  // Прошлый халвинг — недавно (две недели): карточка скажет, что он состоялся.
  const since = h.prev ? now - h.prev : Infinity;
  const left = Math.max(0, Math.floor(eta - now));
  // Текущая высота: последний известный блок плюс вышедшие с тех пор по
  // среднему. До халвинга — не выше next − 1, как бы ни ошиблась оценка.
  const height = left > 0
    ? Math.min(h.next - 1, h.height + Math.max(0, Math.floor((now - tip) / h.avg)))
    : h.next;
  const start = h.next - h.every;
  const done = Math.min(100, Math.max(0, ((height - start) / h.every) * 100));
  const epoch = Math.floor(start / h.every);
  return {
    left,
    parts: [Math.floor(left / 86400), Math.floor((left % 86400) / 3600), Math.floor((left % 3600) / 60), left % 60],
    height,
    done,
    donePct: left > 0 ? Math.min(99.9, Math.round(done * 10) / 10) : 100,
    eta,
    reward: subsidySats(epoch),
    rewardNext: subsidySats(epoch + 1),
    justHappened: h.prev && since >= 0 && since < JUST_HAPPENED ? h.prev : null,
  };
}
