/**
 * «Ещё»: премиум, язык, порог, помощь — остаток главного меню бота.
 *
 * «Открытых позиций» здесь нет: позиции кошелька смотрят в самом кошельке
 * («Мои кошельки» → кошелёк), и отдельная строка вела в тот же список второй
 * дорогой. «Модели» тоже нет: её состояние открывается из вкладки Cortex, где
 * оно и нужно. Значок уже стоит слева, поэтому из подписи он снимается — иначе
 * каждый пункт начинался с двух одинаковых картинок подряд.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { LANGS } from "../i18n";
import { num, usd } from "../lib/format";
import { Card, Row, SectionTitle, ThresholdGlyph } from "../components/ui";

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
          title={bare(t(lang, "menu_premium"))}
          sub={me.plan === "premium" ? `${t(lang, "pr_days_left")} ${num(days)}` : t(lang, "pr_unlock")}
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
