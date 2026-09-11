/**
 * Последние десять завершённых сделок кошелька из рейтинга.
 *
 * Завершённых, а не отдельных переводов: покупка сама по себе ничего не
 * говорит о трейдере, смысл появляется, когда видно за сколько взял, за
 * сколько отдал и что осталось в кармане.
 *
 * Экран, а не раскрытие внутри карточки: десять строк под каждой из ста
 * карточек превратили бы рейтинг в километровую ленту, а грузить их заранее
 * — это сто запросов к базе ради того, что открывают изредка.
 */
import { useEffect, useState } from "react";
import { Frame } from "./Screen";
import type { ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { pct, px, shortAddr, signed, since, usd } from "../lib/format";
import { fetchDeals } from "../lib/api";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty } from "../components/ui";
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

  /**
   * Чем была сделка: сторона и плечо.
   *
   * У спота подписи нет. Завершённая сделка там по определению продажа, и
   * одинаковое «ПРОДАЖА» в каждой из десяти строк ничего не сообщает — всё
   * говорят цены и результат рядом.
   */
  const side = (d: Deal): string => {
    if (venue === "spot") return "";
    if (d.liq) return t(lang, "ui_liquidated");
    // Переворот: закрыли одну сторону и открыли другую, а какую именно —
    // биржа в коде не различает. Подписывать наугад нечем.
    if (d.long === null || d.long === undefined) return "";
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
            <div className="deal" key={`${d.ts}-${i}`}>
              <CoinIcon sym={d.sym} icon={d.icon} size={34} />
              <div className="deal-main">
                <div className="deal-ttl">
                  <b>{d.sym}</b>
                  {side(d) ? <em>{side(d)}</em> : null}
                </div>
                {/* Цены входа и выхода — то, ради чего сюда и заходят. Нет
                    знаков после запятой у токена — строки не будет: врать
                    про цену хуже, чем её не показать, а результат в долларах
                    от этого не зависит и остаётся на месте. */}
                {d.buy && d.sell ? (
                  <div className="deal-px">
                    {px(d.buy)} <span className="arrow">→</span> {px(d.sell)}
                  </div>
                ) : null}
                <div className="deal-ago">
                  {since(Math.max(0, Math.floor(Date.now() / 1000) - d.ts))}
                </div>
              </div>
              <div className="deal-res">
                <b className={d.pnl >= 0 ? "up" : "dn"}>{signed(d.pnl)}</b>
                {/* Доходность только у фьючерсов: там знаменатель — маржа,
                    её биржа сообщает точно. По споту вложенное считается из
                    цен DEX на момент покупки и для старых монет
                    недостоверно — поэтому доску ROI по BSC и сняли. */}
                {d.roi !== null && d.roi !== undefined ? (
                  <small className={d.roi >= 0 ? "up" : "dn"}>{pct(d.roi, 1)}</small>
                ) : null}
                <small>{usd(d.v)}</small>
              </div>
            </div>
          ))
        )}
      </Card>
    </Frame>
  );
}
