/*
 * Экран кошелька Hyperliquid «как у терминалов» (Hyperbot и подобные):
 *
 *   - Счёт: капитал, свободно, маржа в работе (кольца — доля капитала),
 *     объём позиций и плечо счёта;
 *   - Направление: лонги и шорты полосами, перевес, нереализованный PnL,
 *     ROE и фандинг с открытия;
 *   - Результат сделок: кривая накопленного результата за неделю или месяц
 *     (выше нуля — зелёным, ниже — красным; касание — значение дня),
 *     винрейт, профит-фактор, просадка, лучшая и худшая;
 *   - Позиции: размер, вход, марк, ликвидация, маржа, фандинг, PnL и ROE.
 *
 * Только данные, что уже приходят с открытием кошелька: счёт и позиции — из
 * того же ответа Hyperliquid, результат — из базы Wallet Tracker. Новых
 * запросов к бирже нет. Расчёты — lib/walletDash.ts.
 */
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "../i18n/t";
import type { LangCode } from "../i18n/types";
import { dayMonth, lev as levFmt, num, pct, px, signed, usd, usdFull } from "../lib/format";
import type { Account, Perf, Position } from "../lib/types";
import { acctLev, exposure, geom, nearest, share, validPerf } from "../lib/walletDash";
import { CoinIcon } from "./CoinIcon";
import { Card, EyeGlyph, SectionTitle, Segmented, Tiles } from "./ui";
import "./WalletDash.css";

const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "dn" : undefined);

/** Кольцо доли (0…1) — как у счёта в терминалах; число — рядом текстом. */
function Ring({ f, kind }: { f: number; kind: "glow" | "warn" }) {
  const r = 15, c = 2 * Math.PI * r;
  return (
    <svg className={`wd-ring ${kind}`} viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <circle cx="18" cy="18" r={r} className="wd-ring-bg" />
      <circle cx="18" cy="18" r={r} className="wd-ring-fg" strokeDasharray={`${(c * f).toFixed(2)} ${c.toFixed(2)}`} />
    </svg>
  );
}

export function HlAccount({ acct, lang }: { acct: Account; lang: LangCode }) {
  const lv = acctLev(acct);
  const free = share(acct.free, acct.equity);
  const used = share(acct.margin, acct.equity);
  return (
    <Card>
      <SectionTitle>{t(lang, "wd_equity")}</SectionTitle>
      <p className="big wd-equity">{usdFull(acct.equity)}</p>
      <div className="wd-meters">
        <div className="wd-meter">
          <Ring f={free} kind="glow" />
          <div><small>{t(lang, "wd_free")}</small><b>{usd(acct.free)}</b><i>{pct(free * 100, 0, false)}</i></div>
        </div>
        <div className="wd-meter">
          <Ring f={used} kind="warn" />
          <div><small>{t(lang, "wd_margin")}</small><b>{usd(acct.margin)}</b><i>{pct(used * 100, 0, false)}</i></div>
        </div>
      </div>
      <Tiles items={[
        { label: t(lang, "wd_ntl"), value: usd(acct.ntl) },
        { label: t(lang, "wd_acct_lev"), value: lv === null ? "—" : `${num(lv, 2, 2)}×` },
      ]} />
    </Card>
  );
}

