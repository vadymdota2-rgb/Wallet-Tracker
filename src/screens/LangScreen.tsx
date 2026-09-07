/**
 * Выбор языка. Он сохраняется и на сервере — в той же строке `users`,
 * которую читает бот, поэтому чат и мини-апп говорят одинаково.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { LANGS } from "../i18n";
import { setLangRemote } from "../lib/api";
import { applyLang } from "../lib/lang";
import { toast } from "../components/Toast";
import { Card, Row, SectionTitle } from "../components/ui";
import type { LangCode } from "../i18n/types";

export function LangScreen() {
  const lang = useApp((s) => s.lang);

  const choose = async (code: LangCode) => {
    await applyLang(code, true);
    const res = await setLangRemote(code);
    // Сервер мог не принять — интерфейс уже переключился, и это правильно:
    // язык экрана не должен зависеть от сети.
    if (!res?.ok) toast(t(code, "ui_sync_failed"), "err");
    else toast(t(code, "ui_saved"));
  };

  return (
    <Frame title={t(lang, "lang_title")} sub={t(lang, "lang_choose")}>
      <Card>
        <SectionTitle>{t(lang, "lang_current")}</SectionTitle>
        {LANGS.map((l) => (
          <Row
            key={l.id}
            icon={<span aria-hidden="true">{l.flag}</span>}
            title={l.name}
            value={l.id === lang ? "✓" : undefined}
            onClick={() => void choose(l.id)}
          />
        ))}
      </Card>
    </Frame>
  );
}
