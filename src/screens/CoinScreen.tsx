/**
 * Монета: свечи, цена, поток по кошелькам.
 *
 * Свечи тянутся с бирж через nginx. Не ответил никто — график не рисуется
 * и экран честно об этом говорит. Выдуманной истории здесь нет.
 */
import { useEffect, useState } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, px, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import { fetchCandles, TF_LABEL, TIMEFRAMES, type Candle, type Timeframe } from "../lib/klines";
import { CoinIcon, normalizeSym } from "../components/CoinIcon";
import { Area, BuySellBar, Candles } from "../components/Chart";
import { Card, Empty, Row, SectionTitle, Segmented, Skeleton, Tiles } from "../components/ui";

export function CoinScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const tf = useApp((s) => s.chartTf);
  const setTf = useApp((s) => s.setChartTf);
  const coins = useLive((s) => s.coins);
  const flow = useLive((s) => s.flow);

  const sym = String(arg || "");
  const key = normalizeSym(sym);
  const coin = coins[sym] ?? coins[key];

  const [candles, setCandles] = useState<Candle[] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setCandles(null);
    void fetchCandles(sym, tf, ctrl.signal).then((c) => {
      if (!ctrl.signal.aborted) setCandles(c);
    });
    return () => ctrl.abort();
  }, [sym, tf]);

  const row = (flow["24"]?.rows ?? []).find((r) => r.sym === sym || r.sym === key);
  const chg = coin?.c24 ?? coin?.chg ?? 0;

  return (
    <Frame
      title={
        <span className="ttl-coin">
          <CoinIcon sym={sym} size={30} />
          {sym}
        </span>
      }
      sub={coin ? px(coin.price) : undefined}
    >
      <Card>
        <SectionTitle note={t(lang, "ui_chg24")}>
          <span className={chg >= 0 ? "up" : "dn"}>{pct(chg)}</span>
        </SectionTitle>
        <Segmented<Timeframe>
          value={tf}
          onChange={setTf}
          options={TIMEFRAMES.map((id) => ({ id, label: t(lang, TF_LABEL[id]) }))}
        />
        {candles === null ? (
          <Skeleton rows={4} />
        ) : candles.length >= 3 ? (
          <Candles candles={candles} format={px} />
        ) : coin?.hist?.length ? (
          <Area points={coin.hist} height={140} />
        ) : (
          <Empty text={t(lang, "fund_loading")} />
        )}
        <Tiles
          items={[
            { label: t(lang, "ai_w1h"), value: pct(coin?.c1 ?? 0), tone: (coin?.c1 ?? 0) >= 0 ? "up" : "dn" },
            { label: t(lang, "ai_w6h"), value: pct(coin?.c6 ?? 0), tone: (coin?.c6 ?? 0) >= 0 ? "up" : "dn" },
            { label: t(lang, "ai_w24"), value: pct(chg), tone: chg >= 0 ? "up" : "dn" },
          ]}
          cols={3}
        />
      </Card>

      {row ? (
        <Card>
          <SectionTitle>{t(lang, "flow_title")}</SectionTitle>
          <p className="flow-sum">
            <span className={row.net >= 0 ? "up" : "dn"}>{signed(row.net)}</span>
            <small>
              {num(row.w)} {t(lang, "flow_wallets")}
            </small>
          </p>
          <BuySellBar buy={row.buy} sell={row.sell} />
          <div className="pulse-legend">
            <span className="up">{usd(row.buy)} {t(lang, "flow_buys")}</span>
            <span className="dn">{usd(row.sell)} {t(lang, "flow_sells")}</span>
          </div>
        </Card>
      ) : null}

      {coin?.who?.length ? (
        <Card>
          <SectionTitle>{t(lang, "hl_in_position")}</SectionTitle>
          {coin.who.map((h, i) => (
            <Row key={i} title={h.w} sub={ago(h.t)} value={usd(h.v)} />
          ))}
        </Card>
      ) : null}
    </Frame>
  );
}