export function HlExposure({ pos, lang }: { pos: readonly Position[]; lang: LangCode }) {
  if (!pos.length) return null;
  const e = exposure(pos);
  const bias = e.bias === "long" ? "wd_bias_long" : e.bias === "short" ? "wd_bias_short" : "wd_bias_flat";
  return (
    <Card>
      <SectionTitle note={<span className={`wd-bias ${e.bias}`}>{t(lang, bias)}</span>}>{t(lang, "wd_dir")}</SectionTitle>
      <div className="wd-exp">
        {([["long", "wd_longs", e.long], ["short", "wd_shorts", e.short]] as const).map(([k, label, v]) => (
          <div key={k} className={`wd-exp-row ${k}`}>
            <span>{t(lang, label)}</span>
            <b>{usd(v)}</b>
            <i>{pct(share(v, e.total) * 100, 0, false)}</i>
            <span className="wd-track" aria-hidden="true"><span style={{ inlineSize: `${(share(v, e.total) * 100).toFixed(1)}%` }} /></span>
          </div>
        ))}
      </div>
      <Tiles cols={3} size="sm" items={[
        { label: t(lang, "wd_upnl"), value: signed(e.upnl), tone: tone(e.upnl) },
        { label: "ROE", value: e.roe === null ? "—" : pct(e.roe), tone: e.roe === null ? undefined : tone(e.roe) },
        { label: t(lang, "wd_fund"), value: signed(e.funding), tone: tone(e.funding) },
      ]} />
    </Card>
  );
}

const W = 300, H = 120;

/** Кривая накопленного результата: выше нуля — зелёным, ниже — красным;
 *  касание или стрелки — значение дня (вертикаль и подпись). */
function PnlChart({ pts, label }: { pts: [number, number][]; label: string }) {
  const id = useId().replace(/:/g, "");
  const [at, setAt] = useState(-1);
  const g = geom(pts, W, H);
  const now = pts[pts.length - 1]![0];
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(nearest(g.xs, W, (e.clientX - r.left) / r.width));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = at < 0 ? pts.length - 1 : at + (e.key === "ArrowRight" ? 1 : -1);
    setAt(Math.max(0, Math.min(pts.length - 1, i)));
  };
  const p = at >= 0 ? pts[at] : undefined;
  const left = at >= 0 ? (g.xs[at]! / W) * 100 : 0;
  return (
    <div className="wd-chart" role="img" aria-label={label} tabIndex={0}
      onPointerDown={pick} onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? pick(e) : undefined)}
      onPointerLeave={() => setAt(-1)} onKeyDown={key} onBlur={() => setAt(-1)}>
      <div className="wd-plot">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={`${id}u`}><rect x="0" y="0" width={W} height={g.zero} /></clipPath>
          <clipPath id={`${id}d`}><rect x="0" y={g.zero} width={W} height={H - g.zero} /></clipPath>
          <linearGradient id={`${id}gu`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--up)" stopOpacity="0.35" /><stop offset="1" stopColor="var(--up)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={`${id}gd`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="var(--dn)" stopOpacity="0.35" /><stop offset="1" stopColor="var(--dn)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="0" x2={W} y1={g.zero} y2={g.zero} className="wd-zero" vectorEffect="non-scaling-stroke" />
        <path d={g.area} fill={`url(#${id}gu)`} clipPath={`url(#${id}u)`} />
        <path d={g.area} fill={`url(#${id}gd)`} clipPath={`url(#${id}d)`} />
        <path d={g.line} className="wd-line up" clipPath={`url(#${id}u)`} vectorEffect="non-scaling-stroke" />
        <path d={g.line} className="wd-line dn" clipPath={`url(#${id}d)`} vectorEffect="non-scaling-stroke" />
        {at >= 0 ? <line x1={g.xs[at]} x2={g.xs[at]} y1="0" y2={H} className="wd-cross" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {p ? (
        <>
          <i className={`wd-dot ${p[1] >= 0 ? "up" : "dn"}`} style={{ insetInlineStart: `${left}%`, insetBlockStart: `${(g.ys[at]! / H) * 100}%` }} />
          <div className={`wd-tip${left > 60 ? " end" : ""}`} style={{ insetInlineStart: `${left}%` }}>
            <b className={p[1] > 0 ? "up" : p[1] < 0 ? "dn" : undefined}>{signed(p[1])}</b>
            <small>{dayMonth(p[0], now)}</small>
          </div>
        </>
      ) : null}
      </div>
      <div className="wd-axis" aria-hidden="true">
        <span>{dayMonth(pts[0]![0], now)}</span><span>{dayMonth(now, now)}</span>
      </div>
    </div>
  );
}

