/** Помощь — тот же текст, что бот показывает по кнопке ❓. */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { Card, Row, SectionTitle } from "../components/ui";

const MENU: Parameters<typeof t>[1][] = [
  "help_menu_add",
  "help_menu_mywallets",
  "help_menu_top",
  "help_menu_positions",
  "help_menu_threshold",
  "help_menu_premium",
  "help_menu_languages",
];

export function HelpScreen() {
  const lang = useApp((s) => s.lang);
  return (
    <Frame title={t(lang, "help_title")}>
      <Card>
        <p className="note">{t(lang, "help_intro")}</p>
      </Card>
      <Card>
        <SectionTitle>{t(lang, "help_commands")}</SectionTitle>
        {MENU.map((k) => (
          <Row key={k} title={t(lang, k)} />
        ))}
      </Card>
      <Card>
        <SectionTitle>{t(lang, "help_premium_title")}</SectionTitle>
        <Row title={t(lang, "help_premium_1")} />
        <Row title={t(lang, "help_premium_2")} />
        <Row title={t(lang, "help_premium_3")} />
        <Row title={t(lang, "help_premium_4")} />
      </Card>
      <Card>
        <p className="note dim">{t(lang, "help_disclaimer")}</p>
        <p className="note">{t(lang, "help_support")}</p>
        <p className="note">{t(lang, "help_channel")}</p>
      </Card>
    </Frame>
  );
}
