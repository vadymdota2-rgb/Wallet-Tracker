/**
 * «Мои кошельки» — то же, что кнопка 👤 в боте: крупная сумма за сутки,
 * перевес покупок, порог алертов и список кошельков.
 */
import { useApp, isPaused, walletLimit } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { num, pct, shortAddr, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import { setThreshold } from "../lib/api";
import { syncNow } from "../lib/sync";
import { tradeKind, tradeKindKey, isUpKind } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { BuySellBar } from "../components/Chart";
import { Hero } from "../components/Hero";
import { toast } from "../components/Toast";
import { Action, Card, Chips, Empty, Row, SectionTitle, Tiles } from "../components/ui";

const PRESETS = [100, 500, 1000, 5000, 10000, 50000];

/**
 * Процент за сутки показываем, только если он на что-то опирается.
 * У кошелька с остатком в один цент прежний экран рисовал «+349846143.11%».
 */
function dayPct(d1: number, bal: number): number | null {
  if (!Number.isFinite(d1) || !Number.isFinite(bal)) return null;
  if (bal < 1 || Math.abs(d1) > 1000) return null;
  return d1;
}

export function WalletsTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const { me, wallets, alerts, flow } = useLive();

  const limit = walletLimit(me.plan);
  const day = flow["24"];
  const watched = wallets.reduce((sum, w) => sum + (Number(w.bal) || 0), 0);
  const mine = wallets.reduce((sum, w) => sum + (Number(w.net) || 0), 0);

  const applyThreshold = async (value: number) => {
    const res = await setThreshold(value);
    if (res?.ok) {
      toast(t(lang, "threshold_updated"));
      void syncNow();
    } else toast(t(lang, "threshold_save_failed"), "err");
  };

  return (
    <>
      <Card>
        <Hero
          value={signed(mine)}
          tone={mine >= 0 ? "up" : "dn"}
          note={
            <>
              {bare(t(lang, "menu_my_wallets"))} · {t(lang, "big_win_24h")} · {usd(watched)}{" "}
              {t(lang, "hl_in_position")}
            </>
          }
        />
        {day ? (
          <>
            <BuySellBar buy={day.buy} sell={day.sell} />
            <div className="legend">
              <span className="up">{usd(day.buy)} {t(lang, "flow_bought")}</span>
              <span className="dn">{usd(day.sell)} {t(lang, "flow_sold")}</span>
            </div>
          </>
        ) : null}

        <Tiles
          items={[
            { label: bare(t(lang, "menu_my_wallets")), value: <>{num(wallets.length)} <em className="of">/ {limit}</em></> },
            { label: bare(t(lang, "menu_alert_threshold")), value: usd(me.threshold) },
          ]}
        />

        <Chips
          value={PRESETS.includes(Math.round(me.threshold)) ? Math.round(me.threshold) : -1}
          options={[
            ...PRESETS.map((p) => ({ id: p, label: usd(p) })),
            { id: -1, label: "…" },
          ]}
          onChange={(v) => (v === -1 ? open("threshold") : void applyThreshold(v))}
        />
      </Card>

      <Card>
        <SectionTitle note={t(lang, "big_win_24h")}>{bare(t(lang, "menu_my_wallets"))}</SectionTitle>

        {wallets.length === 0 ? (
          <Empty text={t(lang, "mw_no_wallets")} hint={t(lang, "mw_tap_add")} />
        ) : (
          wallets.map((w) => {
            const paused = isPaused(me.plan, w.primary);
            const d = dayPct(w.d1, w.bal);
            return (
              <Row
                key={w.addr}
                title={w.name}
                badge={w.primary ? bare(t(lang, "wl_main_wallet")) : paused ? t(lang, "wl_paused") : undefined}
                sub={
                  <>
                    {shortAddr(w.addr)} · {usd(w.bal)}
                    {w.trades ? ` · ${num(w.trades)} ${t(lang, "rk_trades")}` : ""}
                  </>
                }
                value={d === null ? "—" : pct(d)}
                tone={d === null ? undefined : d >= 0 ? "up" : "dn"}
                valueSub={w.pos.length ? `👁 ${w.pos.length}` : undefined}
                onClick={() => open("wallet", w.addr)}
              />
            );
          })
        )}

        <div className="stack-actions">
          <Action onClick={() => open("addWallet")} disabled={wallets.length >= limit}>
            {t(lang, "menu_add_wallet")}
          </Action>
          {wallets.length >= limit && me.plan !== "premium" ? (
            <small className="hint warn">{t(lang, "pr_limit_free")}</small>
          ) : null}
        </div>
      </Card>

      <Card>
        <SectionTitle note={`${num(me.alerts30d)} / 30${t(lang, "unit_day")}`}>
          {bare(t(lang, "menu_alert_threshold"))}
        </SectionTitle>
        {alerts.length ? (
          alerts.slice(0, 12).map((a, i) => {
            const kind = tradeKind(a.side);
            return (
              <Row
                key={i}
                icon={<CoinIcon sym={a.sym} size={30} />}
                title={a.sym}
                sub={`${a.name} · ${ago(a.t)}`}
                value={usd(a.notional)}
                tone={isUpKind(kind) ? "up" : "dn"}
                valueSub={t(lang, tradeKindKey(kind))}
                onClick={() => open("coin", a.sym)}
              />
            );
          })
        ) : (
          <Empty text={t(lang, "ui_nothing")} />
        )}
      </Card>
    </>
  );
}
