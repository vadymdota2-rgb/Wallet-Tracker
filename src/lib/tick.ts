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
 */
import { useSyncExternalStore } from "react";

const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let stamp = Date.now();

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      stamp = Date.now();
      for (const s of subs) s();
    }, 1000);
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      clearInterval(timer);
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
    if (t - stamp >= 1000) stamp = t;
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
