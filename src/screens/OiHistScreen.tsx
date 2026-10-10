/**
 * Открытый интерес и фандинг во времени: не «сколько сейчас», а как менялось.
 *
 * Интерес — сумма бирж (шесть со своей историей и снимки двадцати трёх),
 * доли бирж — таблицей. Цена — отдельной панелью под
 * ним на той же оси времени: две шкалы на одном поле читались бы как ребус.
 * Сверху — вывод словами по классической схеме «интерес × цена»: растут
 * вместе — заходят новые лонги, интерес растёт при падении — новые шорты,
 * интерес падает при росте — закрываются шорты, падает с ценой — лонги.
 *
 * Фандинг — средняя по шести биржам ставка за восемь часов (у Hyperliquid
 * выплата каждый час, у части монет Binance — раз в четыре: сервер приводит
 * всех к восьми), столбики вверх-вниз от нуля и таблица бирж.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px, since, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchLiqCoins, fetchOiHist, peekLiqCoins, peekOiHist, savedOiHist } from "../lib/api";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { OiChg, OiHistReply } from "../lib/types";
import { Frame } from "./Screen";

type Lang = Parameters<typeof t>[0];
type Range = "1d" | "7d" | "30d";

const BASE_COINS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "SUI", "ADA", "LINK"];

function stamp(ts: number, range: Range): string {
  const d = new Date(ts * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return range === "1d" ? hm : `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}${range === "7d" ? ` ${hm}` : ""}`;
}

function signPct(v: number | null | undefined, d = 2): string {
  return v === null || v === undefined ? "—" : pct(v, d, true);
}

/**
 * Интерес и цена — две панели на одной оси времени. Интерес — линия с
 * заливкой; шкала не с нуля, иначе изменения в пару процентов не видны.
 * Слоями по биржам не рисуем: на такой шкале нижние слои уходят за край, а
 * доли бирж — в таблице ниже. Касание — линия и цифры точки под графиком.
 */
function OiChart({ lang, r, range, sel, onSel }: { lang: Lang; r: OiHistReply; range: Range; sel: number | null; onSel: (i: number | null) => void }) {
  const W = 340;
  const H1 = 140;
  const H2 = 54;
  const GAP = 12;
  const L = 4;
  const R = 4;
  const n = r.t.length;
  const x = (i: number) => L + (i / Math.max(1, n - 1)) * (W - L - R);
  const maxOi = Math.max(1, ...r.oi);
  const minOi = Math.min(...r.oi);
  const pad = Math.max((maxOi - minOi) * 0.15, maxOi * 0.002);
  const lo = minOi - pad;
  const hi = maxOi + pad;
  const y1 = (v: number) => 4 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H1 - 8);
  const pMin = Math.min(...r.px);
  const pMax = Math.max(...r.px);
  const y2 = (v: number) => H1 + GAP + 4 + (1 - (v - pMin) / Math.max(1e-12, pMax - pMin)) * (H2 - 8);
  const line = r.oi.map((v, i) => `${x(i).toFixed(1)},${y1(v).toFixed(1)}`);
  const area = `${x(0).toFixed(1)},${H1} ${line.join(" ")} ${x(n - 1).toFixed(1)},${H1}`;
  const pricePts = r.px.map((v, i) => `${x(i).toFixed(1)},${y2(v).toFixed(1)}`).join(" ");
  const marks = [0, Math.floor((n - 1) / 2), n - 1];
  const iMax = r.oi.indexOf(maxOi);
  const iMin = r.oi.indexOf(minOi);
  return (
    <svg className="oih-chart" viewBox={`0 0 ${W} ${H1 + GAP + H2 + 16}`} role="img" aria-label={t(lang, "oih_oi")}
      onClick={(e) => {
        const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const i = Math.round(((e.clientX - box.left) / box.width * W - L) / (W - L - R) * (n - 1));
        haptic("select");
        onSel(i >= 0 && i < n && i !== sel ? i : null);
      }}>
      <defs>
        <linearGradient id="oihFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0.45" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#oihFill)" />
      <polyline points={line.join(" ")} className="oih-top" />
      {/* Максимум и минимум окна подписаны — остальное по касанию. */}
      {[iMax, iMin].map((i, j) => (
        <text key={j} x={Math.min(W - R, Math.max(L, x(i)))} y={j ? Math.min(H1 - 2, y1(r.oi[i] ?? 0) + 13) : Math.max(10, y1(r.oi[i] ?? 0) - 6)}
          className="oih-v" textAnchor={x(i) < W * 0.15 ? "start" : x(i) > W * 0.85 ? "end" : "middle"}>{usd(r.oi[i])}</text>
      ))}
      <line x1={0} x2={W} y1={H1 + GAP / 2} y2={H1 + GAP / 2} className="oih-sep" />
      <polyline points={pricePts} className="oih-px" />
      <text x={W - R} y={H1 + GAP + 12} className="oih-ax" textAnchor="end">{t(lang, "oih_price")}</text>
      {sel !== null ? (
        <>
          <line x1={x(sel)} x2={x(sel)} y1={0} y2={H1 + GAP + H2} className="oih-cross" />
          <circle cx={x(sel)} cy={y1(r.oi[sel] ?? 0)} r={3.5} className="oih-dot" />
          <circle cx={x(sel)} cy={y2(r.px[sel] ?? 0)} r={3} className="oih-dot" />
        </>
      ) : null}
      {marks.map((i) => (
        <text key={i} x={x(i)} y={H1 + GAP + H2 + 13} className="oih-ax"
          textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{stamp(r.t[i] ?? 0, range)}</text>
      ))}
    </svg>
  );
}

