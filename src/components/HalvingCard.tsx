/**
 * Отсчёт до халвинга биткоина — внизу бокового меню.
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
import { useEffect, useId, useMemo, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct } from "../lib/format";
import { useNow } from "../lib/tick";
import { fetchHalving, peekHalving } from "../lib/api";
import { halvingView } from "../lib/halving";
import type { HalvingReply } from "../lib/types";
import { BtcGlyph } from "./ui";

// Чуть дольше, чем ответ живёт в памяти (5 мин): иначе каждый второй
// повтор брал бы из памяти тот же ответ и обновление шло бы раз в 10 минут.
const REFRESH_MS = 5 * 60_000 + 5_000;

const pad = (n: number) => String(n).padStart(2, "0");
/** Сатоши → BTC без лишних нулей: 3,125 и 1,5625, а на будущих эпохах — до 8 знаков. */
const btc = (sats: number) => num(sats / 1e8, 8);

export function HalvingCard() {
  const lang = useApp((s) => s.lang);
  const local = useNow();
  const titleId = useId();
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
  const day = (ts: number) => (dateFmt ? dateFmt.format(new Date(ts * 1000)) : new Date(ts * 1000).toISOString().slice(0, 10));
  const etaText = day(v.eta);
  const labels = [t(lang, "hv_d"), t(lang, "hv_h"), t(lang, "hv_m"), t(lang, "hv_s")];
  const epochText = t(lang, "hv_epoch", { p: pct(v.donePct, 1, false) });
  const clock = v.parts.map((n, i) => `${i === 0 ? num(n) : pad(n)} ${labels[i]}`).join(" ");

  return (
    <section className="hv" aria-labelledby={titleId}>
      <h2 className="hv-t" id={titleId}>
        <span className="hv-coin" aria-hidden="true"><BtcGlyph /></span>
        {t(lang, "hv_title")}
      </h2>
      {v.justHappened ? (
        <p className="hv-done">{t(lang, "hv_happened", { d: day(v.justHappened), n: num(h.next - h.every) })}</p>
      ) : null}
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
