/**
 * Последние десять сделок кошелька из рейтинга.
 *
 * Экран, а не раскрытие внутри карточки: десять строк под каждой из ста
 * карточек превратили бы рейтинг в километровую ленту, а грузить их заранее
 * — это сто запросов к базе ради того, что открывают изредка.
 *
 * Что показываем, зависит от площадки. У спота сделка — это покупка или
 * продажа монеты на сумму. У фьючерсов — вход в лонг или шорт с плечом, и
 * отдельно помечена ликвидация: выдавать её за обычную сделку нечестно,
 * позицию закрыли не по воле трейдера.
 */
import { useEffect, useState } from "react";
import { Frame } from "./Screen";
import type { ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { shortAddr, signed, since, usd } from "../lib/format";
import { fetchDeals } from "../lib/api";
import { Card, Empty, Row } from "../components/ui";
import type { Deal } from "../lib/types";

export function DealsScreen({ arg, arg2 }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const addr = arg ?? "";
  const venue = arg2 === "perp" ? "perp" : "spot";

  const [deals, setDeals] = useState<Deal[] | null>(null);

  useEffect(() => {
    if (!addr) return;
    const ctrl = new AbortController();
    void (async () => {
      const res = await fetchDeals(addr, venue, ctrl.signal);
      if (!ctrl.signal.aborted) setDeals(res?.ok ? res.deals ?? [] : []);
    })();
    return () => ctrl.abort();
  }, [addr, venue]);

  const side = (d: Deal): string => {
    if (venue === "spot") return t(lang, d.buy ? "alert_buy" : "alert_sell");
    if (d.liq) return t(lang, "ui_liquidated");
    const dir = d.long ? t(lang, "hl_side_long") : t(lang, "hl_side_short");
    return d.lev ? `${dir} ${d.lev}×` : dir;
  };

  return (
    <Frame title={t(lang, "ui_deals")} sub={`${shortAddr(addr)} · ${t(lang, "ui_deals_last")}`}>
      <Card>
        {deals === null ? (
          <Empty text={t(lang, "ui_loading")} />
        ) : deals.length === 0 ? (
          <Empty text={t(lang, "rk_no_completed_trades")} />
        ) : (
          deals.map((d, i) => (
            <Row
              key={`${d.ts}-${i}`}
              title={d.sym}
              sub={
                <>
                  {side(d)}
                  {/* Результат — отдельной цифрой рядом со стороной. Красить
                      им объём нельзя: зелёные «$270,3K» читаются как
                      заработок, хотя это размер сделки, а не прибыль. */}
                  {d.pnl ? (
                    <>
                      {" · "}
                      <b className={d.pnl >= 0 ? "up" : "dn"}>{signed(d.pnl)}</b>
                    </>
                  ) : null}
                </>
              }
              value={usd(d.v)}
              valueSub={since(Math.max(0, Math.floor(Date.now() / 1000) - d.ts))}
            />
          ))
        )}
      </Card>
    </Frame>
  );
}