export function HlPerf({ perf, lang }: { perf: Perf | undefined; lang: LangCode }) {
  const ok = validPerf(perf);
  const wins = (["7", "30"] as const).filter((k) => ok[k]);
  const [win, setWin] = useState<"7" | "30">(wins[0] ?? "30");
  const w = ok[wins.includes(win) ? win : wins[0] ?? "30"];
  return (
    <Card>
      <SectionTitle>{t(lang, "wd_perf")}</SectionTitle>
      {!w ? <p className="hint">{t(lang, "wd_no_perf")}</p> : (
        <>
          {wins.length > 1 ? (
            <Segmented value={win} onChange={setWin} tight
              options={[{ id: "7", label: t(lang, "wd_1w") }, { id: "30", label: t(lang, "wd_1m") }]} />
          ) : null}
          <div className="wd-head">
            <b className={`big ${tone(w.pnl) ?? ""}`}>{signed(w.pnl)}</b>
            <small>{t(lang, "rk_trades")} · {num(w.trades)}</small>
          </div>
          <PnlChart key={win} pts={w.pts}
            label={`${t(lang, "wd_chart")}: ${signed(w.pnl)}, ${t(lang, "ws_winrate")} ${num(w.win, 1)}%`} />
          <Tiles cols={3} size="sm" items={[
            { label: t(lang, "ws_winrate"), value: `${num(w.win, 1)}%` },
            { label: t(lang, "wd_pf"), value: w.pf === null ? "∞" : num(w.pf, 2, 2) },
            { label: t(lang, "wd_dd"), value: w.dd ? usd(-w.dd) : "$0", tone: w.dd ? "dn" : undefined },
            { label: t(lang, "wd_best"), value: signed(w.best), tone: tone(w.best) },
            { label: t(lang, "wd_worst"), value: signed(w.worst), tone: tone(w.worst) },
            { label: t(lang, "rk_trades"), value: `${num(w.wins)}/${num(w.trades)}` },
          ]} />
          <small className="hint">{t(lang, "wd_src")}</small>
        </>
      )}
    </Card>
  );
}

/** Позиции подробно — как таблица терминала, но карточкой на телефон. */
export function HlPositions({ pos, lang, open }: { pos: readonly Position[]; lang: LangCode; open: (i: number) => void }) {
  return (
    <div className="wd-pos">
      {pos.map((p, i) => (
        <button type="button" key={`${p.sym}-${i}`} className={`wd-pcard ${p.long ? "long" : "short"}`} onClick={() => open(i)}>
          <span className="wd-ph">
            <CoinIcon sym={p.sym} size={26} />
            <span className="wd-pt">
              <span><b>{p.sym}</b><span className={`wd-side ${p.long ? "long" : "short"}`}>{t(lang, p.long ? "hl_side_long" : "hl_side_short")}</span></span>
              <small>{levFmt(p.lev)} · {t(lang, p.isolated ? "hl_isolated" : "hl_cross")}</small>
            </span>
            <span className="wd-pnl">
              <b className={tone(p.pnl)}>{signed(p.pnl)}</b>
              <small className={tone(p.pct)}>{pct(p.pct)}</small>
            </span>
            <EyeGlyph size={16} />
          </span>
          <span className="wd-pg">
            <span><small>{t(lang, "hl_position_size")}</small><b>{usd(p.size)}</b></span>
            <span><small>{t(lang, "hl_entry_price")}</small><b>{px(p.entry)}</b></span>
            <span><small>{t(lang, "wd_mark")}</small><b>{px(p.now)}</b></span>
            <span><small>{t(lang, "hl_liq")}</small><b className={p.liq ? "warn" : undefined}>{p.liq ? px(p.liq) : "—"}</b></span>
            <span><small>{t(lang, "hl_collateral")}</small><b>{usd(p.margin)}</b></span>
            <span><small>{t(lang, "wd_fund")}</small><b className={tone(p.funding)}>{signed(p.funding)}</b></span>
          </span>
        </button>
      ))}
    </div>
  );
}
