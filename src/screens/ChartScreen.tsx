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
import { haptic } from "../lib/telegram";
import { fetchLiqMap, fetchOiHist, fetchSymbols, peekSymbols } from "../lib/api";
import type { SymbolRow } from "../lib/types";
import { CoinIcon } from "../components/CoinIcon";
import { loadHistory, loadOlder, market, SOURCE_NAME, subscribe, TFS, type Source, type Tf } from "../chart/data";
import { Engine, fmtPrice, fmtShort, priceDecimals, type ChartType, type Hover, type Tool } from "../chart/engine";
import {
  IND, indTitle, newInd, OVERLAY_KINDS, OWN_KINDS, PANE_KINDS, type IndInst, type IndKind,
} from "../chart/indicators";
import { DRAW_COLORS, type DrawType, type Drawing } from "../chart/draw";

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
}

const PREFS_KEY = "wt-chart-v1";
const DRAW_KEY = "wt-chart-draw-v1";

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

function saveDrawings(sym: string, list: Drawing[]) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAW_KEY) || "{}") as Record<string, Drawing[]>;
    if (list.length) all[sym] = list;
    else delete all[sym];
    localStorage.setItem(DRAW_KEY, JSON.stringify(all));
  } catch { /* места нет — рисунки живут до закрытия */ }
}

/* ── Подписи ───────────────────────────────────────────────────────────── */

const TF_LABEL: Record<Tf, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "2h": "2H", "4h": "4H",
  "6h": "6H", "12h": "12H", "1d": "1D", "3d": "3D", "1w": "1W", "1M": "1M",
};
const TF_QUICK: Tf[] = ["15m", "1h", "4h", "1d"];
const TYPES: ChartType[] = ["candles", "hollow", "heikin", "bars", "line", "area"];
const TOOLS: (DrawType | "cursor")[] = [
  "cursor", "trend", "ray", "ext", "hline", "hray", "vline", "channel", "rect", "fib", "long", "short", "measure", "text", "brush",
];

const indName = (k: IndKind) => `chart_i_${k}` as DictKey;

