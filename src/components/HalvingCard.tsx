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
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct } from "../lib/format";
import { useNow } from "../lib/tick";
import { fetchHalving, peekHalving } from "../lib/api";
import { CLOCK_UNITS, HALVING_TTL_MS, clockSpeech, halvingView, unitLabel, type HalvingReply } from "../lib/halving";
import { BtcGlyph } from "./ui";
import "./HalvingCard.css";

// Чуть дольше, чем ответ живёт в памяти: иначе каждый второй повтор брал
// бы из памяти тот же ответ и обновление шло бы вдвое реже.
const REFRESH_MS = HALVING_TTL_MS + 5_000;

const pad = (n: number) => String(n).padStart(2, "0");
/** Подписи из словаря — запасные, если Intl не умеет единицы (старый WebView). */
const FALLBACK = ["hv_d", "hv_h", "hv_m", "hv_s"] as const;
/** Сатоши → BTC без лишних нулей: 3,125 и 1,5625, а на будущих эпохах — до 8 знаков. */
const btc = (sats: number) => num(sats / 1e8, 8);

export function HalvingCard() {
  const lang = useApp((s) => s.lang);
  const local = useNow();
  const titleId = useId();
  const [h, setH] = useState<HalvingReply | null>(() => peekHalving() ?? null);
  // Первый запрос ещё идёт — заглушка того же размера, а не пустое место,
  // в которое карточка потом «выпрыгнет». Не ответил — карточки нет.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetchHalving().then((r) => {
        if (!alive) return;
        if (r) setH(r);
        setLoading(false);
      });
    // Свёрнутое приложение сеть не трогает; вернулись — сразу свежий ответ
    // (из памяти, если он моложе пяти минут), а не через пять минут.
    const visible = () => {
      if (!document.hidden) load();
    };
    load();
    const id = setInterval(visible, REFRESH_MS);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  // Цифры влезают в ячейки при любом системном размере шрифта: Android
  // увеличивает текст до 130–200 %, и «15» вылезало за рамку ячейки. Не
  // влезает — все четыре числа уменьшаются одинаково (--hv-fit), ровно
  // настолько, чтобы влезло самое широкое. Пересчёт — при смене размера
  // (поворот, другой шрифт), языка и числа цифр в днях, а не каждую секунду:
  // цифры моноширинные.
  const clockRef = useRef<HTMLDivElement>(null);
  // Часы телефона могут врать на минуты и часы — считаем по часам сервера.
  const view = h ? halvingView(h, local + (h.skew ?? 0)) : null;
  const shape = `${lang}|${String(view?.parts[0] ?? 0).length}|${view ? view.left > 0 : "-"}`;
  useLayoutEffect(() => {
    const el = clockRef.current;
    if (!el) return undefined;
    const fit = () => {
      el.style.removeProperty("--hv-fit");
      el.style.removeProperty("--hv-fit-l");
      // Число и подпись в ячейке по центру и шириной по себе — сравниваем с
      // местом в ячейке (без её полей). Числа и подписи — каждые своим
      // коэффициентом: подпись не должна мельчать из-за широкого числа.
      let kb = 1;
      let kl = 1;
      for (const cell of el.querySelectorAll<HTMLElement>(".hv-cell")) {
        const cs = getComputedStyle(cell);
        const room = cell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (room <= 0) continue;
        const b = cell.querySelector("b");
        const l = cell.querySelector("small");
        if (b && b.scrollWidth > room) kb = Math.min(kb, room / b.scrollWidth);
        if (l && l.scrollWidth > room) kl = Math.min(kl, room / l.scrollWidth);
      }
      if (kb < 1) el.style.setProperty("--hv-fit", String(Math.floor(kb * 1000) / 1000));
      if (kl < 1) el.style.setProperty("--hv-fit-l", String(Math.floor(kl * 1000) / 1000));
    };
    fit();
    if (typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shape]);

  // Формат даты — один на язык, а не новый каждую секунду тика.
  const dateFmt = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", year: "numeric" });
    } catch {
      return null;
    }
  }, [lang]);

  if (!h || !view) {
    if (!loading) return null;
    return (
      <section className="hv hv-skel" aria-busy="true" aria-labelledby={titleId}>
        <h2 className="hv-t" id={titleId}>
          <span className="hv-coin" aria-hidden="true"><BtcGlyph /></span>
          {t(lang, "hv_title")}
        </h2>
        <div className="hv-clock" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className={i === 0 ? "hv-cell hv-days" : "hv-cell"}><b>&nbsp;</b><small>&nbsp;</small></div>)}
        </div>
        <div className="hv-bar" aria-hidden="true" />
        {/* Строки под полосой — те же блоки, что у карточки: заглушка той же
            высоты, и при ответе ничего не прыгает. */}
        <div className="hv-meta" aria-hidden="true"><span className="hv-ph">&nbsp;</span><span className="hv-ph">&nbsp;</span></div>
        <p className="hv-eta" aria-hidden="true"><span className="hv-ph">&nbsp;</span></p>
        <p className="hv-avg" aria-hidden="true"><span className="hv-ph">&nbsp;</span></p>
        <p className="hv-rw" aria-hidden="true"><span className="hv-ph">&nbsp;</span></p>
      </section>
    );
  }
  const v = view;
  const day = (ts: number) => (dateFmt ? dateFmt.format(new Date(ts * 1000)) : new Date(ts * 1000).toISOString().slice(0, 10));
  const etaText = day(v.eta);
  // Форма слова — по числу и языку (Intl): «1 day» и «2 days», «544 يومًا».
  const labels = v.parts.map((n, i) => unitLabel(lang, CLOCK_UNITS[i]!, n) ?? t(lang, FALLBACK[i]!));
  const epochText = t(lang, "hv_epoch", { p: pct(v.donePct, 1, false) });
  // Для читалки — словами целиком: «544 дня 3 часа 45 минут 23 секунды».
  const clock = clockSpeech(lang, v.parts) ?? v.parts.map((n, i) => `${i === 0 ? num(n) : pad(n)} ${labels[i]}`).join(" ");

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
        // Больше 999 дней (первые месяцы после халвинга) — «1 457» шире
        // ячейки на узком экране: дням больше места и шрифт поменьше.
        <div ref={clockRef} className={v.parts[0] >= 1000 ? "hv-clock hv-wide" : "hv-clock"} dir="ltr" role="timer" aria-label={clock}>
          {v.parts.map((n, i) => (
            <div key={i} className={i === 0 ? "hv-cell hv-days" : "hv-cell"} aria-hidden="true">
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
        {/* Перенос — только после «/» (крупный шрифт на узком экране), а не
            посреди числа: разряды у num — неразрывные пробелы. */}
        <span className="hv-blk"><bdi dir="ltr">{num(v.height)}{"\u00a0"}/ {num(h.next)}</bdi></span>
      </div>
      <p className="hv-eta">≈ {etaText}</p>
      <p className="hv-avg">{t(lang, h.src === "epoch" ? "hv_avg_epoch" : "hv_avg", { m: num(h.avg / 60, 2) })}</p>
      <p className="hv-rw">
        {/* Перенос — только после «→», а BTC не отрывается от числа. */}
        {t(lang, "hv_reward")} <b><bdi dir="ltr">{btc(v.reward)}{"\u00a0"}→ {btc(v.rewardNext)}{"\u00a0"}BTC</bdi></b>
      </p>
    </section>
  );
}
