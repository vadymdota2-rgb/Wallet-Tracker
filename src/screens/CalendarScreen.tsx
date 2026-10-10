/**
 * Календарь событий, которые двигают рынок: данные и решения центробанков
 * США и других крупных экономик, отчёты компаний, за которыми ходит крипта,
 * листинги и делистинги крупных бирж, экспирации опционов и фьючерсов CME,
 * разлоки токенов.
 *
 * Сверху — ближайшее важное событие с обратным отсчётом. Ниже — лента по
 * дням: время по часам телефона, вид события цветной меткой и словом,
 * важность точками, подробности одной строкой. Касание экспирации открывает
 * опционы монеты, разлока — календарь разлоков. Прошедшая неделя — по
 * кнопке: итог недавних данных тоже важен.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { dateLong, fix2, pct, px, usd } from "../lib/format";
import { haptic, openExternal } from "../lib/telegram";
import { fetchCalendar, peekCalendar } from "../lib/api";
import { useNow } from "../lib/tick";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Skeleton } from "../components/ui";
import type { CalEv, CalReply } from "../lib/types";
import { Frame } from "./Screen";

type Lang = Parameters<typeof t>[0];
type Kind = "all" | "macro" | "opt" | "unl" | "earn" | "list";

/**
 * Названия данных у ForexFactory и Nasdaq → наши слова. Не узнали —
 * оставляем английское: оно точное, а неверный перевод хуже. Порядок
 * важен: ADP проверяется раньше NFP — в обоих есть «Non-Farm».
 */
const MACRO: [RegExp, DictKey][] = [
  [/^Core CPI/i, "cal_m_core_cpi"],
  [/^CPI/i, "cal_m_cpi"],
  [/^Core PPI/i, "cal_m_core_ppi"],
  [/^PPI/i, "cal_m_ppi"],
  [/ADP Non-?Farm/i, "cal_m_adp"],
  [/Non-?Farm (Employment|Payrolls)/i, "cal_m_nfp"],
  [/Unemployment Rate/i, "cal_m_unemp"],
  [/Unemployment Claims|Jobless Claims/i, "cal_m_claims"],
  [/Core PCE/i, "cal_m_core_pce"],
  [/GDP/i, "cal_m_gdp"],
  [/Retail Sales/i, "cal_m_retail"],
  [/ISM Manufacturing/i, "cal_m_ism_m"],
  [/ISM Services/i, "cal_m_ism_s"],
  [/JOLTS/i, "cal_m_jolts"],
  [/Consumer Sentiment|Consumer Confidence/i, "cal_m_sent"],
  [/FOMC Meeting Minutes/i, "cal_m_minutes"],
  [/Powell|Fed Chair/i, "cal_m_powell"],
  [/FOMC Member|Fed .*Speaks/i, "cal_m_fedspeak"],
  [/Durable Goods/i, "cal_m_durable"],
  [/Main Refinancing Rate|Official Bank Rate|BOJ Policy Rate|Cash Rate|Overnight Rate|SNB Policy Rate|Monetary Policy Statement|Interest Rate Decision|Policy Rate/i, "cal_m_rate"],
  [/OPEC/i, "cal_m_opec"],
  [/Bank Holiday/i, "cal_m_holiday"],
  [/Auction/i, "cal_m_auction"],
  [/Crude Oil Inventories/i, "cal_m_oil"],
  [/Trade Balance/i, "cal_m_trade"],
  [/PMI/i, "cal_m_pmi"],
  [/Home Sales|Housing Starts|Building Permits|HPI/i, "cal_m_housing"],
  [/Speaks|Testifies/i, "cal_m_speech"],
];

/** Валюта страны данных → флаг: страну видно сразу, без подписи. */
const FLAG: Record<string, string> = {
  USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", JPY: "🇯🇵", CNY: "🇨🇳", CAD: "🇨🇦", AUD: "🇦🇺", NZD: "🇳🇿", CHF: "🇨🇭", All: "🌍",
};

/** Событие дня, а не часа: разлок, отчёт без объявленного времени. */
const allDay = (e: CalEv) => e.k === "unl" || (e.k === "earn" && e.when === "day");

function macroName(lang: Lang, title: string): string | null {
  const hit = MACRO.find(([re]) => re.test(title));
  return hit ? t(lang, hit[1]) : null;
}

