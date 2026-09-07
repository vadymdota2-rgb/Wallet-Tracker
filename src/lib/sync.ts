/**
 * Опрос сервера. Одна цепочка, а не таймер плюс ретраи: прошлая версия
 * дёргала boot() каждые 8 секунд при неудаче И держала параллельный
 * интервал на три минуты — при затяжном сбое запросы накладывались.
 *
 * Успех — следующий опрос через три минуты. Неудача — пауза растёт вдвое
 * до минуты. На 401/403 ждём дольше: подписи нет и сама она не появится.
 */
import { fetchBootstrap, fetchMarket, lastStatus } from "./api";
import { initData } from "./telegram";
import { useLive } from "../store/live";

const OK_DELAY = 180_000;
const MIN_DELAY = 8_000;
const MAX_DELAY = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let delay = MIN_DELAY;
let running = false;

async function pull(): Promise<boolean> {
  const signed = Boolean(initData());
  const data = signed ? await fetchBootstrap() : await fetchMarket();
  const live = useLive.getState();
  if (!data || data.ok === false) {
    live.setStatus(live.syncedAt ? "stale" : "offline");
    return false;
  }
  live.apply(data);
  if (!signed) live.setStatus("anon");
  return true;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const ok = await pull();
    if (ok) delay = OK_DELAY;
    else if (lastStatus === 401 || lastStatus === 403) delay = MAX_DELAY;
    else delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, delay * 2));
  } finally {
    running = false;
  }
  timer = setTimeout(() => void tick(), delay);
}

/** Ручное обновление — кнопкой или жестом. */
export async function syncNow(): Promise<boolean> {
  if (timer) clearTimeout(timer);
  const ok = await pull();
  delay = ok ? OK_DELAY : Math.min(MAX_DELAY, Math.max(MIN_DELAY, delay));
  timer = setTimeout(() => void tick(), delay);
  return ok;
}

export function startSync(): () => void {
  void tick();
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), 300);
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
  };
}
