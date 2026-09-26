/**
 * Замок на закрытом подпиской — тот же, что в аналитике.
 *
 * Пустой список там, где данные просто не отдаются бесплатному, читался бы
 * как «открытых позиций нет» или «рейтинг ещё считается» — утверждение, а
 * не замок. Поэтому вместо пустоты прямо сказано, что это за подпиской.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { Locked } from "./ui";

export function usePremium(): boolean {
  return useLive((s) => s.me.plan === "premium");
}

/** `fromTab` — замок стоит на вкладке: экран премиума живёт в «Ещё», туда и
    переходим, чтобы «Назад» вёл туда же, куда из аналитики. */
export function PremiumLock({ fromTab = false }: { fromTab?: boolean }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  return (
    <Locked
      text={t(lang, "hl_locked_body")}
      cta={t(lang, "mw_upgrade")}
      onCta={() => {
        haptic("select");
        if (fromTab) goTab("more");
        open("premium");
      }}
    />
  );
}
