/**
 * Даты на экранах с графиками («Страх и жадность», «Институциональные
 * потоки», «Альтсезон»): день словами на языке человека и деления оси
 * времени. Всё — по UTC: день индекса и закрытие дня считаются по UTC.
 */
import { t } from "../i18n/t";
import { dtf } from "../lib/format";

type Lang = Parameters<typeof t>[0];

export function dateStr(lang: Lang, ts: number, opts: Intl.DateTimeFormatOptions): string {
  try {
    return dtf(lang, { timeZone: "UTC", ...opts }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
}

export function timeTicks(lang: Lang, a: number, b: number): { t: number; label: string }[] {
  const span = (b - a) / 86400;
  const out: { t: number; label: string }[] = [];
  const d0 = new Date(a * 1000);
  const y0 = d0.getUTCFullYear();
  const y1 = new Date(b * 1000).getUTCFullYear();
  if (span > 800) {
    for (let y = y0 + 1; y <= y1; y++) out.push({ t: Date.UTC(y, 0, 1) / 1000, label: String(y) });
  } else if (span > 200) {
    for (let y = y0; y <= y1; y++) for (const m of [0, 3, 6, 9]) {
      const ts = Date.UTC(y, m, 1) / 1000;
      if (ts > a && ts < b) out.push({ t: ts, label: m === 0 ? String(y) : dateStr(lang, ts, { month: "short" }) });
    }
  } else if (span > 45) {
    for (let y = y0; y <= y1; y++) for (let m = 0; m < 12; m++) {
      const ts = Date.UTC(y, m, 1) / 1000;
      if (ts > a && ts < b) out.push({ t: ts, label: dateStr(lang, ts, { month: "short" }) });
    }
  } else {
    for (let ts = a + 3 * 86400; ts < b; ts += 7 * 86400) out.push({ t: ts, label: dateStr(lang, ts, { day: "numeric", month: "short" }) });
  }
  return out;
}
