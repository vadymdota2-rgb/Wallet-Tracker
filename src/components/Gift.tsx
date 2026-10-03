/**
 * Подарок при первом открытии: неделя премиума.
 *
 * Отдельным окном, а не всплывашкой: всплывашка гаснет за пару секунд, а
 * человек в первый раз смотрит на приложение и мог её не заметить — потом
 * премиум «откуда-то взялся» и так же молча кончился бы. Окно одно на всю
 * жизнь аккаунта: сервер присылает подарок ровно в том ответе, где его выдал.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { Action } from "./ui";

export function Gift() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const days = useLive((s) => s.gift);
  const drop = useLive((s) => s.dropGift);
  if (!days) return null;

  const close = () => {
    haptic("success");
    drop();
  };

  return (
    <div className="gift-wrap" role="dialog" aria-modal="true" aria-labelledby="gift-ttl">
      <div className="gift">
        <span className="gift-ic" aria-hidden="true">🎁</span>
        <h2 id="gift-ttl">{t(lang, "gift_title", { n: String(days) })}</h2>
        <p>{t(lang, "gift_body")}</p>
        <div className="stack-actions">
          <Action onClick={close}>{t(lang, "gift_ok")}</Action>
          <Action
            kind="ghost"
            onClick={() => {
              drop();
              goTab("more");
              open("premium", "gift");
            }}
          >
            {t(lang, "gift_more")}
          </Action>
        </div>
      </div>
    </div>
  );
}
