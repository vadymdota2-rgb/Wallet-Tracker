/**
 * Опционы BTC и ETH: где по страйкам стоят ставки, куда тянет Max Pain, на
 * что рынок ставит и что делают крупные игроки.
 *
 * Открытый интерес сервер складывает с Deribit, OKX, Bybit и Binance — в
 * монетах, доллары считаются здесь по цене индекса. Сделки и индекс
 * волатильности DVOL — только Deribit: там большая часть рынка опционов.
 *
 * Экран идёт сверху вниз так же, как карта ликвидаций. Сначала главное
 * цифрами — интерес, Put/Call, Max Pain ближайшей даты и DVOL. Потом —
 * интерес по страйкам: цена по вертикали, путы влево, колы вправо, линия
 * текущей цены между строками. Потом даты экспирации, поток сделок за сутки,
 * крупные сделки и доля бирж.
 *
 * Колы — зелёные и справа, путы — красные и слева: сторону говорит и место,
 * и подпись, поэтому различать цвет не обязательно.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { day, dayMonth, fix2, num, pct, px, since, untilDay, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchOptions, peekOptions, refreshOptions, savedOptions } from "../lib/api";
import { useNow } from "../lib/tick";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, SectionTitle, Segmented, Skeleton } from "../components/ui";
import type { OptExpiry, OptionsReply, OptTrade } from "../lib/types";
import { Frame } from "./Screen";

type Lang = Parameters<typeof t>[0];

const COINS = ["BTC", "ETH"] as const;
/** Строк в лесенке страйков — не больше: дальше они сливаются в полоски. */
const MAX_ROWS = 40;
/** Сколько крупных сделок видно сразу. */
const BIG_PAGE = 12;
/** Как часто открытый экран спрашивает свежие данные: сервер пересобирает раз в три минуты. */
const LIVE_EVERY = 120_000;

/** Ширина окна страйков вокруг цены: ближняя дата — узко, дальняя — широко. */
function spanFor(e: OptExpiry | null, nowSec: number): number {
  if (!e) return 0.3;
  const days = (e.ts - nowSec) / 86400;
  return days <= 3 ? 0.08 : days <= 14 ? 0.15 : days <= 60 ? 0.3 : 0.45;
}

/** Круглый шаг не меньше заданного: 1, 2, 2,5, 5 × 10ⁿ. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

interface StrikeRow {
  k: number;
  c: number;
  p: number;
}

/** Страйки выбранной даты (или всех) в окне вокруг цены; если их много — по корзинам. */
function strikeRows(list: OptExpiry[], price: number, span: number): { rows: StrikeRow[]; step: number } {
  const all = new Map<number, StrikeRow>();
  for (const e of list) {
    for (const [k, c, p] of e.k) {
      const r = all.get(k) ?? { k, c: 0, p: 0 };
      r.c += c;
      r.p += p;
      all.set(k, r);
    }
  }
  const lo = price * (1 - span);
  const hi = price * (1 + span);
  let rows = [...all.values()].filter((r) => r.k >= lo && r.k <= hi && r.c + r.p > 0);
  let step = 0;
  if (rows.length > MAX_ROWS) {
    step = niceStep((hi - lo) / MAX_ROWS);
    const b = new Map<number, StrikeRow>();
    for (const r of rows) {
      const k = Math.round(r.k / step) * step;
      const x = b.get(k) ?? { k, c: 0, p: 0 };
      x.c += r.c;
      x.p += r.p;
      b.set(k, x);
    }
    rows = [...b.values()];
  }
  return { rows: rows.sort((a, b) => b.k - a.k), step };
}

