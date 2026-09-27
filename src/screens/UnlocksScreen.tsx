/**
 * Разлоки монет: когда на рынок выйдут монеты команды, инвесторов и фондов.
 *
 * Только будущее, ближайшие сверху, по дням. Главное число строки — сумма в
 * долларах, рядом — доля от монет в обороте: она и показывает давление на
 * цену, цвет полоски слева — тоже она. Тап по строке раскрывает, кому идут
 * монеты, откуда условия и кнопку графика этой монеты.
 *
 * Расписания ведёт сервер по документации проектов (UNLOCK_BOOK в
 * whale_api.py) — платные сервисы с календарями тут не участвуют.
 */
import { useEffect, useMemo, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { day, pct, px, qty, untilDay, usd } from "../lib/format";
import { haptic, openExternal } from "../lib/telegram";
import { fetchUnlocks, peekUnlocks } from "../lib/api";
import type { UnlockEvent, UnlockWho } from "../lib/types";
import { CoinIcon } from "../components/CoinIcon";
import { Empty, Segmented } from "../components/ui";
import { useNow } from "../lib/tick";

type Filter = "all" | "big";

/** Порог «заметного» давления, % оборота — он же фильтр «Крупные». */
const BIG = 1;
const HIGH = 5;

const WHO_KEY: Record<UnlockWho, DictKey> = {
  team: "unl_who_team",
  investors: "unl_who_investors",
  treasury: "unl_who_treasury",
  community: "unl_who_community",
  foundation: "unl_who_foundation",
  mixed: "unl_who_mixed",
};

function level(e: UnlockEvent): "hi" | "mid" | "lo" {
  const p = e.pct ?? 0;
  return p >= HIGH ? "hi" : p >= BIG ? "mid" : "lo";
}

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

  const [items, setItems] = useState<UnlockEvent[] | null>(() => peekUnlocks()?.items ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetchUnlocks().then((r) => {
      if (!alive) return;
      if (r?.ok) setItems(r.items ?? []);
      else if (!items) setFailed(true);
    });
    return () => {
      alive = false;
    };
    // Один запрос при открытии: дальше хватает кэша на полчаса.
  }, []);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const days = useMemo(() => {
    const today = Math.floor(nowSec / 86400) * 86400;
    const out: { ts: number; list: UnlockEvent[] }[] = [];
    for (const e of items ?? []) {
      // Сервер отдаёт только будущее, но экран может висеть открытым сутки.
      if (e.ts < today || !matches(e, q)) continue;
      if (filter === "big" && e.kind !== "cliff" && (e.pct ?? 0) < BIG) continue;
      const last = out[out.length - 1];
      if (last && last.ts === e.ts) last.list.push(e);
      else out.push({ ts: e.ts, list: [e] });
    }
    // Внутри дня — сначала то, что давит сильнее.
    for (const d of out) d.list.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || (b.usd ?? 0) - (a.usd ?? 0));
    return out;
  }, [items, q, filter, nowSec]);

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
        <Segmented<Filter>
          wrap
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: t(lang, "unl_all") },
            { id: "big", label: t(lang, "unl_big") },
          ]}
        />
      </div>

      {items === null ? (
        failed ? <Empty text={t(lang, "generic_error_retry")} /> : <p className="note dim">{t(lang, "ui_loading")}</p>
      ) : days.length === 0 ? (
        <Empty text={t(lang, q ? "unl_empty" : "unl_none")} />
      ) : (
        days.map((d) => (
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
                      <b>{e.sym}</b>
                      <small>
                        {e.name} · {t(lang, e.kind === "cliff" ? "unl_cliff" : "unl_monthly")}
                      </small>
                    </span>
                    <span className="unl-amt">
                      <b>{e.usd !== null ? usd(e.usd) : qty(e.tokens)}</b>
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
