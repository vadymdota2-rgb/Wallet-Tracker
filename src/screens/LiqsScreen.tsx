/**
 * Ликвидации в реальном времени: настоящие принудительные закрытия позиций
 * на Binance, Bybit, OKX, Gate и HTX — в отличие от карты ликвидаций, где
 * уровни лишь оценка.
 *
 * Сверху — сколько ликвидировано за окно и чья сторона пострадала больше,
 * с выводом словами. Ниже — столбики по времени (шорты вверх, лонги вниз:
 * сторону говорит и место, и цвет), биржи, монеты и живая лента, которая
 * обновляется сама каждые пятнадцать секунд.
 *
 * Цвета — как принято на рынке и как у Coinglass: ликвидации лонгов
 * красные (цену выбивали вниз), шортов — зелёные.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px, since, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchLiqs, peekLiqs, refreshLiqs } from "../lib/api";
import { useNow } from "../lib/tick";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { LiqEv, LiqsReply } from "../lib/types";
import { Frame } from "./Screen";

type Lang = Parameters<typeof t>[0];
type Win = "1h" | "4h" | "12h" | "24h" | "7d";

const WINS: Win[] = ["1h", "4h", "12h", "24h", "7d"];
const MINS = [0, 10_000, 100_000, 1_000_000];
const LIVE_EVERY = 15_000;
/** Биржа «в эфире», если событие от неё было не раньше чем пять минут назад. */
const LIVE_FRESH = 300;
const FEED_PAGE = 25;

function winLabel(lang: Lang, w: Win): string {
  return t(lang, `lqs_w_${w}` as Parameters<typeof t>[1]);
}

/** Время свечи: в окне до суток — часы, дальше — день и час. */
function tick(ts: number, long: boolean): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return long ? `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")} ${hh}:${mm}` : `${hh}:${mm}`;
}

/**
 * Столбики по времени: шорты вверх от нуля, лонги вниз, общая шкала. Подписи
 * у трёх крупнейших столбиков; касание — цифры корзины под графиком.
 */
function Bars({ lang, r, sel, onSel }: { lang: Lang; r: LiqsReply; sel: number | null; onSel: (i: number | null) => void }) {
  const W = 340;
  const H = 150;
  const mid = H / 2;
  const n = r.bars.length;
  const max = Math.max(1, ...r.bars.map(([, L, S]) => Math.max(L, S)));
  const bw = (W - 4) / n;
  const gap = Math.min(2, bw * 0.25);
  const h = (v: number) => (v / max) * (mid - 8);
  const long = r.win === "7d";
  const marks = [0, Math.floor(n / 2), n - 1];
  return (
    <svg className="lqs-bars" viewBox={`0 0 ${W} ${H + 16}`} role="img" aria-label={t(lang, "lqs_bars")}>
      <line x1={0} x2={W} y1={mid} y2={mid} className="lqs-zero" />
      {r.bars.map(([ts, L, S], i) => (
        <g key={ts} onClick={() => { haptic("select"); onSel(sel === i ? null : i); }} className={sel === i ? "on" : ""}>
          <rect x={2 + i * bw} y={0} width={bw} height={H} fill="transparent" />
          {S > 0 ? <rect className="s" x={2 + i * bw + gap / 2} y={mid - h(S)} width={bw - gap} height={Math.max(1, h(S))} rx={Math.min(3, (bw - gap) / 2)} /> : null}
          {L > 0 ? <rect className="l" x={2 + i * bw + gap / 2} y={mid} width={bw - gap} height={Math.max(1, h(L))} rx={Math.min(3, (bw - gap) / 2)} /> : null}
        </g>
      ))}
      {marks.map((i) => {
        const b = r.bars[i];
        if (!b) return null;
        return (
          <text key={i} x={2 + i * bw + bw / 2} y={H + 12} className="lqs-ax"
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {tick(b[0], long)}
          </text>
        );
      })}
    </svg>
  );
}

function FeedRow({ lang, e, nowSec }: { lang: Lang; e: LiqEv; nowSec: number }) {
  return (
    <div className={`lqs-ev${e.usd >= 1_000_000 ? " lqs-x2" : e.usd >= 100_000 ? " lqs-x1" : ""}`}>
      <CoinIcon sym={e.s} size={26} />
      <div className="lqs-ev-m">
        <span className="lqs-ev-t">
          <b>{e.s}</b>
          <em className={e.L ? "lqs-side l" : "lqs-side s"}>{t(lang, e.L ? "lqs_long" : "lqs_short")}</em>
        </span>
        <small>{e.ex} · {px(e.px)} · {since(Math.max(1, nowSec - e.t))}</small>
      </div>
      <b className="lqs-ev-v">{usd(e.usd)}</b>
    </div>
  );
}

