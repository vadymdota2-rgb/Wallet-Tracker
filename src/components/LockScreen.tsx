/**
 * Замок на всё приложение: без Премиума вкладки, боковое меню и история
 * алертов закрыты. Вместо них — этот экран:
 * купить Премиум или получить дни бесплатно в «Бонусах» (за друзей и
 * подписки на соцсети — почти два месяца).
 *
 * Открытыми остаются только экраны, через которые Премиум получают, и
 * служебные: LOCK_OPEN_SCREENS. Замок не показывается, пока неизвестно, есть
 * ли Премиум (первая загрузка без снимка) — иначе у подписчика при запуске
 * мелькал бы экран «купить».
 */
import { useEffect } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { trackEvent } from "../lib/api";
import { Action, Card } from "./ui";
import { IntroOffer } from "./Upsell";
import { Frame } from "../screens/Screen";

/** Закрыто ли приложение для этого человека. Сервисному аккаунту — тоже:
 *  он держит базу кошельков, а Премиума у него нет. */
export function useLocked(): boolean {
  const plan = useLive((s) => s.me.plan);
  const status = useLive((s) => s.status);
  if (plan === "premium") return false;
  // «boot» — первая загрузка, о плане ещё ничего не известно.
  return status !== "boot";
}

export function LockScreen() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const service = useLive((s) => s.me.service);

  useEffect(() => {
    if (!service) trackEvent("paywall", "lock");
  }, [service]);

  const go = (fn: () => void) => () => {
    haptic("select");
    fn();
  };

  return (
    <div className="lock">
      {service ? null : <IntroOffer />}
      <Card>
        <div className="lock-body">
          <span className="lock-ic" aria-hidden="true">⭐</span>
          <h2 className="lock-ttl">{t(lang, "lk_title")}</h2>
          {/* Сервисному купить и получить Премиум нечем — только почему. */}
          {service ? (
            <p className="lock-txt">{t(lang, "pr_service_account")}</p>
          ) : (
            <>
              <p className="lock-txt">{t(lang, "lk_body")}</p>
              <div className="stack-actions lock-acts">
                <Action onClick={go(() => open("premium", "lock"))}>⭐ {t(lang, "lk_buy")}</Action>
                <Action kind="ghost" onClick={go(() => open("bonus"))}>🎁 {t(lang, "lk_free")}</Action>
              </div>
              <p className="note dim lock-note">{t(lang, "lk_free_d")}</p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

/** Закрытый экран из стека (график, кошелёк, история алертов…) — тот же
 *  замок, но в рамке экрана: «Назад» возвращает, откуда пришли. */
export function LockSheet() {
  const lang = useApp((s) => s.lang);
  return (
    <Frame title={t(lang, "lk_title")}>
      <LockScreen />
    </Frame>
  );
}
