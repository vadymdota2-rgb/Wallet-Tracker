/**
 * Разделы выпуска, собранные из всех вкладок, и общие кирпичики раздела.
 *
 * Выпуск читается сверху вниз, как обзор рынка у аналитика: сперва итог дня
 * одной строкой и табло сигналов, затем рынок целиком (настроение, цены,
 * капитализация, доминация), деньги институционалов (ETF, премия Coinbase),
 * биткоин на биржах, киты BSC, деривативы, лидеры рейтинга и календарь.
 *
 * Каждое число здесь — из своей вкладки, и раздел ведёт в неё: вывод можно
 * проверить, а не принять на веру. Табло не прогноз — оно только сводит в
 * одно место то, что вкладки показывают порознь.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px, shortAddr, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { CoinIcon } from "../components/CoinIcon";
import { BtcGlyph, EtfGlyph, GaugeGlyph, Row, TopGlyph } from "../components/ui";
import type { CalEv, DigestItem, DigestSignal } from "../lib/types";
import { FLAG, allDay, calTitle } from "./CalendarScreen";

type Lang = Parameters<typeof t>[0];

/* Числа со знаком — изолированным куском слева направо: в арабском иначе
   «+95» превращалось в «95+». */
const iso = (x: string | number) => `⁦${x}⁩`;
const sUsd = (v: number) => iso(usd(v, true));
/** Сумма без знака — там, где сторону говорит само слово («купили», «ликвидировано»). */
const pUsd = (v: number) => iso(usd(v));
const sPct = (v: number, d = 2) => iso(pct(v, d, true));
const btcAmt = (v: number, sign = false) =>
  iso(`${sign && v > 0 ? "+" : ""}${num(v, Math.abs(v) >= 100 ? 0 : 2)} BTC`);

/** Дата словами: «1 октября». */
function dateWord(lang: Lang, tsSec: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(new Date(tsSec * 1000));
  } catch {
    return new Date(tsSec * 1000).toISOString().slice(0, 10);
  }
}

/** Выпуск v3 сворачивает разделы до одной строки вывода. Контекст, а не
 *  проп: разделы старых выпусков те же компоненты и должны остаться как были. */
export const FoldCtx = createContext(false);

/** Раздел выпуска: значок вкладки, её имя и содержимое. Нажатие на шапку
 *  открывает саму вкладку — там то же самое подробно.
 *
 *  В свёрнутом виде (выпуск v3, есть `line`) под шапкой — одна строка вывода,
 *  а подробности и ссылка на вкладку открываются нажатием: выпуск целиком
 *  читается за минуту, а цифры под каждым выводом — в одно касание. */
