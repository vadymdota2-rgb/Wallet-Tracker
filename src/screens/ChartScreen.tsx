/**
 * График на весь экран — свой, без TradingView.
 *
 * Свечи с Binance, Hyperliquid (в том числе акции и металлы HIP-3), Bybit и
 * KuCoin; живая последняя свеча — вебсокетом. Четырнадцать таймфреймов, шесть
 * видов графика, двадцать индикаторов и четырнадцать инструментов рисования.
 * Плюс то, чего нет у TradingView: открытый интерес по 32 биржам, средний
 * фандинг и уровни ликвидаций прямо на графике цены — из данных Wallet Tracker.
 *
 * Монета выбирается кнопкой в шапке (популярные, ваши кошельки, лидеры
 * NetFlow или любой тикер). Таймфрейм, вид и индикаторы запоминаются;
 * рисунки — отдельно по каждой монете.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { haptic, webApp } from "../lib/telegram";
import {
  fetchChartLiqs, fetchChartWhales, fetchLiqMap, fetchOiHist, fetchSymbols, peekSymbols,
  chartSnap, chartStateGet, chartStatePut, pxAlertAdd, pxAlertDel, pxAlertList, pxAlertMove, type PxAlert, type PxLevel,
} from "../lib/api";
import { toast } from "../components/Toast";
import type { SymbolRow } from "../lib/types";
import { CoinIcon } from "../components/CoinIcon";
import { loadHistory, loadOlder, market, SOURCE_NAME, subscribe, TF_MS, TFS, type Source, type Tf } from "../chart/data";
import { Engine, fmtPrice, fmtShort, priceDecimals, type ChartType, type Hover, type Tool } from "../chart/engine";
import {
  AUTO_KINDS, IND, indTitle, newInd, OVERLAY_KINDS, OWN_KINDS, PANE_KINDS, rateKey, type IndInst, type IndKind, type Rating,
} from "../chart/indicators";
import { DRAW_COLORS, FIB_ALL, FIB_DEF, FIBEXT_DEF, isFib, type DrawType, type Drawing } from "../chart/draw";

const POPULAR = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "TON", "HYPE", "SUI", "PEPE", "LINK", "AVAX"];
const VENUE_NAME: Record<string, string> = { binance: "Binance", bybit: "Bybit", hl: "Hyperliquid" };
const MAX_RESULTS = 40;

/** Совпадения по тикеру: точное, потом с начала, потом внутри. */
function search(rows: SymbolRow[], q: string): SymbolRow[] {
  const exact: SymbolRow[] = [];
  const starts: SymbolRow[] = [];
  const inside: SymbolRow[] = [];
  for (const r of rows) {
    if (r.s === q) exact.push(r);
    else if (r.s.startsWith(q)) starts.push(r);
    else if (r.s.includes(q)) inside.push(r);
  }
  return [...exact, ...starts, ...inside].slice(0, MAX_RESULTS);
}

/** Что показать в шапке: xyz:NVDA — это NVDA. */
const label = (sym: string) => sym.split(":").pop() || sym;

/** Без повторов, в исходном порядке, прописными. */
function uniq(list: (string | undefined)[], limit: number): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s || s === "—" || out.includes(s)) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/* ── Настройки графика на устройстве ───────────────────────────────────── */

interface Prefs {
  tf: Tf;
  type: ChartType;
  inds: IndInst[];
  magnet: boolean;
  tools: boolean;
  /** Шкала в процентах. */
  pct?: boolean;
  /** Монеты для сравнения (до трёх). */
  cmp?: string[];
  /** Логарифмическая шкала цены. */
  log?: boolean;
  /** Последняя открытая монета — чтобы вернуться к ней и с другого устройства. */
  sym?: string;
  /** Когда меняли (мс) — для сверки с сервером: новее тот, кто позже. */
  at?: number;
}

const CMP_MAX = 3;
const CMP_COLORS = ["#f0b90b", "#c38bff", "#7fd8ff"];

const PREFS_KEY = "wt-chart-v1";
const DRAW_KEY = "wt-chart-draw-v1";
/** Когда рисунки каждой монеты меняли на этом устройстве (мс). */
const DRAW_AT_KEY = "wt-chart-draw-at-v1";

function loadPrefs(): Prefs {
  const def: Prefs = { tf: "1h", type: "candles", inds: [newInd("vol"), newInd("wt_liq")], magnet: true, tools: false };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "null") as Partial<Prefs> | null;
    if (!raw) return def;
    return {
      tf: TFS.includes(raw.tf as Tf) ? (raw.tf as Tf) : def.tf,
      type: raw.type ?? def.type,
      inds: Array.isArray(raw.inds) ? raw.inds.filter((i) => i && IND[i.kind]) : def.inds,
      magnet: raw.magnet ?? true,
      tools: raw.tools ?? false,
      pct: !!raw.pct,
      cmp: Array.isArray(raw.cmp) ? raw.cmp.filter((x) => typeof x === "string").slice(0, CMP_MAX) : [],
      log: !!raw.log,
      sym: typeof raw.sym === "string" && raw.sym ? raw.sym : undefined,
      at: Number(raw.at) || 0,
    };
  } catch {
    return def;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch { /* приватный режим — живём без памяти */ }
}

function loadDrawings(sym: string): Drawing[] {
  try {
    const all = JSON.parse(localStorage.getItem(DRAW_KEY) || "{}") as Record<string, Drawing[]>;
    return Array.isArray(all[sym]) ? all[sym]! : [];
  } catch {
    return [];
  }
}

function drawAt(sym: string): number {
  try {
    return Number((JSON.parse(localStorage.getItem(DRAW_AT_KEY) || "{}") as Record<string, number>)[sym]) || 0;
  } catch {
    return 0;
  }
}

function saveDrawings(sym: string, list: Drawing[], at = Date.now()) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAW_KEY) || "{}") as Record<string, Drawing[]>;
    if (list.length) all[sym] = list;
    else delete all[sym];
    localStorage.setItem(DRAW_KEY, JSON.stringify(all));
    const ats = JSON.parse(localStorage.getItem(DRAW_AT_KEY) || "{}") as Record<string, number>;
    ats[sym] = at;
    localStorage.setItem(DRAW_AT_KEY, JSON.stringify(ats));
  } catch { /* места нет — рисунки живут до закрытия */ }
}

/* Отправка на сервер — не на каждое движение, а через полторы секунды тишины. */
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
function pushLater(key: string, send: () => void) {
  const was = pushTimers.get(key);
  if (was) clearTimeout(was);
  pushTimers.set(key, setTimeout(() => {
    pushTimers.delete(key);
    send();
  }, 1500));
}

/** Рисунки монеты — на сервер, если влезают в запрос (длинная кисть может не влезть). */
function pushDrawings(sym: string, list: Drawing[], at: number) {
  pushLater(`d:${sym}`, () => {
    if (JSON.stringify(list).length > 15_000) return;
    void chartStatePut({ sym, list, at });
  });
}

/* ── Подписи ───────────────────────────────────────────────────────────── */

const TF_LABEL: Record<Tf, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "4h": "4H",
  "6h": "6H", "12h": "12H", "1d": "1D", "3d": "3D", "1w": "1W", "1M": "1M",
};
const TF_QUICK: Tf[] = ["15m", "1h", "4h", "1d"];
const TYPES: ChartType[] = ["candles", "hollow", "heikin", "bars", "line", "area"];
/* Инструменты — группами, как у TradingView, но со словами: на телефоне по
   значку не угадать, где «расширение Фибоначчи», а где «веер». */
const GROUPS: { key: DictKey; tools: DrawType[] }[] = [
  { key: "chart_g_lines", tools: ["trend", "ray", "ext", "hline", "hray", "vline", "channel"] },
  { key: "chart_g_fib", tools: ["fib", "fibext", "fibfan", "fibtime"] },
  { key: "chart_g_ew", tools: ["ew5", "abc", "tri", "wxy"] },
  { key: "chart_g_pos", tools: ["long", "short", "measure"] },
  { key: "chart_g_shapes", tools: ["rect", "text", "brush"] },
];

const indName = (k: IndKind) => `chart_i_${k}` as DictKey;

/* Значки инструментов — тонкие линии, как у TradingView. */
/* Иконки графика — свой рисунок, не как у TradingView: линия толще и
   круглее, полупрозрачная заливка фигур, а опорные точки — голубые кольца
   (ровно так точки рисунков выглядят и на самом графике). */
type IconKey = DrawType | "cursor" | "magnet" | "eye" | "trash" | "undo" | "redo" | ChartType
  | "bell" | "camera" | "expand" | "shrink" | "vs";

