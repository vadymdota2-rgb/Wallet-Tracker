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
import { useEffect, useMemo, useRef, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { day, pct, px, qty, untilDay, usd } from "../lib/format";
import { haptic, openExternal } from "../lib/telegram";
import { fetchUnlocks, peekUnlocks, savedUnlocks } from "../lib/api";
import type { UnlockEvent, UnlockNoEmit, UnlockSkip, UnlockWho, UnlocksReply } from "../lib/types";
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

  /* По монете целиком — для раскрытой строки: сколько выйдет за год от
     этого дня и докуда тянется её график. */
  const coinAhead = (e: UnlockEvent) => {
    let year = 0;
    let end = e.ts;
    for (const x of items ?? []) {
      if (x.sym !== e.sym || x.ts < e.ts) continue;
      if (x.ts < e.ts + 365 * 86400) year += x.tokens;
      end = Math.max(end, x.ts);
    }
    return { year, end };
  };

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
            <em>{t(lang, why === "done" || why === "burn" ? "unl_st_none_t" : "unl_st_nodata_t")}</em>
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
                    <div className="unl-more">
                      <dl>
                        <dt>{t(lang, "unl_tokens")}</dt>
                        <dd>
                          {qty(e.tokens)} {e.sym}
                        </dd>
                        {e.price !== null ? (
                          <>
                            <dt>{t(lang, "unl_price")}</dt>
                            <dd>{px(e.price)}</dd>
                          </>
                        ) : null}
                        {e.circ ? (
                          <>
                            <dt>{t(lang, "unl_circ")}</dt>
                            <dd>
                              {qty(e.circ)} {e.sym}
                            </dd>
                          </>
                        ) : null}
                        {(() => {
                          const a = coinAhead(e);
                          return (
                            <>
                              <dt>{t(lang, "unl_12m")}</dt>
                              <dd>
                                {qty(a.year)} {e.sym}
                                {e.circ ? ` · ${pct((a.year / e.circ) * 100, 1, false)}` : ""}
                              </dd>
                              <dt>{t(lang, "unl_end")}</dt>
                              <dd>{day(a.end, nowSec)}</dd>
                            </>
                          );
                        })()}
                        {(() => {
                          const why = noEmit[e.sym];
                          return why ? (
                            <>
                              <dt>{t(lang, "unl_emit")}</dt>
                              <dd>{t(lang, NOEMIT_KEY[why])}</dd>
                            </>
                          ) : null;
                        })()}
                        {(Object.entries(e.who) as [UnlockWho, number][])
                          .sort((a, b) => b[1] - a[1])
                          .map(([who, n]) => (
                            <FragmentRow key={who} label={t(lang, WHO_KEY[who] ?? "unl_who_mixed")} value={`${qty(n)} ${e.sym}`} />
                          ))}
                      </dl>
                      <div className="unl-act">
                        <button type="button" className="unl-btn" onClick={() => chart(e.sym)}>
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
            ? (["done", "burn", "undated", "nodata"] as UnlockSkip[]).map((why) => {
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

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
