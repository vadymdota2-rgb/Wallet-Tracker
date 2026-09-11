/**
 * Политика конфиденциальности, условия использования и удаление данных.
 *
 * Тексты те же, что показывает бот по /privacy и /terms: они вынимаются из
 * его словарей скриптом sync-i18n, а не пишутся здесь заново. Документ,
 * который в чате и в приложении звучит по-разному, — это два разных
 * документа, и какой из них настоящий, пользователю не узнать.
 *
 * Удаление требует подтверждения: кнопка «удалить» рядом с текстом политики
 * слишком легко нажимается, а вернуть оплаченный премиум будет нечем.
 */
import { useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { bare, t } from "../i18n/t";
import { forgetMe } from "../lib/api";
import { dropSnapshot } from "../store/live";
import { toast } from "../components/Toast";
import { Action, Card, SectionTitle } from "../components/ui";

export function LegalScreen() {
  const lang = useApp((s) => s.lang);
  const reset = useApp((s) => s.reset);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const erase = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await forgetMe();
      if (res?.ok) {
        // На сервере пусто — копия на устройстве тоже не должна пережить
        // удаление, иначе следующий вход нарисует кошельки из снимка.
        dropSnapshot();
        setDone(true);
        toast(t(lang, "legal_forget_done"));
      } else {
        toast(t(lang, "legal_forget_failed"), "err");
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Frame title={t(lang, "legal_forget_title")}>
        <Card>
          <p className="note">{t(lang, "legal_forget_done")}</p>
          {/* Данных больше нет — оставлять открытым экран, который их
              показывает, незачем: возвращаем на первый таб. */}
          <Action kind="ghost" onClick={reset}>
            {t(lang, "back_button")}
          </Action>
        </Card>
      </Frame>
    );
  }

  return (
    <Frame title={t(lang, "legal_privacy_title")}>
      {/* Заголовок экрана прямо над карточкой говорит то же самое —
          второй раз подряд он лишний. */}
      <Card>
        <p className="note">{t(lang, "legal_privacy_body")}</p>
      </Card>

      <Card>
        <SectionTitle>{bare(t(lang, "legal_terms_title"))}</SectionTitle>
        <p className="note">{t(lang, "legal_terms_body")}</p>
      </Card>

      <Card>
        <SectionTitle>{bare(t(lang, "legal_forget_title"))}</SectionTitle>
        <p className="note dim">{t(lang, "legal_forget_warn")}</p>
        {confirm ? (
          <>
            <Action kind="danger" disabled={busy} onClick={erase}>
              {t(lang, "legal_forget_yes")}
            </Action>
            <Action kind="ghost" disabled={busy} onClick={() => setConfirm(false)}>
              {t(lang, "cancel_button")}
            </Action>
          </>
        ) : (
          <Action kind="danger" onClick={() => setConfirm(true)}>
            {t(lang, "legal_btn_forget")}
          </Action>
        )}
      </Card>
    </Frame>
  );
}