/* Значки инструментов — тонкие линии, как у TradingView. */
function ToolIcon({ k }: { k: DrawType | "cursor" | "magnet" | "eye" | "trash" | ChartType }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const body: Record<string, ReactNode> = {
    cursor: <path {...p} d="M6 3l12 7-5 1.5L10.5 17z" />,
    trend: <><path {...p} d="M5 18L19 6" /><circle cx="5" cy="18" r="1.8" fill="currentColor" /><circle cx="19" cy="6" r="1.8" fill="currentColor" /></>,
    ray: <><path {...p} d="M5 18L21 4" /><circle cx="5" cy="18" r="1.8" fill="currentColor" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></>,
    ext: <><path {...p} d="M2 20L22 4" /><circle cx="8" cy="15" r="1.8" fill="currentColor" /><circle cx="16" cy="9" r="1.8" fill="currentColor" /></>,
    hline: <><path {...p} d="M2 12h20" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></>,
    hray: <><path {...p} d="M7 12h15" /><circle cx="7" cy="12" r="1.8" fill="currentColor" /></>,
    vline: <><path {...p} d="M12 2v20" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></>,
    channel: <><path {...p} d="M3 14L17 5M7 19L21 10" /><path {...p} strokeDasharray="2 2" d="M5 16.5L19 7.5" /></>,
    rect: <><rect {...p} x="4" y="6" width="16" height="12" rx="1" /></>,
    fib: <><path {...p} d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path {...p} strokeDasharray="2 2" d="M5 19L19 5" /></>,
    long: <><rect x="4" y="5" width="16" height="7" fill="rgba(61,220,151,.35)" stroke="#3ddc97" strokeWidth="1.3" /><rect x="4" y="12" width="16" height="5" fill="rgba(255,92,119,.35)" stroke="#ff5c77" strokeWidth="1.3" /></>,
    short: <><rect x="4" y="12" width="16" height="7" fill="rgba(61,220,151,.35)" stroke="#3ddc97" strokeWidth="1.3" /><rect x="4" y="7" width="16" height="5" fill="rgba(255,92,119,.35)" stroke="#ff5c77" strokeWidth="1.3" /></>,
    measure: <><path {...p} d="M4 17L17 4l3 3L7 20z" /><path {...p} d="M8 13l2 2M11 10l2 2M14 7l2 2" /></>,
    text: <path {...p} d="M5 6V4h14v2M12 4v16M9 20h6" />,
    brush: <path {...p} d="M4 18c3 0 3-4 6-4s2 5 6 3 3-8 4-11" />,
    magnet: <path {...p} d="M6 4v8a6 6 0 0012 0V4M6 8h4M14 8h4" />,
    eye: <><path {...p} d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle {...p} cx="12" cy="12" r="3" /></>,
    trash: <path {...p} d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
    candles: <><path {...p} d="M7 3v18M17 5v14" /><rect x="5" y="7" width="4" height="9" fill="currentColor" /><rect {...p} x="15" y="8" width="4" height="7" /></>,
    hollow: <><path {...p} d="M7 3v18M17 5v14" /><rect {...p} x="5" y="7" width="4" height="9" /><rect x="15" y="8" width="4" height="7" fill="currentColor" /></>,
    heikin: <><path {...p} d="M7 4v16M17 6v12" /><rect x="5" y="7" width="4" height="10" fill="currentColor" opacity=".6" /><rect x="15" y="9" width="4" height="6" fill="currentColor" opacity=".6" /></>,
    bars: <path {...p} d="M8 4v16M5 8h3M8 16h3M16 6v12M13 9h3M16 15h3" />,
    line: <path {...p} d="M3 17l5-6 4 3 5-8 4 4" />,
    area: <><path d="M3 17l5-6 4 3 5-8 4 4v10H3z" fill="currentColor" opacity=".3" /><path {...p} d="M3 17l5-6 4 3 5-8 4 4" /></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">{body[k]}</svg>;
}

export function ChartScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const saved = useApp((s) => s.tvSym);
  const setSaved = useApp((s) => s.setTvSym);
  const wallets = useLive((s) => s.wallets);
  const flow = useLive((s) => s.flow);

  const [sym, setSym] = useState(() => (arg ? arg.toUpperCase() : saved || "BTC"));
  const [picking, setPicking] = useState(false);
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
    setSym(v);
    setSaved(v);
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
    const next = { ...p, ...patch };
    savePrefs(next);
    return next;
  });
  const m = market(sym);
  const drawKey = m.hip3 ?? m.base;

  const box = useRef<HTMLDivElement>(null);
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

  // Движок — один на всё время экрана.
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const e = new Engine(c, {
      hover: (h) => setHover(h),
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
      drawings: (list) => saveDrawings(live.current.key, list),
      select: (d) => setSel(d),
      toolDone: () => setTool("cursor"),
      textNew: (d) => setTextEdit({ id: d.id, text: "" }),
      view: (at) => setAtLatest(at),
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
  useEffect(() => {
    eng.current?.setDrawings(loadDrawings(drawKey));
    setSel(null);
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
    return v.map((x, k) => (Number.isFinite(x) ? (d.pane ? fmtShort(x) : fmtPrice(x, dec)) : (d.lines[k] ? "∅" : ""))).filter(Boolean).join(" ");
  };

  const toolLabel = (k: DrawType | "cursor") => t(lang, `chart_d_${k}` as DictKey);

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
          <span className="ch-sep" />
          <button type="button" className={menu === "type" ? "ch-btn on" : "ch-btn"} aria-label={t(lang, "chart_type")}
            onClick={() => setMenu(menu === "type" ? null : "type")}>
            <ToolIcon k={prefs.type} />
          </button>
          <button type="button" className={menu === "ind" ? "ch-btn wide on" : "ch-btn wide"} aria-label={t(lang, "chart_ind")}
            onClick={() => { setMenu(menu === "ind" ? null : "ind"); setIndQ(""); }}>
            <i>ƒx</i>{prefs.inds.length ? <small className="ch-n">{prefs.inds.length}</small> : null}
          </button>
          <button type="button" className={prefs.tools ? "ch-btn on" : "ch-btn"} aria-label={t(lang, "chart_tools")} aria-pressed={prefs.tools}
            onClick={() => { haptic("select"); setP({ tools: !prefs.tools }); if (prefs.tools) setTool("cursor"); }}>
            <ToolIcon k="brush" />
          </button>
        </div>

        <div className="ch-main">
          {prefs.tools ? (
            <div className="ch-tools" role="toolbar" aria-label={t(lang, "chart_tools")}>
              {TOOLS.map((k) => (
                <button key={k} type="button" title={toolLabel(k)} aria-label={toolLabel(k)}
                  className={tool === k ? "on" : undefined}
                  onClick={() => { haptic("select"); setTool(tool === k && k !== "cursor" ? "cursor" : k); }}>
                  <ToolIcon k={k} />
                </button>
              ))}
              <span className="ch-tools-sep" />
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

            {/* Легенда: монета, таймфрейм, биржа, OHLC и индикаторы. */}
            <div className="ch-legend">
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
            {TYPES.map((k) => (
              <button key={k} type="button" className={prefs.type === k ? "ch-row on" : "ch-row"}
                onClick={() => { haptic("select"); setP({ type: k }); setMenu(null); }}>
                <ToolIcon k={k} /> {t(lang, `chart_t_${k}` as DictKey)}
              </button>
            ))}
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
            {([["chart_ind_own", OWN_KINDS], ["chart_ind_over", OVERLAY_KINDS], ["chart_ind_osc", PANE_KINDS]] as [DictKey, IndKind[]][]).map(([head, kinds]) => {
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

        {confirmClear ? (
          <div className="ch-sheet small" role="alertdialog">
            <p>{t(lang, "chart_clear_q", { s: m.label })}</p>
            <div className="ch-sheet-acts">
              <button type="button" className="ch-selbtn" onClick={() => setConfirmClear(false)}>{t(lang, "chart_cancel")}</button>
              <button type="button" className="ch-selbtn dn" onClick={() => {
                haptic("light");
                eng.current?.setDrawings([]);
                saveDrawings(drawKey, []);
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
