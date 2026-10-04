/**
 * Токен проекта — пока готовится.
 *
 * Здесь нет ни цены, ни продажи, ни обещаний: только что токен будет, что
 * именно мы опубликуем перед запуском, и кнопка «сообщить о запуске». Список
 * подписавшихся — в базе бота (token_subs); когда всё будет готово, владелец
 * рассылает уведомление командой /tokencast, а подробности появятся на этом
 * же экране.
 *
 * Отдельный блок — безопасность. Слово «токен» в приложении — приманка для
 * поддельных «пресейлов» и «аирдропов», и защитить людей проще всего заранее:
 * сказать, где будет единственный официальный адрес контракта и чего мы не
 * попросим никогда. Внизу — оговорка, что это не предложение и не обещание
 * дохода.
 */
import { useEffect, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { fetchTokenState, setTokenNotify } from "../lib/api";
import { toast } from "../components/Toast";
import { Action, Card, Row, SectionTitle } from "../components/ui";

type Key = Parameters<typeof t>[1];

/** Что придёт в уведомлении перед запуском — по пунктам. */
const WHAT: [string, Key, Key][] = [
  ["📊", "tk_w1_t", "tk_w1_d"],
  ["📜", "tk_w2_t", "tk_w2_d"],
  ["🔐", "tk_w3_t", "tk_w3_d"],
  ["🎯", "tk_w4_t", "tk_w4_d"],
  ["🗓", "tk_w5_t", "tk_w5_d"],
];

const SAFE: Key[] = ["tk_safe_1", "tk_safe_2", "tk_safe_3"];

export function TokenScreen() {
  const lang = useApp((s) => s.lang);
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchTokenState().then((r) => {
      if (alive) setOn(r?.ok ? Boolean(r.on) : false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    if (busy) return;
    haptic("select");
    setBusy(true);
    const was = on;
    setOn(next);
    const r = await setTokenNotify(next);
    setBusy(false);
    if (!r?.ok) {
      setOn(was);
      toast(t(lang, "generic_error_retry"), "err");
      return;
    }
    if (next) haptic("success");
    toast(t(lang, next ? "tk_notify_ok" : "tk_notify_bye"));
  };

  return (
    <Frame title={t(lang, "tk_title")} sub={t(lang, "tk_status")}>
      <Card>
        <div className="tk-hero">
          <span className="tk-coin" aria-hidden="true">🪙</span>
          <div>
            <span className="tk-chip">{t(lang, "tk_status")}</span>
            <h2 className="tk-name">{t(lang, "tk_name")}</h2>
          </div>
        </div>
        <p className="tk-lead">{t(lang, "tk_intro")}</p>
      </Card>

      <Card>
        <SectionTitle>{t(lang, "tk_what_title")}</SectionTitle>
        {WHAT.map(([ic, title, text]) => (
          <Row
            key={title}
            wrap
            icon={<span aria-hidden="true">{ic}</span>}
            title={t(lang, title)}
            sub={t(lang, text)}
          />
        ))}
      </Card>

      <Card>
        <SectionTitle>{t(lang, "tk_notify_title")}</SectionTitle>
        <p className="note">{t(lang, "tk_notify_d")}</p>
        {on ? (
          <div className="tk-on">
            <span>✓ {t(lang, "tk_notify_on")}</span>
            <button type="button" className="tk-off" disabled={busy} onClick={() => void toggle(false)}>
              {t(lang, "tk_notify_off_btn")}
            </button>
          </div>
        ) : (
          <div className="stack-actions">
            <Action onClick={() => void toggle(true)} disabled={busy || on === null}>
              🔔 {t(lang, "tk_notify_btn")}
            </Action>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>⚠️ {t(lang, "tk_safe_title")}</SectionTitle>
        <ul className="tk-safe">
          {SAFE.map((k) => (
            <li key={k}>{t(lang, k)}</li>
          ))}
        </ul>
      </Card>

      <p className="tk-disc">{t(lang, "tk_disclaimer")}</p>
    </Frame>
  );
}