export function LiqsScreen() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const [win, setWin] = useState<Win>("24h");
  const [sym, setSym] = useState("");
  const [min, setMin] = useState(10_000);
  const [sel, setSel] = useState<number | null>(null);
  const [feedN, setFeedN] = useState(FEED_PAGE);
  const [reply, setReply] = useState<LiqsReply | null>(() => peekLiqs("24h", "", 10_000) ?? null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const now = useNow();

  useEffect(() => {
    let alive = true;
    setSel(null);
    const cached = peekLiqs(win, sym, min);
    if (cached) setReply(cached);
    setBusy(!cached);
    void fetchLiqs(win, sym, min).then((r) => {
      if (!alive) return;
      setBusy(false);
      if (r) setReply(r);
      else setReply((p) => p ?? ({ ok: false, error: "net" } as LiqsReply));
    });
    return () => {
      alive = false;
    };
  }, [win, sym, min, retry]);

  /* Живая лента: пока экран на виду, раз в пятнадцать секунд. */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshLiqs(win, sym, min).then((r) => r?.ok && setReply(r));
    }, LIVE_EVERY);
    return () => window.clearInterval(id);
  }, [win, sym, min]);

  const coinMax = useMemo(() => Math.max(1, ...(reply?.coins ?? []).map(([, L, S]) => L + S)), [reply]);
  const exMax = useMemo(() => Math.max(1, ...(reply?.ex ?? []).map(([, L, S]) => L + S)), [reply]);

  const controls = (
    <>
      <p className="lq-lead">{t(lang, "lqs_sub")}</p>
      <div className="lq-ctl">
        <Segmented<Win> value={win} onChange={(w) => { setWin(w); setFeedN(FEED_PAGE); }}
          options={WINS.map((w) => ({ id: w, label: winLabel(lang, w) }))} />
      </div>
    </>
  );

  if (!reply || !reply.ok) {
    return (
      <Frame title={t(lang, "lqs_title")}>
        {controls}
        {!reply || busy ? <Card><Skeleton rows={8} /></Card> : (
          <Empty text={t(lang, "lqs_err")}
            hint={<button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>} />
        )}
      </Frame>
    );
  }

  const nowSec = Math.floor(now);
  const { L, S, n } = reply.tot;
  const tot = L + S;
  const ratio = L > 0 && S > 0 ? Math.max(L / S, S / L) : 0;
  const verdict = !tot ? null : ratio < 1.25 && L > 0 && S > 0 ? "lqs_v_eq" : L > S ? "lqs_v_long" : "lqs_v_short";
  const bar = sel !== null ? reply.bars[sel] : undefined;
  const live = Object.entries(reply.live ?? {}).filter(([, ts]) => nowSec - ts < LIVE_FRESH).map(([e]) => e);
  const youngSec = reply.since ? nowSec - reply.since : null;
  const young = youngSec !== null && youngSec < ({ "1h": 3600, "4h": 14400, "12h": 43200, "24h": 86400, "7d": 604800 } as const)[win];

  return (
    <Frame title={t(lang, "lqs_title")}>
      {controls}

      {/* Монета: все или одна из самых ликвидируемых */}
      <div className="op-exps" role="tablist">
        {["", ...reply.coins.slice(0, 10).map(([c]) => c).filter((c) => c !== sym), ...(sym ? [sym] : [])]
          .filter((c, i, a) => a.indexOf(c) === i)
          .map((c) => (
            <button key={c || "all"} type="button" role="tab" aria-selected={sym === c}
              className={sym === c ? "chip on" : "chip"}
              onClick={() => { if (sym !== c) { haptic("select"); setSym(c); setFeedN(FEED_PAGE); } }}>
              {c || t(lang, "lqs_all")}
            </button>
          ))}
      </div>

      {young ? <p className="lq-stale">{t(lang, "lqs_young", { t: since(youngSec ?? 0) })}</p> : null}

      <Card>
        <div className="op-head">
          {sym ? <CoinIcon sym={sym} size={32} /> : <span className="lqs-ic" aria-hidden="true">⚡</span>}
          <div className="op-head-n">
            <b>{t(lang, "lqs_head", { w: winLabel(lang, win) })}</b>
            <small>{sym || t(lang, "lqs_all_coins")} · {t(lang, "lqs_n", { n: num(n) })}</small>
          </div>
          {busy ? <span className="lq-busy" aria-hidden="true" /> : null}
        </div>
        <p className="lqs-total">{usd(tot)}</p>
        {tot > 0 ? (
          <>
            <div className="op-split lqs-split" role="img"
              aria-label={`${t(lang, "lqs_longs")} ${usd(L)}, ${t(lang, "lqs_shorts")} ${usd(S)}`}>
              <i className="dn" style={{ width: `${(L / tot) * 100}%` }} />
              <i className="up" style={{ width: `${(S / tot) * 100}%` }} />
            </div>
            <div className="lqs-key">
              <span><i className="op-dot dn" />{t(lang, "lqs_longs")} <b>{usd(L)}</b> <small>{pct((L / tot) * 100, 0, false)}</small></span>
              <span><small>{pct((S / tot) * 100, 0, false)}</small> <b>{usd(S)}</b> {t(lang, "lqs_shorts")}<i className="op-dot up" /></span>
            </div>
            {verdict ? <p className="op-say lqs-say">{t(lang, verdict, { x: num(ratio, 1) })}</p> : null}
          </>
        ) : <p className="lq-hint">{t(lang, "lqs_none")}</p>}
        {reply.big ? (
          <div className="lqs-big">
            <small>{t(lang, "lqs_biggest")}</small>
            <span>
              <b>{usd(reply.big.usd)}</b> · {t(lang, reply.big.L ? "lqs_long" : "lqs_short")} {reply.big.s} · {reply.big.ex}
            </span>
            <em>{px(reply.big.px)} · {since(Math.max(1, nowSec - reply.big.t))}</em>
          </div>
        ) : null}
        <div className="lqs-live">
          {["Binance", "Bybit", "OKX", "Gate", "HTX"].map((e) => (
            <span key={e} className={live.includes(e) ? "on" : ""}><i />{e}</span>
          ))}
        </div>
      </Card>

      <SectionTitle>{t(lang, "lqs_bars")}</SectionTitle>
      <Card>
        <Bars lang={lang} r={reply} sel={sel} onSel={setSel} />
        <div className="op-legend">
          <span><i className="op-dot up" />{t(lang, "lqs_shorts")} ↑</span>
          <span><i className="op-dot dn" />{t(lang, "lqs_longs")} ↓</span>
        </div>
        <p className="op-term-sel" aria-live="polite">
          {bar
            ? t(lang, "lqs_bar_pt", { t: tick(bar[0], win === "7d"), l: usd(bar[1]), s: usd(bar[2]) })
            : t(lang, "lqs_bar_hint")}
        </p>
      </Card>

      {reply.ex.length ? (
        <>
          <SectionTitle>{t(lang, "lqs_by_ex")}</SectionTitle>
          <Card>
            {reply.ex.map(([e, l, s]) => (
              <div key={e} className="lqs-row">
                <b>{e}</b>
                <span className="lqs-row-bar" style={{ width: `${Math.max(3, ((l + s) / exMax) * 100)}%` }}>
                  <i className="dn" style={{ width: `${(l / Math.max(1, l + s)) * 100}%` }} />
                  <i className="up" style={{ width: `${(s / Math.max(1, l + s)) * 100}%` }} />
                </span>
                <em>{usd(l + s)}</em>
              </div>
            ))}
          </Card>
        </>
      ) : null}

      {!sym && reply.coins.length ? (
        <>
          <SectionTitle>{t(lang, "lqs_by_coin")}</SectionTitle>
          <Card>
            <div className="lqs-ch">
              <small>{t(lang, "op_coin")}</small>
              <small>{t(lang, "lqs_longs")} / {t(lang, "lqs_shorts")}</small>
              <small>{t(lang, "lqs_total")}</small>
            </div>
            {reply.coins.slice(0, 15).map(([c, l, s]) => (
              <button key={c} type="button" className="lqs-coin" onClick={() => { haptic("select"); setSym(c); }}>
                <span className="op-mk-c"><CoinIcon sym={c} size={22} /><b>{c}</b></span>
                <span className="lqs-coin-bar">
                  <span className="lqs-row-bar" style={{ width: `${Math.max(3, Math.sqrt((l + s) / coinMax) * 100)}%` }}>
                    <i className="dn" style={{ width: `${(l / Math.max(1, l + s)) * 100}%` }} />
                    <i className="up" style={{ width: `${(s / Math.max(1, l + s)) * 100}%` }} />
                  </span>
                  <small>{usd(l)} / {usd(s)}</small>
                </span>
                <em>{usd(l + s)}</em>
              </button>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle>{t(lang, "lqs_feed")}</SectionTitle>
      <div className="op-exps" role="tablist">
        {MINS.map((m) => (
          <button key={m} type="button" role="tab" aria-selected={min === m}
            className={min === m ? "chip on" : "chip"}
            onClick={() => { if (min !== m) { haptic("select"); setMin(m); setFeedN(FEED_PAGE); } }}>
            {m ? t(lang, "lqs_from", { x: usd(m) }) : t(lang, "lqs_any")}
          </button>
        ))}
      </div>
      <Card>
        {reply.feed.length ? (
          <>
            {reply.feed.slice(0, feedN).map((e, i) => <FeedRow key={`${e.t}-${e.ex}-${e.s}-${i}`} lang={lang} e={e} nowSec={nowSec} />)}
            {reply.feed.length > feedN ? (
              <button type="button" className="lq-more" onClick={() => setFeedN(feedN + FEED_PAGE)}>
                {t(lang, "op_more", { n: reply.feed.length - feedN })}
              </button>
            ) : null}
          </>
        ) : <p className="lq-none">{t(lang, "lqs_feed_none")}</p>}
        <p className="lq-hint">{t(lang, "lqs_feed_note")}</p>
      </Card>

      <details className="lq-how">
        <summary>{t(lang, "lqs_how")}</summary>
        <ul>
          <li>{t(lang, "lqs_how_1")}</li>
          <li>{t(lang, "lqs_how_2")}</li>
          <li>{t(lang, "lqs_how_3")}</li>
        </ul>
      </details>
      <p className="lq-src">
        {t(lang, "lqs_src")}{" "}
        <button type="button" className="lq-chart" onClick={() => open("liqmap")}>{t(lang, "lqs_to_map")}</button>
      </p>
    </Frame>
  );
}
