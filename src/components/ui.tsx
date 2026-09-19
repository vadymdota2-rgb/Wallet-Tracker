/** Мелкие кирпичики интерфейса: строка списка, плитки, кнопка, заголовок. */
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { haptic } from "../lib/telegram";
import { copyText } from "../lib/copy";
import brainIcon from "../assets/brain-icon.png";

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
  after,
  tone,
  badge,
  action,
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
  /** Самый край строки, за числами — например глазок «сюда можно нажать». */
  after?: ReactNode;
  /** Своя кнопка у края строки. Кнопку нельзя вложить в кнопку, поэтому со
   *  своим действием строка перестаёт быть кнопкой целиком: нажимаемой
   *  становится её основная часть, а действие встаёт рядом. */
  action?: ReactNode;
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
      {after !== undefined ? <span className="row-after">{after}</span> : null}
    </>
  );
  if (!onClick) {
    return <div className="row">{inner}{action ? <span className="row-act">{action}</span> : null}</div>;
  }
  if (action) {
    return (
      <div className="row">
        <button
          type="button"
          className="row-hit"
          onClick={() => {
            haptic("select");
            onClick();
          }}
        >
          {inner}
        </button>
        <span className="row-act">{action}</span>
      </div>
    );
  }
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

export function Tiles({
  items,
  cols = 2,
  size,
}: {
  items: Tile[];
  cols?: 2 | 3 | 4;
  /** «sm» — мельче и плотнее: в карточке рейтинга плиток шесть, и обычные
      съедали бы полтора экрана на каждого трейдера. */
  size?: "sm";
}) {
  if (!items.length) return null;
  return (
    <div className={`tiles c${cols}${size === "sm" ? " sm" : ""}`}>
      {items.map((it, i) => (
        <div className="tile" key={i}>
          <small>{it.label}</small>
          <b className={it.tone ? it.tone : undefined}>{it.value}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * Шкала: одно значение против предела.
 *
 * Не круговой индикатор и не пирог из двух долей — обычная полоса с
 * подписанной отметкой. Отметка здесь главное: «вероятность 61%» само по себе
 * ничего не значит, значит только расстояние от 50%, где монетка. То же с
 * AUC: 0.61 читается, только когда видно, где 0.5.
 */
export function Meter({
  value,
  from = 0,
  to = 1,
  mark,
  markLabel,
  tone = "up",
  label,
  note,
}: {
  value: number;
  from?: number;
  to?: number;
  /** Отметка «ничего не значит»: монетка, порог приёмки, нужный минимум. */
  mark?: number;
  markLabel?: string;
  tone?: "up" | "dn" | "flat";
  label?: ReactNode;
  note?: ReactNode;
}) {
  const span = to - from || 1;
  const at = Math.max(0, Math.min(1, (value - from) / span));
  const markAt = mark === undefined ? null : Math.max(0, Math.min(1, (mark - from) / span));
  return (
    <div className="meter">
      {label || note ? (
        <div className="meter-hd">
          <span>{label}</span>
          <span className="meter-note">{note}</span>
        </div>
      ) : null}
      <div className="meter-track">
        <i className={`meter-fill ${tone}`} style={{ width: `${at * 100}%` }} />
        {markAt === null ? null : (
          <i className="meter-mark" style={{ left: `${markAt * 100}%` }} aria-hidden="true" />
        )}
      </div>
      {markLabel && markAt !== null ? (
        <div className="meter-scale">
          <span style={{ left: `${markAt * 100}%` }}>{markLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

export interface BarItem {
  name: string;
  /** −1…1 для расходящихся полос, 0…1 для обычных. */
  value: number;
  label: string;
}

/**
 * Полосы в обе стороны от нуля: довод за сигнал вправо, против — влево.
 *
 * Цвет здесь не единственный признак: сторона и знак в подписи говорят то же
 * самое. Зелёный с красным различимы не для всех глаз, и полагаться на один
 * цвет нельзя.
 */
export function Diverging({ items }: { items: BarItem[] }) {
  if (!items.length) return null;
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1e-6);
  return (
    <div className="bars diverge">
      {items.map((it) => {
        const w = (Math.abs(it.value) / max) * 50;
        const up = it.value >= 0;
        return (
          <div className="bar-row" key={it.name}>
            <span className="bar-name">{it.name}</span>
            <span className="bar-plot">
              <i className="bar-zero" aria-hidden="true" />
              <i
                className={`bar-fill ${up ? "up" : "dn"}`}
                style={up ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
              />
            </span>
            <span className={`bar-val ${up ? "up" : "dn"}`}>{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Полосы одной величины: один цвет на все, длина и есть значение. */
export function Bars({ items }: { items: BarItem[] }) {
  if (!items.length) return null;
  const max = Math.max(...items.map((i) => i.value), 1e-6);
  return (
    <div className="bars">
      {items.map((it) => (
        <div className="bar-row" key={it.name}>
          <span className="bar-name">{it.name}</span>
          <span className="bar-plot">
            <i className="bar-fill" style={{ left: 0, width: `${(it.value / max) * 100}%` }} />
          </span>
          <span className="bar-val">{it.label}</span>
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
/**
 * Выбор раздела плитками, а не лентой.
 *
 * Полоса переключателей годится, пока вариантов три-четыре: дальше они не
 * помещаются в строку, и последние приходится доставать прокруткой, о
 * которой ничто не сообщает — подпись просто обрывается на краю. Плитки
 * показывают все варианты сразу и оставляют место значку, по которому глаз
 * находит нужный раздел быстрее, чем по тексту.
 */
export function TileNav<T extends string>({
  value,
  options,
  onChange,
  cols = 3,
  label,
}: {
  value: T;
  /** venue — значок площадки уголком: знак говорит «что», значок «где». */
  options: { id: T; ic: ReactNode; venue?: "spot" | "perp"; label: ReactNode }[];
  onChange: (id: T) => void;
  cols?: number;
  label?: string;
}) {
  return (
    <nav
      className="views"
      role="tablist"
      aria-label={label}
      style={{ "--cols": cols } as CSSProperties}
    >
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
          {/* Уголок в своей обёртке: правило раскладки должно цеплять
              именно его. Пока оно ловило любой значок площадки, логотип в
              середине плитки — там, где он главный, — тоже уезжал в угол и
              сжимался до тринадцати пикселей. */}
          {o.venue ? (
            <span className="v-tag" aria-hidden="true">
              <VenueMark venue={o.venue} size={13} />
            </span>
          ) : null}
          <span className="v-ic" aria-hidden="true">{o.ic}</span>
          <span>{o.label}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * Лента площадок: выбранная в середине и крупнее, соседние по краям мельче.
 *
 * Плитками это работало, пока бирж было восемь: дальше сетка занимала
 * пол-экрана, и список строк, ради которого раздел и открывают, уезжал вниз.
 * Лента держит высоту одного ряда при любом числе площадок, а разница в
 * размере сразу говорит, какая выбрана и что соседние доступны сдвигом.
 *
 * Лента кольцевая: список повторён несколько раз, и когда прокрутка уходит
 * из средней копии, положение молча переносится в неё же — карточки в копиях
 * одинаковые, поэтому перенос не виден, а край, в который лента упиралась,
 * исчезает. Крутить можно в обе стороны сколько угодно.
 *
 * Выбор идёт за прокруткой: докрутил — выбрал. Приходит он не на каждый
 * пиксель, а когда лента остановилась: иначе, пока палец ведёт от Binance к
 * Bybit, приложение успело бы сходить за двумя лишними досками.
 */
export function VenueReel<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; ic: ReactNode; label: ReactNode }[];
  onChange: (id: T) => void;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Прокрутка сама выбрала площадку — подводить ленту к ней не надо: она уже
     там, и повторный доводчик дёргал бы её под пальцем. */
  const scrolled = useRef(false);
  const first = useRef(true);
  const n = options.length;
  const at = Math.max(0, options.findIndex((o) => o.id === value));
  /* Подсвечена одна карточка, а не все копии выбранной площадки: на коротком
     списке две копии попадают на экран разом, и синей горела бы ещё и та,
     что стоит с краю. Держим ту, что сейчас в середине. */
  const [live, setLive] = useState(-1);

  /* Копий тем больше, чем короче список: одного сильного маха должно не
     хватать, чтобы долететь до края ленты, — там перенос ещё не случился. */
  const reps = n < 2 ? 1 : n >= 8 ? 3 : n >= 4 ? 5 : 9;
  const mid = Math.floor(reps / 2) * n;
  const cards = Array.from({ length: reps * n }, (_, i) => i);

  /* Считаем по видимым прямоугольникам, а не по scrollLeft с offsetLeft: в
     арабской раскладке лента идёт справа налево, начало прокрутки там ноль, а
     дальше уходит в минус — арифметика по числам ползла, и лента выбирала не
     ту площадку. Сдвиг относительно середины одинаков в обе стороны. */
  const shift = (i: number) => {
    const el = box.current;
    const card = el?.children[i] as HTMLElement | undefined;
    if (!el || !card) return 0;
    const own = card.getBoundingClientRect();
    const all = el.getBoundingClientRect();
    return own.left + own.width / 2 - (all.left + all.width / 2);
  };

  const move = (by: number, smooth: boolean) => {
    if (!box.current || Math.abs(by) < 1) return;
    box.current.scrollBy({ left: by, behavior: smooth ? "smooth" : "auto" });
  };

  /* Ближайшая копия нужной площадки, а не та, что в средней копии: щелчок по
     соседней карточке должен сдвигать ленту на шаг, а не прокручивать её
     через весь список к другому её экземпляру. */
  const nearest = (want: number) => {
    let best = mid + want;
    let near = Infinity;
    for (let r = 0; r < reps; r++) {
      const i = r * n + want;
      const d = Math.abs(shift(i));
      if (d < near) {
        near = d;
        best = i;
      }
    }
    return best;
  };

  useEffect(() => {
    if (scrolled.current) {
      scrolled.current = false;
      return;
    }
    if (!n) return;
    // Ширины плиток известны только после первой отрисовки: на холодном
    // запуске центрировать раньше нечего.
    const to = first.current ? mid + at : nearest(at);
    move(shift(to), !first.current);
    setLive(to);
    first.current = false;
  }, [at, n, reps]);

  const settle = () => {
    const el = box.current;
    if (!el || !n) return;
    let best = 0;
    let near = Infinity;
    cards.forEach((_, i) => {
      const d = Math.abs(shift(i));
      if (d < near) {
        near = d;
        best = i;
      }
    });
    const pick = options[best % n];
    if (pick && pick.id !== value) {
      scrolled.current = true;
      haptic("select");
      onChange(pick.id);
    }
    /* Вышли из средней копии — молча возвращаемся в неё. Карточка под тем же
       номером выглядит точно так же, поэтому подмены не видно, а запас хода в
       обе стороны снова полный. */
    if (reps > 1 && (best < mid || best >= mid + n)) {
      move(shift(mid + (best % n)), false);
      setLive(mid + (best % n));
      return;
    }
    setLive(best);
  };

  return (
    <nav
      className="reel"
      role="tablist"
      aria-label={label}
      ref={box}
      onScroll={() => {
        if (idle.current) clearTimeout(idle.current);
        idle.current = setTimeout(settle, 120);
      }}
    >
      {cards.map((i) => {
        const o = options[i % n]!;
        /* Читалке экрана показываем один список, а не все копии: кнопки в
           них те же самые, и объявлять площадку по три раза незачем. */
        const copy = i < mid || i >= mid + n;
        return (
          <button
            key={i}
            type="button"
            role={copy ? undefined : "tab"}
            aria-hidden={copy || undefined}
            tabIndex={copy ? -1 : undefined}
            aria-selected={copy ? undefined : o.id === value}
            className={i === live || (live < 0 && o.id === value && !copy) ? "on" : undefined}
            onClick={() => {
              move(shift(i), true);
              setLive(i);
              if (o.id === value) return;
              scrolled.current = true;
              haptic("select");
              onChange(o.id);
            }}
          >
            <span className="v-ic" aria-hidden="true">{o.ic}</span>
            <span>{o.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Значок «Аналитика» в нижнем меню. Две свечи — самая короткая запись того,
 * что в разделе лежит: цена, объём и что с ними стало.
 *
 * Не столбики с линией тренда: линия со стрелкой уже занята знаком NetFlow,
 * а два значка со стрелкой вверх в одном приложении читаются как одно и то
 * же. Не столбики в рамке: скруглённый прямоугольник в нижнем меню уже есть
 * — это «Мои кошельки», — и рядом они слипаются в одну форму.
 */
/**
 * Значок Cortex — тот же мозг, что наверху вкладки, только маленький.
 *
 * Не нарисованный заново, а вырезанный из самой картинки: границы взяты с её
 * карты яркости, фон снят прозрачностью по светлоте — у картинки он почти
 * чёрный, у мозга светящиеся жилки. Иначе в доке рядом с линейными значками
 * висел бы чёрный квадрат.
 *
 * Он чуть крупнее соседей: у тех контур в полторы точки, здесь тонкие жилки,
 * и на двадцати одной точке они бледнеют до тени.
 */
export function CortexGlyph({ size = 26 }: { size?: number }) {
  return (
    <img
      className="glyph glyph-brain"
      src={brainIcon}
      alt=""
      width={size}
      height={size}
      aria-hidden="true"
    />
  );
}

export function AnalyticsGlyph({ size = 21 }: { size?: number }) {
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
      <path d="M7.4 3.6v3.1M7.4 16.3v3.9M16.6 4.4v4.4M16.6 17.6v2.6" />
      <rect x="4.7" y="6.7" width="5.4" height="9.6" rx="1.5" />
      <rect x="13.9" y="8.8" width="5.4" height="8.8" rx="1.5" />
    </svg>
  );
}

/**
 * Значок «Топ трейдеров» — медаль на ленте.
 *
 * Круг с лентами — единственная не прямоугольная форма в нижнем меню, и на
 * двадцати одном пикселе она узнаётся раньше всех соседей. Пьедестал точнее
 * по смыслу, но три его ступеньки со звездой на этом размере сливаются в
 * пятно; кубок — тот же 🏆, только нарисованный, ради чего менять не стоило.
 */
export function TopGlyph({ size = 21 }: { size?: number }) {
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
      <path d="M7.4 2.6 10.4 8M16.6 2.6 13.6 8" />
      <circle cx="12" cy="14.6" r="6.6" />
      <path
        d="m12 10.6 1.24 2.5 2.76.4-2 1.95.47 2.75L12 16.9l-2.47 1.3.47-2.75-2-1.95 2.76-.4z"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/**
 * Знак «Крупные ордера» — разовые сделки на BSC.
 *
 * Два столбика разной высоты: крупная покупка и продажа поменьше. Раздел про
 * отдельные сделки, а не про накопленный итог, поэтому здесь столбики, а не
 * линия, как у NetFlow, — эти два раздела стоят рядом и различаться должны с
 * одного взгляда.
 */
export function OrdersGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" width={size} height={size} fill="none"
         aria-hidden="true">
      <path d="M2.4 20.4h19.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            opacity="0.5" />
      <rect x="4.6" y="4.2" width="6.2" height="14.6" rx="2.2" fill="var(--up)" />
      <rect x="13.2" y="10.6" width="6.2" height="8.2" rx="2.2" fill="var(--dn)" />
    </svg>
  );
}

/**
 * Знак «Крупные позиции» — доска открытых позиций Hyperliquid.
 *
 * Стопка: сверху самая крупная позиция, под ней те, что помельче. Ровно то,
 * что в разделе и лежит — список по убыванию размера.
 *
 * Лежачие полосы, а не стоячие столбики: столбики стоят на соседней плитке
 * «Крупные ордера», и рядом два таких знака не различить. Проверял их бок о
 * бок на двадцати двух пикселях — сливались.
 */
export function StackGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" width={size} height={size} fill="none"
         aria-hidden="true">
      <rect x="2.6" y="3.6" width="18.8" height="7.6" rx="2.4" fill="var(--up)" />
      <rect x="5.4" y="13.2" width="13.2" height="3.6" rx="1.6" fill="var(--dn)" opacity="0.85" />
      <rect x="8.2" y="18.2" width="7.6" height="2.8" rx="1.3" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

/**
 * Знак «Крупные позиции» — открытые позиции на Hyperliquid.
 *
 * Стрелка вверх и стрелка вниз: лонг и шорт. Рядом со столбиками ордеров
 * стрелки не спутать, а по отдельности каждая говорит своё направление.
 *
 * Горизонтальные встречные стрелки не годятся: так рисуют перевод, и ровно
 * такая пара стоит на соседней плитке «Ротация».
 */
export function PositionsGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" width={size} height={size} fill="none"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.6 20.4V5.2" stroke="var(--up)" strokeWidth="3" />
      <path d="M4 8.6 7.6 4.6l3.6 4" stroke="var(--up)" strokeWidth="3" />
      <path d="M16.4 3.6v12.2" stroke="var(--dn)" strokeWidth="3" />
      <path d="M12.8 12.4l3.6 4 3.6-4" stroke="var(--dn)" strokeWidth="3" />
    </svg>
  );
}

/**
 * Знак NetFlow.
 *
 * Не значок «поток» вообще, а картинка самого раздела: линия накопленного
 * потока переходит через ось нуля — снизу красным, сверху зелёным, — и
 * заканчивается стрелкой. То же самое человек видит внутри, в тренде рынка,
 * поэтому знак и раздел узнаются друг по другу.
 *
 * Пары встречных стрелок (↑↓) и кольца из стрелок сознательно нет: первая
 * означает перевод, второе — ротацию, и оба уже заняты соседними плитками.
 *
 * Ось рисуется currentColor, а не своим цветом: на выбранной плитке фон
 * синий, и постоянный серо-синий на нём пропадал. Кривая цвета не меняет —
 * красное и зелёное здесь значат то же, что во всём приложении.
 */
export function NetFlowGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="glyph nf-mark"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.6 12.5h20.8" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <path d="M2.2 20C5.6 20 6 12.5 9.4 12.5" stroke="var(--dn)" strokeWidth="2.8" />
      <path d="M9.4 12.5c4 0 3.4-7 9.6-8.4" stroke="var(--up)" strokeWidth="2.8" />
      <path d="M14.4 3.1h5.2v5.2" stroke="var(--up)" strokeWidth="2.8" />
    </svg>
  );
}

/**
 * Знак «Ротация» — деньги переложили из одной монеты в другую.
 *
 * Две монеты и дуга между ними: левая пустая — из неё вышли, правая залитая
 * — в неё зашли. Кольцо из двух стрелок, которым ротацию обычно рисуют,
 * здесь читалось бы как «обновить»: ровно такой значок стоит в шапке справа
 * и означает совсем другое.
 *
 * Дуга поверху, а не прямая стрелка между монетами: на двадцати двух
 * пикселях прямая упиралась бы в кружки и сливалась с ними, а поднятая дуга
 * видна целиком и сразу говорит про перенос.
 */
export function RotationGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" width={size} height={size} fill="none"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.4 13.4C5.4 5.6 18.6 5.6 18.6 13" stroke="currentColor" strokeWidth="2"
            opacity="0.75" />
      <path d="M16.2 10.6 18.6 13.4 21 10.6" stroke="currentColor" strokeWidth="2"
            opacity="0.75" />
      <circle cx="5.4" cy="17" r="3.2" stroke="var(--dn)" strokeWidth="2.3" />
      <circle cx="18.6" cy="17" r="4" fill="var(--up)" />
    </svg>
  );
}

/**
 * Знак «Фандинг» — перекошенные весы.
 *
 * Фандинг это плата одной стороны другой, и весь смысл раздела в том, на
 * какую сторону перекос: коромысло наклонено, тяжёлая чаша внизу зелёная,
 * лёгкая вверху красная. Ровные весы (⚖️, что стояли раньше) говорят прямо
 * противоположное — «поровну», то есть ровно то, чего в этом разделе не
 * ищут.
 */
export function FundingGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" width={size} height={size} fill="none"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 13.6 8.6 20.5h6.8z" fill="currentColor" opacity="0.45" />
      <path d="M7 11.6 17.4 15.8" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="4.7" cy="10.7" r="2.5" stroke="var(--dn)" strokeWidth="2.2" />
      <circle cx="19.4" cy="16.5" r="3.2" fill="var(--up)" />
    </svg>
  );
}

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

/**
 * Карточка. ref нужен экранам, которые открываются сразу на нужном разделе:
 * прокрутить к карточке можно только зная, где она оказалась после вёрстки.
 * В React 19 ref — обычное свойство, forwardRef не нужен.
 */
export function Card({
  children,
  pad = true,
  lit = false,
  ref,
}: {
  children: ReactNode;
  pad?: boolean;
  /** Подсветить при появлении — «вы приехали сюда». Гаснет сама. */
  lit?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <section ref={ref} className={`card${pad ? "" : " flush"}${lit ? " lit" : ""}`}>
      {children}
    </section>
  );
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
    onDone(await copyText(addr));
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
/** История сделок: строки списка с точками-маркерами. */
export function DealsGlyph({ size = 19 }: { size?: number }) {
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
      <path d="M5 7h1M5 12h1M5 17h1" />
      <path d="M9.5 7H19M9.5 12h6.5M9.5 17h8" />
    </svg>
  );
}

/** Пара к PlusGlyph: тот же кружок и та же линия, только без вертикали. */
/** Две страницы одна за другой — знак «скопировать». */
export function CopyGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
         aria-hidden="true">
      <rect x="8.6" y="8.6" width="12" height="12" rx="3" />
      <path d="M15.4 4.4H6.4a2.6 2.6 0 0 0-2.6 2.6v9" />
    </svg>
  );
}

export function MinusGlyph({ size = 19 }: { size?: number }) {
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
      <path d="M8.2 12h7.6" />
    </svg>
  );
}

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

/** Лампочка подсказки. Янтарная — в сером абзаце она и должна цеплять глаз. */
export function HintGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="glyph hint-mark"
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
      <path d="M12 3.2a6.3 6.3 0 0 0-3.6 11.5c.5.35.8.92.8 1.53v.37h5.6v-.37c0-.61.3-1.18.8-1.53A6.3 6.3 0 0 0 12 3.2Z" />
      <path d="M9.9 19h4.2" opacity="0.85" />
      <path d="M10.7 21.2h2.6" opacity="0.6" />
    </svg>
  );
}

/**
 * Абзац из текста бота: эмодзи, для которых нарисован свой значок, меняются
 * на него по дороге. Строки приходят из словаря целиком, вырезать значок из
 * середины предложения иначе нечем.
 */
const INLINE: Record<string, () => ReactNode> = {
  "\u{1F4A1}": () => <HintGlyph />,
  "\u2795": () => <PlusGlyph size={15} />,
};
const INLINE_RE = new RegExp(`(${Object.keys(INLINE).join("|")})`, "u");

/** Строка бота со своими значками вместо эмодзи — куском, без обёртки. */
export function botNodes(text: string): ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    const make = INLINE[part];
    return make ? <Fragment key={i}>{make()}</Fragment> : part;
  });
}

export function BotText({ text, className = "note" }: { text: string; className?: string }) {
  return <p className={className}>{botNodes(text)}</p>;
}
