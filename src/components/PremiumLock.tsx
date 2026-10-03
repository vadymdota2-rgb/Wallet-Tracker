/**
 * Замок на закрытом подпиской — тот же, что в аналитике.
 *
 * Пустой список там, где данные просто не отдаются бесплатному, читался бы
 * как «открытых позиций нет» или «рейтинг ещё считается» — утверждение, а
 * не замок. Поэтому вместо пустоты прямо сказано, что это за подпиской.
 */
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { PaySrc } from "../lib/upsell";
import { Locked } from "./ui";
import { usePaywall } from "./Upsell";

export { usePremium } from "./Upsell";

export function PremiumLock({ src = "perp" }: { src?: PaySrc }) {
  const lang = useApp((s) => s.lang);
  const toPremium = usePaywall();
  return <Locked text={t(lang, "hl_locked_body")} cta={t(lang, "mw_upgrade")} onCta={() => toPremium(src)} />;
}