function hm(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Начало дня по часам телефона — события группируются по местному дню. */
function dayKey(ts: number): number {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function dayTitle(lang: Lang, key: number, today: number): string {
  const diff = Math.round((key - today) / 86400);
  if (diff === 0) return t(lang, "cal_today");
  if (diff === 1) return t(lang, "cal_tomorrow");
  if (diff === -1) return t(lang, "cal_yesterday");
  const d = new Date(key * 1000);
  let wd = "";
  try {
    wd = new Intl.DateTimeFormat(lang, { weekday: "long" }).format(d);
  } catch {
    wd = "";
  }
  return `${dateLong(key)}${wd ? `, ${wd}` : ""}`;
}

/** «через 2 д 4 ч» / «через 3 ч 5 мин» / «через 12 мин 40 с» — в последний
    час отсчёт идёт по секундам, чтобы было видно, что он живой. */
function countdown(lang: Lang, sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? t(lang, "cal_in_dh", { d, h }) : h > 0 ? t(lang, "cal_in_hm", { h, m })
    : t(lang, "cal_in_ms", { m, s: sec % 60 });
}

/** Отсчёт в строке: до часа события, а у события дня — сколько дней до него. */
function rowCountdown(lang: Lang, e: CalEv, nowSec: number, today: number): { text: string; soon: boolean } | null {
  if (e.k === "list") return null; // объявление биржи — уже случившаяся новость
  if (allDay(e)) {
    const d = Math.round((dayKey(e.t) - today) / 86400);
    return d >= 1 ? { text: t(lang, "cal_in_d", { d }), soon: false } : null;
  }
  const left = e.t - nowSec;
  if (left <= 0) return { text: t(lang, "cal_now"), soon: true };
  return { text: countdown(lang, left), soon: left < 3600 };
}

/** Часовой пояс телефона — по нему показано всё время на экране:
    «Kyiv, UTC+3». */
function zoneLabel(): string {
  const off = -new Date().getTimezoneOffset();
  const hh = Math.floor(Math.abs(off) / 60);
  const mm = Math.abs(off) % 60;
  const utc = `UTC${off >= 0 ? "+" : "−"}${hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
  let city = "";
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    city = z.includes("/") ? z.split("/").pop()!.replace(/_/g, " ") : "";
  } catch {
    city = "";
  }
  return city ? `${city}, ${utc}` : utc;
}

function title(lang: Lang, e: CalEv): string {
  if (e.k === "fomc") return t(lang, "cal_fomc");
  if (e.k === "opt") return t(lang, "cal_opt", { s: e.sym ?? "" });
  if (e.k === "unl") return t(lang, "cal_unl", { s: e.sym ?? "" });
  if (e.k === "earn") return t(lang, "cal_earn", { s: e.sym ?? "" });
  if (e.k === "cme") return t(lang, "cal_cme");
  /* Объявление биржи — как есть, по-английски: в нём тикеры и точное время. */
  if (e.k === "list") return e.title ?? "";
  return macroName(lang, e.title ?? "") ?? e.title ?? "";
}

/** Цветная метка вида события: макро, экспирации, разлоки, отчёты, листинги. */
const mark = (e: CalEv) => (e.k === "fomc" ? "macro" : e.k === "cme" ? "opt" : e.k);

function Row({ lang, e, past, nowSec, today, onOpen }: {
  lang: Lang; e: CalEv; past: boolean; nowSec: number; today: number; onOpen: (e: CalEv) => void;
}) {
  const tap = e.k === "opt" || e.k === "unl" || (e.k === "list" && Boolean(e.url));
  const cd = past ? null : rowCountdown(lang, e, nowSec, today);
  const body = (
    <>
      {/* Разлок и отчёт без объявленного часа назначены на день — время не пишем. */}
      <span className="cal-time">{allDay(e) ? "" : hm(e.t)}</span>
      <span className={`cal-k ${mark(e)}`} aria-hidden="true" />
      <span className="cal-m">
        <span className="cal-t">
          {e.k === "opt" || e.k === "unl" ? <CoinIcon sym={e.sym ?? ""} size={18} /> : null}
          {e.k === "macro" && e.cc ? <span className="cal-flag" aria-label={e.cc}>{FLAG[e.cc] ?? e.cc}</span> : null}
          {e.k === "list" ? <em className={e.de ? "cal-ex de" : "cal-ex"}>{e.ex}</em> : null}
          <b className={e.k === "list" ? "cal-news" : undefined}>{title(lang, e)}</b>
          <span className={`cal-imp ${e.imp}`} role="img"
            aria-label={t(lang, e.imp === "high" ? "cal_imp_high" : e.imp === "mid" ? "cal_imp_mid" : "cal_imp_low")}>
            <i /><i /><i />
          </span>
        </span>
        {e.k === "macro" ? (
          <small>
            {macroName(lang, e.title ?? "") ? `${e.title}` : ""}
            {macroName(lang, e.title ?? "") && (e.fc || e.prev) ? " · " : ""}
            {e.fc ? t(lang, "cal_fc", { x: e.fc }) : ""}{e.fc && e.prev ? " · " : ""}{e.prev ? t(lang, "cal_prev", { x: e.prev }) : ""}
          </small>
        ) : e.k === "earn" ? (
          <small>
            {e.name}
            {" · "}{t(lang, e.when === "pre" ? "cal_earn_pre" : e.when === "post" ? "cal_earn_post" : "cal_earn_day")}
            {e.eps ? ` · ${t(lang, "cal_eps", { x: e.eps })}` : ""}
          </small>
        ) : e.k === "list" ? (
          <small>{t(lang, e.de ? "cal_delist" : "cal_list")}</small>
        ) : e.k === "cme" ? (
          <small>{t(lang, "cal_cme_sub")}</small>
        ) : e.k === "fomc" ? (
          <small>{t(lang, "cal_fomc_sub")}{e.tent ? ` · ${t(lang, "cal_tent")}` : ""}</small>
        ) : e.k === "opt" ? (
          <small>
            {usd(e.n)} · {t(lang, "op_mp")} {px(e.mp)}
            {e.px && e.mp ? ` (${pct(((e.mp - e.px) / e.px) * 100, 1, true)})` : ""}
            {e.pcr ? ` · P/C ${fix2(e.pcr)}` : ""}
          </small>
        ) : (
          <small>
            {usd(e.usd)}{e.pct ? ` · ${t(lang, "cal_unl_pct", { x: pct(e.pct, 1, false) })}` : ""}
            {e.name && e.name !== e.sym ? ` · ${e.name}` : ""}
          </small>
        )}
        {cd ? <span className={cd.soon ? "cal-cd soon" : "cal-cd"}>{cd.text}</span> : null}
      </span>
      {tap ? <span className="cal-go" aria-hidden="true">›</span> : null}
    </>
  );
  const cls = `cal-row${past ? " past" : ""}${e.imp === "high" ? " hi" : ""}`;
  return tap ? (
    <button type="button" className={cls} onClick={() => { haptic("select"); onOpen(e); }}>{body}</button>
  ) : <div className={cls}>{body}</div>;
}

export function CalendarScreen() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const setOptSym = useApp((s) => s.setOptSym);
  const [kind, setKind] = useState<Kind>("all");
  const [onlyHigh, setOnlyHigh] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [reply, setReply] = useState<CalReply | null>(() => peekCalendar());
  const [failed, setFailed] = useState(false);
  const now = useNow();

  useEffect(() => {
    void fetchCalendar().then((r) => {
      if (r?.ok) setReply(r);
      else setFailed(true);
    });
  }, []);

  /* Экран открыт долго — календарь подтягивается сам: раз в пять минут и
     сразу, когда приложение снова на виду. */
  useEffect(() => {
    const pull = () => {
      if (document.visibilityState !== "visible") return;
      void fetchCalendar().then((r) => r?.ok && setReply(r));
    };
    const id = window.setInterval(pull, 5 * 60_000);
    document.addEventListener("visibilitychange", pull);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", pull);
    };
  }, []);

  const nowSec = Math.floor(now);
  const today = dayKey(nowSec);
  const items = useMemo(() => (reply?.items ?? []).filter((e) =>
    (kind === "all" || (kind === "macro" ? e.k === "macro" || e.k === "fomc" : kind === "opt" ? e.k === "opt" || e.k === "cme" : e.k === kind))
    && (!onlyHigh || e.imp === "high")), [reply, kind, onlyHigh]);
  /* Разлок назначен на день, не на час: он «прошёл», только когда кончился день. */
  const isPast = (e: CalEv) => (allDay(e) ? e.t + 86400 : e.t + 3600) < nowSec;
  const past = items.filter(isPast);
  const next = items.filter((e) => !isPast(e));
  /* Ближайшее важное — то, что назначено на час: листинг — уже новость, а у
     события дня нет точного отсчёта. */
  const hero = next.find((e) => e.imp === "high" && !allDay(e) && e.k !== "list" && e.t > nowSec)
    ?? next.find((e) => e.t > nowSec && e.k !== "list");

  const groups = useMemo(() => {
    const out: [number, CalEv[]][] = [];
    for (const e of [...(showPast ? past : []), ...next]) {
      const k = dayKey(e.t);
      const g = out[out.length - 1];
      if (g && g[0] === k) g[1].push(e);
      else out.push([k, [e]]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, showPast, nowSec]);

  const onOpen = (e: CalEv) => {
    if (e.k === "opt" && e.sym) {
      setOptSym(e.sym);
      open("options");
    } else if (e.k === "unl") open("unlocks");
    else if (e.k === "list" && e.url) openExternal(e.url);
  };

  const kinds: [Kind, DictKey][] = [
    ["all", "cal_f_all"], ["macro", "cal_f_macro"], ["earn", "cal_f_earn"], ["list", "cal_f_list"],
    ["opt", "cal_f_opt"], ["unl", "cal_f_unl"],
  ];

  return (
    <Frame title={t(lang, "cal_title")}>
      <p className="lq-lead">{t(lang, "cal_sub")}</p>
      <p className="cal-tz">🕐 {t(lang, "cal_tz", { z: zoneLabel() })}</p>
      <div className="op-exps" role="tablist">
        {kinds.map(([k, key]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "chip on" : "chip"}
            onClick={() => { if (kind !== k) { haptic("select"); setKind(k); } }}>
            {t(lang, key)}
          </button>
        ))}
        <button type="button" aria-pressed={onlyHigh} className={onlyHigh ? "chip on" : "chip"}
          onClick={() => { haptic("select"); setOnlyHigh(!onlyHigh); }}>
          {t(lang, "cal_only_high")}
        </button>
      </div>

      {!reply ? (
        failed ? <Empty text={t(lang, "cal_err")} /> : <Card><Skeleton rows={8} /></Card>
      ) : (
        <>
          {hero ? (
            <Card>
              <div className="cal-hero">
                <small>{t(lang, "cal_next")}</small>
                <b>{title(lang, hero)}</b>
                <span>{dayTitle(lang, dayKey(hero.t), today)}{!allDay(hero) ? `, ${hm(hero.t)}` : ""}</span>
                <em>{countdown(lang, Math.max(60, hero.t - nowSec))}</em>
              </div>
            </Card>
          ) : null}

          {past.length ? (
            <button type="button" className="cal-past" onClick={() => { haptic("select"); setShowPast(!showPast); }}>
              {t(lang, showPast ? "cal_hide_past" : "cal_show_past", { n: past.length })}
            </button>
          ) : null}

          {groups.length ? groups.map(([k, list]) => (
            <section key={k} className="cal-day">
              <h3 className={k === today ? "today" : k < today ? "past" : ""}>{dayTitle(lang, k, today)}</h3>
              <Card>
                {list.map((e, i) => <Row key={`${e.k}-${e.t}-${e.sym ?? e.title}-${i}`} lang={lang} e={e} past={isPast(e)}
                  nowSec={nowSec} today={today} onOpen={onOpen} />)}
              </Card>
            </section>
          )) : <Empty text={t(lang, "cal_none")} />}

          <div className="op-legend cal-legend">
            <span><i className="cal-k macro" />{t(lang, "cal_f_macro")}</span>
            <span><i className="cal-k opt" />{t(lang, "cal_f_opt")}</span>
            <span><i className="cal-k unl" />{t(lang, "cal_f_unl")}</span>
            <span><i className="cal-k earn" />{t(lang, "cal_f_earn")}</span>
            <span><i className="cal-k list" />{t(lang, "cal_f_list")}</span>
            <span><span className="cal-imp high" aria-hidden="true"><i /><i /><i /></span>{t(lang, "cal_imp_high")}</span>
          </div>
          <p className="lq-src">{t(lang, "cal_src")}</p>
        </>
      )}
    </Frame>
  );
}
