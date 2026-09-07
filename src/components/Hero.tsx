/** Крупное число сверху экрана и подпись под ним. */
import type { ReactNode } from "react";

export function Hero({
  value,
  tone,
  note,
  icon,
}: {
  value: ReactNode;
  tone?: "up" | "dn";
  note?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="hero">
      {icon ? <span className="hero-ico">{icon}</span> : null}
      <div className="hero-main">
        <strong className={tone ? `hero-val ${tone}` : "hero-val"}>{value}</strong>
        {note ? <small className="hero-note">{note}</small> : null}
      </div>
    </div>
  );
}
