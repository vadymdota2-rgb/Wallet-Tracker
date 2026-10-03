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
import { num } from "../lib/format";
import { Card, SectionTitle } from "./ui";
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

/** Вводная цена после пробной недели — на виду, пока действует. Письмо
 *  бота человек может пропустить; без этой карточки скидка жила бы только
 *  на экране оплаты, куда ещё надо дойти. Часы — обратным отсчётом: цена
 *  настоящая и правда кончается (intro_until в whale_api.py). */
export function IntroOffer() {
  const lang = useApp((s) => s.lang);
  const plan = useLive((s) => s.me.plan);
  const pay = useLive((s) => s.pay);
  const intro = pay.intro;
  if (!intro || plan === "premium" || intro.until * 1000 <= Date.now()) return null;
  const full = pay.plans?.m?.stars ?? pay.stars;
  const h = Math.max(1, Math.ceil((intro.until * 1000 - Date.now()) / 3600000));
  return (
    <Card>
      <SectionTitle>{t(lang, "in_title", { a: num(intro.stars), b: num(full) })}</SectionTitle>
      <Upsell src="intro" text={t(lang, "in_body", { h })} cta={t(lang, "in_cta")} />
    </Card>
  );
}
