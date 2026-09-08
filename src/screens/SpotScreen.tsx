/**
 * Покупка на BSC, которую кошелёк ещё не продал.
 *
 * Считается по сделкам из базы тем же учётом, что в боте: покупка добавляет
 * количество и стоимость, продажа списывает их пропорционально. Осталось
 * количество — значит токен на руках, и это ровно то, о чём приходил алерт.
 *
 * График — из истории цен токена, той же, что под карточкой монеты. Свечей с
 * биржи здесь нет и быть не может: такие токены на биржах не торгуются.
 */
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive, walletByAddr } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, px, signed, since, usd } from "../lib/format";

import { CoinIcon } from "../components/CoinIcon";
import { Area } from "../components/Chart";
import { Hero } from "../components/Hero";
import { Card, Empty, Tiles } from "../components/ui";

export function SpotScreen({ arg, arg2 }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const wallets = useLive((s) => s.wallets);

  const w = walletByAddr(wallets, arg);
  const idx = Number(arg2 ?? -1);
  const h = w && Number.isInteger(idx) ? w.holds?.[idx] : undefined;

  if (!w || !h) {
    return (
      <Frame title={t(lang, "ui_spot_open")}>
        <Card><Empty text={t(lang, "hl_no_open_positions")} /></Card>
      </Frame>
    );
  }

  return (
    <Frame title={h.sym} sub={w.name}>
      <Card>
        <Hero
          icon={<CoinIcon sym={h.sym} size={44} />}
          value={signed(h.pnl)}
          tone={h.pnl >= 0 ? "up" : "dn"}
          note={<>{pct(h.pct)} · {usd(h.value)}</>}
        />
        {h.hist.length >= 2 ? (
          <Area points={h.hist} height={150} up={h.pnl >= 0} />
        ) : (
          <Empty text={t(lang, "fund_loading")} />
        )}
        <Tiles
          items={[
            { label: t(lang, "hl_entry_price"), value: px(h.entry) },
            { label: t(lang, "hl_mark_price"), value: px(h.price) },
            { label: t(lang, "ui_invested"), value: usd(h.cost) },
            { label: t(lang, "ui_worth_now"), value: usd(h.value) },
            { label: t(lang, "ui_buys"), value: num(h.buys) },
            { label: t(lang, "ui_held_since"), value: h.since ? since(Date.now() / 1000 - h.since) : "—" },
          ]}
        />
      </Card>
    </Frame>
  );
}
