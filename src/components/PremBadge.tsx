/**
 * Значок Премиума в шапке (вертикальный: корона, под ней дни) — на месте прежней кнопки «обновить»: данные и так
 * приходят сами (раз в три минуты и при возвращении в приложение), а сколько
 * осталось Премиума человек теперь видит сразу. Нажатие — экран Премиума.
 * Премиума нет — «0 дн.», нажатие открывает замок на весь экран («купить /
 * бесплатно в Бонусах»). Осталось три дня и меньше — значок тёплого цвета:
 * пора продлить.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { haptic } from "../lib/telegram";

function Crown() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z" fill="currentColor" />
    </svg>
  );
}

export function PremBadge() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const me = useLive((s) => s.me);
  const status = useLive((s) => s.status);
  if (status === "boot") return null;

  const left = me.plan === "premium" && me.premUntil ? me.premUntil - Date.now() : 0;
  // Дней нет — тот же значок с нулём, а нажатие открывает замок на весь
  // экран: купить или получить дни бесплатно в «Бонусах».
  if (left <= 0) {
    return (
      <button type="button" className="prem-badge zero" onClick={() => { haptic("select"); open("lock"); }}
        aria-label={`${bare(t(lang, "menu_premium"))}: ${t(lang, "pr_days_left")} 0`}>
        <Crown />
        <span className="pb-n">
          <b>0</b>
          <small>{t(lang, "hdr_days")}</small>
        </span>
      </button>
    );
  }
  const go = () => {
    haptic("select");
    goTab("more");
    open("premium", "hdr");
  };
  const days = Math.max(1, Math.ceil(left / 86400000));
  return (
    <button type="button" className={days <= 3 ? "prem-badge soon" : "prem-badge"} onClick={go}
      aria-label={`${bare(t(lang, "menu_premium"))}: ${t(lang, "pr_days_left")} ${days}`}>
      <Crown />
      <span className="pb-n">
        <b>{days}</b>
        <small>{t(lang, "hdr_days")}</small>
      </span>
    </button>
  );
}
