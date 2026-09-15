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

/** Текущее время в секундах эпохи, обновляется раз в секунду. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(stamp / 1000),
    // На сервере рендера нет, но тип требует снимок — берём то же время.
    () => Math.floor(stamp / 1000),
  );
}
