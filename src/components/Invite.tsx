/**
 * Приглашения: пригласил друга — +7 дней премиума обоим. Другу — сразу,
 * пригласившему — когда друг начнёт пользоваться (ref_settle в whale_api.py).
 *
 * Ссылка ведёт прямо в приложение (t.me/<бот>?startapp=ref_<код>). Код
 * случайный, а не номер аккаунта. Делиться — окном Telegram «Поделиться»:
 * человек выбирает чат, а текст и ссылка уже подставлены.
 */
import { useEffect, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { fetchRef, peekRef, type RefInfo } from "../lib/api";
import { copyText } from "../lib/copy";
import { haptic, openTg } from "../lib/telegram";
import { toast } from "./Toast";
import { Action, Card, SectionTitle } from "./ui";

export function useRefInfo(): RefInfo | null {
  const [info, setInfo] = useState<RefInfo | null>(() => peekRef() ?? null);
  useEffect(() => {
    let alive = true;
    void fetchRef().then((r) => alive && r?.ok && setInfo(r));
    return () => {
      alive = false;
    };
  }, []);
  return info?.ok ? info : null;
}

/** Окно Telegram «Поделиться» со ссылкой и текстом. */
export function shareTg(link: string, text: string): void {
  haptic("select");
  openTg(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
}

export function InviteCard() {
  const lang = useApp((s) => s.lang);
  const info = useRefInfo();
  if (!info?.link) return null;
  const link = info.link;
  const bonus = info.bonus ?? 7;
  const copy = async () => {
    haptic("select");
    const ok = await copyText(link);
    toast(t(lang, ok ? "ui_copied" : "ui_copy_failed"), ok ? "ok" : "err");
  };
  return (
    <Card>
      <SectionTitle>{t(lang, "ref_title", { n: bonus })}</SectionTitle>
      <p className="note dim">{t(lang, "ref_body", { n: bonus, a: info.activeDays ?? 3 })}</p>
      {info.invited ? (
        <p className="note">{t(lang, "ref_stats", { n: info.invited, d: info.days ?? 0 })}</p>
      ) : null}
      {info.waiting ? <p className="note dim">{t(lang, "ref_wait", { w: info.waiting })}</p> : null}
      <div className="stack-actions">
        <Action onClick={() => shareTg(link, t(lang, "ref_share_text", { n: bonus }))}>{t(lang, "ref_share")}</Action>
        <Action kind="ghost" onClick={() => void copy()}>{t(lang, "ui_copy")}</Action>
      </div>
    </Card>
  );
}
