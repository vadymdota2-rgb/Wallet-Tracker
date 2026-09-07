/**
 * «Мои кошельки» — крупная сумма за сутки, перевес покупок, порог алертов
 * и список кошельков с местом в рейтинге.
 */
import { useApp, isPaused, walletLimit } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { num, shortAddr, usd } from "../lib/format";
import { walletRank } from "../lib/rank";
import { setThreshold } from "../lib/api";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { Action, Card, Chips, Empty, Row, SectionTitle, Tiles, VenueMark } from "../components/ui";

const PRESETS = [100, 500, 1000, 5000, 10000, 50000];

export function WalletsTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const { me, wallets, rank } = useLive();

  const limit = walletLimit(me.plan);

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
            {t(lang, "menu_add_wallet")}
          </Action>
          {wallets.length >= limit && me.plan !== "premium" ? (
            <small className="hint warn">{t(lang, "pr_limit_free")}</small>
          ) : null}
        </div>

        {wallets.length === 0 ? (
          <Empty text={t(lang, "mw_no_wallets")} hint={t(lang, "mw_tap_add")} />
        ) : (
          wallets.map((w) => {
            const paused = isPaused(me.plan, w.primary);
            const place = walletRank(rank, w.addr);
            return (
              <Row
                key={w.addr}
                title={w.name}
                badge={w.primary ? bare(t(lang, "wl_main_wallet")) : paused ? t(lang, "wl_paused") : undefined}
                sub={shortAddr(w.addr)}
                mid={
                  place.best ? (
                    <span className="mark cup">
                      <VenueMark venue={place.best.venue} />
                      🏆 {place.best.place}
                    </span>
                  ) : undefined
                }
                value={w.pos.length ? <span className="mark">👁 {w.pos.length}</span> : ""}
                onClick={() => open("wallet", w.addr)}
              />
            );
          })
        )}

      </Card>
    </>
  );
}