function Spark({ path }: { path: number[] }) {
  if (path.length < 2) return null;
  const lo = Math.min(...path);
  const hi = Math.max(...path);
  const h = 26;
  const w = 120;
  const y = (v: number) => (hi === lo ? h / 2 : 2 + ((hi - v) / (hi - lo)) * (h - 4));
  const pts = path.map((v, i) => `${((i / (path.length - 1)) * (w - 3)).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="op-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
      <circle cx={w - 3} cy={y(path[path.length - 1] ?? lo)} r={2.5} />
    </svg>
  );
}

function LiveAge({ lang, at }: { lang: Lang; at: number }) {
  const now = useNow();
  return (
    <small className="lq-live">
      <i aria-hidden="true" />
      {t(lang, "lq_live", { t: since(Math.max(1, now - at)) })}
    </small>
  );
}

/** Строка крупной сделки: слева — что и какая сторона, справа — сколько и когда. */
function BigRow({ lang, b, sym, nowSec }: { lang: Lang; b: OptTrade; sym: string; nowSec: number }) {
  const call = b.cp === "C";
  const exp = Math.floor(Date.parse(`${b.e}T08:00:00Z`) / 1000);
  return (
    <div className="op-big-r">
      <div className="op-big-l">
        <span className="op-big-t">
          <em className={`op-cp ${call ? "up" : "dn"}`}>{t(lang, call ? "op_call" : "op_put")}</em>
          <b>{num(b.k)}</b>
          <small>{dayMonth(exp, nowSec)}</small>
        </span>
        <span className="op-big-s">
          <em className={b.s === "b" ? "op-side buy" : "op-side sell"}>{t(lang, b.s === "b" ? "op_buy" : "op_sell")}</em>
          <small>{num(b.a, b.a < 10 ? 2 : 0)} {sym}</small>
          {b.blk ? <em className="op-blk">{t(lang, "op_block")}</em> : null}
        </span>
      </div>
      <div className="op-big-c">
        <b>{usd(b.n)}</b>
        <small>{t(lang, "op_prem", { x: usd(b.pr) })}</small>
        <small>{since(nowSec - b.t)}</small>
      </div>
    </div>
  );
}

export function OptionsScreen() {
  const lang = useApp((s) => s.lang);
  const saved = useApp((s) => s.optSym);
  const setOptSym = useApp((s) => s.setOptSym);
  const [sym, setSym] = useState<string>((COINS as readonly string[]).includes(saved) ? saved : "BTC");
  const [exp, setExp] = useState<string>("all");
  const [sel, setSel] = useState<number | null>(null);
  const [bigN, setBigN] = useState(BIG_PAGE);
  const [reply, setReply] = useState<OptionsReply | null>(() => peekOptions(sym) ?? savedOptions(sym)?.v ?? null);
  const [busy, setBusy] = useState(false);
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setSel(null);
    setExp("all");
    setBigN(BIG_PAGE);
    const cached = peekOptions(sym);
    const kept = cached ? null : savedOptions(sym);
    setReply(cached ?? kept?.v ?? null);
    setBusy(!cached);
    setStaleAt(null);
    void fetchOptions(sym).then((r) => {
      if (!alive) return;
      setBusy(false);
      if (r?.ok || r?.error === "no_data") setReply(r);
      else if (kept) setStaleAt(kept.at);
      else setReply(r ?? ({ ok: false, error: "net" } as OptionsReply));
    });
    setOptSym(sym);
    return () => {
      alive = false;
    };
  }, [sym, setOptSym, retry]);

  /* Пока экран открыт — свежие данные раз в две минуты; выбор даты и
     страйка при этом остаётся. */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshOptions(sym).then((r) => {
        if (r?.ok) {
          setReply(r);
          setStaleAt(null);
        }
      });
    }, LIVE_EVERY);
    return () => window.clearInterval(id);
  }, [sym]);

  const nowSec = Math.floor(Date.now() / 1000);
  const exps = useMemo(() => (reply?.ok ? reply.exp.filter((e) => e.ts > nowSec) : []), [reply, nowSec]);
  const cur = exp === "all" ? null : exps.find((e) => e.d === exp) ?? null;
  const view = useMemo(
    () => (reply?.ok ? strikeRows(cur ? [cur] : exps, reply.px, spanFor(cur, nowSec)) : { rows: [], step: 0 }),
    [reply, exps, cur, nowSec],
  );

  const again = () => {
    haptic("select");
    setRetry((n) => n + 1);
  };

  if (!reply || !reply.ok) {
    return (
      <Frame title={t(lang, "op_title")}>
        <p className="lq-lead">{t(lang, "op_sub")}</p>
        <CoinSwitch sym={sym} onPick={setSym} />
        {!reply ? (
          <Card><Skeleton rows={10} /></Card>
        ) : (
          <Empty
            text={t(lang, "op_err")}
            hint={<button type="button" className="lq-retry" onClick={again}>{t(lang, "ui_retry")}</button>}
          />
        )}
      </Frame>
    );
  }

  const P = reply.px;
  const totC = exps.reduce((a, e) => a + e.c, 0);
  const totP = exps.reduce((a, e) => a + e.p, 0);
  const volC = exps.reduce((a, e) => a + e.vc, 0);
  const volP = exps.reduce((a, e) => a + e.vp, 0);
  const pcr = totC > 0 ? totP / totC : 0;
  const pcrVol = volC > 0 ? volP / volC : 0;
  const mood = pcr < 0.7 ? "op_mood_up" : pcr > 1 ? "op_mood_dn" : "op_mood_eq";
  const near = exps[0];
  const mpExp = cur ?? near;

  const maxBar = Math.max(1, ...view.rows.map((r) => Math.max(r.c, r.p)));
  const rowSel = sel !== null ? view.rows.find((r) => r.k === sel) : undefined;
  const mpRow = mpExp && cur
    ? view.rows.reduce<StrikeRow | null>((b, r) => (!b || Math.abs(r.k - mpExp.mp) < Math.abs(b.k - mpExp.mp) ? r : b), null)
    : null;
  /* Линия цены — между последней строкой выше цены и первой ниже. */
  const priceAt = view.rows.findIndex((r) => r.k < P);

  const expMax = Math.max(1, ...exps.map((e) => e.c + e.p));
  const f = "cb" in reply.flow ? reply.flow : null;
  const fMax = f ? Math.max(1, f.cb, f.cs, f.pb, f.ps) : 1;
  const flowKey = !f ? null : f.cb > f.pb * 1.2 ? "op_flow_up" : f.pb > f.cb * 1.2 ? "op_flow_dn" : "op_flow_eq";
  const exTot = reply.ex.reduce((a, [, v]) => a + v, 0);

  return (
    <Frame title={t(lang, "op_title")}>
      <p className="lq-lead">{t(lang, "op_sub")}</p>
      <CoinSwitch sym={sym} onPick={setSym} />

      {staleAt ? (
        <p className="lq-stale">
          {t(lang, "op_stale", { t: since((Date.now() - staleAt) / 1000) })}{" "}
          <button type="button" onClick={again}>{t(lang, "ui_retry")}</button>
        </p>
      ) : null}

      <Card>
        <div className="lq-hero">
          <CoinIcon sym={reply.sym} size={34} />
          <div className="lq-hero-n">
            <b>{reply.sym}</b>
            <LiveAge lang={lang} at={reply.at} />
          </div>
          <div className="lq-hero-p">
            <b>{px(P)}</b>
          </div>
          {busy ? <span className="lq-busy" aria-hidden="true" /> : null}
        </div>

        <div className="op-tiles">
          <div className="op-tile">
            <small>{t(lang, "op_oi")}</small>
            <b>{usd((totC + totP) * P)}</b>
            <div className="lq-bal-bar" role="img"
              aria-label={`${t(lang, "op_puts")} ${usd(totP * P)}, ${t(lang, "op_calls")} ${usd(totC * P)}`}>
              <i className="dn" style={{ width: `${(totP / Math.max(1e-9, totC + totP)) * 100}%` }} />
              <i className="up" style={{ width: `${(totC / Math.max(1e-9, totC + totP)) * 100}%` }} />
            </div>
            <span className="op-tile-k">
              <em className="dn">{t(lang, "op_puts")} {pct((totP / Math.max(1e-9, totC + totP)) * 100, 0, false)}</em>
              <em className="up">{t(lang, "op_calls")} {pct((totC / Math.max(1e-9, totC + totP)) * 100, 0, false)}</em>
            </span>
          </div>
          <div className="op-tile">
            <small>{t(lang, "op_pcr")}</small>
            <b>{fix2(pcr)}</b>
            <span>{t(lang, mood)}</span>
            <span className="op-tile-d">{t(lang, "op_pcr_vol", { x: fix2(pcrVol) })}</span>
          </div>
          {mpExp ? (
            <button
              type="button"
              className="op-tile"
              onClick={() => { haptic("select"); setExp(mpExp.d); setSel(null); }}
            >
              <small>{t(lang, "op_mp")}</small>
              <b>{px(mpExp.mp)}</b>
              <span>{t(lang, "op_mp_sub", { d: day(mpExp.ts, nowSec), x: pct(((mpExp.mp - P) / P) * 100, 1, true) })}</span>
            </button>
          ) : null}
          {reply.dvol ? (
            <div className="op-tile">
              <small>{t(lang, "op_dvol")}</small>
              <b>{num(reply.dvol.v, 1)}</b>
              <Spark path={reply.dvol.path} />
              <span className="op-tile-d">{t(lang, "op_dvol_sub", { x: `${reply.dvol.chg > 0 ? "+" : ""}${num(reply.dvol.chg, 1)}` })}</span>
            </div>
          ) : null}
        </div>
      </Card>

      <SectionTitle>{t(lang, "op_strikes")}</SectionTitle>
      <div className="op-exps" role="tablist">
        {[null, ...exps].map((e) => {
          const id = e ? e.d : "all";
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={exp === id}
              className={exp === id ? "chip on" : "chip"}
              onClick={() => { if (exp !== id) { haptic("select"); setExp(id); setSel(null); } }}
            >
              {e ? dayMonth(e.ts, nowSec) : t(lang, "op_all")}
            </button>
          );
        })}
      </div>
      <Card>
        <div className="op-ladder-h">
          <span className="dn">◀ {t(lang, "op_puts")}</span>
          <small>{t(lang, "op_strike")}</small>
          <span className="up">{t(lang, "op_calls")} ▶</span>
        </div>
        <div className="op-ladder">
          {view.rows.map((r, i) => (
            <div key={r.k} className="op-ladder-g">
              {i === priceAt ? (
                <div className="op-px"><span>{t(lang, "op_price", { x: px(P) })}</span></div>
              ) : null}
              <button
                type="button"
                className={`op-row${sel === r.k ? " on" : ""}${mpRow?.k === r.k ? " mp" : ""}`}
                aria-pressed={sel === r.k}
                onClick={() => { haptic("select"); setSel(sel === r.k ? null : r.k); }}
              >
                <span className="op-bar l"><i style={{ width: `${(r.p / maxBar) * 100}%` }} /></span>
                <b>{num(r.k)}{mpRow?.k === r.k ? <em>MP</em> : null}</b>
                <span className="op-bar r"><i style={{ width: `${(r.c / maxBar) * 100}%` }} /></span>
              </button>
            </div>
          ))}
          {priceAt === -1 && view.rows.length ? (
            <div className="op-px"><span>{t(lang, "op_price", { x: px(P) })}</span></div>
          ) : null}
        </div>
        {rowSel ? (
          <div className="op-sel" aria-live="polite">
            <b>{view.step ? `≈ ${num(rowSel.k)}` : num(rowSel.k)}</b>
            <span>{pct(((rowSel.k - P) / P) * 100, 1, true)}</span>
            <span className="dn">{t(lang, "op_puts")} <b>{usd(rowSel.p * P)}</b> · {num(rowSel.p, 1)} {reply.sym}</span>
            <span className="up">{t(lang, "op_calls")} <b>{usd(rowSel.c * P)}</b> · {num(rowSel.c, 1)} {reply.sym}</span>
          </div>
        ) : (
          <p className="lq-hint">{t(lang, cur ? "op_tap_mp" : "op_tap")}</p>
        )}
      </Card>

      <SectionTitle>{t(lang, "op_exp")}</SectionTitle>
      <Card>
        <div className="op-exp-h">
          <span />
          <small>{t(lang, "op_oi")}</small>
          <small>P/C</small>
          <small>{t(lang, "op_mp")}</small>
        </div>
        {exps.map((e) => (
          <button
            key={e.d}
            type="button"
            className={exp === e.d ? "op-exp on" : "op-exp"}
            onClick={() => { haptic("select"); setExp(exp === e.d ? "all" : e.d); setSel(null); }}
          >
            <span className="op-exp-d">
              <b>{dayMonth(e.ts, nowSec)}</b>
              <small>{untilDay(e.ts, nowSec)}</small>
            </span>
            <span className="op-exp-oi">
              <em>{usd((e.c + e.p) * P)}</em>
              <span className="op-exp-bar" style={{ width: `${((e.c + e.p) / expMax) * 100}%` }}>
                <i className="dn" style={{ width: `${(e.p / Math.max(1e-9, e.c + e.p)) * 100}%` }} />
                <i className="up" style={{ width: `${(e.c / Math.max(1e-9, e.c + e.p)) * 100}%` }} />
              </span>
            </span>
            <span className="op-exp-n">{e.c > 0 ? fix2(e.p / e.c) : "—"}</span>
            <span className="op-exp-n">{px(e.mp)}</span>
          </button>
        ))}
      </Card>

      {f ? (
        <>
          <SectionTitle>{t(lang, "op_flow", { h: num(Math.min(24, f.h)) })}</SectionTitle>
          <Card>
            {flowKey ? <p className="lq-bal-t">{t(lang, flowKey)}</p> : null}
            {([["up", "op_calls", f.cb, f.cs], ["dn", "op_puts", f.pb, f.ps]] as const).map(([k, name, b, s]) => (
              <div key={k} className={`op-flow ${k}`}>
                <b>{t(lang, name)}</b>
                <div className="op-flow-r">
                  <small>{t(lang, "op_bought")}</small>
                  <span className="op-flow-b"><i style={{ width: `${(b / fMax) * 100}%` }} /></span>
                  <em>{usd(b)}</em>
                </div>
                <div className="op-flow-r sold">
                  <small>{t(lang, "op_sold")}</small>
                  <span className="op-flow-b"><i style={{ width: `${(s / fMax) * 100}%` }} /></span>
                  <em>{usd(s)}</em>
                </div>
              </div>
            ))}
            <p className="lq-hint">{t(lang, "op_flow_note")}</p>
          </Card>
        </>
      ) : null}

      <SectionTitle>{t(lang, "op_big")}</SectionTitle>
      <Card>
        <p className="lq-hint op-big-sub">{t(lang, "op_big_sub", { x: usd(reply.sym === "BTC" ? 1_000_000 : 500_000) })}</p>
        {reply.big.length ? (
          <>
            {reply.big.slice(0, bigN).map((b, i) => (
              <BigRow key={`${b.t}-${b.k}-${b.cp}-${i}`} lang={lang} b={b} sym={reply.sym} nowSec={nowSec} />
            ))}
            {reply.big.length > bigN ? (
              <button type="button" className="lq-more" onClick={() => setBigN(bigN + BIG_PAGE)}>
                {t(lang, "op_more", { n: reply.big.length - bigN })}
              </button>
            ) : null}
          </>
        ) : (
          <p className="lq-none">{t(lang, "op_big_none")}</p>
        )}
      </Card>

      {reply.ex.length > 1 ? (
        <>
          <SectionTitle>{t(lang, "op_ex")}</SectionTitle>
          <Card>
            {reply.ex.map(([name, v]) => (
              <div key={name} className="op-ex">
                <b>{name}</b>
                <span className="op-ex-b"><i style={{ width: `${(v / Math.max(1, reply.ex[0]?.[1] ?? 1)) * 100}%` }} /></span>
                <em>{usd(v)}</em>
                <small>{pct((v / Math.max(1, exTot)) * 100, 0, false)}</small>
              </div>
            ))}
          </Card>
        </>
      ) : null}

      <details className="lq-how">
        <summary>{t(lang, "op_how")}</summary>
        <ul>
          <li>{t(lang, "op_how_1")}</li>
          <li>{t(lang, "op_how_2")}</li>
          <li>{t(lang, "op_how_3")}</li>
          <li>{t(lang, "op_how_4")}</li>
          <li>{t(lang, "op_how_5")}</li>
        </ul>
      </details>

      <p className="lq-src">
        {t(lang, "op_src", { ex: reply.ex.map(([n]) => n).join(", ") })}{" "}
        {t(lang, "lq_updated", { t: since(Date.now() / 1000 - reply.at) })}
      </p>
    </Frame>
  );
}

function CoinSwitch({ sym, onPick }: { sym: string; onPick: (s: string) => void }) {
  return (
    <div className="lq-ctl">
      <Segmented<string>
        value={sym}
        onChange={onPick}
        options={COINS.map((c) => ({ id: c, label: <span className="op-coin"><CoinIcon sym={c} size={18} /> {c}</span> }))}
      />
    </div>
  );
}
