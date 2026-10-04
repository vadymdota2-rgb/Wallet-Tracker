/**
 * Кнопка-приглашение в Премиум и карточки вокруг пробного срока: сколько
 * осталось пробы и вводная цена после неё. Нажатие открывает экран Премиума
 * поверх текущего — «Назад» возвращает туда же — с заголовком про то, с чем
 * человек пришёл.
 */
import type { ReactNode } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { num } from "../lib/format";
import { Card, SectionTitle } from "./ui";
import type { PaySrc } from "../lib/upsell";

/** Открыть экран премиума с указанием, откуда пришли. */
function usePaywall(): (src: PaySrc) => void {
  const open = useApp((s) => s.open);
  return (src) => {
    haptic("select");
    open("premium", src);
  };
}

function Upsell({ src, text, cta }: { src: PaySrc; text: ReactNode; cta?: ReactNode }) {
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

/** Пробный премиум: сколько осталось и что будет после — заранее. В
 *  кошельках — всю неделю; на дайджесте, с которого открывается приложение,
 *  — в последние `within` дней: раньше это только мешало бы читать. */
export function TrialCard({ within }: { within?: number }) {
  const lang = useApp((s) => s.lang);
  const me = useLive((s) => s.me);
  if (!me.trial || !me.premUntil || me.plan !== "premium") return null;
  const days = Math.max(1, Math.ceil((me.premUntil - Date.now()) / 86400000));
  if (within && days > within) return null;
  return (
    <Card>
      <SectionTitle>{t(lang, "tr_left", { n: days })}</SectionTitle>
      <Upsell src="trial" text={t(lang, "tr_after")} cta={t(lang, "tr_cta")} />
    </Card>
  );
}
