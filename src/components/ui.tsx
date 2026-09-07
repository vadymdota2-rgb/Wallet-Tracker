/** Мелкие кирпичики интерфейса: строка списка, плитки, кнопка, заголовок. */
import type { ReactNode } from "react";
import { haptic } from "../lib/telegram";

export function SectionTitle({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="sect">
      <h2>{children}</h2>
      {note ? <span className="sect-note">{note}</span> : null}
    </div>
  );
}

/** Ряд чипов с прокруткой: пресеты порога, окна, площадки. */
export function Chips<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: ReactNode }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          className={o.id === value ? "chip on" : "chip"}
          aria-pressed={o.id === value}
          onClick={() => {
            if (o.id === value) return;
            haptic("select");
            onChange(o.id);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Row({
  icon,
  title,
  sub,
  mid,
  value,
  valueSub,
  tone,
  badge,
  onClick,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** Метка между текстом и правым краем — например место в рейтинге. */
  mid?: ReactNode;
  value?: ReactNode;
  valueSub?: ReactNode;
  tone?: "up" | "dn";
  badge?: ReactNode;
  onClick?: () => void;
}) {
  const inner = (
    <>
      {icon ? <span className="row-ico">{icon}</span> : null}
      <span className="row-main">
        <span className="row-title">
          {title}
          {badge ? <em className="row-badge">{badge}</em> : null}
        </span>
        {sub ? <small className="row-sub">{sub}</small> : null}
      </span>
      {mid !== undefined ? <span className="row-mid">{mid}</span> : null}
      {value !== undefined ? (
        <span className="row-val">
          <b className={tone ? `q ${tone}` : "q"}>{value}</b>
          {valueSub ? <small>{valueSub}</small> : null}
        </span>
      ) : null}
    </>
  );
  if (!onClick) return <div className="row">{inner}</div>;
  return (
    <button
      type="button"
      className="row tap"
      onClick={() => {
        haptic("select");
        onClick();
      }}
    >
      {inner}
    </button>
  );
}

export interface Tile {
  label: ReactNode;
  value: ReactNode;
  tone?: "up" | "dn" | "dim";
}

export function Tiles({ items, cols = 2 }: { items: Tile[]; cols?: 2 | 3 | 4 }) {
  if (!items.length) return null;
  return (
    <div className={`tiles c${cols}`}>
      {items.map((it, i) => (
        <div className="tile" key={i}>
          <small>{it.label}</small>
          <b className={it.tone ? it.tone : undefined}>{it.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Action({
  children,
  onClick,
  kind = "primary",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`action ${kind}`}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        haptic("light");
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: ReactNode }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          className={o.id === value ? "on" : undefined}
          onClick={() => {
            if (o.id === value) return;
            haptic("select");
            onChange(o.id);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ text, hint }: { text: ReactNode; hint?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-mark" aria-hidden="true" />
      <p>{text}</p>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function Locked({ text, cta, onCta }: { text: ReactNode; cta: ReactNode; onCta: () => void }) {
  return (
    <div className="locked">
      <span aria-hidden="true">🔒</span>
      <p>{text}</p>
      <Action onClick={onCta}>{cta}</Action>
    </div>
  );
}

export function Card({ children, pad = true }: { children: ReactNode; pad?: boolean }) {
  return <section className={pad ? "card" : "card flush"}>{children}</section>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}
