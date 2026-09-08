/**
 * Покупка на BSC, которую кошелёк ещё не продал.
 *
 * Считается по сделкам из базы тем же учётом, что в боте: покупка добавляет
 * количество и стоимость, продажа списывает их пропорционально. Осталось
 * количество — значит токен на руках, и это ровно то, о чём приходил алерт.
 *
 * Свечи собираются из почасовых цен токена: биржевых свечей тут быть не
 * может, такие токены на биржах не торгуются. Устройство экрана то же, что
 * у позиции Hyperliquid: цена входа отдельной линией, у текущей цены —
 * доходность и прибыль.
 */
import { useEffect, useState } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive, walletByAddr } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, px, signed, usd } from "../lib/format";
import { holdTime } from "../lib/labels";
import { candlesFrom, TF_LABEL, SPOT_TFS, type SpotTf } from "../lib/klines";
import { fetchTokenHist } from "../lib/api";
import { CoinIcon } from "../components/CoinIcon";
import { Candles } from "../components/Chart";
import { Hero } from "../components/Hero";
import { Card, Empty, Segmented, Skeleton, Tiles } from "../components/ui";

export function SpotScreen({ arg, arg2 }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const wallets = useLive((s) => s.wallets);

  const w = walletByAddr(wallets, arg);
  const idx = Number(arg2 ?? -1);
  const h = w && Number.isInteger(idx) ? w.holds?.[idx] : undefined;
  const token = h?.token ?? "";

  const [tf, setTf] = useState<SpotTf>("1d");
  const [hist, setHist] = useState<[number, number][] | null>(null);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    setHist(null);
    void fetchTokenHist(token, ctrl.signal).then((d) => {
      if (!ctrl.signal.aborted) setHist(d?.ok ? d.hist ?? [] : []);
    });
    return () => ctrl.abort();
  }, [token]);

  if (!w || !h) {
    return (
      <Frame title={t(lang, "ui_spot_open")}>
        <Card><Empty text={t(lang, "hl_no_open_positions")} /></Card>
      </Frame>
    );
  }

  const candles = hist ? candlesFrom(hist, tf) : null;

  return (
    <Frame title={h.sym} sub={w.name}>
      <Card>
        <Hero
          icon={<CoinIcon sym={h.sym} icon={h.icon} size={44} />}
          value={signed(h.pnl)}
          tone={h.pnl >= 0 ? "up" : "dn"}
          note={<>{pct(h.pct)} · {usd(h.value)}</>}
        />

        <Segmented<SpotTf>
          value={tf}
          onChange={setTf}
          options={SPOT_TFS.map((id) => ({ id, label: t(lang, TF_LABEL[id]) }))}
        />
        {candles === null ? (
          <Skeleton rows={3} />
        ) : candles.length >= 3 ? (
          <Candles
            candles={candles}
            format={px}
            entry={h.entry}
            entryLabel={t(lang, "hl_entry_price")}
            note={`${pct(h.pct)} · ${signed(h.pnl)}`}
            noteTone={h.pnl >= 0 ? "up" : "dn"}
          />
        ) : (
          <Empty text={t(lang, "fund_loading")} />
        )}

        {h.partial ? <p className="note warn">{t(lang, "ui_partial_note")}</p> : null}

        <Tiles
          items={[
            { label: t(lang, "hl_entry_price"), value: `${h.partial ? "≈ " : ""}${px(h.entry)}` },
            { label: t(lang, "hl_mark_price"), value: px(h.price) },
            { label: t(lang, "ui_invested"), value: `${h.partial ? "≈ " : ""}${usd(h.cost)}` },
            { label: t(lang, "ui_worth_now"), value: usd(h.value) },
            { label: t(lang, "ui_buys"), value: num(h.buys) },
            // Длительность, а не календарная фраза: «в прошлом месяце» и
            // «позавчера» и не точны, и в плитку не влезают.
            {
              label: t(lang, "ui_held_since"),
              value: h.since ? holdTime(Date.now() / 1000 - h.since, lang) ?? "—" : "—",
            },
          ]}
        />
      </Card>
    </Frame>
  );
}
