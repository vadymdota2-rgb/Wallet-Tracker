/** «Ещё»: премиум, язык, порог, помощь — остаток главного меню бота. */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { LANGS } from "../i18n";
import { num, usd } from "../lib/format";
import { Card, Row, SectionTitle } from "../components/ui";

export function MoreTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const me = useLive((s) => s.me);

  const langName = LANGS.find((l) => l.id === lang);
  const days = me.premUntil ? Math.max(0, Math.ceil((me.premUntil - Date.now()) / 86400000)) : 0;

  return (
    <>
      <Card>
        <SectionTitle>{t(lang, "menu_title")}</SectionTitle>
        <Row
          icon={<span aria-hidden="true">⭐</span>}
          title={t(lang, "menu_premium")}
          sub={me.plan === "premium" ? `${t(lang, "pr_days_left")} ${num(days)}` : t(lang, "pr_unlock")}
          value={me.plan === "premium" ? "✓" : "🔒"}
          onClick={() => open("premium")}
        />
        <Row
          icon={<span aria-hidden="true">💰</span>}
          title={t(lang, "menu_alert_threshold")}
          sub={t(lang, "threshold_desc")}
          value={usd(me.threshold)}
          onClick={() => open("threshold")}
        />
        <Row
          icon={<span aria-hidden="true">📈</span>}
          title={t(lang, "menu_positions")}
          sub={t(lang, "hl_positions_choose")}
          onClick={() => open("positions")}
        />
        <Row
          icon={<span aria-hidden="true">🌐</span>}
          title={t(lang, "menu_languages")}
          sub={t(lang, "lang_current")}
          value={langName ? `${langName.flag} ${langName.name}` : lang}
          onClick={() => open("lang")}
        />
        <Row
          icon={<span aria-hidden="true">🧠</span>}
          title={t(lang, "ai_st_btn")}
          sub={t(lang, "ai_st_title")}
          onClick={() => open("model")}
        />
        <Row
          icon={<span aria-hidden="true">❓</span>}
          title={t(lang, "menu_help")}
          sub={t(lang, "help_support")}
          onClick={() => open("help")}
        />
      </Card>
    </>
  );
}
