/**
 * Карточка сигнала.
 *
 * Сверху — то, что модель вообще сказала: вероятность роста за выбранный ею
 * горизонт, полосой с отметкой на 50%. Расстояние от отметки и есть весь
 * смысл числа.
 *
 * Ниже — график, и на нём весь план сразу: вход, стоп и обе цели линиями,
 * риск и прибыль полосами. Четыре цены в плитках не говорят, далеко ли цель
 * от того, где цена ходила последние сутки; график говорит это первым
 * взглядом. Числа под ним остаются: график — не замена значениям.
 *
 * В конце — вклад признаков в эту оценку, полосами в обе стороны от нуля.
 * Доводы против показываются наравне с доводами за: прятать их значило бы
 * рисовать модель увереннее, чем она есть.
 */
import { useEffect, useState } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, px, signed } from "../lib/format";
import { sideKey, whyKey } from "../lib/labels";
import { venueName } from "../lib/rank";
import { fetchTokenHist } from "../lib/api";
import {
  candlesFrom, fetchCandles, TF_LABEL,
  type Candle, type SpotTf, type Timeframe,
} from "../lib/klines";
import { CoinIcon } from "../components/CoinIcon";
import { Candles, type PlanLevel, type PlanZone } from "../components/Chart";
import {
  Card, Diverging, Empty, Meter, SectionTitle, Segmented, Skeleton, Tiles,
} from "../components/ui";
import type { LangCode } from "../i18n/types";
import type { Venue } from "../lib/types";

/* Сетка таймфреймов карточки: четыре кнопки влезают в 320 точек, шесть —
   нет, последняя уезжала за край. */
const PLAN_TFS: Timeframe[] = ["15m", "1h", "4h", "1d"];
const PLAN_SPOT_TFS: SpotTf[] = ["1h", "4h", "1d"];

/** Горизонт словами: модель выбирает его сама, и он у каждого сигнала свой. */
function hours(lang: LangCode, sec: number): string {
  const h = Math.max(1, Math.round((sec || 86400) / 3600));
  return t(lang, "ai_hours", { n: h });
}

