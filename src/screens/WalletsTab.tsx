/**
 * «Мои кошельки» — крупная сумма за сутки, перевес покупок, порог алертов
 * и список кошельков с местом в рейтинге.
 */
import { useRef } from "react";
import { useApp, isPaused, walletLimit } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { num, shortAddr, usd } from "../lib/format";
import { boardShort, placeAt, rowVenue, venueName, walletRank } from "../lib/rank";
import { setThreshold } from "../lib/api";
import { toast } from "../components/Toast";
import { Action, botNodes, Card, Chips, Empty, EyeGlyph, PlusGlyph, Row, SectionTitle, Tiles, VenueMark } from "../components/ui";

const PRESETS = [100, 500, 1000, 5000, 10000, 50000];

export function WalletsTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const { me, wallets, rank } = useLive();

  const limit = walletLimit(me.plan);

  // Порог меняем на месте и только потом сохраняем. Раньше чип ждал ответа
  // сервера, а следом полной выгрузки — секунды на нажатие, за которые
  // экран не подавал признаков жизни. Сервер значение не правит, а лишь
  // принимает или отвергает, так что показывать его сразу — не обман.
  const seq = useRef(0);
  const base = useRef(0);

  const applyThreshold = async (value: number) => {
    const live = useLive.getState();
    if (Math.round(live.me.threshold) === value) return;
    // Откат — к последнему подтверждённому, а не к тому, что мы сами
    // нарисовали предыдущим нажатием.
    if (seq.current === 0) base.current = live.me.threshold;
    const my = ++seq.current;
    live.patchMe({ threshold: value });

    const res = await setThreshold(value);
    if (my !== seq.current) return; // перебито более поздним нажатием
    seq.current = 0;
    if (res?.ok) toast(t(lang, "threshold_updated"));
    else {
      live.patchMe({ threshold: base.current });
      toast(t(lang, "threshold_save_failed"), "err");
    }
  };

  return (
    <>
      <Card>
        <Tiles
          items={[
            {
              label: bare(t(lang, "menu_my_wallets")),
              value: <>{num(wallets.length)} <em className="of">/ {limit}</em></>,
            },
            { label: bare(t(lang, "menu_alert_threshold")), value: usd(me.threshold) },
          ]}
        />

        <Chips
          value={PRESETS.includes(Math.round(me.threshold)) ? Math.round(me.threshold) : -1}
          options={[...PRESETS.map((p) => ({ id: p, label: usd(p) })), { id: -1, label: "…" }]}
          onChange={(v) => (v === -1 ? open("threshold") : void applyThreshold(v))}
        />
      </Card>

      <Card>
        <SectionTitle note={`${num(wallets.length)} / ${limit}`}>
          {bare(t(lang, "menu_my_wallets"))}
        </SectionTitle>
        <div className="stack-actions">
          <Action onClick={() => open("addWallet")} disabled={wallets.length >= limit}>
            <PlusGlyph /> {bare(t(lang, "menu_add_wallet"))}
          </Action>
          {wallets.length >= limit && me.plan !== "premium" ? (
            <small className="hint warn">{t(lang, "pr_limit_free")}</small>
          ) : null}
        </div>

        {wallets.length === 0 ? (
          <Empty text={t(lang, "mw_no_wallets")} hint={botNodes(t(lang, "mw_tap_add"))} />
        ) : (
          wallets.map((w) => {
            const paused = isPaused(me.plan, w.primary);
            const place = walletRank(rank, w.addr);
            const venue = rowVenue(w, place);
            const at = venue ? placeAt(place, venue) : null;
            return (
              <Row
                key={w.addr}
                title={w.name}
                badge={w.primary ? bare(t(lang, "wl_main_wallet")) : paused ? t(lang, "wl_paused") : undefined}
                sub={shortAddr(w.addr)}
                // Площадка — третьей строкой под адресом. В середине она
                // вместе с местом не помещалась: имя резалось до «Silent …»,
                // а адрес до «0xb2b2……».
                sub2={
                  venue ? (
                    <span className="venue-line">
                      <VenueMark venue={venue} />
                      <em className="venue-name">{venueName(venue)}</em>
                    </span>
                  ) : undefined
                }
                // У кубка — доска, по которой место лучшее: PnL, ROI, WIN
                // или ACT. Из четырёх показываем ту одну, где кошелёк выше.
                mid={
                  at ? (
                    <span className="mark cup">
                      <em className="board">{boardShort(at.kind)}</em> 🏆 {at.place}
                    </span>
                  ) : undefined
                }
                value={
                  w.pos.length ? (
                    <span className="mark"><EyeGlyph /> {w.pos.length}</span>
                  ) : (
                    ""
                  )
                }
                onClick={() => open("wallet", w.addr)}
              />
            );
          })
        )}

      </Card>
    </>
  );
}
