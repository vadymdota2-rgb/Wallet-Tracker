/**
 * График на весь экран — TradingView.
 *
 * Открывается из бокового меню. Любую монету можно выбрать двумя способами:
 * кнопкой монеты в шапке (популярные, ваши кошельки, NetFlow
 * или любой тикер вручную) или поиском самого TradingView прямо на графике.
 * Таймфреймы, индикаторы и рисование — тоже его, все сразу.
 *
 * Последняя открытая монета запоминается: вернулся в меню — график тот же.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { TV_EMBED_SRC, tvConfig, tvSymbol } from "../lib/tradingview";
import { fetchSymbols, peekSymbols } from "../lib/api";
import type { SymbolRow } from "../lib/types";
import { CoinIcon } from "../components/CoinIcon";

const POPULAR = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "TON", "HYPE", "SUI", "PEPE", "LINK", "AVAX"];
const VENUE_NAME: Record<string, string> = { binance: "Binance", bybit: "Bybit", hl: "Hyperliquid" };
const MAX_RESULTS = 40;

/** Совпадения по тикеру: точное, потом с начала, потом внутри. Порядок внутри
 *  группы — как в справочнике: там впереди то, что торгуется на большем
 *  числе бирж. */
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

/** Без повторов, в исходном порядке, прописными — «btc» и «BTC» одна монета. */
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

export function ChartScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const saved = useApp((s) => s.tvSym);
  const setSaved = useApp((s) => s.setTvSym);
  const wallets = useLive((s) => s.wallets);
  const flow = useLive((s) => s.flow);

  const [sym, setSym] = useState(() => (arg ? arg.toUpperCase() : saved || "BTC"));
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  /* Справочник всех монет — для поиска. Подгружается при запуске вместе с
     остальным, а если ещё не пришёл — при открытии выбора. */
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
    const s = next.trim().toUpperCase();
    if (!s) return;
    haptic("select");
    setSym(s);
    setSaved(s);
    setPicking(false);
    setQuery("");
  };

  const typed = query.trim().toUpperCase().replace(/\s+/g, "");
  /* Монеты, которые приложение знает, а биржевой справочник нет (токены BSC
     из кошельков и потока), — тоже в поиске. */
  const known = useMemo<SymbolRow[]>(() => {
    const seen = new Set((dir ?? []).map((r) => r.s));
    return groups.flatMap((g) => g.list).filter((s) => !seen.has(s)).map((s) => ({ s, v: [] }));
  }, [dir, groups]);
  const results = typed ? search([...(dir ?? []), ...known], typed) : [];
  const tv = tvSymbol(sym);

  /* Официальный код виджета: контейнер, место под окно, строка атрибуции и
     скрипт с настройками внутри — ровно как в их конструкторе. Скрипт читает
     настройки из себя (document.currentScript), поэтому он вставляется, а не
     импортируется. При смене монеты или языка контейнер собирается заново:
     виджет не умеет менять символ снаружи. */
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = host.current;
    if (!box) return;
    box.replaceChildren();
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    const copy = document.createElement("div");
    copy.className = "tradingview-widget-copyright";
    const a = document.createElement("a");
    a.href = "https://www.tradingview.com/";
    a.rel = "noopener nofollow";
    a.target = "_blank";
    const span = document.createElement("span");
    span.className = "blue-text";
    span.textContent = "Track all markets on TradingView";
    a.appendChild(span);
    copy.appendChild(a);
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = TV_EMBED_SRC;
    script.async = true;
    script.innerHTML = JSON.stringify(tvConfig(tv, lang));
    box.append(widget, copy, script);
    return () => box.replaceChildren();
  }, [tv, lang]);

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
              {/* Нашлась ровно такая монета — она первой строкой, с биржами.
                  Нет — введённое всё равно можно открыть: TradingView может
                  знать то, чего нет в нашем справочнике. */}
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
          <p className="note dim">{t(lang, "chart_hint")}</p>
        </div>
      ) : null}
      <div ref={host} className="tradingview-widget-container chart-frame" data-symbol={tv} />
    </Frame>
  );
}
