/**
 * Мозг оракула: то, на что он смотрит, вокруг того, чем он смотрит.
 *
 * Подписи вокруг картинки — не украшение и не выдумка. Это те самые признаки,
 * на которых обучена модель: их имена приходят с сервера тем же списком, что
 * стоит в `ORACLE_FEATURES` бота, и, если модель обучена, порядок берётся по
 * её собственной важности — сначала то, что решает больше. Придумывать здесь
 * слова нельзя: человек прочтёт их как обещание, что оракул это учитывает.
 *
 * Сама картинка не движется: присланный файл — одиночный кадр с расширением
 * .gif. Живым мозг делает слой поверх: огоньки, бегущие по жилкам, и вспышки
 * в узлах. Своих линий этот слой не рисует — режим наложения «screen»
 * складывает его свет с тем, что под ним, поэтому загорается настоящая нить
 * картинки, а не появляется чужая поверх неё. Пути проложены по самому
 * мозгу: яркость картинки снята сеткой 48×27, и координаты взяты с неё, а не
 * на глаз.
 *
 * Слой огней едет вместе с картинкой в одном наплыве: разойдись они, за сорок
 * секунд огни уползли бы с жилок на пустоту. Подписи в наплыве не участвуют —
 * текст, который дышит, читать невозможно.
 *
 * При `prefers-reduced-motion` не движется ничего.
 */
import { useEffect, useId, useState, type CSSProperties } from "react";
import { t } from "../i18n/t";
import { whyKey } from "../lib/labels";
import type { LangCode } from "../i18n/types";
import brain from "../assets/brain.gif";

/** Признаки оракула — тем же порядком и теми же именами, что в боте. */
export const ORACLE_FEATURES = [
  "flow", "volume", "wallets", "spread", "accel", "trades", "ticket", "top100",
  "top dir", "both", "ret 1h", "ret 6h", "ret 24h", "vol 24h", "vol jump",
  "to high", "from low", "RSI", "trend", "ATR", "funding", "funding z",
  "OI 1h", "OI 24h", "OI/vlm", "vlm 24h", "liq skew", "liq/OI", "leverage",
  "liquidity", "BTC 24h", "BTC vol", "breadth", "hour", "hour 2",
  "MACD", "MACD sig", "MACD hist",
  "age", "vlm z", "shock",
] as const;

/* Пять мест вокруг картинки. Больше — и подписи начинают налезать друг на
   друга на узком телефоне; меньше — вокруг пусто. */
const SLOTS = 5;
/* Шаг очереди. Меняется одно место за шаг, поэтому своя подпись живёт
   SLOTS × STEP — семь секунд: полторы на проявление, четыре на чтение,
   полторы на угасание. Раньше все пять менялись разом и каждые 1.4 с: рядом
   со списком сигналов это мелькало и перетягивало взгляд. */
const STEP = 1400;

/* Жилки мозга в координатах картинки 960×540. Сняты с её яркости, а не
   придуманы: мозг занимает x 230…760, y 60…350, ствол уходит вниз около
   x 560…600. Числа рядом — за сколько секунд огонёк проходит путь и через
   сколько стартует: пути разной длины и разной спешки, иначе выходит парад.
   Числа заданы, а не случайны: случайный мозг при каждом входе горел бы
   иначе, и заметить, что он сломался, было бы нельзя. */
const WIRES: [string, number, number][] = [
  ["M316,236 C390,130 500,88 620,96 C690,100 735,140 742,196", 16, 0],
  ["M300,272 C376,186 482,146 600,150 C685,152 722,186 734,228", 13, 3],
  ["M300,308 C378,252 470,218 580,208 C668,198 712,220 726,262", 18, 6],
  ["M300,340 C380,305 470,285 570,275 C658,268 706,282 722,304", 14, 9],
  ["M320,300 C380,345 460,360 545,345 C620,332 680,330 720,345", 12, 2],
  ["M560,330 C570,380 585,430 600,490", 11, 5],
  ["M296,292 C316,242 348,202 388,178", 9, 8],
  ["M655,148 C695,175 715,212 714,252", 15, 4],
  ["M400,250 C470,230 540,225 610,240", 10, 7],
];

/* Хвост импульса: радиус, прозрачность и отставание по времени. Первое
   пятно — сам импульс, два следом — его след. */
const TAIL: [number, number, number][] = [
  [14, 1, 0], [10, 0.6, 0.35], [7, 0.32, 0.7],
];

/** Узлы: где вспыхивает синапс. Тоже по карте яркости. */
const NODES: [number, number][] = [
  [340, 240], [420, 180], [500, 140], [590, 130], [670, 150], [712, 205],
  [330, 300], [430, 255], [530, 225], [630, 220], [700, 255],
  [360, 340], [460, 320], [560, 300], [648, 292], [700, 312],
  [400, 360], [520, 350], [620, 345], [575, 400], [595, 460],
];