function ToolIcon({ k }: { k: IconKey }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const f = { fill: "currentColor", opacity: 0.18 };
  const N = (x: number, y: number) => <circle cx={x} cy={y} r="2.3" fill="#050b16" stroke="#7fd8ff" strokeWidth="1.6" />;
  const lbl = (x: number, txt: string) => <text x={x} y="23" fontSize="6.5" fontWeight="700" fill="#7fd8ff" stroke="none">{txt}</text>;
  const body: Record<IconKey, ReactNode> = {
    cursor: <><path d="M5 3.5l13.5 7-5.8 1.9-2.4 5.6z" {...f} /><path {...p} d="M5 3.5l13.5 7-5.8 1.9-2.4 5.6z" /><path {...p} d="M13 13l5 6" /></>,
    trend: <><path {...p} d="M5 18L19 6" />{N(5, 18)}{N(19, 6)}</>,
    ray: <><path {...p} d="M5 18L21 4M16.5 4H21v4.5" />{N(5, 18)}{N(11.5, 12.4)}</>,
    ext: <><path {...p} d="M2 20L22 4" />{N(8, 15.2)}{N(16, 8.8)}</>,
    hline: <><path {...p} d="M2 12h20" />{N(12, 12)}</>,
    hray: <><path {...p} d="M7 12h15M19 9l3 3-3 3" />{N(7, 12)}</>,
    vline: <><path {...p} d="M12 2v20" />{N(12, 12)}</>,
    channel: <><path d="M3 14L17 5l4 5-14 9z" {...f} /><path {...p} d="M3 14L17 5M7 19L21 10" />{N(3, 14)}{N(17, 5)}</>,
    rect: <><rect x="4" y="6" width="16" height="12" rx="3" {...f} /><rect {...p} x="4" y="6" width="16" height="12" rx="3" />{N(4, 6)}{N(20, 18)}</>,
    fib: <><rect x="3" y="9.5" width="18" height="5" rx="1" fill="#f0b90b" opacity=".28" /><path {...p} d="M3 5h18M3 9.5h18M3 14.5h18M3 19h18" />{N(3, 19)}{N(21, 5)}</>,
    long: <><rect x="4" y="4.5" width="16" height="8" rx="2.5" fill="rgba(61,220,151,.28)" stroke="#3ddc97" strokeWidth="1.5" /><rect x="4" y="12.5" width="16" height="6" rx="2.5" fill="rgba(255,92,119,.28)" stroke="#ff5c77" strokeWidth="1.5" />{N(4, 12.5)}</>,
    short: <><rect x="4" y="11.5" width="16" height="8" rx="2.5" fill="rgba(61,220,151,.28)" stroke="#3ddc97" strokeWidth="1.5" /><rect x="4" y="5.5" width="16" height="6" rx="2.5" fill="rgba(255,92,119,.28)" stroke="#ff5c77" strokeWidth="1.5" />{N(4, 11.5)}</>,
    measure: <><path d="M4 18L18 4l2.5 2.5-14 14z" {...f} /><path {...p} d="M4 18L18 4l2.5 2.5-14 14zM8.5 13.5l2 2M11.5 10.5l2 2M14.5 7.5l2 2" /></>,
    text: <><path {...p} strokeWidth="2.2" d="M6 6.5V5h12v1.5M12 5v14M9.5 19h5" />{N(19, 18)}</>,
    brush: <><path {...p} d="M4 18c3 0 3-4 6-4s2 5 6 3 3-8 4-11" />{N(20, 6)}</>,
    fibext: <><path {...p} d="M3 18L8.5 9l5 5" /><path {...p} opacity=".7" d="M15 5h7M15 10h7M15 15h7" />{N(3, 18)}{N(8.5, 9)}{N(13.5, 14)}</>,
    fibfan: <><path d="M3 20L21 4v15z" {...f} /><path {...p} d="M3 20L21 4M3 20L21 10M3 20L21 15" />{N(3, 20)}</>,
    fibtime: <><path {...p} d="M4 3v18M7 3v18M10 3v18M15 3v18M21 3v18" />{N(4, 12)}</>,
    ew5: <><path {...p} d="M2 18l4-6 3 3 5-9 3 5 5-6" />{N(6, 12)}{N(14, 6)}{N(22, 5)}{lbl(1, "1-5")}</>,
    abc: <><path {...p} d="M3 5l6 10 5-5 7 8" />{N(9, 15)}{N(14, 10)}{N(21, 18)}{lbl(1, "ABC")}</>,
    tri: <><path d="M2 6l20 4.5L2 16z" {...f} /><path {...p} d="M2 6l4 10 4-8 4 6 4-4 4 3" /></>,
    wxy: <><path {...p} d="M3 5l6 9 5-4 7 9" />{N(9, 14)}{N(14, 10)}{lbl(1, "WXY")}</>,
    undo: <path {...p} d="M9.5 14.5L5 10l4.5-4.5M5 10h9.5a5 5 0 010 10H12" />,
    redo: <path {...p} d="M14.5 14.5L19 10l-4.5-4.5M19 10H9.5a5 5 0 000 10H12" />,
    magnet: <><path {...p} d="M6 4v8a6 6 0 0012 0V4" /><path d="M4.6 3.5h2.8v4H4.6zM16.6 3.5h2.8v4h-2.8z" fill="#7fd8ff" /></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" {...f} /><path {...p} d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" fill="#7fd8ff" /></>,
    trash: <><path d="M6.5 8h11l-1 11.5a1.5 1.5 0 01-1.5 1.5H9a1.5 1.5 0 01-1.5-1.5z" {...f} /><path {...p} d="M4 7.5h16M9.5 7.5V5a1 1 0 011-1h3a1 1 0 011 1v2.5M6.5 8l1 11.5A1.5 1.5 0 009 21h6a1.5 1.5 0 001.5-1.5l1-11.5" /></>,
    candles: <><path {...p} d="M7.5 3v18M16.5 5v14" /><rect x="5" y="7" width="5" height="9" rx="1.6" fill="currentColor" /><rect x="14" y="8.5" width="5" height="6.5" rx="1.6" {...f} /><rect {...p} x="14" y="8.5" width="5" height="6.5" rx="1.6" /></>,
    hollow: <><path {...p} d="M7.5 3v18M16.5 5v14" /><rect {...p} x="5" y="7" width="5" height="9" rx="1.6" /><rect x="14" y="8.5" width="5" height="6.5" rx="1.6" fill="currentColor" /></>,
    heikin: <><path {...p} d="M7.5 4v16M16.5 6v12" /><rect x="5" y="7" width="5" height="10" rx="2.5" fill="currentColor" opacity=".55" /><rect x="14" y="9" width="5" height="6" rx="2.5" fill="currentColor" opacity=".55" /></>,
    bars: <path {...p} d="M8 4v16M5 8h3M8 16h3M16 6v12M13 9h3M16 15h3" />,
    line: <><path {...p} d="M3 17l5-6 4 3 5-8 4 4" />{N(17, 6)}</>,
    area: <><path d="M3 17l5-6 4 3 5-8 4 4v10H3z" {...f} /><path {...p} d="M3 17l5-6 4 3 5-8 4 4" />{N(17, 6)}</>,
    bell: <><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" {...f} /><path {...p} d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15zM10 20.5a2.2 2.2 0 004 0" /><circle cx="18" cy="5.5" r="2.4" fill="#7fd8ff" /></>,
    camera: <><rect x="3" y="7" width="18" height="13" rx="4" {...f} /><path {...p} d="M3 11a4 4 0 014-4h1.5l1.5-2.5h4L15.5 7H17a4 4 0 014 4v5a4 4 0 01-4 4H7a4 4 0 01-4-4z" /><circle cx="12" cy="13.5" r="3.2" fill="none" stroke="#7fd8ff" strokeWidth="1.8" /></>,
    expand: <path {...p} d="M4 9V6a2 2 0 012-2h3M15 4h3a2 2 0 012 2v3M20 15v3a2 2 0 01-2 2h-3M9 20H6a2 2 0 01-2-2v-3" />,
    shrink: <path {...p} d="M9 4v3a2 2 0 01-2 2H4M20 9h-3a2 2 0 01-2-2V4M15 20v-3a2 2 0 012-2h3M4 15h3a2 2 0 012 2v3" />,
    vs: <><path {...p} d="M3 16l5-5 4 3 9-8" /><path {...p} opacity=".55" strokeDasharray="0.5 3.2" d="M3 8l6 5 5-2 7 6" />{N(21, 6)}</>,
  };
  return <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">{body[k]}</svg>;
}

