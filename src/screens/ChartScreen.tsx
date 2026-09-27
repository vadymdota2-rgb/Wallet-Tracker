/**
 * График на весь экран — TradingView.
 *
 * Открывается из бокового меню. Любую монету можно выбрать двумя способами:
 * кнопкой монеты в шапке (популярные, ваши кошельки, сигналы Cortex, NetFlow
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
import { CoinIcon } from "../components/CoinIcon";

const POPULAR = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "TON", "HYPE", "SUI", "PEPE", "LINK", "AVAX"];

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
  const cortex = useLive((s) => s.cortex);
  const flow = useLive((s) => s.flow);

  const [sym, setSym] = useState(() => (arg ? arg.toUpperCase() : saved || "BTC"));
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () =>
      [
        { key: "chart_mine" as const, list: uniq(wallets.flatMap((w) => [...w.pos.map((p) => p.sym), ...(w.holds ?? []).map((h) => h.sym)]), 12) },
        { key: "chart_signals" as const, list: uniq(cortex.list.map((s) => s.sym), 12) },
        { key: "chart_popular" as const, list: POPULAR },
        { key: "chart_flow" as const, list: uniq((flow["24"]?.rows ?? []).map((r) => r.sym), 12) },
      ].filter((g) => g.list.length > 0),
    [wallets, cortex.list, flow],
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

  const typed = query.trim().toUpperCase();
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
          <CoinIcon sym={sym} size={20} />
          <b className="chart-sym">{sym}</b>
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
          {groups.map((g) => {
            const list = typed ? g.list.filter((s) => s.includes(typed)) : g.list;
            if (!list.length) return null;
            return (
              <section key={g.key} className="chart-group">
                <h3>{t(lang, g.key)}</h3>
                <div className="chart-chips">
                  {list.map((s) => (
                    <button key={s} type="button" className={s === sym ? "on" : undefined} onClick={() => pick(s)}>
                      <CoinIcon sym={s} size={18} />
                      {s}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          <p className="note dim">{t(lang, "chart_hint")}</p>
        </div>
      ) : null}
      <div ref={host} className="tradingview-widget-container chart-frame" data-symbol={tv} />
    </Frame>
  );
}
