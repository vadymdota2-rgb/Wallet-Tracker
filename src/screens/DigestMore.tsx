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
import type { ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct, px, shortAddr, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { CoinIcon } from "../components/CoinIcon";
import { EtfGlyph, GaugeGlyph, Row, TopGlyph } from "../components/ui";
import type { DigestItem, DigestSignal } from "../lib/types";

type Lang = Parameters<typeof t>[0];

/* Числа со знаком — изолированным куском слева направо: в арабском иначе
   «+95» превращалось в «95+». */
const iso = (x: string | number) => `⁦${x}⁩`;
const sUsd = (v: number) => iso(usd(v, true));
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

/** Раздел выпуска: значок вкладки, её имя и содержимое. Нажатие на шапку
 *  открывает саму вкладку — там то же самое подробно. */
export function Sec({ icon, title, children, onOpen }: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
}) {
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

const SIG_KEY: Record<DigestSignal["k"], Parameters<typeof t>[1]> = {
  fng: "dg_sig_fng",
  etf: "dg_sig_etf",
  btcx: "dg_sig_btcx",
  whales: "dg_sig_whales",
  cbp: "dg_sig_cbp",
};

function sigValue(s: DigestSignal): string {
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
  }
}

export function Summary({ it, lang }: { it: DigestItem; lang: Lang }) {
  const sig = it.sig ?? [];
  if (!sig.length) return null;
  const up = sig.filter((s) => s.d > 0).length;
  const dn = sig.filter((s) => s.d < 0).length;
  const n = sig.length;
  /* Перевес — когда за одну сторону больше половины сигналов. Иначе честно
     пишем, что сигналы расходятся: натягивать вывод на 2 против 2 нельзя. */
  const verdict = up > n / 2
    ? { cls: "up", text: t(lang, "dg_v_bull", { b: up, n }) }
    : dn > n / 2
      ? { cls: "dn", text: t(lang, "dg_v_bear", { s: dn, n }) }
      : { cls: "mix", text: t(lang, "dg_v_mix", { b: up, s: dn }) };
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
    <Sec icon={<GaugeGlyph size={20} />} title={t(lang, "dg_mkt_title")} onOpen={() => open("fng")}>
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
  return (
    <Sec icon={<EtfGlyph size={20} />} title={t(lang, "dg_p_inst")} onOpen={() => open("etf")}>
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
  return (
    <Sec icon={<CoinIcon sym="BTC" size={20} />} title={t(lang, "btc_flow_title")} onOpen={toTab}>
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
  if (!l || (!l.spot && !l.btc)) return null;
  return (
    <Sec icon={<TopGlyph size={20} />} title={t(lang, "rk_top_traders_30d")} onOpen={() => goTab("top")}>
      {l.spot ? (
        <Row icon={<span className="dg-medal" aria-hidden="true">🥇</span>}
          title={<>{iso(shortAddr(l.spot.a))} <span className="dim">· BSC</span></>}
          sub={t(lang, "dg_lead_stats", { w: num(l.spot.win), n: num(l.spot.tr) })}
          value={sUsd(l.spot.pnl)} tone={tone(l.spot.pnl)} wrap
          onClick={() => open("deals", l.spot!.a, "spot")} />
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
    <Row icon={<span className="dg-medal" aria-hidden="true">₿</span>}
      title={t(lang, "hv_title")}
      sub={`${t(lang, "dg_halv", { n: num(h.left) })} · ≈ ${dateWord(lang, h.eta)}`} />
  );
}
