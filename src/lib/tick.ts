/**
 * Общие часы для обратных отсчётов.
 *
 * Один таймер на всё приложение, а не свой у каждой строки: на доске
 * фандинга их сорок, и сорок интервалов по секунде — это сорок таймеров,
 * которые телефон будит одновременно. Подписчики получают одно и то же
 * значение, поэтому и перерисовываются одним махом.
 *
 * Между перерисовками — секунда: отсчёт, который стоит на месте, выглядит
 * сломанным, а чаще секунды глазу всё равно не видно.
 *
 * Тик — на границе секунды (+ запас TICK_SLACK), а не «раз в 1000 мс от
 * запуска»: такие срабатывания на телефоне запаздывают по-разному, и после
 * тика в 10,999 следующий в 12,001 — секунда 11 в отсчёте пропадала.
 */
import { useSyncExternalStore } from "react";

const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let stamp = Date.now();
/** Запас после границы секунды, мс: таймер не должен сработать за миг до неё. */
const TICK_SLACK = 5;

/** Ждать до следующей границы секунды. */
const untilNextSecond = (t: number) => 1000 - (t % 1000) + TICK_SLACK;

function tick(): void {
  stamp = Date.now();
  for (const s of subs) s();
  // Подписчик мог отписаться прямо в тике — тогда новый таймер не нужен.
  timer = subs.size ? setTimeout(tick, untilNextSecond(Date.now())) : undefined;
}

/** Подписка на тик (экспорт — для тестов; в приложении — через useNow). */
export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!timer) timer = setTimeout(tick, untilNextSecond(Date.now()));
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/**
 * Снимок часов для React (экспорт — для тестов).
 *
 * Пока подписчиков нет, таймер стоит и stamp не обновляется: открыли меню
 * через час — первый кадр отсчёта считался от времени часовой давности и
 * через секунду прыгал. Без таймера берём «сейчас»; поправка не чаще раза
 * в секунду, чтобы два вызова в одной отрисовке давали одно значение.
 */
export function nowSnapshot(): number {
  if (!timer) {
    const t = Date.now();
    // В обе стороны: часы телефона могли и перевести назад (синхронизация
    // времени), и тогда снимок «из будущего» висел бы до первого тика.
    if (Math.abs(t - stamp) >= 1000) stamp = t;
  }
  return Math.floor(stamp / 1000);
}

/** Текущее время в секундах эпохи, обновляется раз в секунду. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    nowSnapshot,
    // На сервере рендера нет, но тип требует снимок — берём то же время.
    nowSnapshot,
  );
}
