/**
 * Монета: свечи, цена, поток по кошелькам.
 *
 * Источников свечей два, и нужны оба. Мажоры берутся с бирж через nginx —
 * там настоящие OHLC. Но в потоке китов почти всё это токены BSC, которых
 * на биржах нет вовсе: по ним экран показывал пустоту и «загружается»,
 * хотя история цены лежит в базе бота. Её и собираем в свечи, как на
 * экране спотовых остатков.
 *
 * Что не изменилось: выдуманной истории здесь по-прежнему нет. Не ответил
 * никто и адреса нет — график не рисуется, и экран говорит об этом словами.
 */
import { useEffect, useState } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, px, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import {
  candlesFrom, fetchCandles, SPOT_TFS, TF_LABEL, TIMEFRAMES,
  type Candle, type SpotTf, type Timeframe,
} from "../lib/klines";
import { fetchTokenHist } from "../lib/api";
import { CoinIcon, normalizeSym } from "../components/CoinIcon";
import { Area, BuySellBar, Candles } from "../components/Chart";
import { Card, Empty, Row, SectionTitle, Segmented, Skeleton, Tiles } from "../components/ui";

export function CoinScreen({ arg, arg2 }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const tf = useApp((s) => s.chartTf);
  const setTf = useApp((s) => s.setChartTf);
  const coins = useLive((s) => s.coins);
  const flow = useLive((s) => s.flow);

  const sym = String(arg || "");
  const key = normalizeSym(sym);
  const coin = coins[sym] ?? coins[key];

  const row = (flow["24"]?.rows ?? []).find((r) => r.sym === sym || r.sym === key);
  /* Адрес контракта: его передаёт строка, из которой пришли, а если пришли
     не оттуда — берём из общей выгрузки. Без адреса истории цены не
     достать: тикеры не уникальны, искать по ним нельзя. */
  const addr = String(arg2 || coin?.addr || row?.addr || row?.token || "");
  const hasAddr = /^0x[0-9a-fA-F]{40}$/.test(addr);

  const [spotTf, setSpotTf] = useState<SpotTf>("1d");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [hist, setHist] = useState<[number, number][] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setCandles(null);
    void fetchCandles(sym, tf, ctrl.signal).then((c) => {
      if (!ctrl.signal.aborted) setCandles(c);
    });
    return () => ctrl.abort();
  }, [sym, tf]);

  /* Оба источника запрашиваются сразу, а не по цепочке: ждать отказа биржи,
     чтобы только потом пойти в базу, значит показывать скелет дважды. */
  useEffect(() => {
    if (!hasAddr) {
      setHist([]);
      return;
    }
    const ctrl = new AbortController();
    setHist(null);
    void fetchTokenHist(addr, ctrl.signal).then((d) => {
      if (!ctrl.signal.aborted) setHist(d?.ok ? d.hist ?? [] : []);
    });
    return () => ctrl.abort();
  }, [addr, hasAddr]);

  const chg = coin?.c24 ?? coin?.chg ?? 0;

  const exch = candles && candles.length >= 3 ? candles : null;
  const dex = hist?.length ? candlesFrom(hist, spotTf) : null;
  // Биржевые свечи точнее: там настоящие OHLC, а не почасовые замеры.
  const dexShown = !exch && !!dex && dex.length >= 3;
  const waiting = candles === null || (!exch && hasAddr && hist === null);

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
        {/* Набор таймфреймов зависит от источника: у биржи своя сетка, у
            истории из базы замеры почасовые, и минутных свечей из них не
            собрать. Показывать биржевую сетку над графиком из базы значило
            бы обещать точность, которой там нет. */}
        {dexShown ? (
          <Segmented<SpotTf>
            value={spotTf}
            onChange={setSpotTf}
            options={SPOT_TFS.map((id) => ({ id, label: t(lang, TF_LABEL[id]) }))}
          />
        ) : (
          <Segmented<Timeframe>
            value={tf}
            onChange={setTf}
            options={TIMEFRAMES.map((id) => ({ id, label: t(lang, TF_LABEL[id]) }))}
          />
        )}
        {waiting ? (
          <Skeleton rows={4} />
        ) : exch ? (
          <Candles candles={exch} format={px} />
        ) : dexShown ? (
          <Candles candles={dex!} format={px} />
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
          {/* То же имя, что у раздела, откуда сюда приходят. */}
          <SectionTitle>NetFlow</SectionTitle>
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
