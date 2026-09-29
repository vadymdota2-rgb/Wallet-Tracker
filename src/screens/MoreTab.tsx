/**
 * «Ещё»: премиум, язык, порог, помощь — остаток главного меню бота.
 *
 * «Открытых позиций» здесь нет: позиции кошелька смотрят в самом кошельке
 * («Мои кошельки» → кошелёк), и отдельная строка вела в тот же список второй
 * дорогой. Значок уже стоит слева, поэтому из подписи он снимается — иначе
 * каждый пункт начинался с двух одинаковых картинок подряд.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { LANGS } from "../i18n";
import { num, usd } from "../lib/format";
import { BellGlyph, Card, Row, SectionTitle, ThresholdGlyph } from "../components/ui";

export function MoreTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const me = useLive((s) => s.me);

  const langName = LANGS.find((l) => l.id === lang);
  const unread = me.unread ?? 0;
  const days = me.premUntil ? Math.max(0, Math.ceil((me.premUntil - Date.now()) / 86400000)) : 0;

  return (
    <>
      <Card>
        <SectionTitle>{t(lang, "menu_title")}</SectionTitle>
        {/* История алертов — первой: сюда заглядывают чаще всего, а со
            «только в приложении» это единственное место, где алерты видны. */}
        <Row
          icon={<span className="row-glyph"><BellGlyph size={22} /></span>}
          title={t(lang, "alerts_title")}
          sub={unread > 0 ? `${num(unread)} ${t(lang, "alerts_new")}` : t(lang, "alerts_sub")}
          value={unread > 0 ? <span className="count-badge">{unread > 99 ? "99+" : unread}</span> : undefined}
          onClick={() => open("alerts")}
        />
        <Row
          icon={<span aria-hidden="true">⭐</span>}
          title={bare(t(lang, "menu_premium"))}
          sub={me.plan === "premium"
            ? `${t(lang, "pr_days_left")} ${me.service ? "∞" : num(days)}`
            : t(lang, "pr_unlock")}
          value={me.plan === "premium" ? "✓" : "🔒"}
          onClick={() => open("premium")}
        />
        <Row
          icon={<span className="row-glyph"><ThresholdGlyph size={22} /></span>}
          title={bare(t(lang, "menu_alert_threshold"))}
          sub={t(lang, "threshold_desc")}
          value={usd(me.threshold)}
          onClick={() => open("threshold")}
        />
        <Row
          icon={<span aria-hidden="true">🌐</span>}
          title={bare(t(lang, "menu_languages"))}
          sub={t(lang, "lang_current")}
          value={langName ? `${langName.flag} ${langName.name}` : lang}
          onClick={() => open("lang")}
        />
        <Row
          icon={<span aria-hidden="true">❓</span>}
          title={bare(t(lang, "menu_help"))}
          sub={t(lang, "help_support")}
          onClick={() => open("help")}
        />
        <Row
          icon={<span aria-hidden="true">🔒</span>}
          title={t(lang, "ui_legal")}
          sub={`${bare(t(lang, "legal_btn_privacy"))} · ${bare(t(lang, "legal_terms_title"))}`}
          onClick={() => open("legal")}
        />
      </Card>
    </>
  );
}
