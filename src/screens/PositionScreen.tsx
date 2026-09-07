/**
 * Одна позиция на Hyperliquid: крупная прибыль сверху, свечи с ценовой
 * шкалой, затем цифры плитками — как в боте.
 *
 * Запас до ликвидации считается только когда есть и цена ликвидации, и
 * текущая. Прошлая версия делила без проверки и показывала «NaN%».
 */
import { useEffect, useState } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive, walletByAddr } from "../store/live";
import { t } from "../i18n/t";
import { lev as levFmt, num, pct, px, signed, usd } from "../lib/format";
import { fetchCandles, type Candle, type Timeframe } from "../lib/klines";
import { CoinIcon } from "../components/CoinIcon";
import { Candles } from "../components/Chart";
import { Hero } from "../components/Hero";
import { Card, Empty, Segmented, Skeleton, Tiles } from "../components/ui";

const TFS: { id: Timeframe; key: Parameters<typeof t>[1] }[] = [
  { id: "1h", key: "ui_tf_1h" },
  { id: "1d", key: "ui_tf_1d" },
  { id: "1w", key: "ui_tf_1w" },
];

export function PositionScreen({ arg, arg2 }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const tf = useApp((s) => s.chartTf);
  const setTf = useApp((s) => s.setChartTf);
  const wallets = useLive((s) => s.wallets);

  const w = walletByAddr(wallets, arg);
  const idx = Number(arg2 ?? -1);
  const p = w && Number.isInteger(idx) ? w.pos[idx] : undefined;
  const sym = p?.sym ?? "";

  const [candles, setCandles] = useState<Candle[] | null>(null);
  useEffect(() => {
    if (!sym) return;
    const ctrl = new AbortController();
    setCandles(null);
    void fetchCandles(sym, tf, ctrl.signal).then((c) => {
      if (!ctrl.signal.aborted) setCandles(c);
    });
    return () => ctrl.abort();
  }, [sym, tf]);

  if (!w || !p) {
    return (
      <Frame title={t(lang, "hl_open_positions")}>
        <Card><Empty text={t(lang, "hl_no_open_positions")} /></Card>
      </Frame>
    );
  }

  const cushion =
    p.liq > 0 && p.now > 0 ? ((p.long ? p.now - p.liq : p.liq - p.now) / p.now) * 100 : null;
  const share = w.bal > 0 ? (p.margin / w.bal) * 100 : null;

  return (
    <Frame title={p.sym} sub={w.name}>
      <Card>
        <Hero
          icon={<CoinIcon sym={p.sym} size={44} />}
          value={signed(p.pnl)}
          tone={p.pnl >= 0 ? "up" : "dn"}
          note={
            <>
              {pct(p.pct)} · {p.long ? t(lang, "hl_side_long") : t(lang, "hl_side_short")}{" "}
              {levFmt(p.lev)} · {p.isolated ? t(lang, "hl_isolated") : t(lang, "hl_cross")}
            </>
          }
        />

        <Segmented<Timeframe>
          value={tf}
          onChange={setTf}
          options={TFS.map((x) => ({ id: x.id, label: t(lang, x.key) }))}
        />
        {candles === null ? (
          <Skeleton rows={3} />
        ) : candles.length >= 3 ? (
          <Candles candles={candles} format={px} />
        ) : (
          <Empty text={t(lang, "fund_loading")} />
        )}

        <Tiles
          items={[
            { label: t(lang, "hl_entry_price"), value: px(p.entry) },
            { label: t(lang, "hl_mark_price"), value: px(p.now) },
            { label: t(lang, "hl_position_size"), value: usd(p.size) },
            { label: t(lang, "hl_collateral"), value: usd(p.margin) },
          ]}
        />
      </Card>

      <Card>
        <Tiles
          items={[
            { label: t(lang, "hl_liq"), value: p.liq > 0 ? px(p.liq) : "—" },
            { label: t(lang, "ui_to_liq"), value: cushion === null ? "—" : pct(cushion, 1, false),
              tone: cushion === null ? "dim" : cushion > 20 ? "up" : "dn" },
            { label: t(lang, "hl_leverage"), value: levFmt(p.lev) },
            { label: t(lang, "hl_of_account"), value: share === null ? "—" : `${num(share, 1)}%` },
          ]}
        />
      </Card>
    </Frame>
  );
}
