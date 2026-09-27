/** Общая рамка экрана в стеке: заголовок, кнопка назад, содержимое. */
import type { ReactNode } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";

export interface ScreenProps {
  arg?: string;
  arg2?: string;
}

export function Frame({
  title,
  sub,
  children,
  actions,
  full = false,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** Содержимое во всю оставшуюся высоту, без отступов — для графика. */
  full?: boolean;
}) {
  const lang = useApp((s) => s.lang);
  const back = useApp((s) => s.back);
  return (
    <div className={full ? "screen full" : "screen"}>
      <div className="screen-hd">
        <button
          type="button"
          className="back"
          onClick={() => {
            haptic("light");
            back();
          }}
        >
          {t(lang, "back_button")}
        </button>
        <div className="screen-ttl">
          <h1>{title}</h1>
          {sub ? <small>{sub}</small> : null}
        </div>
        {actions ? <div className="screen-act">{actions}</div> : null}
      </div>
      <div className="screen-body">{children}</div>
    </div>
  );
}
