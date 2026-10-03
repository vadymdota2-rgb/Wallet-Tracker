/**
 * Приглашение в премиум там, где человек упёрся в границу бесплатного.
 *
 * Не глухой замок, а конкретное «вот что ещё есть»: «ещё 90 трейдеров»,
 * «12 свежих сделок появятся через 15 минут». Нажатие открывает экран
 * премиума поверх текущего — «Назад» возвращает туда же, откуда пришли, —
 * с заголовком про то, за чем человек пришёл.
 */
import type { ReactNode } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import type { PaySrc } from "../lib/upsell";

export function usePremium(): boolean {
  return useLive((s) => s.me.plan === "premium");
}

/** Открыть экран премиума с указанием, откуда пришли. */
export function usePaywall(): (src: PaySrc) => void {
  const open = useApp((s) => s.open);
  return (src) => {
    haptic("select");
    open("premium", src);
  };
}

export function Upsell({ src, text, cta }: { src: PaySrc; text: ReactNode; cta?: ReactNode }) {
  const lang = useApp((s) => s.lang);
  const toPremium = usePaywall();
  return (
    <button type="button" className="upsell" onClick={() => toPremium(src)}>
      <span className="upsell-ic" aria-hidden="true">⭐</span>
      <span className="upsell-txt">
        <span>{text}</span>
        <b>{cta ?? t(lang, "up_cta")}</b>
      </span>
      <span className="upsell-go" aria-hidden="true">›</span>
    </button>
  );
}

/** Бесплатному сделки китов приходят с задержкой. Сказать об этом прямо и
 *  числом: «ещё 12 свежих сделок — сразу с Премиум». Нет задержки в ответе
 *  (премиум или старый сервер) — ничего не рисуем. */
export function DelayNote({ delay, hidden }: { delay?: number; hidden?: number }) {
  const lang = useApp((s) => s.lang);
  if (!delay) return null;
  const m = String(Math.round(delay / 60));
  const text = hidden
    ? t(lang, "up_delay", { n: String(hidden), m })
    : t(lang, "up_delay0", { m });
  return <Upsell src="delay" text={text} />;
}
