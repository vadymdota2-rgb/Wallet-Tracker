/**
 * Подгрузка при запуске.
 *
 * Человек открывает приложение кнопкой Open в Telegram — и всё, что раньше
 * грузилось только по нажатию, подтягивается сразу в фоне: позиции и остатки
 * всех его кошельков, крупные сделки за все окна, фильтры потока и лонгов с
 * шортами, сделки первых трейдеров доски, история
 * цен монет из потока и из кошельков. Ответы ложатся в память (memo.ts), и
 * экран, открытый потом, берёт готовое без скелета.
 *
 * Идёт после первой выгрузки и не мешает ей: сперва человек видит главный
 * экран, потом в очереди по четыре запроса за раз добирается остальное. Пока
 * приложение открыто, подгрузка повторяется с каждым опросом сервера —
 * иначе через несколько минут память устарела бы и скелеты вернулись.
 *
 * Закрытое подпиской не запрашивается: сервер его бесплатному всё равно не
 * отдаст, а лишние отказы — лишняя нагрузка.
 */
import { FREE, FREE_BIG_WINS, FREE_FLOW_WINS } from "./upsell";
import {
  fetchBig, fetchBtcBig, fetchBtcFlow, fetchBtcRank, fetchDeals, fetchFlow, fetchLs, fetchSymbols, fetchTokenHist,
  fetchUnlocks, fetchWallet,
} from "./api";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import type { WalletLive } from "./types";

const PARALLEL = 4;
/** Окна крупных сделок, кроме суток: сутки уже пришли в общей выгрузке. */
const BIG_WINS = ["1h", "6h", "7d", "30d"];
const TOP_DEALS = 10;
const FLOW_COINS = 10;
const HOLD_COINS = 20;

let runs = 0;

/** Живые данные кошелька — в хранилище: из них рисуются и список, и карточка. */
export function applyWalletLive(addr: string, d: WalletLive | null): void {
  if (!d?.ok) return;
  useLive.getState().patchWallet(addr, {
    pos: d.pos ?? [],
    holds: d.holds ?? [],
    equity: d.equity,
    bal: d.bal ?? 0,
    d1: d.d1 ?? 0,
  });
}

/** Очередь с ограничением: телефону и серверу — не больше четырёх сразу. */
async function drain(jobs: (() => Promise<unknown>)[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        if (job) await job();
      } catch {
        // Подгрузка — не обязательство: не вышло — экран сходит сам.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
}

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Список заданий по тому, что сейчас есть в хранилище. */
function plan(): (() => Promise<unknown>)[] {
  const live = useLive.getState();
  const app = useApp.getState();
  const premium = live.me.plan === "premium";
  const jobs: (() => Promise<unknown>)[] = [];

  // 0. Календарь разлоков — самым первым: сервер отдаёт его из памяти
  // мгновенно, а в конце очереди экран ждал десятки чужих запросов.
  jobs.push(() => fetchUnlocks(premium));

  // 1. Кошельки — первыми: их открывают чаще всего.
  for (const w of live.wallets) {
    // У биткоина позиций Hyperliquid нет — его экран берёт данные сам.
    if (w.chain === "btc") continue;
    jobs.push(() => fetchWallet(w.addr).then((d) => applyWalletLive(w.addr, d)));
  }

  // 2. Крупные сделки за все окна — те, что открыты по плану: неделю и
  //    месяц бесплатному сервер не отдаёт, и запрос был бы впустую.
  for (const win of BIG_WINS) {
    if (premium || (FREE_BIG_WINS as readonly string[]).includes(win)) jobs.push(() => fetchBig(win));
  }

  // 3. Поток: притоки и оттоки выбранного окна. «Все» уже в выгрузке.
  if (premium || (FREE_FLOW_WINS as readonly string[]).includes(app.flowWin))
    for (const side of ["in", "out"]) jobs.push(() => fetchFlow(app.flowWin, "", 0, side));

  // 4. Лонги и шорты — только подписчику.
  if (premium) {
    for (const side of ["in", "out"]) jobs.push(() => fetchLs(app.flowWin, "", 0, side, app.lsCls));
  }

  // 5. Сделки первых трейдеров доски, которую человек смотрит.
  if (app.rankVenue === "btc") {
    jobs.push(() => fetchBtcRank(app.rankWin));
  } else {
    const venue = app.rankVenue === "perp" && !premium ? "spot" : app.rankVenue;
    const board = live.rank[venue]?.[app.rankKind] ?? live.rank[venue]?.pnl ?? [];
    const n = premium ? FREE.premiumDeals : FREE.deals;
    for (const r of board.slice(0, TOP_DEALS)) jobs.push(() => fetchDeals(r.a, venue, n));
  }

  // 5б. Биткоин: поток для NetFlow и выводы с бирж за выбранное окно.
  jobs.push(() => fetchBtcFlow());
  jobs.push(() => fetchBtcBig(app.bigWin, app.btcSide, app.btcBase ? app.btcMin : Math.max(1, app.btcMin), app.btcBase));

  // 6. Справочник монет для поиска на графике.
  jobs.push(() => fetchSymbols());

  // 7. История цены монет из потока — открывают их из списка.
  for (const r of (live.flow[app.flowWin]?.rows ?? []).slice(0, FLOW_COINS)) {
    const a = r.addr || r.token;
    if (isAddr(a)) jobs.push(() => fetchTokenHist(a));
  }
  return jobs;
}

/** Монеты в кошельках — их список известен только после живых данных. */
function holdJobs(): (() => Promise<unknown>)[] {
  const seen = new Set<string>();
  const jobs: (() => Promise<unknown>)[] = [];
  for (const w of useLive.getState().wallets) {
    for (const h of w.holds ?? []) {
      const a = h.token?.toLowerCase();
      if (!isAddr(a) || seen.has(a) || seen.size >= HOLD_COINS) continue;
      seen.add(a);
      jobs.push(() => fetchTokenHist(a));
    }
  }
  return jobs;
}

/**
 * Подтянуть всё. Повторный вызов, пока идёт прошлый, ничего не делает:
 * одинаковые запросы в памяти и так склеиваются, а очередь не должна
 * разрастаться вдвое.
 */
export async function prefetchAll(): Promise<void> {
  if (runs > 0) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  runs++;
  try {
    await drain(plan());
    await drain(holdJobs());
  } finally {
    runs--;
  }
}