export function Brain({ lang, top }: {
  lang: LangCode;
  /** Важности обученной модели: если они есть, порядок берётся по ним. */
  top?: { k: string }[];
}) {
  /* Показываются все признаки по очереди, а важные — первыми: сервер
     присылает верхушку по важности обученной модели, дальше идёт остальной
     список. Крутить одну только верхушку значило бы уверять, что оракул
     смотрит на пять чисел. */
  const names = [
    ...(top ?? []).map((x) => x.k),
    ...ORACLE_FEATURES.filter((f) => !(top ?? []).some((x) => x.k === f)),
  ];
  const [tick, setTick] = useState(0);
  const [still, setStill] = useState(false);
  /* Свой номер на все ссылки внутри svg: два таких мозга на одной странице
     поделили бы одни и те же пути. */
  const uid = useId().replace(/:/g, "");

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const apply = () => setStill(!!mq?.matches);
    apply();
    mq?.addEventListener?.("change", apply);
    return () => mq?.removeEventListener?.("change", apply);
  }, []);

  useEffect(() => {
    if (still) return;
    const id = window.setInterval(() => setTick((n) => n + 1), STEP);
    return () => window.clearInterval(id);
  }, [still]);

  const label = (raw: string) => {
    const k = whyKey(raw);
    return k ? t(lang, k) : raw;
  };

  return (
    <div className="brain" aria-hidden="true">
      <div className="brain-live">
        <img className="brain-img" src={brain} alt="" width={960} height={540} />
        {still ? null : (
          <svg className="brain-fire" viewBox="0 0 960 540"
               preserveAspectRatio="xMidYMid slice">
            <defs>
              <radialGradient id={`${uid}b`}>
                <stop offset="0%" stopColor="#dff6ff" stopOpacity="1" />
                <stop offset="35%" stopColor="#7fd8ff" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#7fd8ff" stopOpacity="0" />
              </radialGradient>
              <radialGradient id={`${uid}v`}>
                <stop offset="0%" stopColor="#f0e2ff" stopOpacity="1" />
                <stop offset="35%" stopColor="#c07bff" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#c07bff" stopOpacity="0" />
              </radialGradient>
              {WIRES.map(([d], i) => <path key={i} id={`${uid}w${i}`} d={d} />)}
            </defs>
            {/* Импульс — мягкое пятно света, идущее по жилке, и два таких же
                следом, поменьше и бледнее: получается хвост кометы.
                Пятно, а не отрезок линии: у отрезка есть края, и он ложится
                поверх картинки чужой чертой, а у пятна краёв нет — оно просто
                подсвечивает то, что под ним. */}
            {WIRES.map(([, dur, begin], i) =>
              TAIL.map(([r, op, lag], k) => (
                /* Прозрачность живёт своим кругом той же длины и с той же
                   задержкой, что и движение. Без неё пятно до своего выхода
                   стоит в начале координат — светящейся точкой в углу
                   картинки, — а потом выскакивает посреди мозга. Теперь оно
                   разгорается в начале пути и гаснет в конце. */
                <circle
                  key={`${i}-${k}`}
                  className="brain-spark"
                  r={r}
                  fill={`url(#${uid}${i % 3 ? "b" : "v"})`}
                  style={{
                    "--op": op,
                    animationDuration: `${dur}s`,
                    animationDelay: `${begin + lag}s`,
                  } as CSSProperties}
                >
                  <animateMotion dur={`${dur}s`} begin={`${begin + lag}s`}
                                 repeatCount="indefinite">
                    <mpath href={`#${uid}w${i}`} />
                  </animateMotion>
                </circle>
              )),
            )}
            {NODES.map(([x, y], i) => (
              <circle
                key={i}
                className="brain-node"
                cx={x}
                cy={y}
                r="14"
                fill={`url(#${uid}${i % 3 ? "b" : "v"})`}
                style={{
                  animationDuration: `${4.5 + (i % 4)}s`,
                  animationDelay: `${((i * 0.7) % 9).toFixed(1)}s`,
                }}
              />
            ))}
          </svg>
        )}
      </div>
      {Array.from({ length: SLOTS }, (_, i) => {
        /* За один шаг меняется одно место — то, до которого дошла очередь.
           Остальные стоят: так на картинке всегда есть что читать, и ни одна
           подпись не исчезает вместе с соседней. */
        const n = names.length;
        const spread = Math.max(1, Math.floor(n / SLOTS));
        const turn = Math.floor((tick + SLOTS - i) / SLOTS);
        const at = ((turn + i * spread) % n + n) % n;
        const raw = names[at] ?? "";
        return (
          /* Ключ меняется только вместе с именем: на нём перезапускается
             плавное проявление, и чужие шаги его не сбивают. */
          <span
            key={`${i}-${still ? "still" : at}`}
            className={`brain-tag s${i}${still ? " still" : ""}`}
          >
            {label(raw)}
          </span>
        );
      })}
    </div>
  );
}