export function SignalScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const cortex = useLive((s) => s.cortex);

  const [venueRaw, idxRaw] = String(arg || "").split(":");
  const venue = (venueRaw === "perp" ? "perp" : "spot") as Venue;
  const idx = Number(idxRaw);

  const list = cortex.list.filter((s) => s.venue === venue);
  const s = list[idx];

  const sym = s?.sym ?? "";
  const addr = String(s?.addr || "");
  const hasAddr = /^0x[0-9a-fA-F]{40}$/.test(addr);

  /* Таймфрейм тут свой, а не общий с экраном монеты, и начинается с часа.
     План живёт часами: на дневных свечах цель в четыре процента сливается с
     телом одной свечи, и смотреть на неё незачем. Недель и месяцев в наборе
     нет по той же причине. */
  const [tf, setTf] = useState<Timeframe>("1h");
  const [spotTf, setSpotTf] = useState<SpotTf>("1h");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [hist, setHist] = useState<[number, number][] | null>(null);

  /* Оба источника спрашиваются сразу, а не по цепочке: ждать отказа биржи,
     чтобы только потом пойти в базу, значит показывать скелет дважды. */
  useEffect(() => {
    if (!sym) return;
    const ctrl = new AbortController();
    setCandles(null);
    void fetchCandles(sym, tf, ctrl.signal).then((c) => {
      if (!ctrl.signal.aborted) setCandles(c);
    });
    return () => ctrl.abort();
  }, [sym, tf]);

  useEffect(() => {
    if (!hasAddr) {
      setHist([]);
      return;
    }
    const ctrl = new AbortController();
    setHist(null);
    void fetchTokenHist(addr, ctrl.signal).then((d) => {
      if (!ctrl.signal.aborted) setHist(d?.ok ? d.hist ?? [] : []);
    });
    return () => ctrl.abort();
  }, [addr, hasAddr]);

  if (!s) {
    return (
      <Frame title={t(lang, "ai_title")}>
        <Empty text={t(lang, "ui_no_signals")} />
      </Frame>
    );
  }

  const long = s.side === "buy";
  /* Показывается уверенность модели в том, что она советует: у покупки это
     шанс роста, у продажи — шанс падения. Так же и в списке.
     Прежде здесь всегда стоял шанс роста, и у продажи с уверенностью 67%
     карточка показывала 33% — число, о котором никто не спрашивал, а список
     на том же сигнале показывал 67%. Отметка «монетка» стоит на половине в
     обоих случаях, так что сравнивать сигналы это не мешает. */
  const conf = s.conf;
  const away = (v: number) => (s.entry > 0 ? ((v - s.entry) / s.entry) * 100 : 0);

  /* Уровни плана: значок в подписи, а не только цвет. Зелёный с красным
     различим не для всех глаз, и «🛑» с «🎯» говорят то же самое.

     Порядок здесь — порядок важности, а не порядок цен: график ставит
     подписи в нём и пропускает те, что налезают на уже поставленные. Когда
     монета за сутки прошла куда больше плана, все четыре уровня сжимаются
     в несколько точек и подписать удаётся не все. Первым должен стоять
     стоп: это то, чем человек рискует. Прежде порядок был «вход, стоп,
     цели», и при сжатом плане выбывала как раз подпись стопа, а обе цели
     оставались — карточка показывала, сколько можно взять, и умалчивала,
     сколько можно потерять. */
  const levels: PlanLevel[] = [
    { v: s.stop, tone: "dn", label: t(lang, "ai_stop") },
    { v: s.entry, tone: "warn", label: t(lang, "ai_entry") },
    { v: s.t1, tone: "up", label: `${t(lang, "ai_take_one")} 1` },
    { v: s.t2, tone: "up", label: `${t(lang, "ai_take_one")} 2` },
  ].filter((l) => l.v > 0) as PlanLevel[];
  /* Полосы риска и прибыли: их высоты и есть то отношение, ради которого
     сделку берут. Считаются от входа, а не от текущей цены. */
  const zones: PlanZone[] = [];
  if (s.entry > 0 && s.stop > 0) zones.push({ from: s.entry, to: s.stop, tone: "dn" });
  if (s.entry > 0 && s.t2 > 0) zones.push({ from: s.entry, to: s.t2, tone: "up" });

  const exch = candles && candles.length >= 3 ? candles : null;
  const dex = hist?.length ? candlesFrom(hist, spotTf) : null;
  // Биржевые свечи точнее: там настоящие OHLC, а не почасовые замеры.
  const dexShown = !exch && !!dex && dex.length >= 3;
  const waiting = candles === null || (!exch && hasAddr && hist === null);

  return (
    <Frame
      title={
        <span className="ttl-coin">
          <CoinIcon sym={s.sym} size={30} />
          {s.sym}
        </span>
      }
      /* Площадка своим именем: «спот» — это про вид сделки, а тут важно,
         где монета торгуется. */
      sub={`${t(lang, sideKey(venue, long))} · ${venueName(venue)} · ${
        t(lang, s.model ? "ai_mode_model" : "ai_mode_formula")}`}
    >
      <Card>
        <div className="hero">
          <div className="hero-main">
            <div className={`hero-val ${long ? "up" : "dn"}`}>{conf}%</div>
            <div className="hero-note">
              {t(lang, long ? "ai_p_up" : "ai_p_dn", { h: hours(lang, s.h) })}
            </div>
          </div>
        </div>
        <Meter
          value={conf / 100}
          mark={0.5}
          markLabel={t(lang, "ai_st_coin")}
          tone={long ? "up" : "dn"}
        />
      </Card>

      <Card>
        <SectionTitle>{t(lang, "ai_plan")}</SectionTitle>
        {/* Сетка таймфреймов зависит от источника: у биржи своя, у истории из
            базы замеры почасовые, и минутных свечей из них не собрать. */}
        {dexShown ? (
          <Segmented<SpotTf>
            value={spotTf}
            onChange={setSpotTf}
            options={PLAN_SPOT_TFS.map((id) => ({ id, label: t(lang, TF_LABEL[id]) }))}
          />
        ) : (
          <Segmented<Timeframe>
            value={tf}
            onChange={setTf}
            options={PLAN_TFS.map((id) => ({ id, label: t(lang, TF_LABEL[id]) }))}
          />
        )}
        {waiting ? (
          <Skeleton rows={4} />
        ) : exch || dexShown ? (
          <Candles
            candles={(exch ?? dex) as Candle[]}
            height={210}
            format={px}
            levels={levels}
            zones={zones}
          />
        ) : (
          /* Ничего не досочиняем: нет котировок — так и написано. Уровни
             стоят числами ниже, и от отсутствия графика они не пропадают. */
          <Empty text={t(lang, "ui_no_quotes")} />
        )}
      </Card>

      <Card>
        <Tiles
          items={[
            { label: t(lang, "ai_entry"), value: px(s.entry) },
            { label: t(lang, "ai_stop"), value: px(s.stop), tone: "dn" },
            { label: `${t(lang, "ai_take_one")} 1`, value: px(s.t1), tone: "up" },
            { label: `${t(lang, "ai_take_one")} 2`, value: px(s.t2), tone: "up" },
          ]}
        />
        {/* Полоса показывает, куда от входа идёт цена, а цвет — чем это
            кончится. У продажи цель ниже входа, стоп выше, и по одному знаку
            выходило, что цель красная, а стоп зелёный — ровно наоборот. */}
        <Diverging
          items={[
            { name: t(lang, "ai_stop"), value: away(s.stop),
              label: pct(away(s.stop), 1), tone: "dn" },
            { name: `${t(lang, "ai_take_one")} 1`, value: away(s.t1),
              label: pct(away(s.t1), 1), tone: "up" },
            { name: `${t(lang, "ai_take_one")} 2`, value: away(s.t2),
              label: pct(away(s.t2), 1), tone: "up" },
          ]}
        />
        <Tiles
          size="sm"
          items={[
            /* Риск — это доля депозита, которой человек рискует, а не
               расстояние до стопа: расстояние видно на полосах выше.
               Запасным значением тут стояло как раз расстояние до стопа —
               то самое, чем риск не является, — и на перпах с плечом 5
               карточка занижала его впятеро против того же числа в чате.
               Считает долю сам бот, обоими путями; нет числа — прочерк, а
               не похожее. */
            { label: t(lang, "ai_risk"),
              value: s.share > 0 ? pct(s.share, 1, false) : "—" },
            { label: t(lang, "hl_leverage"), value: venue === "perp" ? `${s.lev}×` : "1×" },
            { label: t(lang, "flow_wallets"), value: num(s.w) },
            /* Сырой поток за сутки — не то же, что вклад признака «поток» в
               оценку: первое в долларах, второе в процентных пунктах. */
            { label: t(lang, "flow_title"), value: signed(s.net),
              tone: s.net >= 0 ? "up" : "dn" },
          ]}
        />
      </Card>

      <Card>
        <SectionTitle>{t(lang, "ai_why")}</SectionTitle>
        {s.why.length === 0 ? (
          <p className="note dim">{t(lang, "ai_st_untrained")}</p>
        ) : s.model ? (
          /* У обученной модели вклад признака — сдвиг вероятности в
             процентных пунктах, его можно поставить на полосу. */
          <Diverging
            items={s.why.map((w) => {
              const k = whyKey(w.k);
              return {
                name: k ? t(lang, k) : w.k,
                value: w.v,
                label: `${w.v >= 0 ? "+" : "−"}${Math.abs(w.v).toFixed(1)}`,
              };
            })}
          />
        ) : (
          /* У формулы такого числа не существует, и рисовать её условия теми
             же полосами значило бы выдавать одно за другое. Поэтому список:
             что именно совпало. Раньше здесь стояло одно «ещё не обучена —
             формула» — правда про модель и ничего про сигнал. */
          <>
            <p className="note">{t(lang, "ai_why_formula")}</p>
            <ul className="why-list">
              {s.why.map((w, i) => {
                const k = whyKey(w.k);
                return <li key={i}>{k ? t(lang, k) : w.k}</li>;
              })}
            </ul>
            <p className="note dim">{t(lang, "ai_st_untrained")}</p>
          </>
        )}
        <p className="note dim">{t(lang, "ai_trade_hint")}</p>
      </Card>
    </Frame>
  );
}