/** Фандинг столбиками от нуля: плюс — вверх (лонги платят), минус — вниз. */
function FundBars({ lang, bars }: { lang: Lang; bars: [number, number][] }) {
  const W = 340;
  const H = 110;
  const pos = bars.some(([, v]) => v > 0);
  const neg = bars.some(([, v]) => v < 0);
  /* Ноль посередине, только если есть обе стороны; иначе — у края, и
     столбики получают всю высоту. */
  const mid = pos && neg ? H / 2 : neg ? 6 : H - 6;
  const room = pos && neg ? H / 2 - 6 : H - 12;
  const n = bars.length;
  const max = Math.max(0.005, ...bars.map(([, v]) => Math.abs(v)));
  const bw = (W - 4) / Math.max(1, n);
  const gap = Math.min(2, bw * 0.25);
  return (
    <svg className="oih-fund" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t(lang, "oih_fund")}>
      <line x1={0} x2={W} y1={mid} y2={mid} className="lqs-zero" />
      {bars.map(([ts, v], i) => {
        const h = Math.max(1, (Math.abs(v) / max) * room);
        return (
          <rect key={ts} className={v >= 0 ? "p" : "m"} x={2 + i * bw + gap / 2} y={v >= 0 ? mid - h : mid}
            width={Math.max(1, bw - gap)} height={h} rx={Math.min(2, (bw - gap) / 2)} />
        );
      })}
    </svg>
  );
}

function Chg({ lang, c, p }: { lang: Lang; c: OiChg; p: OiChg }) {
  return (
    <div className="oih-chg">
      {(["1h", "4h", "24h"] as const).map((k) => (
        <div key={k}>
          <small>{t(lang, `oih_${k}` as Parameters<typeof t>[1])}</small>
          <b className={(c[k] ?? 0) >= 0 ? "pos" : "neg"}>{signPct(c[k])}</b>
          <em>{t(lang, "oih_px_short")} {signPct(p[k])}</em>
        </div>
      ))}
    </div>
  );
}

