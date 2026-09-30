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
import { prefetchAll } from "./prefetch";

const OK_DELAY = 180_000;
/* Первый повтор после сбоя — быстро: при запуске сбой обычно разовый
   (сервер только что перезапущен, сеть телефона просыпается), и ждать
   восемь-шестнадцать секунд значило заставлять человека жать «обновить». */
const MIN_DELAY = 3_000;
const MAX_DELAY = 60_000;
/* Сервер отдал быструю выгрузку — справочник монет из памяти, полный
   дособирается. Переспрашиваем через пару секунд, а не через три минуты. */
const SOON_DELAY = 2_500;

let soon = false;
let fails = 0;

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
  /* Сервер собрал не всё: справочник монет или первый круг опроса бирж
     фандинга ещё идут. Переспрашиваем через пару секунд. */
  soon = Array.isArray(data.partial)
    && (data.partial.includes("coins:later") || data.partial.includes("fund:later"));
  /* Главный экран уже нарисован из выгрузки — теперь в фоне подтягиваем всё,
     что раньше грузилось только по нажатию. Чуть позже, чтобы не спорить с
     первой отрисовкой за сеть. */
  setTimeout(() => void prefetchAll(), 400);
  return true;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const ok = await pull();
    if (ok) {
      fails = 0;
      delay = soon ? SOON_DELAY : OK_DELAY;
    } else if (lastStatus === 401 || lastStatus === 403) delay = MAX_DELAY;
    else {
      // Серия сбоев считается сама по себе: прежде удвоение шло от трёх минут
      // удачного опроса, и первый же сбой откладывал повтор на минуту.
      delay = Math.min(MAX_DELAY, MIN_DELAY * 2 ** fails);
      fails++;
    }
  } finally {
    running = false;
  }
  timer = setTimeout(() => void tick(), delay);
}

/** Ручное обновление — кнопкой или жестом. */
export async function syncNow(): Promise<boolean> {
  if (timer) clearTimeout(timer);
  const ok = await pull();
  if (ok) fails = 0;
  delay = ok ? (soon ? SOON_DELAY : OK_DELAY) : MIN_DELAY;
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
