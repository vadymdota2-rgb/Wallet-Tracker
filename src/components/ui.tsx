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
 * Не кошелёк, а стопка карт: одна впереди с чипом, две уходят назад. Смысл
 * вкладки — что кошельков несколько, а один кошелёк этого не показывает.
 * Две линии сзади дают глубину двумя штрихами: веер из повёрнутых карт на
 * двадцати одном пикселе слипается в пятно, проверено.
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
      <rect x="2.6" y="8.4" width="18.8" height="12.2" rx="2.8" />
      <path d="M5.4 5.85h13.2" opacity="0.55" />
      <path d="M7.6 3.3h8.8" opacity="0.3" />
      <rect x="5.9" y="12.4" width="4.6" height="3.3" rx="1.1"
            fill="currentColor" stroke="none" opacity="0.92" />
    </svg>
  );
}

/**
 * Глаз — сколько открытых позиций у кошелька. Своя отрисовка вместо 👁:
 * системная эмодзи то плоская чёрточка, то цветной глаз с ресницами, и с
 * цифрой рядом она не выравнивается.
 */
export function EyeGlyph({ size = 23 }: { size?: number }) {
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
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Порог алертов — монета с долларом. Мешок денег 💰 заменён на неё, а не на
 * колокол: слово «алертов» в подписи уже есть, значку остаётся сказать
 * «сумма». Монету с чертой снизу пробовал — на семнадцати пикселях черта
 * сливается с монетой в кляксу.
 */
export function ThresholdGlyph({ size = 25 }: { size?: number }) {
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
      <circle cx="12" cy="12" r="8.6" />
      <path d="M14.4 9.1c-.5-.9-1.4-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2.1c1.7.4 2.9.9 2.9 2.2s-1.2 2.2-2.9 2.2c-1.3 0-2.3-.5-2.8-1.5" />
      <path d="M12 6.2v11.6" opacity="0.75" />
    </svg>
  );
}

/** Плюс в круге — «добавить». Круг роднит его с монетой порога и глазом. */
export function PlusGlyph({ size = 19 }: { size?: number }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 8.2v7.6M8.2 12h7.6" />
    </svg>
  );
}
