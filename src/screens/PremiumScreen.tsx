/**
 * Премиум. Счета выставляет бот — Telegram Stars и TON доступны только в
 * чате, мини-апп их создать не может. Поэтому здесь список того, что даёт
 * подписка, и переход в чат.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { webApp } from "../lib/telegram";
import { Action, Card, Row, SectionTitle } from "../components/ui";

const BOT = "https://t.me/WalletTrackerOfficial";

export function PremiumScreen() {
  const lang = useApp((s) => s.lang);
  const me = useLive((s) => s.me);
  const active = me.plan === "premium";
  const days = me.premUntil ? Math.max(0, Math.ceil((me.premUntil - Date.now()) / 86400000)) : 0;

  const perks: Parameters<typeof t>[1][] = [
    "help_premium_1",
    "help_premium_2",
    "help_premium_3",
    "help_premium_4",
  ];

  return (
    <Frame
      title={active ? t(lang, "pr_active_title") : t(lang, "pr_title")}
      sub={active ? `${t(lang, "pr_days_left")} ${num(days)}` : t(lang, "pr_unlock")}
    >
      <Card>
        <SectionTitle>{t(lang, "pr_includes")}</SectionTitle>
        {perks.map((k) => (
          <Row key={k} title={t(lang, k)} />
        ))}
      </Card>

      <Card>
        <SectionTitle note={t(lang, "pr_subscription_label")}>{t(lang, "pr_price_label")}</SectionTitle>
        <Row title={t(lang, active ? "pr_renew" : "pr_buy")} />
        <Row title={t(lang, active ? "pr_renew_ton" : "pr_buy_ton")} />
        <p className="note dim">{t(lang, "ui_pay_in_bot")}</p>
        <div className="stack-actions">
          <Action
            onClick={() => {
              const w = webApp();
              // openTelegramLink есть не во всех клиентах — тогда обычная ссылка.
              const anyApp = w as unknown as { openTelegramLink?: (u: string) => void } | null;
              if (anyApp?.openTelegramLink) anyApp.openTelegramLink(BOT);
              else window.open(BOT, "_blank", "noopener");
            }}
          >
            {t(lang, "ui_open_bot")}
          </Action>
        </div>
      </Card>
    </Frame>
  );
}
