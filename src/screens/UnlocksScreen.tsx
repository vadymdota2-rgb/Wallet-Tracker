/**
 * Разлоки монет: когда на рынок выйдут монеты команды, инвесторов и фондов.
 *
 * Только будущее, ближайшие сверху, по дням. Главное число строки — сумма в
 * долларах, рядом — доля от монет в обороте: она и показывает давление на
 * цену, цвет полоски слева — тоже она. Тап по строке раскрывает, кому идут
 * монеты, откуда условия и кнопку графика этой монеты.
 *
 * Всё считает наш сервер (UNLOCK_BOOK в whale_api.py): расписания — по
 * документации проектов, оборот — от опорного значения плюс наши же
 * разлоки, цена — Hyperliquid. Чужих календарей и справочников тут нет.
 * Оценочные объёмы помечены «≈» и словом «оценка».
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { day, pct, px, qtyWord as qty, untilDay, usdWord as usd } from "../lib/format";
import { haptic, openExternal } from "../lib/telegram";
import { fetchUnlocks, peekUnlocks, savedUnlocks } from "../lib/api";
import type { UnlockEvent, UnlockNoEmit, UnlockSkip, UnlockStake, UnlockWho, UnlocksReply } from "../lib/types";
import { CoinIcon } from "../components/CoinIcon";
import { Empty, Segmented } from "../components/ui";
import { useNow } from "../lib/tick";

/** Что показывать: всё, только разлоки или только эмиссию. */
type Kind = "all" | "unlock" | "emit";

/** Порог «заметного» давления, % оборота — он же фильтр «Крупные». */
const BIG = 1;
const HIGH = 5;
const SKIP_KEY: Record<UnlockSkip, DictKey> = {
  done: "unl_r_done",
  burn: "unl_r_burn",
  undated: "unl_r_undated",
  nodata: "unl_r_nodata",
  pegged: "unl_r_pegged",
};
const NOEMIT_KEY: Record<UnlockNoEmit, DictKey> = {
  fixed: "unl_ne_fixed",
  notyet: "unl_ne_notyet",
};

/** Строк в первой порции — пара экранов телефона. */
const STEP = 60;

const WHO_KEY: Record<UnlockWho, DictKey> = {
  team: "unl_who_team",
  investors: "unl_who_investors",
  treasury: "unl_who_treasury",
  community: "unl_who_community",
  foundation: "unl_who_foundation",
  mixed: "unl_who_mixed",
  emission: "unl_who_emission",
};

function level(e: UnlockEvent): "hi" | "mid" | "lo" {
  const p = e.pct ?? 0;
  return p >= HIGH ? "hi" : p >= BIG ? "mid" : "lo";
}

/**
 * Часть дня монеты: только разлок, только эмиссия или всё вместе.
 *
 * В один день у монеты бывает и то и другое (у EIGEN 1-го числа выходят
 * доли инвесторов и команды и тут же новые монеты стейкинга). Когда выбран
 * один вид, сумма, доллары и доля оборота пересчитываются по нему — иначе
 * «разлок» показывал бы и эмиссию внутри себя.
 */
function part(e: UnlockEvent, kind: Kind): UnlockEvent | null {
  if (kind === "all") return e;
  const who: UnlockEvent["who"] = {};
  let tokens = 0;
  for (const [k, v] of Object.entries(e.who) as [UnlockWho, number][]) {
    if ((k === "emission") !== (kind === "emit")) continue;
    who[k] = v;
    tokens += v;
  }
  if (tokens <= 0) return null;
  if (tokens === e.tokens) return e;
  const share = tokens / e.tokens;
  return {
    ...e,
    who,
    tokens,
    usd: e.usd !== null ? Math.round(e.usd * share) : null,
    pct: e.pct !== null ? Math.round(e.pct * share * 100) / 100 : null,
    kind: kind === "emit" ? "monthly" : e.kind,
  };
}

const hasEmission = (e: UnlockEvent) => (e.who.emission ?? 0) > 0;
const hasUnlock = (e: UnlockEvent) => Object.keys(e.who).some((k) => k !== "emission");

/** Поиск по тикеру и названию: «arb», «Arbitrum», «star». */
function matches(e: UnlockEvent, q: string): boolean {
  if (!q) return true;
  return e.sym.toLowerCase().includes(q) || e.name.toLowerCase().includes(q);
}

