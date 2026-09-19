/**
 * Мозг оракула: то, на что он смотрит, вокруг того, чем он смотрит.
 *
 * Подписи вокруг картинки — не украшение и не выдумка. Это те самые признаки,
 * на которых обучена модель: их имена приходят с сервера тем же списком, что
 * стоит в `ORACLE_FEATURES` бота, и, если модель обучена, порядок берётся по
 * её собственной важности — сначала то, что решает больше. Придумывать здесь
 * слова нельзя: человек прочтёт их как обещание, что оракул это учитывает.
 *
 * Картинка сама не движется: присланный файл — одиночный кадр с расширением
 * .gif. Движение ей даёт стиль — медленный наплыв, дыхание свечения и луч
 * поперёк; здесь только подписи. При `prefers-reduced-motion` не движется
 * ничего: мигающий текст читать тяжело и не всем безопасно.
 */
import { useEffect, useState } from "react";
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
] as const;

/* Пять мест вокруг картинки. Больше — и подписи начинают налезать друг на
   друга на узком телефоне; меньше — вокруг пусто. */
const SLOTS = 5;
/* Шаг очереди. Меняется одно место за шаг, поэтому своя подпись живёт
   SLOTS × STEP — семь секунд: полторы на проявление, четыре на чтение,
   полторы на угасание. Раньше все пять менялись разом и каждые 1.4 с: рядом
   со списком сигналов это мелькало и перетягивало взгляд. */
const STEP = 1400;

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
      <img className="brain-img" src={brain} alt="" width={960} height={540} />
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
