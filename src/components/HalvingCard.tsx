/**
 * Отсчёт до халвинга биткоина — внизу бокового меню, на месте даты сборки.
 *
 * Сервер раз в пять минут отдаёт высоту последнего блока и среднее время
 * блока за текущий период сложности. Дальше приложение считает само: сколько
 * блоков осталось, сколько это секунд, и тикает раз в секунду. Высота между
 * ответами тоже оценивается — по тому же среднему времени, — поэтому полоса
 * эпохи и номер блока не стоят на месте, пока меню открыто.
 *
 * Дата — оценка: блоки идут не строго раз в десять минут, и к самому
 * халвингу она может сдвинуться на дни. Поэтому перед ней «≈».
 */
import { useEffect, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { num, pct } from "../lib/format";
import { useNow } from "../lib/tick";
import { fetchHalving, peekHalving } from "../lib/api";
import type { HalvingReply } from "../lib/types";

const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, "0");

export function HalvingCard() {
  const lang = useApp((s) => s.lang);
  const now = useNow();
  const [h, setH] = useState<HalvingReply | null>(() => peekHalving() ?? null);

  useEffect(() => {
    let alive = true;
    void fetchHalving().then((r) => {
      if (alive && r?.ok && r.height) setH(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!h?.height) return null;
  const since = Math.max(0, now - h.at);
  const height = Math.min(h.next, h.height + Math.floor(since / h.avg));
  const left = Math.max(0, (h.next - h.height) * h.avg - since);
  const start = h.next - h.every;
  const done = ((height - start) / h.every) * 100;
  const epoch = Math.floor(h.height / h.every);
  const reward = 50 / 2 ** epoch;
  const eta = (() => {
    try {
      return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date((now + left) * 1000));
    } catch {
      return new Date((now + left) * 1000).toISOString().slice(0, 10);
    }
  })();
  const parts: [number, string][] = [
    [left / 86400, t(lang, "hv_d")],
    [(left % 86400) / 3600, t(lang, "hv_h")],
    [(left % 3600) / 60, t(lang, "hv_m")],
    [left % 60, t(lang, "hv_s")],
  ];

  return (
    <section className="hv" aria-label={t(lang, "hv_title")}>
      <p className="hv-t">
        <span className="hv-coin" aria-hidden="true">₿</span>
        {t(lang, "hv_title")}
      </p>
      {left > 0 ? (
        <div className="hv-clock" dir="ltr">
          {parts.map(([v, label], i) => (
            <div key={label} className={i === 0 ? "hv-cell big" : "hv-cell"}>
              <b>{i === 0 ? num(Math.floor(v)) : pad(v)}</b>
              <small>{label}</small>
            </div>
          ))}
        </div>
      ) : (
        <p className="hv-now">{t(lang, "hv_now")}</p>
      )}
      <div className="hv-bar" role="img" aria-label={pct(done, 1, false)}>
        <i style={{ width: `${Math.min(100, Math.max(0, done))}%` }} />
      </div>
      <div className="hv-meta">
        <span>{t(lang, "hv_epoch", { p: pct(done, 1, false) })}</span>
        <span><bdi dir="ltr">{num(height)} / {num(h.next)}</bdi></span>
      </div>
      <p className="hv-eta">≈ {eta}</p>
      <p className="hv-rw">
        {t(lang, "hv_reward")} <b><bdi dir="ltr">{num(reward, 4)} → {num(reward / 2, 5)} BTC</bdi></b>
      </p>
    </section>
  );
}