export function UnlocksScreen() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const setTvSym = useApp((s) => s.setTvSym);
  const nowSec = useNow();

  /* Сразу — из памяти этого запуска или из прошлого (сохранён на
     устройстве); свежий ответ заменит его, как только придёт. */
  const [reply, setReply] = useState<UnlocksReply | null>(() => peekUnlocks() ?? savedUnlocks());
  const items = reply?.items ?? null;
  const none = reply?.none ?? {};
  const noEmit = reply?.noEmit ?? {};
  const stake = reply?.stake ?? {};
  const supplyRef = reply?.supply ?? {};
  const vols = reply?.vol ?? {};
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetchUnlocks().then((r) => {
      if (!alive) return;
      if (r?.ok) setReply({ ...r, items: r.items ?? [] });
      else if (!items) setFailed(true);
    });
    return () => {
      alive = false;
    };
    // Один запрос при открытии: дальше хватает кэша на полчаса.
  }, []);

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [bigOnly, setBigOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  /* Проверенные монеты вне календаря, подходящие под поиск: про них экран
     говорит прямо — разлоков и эмиссии нет или данных нет, — а не молчит. */
  const statusHits = useMemo(() => {
    const u = q.toUpperCase().replace(/\s+/g, "");
    if (!u) return [] as [string, UnlockSkip][];
    const all = Object.entries(none) as [string, UnlockSkip][];
    const exact = all.filter(([s]) => s === u);
    const starts = all.filter(([s]) => s !== u && s.startsWith(u));
    return [...exact, ...starts].slice(0, 8);
  }, [q, none]);
  const [showChecked, setShowChecked] = useState(false);
  const days = useMemo(() => {
    const today = Math.floor(nowSec / 86400) * 86400;
    const out: { ts: number; list: UnlockEvent[] }[] = [];
    for (const raw of items ?? []) {
      // Сервер отдаёт только будущее, но экран может висеть открытым сутки.
      if (raw.ts < today || !matches(raw, q)) continue;
      const e = part(raw, kind);
      if (!e) continue;
      if (bigOnly && e.kind !== "cliff" && (e.pct ?? 0) < BIG) continue;
      const last = out[out.length - 1];
      if (last && last.ts === e.ts) last.list.push(e);
      else out.push({ ts: e.ts, list: [e] });
    }
    // Внутри дня — сначала то, что давит сильнее.
    for (const d of out) d.list.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || (b.usd ?? 0) - (a.usd ?? 0));
    return out;
  }, [items, q, kind, bigOnly, nowSec]);

  /* Рисуем порциями. Всех строк почти тысяча, и разом с иконками они
     рисовались на телефоне секунду-две — экран открывался пустым. Первая
     порция — пара экранов, дальше дорисовывается, когда прокрутка подходит
     к концу. Сменили поиск или вид — снова с первой порции. */
  const [limit, setLimit] = useState(STEP);
  useEffect(() => setLimit(STEP), [q, kind, bigOnly]);
  const shown = useMemo(() => {
    const out: typeof days = [];
    let n = 0;
    for (const d of days) {
      if (n >= limit) break;
      const list = d.list.slice(0, limit - n);
      n += list.length;
      out.push({ ts: d.ts, list });
    }
    return { days: out, more: n < days.reduce((a, d) => a + d.list.length, 0) };
  }, [days, limit]);
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tail.current;
    if (!el || !shown.more || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (ents) => {
        if (ents.some((x) => x.isIntersecting)) setLimit((l) => l + STEP * 2);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown.more, limit]);

  /* Сводка сверху — по всему календарю, без поиска и фильтра: сколько
     выходит за неделю и за месяц и какой разлок давит сильнее всех. */
  const sum = useMemo(() => {
    const today = Math.floor(nowSec / 86400) * 86400;
    /* Доллары окна — отдельно разлоки и эмиссия: одно без другого
       читалось как «разлоков на столько-то», хотя там была и эмиссия. */
    /* Эмиссия идёт каждый день, а в календаре сложена в одну строку на
       месяц. В окно берём её долю по дням: иначе в неделю, где есть 1-е
       число, попадал целый месяц эмиссии SOL и ETH, и неделя выглядела
       тяжелее месяца. */
    let emitMonth = 0;
    for (const e of items ?? []) {
      if (e.ts < today || e.ts >= today + 31 * 86400) continue;
      emitMonth += part(e, "emit")?.usd ?? 0;
    }
    const win = (days: number) => {
      let unl = 0;
      for (const e of items ?? []) {
        if (e.ts < today || e.ts >= today + days * 86400) continue;
        unl += part(e, "unlock")?.usd ?? 0;
      }
      const emit = (emitMonth * days) / 30.44;
      return { usd: unl + emit, unl, emit };
    };
    let top: UnlockEvent | null = null;
    for (const e of items ?? []) {
      if (e.ts < today || e.ts >= today + 30 * 86400) continue;
      if (!top || (e.pct ?? 0) > (top.pct ?? 0)) top = e;
    }
    return { w: win(7), m: win(30), top };
  }, [items, nowSec]);

  const chart = (sym: string) => {
    haptic("select");
    setTvSym(sym);
    open("chart", sym);
  };

  return (
    <Frame title={t(lang, "unl_title")} sub={t(lang, "unl_sub")}>
      <div className="unl-tools">
        <input
          className="find"
          type="search"
          value={query}
          placeholder={t(lang, "unl_search")}
          onChange={(e) => setQuery(e.target.value)}
          inputMode="search"
          aria-label={t(lang, "unl_search")}
        />
        <Segmented<Kind>
          wrap
          value={kind}
          onChange={setKind}
          options={[
            { id: "all", label: t(lang, "unl_all") },
            { id: "unlock", label: t(lang, "unl_type_unlock") },
            { id: "emit", label: t(lang, "unl_emit") },
          ]}
        />
        <button
          type="button"
          className={bigOnly ? "unl-big on" : "unl-big"}
          aria-pressed={bigOnly}
          onClick={() => {
            haptic("select");
            setBigOnly(!bigOnly);
          }}
        >
          <span className="unl-big-box" aria-hidden="true" />
          {t(lang, "unl_big")}
        </button>
      </div>

      {items?.length ? (
        <div className="unl-sum">
          <div className="unl-sum-t">
            <small>{t(lang, "unl_7d")}</small>
            <b>{usd(sum.w.usd)}</b>
            <small>{t(lang, "unl_split", { a: usd(sum.w.unl), b: usd(sum.w.emit) })}</small>
          </div>
          <div className="unl-sum-t">
            <small>{t(lang, "unl_30d")}</small>
            <b>{usd(sum.m.usd)}</b>
            <small>{t(lang, "unl_split", { a: usd(sum.m.unl), b: usd(sum.m.emit) })}</small>
          </div>
          {sum.top && sum.top.pct !== null ? (
            <button
              type="button"
              className={`unl-sum-top p-${level(sum.top)}`}
              onClick={() => {
                haptic("select");
                setQuery(sum.top!.sym);
              }}
            >
              <small>{t(lang, "unl_top")}</small>
              <span>
                <CoinIcon sym={sum.top.sym} size={18} />
                <b>{sum.top.sym}</b> · {day(sum.top.ts, nowSec)} ·{" "}
                <em>{t(lang, "unl_of_circ", { p: pct(sum.top.pct, 1, false) })}</em>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {statusHits.map(([sym, why]) => (
        <div key={sym} className={`unl-status s-${why}`}>
          <CoinIcon sym={sym} size={30} />
          <span className="unl-st">
            <b className="unl-st-sym">{sym}</b>
            <em>{t(lang, why === "undated" || why === "nodata" ? "unl_st_nodata_t" : "unl_st_none_t")}</em>
            <small>{t(lang, SKIP_KEY[why])}</small>
          </span>
        </div>
      ))}

      {items === null ? (
        failed ? <Empty text={t(lang, "generic_error_retry")} /> : <p className="note dim">{t(lang, "ui_loading")}</p>
      ) : days.length === 0 ? (
        statusHits.length ? null : (
          <Empty text={q ? t(lang, "unl_unknown", { q: query.trim().toUpperCase() }) : t(lang, "unl_none")} />
        )
      ) : (
        shown.days.map((d) => (
          <section key={d.ts} className="unl-day">
            <h3>
              <span>{day(d.ts, nowSec)}</span>
              <small>{untilDay(d.ts, nowSec)}</small>
            </h3>
            {d.list.map((e) => {
              const key = `${e.sym}:${e.ts}`;
              const expanded = openKey === key;
              return (
                <div key={key} className={`unl-row p-${level(e)}${expanded ? " open" : ""}`}>
                  <button
                    type="button"
                    className="unl-main"
                    aria-expanded={expanded}
                    onClick={() => {
                      haptic("light");
                      setOpenKey(expanded ? null : key);
                    }}
                  >
                    <CoinIcon sym={e.sym} size={30} />
                    <span className="unl-id">
                      <span className="unl-sym">
                        <b>{e.sym}</b>
                        {/* Что это: разлок (цвет команды и инвесторов) или
                            эмиссия (новые монеты сети); бывает и то и другое. */}
                        {hasUnlock(e) ? <i className="unl-tag u">{t(lang, "unl_tag_unlock")}</i> : null}
                        {hasEmission(e) ? <i className="unl-tag e">{t(lang, "unl_emit")}</i> : null}
                      </span>
                      <small>
                        {e.name}
                        {hasUnlock(e) ? ` · ${t(lang, e.kind === "cliff" ? "unl_cliff" : "unl_monthly")}` : ""}
                        {e.est ? <em className="unl-est"> · {t(lang, "unl_est")}</em> : null}
                      </small>
                    </span>
                    <span className="unl-amt">
                      <b>
                        {e.est ? "≈" : ""}
                        {e.usd !== null ? usd(e.usd) : qty(e.tokens)}
                      </b>
                      <small>
                        {e.pct !== null ? t(lang, "unl_of_circ", { p: pct(e.pct, 2, false) }) : qty(e.tokens)}
                      </small>
                    </span>
                  </button>
                  {expanded ? (
                    <CoinMore
                      e={e}
                      lang={lang}
                      nowSec={nowSec}
                      items={items ?? []}
                      stake={stake[e.sym]}
                      noEmit={noEmit[e.sym]}
                      ref0={supplyRef[e.sym]}
                      vol={vols[e.sym]}
                      onChart={() => chart(e.sym)}
                    />
                  ) : null}
                </div>
              );
            })}
          </section>
        ))
      )}
      {shown.more ? <div ref={tail} className="unl-tail" aria-hidden="true" /> : null}

      {/* Все проверенные монеты вне календаря — чтобы было видно, что их не
          забыли, а проверили. По группам причин; тап — поиск по монете. */}
      {!shown.more && !q && Object.keys(none).length ? (
        <section className="unl-checked">
          <button
            type="button"
            className="unl-checked-hd"
            aria-expanded={showChecked}
            onClick={() => {
              haptic("light");
              setShowChecked(!showChecked);
            }}
          >
            {t(lang, "unl_checked", { n: Object.keys(none).length })}
            <span className="chart-caret" aria-hidden="true" />
          </button>
          {showChecked
            ? (["done", "burn", "pegged", "undated", "nodata"] as UnlockSkip[]).map((why) => {
                const list = Object.keys(none)
                  .filter((s) => none[s] === why)
                  .sort();
                if (!list.length) return null;
                return (
                  <div key={why} className="unl-checked-g">
                    <p>{t(lang, SKIP_KEY[why])}</p>
                    <div className="chart-chips">
                      {list.map((s) => (
                        <button key={s} type="button" onClick={() => setQuery(s)}>
                          <CoinIcon sym={s} size={18} />
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })
            : null}
        </section>
      ) : null}

      <p className="note dim">{t(lang, "unl_note")}</p>
    </Frame>
  );
}

type Lang = ReturnType<typeof useApp.getState>["lang"];
type Who = Exclude<UnlockWho, "emission">;
type Slice = "free" | "staked" | Who | "nosched";

/* Цвет закреплён за группой, а не за местом в списке: у всех монет
   команда оранжевая, инвесторы малиновые. Порядок по кругу — порядок
   палитры, соседние цвета различимы и при дальтонизме (проверено
   валидатором на фоне карточки). Свободный оборот и запертое без графика —
   нейтральные: это не группы держателей. */
const RING: { key: Slice; color: string }[] = [
  { key: "free", color: "#5d6f8a" },
  { key: "staked", color: "#3987e5" },
  { key: "team", color: "#d95926" },
  { key: "community", color: "#199e70" },
  { key: "treasury", color: "#c98500" },
  { key: "investors", color: "#d55181" },
  { key: "foundation", color: "#9085e9" },
  { key: "mixed", color: "#e66767" },
  { key: "nosched", color: "#34455f" },
];
const YEAR = 365 * 86400;
const DETAIL_KEY = "wt-unl-detail";
const MONTH = 30.44 * 86400;

/** «в 2,7 раза»: одна цифра после запятой, без лишнего нуля. */
const times = (x: number) => pct(x, 1, false).replace("%", "").trim();

/** Раскрытая карточка монеты: вывод, круг выпуска, кривая оборота и
 *  цифры тремя группами — этот день, сейчас, впереди. У терминов «?»:
 *  объяснение одной фразой, без которого новичку цифры ничего не скажут. */
function CoinMore({
  e,
  lang,
  nowSec,
  items,
  stake,
  noEmit,
  ref0,
  vol,
  onChart,
}: {
  e: UnlockEvent;
  lang: Lang;
  nowSec: number;
  items: UnlockEvent[];
  stake: UnlockStake | null | undefined;
  noEmit: UnlockNoEmit | undefined;
  ref0: { t: number; m: number } | undefined;
  vol: number | undefined;
  onChart: () => void;
}) {
  /* Какое объяснение раскрыто: «место:термин» — один термин встречается и
     в выводе, и в строке, раскрываться он должен там, где нажали. */
  const [help, setHelp] = useState<string | null>(null);
  /* Коротко или подробно: новичку хватает вывода, круга и трёх цифр,
     остальное — по кнопке. Выбор помнится на устройстве для всех монет. */
  const [full, setFull] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DETAIL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleFull = () => {
    haptic("light");
    setFull((v) => {
      try {
        localStorage.setItem(DETAIL_KEY, v ? "0" : "1");
      } catch {
        // хранилище закрыто — выбор живёт до закрытия карточки
      }
      return !v;
    });
  };
  const sym = e.sym;
  const mine = useMemo(() => items.filter((x) => x.sym === sym).sort((x, y) => x.ts - y.ts), [items, sym]);
  const first = mine[0];
  const now = first?.circ ?? e.circ ?? 0;
  const locked: Partial<Record<Who, number>> = {};
  let emitYr = 0;
  let yearAll = 0;
  let yearFromDay = 0;
  let end = e.ts;
  for (const x of mine) {
    for (const [k, v] of Object.entries(x.who) as [UnlockWho, number][]) {
      if (k === "emission") {
        if (x.ts < nowSec + YEAR) emitYr += v;
      } else locked[k] = (locked[k] ?? 0) + v;
    }
    if (x.ts < nowSec + YEAR) yearAll += x.tokens;
    if (x.ts >= e.ts && x.ts < e.ts + YEAR) yearFromDay += x.tokens;
    end = Math.max(end, x.ts);
  }
  const last = mine[mine.length - 1];
  const openEmit = !noEmit && !!last && (last.who.emission ?? 0) > 0 && last.ts >= nowSec + 33 * MONTH;
  let lastUnlock = 0;
  for (const x of mine) if (hasUnlock(x)) lastUnlock = Math.max(lastUnlock, x.ts);
  const lockedSum = Object.values(locked).reduce((a, v) => a + (v ?? 0), 0);
  const nosched = ref0?.t ? Math.max(0, ref0.t - now - lockedSum) : 0;

  /* Вывод: сколько монет прибавится за год к нынешнему обороту. */
  const yearPct = now ? (yearAll / now) * 100 : 0;
  /* Второе мерило — ликвидность: ближайший разлок за 30 дней в днях всех
     торгов монетой. Сутки торгов и больше поднимают вывод до «высокого»,
     пять суток — до «очень высокого», даже если по обороту немного. */
  const days = (x: UnlockEvent) => (vol && x.usd ? x.usd / vol : 0);
  const nextUnlock = mine.find((x) => x.ts >= nowSec - 86400 && x.ts < nowSec + 30 * 86400 && hasUnlock(x));
  const nextDays = nextUnlock ? days(part(nextUnlock, "unlock") ?? nextUnlock) : 0;
  const bySupply = yearAll <= 0 || yearPct < 3 ? 1 : yearPct < 10 ? 2 : yearPct < 30 ? 3 : 4;
  const lvl = Math.max(bySupply, nextDays >= 5 ? 4 : nextDays >= 1 ? 3 : 1);
  const lvlKey: DictKey = lvl === 1 ? "unl_v_low" : lvl === 2 ? "unl_v_mid" : lvl === 3 ? "unl_v_high" : "unl_v_max";
  const verdict =
    yearAll <= 0
      ? t(lang, "unl_v_none")
      : yearPct >= 100
        ? t(lang, "unl_v_times", { x: times(1 + yearPct / 100) })
        : t(lang, "unl_v_add", { p: pct(yearPct, 1, false) });

  const price = e.price;
  const capAmount = ref0?.m || ref0?.t || (noEmit ? now + lockedSum : 0);

  const Row = ({ label, q, children }: { label: string; q?: DictKey; children: React.ReactNode }) => (
    <>
      <dt>
        {label}
        {q ? (
          <button
            type="button"
            className="unl-q"
            aria-expanded={help === `r:${q}`}
            aria-label="?"
            onClick={() => setHelp(help === `r:${q}` ? null : `r:${q}`)}
          >
            ?
          </button>
        ) : null}
      </dt>
      <dd>{children}</dd>
      {q && help === `r:${q}` ? <dd className="unl-help">{t(lang, q)}</dd> : null}
    </>
  );
  const dayKind: DictKey = hasUnlock(e) ? "unl_q_unlock" : "unl_q_emit";
  const dayNote = [
    e.usd !== null ? usd(e.usd) : "",
    e.pct !== null ? t(lang, "unl_of_circ", { p: pct(e.pct, 2, false) }) : "",
    days(e) >= 0.05 ? t(lang, "unl_vol_days", { d: times(days(e)) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="unl-more">
      <div className={`unl-verdict v${lvl}`}>
        <div className="unl-verdict-hd">
          <span className="unl-vbars" aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <i key={i} className={i <= lvl ? "on" : ""} />
            ))}
          </span>
          <span>
            {t(lang, "unl_v_title")}: <b>{t(lang, lvlKey)}</b>
          </span>
          <button
            type="button"
            className="unl-q"
            aria-expanded={help === "v:pressure"}
            aria-label="?"
            onClick={() => setHelp(help === "v:pressure" ? null : "v:pressure")}
          >
            ?
          </button>
        </div>
        <p>{verdict}</p>
        {nextUnlock && nextDays >= 0.1 ? (
          <p>
            {t(lang, "unl_v_liq", { date: day(nextUnlock.ts, nowSec), d: times(nextDays) })}
            <button
              type="button"
              className="unl-q"
              aria-expanded={help === "v:vol"}
              aria-label="?"
              onClick={() => setHelp(help === "v:vol" ? null : "v:vol")}
            >
              ?
            </button>
          </p>
        ) : null}
        {help === "v:vol" ? <p className="unl-help">{t(lang, "unl_q_vol")}</p> : null}
        {help === "v:pressure" ? <p className="unl-help">{t(lang, "unl_q_pressure")}</p> : null}
      </div>

      <SupplyRing lang={lang} sym={sym} now={now} locked={locked} nosched={nosched} stake={stake} known={!!ref0?.t || !!noEmit} />
      {!full ? (
        <dl className="unl-brief">
          <Row label={t(lang, "unl_tokens")} q={dayKind}>
            {qty(e.tokens)} {sym}
            <small className="unl-note">{dayNote}</small>
          </Row>
          {price !== null && now ? <Row label={t(lang, "unl_mcap")}>{usd(now * price)}</Row> : null}
          <Row label={t(lang, "unl_12m")}>
            {qty(yearFromDay)} {sym}
            {e.circ ? (
              <small className="unl-note">{t(lang, "unl_of_circ", { p: pct((yearFromDay / e.circ) * 100, 1, false) })}</small>
            ) : null}
          </Row>
        </dl>
      ) : null}
      <button type="button" className="unl-more-tg" aria-expanded={full} onClick={toggleFull}>
        {t(lang, full ? "unl_more_hide" : "unl_more_show")} <span aria-hidden="true">{full ? "▴" : "▾"}</span>
      </button>
      {full ? (
        <>
      <SupplyCurve lang={lang} sym={sym} now={now} mine={mine} nowSec={nowSec} />

      <h4 className="unl-sec">{t(lang, "unl_sec_day")}</h4>
      <dl>
        <Row label={t(lang, "unl_tokens")} q={dayKind}>
          {qty(e.tokens)} {sym}
          <small className="unl-note">{dayNote}</small>
        </Row>
        {(Object.entries(e.who) as [UnlockWho, number][])
          .sort((x, y) => y[1] - x[1])
          .map(([who, n]) => (
            <FragmentRow key={who} label={t(lang, WHO_KEY[who] ?? "unl_who_mixed")} value={`${qty(n)} ${sym}`} />
          ))}
      </dl>

      <h4 className="unl-sec">{t(lang, "unl_sec_now")}</h4>
      <dl>
        {price !== null ? <Row label={t(lang, "unl_price")}>{px(price)}</Row> : null}
        <Row label={t(lang, "unl_pie_now")} q="unl_q_circ">
          {qty(now)} {sym}
        </Row>
        {price !== null && now ? <Row label={t(lang, "unl_mcap")}>{usd(now * price)}</Row> : null}
        {vol ? (
          <Row label={t(lang, "unl_vol")} q="unl_q_vol">
            {usd(vol)}
          </Row>
        ) : null}
        {price !== null ? (
          <Row label={t(lang, "unl_fdv")} q="unl_q_fdv">
            {capAmount ? (
              <>
                {usd(capAmount * price)}
                {now && capAmount > now * 1.02 ? (
                  <small className="unl-note">{t(lang, "unl_fdv_x", { x: times(capAmount / now) })}</small>
                ) : null}
              </>
            ) : (
              t(lang, "unl_fdv_nocap")
            )}
          </Row>
        ) : null}
        <Row label={t(lang, "unl_staked")} q={stake ? "unl_q_stake" : undefined}>
          {stake === undefined
            ? t(lang, "unl_stake_unknown")
            : stake === null
              ? t(lang, "unl_stake_none")
              : `${qty(stake.n)} ${sym}${
                  stake.p !== null
                    ? ` · ${t(lang, stake.of === "supply" ? "unl_of_supply" : "unl_of_circ", { p: pct(stake.p, 1, false) })}`
                    : ""
                }`}
          {stake && stake.of === "supply" ? <small className="unl-note">{t(lang, "unl_stake_supply_note")}</small> : null}
          {stake ? (
            <small className="unl-note">{t(lang, "unl_asof", { d: day(Date.parse(stake.at) / 1000, nowSec) })}</small>
          ) : null}
        </Row>
        {stake ? (
          <Row label={t(lang, "unl_apy")}>
            {stake.y === undefined ? t(lang, "unl_stake_unknown") : t(lang, "unl_apy_val", { p: pct(stake.y, 2, false) })}
            {stake.y !== undefined && noEmit ? <small className="unl-note">{t(lang, "unl_apy_nodil")}</small> : null}
            {stake.y !== undefined && !noEmit && emitYr > 0 && now ? (
              <small className="unl-note">
                {t(lang, "unl_apy_net", {
                  e: pct((emitYr / now) * 100, 1, false),
                  r: pct(stake.y - (emitYr / now) * 100, 1, true),
                })}
              </small>
            ) : null}
          </Row>
        ) : null}
      </dl>

      <h4 className="unl-sec">{t(lang, "unl_sec_ahead")}</h4>
      <dl>
        <Row label={t(lang, "unl_12m")}>
          {qty(yearFromDay)} {sym}
          {e.circ ? (
            <small className="unl-note">{t(lang, "unl_of_circ", { p: pct((yearFromDay / e.circ) * 100, 1, false) })}</small>
          ) : null}
        </Row>
        <Row label={t(lang, "unl_end")}>
          {/* Бессрочная эмиссия расписана на три года вперёд — её «последний»
              день лишь край горизонта, а не конец выпуска. */}
          {openEmit ? t(lang, "unl_end_open") : day(end, nowSec)}
          {openEmit && lastUnlock ? (
            <small className="unl-note">
              {t(lang, "unl_type_unlock")}: {day(lastUnlock, nowSec)}
            </small>
          ) : null}
        </Row>
        <Row label={t(lang, "unl_emit")} q="unl_q_emit">
          {noEmit ? (
            t(lang, NOEMIT_KEY[noEmit])
          ) : emitYr > 0 && now ? (
            <>
              {t(lang, "unl_apy_val", { p: `+${pct((emitYr / now) * 100, 1, false)}` })}
              <small className="unl-note">
                {qty(emitYr)} {sym}
              </small>
            </>
          ) : (
            t(lang, "unl_stake_unknown")
          )}
        </Row>
      </dl>

        </>
      ) : null}

      <div className="unl-act">
        <button type="button" className="unl-btn" onClick={onChart}>
          {t(lang, "unl_chart")}
        </button>
        <button
          type="button"
          className="unl-btn ghost"
          onClick={() => {
            haptic("light");
            openExternal(e.src);
          }}
        >
          {t(lang, "unl_src")} ↗
        </button>
      </div>
    </div>
  );
}

/** Круг выпуска: что на рынке сейчас (свободно и в стейкинге), что ещё
 *  выйдет по графику по группам и что заперто без графика. */
function SupplyRing({
  lang,
  sym,
  now,
  locked,
  nosched,
  stake,
  known,
}: {
  lang: Lang;
  sym: string;
  now: number;
  locked: Partial<Record<Who, number>>;
  nosched: number;
  stake: UnlockStake | null | undefined;
  known: boolean;
}) {
  if (!now) return null;
  /* Застейканное — часть оборота, если считано от оборота; доля «от
     выпуска» включает и запертое, его в круг не вписать. */
  const staked = stake && stake.of !== "supply" && stake.n < now ? stake.n : 0;
  const parts = RING.map(({ key, color }) => ({
    key,
    color,
    n:
      key === "free" ? now - staked : key === "staked" ? staked : key === "nosched" ? nosched : (locked[key] ?? 0),
  })).filter((x) => x.n > 0);
  const total = parts.reduce((a, x) => a + x.n, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  const GAP = parts.length > 1 ? 2 : 0;
  let at = 0;
  const label = (k: Slice) =>
    t(
      lang,
      k === "free" ? "unl_pie_free" : k === "staked" ? "unl_staked" : k === "nosched" ? "unl_pie_nosched" : WHO_KEY[k],
    );
  const row = (x: (typeof parts)[number]) => (
    <li key={x.key}>
      <i style={{ background: x.color }} />
      <span>{label(x.key)}</span>
      <b>{pct((x.n / total) * 100, 1, false)}</b>
      <small>{qty(x.n)}</small>
    </li>
  );
  const nowParts = parts.filter((x) => x.key === "free" || x.key === "staked");
  const laterParts = parts.filter((x) => x.key !== "free" && x.key !== "staked");
  return (
    <div className="unl-ring">
      <div className="unl-ring-row">
        <svg viewBox="0 0 112 112" width="112" height="112" role="img" aria-label={`${sym}: ${qty(total)}`}>
          <circle cx="56" cy="56" r={R} fill="none" stroke="var(--line)" strokeWidth="14" />
          {parts.map((x) => {
            const len = (x.n / total) * C;
            const seg = (
              <circle
                key={x.key}
                cx="56"
                cy="56"
                r={R}
                fill="none"
                stroke={x.color}
                strokeWidth="14"
                strokeDasharray={`${Math.max(len - GAP, 0.8)} ${C}`}
                strokeDashoffset={-at}
                transform="rotate(-90 56 56)"
              >
                <title>{`${label(x.key)}: ${qty(x.n)} ${sym} · ${pct((x.n / total) * 100, 1, false)}`}</title>
              </circle>
            );
            at += len;
            return seg;
          })}
          <text x="56" y="54" textAnchor="middle" className="unl-ring-big">
            {qty(total)}
          </text>
          <text x="56" y="69" textAnchor="middle" className="unl-ring-small">
            {t(lang, "unl_pie_total")}
          </text>
        </svg>
        <div className="unl-ring-legend">
          <h4>{t(lang, "unl_pie_now")}</h4>
          <ul>{nowParts.map(row)}</ul>
          {laterParts.length ? (
            <>
              <h4>{t(lang, "unl_pie_later")}</h4>
              <ul>{laterParts.map(row)}</ul>
            </>
          ) : null}
        </div>
      </div>
      {!known && laterParts.length ? <p className="unl-ring-note">{t(lang, "unl_pie_note")}</p> : null}
    </div>
  );
}

/** Кривая оборота на три года: сколько монет будет на рынке по месяцам,
 *  с учётом разлоков и эмиссии. Ступеньки — крупные разлоки (от 5% оборота),
 *  они отмечены точками. Палец по графику — дата и оборот в этот месяц. */
function SupplyCurve({
  lang,
  sym,
  now,
  mine,
  nowSec,
}: {
  lang: Lang;
  sym: string;
  now: number;
  mine: UnlockEvent[];
  nowSec: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const N = 36;
  const pts = useMemo(() => {
    const out: number[] = [];
    for (let m = 0; m <= N; m++) {
      const until = nowSec + m * MONTH;
      let acc = now;
      for (const ev of mine) if (ev.ts <= until) acc += ev.tokens;
      out.push(acc);
    }
    return out;
  }, [mine, now, nowSec]);
  const at = (m: number) => pts[m] ?? now;
  if (!now || at(N) <= now * 1.001) return null;
  const W = 320;
  const H = 120;
  const top = 14;
  const bottom = 18;
  const max = at(N) * 1.04;
  const x = (m: number) => (m / N) * W;
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom);
  const line = pts.map((v, m) => `${m ? "L" : "M"}${x(m).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${W},${H - bottom}L0,${H - bottom}Z`;
  const big = mine.filter((ev) => ev.ts <= nowSec + N * MONTH && ev.kind === "cliff" && (ev.pct ?? 0) >= 5);
  const yearTicks = [12, 24, 36];
  const dateAt = (m: number) => new Date((nowSec + m * MONTH) * 1000);
  const yearOf = (m: number) => dateAt(m).getUTCFullYear();
  const pick = (ev: React.PointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const m = Math.round(((ev.clientX - r.left) / r.width) * N);
    setHover(Math.max(0, Math.min(N, m)));
  };
  const h = hover ?? N;
  const hv = at(h);
  return (
    <div className="unl-curve">
      <div className="unl-curve-hd">
        <span>{t(lang, "unl_curve_title")}</span>
        <b>
          {day(Math.round(dateAt(h).getTime() / 1000), nowSec)}: {qty(hv)} {sym}
          <em> {pct(((hv - now) / now) * 100, 1, true)}</em>
        </b>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`${t(lang, "unl_curve_title")}: ${qty(now)} → ${qty(at(N))} ${sym}`}
        onPointerDown={pick}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`uc-${sym}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3987e5" stopOpacity="0.35" />
            <stop offset="1" stopColor="#3987e5" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="0" x2={W} y1={y(now)} y2={y(now)} className="unl-curve-base" />
        {yearTicks.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={top} y2={H - bottom} className="unl-curve-grid" />
            <text x={m === N ? x(m) - 2 : x(m)} y={H - 4} textAnchor={m === N ? "end" : "middle"} className="unl-curve-tick">
              {yearOf(m)}
            </text>
          </g>
        ))}
        <path d={area} fill={`url(#uc-${sym})`} />
        <path d={line} fill="none" stroke="#3987e5" strokeWidth="2" strokeLinejoin="round" />
        {big.map((ev) => {
          const m = Math.min(N, Math.max(0, (ev.ts - nowSec) / MONTH));
          const v = at(Math.min(N, Math.ceil(m)));
          return <circle key={ev.ts} cx={x(m)} cy={y(v)} r="4" className="unl-curve-dot" />;
        })}
        {hover !== null ? <line x1={x(h)} x2={x(h)} y1={top} y2={H - bottom} className="unl-curve-cross" /> : null}
      </svg>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
