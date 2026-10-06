/**
 * Алерт карточкой: BSC, Bitcoin и Hyperliquid в одном виде.
 *
 * Бот кладёт к каждому алерту те же данные полями (alerts.data), без языка, —
 * карточка собирается из них на языке приложения, а не пересказывает текст
 * из чата. Наверху — откуда и чей кошелёк, крупно — что сделано и на
 * сколько, ниже сеткой только то, по чему решают: цена, количество, вход,
 * результат, плечо и ликвидация. Цвет края — направление: зелёный — ставка
 * вверх (покупка, лонг, закрытие шорта), красный — вниз, фиолетовый —
 * ликвидация.
 *
 * Слова — те же, что в алерте Telegram (ключи alert_* и hl_* взяты из
 * словаря бота): человек видит одно и то же в чате и здесь.
 */
import type { ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { num, pct, px, qtyWord, since, usd } from "../lib/format";
import { haptic, openExternal } from "../lib/telegram";
import type { AlertCardData } from "../lib/types";
import { CoinIcon } from "./CoinIcon";
import { VenueMark } from "./ui";

type Lang = Parameters<typeof t>[0];
type Tone = "up" | "dn" | "liq" | "flat";

const BSC_ACT: Record<string, DictKey> = {
  buy: "alert_buy",
  sell: "alert_sell",
  transfer: "alert_transfer",
  add_liq: "alert_add_liquidity",
  rm_liq: "alert_remove_liquidity",
  fees: "alert_collect_fees",
  wrap: "alert_wrap",
  unwrap: "alert_unwrap",
  bridge_out: "alert_bridge_out",
  bridge_in: "alert_bridge_in",
  arb: "alert_arbitrage",
  in: "alert_transfer",
  out: "alert_transfer",
};

const UP = new Set(["buy", "in", "hl_open_long", "hl_add_long", "hl_close_short", "hl_partial_short"]);
const DN = new Set(["sell", "out", "hl_open_short", "hl_add_short", "hl_close_long", "hl_partial_long"]);
const LIQ = new Set(["hl_liq_long", "hl_liq_short", "hl_liquidated"]);

function tone(a: string): Tone {
  if (LIQ.has(a)) return "liq";
  if (UP.has(a)) return "up";
  if (DN.has(a)) return "dn";
  return "flat";
}

function title(lang: Lang, d: AlertCardData): string {
  const key = d.k === "hl" ? (d.a as DictKey) : BSC_ACT[d.a] ?? "alert_transfer";
  const s = t(lang, key);
  return s === d.a ? t(lang, "hl_trade") : s;
}

/** Количество монет: у биткоина важны знаки после запятой, у мемкоина — нет. */
function amount(v: number | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  // Сотни миллионов мемкоинов — словом («297 млн»): девять цифр в строку не
  // помещаются, а точность до штуки тут ничего не говорит.
  if (a >= 1e6) return qtyWord(v);
  return num(v, a >= 1000 ? 0 : a >= 100 ? 2 : a >= 1 ? 4 : 6);
}

const VENUE: Record<AlertCardData["k"], { mark: "spot" | "perp" | "btc"; name: string }> = {
  bsc: { mark: "spot", name: "BSC" },
  btc: { mark: "btc", name: "Bitcoin" },
  hl: { mark: "perp", name: "Hyperliquid" },
};

function Fact({ label, children, tone: tn }: { label: ReactNode; children: ReactNode; tone?: "up" | "dn" }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={tn}>{children}</dd>
    </>
  );
}