export function ChartScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const saved = useApp((s) => s.tvSym);
  const setSaved = useApp((s) => s.setTvSym);
  const wallets = useLive((s) => s.wallets);
  const flow = useLive((s) => s.flow);

  const [sym, setSym] = useState(() => (arg ? arg.toUpperCase() : saved || "BTC"));
  // Открыли график на конкретной монете — она и станет «последней».
  useEffect(() => {
    if (arg) setSaved(arg.toUpperCase());
  }, [arg, setSaved]);
  const [picking, setPicking] = useState(false);
  /** Выбор монеты для сравнения, а не для открытия. */
  const [cmpPick, setCmpPick] = useState(false);
  const [query, setQuery] = useState("");
  const [dir, setDir] = useState<SymbolRow[] | null>(() => peekSymbols()?.items ?? null);
  useEffect(() => {
    if (!picking || dir) return;
    let alive = true;
    void fetchSymbols().then((r) => {
      if (alive && r?.ok) setDir(r.items ?? []);
    });
    return () => {
      alive = false;
    };
  }, [picking, dir]);

  const groups = useMemo(
    () =>
      [
        { key: "chart_mine" as const, list: uniq(wallets.flatMap((w) => [...w.pos.map((p) => p.sym), ...(w.holds ?? []).map((h) => h.sym)]), 12) },
        { key: "chart_popular" as const, list: POPULAR },
        { key: "chart_flow" as const, list: uniq((flow["24"]?.rows ?? []).map((r) => r.sym), 12) },
      ].filter((g) => g.list.length > 0),
    [wallets, flow],
  );

  const pick = (next: string) => {
    const s = next.trim();
    if (!s) return;
    haptic("select");
    const v = s.includes(":") ? s : s.toUpperCase();
    if (cmpPick) {
      const cur = prefs.cmp ?? [];
      if (!cur.includes(v) && v !== sym) setP({ cmp: [...cur, v].slice(-CMP_MAX) });
      setPicking(false);
      setCmpPick(false);
      setQuery("");
      return;
    }
    setSym(v);
    setSaved(v);
    setP({ sym: v });
    setPicking(false);
    setQuery("");
  };

  const typed = query.trim().toUpperCase().replace(/\s+/g, "");
  const known = useMemo<SymbolRow[]>(() => {
    const seen = new Set((dir ?? []).map((r) => r.s));
    return groups.flatMap((g) => g.list).filter((s) => !seen.has(s)).map((s) => ({ s, v: [] }));
  }, [dir, groups]);
  const results = typed ? search([...(dir ?? []), ...known], typed) : [];

  /* ── График ──────────────────────────────────────────────────────────── */

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const setP = (patch: Partial<Prefs>) => setPrefs((p) => {
    const next = { ...p, ...patch, at: Date.now() };
    savePrefs(next);
    pushLater("prefs", () => void chartStatePut({ prefs: next, at: next.at! }));
    return next;
  });
  // Настройки с сервера — если там новее (меняли на другом устройстве).
  useEffect(() => {
    let alive = true;
    void chartStateGet("").then((r) => {
      const v = r?.ok ? r.prefs : null;
      if (!alive || !v || v.at <= (prefs.at ?? 0)) return;
      const raw = v.v as Partial<Prefs>;
      const next: Prefs = {
        ...prefs,
        tf: TFS.includes(raw.tf as Tf) ? (raw.tf as Tf) : prefs.tf,
        type: raw.type ?? prefs.type,
        inds: Array.isArray(raw.inds) ? raw.inds.filter((i) => i && IND[i.kind]) : prefs.inds,
        magnet: raw.magnet ?? prefs.magnet,
        tools: raw.tools ?? prefs.tools,
        pct: !!raw.pct,
        cmp: Array.isArray(raw.cmp) ? raw.cmp.slice(0, CMP_MAX) : [],
        log: !!raw.log,
        sym: typeof raw.sym === "string" && raw.sym ? raw.sym : prefs.sym,
        at: v.at,
      };
      savePrefs(next);
      setPrefs(next);
      // Монета, на которой остановились, — если график открыли не на конкретной.
      if (!arg && next.sym && next.sym !== sym) {
        setSym(next.sym);
        setSaved(next.sym);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const m = market(sym);
  const drawKey = m.hip3 ?? m.base;

  const box = useRef<HTMLDivElement>(null);
  /** Легенда цены — едет вверх, когда листают к индикаторам. */
  const legendEl = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const eng = useRef<Engine | null>(null);
  const live = useRef<{ sym: string; tf: Tf; src: Source | null; key: string }>({ sym, tf: prefs.tf, src: null, key: drawKey });
  live.current.sym = sym;
  live.current.tf = prefs.tf;
  live.current.key = drawKey;

  const [hover, setHover] = useState<Hover | null>(null);
  const [status, setStatus] = useState<"load" | "ok" | "none">("load");
  const [src, setSrc] = useState<Source | null>(null);
  const [sel, setSel] = useState<Drawing | null>(null);
  const [tool, setTool] = useState<Tool>("cursor");
  const [atLatest, setAtLatest] = useState(true);
  const [menu, setMenu] = useState<null | "tf" | "type" | "ind">(null);
  const [indQ, setIndQ] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<{ id: string; text: string } | null>(null);
  const [hideDraw, setHideDraw] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [ownNone, setOwnNone] = useState<Record<string, boolean>>({});
  /* Список индикаторов в легенде свёрнут: на телефоне он закрывал свечи. */
  const [legendOpen, setLegendOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);
  const [hist, setHist] = useState({ undo: false, redo: false });
  const [rating, setRating] = useState<Rating | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  /* Открытая группа инструментов и последний выбранный в каждой — его значок на кнопке группы. */
  const [flyout, setFlyout] = useState<number | null>(null);
  const [groupLast, setGroupLast] = useState<DrawType[]>(() => GROUPS.map((g) => g.tools[0]!));
  const [fibEdit, setFibEdit] = useState(false);
  /* Подсказка по жестам — пока человек ни разу не поставил перекрестие. */
  const [gest, setGest] = useState(() => {
    try {
      return !localStorage.getItem("wt-chart-gest");
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (!gest || !hover?.live) return;
    setGest(false);
    try {
      localStorage.setItem("wt-chart-gest", "1");
    } catch { /* не запомнится — покажем ещё раз */ }
  }, [gest, hover?.live]);

  /* ── Алерты по цене ───────────────────────────────────────────────────
     Алерт живёт на сервере, а рисунок — на устройстве; связь — номер алерта
     в рисунке. У горизонтали и наклонной линии алерт один, у позиции — два:
     тейк (alert) и стоп (alert2). Рисунок подвинули — алерт переезжает,
     удалили — снимается. */
  const [alerts, setAlerts] = useState<PxAlert[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  /** Подпись уровня каждого алерта: изменилась — значит, рисунок двигали. */
  const alertSig = useRef(new Map<number, string>());
  const levelOf = (d: Drawing, second = false): PxLevel | null => {
    if (d.type === "hline" || d.type === "hray") return d.pts[0] ? { price: d.pts[0].p } : null;
    if (d.type === "long" || d.type === "short") {
      const q = d.pts[second ? 2 : 1];
      return q ? { price: q.p } : null;
    }
    if (d.type === "trend" || d.type === "ray" || d.type === "ext") {
      const [a, b] = d.pts;
      return a && b && a.t !== b.t ? { line: { t1: a.t, p1: a.p, t2: b.t, p2: b.p, log: !!eng.current?.log } } : null;
    }
    return null;
  };
  const sigOf = (lv: PxLevel | null) => JSON.stringify(lv);
  const alertPairs = (d: Drawing): [number, PxLevel | null][] => {
    const out: [number, PxLevel | null][] = [];
    if (d.alert) out.push([d.alert, levelOf(d)]);
    if (d.alert2) out.push([d.alert2, levelOf(d, true)]);
    return out;
  };
  const refreshAlerts = () => void pxAlertList().then((r) => {
    if (!r?.ok) return;
    const items = r.items ?? [];
    setAlerts(items);
    // Сработавшие и снятые в другом месте — убрать колокольчик с рисунков.
    const e = eng.current;
    if (!e) return;
    const live2 = new Set(items.filter((a) => !a.fired).map((a) => a.id));
    for (const d of e.allDrawings) {
      const patch: Partial<Drawing> = {};
      for (const key of ["alert", "alert2"] as const) {
        const id = d[key];
        if (!id || live2.has(id)) continue;
        patch[key] = undefined;
        const a = items.find((x) => x.id === id);
        if (a?.fired) patch.fired = a.fired;
      }
      if (Object.keys(patch).length) e.patchQuiet(d.id, patch);
    }
  });
  const prevAlerted = useRef(new Map<number, string>());
  const seedAlerts = (list: Drawing[]) => {
    prevAlerted.current = new Map();
    for (const d of list) for (const [id, lv] of alertPairs(d)) {
      prevAlerted.current.set(id, d.id);
      alertSig.current.set(id, sigOf(lv));
    }
  };
  const syncAlerts = (list: Drawing[]) => {
    const now = new Map<number, string>();
    for (const d of list) {
      for (const [id, lv] of alertPairs(d)) {
        now.set(id, d.id);
        const sig = sigOf(lv);
        const was = alertSig.current.get(id);
        if (lv && was !== undefined && was !== sig) {
          alertSig.current.set(id, sig);
          void pxAlertMove(id, lv);
        }
      }
    }
    for (const id of prevAlerted.current.keys()) {
      if (!now.has(id)) {
        alertSig.current.delete(id);
        void pxAlertDel(id).then(refreshAlerts);
      }
    }
    prevAlerted.current = now;
  };
  useEffect(() => {
    refreshAlerts();
    const timer = setInterval(refreshAlerts, 60_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleAlert = async (d: Drawing) => {
    const e = eng.current;
    if (!e) return;
    haptic("select");
    if (d.alert || d.alert2) {
      const ids = [d.alert, d.alert2].filter((x): x is number => !!x);
      e.patchQuiet(d.id, { alert: undefined, alert2: undefined });
      for (const id of ids) {
        alertSig.current.delete(id);
        prevAlerted.current.delete(id);
        await pxAlertDel(id);
      }
      refreshAlerts();
      return;
    }
    const pos = d.type === "long" || d.type === "short";
    const base = `${m.label} · ${TF_LABEL[prefs.tf]}`;
    const want: [PxLevel | null, string][] = pos
      ? [[levelOf(d), `🎯 TP · ${base}`], [levelOf(d, true), `🛑 SL · ${base}`]]
      : [[levelOf(d), base]];
    const ids: number[] = [];
    for (const [lv, note] of want) {
      if (!lv) continue;
      const r = await pxAlertAdd(m.hip3 ?? m.base, lv, lang, note);
      if (r?.ok && r.id) {
        ids.push(r.id);
        alertSig.current.set(r.id, sigOf(lv));
        prevAlerted.current.set(r.id, d.id);
      } else {
        toast(r?.error === "limit" ? t(lang, "chart_alert_limit", { n: r.max ?? 30 }) : t(lang, "chart_alert_err"), "err");
        break;
      }
    }
    if (!ids.length) return;
    e.patchQuiet(d.id, { alert: ids[0], alert2: ids[1], fired: undefined });
    haptic("success");
    const lv = levelOf(d);
    const shown = lv && "price" in lv ? lv.price : null;
    toast(shown !== null
      ? t(lang, "chart_alert_set", { s: m.label, p: fmtPrice(shown, priceDecimals(shown)) })
      : t(lang, "chart_alert_set_line", { s: m.label }));
    refreshAlerts();
  };

  // Движок — один на всё время экрана.
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const e = new Engine(c, {
      hover: (h) => setHover(h),
      scroll: (y) => {
        const el = legendEl.current;
        if (el) el.style.transform = y ? `translateY(${-y}px)` : "";
      },
      needOlder: () => {
        const { sym: s, tf, src: from } = live.current;
        if (!from) return;
        const first = e.firstTime;
        if (first === null) return;
        void loadOlder(s, tf, from, first).then((older) => {
          if (live.current.sym !== s || live.current.tf !== tf) return;
          e.prepend(older);
        }).catch(() => e.olderFailed());
      },
      drawings: (list) => {
        const at = Date.now();
        saveDrawings(live.current.key, list, at);
        pushDrawings(live.current.key, list, at);
        syncAlerts(list);
      },
      select: (d) => setSel(d),
      toolDone: () => setTool("cursor"),
      textNew: (d) => setTextEdit({ id: d.id, text: "" }),
      view: (at) => setAtLatest(at),
      history: (u, r) => setHist({ undo: u, redo: r }),
      rating: (r) => setRating(r),
      pct: (on) => setP({ pct: on }),
      log: (on) => setP({ log: on }),
    });
    eng.current = e;
    return () => {
      e.destroy();
      eng.current = null;
    };
  }, []);

  // Свечи: история и живая последняя.
  useEffect(() => {
    const e = eng.current;
    if (!e) return;
    const ctrl = new AbortController();
    let unsub: (() => void) | null = null;
    setStatus("load");
    setSrc(null);
    live.current.src = null;
    e.setData([], prefs.tf);
    e.setWatermark(`${m.label} · ${TF_LABEL[prefs.tf]}`);
    void loadHistory(sym, prefs.tf, ctrl.signal).then((h) => {
      if (ctrl.signal.aborted) return;
      if (!h) {
        setStatus("none");
        return;
      }
      live.current.src = h.src;
      setSrc(h.src);
      e.setData(h.bars, prefs.tf);
      setStatus("ok");
      setAtLatest(true);
      unsub = subscribe(sym, prefs.tf, h.src, (b) => e.update(b));
    });
    return () => {
      ctrl.abort();
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym, prefs.tf]);

  useEffect(() => eng.current?.setType(prefs.type), [prefs.type]);
  useEffect(() => eng.current?.setIndicators(prefs.inds), [prefs.inds]);
  useEffect(() => eng.current?.setMagnet(prefs.magnet), [prefs.magnet]);
  useEffect(() => eng.current?.setTool(tool), [tool]);
  useEffect(() => eng.current?.setHideDrawings(hideDraw), [hideDraw]);
  useEffect(() => eng.current?.setText((k) => t(lang, k as DictKey)), [lang]);
  useEffect(() => eng.current?.setPct(!!prefs.pct), [prefs.pct]);
  useEffect(() => {
    const e = eng.current;
    if (e && e.log !== !!prefs.log) e.setLog(!!prefs.log);
  }, [prefs.log]);
  // Сравнение: свечи тех же таймфрейма у каждой монеты, раз в минуту — свежие.
  const cmpKey = (prefs.cmp ?? []).join(",");
  useEffect(() => {
    const e = eng.current;
    if (!e) return;
    const list = (prefs.cmp ?? []).filter(Boolean);
    if (!list.length) {
      e.setCompare([]);
      return;
    }
    let alive = true;
    const load = () => void Promise.all(list.map((s) => loadHistory(s, prefs.tf))).then((hs) => {
      if (!alive) return;
      e.setCompare(hs.flatMap((h, k) => (h ? [{ label: market(list[k]!).label, color: CMP_COLORS[k % CMP_COLORS.length]!, bars: h.bars }] : [])));
    });
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpKey, prefs.tf]);
  useEffect(() => {
    const list = loadDrawings(drawKey);
    // Алерты на линиях этой монеты — точка отсчёта для сверки: без неё смена
    // монеты выглядела бы как «линии с алертами удалили», и алерты снялись бы.
    seedAlerts(list);
    eng.current?.setDrawings(list);
    setSel(null);
    refreshAlerts();
    // С сервера — если там новее; если новее здесь — отправить туда.
    const localAt = drawAt(drawKey);
    let alive = true;
    void chartStateGet(drawKey).then((r) => {
      if (!alive || !r?.ok) return;
      const srv = r.draw;
      if (srv && srv.at > localAt) {
        const got = (srv.list as Drawing[]).filter((d) => d && Array.isArray(d.pts));
        saveDrawings(drawKey, got, srv.at);
        seedAlerts(got);
        eng.current?.setDrawings(got);
        refreshAlerts();
      } else if (list.length && (!srv || srv.at < localAt)) pushDrawings(drawKey, list, localAt || Date.now());
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawKey]);

  // Свои данные Wallet Tracker: интерес, фандинг, уровни ликвидаций.
  const wantOi = prefs.inds.some((i) => i.kind === "wt_oi");
  const wantFund = prefs.inds.some((i) => i.kind === "wt_fund");
  const wantLiq = prefs.inds.some((i) => i.kind === "wt_liq");
  const ownSym = m.hip3 ? "" : m.base;
  const oiRange = ["1m", "3m", "5m", "15m"].includes(prefs.tf) ? "1d" : ["30m", "1h", "2h"].includes(prefs.tf) ? "7d" : "30d";
  useEffect(() => {
    const e = eng.current;
    if (!e) return;
    if (!(wantOi || wantFund) || !ownSym) {
      e.setOwn("oi", null);
      e.setOwn("fund", null);
      setOwnNone((x) => ({ ...x, oi: !!(wantOi || wantFund) && !ownSym }));
      return;
    }
    let alive = true;
    void fetchOiHist(ownSym, oiRange).then((r) => {
      if (!alive) return;
      if (!r?.ok) {
        e.setOwn("oi", null);
        e.setOwn("fund", null);
        setOwnNone((x) => ({ ...x, oi: true }));
        return;
      }
      setOwnNone((x) => ({ ...x, oi: false }));
      e.setOwn("oi", { t: r.t.map((s) => s * 1000), v: r.oi });
      const bars = r.fund?.bars ?? [];
      e.setOwn("fund", bars.length ? { t: bars.map((b) => b[0] * 1000), v: bars.map((b) => b[1]) } : null);
    });
    return () => {
      alive = false;
    };
  }, [wantOi, wantFund, ownSym, oiRange]);
  useEffect(() => {
    const e = eng.current;
    if (!e) return;
    if (!wantLiq || !ownSym) {
      e.setLiq(null);
      setOwnNone((x) => ({ ...x, liq: wantLiq && !ownSym }));
      return;
    }
    let alive = true;
    const load = () => void fetchLiqMap(ownSym, "7d").then((r) => {
      if (!alive) return;
      if (!r?.ok) {
        e.setLiq(null);
        setOwnNone((x) => ({ ...x, liq: true }));
        return;
      }
      setOwnNone((x) => ({ ...x, liq: false }));
      e.setLiq({ rows: r.buckets.map((b) => ({ p: b.p, L: b.L.reduce((a, v) => a + v, 0), S: b.S.reduce((a, v) => a + v, 0) })) });
    });
    load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [wantLiq, ownSym]);

  const wantLiqx = prefs.inds.some((i) => i.kind === "wt_liqx");
  const wantWhale = prefs.inds.some((i) => i.kind === "wt_whale");
  const liqStep = Math.min(7 * 86400, Math.round(TF_MS[prefs.tf] / 1000));
  useEffect(() => {
    const e = eng.current;
    if (!e) return;
    if (!wantLiqx || !ownSym) {
      e.setLiqx(null);
      return;
    }
    let alive = true;
    const load = () => void fetchChartLiqs(ownSym, liqStep).then((r) => {
      if (alive) e.setLiqx(r?.ok ? r.rows ?? [] : null);
    });
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [wantLiqx, ownSym, liqStep]);
  useEffect(() => {
    const e = eng.current;
    if (!e) return;
    if (!wantWhale) {
      e.setWhales(null);
      return;
    }
    let alive = true;
    const load = () => void fetchChartWhales(m.hl).then((r) => {
      if (alive) e.setWhales(r?.ok ? r.rows ?? [] : null);
    });
    load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [wantWhale, m.hl]);

  /* ── Действия ────────────────────────────────────────────────────────── */

  const addInd = (k: IndKind) => {
    haptic("select");
    // Свои данные и объём — по одному: второй экземпляр ничего не добавит.
    if ((IND[k].own || k === "vol") && prefs.inds.some((i) => i.kind === k)) return;
    setP({ inds: [...prefs.inds, newInd(k)] });
  };
  const patchInd = (uid: string, patch: Partial<IndInst>) =>
    setP({ inds: prefs.inds.map((i) => (i.uid === uid ? { ...i, ...patch } : i)) });
  const dropInd = (uid: string) => {
    haptic("light");
    setP({ inds: prefs.inds.filter((i) => i.uid !== uid) });
    if (edit === uid) setEdit(null);
  };

  const editing = prefs.inds.find((i) => i.uid === edit) ?? null;

  /* ── Легенда ─────────────────────────────────────────────────────────── */

  const bar = hover?.bar ?? null;
  const dec = bar ? priceDecimals(bar.c) : 2;
  const chg = bar && hover?.prev ? ((bar.c - hover.prev.c) / hover.prev.c) * 100 : null;
  const up = bar ? bar.c >= bar.o : true;

  const indVals = (i: IndInst): string => {
    const v = hover?.vals[i.uid];
    if (!v) return "";
    if (i.kind === "wt_fund") return Number.isFinite(v[0]) ? `${(v[0] ?? 0).toFixed(4)}%` : "";
    if (i.kind === "vol" || i.kind === "obv" || i.kind === "wt_oi") return v.filter(Number.isFinite).map((x) => fmtShort(x)).join(" ");
    const d = IND[i.kind];
    return v.filter(Number.isFinite).map((x) => (d.pane ? fmtShort(x) : fmtPrice(x, dec))).join(" ");
  };

  const toolLabel = (k: DrawType | "cursor") => t(lang, `chart_d_${k}` as DictKey);

  /* Во весь экран: прячем шапку и нижнее меню, в Telegram 8.0+ — ещё и
     полноэкранный режим самого мини-приложения. */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("ch-full", full);
    const wa = webApp();
    try {
      if (full) wa?.requestFullscreen?.();
      else if (wa?.isFullscreen) wa.exitFullscreen?.();
    } catch { /* старый клиент Telegram — хватит CSS */ }
    return () => root.classList.remove("ch-full");
  }, [full]);
  /* В полноэкранном режиме Telegram кладёт поверх приложения свои кнопки
     («Назад», «⌄», «⋮»), а сверху — строка статуса телефона. Панель графика
     уезжала под них вместе с кнопкой выхода: развернуть можно, свернуть —
     нет. Берём отступы у самого Telegram и держим их в CSS-переменных; вышли
     из полного экрана средствами Telegram — выключаем и у себя. */
  useEffect(() => {
    const wa = webApp();
    const root = document.documentElement;
    const sync = () => {
      const s = wa?.safeAreaInset;
      const c = wa?.contentSafeAreaInset;
      root.style.setProperty("--ch-top", `${(s?.top ?? 0) + (c?.top ?? 0)}px`);
      root.style.setProperty("--ch-bottom", `${(s?.bottom ?? 0) + (c?.bottom ?? 0)}px`);
    };
    const onFull = () => {
      sync();
      if (wa && !wa.isFullscreen) setFull(false);
    };
    sync();
    // Вертикальный свайп по графику листает панели индикаторов — не даём ему
    // сворачивать само мини-приложение.
    try {
      wa?.disableVerticalSwipes?.();
    } catch { /* старый клиент */ }
    wa?.onEvent?.("safeAreaChanged", sync);
    wa?.onEvent?.("contentSafeAreaChanged", sync);
    wa?.onEvent?.("fullscreenChanged", onFull);
    return () => {
      wa?.offEvent?.("safeAreaChanged", sync);
      wa?.offEvent?.("contentSafeAreaChanged", sync);
      wa?.offEvent?.("fullscreenChanged", onFull);
      try {
        wa?.enableVerticalSwipes?.();
      } catch { /* старый клиент */ }
    };
  }, []);
  useEffect(() => () => {
    try {
      const wa = webApp();
      if (wa?.isFullscreen) wa.exitFullscreen?.();
    } catch { /* нет — и ладно */ }
  }, []);

  const snap = async () => {
    const e = eng.current;
    if (!e || snapBusy) return;
    haptic("select");
    setSnapBusy(true);
    try {
      const title = `${m.label}${m.hip3 ? "" : "USDT"} · ${TF_LABEL[prefs.tf]}${src ? ` · ${SOURCE_NAME[src]}` : ""}`;
      const last = hover?.bar;
      const sub = last ? `O ${fmtPrice(last.o, dec)}  H ${fmtPrice(last.h, dec)}  L ${fmtPrice(last.l, dec)}  C ${fmtPrice(last.c, dec)}` : "";
      const blob = await e.snapshot(title, sub);
      const b64 = await new Promise<string>((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(",", 2)[1] ?? "");
        r.onerror = () => fail(r.error);
        r.readAsDataURL(blob);
      });
      const r = await chartSnap(b64, title);
      if (r?.ok) {
        haptic("success");
        toast(t(lang, "chart_snap_sent"));
      } else toast(r?.error === "rate" ? t(lang, "chart_snap_rate") : t(lang, "generic_error_retry"), "err");
    } catch {
      toast(t(lang, "generic_error_retry"), "err");
    } finally {
      setSnapBusy(false);
    }
  };

  /* Клавиши — для Telegram на компьютере, как в TradingView. */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const e = eng.current;
      if (!e) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();
      const code = ev.code;
      const tools: Record<string, DrawType> = { KeyH: "hline", KeyJ: "hray", KeyT: "trend", KeyF: "fib", KeyV: "vline", KeyR: "rect", KeyP: "long", KeyM: "measure" };
      let hit = true;
      if (mod && key === "z" && !ev.shiftKey) e.undo();
      else if (mod && (key === "y" || (key === "z" && ev.shiftKey))) e.redo();
      else if (ev.altKey && tools[code]) {
        setP({ tools: true });
        setTool(tools[code]!);
      } else if (key === "escape") {
        setTool("cursor");
        setMenu(null);
        setFlyout(null);
      } else if (key === "delete" || key === "backspace") e.deleteSelected();
      else if (key === "arrowleft") e.nudge(-10);
      else if (key === "arrowright") e.nudge(10);
      else if (key === "+" || key === "=") e.zoomBy(1.25);
      else if (key === "-") e.zoomBy(0.8);
      else hit = false;
      if (hit) ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pickTool = (k: DrawType, g: number) => {
    haptic("select");
    setTool(k);
    setGroupLast((a) => a.map((x, i) => (i === g ? k : x)));
    setFlyout(null);
  };

  return (
    <Frame
      full
      title={t(lang, "chart_title")}
      actions={
        <button
          type="button"
          className={picking ? "chart-pick on" : "chart-pick"}
          aria-expanded={picking}
          onClick={() => {
            haptic("select");
            setPicking(!picking);
          }}
        >
          <CoinIcon sym={label(sym)} size={20} />
          <b className="chart-sym">{label(sym)}</b>
          <span className="chart-caret" aria-hidden="true" />
        </button>
      }
    >
      <div className="ch">
        {/* Верхняя панель: таймфреймы, вид, индикаторы, рисование. */}
        <div className="ch-bar" role="toolbar">
          <div className="ch-tfs">
          {TF_QUICK.map((tf) => (
            <button key={tf} type="button" className={prefs.tf === tf ? "ch-tf on" : "ch-tf"}
              onClick={() => { haptic("select"); setP({ tf }); setMenu(null); }}>
              {TF_LABEL[tf]}
            </button>
          ))}
          <button type="button" className={menu === "tf" || !TF_QUICK.includes(prefs.tf) ? "ch-tf on" : "ch-tf"}
            aria-expanded={menu === "tf"} onClick={() => setMenu(menu === "tf" ? null : "tf")}>
            {TF_QUICK.includes(prefs.tf) ? "⋯" : TF_LABEL[prefs.tf]}
          </button>
          </div>
          <button type="button" className={menu === "type" ? "ch-btn on" : "ch-btn"} aria-label={t(lang, "chart_type")}
            onClick={() => setMenu(menu === "type" ? null : "type")}>
            <ToolIcon k={prefs.type} />
          </button>
          <button type="button" className={prefs.cmp?.length ? "ch-btn on" : "ch-btn"} aria-label={t(lang, "chart_cmp")}
            onClick={() => { haptic("select"); setCmpPick(true); setPicking(true); }}>
            <ToolIcon k="vs" />
          </button>
          <button type="button" className={menu === "ind" ? "ch-btn wide on" : "ch-btn wide"} aria-label={t(lang, "chart_ind")}
            onClick={() => { setMenu(menu === "ind" ? null : "ind"); setIndQ(""); }}>
            <i>ƒx</i>{prefs.inds.length ? <small className="ch-n">{prefs.inds.length}</small> : null}
          </button>
          <button type="button" className={prefs.tools ? "ch-btn on" : "ch-btn"} aria-label={t(lang, "chart_tools")} aria-pressed={prefs.tools}
            onClick={() => { haptic("select"); setP({ tools: !prefs.tools }); if (prefs.tools) setTool("cursor"); }}>
            <ToolIcon k="brush" />
          </button>
          <button type="button" className={alertsOpen ? "ch-btn on" : "ch-btn"} aria-label={t(lang, "chart_alerts")}
            onClick={() => { haptic("select"); setAlertsOpen(!alertsOpen); refreshAlerts(); }}>
            <ToolIcon k="bell" />{alerts.filter((a) => !a.fired).length ? <small className="ch-n">{alerts.filter((a) => !a.fired).length}</small> : null}
          </button>
          <button type="button" className="ch-btn" aria-label={t(lang, "chart_snap")} disabled={snapBusy || status !== "ok"}
            onClick={() => void snap()}>{snapBusy ? "…" : <ToolIcon k="camera" />}</button>
          <button type="button" className={full ? "ch-btn on" : "ch-btn"} aria-label={t(lang, "chart_full")} aria-pressed={full}
            onClick={() => { haptic("select"); setFull(!full); }}><ToolIcon k={full ? "shrink" : "expand"} /></button>
        </div>

        <div className="ch-main">
          {prefs.tools ? (
            <div className="ch-tools" role="toolbar" aria-label={t(lang, "chart_tools")}>
              <button type="button" title={toolLabel("cursor")} aria-label={toolLabel("cursor")}
                className={tool === "cursor" ? "on" : undefined}
                onClick={() => { haptic("select"); setTool("cursor"); setFlyout(null); }}>
                <ToolIcon k="cursor" />
              </button>
              {GROUPS.map((g, gi) => {
                const active = g.tools.includes(tool as DrawType);
                const icon = active ? (tool as DrawType) : groupLast[gi]!;
                return (
                  <button key={g.key} type="button" title={t(lang, g.key)} aria-label={t(lang, g.key)} aria-expanded={flyout === gi}
                    className={active || flyout === gi ? "on grp" : "grp"}
                    onClick={() => { haptic("select"); setFlyout(flyout === gi ? null : gi); }}>
                    <ToolIcon k={icon} />
                  </button>
                );
              })}
              <span className="ch-tools-sep" />
              <button type="button" title={t(lang, "chart_undo")} aria-label={t(lang, "chart_undo")} disabled={!hist.undo}
                onClick={() => { haptic("light"); eng.current?.undo(); }}>
                <ToolIcon k="undo" />
              </button>
              <button type="button" title={t(lang, "chart_redo")} aria-label={t(lang, "chart_redo")} disabled={!hist.redo}
                onClick={() => { haptic("light"); eng.current?.redo(); }}>
                <ToolIcon k="redo" />
              </button>
              <button type="button" title={t(lang, "chart_magnet")} aria-label={t(lang, "chart_magnet")} aria-pressed={prefs.magnet}
                className={prefs.magnet ? "on" : undefined} onClick={() => setP({ magnet: !prefs.magnet })}>
                <ToolIcon k="magnet" />
              </button>
              <button type="button" title={t(lang, "chart_hide_draw")} aria-label={t(lang, "chart_hide_draw")} aria-pressed={hideDraw}
                className={hideDraw ? "on" : undefined} onClick={() => setHideDraw(!hideDraw)}>
                <ToolIcon k="eye" />
              </button>
              <button type="button" title={t(lang, "chart_clear_draw")} aria-label={t(lang, "chart_clear_draw")}
                onClick={() => setConfirmClear(true)}>
                <ToolIcon k="trash" />
              </button>
            </div>
          ) : null}

          <div className="ch-plot" ref={box}>
            <canvas ref={cv} className="ch-cv" />

            {full ? (
              <button type="button" className="ch-exitfull" aria-label={t(lang, "chart_full")}
                onClick={() => { haptic("select"); setFull(false); }}>✕</button>
            ) : null}

            {flyout !== null && prefs.tools ? (
              <div className="ch-fly" role="menu" aria-label={t(lang, GROUPS[flyout]!.key)}>
                <h3>{t(lang, GROUPS[flyout]!.key)}</h3>
                <div className="ch-tiles row">
                  {GROUPS[flyout]!.tools.map((k) => (
                    <button key={k} type="button" role="menuitem" className={tool === k ? "ch-tile on" : "ch-tile"} onClick={() => pickTool(k, flyout)}>
                      <span className="ch-tile-ic"><ToolIcon k={k} /></span>
                      <span className="ch-tile-name">{toolLabel(k)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Легенда: монета, таймфрейм, биржа, OHLC и индикаторы. */}
            <div className="ch-legend" ref={legendEl}>
              <div className="ch-lg-head">
                <b>{m.label}{m.hip3 ? "" : "USDT"}</b>
                <span>· {TF_LABEL[prefs.tf]}</span>
                {src ? <span>· {SOURCE_NAME[src]}</span> : null}
                {status === "ok" ? <span className="ch-live" title={t(lang, "chart_live")} /> : null}
              </div>
              {bar ? (
                <div className={up ? "ch-ohlc up" : "ch-ohlc dn"}>
                  <span>O<b>{fmtPrice(bar.o, dec)}</b></span>
                  <span>H<b>{fmtPrice(bar.h, dec)}</b></span>
                  <span>L<b>{fmtPrice(bar.l, dec)}</b></span>
                  <span>C<b>{fmtPrice(bar.c, dec)}</b></span>
                  {chg !== null ? <b>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</b> : null}
                </div>
              ) : null}
              {prefs.cmp?.length || prefs.pct ? (
                <div className="ch-cmp">
                  {hover?.mainPct !== undefined ? (
                    <span><i style={{ background: "#eaf5ff" }} />{m.label} <b>{hover.mainPct >= 0 ? "+" : ""}{hover.mainPct.toFixed(2)}%</b></span>
                  ) : null}
                  {(prefs.cmp ?? []).map((c, k) => {
                    const v = hover?.cmp?.[k];
                    return (
                      <span key={c}>
                        <i style={{ background: CMP_COLORS[k % CMP_COLORS.length] }} />{market(c).label}{" "}
                        <b>{v && Number.isFinite(v.pct) ? `${v.pct >= 0 ? "+" : ""}${v.pct.toFixed(2)}%` : "…"}</b>
                        <button type="button" className="ch-lg-x" aria-label={t(lang, "chart_remove")}
                          onClick={() => setP({ cmp: (prefs.cmp ?? []).filter((x) => x !== c) })}>×</button>
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {hover?.liq || hover?.wh ? (
                <div className="ch-ohlc ch-own">
                  {hover.liq?.L ? <span>💥L <b className="dn">${fmtShort(hover.liq.L)}</b></span> : null}
                  {hover.liq?.S ? <span>💥S <b className="up">${fmtShort(hover.liq.S)}</b></span> : null}
                  {hover.wh?.buy ? <span>🐋 <b className="up">+${fmtShort(hover.wh.buy)}</b></span> : null}
                  {hover.wh?.sell ? <span>🐋 <b className="dn">−${fmtShort(hover.wh.sell)}</b></span> : null}
                </div>
              ) : null}
              {rating ? (
                <button type="button" className={`ch-rate ${rateKey(rating.total)}`} onClick={() => setRateOpen(true)}>
                  {t(lang, "chart_rate")}: <b>{t(lang, rateKey(rating.total))}</b>
                </button>
              ) : null}
              {prefs.inds.length ? (
                <button type="button" className="ch-lg-fold" aria-expanded={legendOpen} onClick={() => setLegendOpen(!legendOpen)}>
                  <i>ƒx</i> {prefs.inds.length} <span className={legendOpen ? "ch-fold-c on" : "ch-fold-c"} aria-hidden="true" />
                </button>
              ) : null}
              {(legendOpen ? prefs.inds : []).map((i) => {
                const d = IND[i.kind];
                const none = (i.kind === "wt_liq" && ownNone.liq) || ((i.kind === "wt_oi" || i.kind === "wt_fund") && ownNone.oi);
                return (
                  <div key={i.uid} className={i.hidden ? "ch-lg-ind off" : "ch-lg-ind"}>
                    <button type="button" className="ch-lg-name" onClick={() => setEdit(i.uid)}>
                      <span className="ch-dot" style={{ background: i.colors[0] ?? d.lines[0]?.color ?? "#f0b90b" }} />
                      {d.own ? t(lang, indName(i.kind)) : indTitle(i)}
                    </button>
                    <span className="ch-lg-val">{none ? t(lang, "chart_own_none", { s: m.label }) : i.hidden ? "" : indVals(i)}</span>
                    <button type="button" className="ch-lg-x" aria-label={i.hidden ? t(lang, "chart_show") : t(lang, "chart_hide")}
                      onClick={() => patchInd(i.uid, { hidden: !i.hidden })}><ToolIcon k="eye" /></button>
                    <button type="button" className="ch-lg-x" aria-label={t(lang, "chart_remove")} onClick={() => dropInd(i.uid)}>×</button>
                  </div>
                );
              })}
            </div>

            {status === "load" ? <div className="ch-note">{t(lang, "ui_loading")}…</div> : null}
            {status === "none" ? <div className="ch-note">{t(lang, "chart_no_data", { s: m.label })}</div> : null}

            {!atLatest && status === "ok" ? (
              <button type="button" className="ch-latest" aria-label={t(lang, "chart_latest")}
                onClick={() => { haptic("select"); eng.current?.goLatest(); }}>»</button>
            ) : null}

            {/* Выбранный рисунок: цвет, текст, замок, удаление. */}
            {sel ? (
              <div className="ch-selbar">
                {DRAW_COLORS.map((c) => (
                  <button key={c} type="button" className={sel.color === c ? "ch-color on" : "ch-color"} style={{ background: c }}
                    aria-label={c} onClick={() => eng.current?.patchDrawing(sel.id, { color: c })} />
                ))}
                {["hline", "hray", "trend", "ray", "ext", "long", "short"].includes(sel.type) ? (
                  <button type="button" className={sel.alert || sel.alert2 ? "ch-selbtn on" : "ch-selbtn"} onClick={() => void toggleAlert(sel)}>
                    {sel.alert || sel.alert2 ? t(lang, "chart_alert_off")
                      : sel.type === "long" || sel.type === "short" ? t(lang, "chart_alert_tpsl") : t(lang, "chart_alert_on")}
                  </button>
                ) : null}
                {isFib(sel.type) ? (
                  <button type="button" className="ch-selbtn" onClick={() => setFibEdit(true)}>{t(lang, "chart_fib_levels")}</button>
                ) : null}
                {sel.type === "text" ? (
                  <button type="button" className="ch-selbtn" onClick={() => setTextEdit({ id: sel.id, text: sel.text ?? "" })}>
                    {t(lang, "chart_edit_text")}
                  </button>
                ) : null}
                <button type="button" className="ch-selbtn" onClick={() => eng.current?.patchDrawing(sel.id, { locked: !sel.locked })}>
                  {sel.locked ? t(lang, "chart_unlock") : t(lang, "chart_lock")}
                </button>
                <button type="button" className="ch-selbtn dn" aria-label={t(lang, "chart_del")}
                  onClick={() => { haptic("light"); eng.current?.deleteSelected(); }}>
                  <ToolIcon k="trash" />
                </button>
              </div>
            ) : null}

            {tool !== "cursor" ? <div className="ch-toolhint">{toolLabel(tool)}</div> : null}
          </div>
        </div>

        {/* Меню: таймфреймы, вид графика. */}
        {menu === "tf" ? (
          <div className="ch-pop" role="menu">
            <div className="ch-grid">
              {TFS.map((tf) => (
                <button key={tf} type="button" className={prefs.tf === tf ? "on" : undefined}
                  onClick={() => { haptic("select"); setP({ tf }); setMenu(null); }}>{TF_LABEL[tf]}</button>
              ))}
            </div>
          </div>
        ) : null}
        {menu === "type" ? (
          <div className="ch-pop" role="menu">
            <h3>{t(lang, "chart_type")}</h3>
            <div className="ch-tiles">
              {TYPES.map((k) => (
                <button key={k} type="button" className={prefs.type === k ? "ch-tile on" : "ch-tile"}
                  onClick={() => { haptic("select"); setP({ type: k }); setMenu(null); }}>
                  <span className="ch-tile-ic"><ToolIcon k={k} /></span>
                  <span className="ch-tile-name">{t(lang, `chart_t_${k}` as DictKey)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Индикаторы: поиск, свои данные первыми. */}
        {menu === "ind" ? (
          <div className="ch-sheet" role="dialog" aria-label={t(lang, "chart_ind")}>
            <div className="ch-sheet-hd">
              <b>{t(lang, "chart_ind")}</b>
              <button type="button" className="ch-close" onClick={() => setMenu(null)}>{t(lang, "chart_ok")}</button>
            </div>
            <input className="find" value={indQ} onChange={(e) => setIndQ(e.target.value)} placeholder={t(lang, "chart_ind_search")}
              aria-label={t(lang, "chart_ind_search")} />
            {([["chart_ind_own", OWN_KINDS], ["chart_ind_auto", AUTO_KINDS], ["chart_ind_over", OVERLAY_KINDS], ["chart_ind_osc", PANE_KINDS]] as [DictKey, IndKind[]][]).map(([head, kinds]) => {
              const q = indQ.trim().toLowerCase();
              const list = kinds.filter((k) => !q || t(lang, indName(k)).toLowerCase().includes(q) || IND[k].short.toLowerCase().includes(q));
              if (!list.length) return null;
              return (
                <section key={head} className={head === "chart_ind_own" ? "ch-ind-grp own" : "ch-ind-grp"}>
                  <h3>{head === "chart_ind_own" ? "★ " : ""}{t(lang, head)}</h3>
                  {list.map((k) => {
                    const n = prefs.inds.filter((i) => i.kind === k).length;
                    return (
                      <button key={k} type="button" className={n ? "ch-row on" : "ch-row"} onClick={() => addInd(k)}>
                        <span className="ch-row-name">{t(lang, indName(k))}</span>
                        {n ? <span className="ch-row-n">{t(lang, "chart_ind_on", { n })}</span> : <span className="ch-row-add">+</span>}
                      </button>
                    );
                  })}
                </section>
              );
            })}
          </div>
        ) : null}

        {/* Настройки индикатора. */}
        {editing ? (
          <div className="ch-sheet" role="dialog" aria-label={t(lang, "chart_settings")}>
            <div className="ch-sheet-hd">
              <b>{t(lang, indName(editing.kind))}</b>
              <button type="button" className="ch-close" onClick={() => setEdit(null)}>{t(lang, "chart_ok")}</button>
            </div>
            {IND[editing.kind].params.map((p, k) => (
              <label key={p.name} className="ch-param">
                <span>{p.name}</span>
                <input type="number" inputMode="decimal" min={p.min} max={p.max} step={p.step}
                  value={editing.params[k] ?? p.def}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    const params = editing.params.slice();
                    params[k] = Math.max(p.min, Math.min(p.max, v));
                    patchInd(editing.uid, { params });
                  }} />
              </label>
            ))}
            {IND[editing.kind].lines.map((l, k) => (
              <div key={l.name} className="ch-param">
                <span>{l.name}</span>
                <span className="ch-colors">
                  {[l.color, ...DRAW_COLORS].filter((c, i, a) => a.indexOf(c) === i).slice(0, 6).map((c) => (
                    <button key={c} type="button" className={(editing.colors[k] ?? l.color) === c ? "ch-color on" : "ch-color"}
                      style={{ background: c }} aria-label={c}
                      onClick={() => { const colors = editing.colors.slice(); colors[k] = c; patchInd(editing.uid, { colors }); }} />
                  ))}
                </span>
              </div>
            ))}
            <div className="ch-sheet-acts">
              <button type="button" className="ch-selbtn" onClick={() => patchInd(editing.uid, { hidden: !editing.hidden })}>
                {editing.hidden ? t(lang, "chart_show") : t(lang, "chart_hide")}
              </button>
              {IND[editing.kind].params.length ? (
                <button type="button" className="ch-selbtn" onClick={() => {
                  const d = IND[editing.kind];
                  patchInd(editing.uid, { params: d.params.map((p) => p.def), colors: d.lines.map((l) => l.color) });
                }}>{t(lang, "chart_defaults")}</button>
              ) : null}
              <button type="button" className="ch-selbtn dn" onClick={() => dropInd(editing.uid)}>{t(lang, "chart_remove")}</button>
            </div>
          </div>
        ) : null}

        {/* Текст рисунка. */}
        {textEdit ? (
          <div className="ch-sheet small" role="dialog" aria-label={t(lang, "chart_edit_text")}>
            <form onSubmit={(e) => {
              e.preventDefault();
              eng.current?.patchDrawing(textEdit.id, { text: textEdit.text.trim() || "Text" });
              setTextEdit(null);
            }}>
              <input className="find" autoFocus maxLength={80} value={textEdit.text} placeholder={t(lang, "chart_text_ph")}
                onChange={(e) => setTextEdit({ ...textEdit, text: e.target.value })} />
              <div className="ch-sheet-acts">
                <button type="submit" className="ch-selbtn on">{t(lang, "chart_ok")}</button>
              </div>
            </form>
          </div>
        ) : null}

        {/* Уровни Фибоначчи — любые из двадцати, плюс продление вправо. */}
        {fibEdit && sel && isFib(sel.type) ? (() => {
          const cur = sel.levels ?? (sel.type === "fib" ? FIB_DEF : FIBEXT_DEF);
          return (
            <div className="ch-sheet small" role="dialog" aria-label={t(lang, "chart_fib_levels")}>
              <div className="ch-sheet-hd">
                <b>{t(lang, "chart_fib_levels")}</b>
                <button type="button" className="ch-close" onClick={() => setFibEdit(false)}>{t(lang, "chart_ok")}</button>
              </div>
              <div className="ch-fibs">
                {FIB_ALL.map((lv) => {
                  const on = cur.includes(lv);
                  return (
                    <button key={lv} type="button" className={on ? (lv === 0.618 || lv === 0.65 ? "on gold" : "on") : undefined}
                      onClick={() => {
                        const next = on ? cur.filter((x) => x !== lv) : [...cur, lv].sort((a, b) => a - b);
                        eng.current?.patchDrawing(sel.id, { levels: next });
                      }}>{lv}</button>
                  );
                })}
              </div>
              <p className="ch-hint">{t(lang, "chart_fib_gold")}</p>
              <div className="ch-sheet-acts">
                <button type="button" className={sel.extend ? "ch-selbtn on" : "ch-selbtn"}
                  onClick={() => eng.current?.patchDrawing(sel.id, { extend: !sel.extend })}>{t(lang, "chart_fib_ext")}</button>
                <button type="button" className="ch-selbtn" onClick={() => eng.current?.patchDrawing(sel.id, { levels: undefined })}>
                  {t(lang, "chart_defaults")}
                </button>
              </div>
            </div>
          );
        })() : null}

        {/* Технический рейтинг: что думают 26 индикаторов — словами. */}
        {rateOpen && rating ? (
          <div className="ch-sheet" role="dialog" aria-label={t(lang, "chart_rate")}>
            <div className="ch-sheet-hd">
              <b>{t(lang, "chart_rate")} · {m.label} · {TF_LABEL[prefs.tf]}</b>
              <button type="button" className="ch-close" onClick={() => setRateOpen(false)}>{t(lang, "chart_ok")}</button>
            </div>
            <div className={`ch-gauge ${rateKey(rating.total)}`}>
              <div className="ch-gauge-bar"><span style={{ left: `${((rating.total + 1) / 2) * 100}%` }} /></div>
              <div className="ch-gauge-lbl">
                <span>{t(lang, "chart_r_ss")}</span><span>{t(lang, "chart_r_n")}</span><span>{t(lang, "chart_r_sb")}</span>
              </div>
              <b>{t(lang, rateKey(rating.total))}</b>
            </div>
            {([["chart_rate_osc", rating.oscItems, rating.osc], ["chart_rate_ma", rating.maItems, rating.ma]] as const).map(([head, items, score]) => (
              <section key={head} className="ch-rate-grp">
                <h3>{t(lang, head)} · <span className={rateKey(score)}>{t(lang, rateKey(score))}</span>
                  <small> ▲{items.filter((x) => x.vote > 0).length} ●{items.filter((x) => x.vote === 0).length} ▼{items.filter((x) => x.vote < 0).length}</small>
                </h3>
                {items.map((x) => (
                  <div key={x.name} className="ch-rate-row">
                    <span>{x.name}</span>
                    <span className="dim">{head === "chart_rate_ma" ? fmtPrice(x.value, dec) : fmtShort(x.value)}</span>
                    <b className={x.vote > 0 ? "chart_r_b" : x.vote < 0 ? "chart_r_s" : "chart_r_n"}>
                      {t(lang, x.vote > 0 ? "chart_r_b" : x.vote < 0 ? "chart_r_s" : "chart_r_n")}
                    </b>
                  </div>
                ))}
              </section>
            ))}
            <p className="ch-hint">{t(lang, "chart_rate_note")}</p>
          </div>
        ) : null}

        {alertsOpen ? (
          <div className="ch-sheet" role="dialog" aria-label={t(lang, "chart_alerts")}>
            <div className="ch-sheet-hd">
              <b>{t(lang, "chart_alerts")}</b>
              <button type="button" className="ch-close" onClick={() => setAlertsOpen(false)}>{t(lang, "chart_ok")}</button>
            </div>
            {alerts.length ? alerts.map((a) => (
              <div key={a.id} className={a.fired ? "ch-alert fired" : "ch-alert"}>
                <button type="button" className="ch-alert-main" onClick={() => { setAlertsOpen(false); pick(a.sym); }}>
                  <CoinIcon sym={label(a.sym)} size={24} />
                  <span>
                    <b>{label(a.sym)} {a.dir > 0 ? "↑" : "↓"} {fmtPrice(a.price, priceDecimals(a.price))}{a.kind === "l" ? ` · ${t(lang, "chart_alert_line")}` : ""}</b>
                    <small>{a.fired ? `✓ ${t(lang, "chart_alert_fired")} · ${new Date(a.fired * 1000).toLocaleString(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : t(lang, "chart_alert_wait")}
                      {a.note ? ` · ${a.note}` : ""}</small>
                  </span>
                </button>
                <button type="button" className="ch-lg-x" aria-label={t(lang, "chart_del")} onClick={() => {
                  haptic("light");
                  const e = eng.current;
                  const d = e?.allDrawings.find((x) => x.alert === a.id || x.alert2 === a.id);
                  if (e && d) e.patchQuiet(d.id, d.alert === a.id ? { alert: undefined } : { alert2: undefined });
                  alertSig.current.delete(a.id);
                  prevAlerted.current.delete(a.id);
                  setAlerts((xs) => xs.filter((x) => x.id !== a.id));
                  void pxAlertDel(a.id);
                }}>×</button>
              </div>
            )) : <p className="ch-hint">{t(lang, "chart_alert_none")}</p>}
          </div>
        ) : null}

        {confirmClear ? (
          <div className="ch-sheet small" role="alertdialog">
            <p>{t(lang, "chart_clear_q", { s: m.label })}</p>
            <div className="ch-sheet-acts">
              <button type="button" className="ch-selbtn" onClick={() => setConfirmClear(false)}>{t(lang, "chart_cancel")}</button>
              <button type="button" className="ch-selbtn dn" onClick={() => {
                haptic("light");
                eng.current?.clearDrawings();
                setSel(null);
                setConfirmClear(false);
              }}>{t(lang, "chart_del")}</button>
            </div>
          </div>
        ) : null}

        {gest && status === "ok" && !prefs.tools && !sel ? (
          <p className="ch-gest">{t(lang, "chart_gest")}</p>
        ) : null}
      </div>

      {picking ? (
        <div className="chart-picker" role="dialog" aria-label={t(lang, "chart_pick")}>
          <div className="ch-seg" role="tablist">
            <button type="button" role="tab" aria-selected={!cmpPick} className={!cmpPick ? "on" : undefined} onClick={() => setCmpPick(false)}>
              {t(lang, "chart_open")}
            </button>
            <button type="button" role="tab" aria-selected={cmpPick} className={cmpPick ? "on" : undefined} onClick={() => setCmpPick(true)}>
              + {t(lang, "chart_cmp")}
            </button>
          </div>
          {cmpPick ? <p className="note dim">{t(lang, "chart_cmp_hint")}</p> : null}
          <form
            className="chart-find"
            onSubmit={(e) => {
              e.preventDefault();
              pick(typed);
            }}
          >
            <input
              className="find"
              value={query}
              autoFocus
              placeholder={t(lang, "chart_search")}
              onChange={(e) => setQuery(e.target.value)}
              inputMode="search"
              autoCapitalize="characters"
              aria-label={t(lang, "chart_search")}
            />
            <button type="submit" className="chart-go" disabled={!typed}>
              {t(lang, "chart_open")}
            </button>
          </form>
          {typed ? (
            <div className="chart-results">
              {results[0]?.s !== typed ? (
                <button type="button" className="chart-res typed" onClick={() => pick(typed)}>
                  <CoinIcon sym={typed} size={26} />
                  <span className="chart-res-main">
                    <b>{t(lang, "chart_open")} «{typed}»</b>
                  </span>
                </button>
              ) : null}
              {results.map((r) => (
                <button key={r.t ?? r.s} type="button" className="chart-res" onClick={() => pick(r.t ?? r.s)}>
                  <CoinIcon sym={r.s} size={26} />
                  <span className="chart-res-main">
                    <b>{r.s}</b>
                    <small>
                      {[r.c === "rwa" ? t(lang, "ui_cls_rwa") : "", ...r.v.map((v) => VENUE_NAME[v] ?? v)]
                        .filter(Boolean)
                        .join(" · ") || t(lang, "chart_in_app")}
                    </small>
                  </span>
                </button>
              ))}
              {!dir ? <p className="note dim">{t(lang, "ui_loading")}</p> : null}
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="chart-group">
                <h3>{t(lang, g.key)}</h3>
                <div className="chart-chips">
                  {g.list.map((s) => (
                    <button key={s} type="button" className={s === sym ? "on" : undefined} onClick={() => pick(s)}>
                      <CoinIcon sym={s} size={18} />
                      {s}
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      ) : null}
    </Frame>
  );
}