export function OiHistScreen() {
  const lang = useApp((s) => s.lang);
  const [sym, setSym] = useState("BTC");
  const [range, setRange] = useState<Range>("7d");
  const [sel, setSel] = useState<number | null>(null);
  const [reply, setReply] = useState<OiHistReply | null>(() => peekOiHist("BTC", "7d") ?? savedOiHist("BTC", "7d"));
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [coins, setCoins] = useState<string[]>(() => (peekLiqCoins()?.coins ?? []).slice(0, 14).map((c) => c.s));

  useEffect(() => {
    void fetchLiqCoins().then((r) => {
      const list = (r?.coins ?? []).slice(0, 14).map((c) => c.s);
      if (list.length) setCoins(list);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    setSel(null);
    const cached = peekOiHist(sym, range) ?? savedOiHist(sym, range);
    setReply(cached);
    setBusy(true);
    void fetchOiHist(sym, range).then((r) => {
      if (!alive) return;
      setBusy(false);
      if (r?.ok || !cached) setReply(r ?? ({ ok: false, error: "net" } as OiHistReply));
    });
    return () => {
      alive = false;
    };
  }, [sym, range, retry]);

  const list = useMemo(() => {
    const base = coins.length ? coins : BASE_COINS;
    return base.includes(sym) ? base : [sym, ...base];
  }, [coins, sym]);

  const head = (
    <>
      <p className="lq-lead">{t(lang, "oih_sub")}</p>
      <div className="op-coins" role="tablist">
        {list.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={c === sym} className={c === sym ? "op-coin on" : "op-coin"}
            onClick={() => { if (c !== sym) { haptic("select"); setSym(c); } }}>
            <CoinIcon sym={c} size={22} />
            <span><b>{c}</b></span>
          </button>
        ))}
      </div>
      <div className="lq-ctl">
        <Segmented<Range> value={range} onChange={setRange} options={[
          { id: "1d", label: t(lang, "big_win_24h") },
          { id: "7d", label: t(lang, "big_win_7d") },
          { id: "30d", label: t(lang, "big_win_30d") },
        ]} />
      </div>
    </>
  );

  if (!reply || !reply.ok) {
    return (
      <Frame title={t(lang, "oih_title")}>
        {head}
        {!reply || busy ? <Card><Skeleton rows={8} /></Card> : (
          <Empty text={reply.error === "no_data" ? t(lang, "oih_no_data", { s: sym }) : t(lang, "oih_err")}
            hint={<button type="button" className="lq-retry" onClick={() => setRetry((n) => n + 1)}>{t(lang, "ui_retry")}</button>} />
        )}
      </Frame>
    );
  }

  const oiNow = reply.oi[reply.oi.length - 1] ?? 0;
  const pxNow = reply.px[reply.px.length - 1] ?? 0;
  /* Вывод по сутки (или по окну, если суток в нём нет). */
  const dOi = reply.chg["24h"] ?? reply.chg.all ?? 0;
  const dPx = reply.pchg["24h"] ?? reply.pchg.all ?? 0;
  const quad = Math.abs(dOi) < 1 ? "oih_q_flat" : dOi > 0 ? (dPx >= 0 ? "oih_q_up_up" : "oih_q_up_dn") : (dPx >= 0 ? "oih_q_dn_up" : "oih_q_dn_dn");
  const f = reply.fund;
  const apr = f.apr ?? 0;
  const fundKey = !f.ex.length ? null : apr > 30 ? "oih_f_hot" : apr > 10 ? "oih_f_warm" : apr < -5 ? "oih_f_neg" : "oih_f_calm";
  const s = sel !== null ? sel : null;
  const exMax = Math.max(1, ...reply.ex.map(([, v]) => v));

  return (
    <Frame title={t(lang, "oih_title")}>
      {head}

      <Card>
        <div className="op-head">
          <CoinIcon sym={reply.sym} size={32} />
          <div className="op-head-n">
            <b>{t(lang, "oih_head", { s: reply.sym })}</b>
            <small>{px(pxNow)} · {signPct(reply.pchg["24h"] ?? reply.pchg.all)}</small>
          </div>
          {busy ? <span className="lq-busy" aria-hidden="true" /> : null}
        </div>
        <p className="lqs-total">{usd(oiNow)}</p>
        <p className="op-say">{t(lang, quad, { oi: signPct(dOi, 1), p: signPct(dPx, 1) })}</p>
        <Chg lang={lang} c={reply.chg} p={reply.pchg} />
      </Card>

      <SectionTitle>{t(lang, "oih_oi")}</SectionTitle>
      <Card>
        <OiChart lang={lang} r={reply} range={range} sel={s} onSel={setSel} />
        <p className="op-term-sel" aria-live="polite">
          {s !== null
            ? t(lang, "oih_pt", { t: stamp(reply.t[s] ?? 0, range), oi: usd(reply.oi[s]), p: px(reply.px[s]) })
            : t(lang, "oih_hint")}
        </p>
      </Card>

      <SectionTitle>{t(lang, "oih_by_ex")}</SectionTitle>
      <Card>
        {reply.ex.map(([e, v, c]) => (
          <div key={e} className="op-ex oih-ex">
            <b>{e}</b>
            <span className="op-ex-b"><i style={{ width: `${(v / exMax) * 100}%` }} /></span>
            <em>{usd(v)}</em>
            <small className={(c ?? 0) >= 0 ? "pos" : "neg"}>{signPct(c, 1)}</small>
          </div>
        ))}
        <p className="lq-hint">{t(lang, "oih_ex_note", { w: t(lang, range === "1d" ? "big_win_24h" : range === "7d" ? "big_win_7d" : "big_win_30d") })}</p>
      </Card>

      {f.ex.length ? (
        <>
          <SectionTitle>{t(lang, "oih_fund")}</SectionTitle>
          <Card>
            <div className="oih-fh">
              <div>
                <small>{t(lang, "oih_f_avg")}</small>
                <b className={(f.avg ?? 0) >= 0 ? "pos" : "neg"}>{pct(f.avg ?? 0, 4, true)}</b>
              </div>
              <div>
                <small>{t(lang, "oih_f_apr")}</small>
                <b className={apr >= 0 ? "pos" : "neg"}>{pct(apr, 1, true)}</b>
              </div>
            </div>
            {fundKey ? <p className="op-say">{t(lang, fundKey)}</p> : null}
            {f.bars.length > 1 ? (
              <>
                <FundBars lang={lang} bars={f.bars} />
                <p className="lq-hint">{t(lang, "oih_f_bars", { d: num(f.days ?? 7) })}</p>
              </>
            ) : null}
            <div className="oih-ft">
              <small>{t(lang, "oih_f_ex")}</small>
              <small>{t(lang, "oih_f_8h")}</small>
              <small>{t(lang, "oih_f_apr_s")}</small>
            </div>
            {f.ex.map(([e, r8, a, step]) => (
              <div key={e} className="oih-fr">
                <span><b>{e}</b><small>{t(lang, "oih_f_every", { h: num(step) })}</small></span>
                <em className={r8 >= 0 ? "pos" : "neg"}>{pct(r8, 4, true)}</em>
                <em className={a >= 0 ? "pos" : "neg"}>{pct(a, 1, true)}</em>
              </div>
            ))}
          </Card>
        </>
      ) : null}

      <details className="lq-how">
        <summary>{t(lang, "oih_how")}</summary>
        <ul>
          <li>{t(lang, "oih_how_1")}</li>
          <li>{t(lang, "oih_how_2")}</li>
          <li>{t(lang, "oih_how_3")}</li>
        </ul>
      </details>
      <p className="lq-src">{t(lang, "oih_src", { n: num(reply.ex.length) })} {t(lang, "lq_updated", { t: since(Date.now() / 1000 - reply.at) })}</p>
    </Frame>
  );
}
