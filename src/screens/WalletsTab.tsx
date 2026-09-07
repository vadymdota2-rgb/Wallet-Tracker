/**
 * «Мой аккаунт» — то же, что кнопка 👤 в боте: отслеживаемые кошельки и то,
 * что они держат прямо сейчас.
 */
import { useApp, isPaused, walletLimit } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { pct, shortAddr, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import { tradeKind, tradeKindKey, isUpKind } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { BuySellBar } from "../components/Chart";
import { Action, Card, Empty, Row, SectionTitle, Tiles } from "../components/ui";

export function WalletsTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const { me, wallets, alerts, flow, status } = useLive();

  const limit = walletLimit(me.plan);
  const free = Math.max(0, limit - wallets.length);
  const day = flow["24"];
  const totalEquity = wallets.reduce((sum, w) => sum + (Number(w.bal) || 0), 0);

  return (
    <>
      {day ? (
        <Card>
          <SectionTitle note={t(lang, "flow_hint")}>{t(lang, "ui_pulse")}</SectionTitle>
          <div className="pulse">
            <b className={day.net >= 0 ? "up" : "dn"}>{signed(day.net)}</b>
            <BuySellBar buy={day.buy} sell={day.sell} />
            <div className="pulse-legend">
              <span className="up">{usd(day.buy)} {t(lang, "flow_total_buys")}</span>
              <span className="dn">{usd(day.sell)} {t(lang, "flow_total_sells")}</span>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <SectionTitle
          note={wallets.length ? `${wallets.length} / ${limit}` : undefined}
        >
          {t(lang, "account_title")}
        </SectionTitle>

        {wallets.length === 0 ? (
          <Empty
            text={status === "anon" ? t(lang, "menu_no_wallets") : t(lang, "mw_no_wallets")}
            hint={t(lang, "mw_tap_add")}
          />
        ) : (
          <>
            <Tiles
              items={[
                { label: t(lang, "ui_portfolio"), value: usd(totalEquity) },
                { label: bare(t(lang, "menu_alert_threshold")), value: usd(me.threshold) },
              ]}
            />
            {wallets.map((w) => {
              const paused = isPaused(me.plan, w.primary);
              const openPos = w.pos.length;
              return (
                <Row
                  key={w.addr}
                  icon={<span className="wl-ico">{w.primary ? "🔔" : paused ? "⏸" : "👛"}</span>}
                  title={w.name}
                  badge={w.primary ? t(lang, "wl_main_wallet") : paused ? t(lang, "wl_paused") : undefined}
                  sub={
                    <>
                      {shortAddr(w.addr)}
                      {openPos ? ` · ${openPos} ${t(lang, "hl_in_position")}` : ""}
                    </>
                  }
                  value={usd(w.bal)}
                  valueSub={w.d1 ? pct(w.d1) : undefined}
                  tone={w.d1 > 0 ? "up" : w.d1 < 0 ? "dn" : undefined}
                  onClick={() => open("wallet", w.addr)}
                />
              );
            })}
          </>
        )}

        <div className="stack-actions">
          <Action onClick={() => open("addWallet")} disabled={free === 0 && me.plan !== "premium"}>
            {t(lang, "menu_add_wallet")}
          </Action>
          {free > 0 ? (
            <small className="hint">{free} {t(lang, "ui_free_slots")}</small>
          ) : me.plan !== "premium" ? (
            <small className="hint warn">{t(lang, "free_plan_1_wallet")}</small>
          ) : null}
        </div>

        {me.plan !== "premium" && wallets.length > 1 ? (
          <p className="note">
            {t(lang, "mw_free_notice1")}
            <br />
            {t(lang, "mw_free_notice2")}
          </p>
        ) : null}
      </Card>

      <Card>
        <SectionTitle note={`${me.alerts30d} / 30d`}>{t(lang, "menu_alert_threshold")}</SectionTitle>
        <Row
          title={t(lang, "threshold_current")}
          value={usd(me.threshold)}
          onClick={() => open("threshold")}
        />
        {alerts.length ? (
          alerts.slice(0, 12).map((a, i) => {
            const kind = tradeKind(a.side);
            return (
              <Row
                key={i}
                icon={<CoinIcon sym={a.sym} size={28} />}
                title={a.sym}
                sub={`${a.name || shortAddr("")} · ${ago(a.t)}`}
                value={usd(a.notional)}
                tone={isUpKind(kind) ? "up" : "dn"}
                valueSub={t(lang, tradeKindKey(kind))}
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
