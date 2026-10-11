/**
 * Поиск монеты: строка ввода и полный список — все бессрочные фьючерсы к USDT
 * на Binance, OKX и Gate, по обороту за сутки. Общий для карты ликвидаций,
 * ликвидаций и истории интереса: популярные монеты у каждого экрана — свои
 * кнопки, а любая другая находится здесь.
 *
 * Монеты нет в списке (например, она торгуется только на Hyperliquid) —
 * кнопка «Попробовать …» отправляет набранное как есть: сервер ищет её по
 * всем своим биржам.
 */
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n/t";
import { usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchLiqCoins, peekLiqCoins } from "../lib/api";
import type { LiqCoin } from "../lib/types";
import { CoinIcon } from "./CoinIcon";

type Lang = Parameters<typeof t>[0];

/** Сколько строк списка рисовать за раз: значки грузятся картинками. */
const PAGE = 60;

export function useLiqCoins(): LiqCoin[] {
  const [list, setList] = useState<LiqCoin[]>(() => peekLiqCoins()?.coins ?? []);
  useEffect(() => {
    let alive = true;
    void fetchLiqCoins().then((r) => {
      if (alive && r?.ok && r.coins.length) setList(r.coins);
    });
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

export function CoinFind({ lang, sym, onPick, list }: {
  lang: Lang;
  sym: string;
  onPick: (s: string) => void;
  list: LiqCoin[];
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);

  const q = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const found = useMemo(() => {
    if (!q) return list;
    const head = list.filter((c) => c.s.startsWith(q));
    const rest = list.filter((c) => !c.s.startsWith(q) && c.s.includes(q));
    return [...head, ...rest];
  }, [list, q]);
  const showList = open || q.length > 0;

  const pick = (s: string) => {
    haptic("select");
    onPick(s);
    setQuery("");
    setOpen(false);
    setShown(PAGE);
  };

  return (
    <>
      <form
        className="lq-find"
        onSubmit={(e) => {
          e.preventDefault();
          const first = found[0];
          if (first) pick(first.s);
          else if (q) pick(q);
        }}
      >
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
          placeholder={t(lang, "lq_search")}
          aria-label={t(lang, "lq_search")}
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          enterKeyHint="search"
        />
        <button
          type="button"
          className={open ? "on" : ""}
          aria-expanded={showList}
          onClick={() => { haptic("select"); setOpen(!showList); setQuery(""); setShown(PAGE); }}
        >
          {showList ? t(lang, "lq_hide_all") : t(lang, "lq_all", { n: list.length || "…" })}
        </button>
      </form>
      {showList ? (
        <div className="lq-list" role="listbox">
          {found.length ? (
            <>
              {found.slice(0, shown).map((c, i) => (
                <button key={c.s} type="button" role="option" aria-selected={c.s === sym}
                  className={c.s === sym ? "lq-li on" : "lq-li"} onClick={() => pick(c.s)}>
                  <span className="lq-li-n">{list.indexOf(c) + 1 || i + 1}</span>
                  <CoinIcon sym={c.s} size={24} />
                  <b>{c.s}</b>
                  <small>{c.ex.join(" · ")}</small>
                  <em>{usd(c.v)}</em>
                </button>
              ))}
              {found.length > shown ? (
                <button type="button" className="lq-more" onClick={() => setShown(shown + PAGE)}>
                  {t(lang, "lq_more", { n: found.length - shown })}
                </button>
              ) : null}
            </>
          ) : (
            <p className="lq-none">
              {t(lang, "lq_nothing")}{" "}
              {q ? <button type="button" onClick={() => pick(q)}>{t(lang, "lq_try", { s: q })}</button> : null}
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}
