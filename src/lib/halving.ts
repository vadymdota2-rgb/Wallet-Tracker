/**
 * Расчёт отсчёта до халвинга — отдельно от экрана, чтобы его проверяли
 * тесты (tests/halving.test.ts): здесь нет ни React, ни сети, ни часов —
 * время приходит параметром.
 */
import type { HalvingReply } from "./types";

/** Награда за блок в эпоху 0 — 50 BTC в сатоши. */
const SUBSIDY0 = 5_000_000_000;

/**
 * Ответ сервера пригоден для отсчёта. Мусор (обрезанный JSON, старый формат,
 * чужой прокси) не должен рисовать «−3 дня» или полосу на 400 %.
 */
export function validHalving(h: unknown): h is HalvingReply {
  if (!h || typeof h !== "object") return false;
  const r = h as Partial<HalvingReply>;
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  return r.ok === true && int(r.height) && int(r.next) && int(r.every)
    && r.next! % r.every! === 0 && r.next! - r.every! <= r.height! && r.height! < r.next!
    && typeof r.avg === "number" && r.avg >= 300 && r.avg <= 1200
    && typeof r.at === "number" && r.at > 1_600_000_000;
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
}

/** Всё, что рисует карточка, — на момент now (unix-секунды по часам сервера). */
export function halvingView(h: HalvingReply, now: number): HalvingView {
  // Старый ответ (до поля eta) — считаем от момента ответа.
  const tip = h.tip ?? h.at;
  const eta = h.eta ?? h.at + (h.next - h.height) * h.avg;
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
  };
}