export function AlertCard({ d, ts, nowSec, fresh, appOnly }: {
  d: AlertCardData;
  ts?: number;
  nowSec: number;
  fresh?: boolean;
  appOnly?: boolean;
}) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const tn = tone(d.a);
  const v = VENUE[d.k] ?? VENUE.bsc;
  const isHl = d.k === "hl";
  const sell = d.a === "sell";
  const partial = d.a === "hl_partial_long" || d.a === "hl_partial_short";

  const facts: ReactNode[] = [];
  if (d.px) facts.push(
    <Fact key="px" label={t(lang, isHl ? "hl_price" : sell ? "alert_sell_price" : "alert_buy_price")}>{px(d.px)}</Fact>);
  if (d.qty) facts.push(
    <Fact key="qty" label={t(lang, isHl ? "hl_qty" : "alert_qty")}>{amount(d.qty)} {d.sym}</Fact>);
  if (d.cq && d.cs) facts.push(
    <Fact key="cq" label={t(lang, sell ? "alert_received" : "alert_spent")}>{amount(d.cq)} {d.cs}</Fact>);
  if (d.ex) facts.push(
    <Fact key="ex" label={t(lang, d.a === "buy" || d.a === "in" ? "alert_from_exchange" : "alert_to_exchange")}>{d.ex}</Fact>);
  if (d.lev) facts.push(
    <Fact key="lev" label={t(lang, "hl_leverage")}>{d.lev}× {t(lang, d.iso ? "hl_isolated" : "hl_cross")}</Fact>);
  if (d.fills && d.fills > 1) facts.push(
    <Fact key="fills" label={t(lang, "hl_fills_in_series")}>{num(d.fills)}</Fact>);
  if (d.avg) facts.push(<Fact key="avg" label={t(lang, "alert_avg_entry")}>{px(d.avg)}</Fact>);
  if (typeof d.pnl === "number" && d.pnl !== 0) facts.push(
    <Fact key="pnl" label={t(lang, isHl ? "hl_pnl" : "alert_trade_pnl")} tone={d.pnl >= 0 ? "up" : "dn"}>
      {usd(d.pnl, true)}{typeof d.pnlPct === "number" ? ` (${pct(d.pnlPct)})` : ""}
    </Fact>);
  if (d.prior) facts.push(
    <Fact key="prior" label={t(lang, "al_prior")} tone={d.prior.chg >= 0 ? "up" : "dn"}>
      {px(d.prior.px)} · {since(d.prior.ago)} → {pct(d.prior.chg)}
    </Fact>);
  if (d.pos) facts.push(
    <Fact key="pos" label={t(lang, partial ? "hl_position_left" : "hl_position_size")}>{usd(d.pos)}</Fact>);
  if (d.margin) facts.push(
    <Fact key="margin" label={t(lang, "hl_collateral")}>
      {usd(d.margin)}
      {d.acct ? <small> · {pct((d.margin / d.acct) * 100, 1, false)} {t(lang, "hl_of_account")}</small> : null}
    </Fact>);
  if (d.liq) facts.push(<Fact key="liq" label={t(lang, "hl_liq")} tone="dn">{px(d.liq)}</Fact>);
  if (d.acct) facts.push(<Fact key="acct" label={t(lang, "hl_account")}>{usd(d.acct)}</Fact>);

  /* Куда дальше: транзакция в обозревателе и график монеты. График BTC и
     монет Hyperliquid — свой, в приложении; токены BSC — на DexScreener. */
  const txUrl = d.tx
    ? d.k === "btc" ? `https://mempool.space/tx/${d.tx}` : d.k === "bsc" ? `https://bscscan.com/tx/${d.tx}` : ""
    : "";
  const go = (fn: () => void) => () => {
    haptic("select");
    fn();
  };
  const toWallet = d.w ? go(() => open(d.k === "btc" ? "btcWallet" : "wallet", d.w)) : undefined;

  return (
    <article className={`alc ${tn}${fresh ? " fresh" : ""}`}>
      <header className="alc-hd">
        <span className="alc-venue">
          <VenueMark venue={v.mark} size={14} />
          {v.name}
        </span>
        {d.n ? (
          toWallet ? (
            <button type="button" className="alc-who" onClick={toWallet}>{d.n}</button>
          ) : (
            <span className="alc-who">{d.n}</span>
          )
        ) : null}
      </header>

      <div className="alc-main">
        <CoinIcon sym={d.sym || "?"} addr={d.k === "bsc" ? d.ca : undefined} size={38} />
        <div className="alc-what">
          <span className="alc-act">{title(lang, d)}</span>
          <b className="alc-sym">
            {d.sym || "—"}
            {d.txs && d.txs > 1 ? <small> ×{d.txs}</small> : null}
          </b>
        </div>
        <div className="alc-sum">
          <b>{usd(d.usd)}</b>
          {d.lev ? <small>{d.lev}×</small> : null}
        </div>
      </div>

      {facts.length ? <dl className="alc-grid">{facts}</dl> : null}
      {d.closed ? <p className="alc-closed">✓ {t(lang, "hl_position_closed")}</p> : null}

      <footer className="alc-links">
        {txUrl ? (
          <button type="button" onClick={go(() => openExternal(txUrl))}>{t(lang, "alert_transaction")} ↗</button>
        ) : null}
        {isHl && d.w ? (
          <button type="button" onClick={go(() => openExternal(`https://hypurrscan.io/address/${d.w}`))}>Hypurrscan ↗</button>
        ) : null}
        {d.k === "bsc" && d.ca ? (
          <button type="button" onClick={go(() => openExternal(`https://dexscreener.com/bsc/${d.ca}`))}>DexScreener ↗</button>
        ) : d.k !== "bsc" && d.sym ? (
          <button type="button" onClick={go(() => open("chart", d.sym))}>{t(lang, "chart_title")}</button>
        ) : null}
        {/* Время и «только здесь» — справа внизу: наверху им не хватало места
            рядом с именем кошелька. */}
        <span className="alc-t">
          {appOnly ? <em className="alert-tag">{t(lang, "alerts_app_only")}</em> : null}
          {ts ? since(Math.max(0, nowSec - Math.floor(ts / 1000))) : null}
        </span>
      </footer>
    </article>
  );
}
