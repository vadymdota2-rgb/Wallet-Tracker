/**
 * Отсчёт до халвинга биткоина — внизу бокового меню, на месте даты сборки.
 *
 * Сервер раз в пять минут отдаёт высоту и время последнего блока, среднее
 * время блока за всю эпоху (от прошлого халвинга) и готовую оценку момента
 * халвинга. Приложение тикает раз в секунду от этой оценки, а пока меню
 * открыто — раз в пять минут переспрашивает сервер. Высота между ответами
 * оценивается по тому же среднему, поэтому полоса эпохи и номер блока не
 * стоят на месте.
 *
 * Дата — оценка: блоки идут не строго раз в десять минут, и к самому
 * халвингу она может сдвинуться на дни. Поэтому перед ней «≈», а ниже —
 * среднее, по которому она посчитана.
 *
 * Расчёт — в lib/halving.ts (его проверяют тесты), здесь только вывод.
 * Отсчёт идёт по часам сервера: телефон с неверным временем иначе показал
 * бы неверный отсчёт.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct } from "../lib/format";
import { useNow } from "../lib/tick";
import { fetchHalving, peekHalving } from "../lib/api";
import { halvingView } from "../lib/halving";
import type { HalvingReply } from "../lib/types";

const pad = (n: number) => String(n).padStart(2, "0");

/** Знак биткоина рисунком: символа ₿ (Unicode 10) нет в шрифтах старых Android — там был бы пустой квадрат. */
export function BtcGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <g transform="rotate(14 12 12)" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 5h5.2a3 3 0 010 6H8zm0 6h6a3 3 0 010 6H8zm0-6v12M10 3v2m3-2v2m-3 12v2m3-2v2" />
      </g>
    </svg>
  );
}
const REFRESH_MS = 5 * 60_000;
/** Сатоши → BTC без лишних нулей: 3,125 и 1,5625, а на будущих эпохах — до 8 знаков. */
const btc = (sats: number) => num(sats / 1e8, 8);

export function HalvingCard() {
  const lang = useApp((s) => s.lang);
  const local = useNow();
  const [h, setH] = useState<HalvingReply | null>(() => peekHalving() ?? null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetchHalving().then((r) => {
        if (alive && r) setH(r);
      });
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Формат даты — один на язык, а не новый каждую секунду тика.
  const dateFmt = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", year: "numeric" });
    } catch {
      return null;
    }
  }, [lang]);

  if (!h) return null;
  // Часы телефона могут врать на минуты и часы — считаем по часам сервера.
  const v = halvingView(h, local + (h.skew ?? 0));
  const etaText = dateFmt ? dateFmt.format(new Date(v.eta * 1000)) : new Date(v.eta * 1000).toISOString().slice(0, 10);
  const labels = [t(lang, "hv_d"), t(lang, "hv_h"), t(lang, "hv_m"), t(lang, "hv_s")];
  const epochText = t(lang, "hv_epoch", { p: pct(v.donePct, 1, false) });
  const clock = v.parts.map((n, i) => `${i === 0 ? num(n) : pad(n)} ${labels[i]}`).join(" ");

  return (
    <section className="hv" aria-label={t(lang, "hv_title")}>
      <p className="hv-t">
        <span className="hv-coin" aria-hidden="true"><BtcGlyph /></span>
        {t(lang, "hv_title")}
      </p>
      {v.left > 0 ? (
        // role="timer": читалка экрана не объявляет каждую секунду, а целиком
        // читает отсчёт, когда до него дошли.
        <div className="hv-clock" dir="ltr" role="timer" aria-label={clock}>
          {v.parts.map((n, i) => (
            <div key={i} className={i === 0 ? "hv-cell big" : "hv-cell"} aria-hidden="true">
              <b>{i === 0 ? num(n) : pad(n)}</b>
              <small>{labels[i]}</small>
            </div>
          ))}
        </div>
      ) : (
        <p className="hv-now">{t(lang, "hv_now")}</p>
      )}
      <div className="hv-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={v.donePct} aria-valuetext={epochText}>
        <i style={{ width: `${v.done}%` }} />
      </div>
      <div className="hv-meta">
        <span>{epochText}</span>
        <span><bdi dir="ltr">{num(v.height)} / {num(h.next)}</bdi></span>
      </div>
      <p className="hv-eta">≈ {etaText}</p>
      <p className="hv-avg">{t(lang, h.src === "epoch" ? "hv_avg_epoch" : "hv_avg", { m: num(h.avg / 60, 2) })}</p>
      <p className="hv-rw">
        {t(lang, "hv_reward")} <b><bdi dir="ltr">{btc(v.reward)} → {btc(v.rewardNext)} BTC</bdi></b>
      </p>
    </section>
  );
}
