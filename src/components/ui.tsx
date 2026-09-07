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
  sub2,
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
  /** Вторая строка пояснения: то, что не влезает в первую и обрезается. */
  sub2?: ReactNode;
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
          <span className="row-name">{title}</span>
          {badge ? <em className="row-badge">{badge}</em> : null}
        </span>
        {sub ? <small className="row-sub">{sub}</small> : null}
        {sub2 ? <small className="row-sub">{sub2}</small> : null}
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

/**
 * Значок площадки: BNB для спота на BSC, HYPE для фьючерсов Hyperliquid.
 * Файлы едут вместе с образом, наружу запросов нет.
 */
export function VenueMark({ venue, size = 15 }: { venue: "spot" | "perp"; size?: number }) {
  return (
    <img
      className="venue"
      src={`/coins/hl/${venue === "spot" ? "BNB" : "HYPE"}.svg`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      aria-hidden="true"
    />
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

/**
 * Полный адрес кошелька с кнопкой «копировать». Сокращённый вид годится для
 * списка, но чтобы открыть кошелёк в обозревателе, нужны все 42 символа.
 *
 * `navigator.clipboard` в Telegram доступен не всегда, поэтому при отказе
 * пробуем старый способ через скрытое поле и говорим правду, если не вышло.
 */
export function AddrBar({
  addr,
  label,
  copy,
  onDone,
}: {
  addr: string;
  label: ReactNode;
  copy: string;
  onDone: (ok: boolean) => void;
}) {
  const put = async () => {
    haptic("light");
    try {
      await navigator.clipboard.writeText(addr);
      onDone(true);
      return;
    } catch {
      // Ниже — запасной путь.
    }
    try {
      const el = document.createElement("textarea");
      el.value = addr;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      onDone(ok);
    } catch {
      onDone(false);
    }
  };

  return (
    <div className="addr">
      <div className="addr-main">
        <small>{label}</small>
        <code>{addr}</code>
      </div>
      <button type="button" className="addr-copy" onClick={() => void put()} aria-label={copy}>
        ⧉ {copy}
      </button>
    </div>
  );
}

/**
 * Значок «Мои кошельки» в нижнем меню. Рисуем сам, а не эмодзи: 💼 у каждой
 * системы своё — на одном телефоне коричневый портфель, на другом синий, —
 * и в один ряд с остальными вкладками он не встаёт.
 *
 * Всё в currentColor, так что значок сам гаснет и загорается вместе с
 * подписью вкладки, без отдельных состояний.
 */
export function WalletGlyph({ size = 21 }: { size?: number }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Ремешок: отогнутый край, из-за него кошелёк не читается коробкой. */}
      <path d="M6.2 7V5.5a1.6 1.6 0 0 1 2-1.55l8.1 2.15" opacity="0.75" />
      <path d="M3 9.5A2.5 2.5 0 0 1 5.5 7h13A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />
      {/* Кармашек застёжки с монетой — он и отличает кошелёк от сумки. */}
      <path d="M21 11.3h-3.1a2.2 2.2 0 0 0 0 4.4H21" fill="currentColor" fillOpacity="0.16" />
      <circle cx="17.9" cy="13.5" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  );
}