export function Sec({ icon, title, children, onOpen, line, tone: lineTone }: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
  line?: ReactNode;
  tone?: "up" | "dn";
}) {
  const fold = useContext(FoldCtx);
  const [open, setOpen] = useState(false);
  const lang = useApp((s) => s.lang);
  if (fold && line) {
    return (
      <div className={open ? "dg-sec dg-fold on" : "dg-sec dg-fold"}>
        <button type="button" className="dg-fold-head" aria-expanded={open}
          onClick={() => { haptic("select"); setOpen(!open); }}>
          <span className="dg-sec-ic" aria-hidden="true">{icon}</span>
          <span className="dg-fold-t">
            <h3>{title}</h3>
            <span className={lineTone ? `dg-fold-l ${lineTone}` : "dg-fold-l"}>{line}</span>
          </span>
          <span className="dg-fold-ch" aria-hidden="true">⌄</span>
        </button>
        {open ? (
          <div className="dg-fold-body">
            {children}
            {onOpen ? (
              <button type="button" className="dg-fold-go" onClick={() => { haptic("select"); onOpen(); }}>
                {t(lang, "dg_go")} ›
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="dg-sec">
      {onOpen ? (
        <button type="button" className="dg-sec-head dg-sec-link"
          onClick={() => { haptic("select"); onOpen(); }}>
          <span className="dg-sec-ic" aria-hidden="true">{icon}</span>
          <h3>{title}</h3>
          <span className="dg-sec-go" aria-hidden="true">›</span>
        </button>
      ) : (
        <div className="dg-sec-head">
          <span className="dg-sec-ic" aria-hidden="true">{icon}</span>
          <h3>{title}</h3>
        </div>
      )}
      {children}
    </div>
  );
}

/** Подпись над короткими списками внутри раздела: «Приток», «Отток». */
export function Sub({ children }: { children: ReactNode }) {
  return <p className="dg-sub">{children}</p>;
}

export function Quiet({ lang }: { lang: Lang }) {
  return <p className="dg-quiet">{t(lang, "dg_quiet")}</p>;
}

/** Заголовок части выпуска: «Рынок», «Институционалы», «Киты BSC»… */
export function Part({ children }: { children: ReactNode }) {
  return <h2 className="dg-part">{children}</h2>;
}

/* ── Сводка дня ───────────────────────────────────────────────────────── */

export const SIG_KEY: Record<DigestSignal["k"], Parameters<typeof t>[1]> = {
  fng: "dg_sig_fng",
  etf: "dg_sig_etf",
  btcx: "dg_sig_btcx",
  whales: "dg_sig_whales",
  cbp: "dg_sig_cbp",
  liq: "dg_sig_liq",
  oi: "dg_sig_oi",
  fund: "dg_sig_fund",
  pcr: "dg_sig_pcr",
};

export function sigValue(s: DigestSignal): string {
  switch (s.k) {
    case "fng":
      return num(s.v);
    case "etf":
    case "whales":
      return sUsd(s.v);
    case "btcx":
      return btcAmt(s.v, true);
    case "cbp":
      return sPct(s.v, 3);
    case "liq":
      return iso(`${num(s.v)}%`);
    case "oi":
      return sPct(s.v, 1);
    case "fund":
      return sPct(s.v, 4);
    case "pcr":
      return iso(num(s.v, 2));
  }
}

/** Итог табло. Перевес — когда за одну сторону больше половины сигналов.
 *  Иначе честно пишем, что сигналы расходятся: натягивать вывод на 2 против 2 нельзя. */
export function verdictOf(it: DigestItem, lang: Lang): { cls: "up" | "dn" | "mix"; text: string } | null {
  const sig = it.sig ?? [];
  if (!sig.length) return null;
  const up = sig.filter((s) => s.d > 0).length;
  const dn = sig.filter((s) => s.d < 0).length;
  const n = sig.length;
  return up > n / 2
    ? { cls: "up", text: t(lang, "dg_v_bull", { b: up, n }) }
    : dn > n / 2
      ? { cls: "dn", text: t(lang, "dg_v_bear", { s: dn, n }) }
      : { cls: "mix", text: t(lang, "dg_v_mix", { b: up, s: dn }) };
}

export function Summary({ it, lang }: { it: DigestItem; lang: Lang }) {
  const sig = it.sig ?? [];
  const verdict = verdictOf(it, lang);
  if (!sig.length || !verdict) return null;
  return (
    <div className="dg-sum-box">
      <p className={`dg-verdict ${verdict.cls}`}>{verdict.text}</p>
      <ul className="dg-sig">
        {sig.map((s) => (
          <li key={s.k}>
            <span className={`dg-sig-d ${s.d > 0 ? "up" : s.d < 0 ? "dn" : "flat"}`} aria-hidden="true">
              {s.d > 0 ? "▲" : s.d < 0 ? "▼" : "●"}
            </span>
            <span className="dg-sig-k">{t(lang, SIG_KEY[s.k])}</span>
            <b className={s.d > 0 ? "up" : s.d < 0 ? "dn" : undefined}>{sigValue(s)}</b>
          </li>
        ))}
      </ul>
      <p className="dg-note">{t(lang, "dg_sig_note")}</p>
    </div>
  );
}

/* ── Рынок ────────────────────────────────────────────────────────────── */

const FNG_ZONES: [number, Parameters<typeof t>[1]][] = [
  [25, "fg_z0"], [46, "fg_z1"], [54, "fg_z2"], [75, "fg_z3"], [100, "fg_z4"],
];

function Cell({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "up" | "dn" }) {
  return (
    <div className="dg-cell">
      <small>{label}</small>
      <b>{value}</b>
      {sub ? <em className={tone}>{sub}</em> : null}
    </div>
  );
}

const tone = (v: number): "up" | "dn" | undefined => (v > 0 ? "up" : v < 0 ? "dn" : undefined);

/** Капитализация рынка — в триллионах: «$2 905,85B» не влезал в ячейку. */
const capShort = (v: number) => (v >= 1e12 ? `$${num(v / 1e12, 2)}T` : usd(v));

export function Market({ it, lang }: { it: DigestItem; lang: Lang }) {
  const open = useApp((s) => s.open);
  const m = it.mkt;
  if (!m) return null;
  const zone = m.fng ? FNG_ZONES.find(([max]) => m.fng!.v <= max)?.[1] : undefined;
  return (
    <Sec icon={<GaugeGlyph size={20} />} title={t(lang, "dg_mkt_title")} onOpen={() => open("fng")}
      line={marketLine(it, lang)} tone={m.btc ? tone(m.btc.ch) : undefined}>
      <div className="dg-cells">
        {m.fng ? (
          <Cell label={t(lang, "dg_sig_fng")} value={num(m.fng.v)}
            sub={`${zone ? t(lang, zone) : ""} · ${iso(`${m.fng.d1 > 0 ? "+" : ""}${m.fng.d1}`)}`} tone={tone(m.fng.d1)} />
        ) : null}
        {m.btc ? <Cell label="BTC" value={px(m.btc.px)} sub={sPct(m.btc.ch)} tone={tone(m.btc.ch)} /> : null}
        {m.eth ? <Cell label="ETH" value={px(m.eth.px)} sub={sPct(m.eth.ch)} tone={tone(m.eth.ch)} /> : null}
        {m.cap ? <Cell label={t(lang, "dg_mkt_cap")} value={iso(capShort(m.cap.v))} sub={sPct(m.cap.ch)} tone={tone(m.cap.ch)} /> : null}
        {m.dom ? (
          <Cell label={t(lang, "dg_mkt_dom")} value={iso(pct(m.dom.btc, 1, false))}
            sub={iso(`${m.dom.d1 > 0 ? "+" : ""}${num(m.dom.d1, 2)}`)} tone={tone(m.dom.d1)} />
        ) : null}
        {m.alt ? (
          <Cell label={t(lang, "dg_mkt_alt")} value={num(m.alt.v)}
            sub={iso(`${m.alt.d1 > 0 ? "+" : ""}${m.alt.d1}`)} tone={tone(m.alt.d1)} />
        ) : null}
      </div>
      <p className="dg-note">{t(lang, "dg_mkt_note")}</p>
    </Sec>
  );
}

/* ── Институционалы ───────────────────────────────────────────────────── */

export function Institutions({ it, lang }: { it: DigestItem; lang: Lang }) {
  const open = useApp((s) => s.open);
  const inst = it.inst;
  if (!inst || !inst.etf.length) return null;
  const day = inst.etf[0]?.day;
  const il = instLine(it, lang);
  return (
    <Sec icon={<EtfGlyph size={20} />} title={t(lang, "dg_p_inst")} onOpen={() => open("etf")}
      line={il?.text} tone={il?.tone}>
      {day ? <p className="dg-sum">{t(lang, "dg_etf_day", { d: dateWord(lang, day) })}</p> : null}
      {inst.etf.map((e) => (
        <Row key={e.c} icon={<CoinIcon sym={e.c.toUpperCase()} size={28} />}
          title={t(lang, "dg_etf_coin", { c: e.c.toUpperCase() })}
          value={sUsd(e.v)} tone={tone(e.v)} onClick={() => open("etf")} />
      ))}
      {inst.top?.length ? (
        <p className="dg-line">
          {t(lang, "dg_etf_top")}{" "}
          {inst.top.map((f, i) => (
            <span key={f.t}>{i ? ", " : ""}<b>{f.t}</b> <span className="up">{sUsd(f.v)}</span></span>
          ))}
        </p>
      ) : null}
      {inst.bot?.length ? (
        <p className="dg-line">
          {t(lang, "dg_etf_bot")}{" "}
          {inst.bot.map((f, i) => (
            <span key={f.t}>{i ? ", " : ""}<b>{f.t}</b> <span className="dn">{sUsd(f.v)}</span></span>
          ))}
        </p>
      ) : null}
      {inst.cbp !== undefined ? (
        <p className="dg-line">
          {t(lang, "dg_sig_cbp")}{" "}
          <b className={tone(inst.cbp)}>{sPct(inst.cbp, 3)}</b>
          <span className="dim"> · {t(lang, "dg_cbp_hint")}</span>
        </p>
      ) : null}
    </Sec>
  );
}

/* ── Bitcoin на биржах ────────────────────────────────────────────────── */

export function BitcoinSec({ it, lang }: { it: DigestItem; lang: Lang }) {
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const setBigView = useApp((s) => s.setBigView);
  const b = it.btc;
  if (!b) return null;
  const toTab = () => {
    setBigView("btc");
    goTab("analytics");
  };
  const rows = (list: NonNullable<typeof b.buy>, buy: boolean) =>
    list.map((r) => (
      <Row key={`${buy ? "b" : "s"}${r.a}${r.ex}`} icon={<CoinIcon sym="BTC" size={28} />}
        title={iso(`${num(r.btc, r.btc >= 100 ? 0 : 2)} BTC${r.n && r.n > 1 ? ` ×${r.n}` : ""}`)}
        sub={`${buy ? "←" : "→"} ${r.ex} · ${shortAddr(r.a)}`}
        value={usd(r.v)} tone={buy ? "up" : "dn"}
        onClick={() => open("btcWallet", r.a)} />
    ));
  const bl = btcLine(it, lang);
  return (
    <Sec icon={<CoinIcon sym="BTC" size={20} />} title={t(lang, "btc_flow_title")} onOpen={toTab}
      line={bl?.text} tone={bl?.tone}>
      {b.net !== undefined ? (
        <p className="dg-sum">
          {t(lang, "btc_net")}{" "}
          <b className={b.net >= 0 ? "q up" : "q dn"}>{btcAmt(b.net, true)}</b>
          <span className="dim"> · {t(lang, "btc_wd")} {btcAmt(b.out ?? 0)} · {t(lang, "btc_dep")} {btcAmt(b.in ?? 0)}</span>
        </p>
      ) : null}
      {b.ex?.length ? (
        <p className="dg-line">
          {b.ex.map((e, i) => (
            <span key={e.ex}>{i ? " · " : ""}<b>{e.ex}</b> <span className={tone(e.net)}>{btcAmt(e.net, true)}</span></span>
          ))}
        </p>
      ) : null}
      {b.buy?.length ? <Sub>{t(lang, "dg_btc_wd")}</Sub> : null}
      {b.buy ? rows(b.buy, true) : null}
      {b.sell?.length ? <Sub>{t(lang, "dg_btc_dep")}</Sub> : null}
      {b.sell ? rows(b.sell, false) : null}
      {b.full === false ? <p className="dg-note">{t(lang, "dg_btc_partial")}</p> : null}
    </Sec>
  );
}

/* ── Лидеры рейтинга ─────────────────────────────────────────────────── */

export function Leaders({ it, lang }: { it: DigestItem; lang: Lang }) {
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const l = it.lead;
  if (!l || (!l.spot && !l.perp && !l.btc)) return null;
  return (
    <Sec icon={<TopGlyph size={20} />} title={t(lang, "rk_top_traders_30d")} onOpen={() => goTab("top")}
      line={leadLine(it, lang)} tone="up">
      {l.spot ? (
        <Row icon={<span className="dg-medal" aria-hidden="true">🥇</span>}
          title={<>{iso(shortAddr(l.spot.a))} <span className="dim">· BSC</span></>}
          sub={t(lang, "dg_lead_stats", { w: num(l.spot.win), n: num(l.spot.tr) })}
          value={sUsd(l.spot.pnl)} tone={tone(l.spot.pnl)} wrap
          onClick={() => open("deals", l.spot!.a, "spot")} />
      ) : null}
      {l.perp ? (
        <Row icon={<span className="dg-medal" aria-hidden="true">🥇</span>}
          title={<>{iso(shortAddr(l.perp.a))} <span className="dim">· Hyperliquid</span></>}
          sub={t(lang, "dg_lead_stats", { w: num(l.perp.win), n: num(l.perp.tr) })}
          value={sUsd(l.perp.pnl)} tone={tone(l.perp.pnl)} wrap
          onClick={() => open("deals", l.perp!.a, "perp")} />
      ) : null}
      {l.btc ? (
        <Row icon={<span className="dg-medal" aria-hidden="true">🥇</span>}
          title={<>{iso(shortAddr(l.btc.a))} <span className="dim">· Bitcoin</span></>}
          sub={`${t(lang, "btc_hold")} ${btcAmt(l.btc.btc)}`}
          value={sUsd(l.btc.pnl)} tone={tone(l.btc.pnl)} wrap
          onClick={() => open("btcWallet", l.btc!.a)} />
      ) : null}
      <p className="dg-note">{t(lang, "dg_lead_note")}</p>
    </Sec>
  );
}

/* ── Календарь: халвинг ──────────────────────────────────────────────── */

export function HalvingLine({ it, lang }: { it: DigestItem; lang: Lang }) {
  const h = it.halv;
  if (!h) return null;
  return (
    <Row icon={<span className="dg-medal" aria-hidden="true"><BtcGlyph /></span>}
      title={t(lang, "hv_title")}
      sub={`${t(lang, "dg_halv", { n: num(h.left) })} · ≈ ${dateWord(lang, h.eta)}`} />
  );
}

/* ── v3: строки вывода для старых разделов ─────────────────────────────── */

export function marketLine(it: DigestItem, lang: Lang): string | null {
  const m = it.mkt;
  if (!m?.btc) return null;
  const zone = m.fng ? FNG_ZONES.find(([max]) => m.fng!.v <= max)?.[1] : undefined;
  return t(lang, "dg_l_mkt", {
    p: iso(px(m.btc.px)), c: sPct(m.btc.ch), z: zone ? `${t(lang, zone)}: ${m.fng!.v}` : "—",
  });
}

export function instLine(it: DigestItem, lang: Lang): { text: string; tone?: "up" | "dn" } | null {
  const e = it.inst?.etf.find((x) => x.c === "btc");
  if (!e) return null;
  if (Math.abs(e.v) < 1e6) return { text: t(lang, "dg_l_etf_flat") };
  return e.v > 0 ? { text: t(lang, "dg_l_etf_in", { v: pUsd(e.v) }), tone: "up" }
    : { text: t(lang, "dg_l_etf_out", { v: pUsd(Math.abs(e.v)) }), tone: "dn" };
}

export function btcLine(it: DigestItem, lang: Lang): { text: string; tone?: "up" | "dn" } | null {
  const n = it.btc?.net;
  if (n === undefined) return null;
  return n >= 0 ? { text: t(lang, "dg_l_btcx_out", { v: btcAmt(n) }), tone: "up" }
    : { text: t(lang, "dg_l_btcx_in", { v: btcAmt(Math.abs(n)) }), tone: "dn" };
}

export function leadLine(it: DigestItem, lang: Lang): string | null {
  /* Лучший из лучших — у кого из первых мест прибыль больше. */
  const best = [it.lead?.spot, it.lead?.perp, it.lead?.btc]
    .filter((x): x is { pnl: number } & NonNullable<typeof x> => !!x)
    .sort((a, b) => b.pnl - a.pnl)[0];
  return best ? t(lang, "dg_l_lead", { v: pUsd(best.pnl) }) : null;
}

/* ── v3: ликвидации ───────────────────────────────────────────────────── */

function liqVerdict(lang: Lang, L: number, S: number): string {
  const ratio = L > 0 && S > 0 ? Math.max(L / S, S / L) : 0;
  const x = num(ratio, 1);
  return ratio < 1.25 && L > 0 && S > 0 ? t(lang, "lqs_v_eq") : L > S ? t(lang, "lqs_v_long", { x }) : t(lang, "lqs_v_short", { x });
}

export function LiqSec({ it, lang, icon }: { it: DigestItem; lang: Lang; icon: ReactNode }) {
  const open = useApp((s) => s.open);
  const q = it.liq;
  if (!q?.n) return null;
  const line = t(lang, "dg_l_liq", { v: pUsd(q.L + q.S), w: liqVerdict(lang, q.L, q.S) });
  return (
    <Sec icon={icon} title={t(lang, "lqs_title")} line={line} tone={q.S > q.L ? "up" : "dn"} onOpen={() => open("liqs")}>
      <p className="dg-sum">{t(lang, "dg_liq_split", { l: pUsd(q.L), s: pUsd(q.S), n: num(q.n), e: num(q.ex) })}</p>
      {q.coins.map((c) => (
        <Row key={c.sym} icon={<CoinIcon sym={c.sym} size={28} />} title={c.sym}
          sub={`${t(lang, "lqs_longs")} ${usd(c.L)} · ${t(lang, "lqs_shorts")} ${usd(c.S)}`}
          value={usd(c.L + c.S)} tone={c.S > c.L ? "up" : "dn"} onClick={() => open("liqs")} />
      ))}
      {q.big ? (
        <p className="dg-line">
          {t(lang, "lqs_biggest")}: <b>{pUsd(q.big.usd)}</b> · {t(lang, q.big.L ? "lqs_long" : "lqs_short")} {q.big.sym} · {q.big.ex}
        </p>
      ) : null}
    </Sec>
  );
}

/* ── v3: открытый интерес и фандинг ───────────────────────────────────── */

function oiVerdict(lang: Lang, ch: number, pch: number): string {
  const key = Math.abs(ch) < 1 ? "oih_q_flat" : ch > 0 ? (pch >= 0 ? "oih_q_up_up" : "oih_q_up_dn") : (pch >= 0 ? "oih_q_dn_up" : "oih_q_dn_dn");
  return t(lang, key, { oi: sPct(ch, 1), p: sPct(pch, 1) });
}

export function OiSec({ it, lang, icon }: { it: DigestItem; lang: Lang; icon: ReactNode }) {
  const open = useApp((s) => s.open);
  const b = it.oi?.btc;
  if (!b || b.ch === null || b.pch === null) return null;
  return (
    <Sec icon={icon} title={t(lang, "oih_title")} line={t(lang, "dg_l_oi", { w: oiVerdict(lang, b.ch, b.pch) })}
      onOpen={() => open("oihist")}>
      {(["btc", "eth"] as const).map((k) => {
        const o = it.oi?.[k];
        if (!o) return null;
        return (
          <div key={k} className="dg-grp">
            <Row icon={<CoinIcon sym={k.toUpperCase()} size={28} />} title={k.toUpperCase()}
              sub={o.ch !== null && o.pch !== null ? oiVerdict(lang, o.ch, o.pch) : undefined}
              value={usd(o.oi)} valueSub={o.ch !== null ? sPct(o.ch, 1) : undefined}
              tone={o.ch !== null ? tone(o.ch) : undefined} wrap onClick={() => open("oihist")} />
            {o.fund !== null ? (
              <p className="dg-line">
                {t(lang, "dg_oi_fund", { v: sPct(o.fund, 4), n: num(o.fex) })}
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="dg-note">{t(lang, "dg_oi_note")}</p>
    </Sec>
  );
}

/* ── v3: опционы ──────────────────────────────────────────────────────── */

function optMood(pcr: number | null): Parameters<typeof t>[1] {
  return pcr === null ? "op_mood_eq" : pcr < 0.7 ? "op_mood_up" : pcr > 1 ? "op_mood_dn" : "op_mood_eq";
}

export function OptSec({ it, lang, icon }: { it: DigestItem; lang: Lang; icon: ReactNode }) {
  const open = useApp((s) => s.open);
  const setOptSym = useApp((s) => s.setOptSym);
  const b = it.opt?.btc;
  if (!b) return null;
  const go = (sym: string) => () => { setOptSym(sym); open("options"); };
  return (
    <Sec icon={icon} title={t(lang, "op_title")}
      line={t(lang, "dg_l_opt", { n: pUsd(b.n), w: t(lang, optMood(b.pcr)) })}
      tone={b.pcr !== null && b.pcr < 0.7 ? "up" : b.pcr !== null && b.pcr > 1 ? "dn" : undefined}
      onOpen={go("BTC")}>
      {(["btc", "eth"] as const).map((k) => {
        const o = it.opt?.[k];
        if (!o) return null;
        return (
          <div key={k} className="dg-grp">
            <Row icon={<CoinIcon sym={k.toUpperCase()} size={28} />} title={k.toUpperCase()}
              sub={`Put/Call ${o.pcr !== null ? num(o.pcr, 2) : "—"}${o.dvol ? ` · DVOL ${num(o.dvol, 1)}` : ""}`}
              value={usd(o.n)} onClick={go(k.toUpperCase())} />
            {o.next ? (
              <p className="dg-line">
                {t(lang, "dg_opt_next", { d: dateWord(lang, o.next.ts), n: pUsd(o.next.n), mp: iso(px(o.next.mp)) })}
                <span className="dim"> · {t(lang, "dg_opt_mp", { p: sPct((o.next.mp / o.px - 1) * 100, 1) })}</span>
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="dg-note">{t(lang, "dg_opt_note")}</p>
    </Sec>
  );
}

/* ── v3: неделя вперёд ────────────────────────────────────────────────── */

function dayTime(lang: Lang, e: CalEv): string {
  const d = dateWord(lang, e.t);
  if (allDay(e)) return d;
  const dt = new Date(e.t * 1000);
  return `${d}, ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

export function AheadSec({ it, lang, icon }: { it: DigestItem; lang: Lang; icon: ReactNode }) {
  const open = useApp((s) => s.open);
  const cal = (it.cal ?? []) as CalEv[];
  return (
    <Sec icon={icon} title={t(lang, "dg_p_ahead")} onOpen={() => open("calendar")}>
      {cal.length ? cal.map((e, i) => (
        <Row key={`${e.k}${e.t}${i}`}
          icon={e.k === "macro" || e.k === "fomc"
            ? <span className="dg-medal" aria-hidden="true">{e.k === "fomc" ? "🇺🇸" : FLAG[e.cc ?? ""] ?? "🌍"}</span>
            : e.k === "cme" ? <span className="dg-medal" aria-hidden="true">📅</span>
              : <CoinIcon sym={e.sym ?? ""} size={28} />}
          title={calTitle(lang, e)}
          sub={e.k === "macro" && e.title && !calTitle(lang, e).includes(e.title) ? `${dayTime(lang, e)} · ${e.title}` : dayTime(lang, e)}
          value={e.n ? usd(e.n) : e.usd ? usd(e.usd) : undefined}
          valueSub={e.pct ? t(lang, "dg_unl_of", { p: pct(e.pct, 2, false) }) : undefined}
          wrap onClick={() => open("calendar")} />
      )) : <Quiet lang={lang} />}
      <HalvingLine it={it} lang={lang} />
    </Sec>
  );
}

/* ── Главные выводы одним списком — для картинки в соцсети ─────────────── */

export type DigestLine = { text: string; tone?: "up" | "dn" };

/** Выводы по вкладкам в порядке важности: рынок, ликвидации, интерес,
 *  опционы, ETF, биткоин на биржах. Те же слова, что в свёрнутых разделах. */
export function digestLines(it: DigestItem, lang: Lang): DigestLine[] {
  const out: DigestLine[] = [];
  const m = marketLine(it, lang);
  if (m) out.push({ text: m, tone: it.mkt?.btc ? tone(it.mkt.btc.ch) : undefined });
  const q = it.liq;
  if (q?.n) out.push({ text: t(lang, "dg_l_liq", { v: pUsd(q.L + q.S), w: liqVerdict(lang, q.L, q.S) }), tone: q.S > q.L ? "up" : "dn" });
  const b = it.oi?.btc;
  if (b && b.ch !== null && b.pch !== null) out.push({ text: t(lang, "dg_l_oi", { w: oiVerdict(lang, b.ch, b.pch) }) });
  const o = it.opt?.btc;
  if (o) {
    out.push({ text: t(lang, "dg_l_opt", { n: pUsd(o.n), w: t(lang, optMood(o.pcr)) }),
      tone: o.pcr !== null && o.pcr < 0.7 ? "up" : o.pcr !== null && o.pcr > 1 ? "dn" : undefined });
  }
  const il = instLine(it, lang);
  if (il) out.push(il);
  const bl = btcLine(it, lang);
  if (bl) out.push(bl);
  return out;
}
