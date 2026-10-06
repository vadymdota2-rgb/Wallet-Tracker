/**
 * Потоки бирж BSC — своя плитка рядом с NetFlow DEX. Данные свои (бот: bsc_exchanges.cpp, таблица
 * bsc_ex_flow; API: /api/bsc/exflow), с логикой DEX не смешиваются: там
 * свопы кошельков базы, здесь — переводы на биржи и с бирж всей сети.
 *
 * Вид — как у NetFlow DEX: сводка за окно, ниже каждая монета отдельно —
 * сколько вывели с бирж, сколько завели, итог и своя линия. Конкретные
 * кошельки здесь не показываются.
 */
import { useEffect, useState } from "react";
import { useApp } from "../store/app";
import type { FlowWin } from "../store/app";
import { t } from "../i18n/t";
import { num, signed, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { copyText } from "../lib/copy";
import { toast } from "../components/Toast";
import { fetchBscExFlow, peekBscExFlow } from "../lib/api";
import { BuySellBar, FlowSpark, TrendChart } from "../components/Chart";
import { CoinIcon } from "../components/CoinIcon";
import { CopyGlyph, Empty, Skeleton } from "../components/ui";
import type { BscExFlowReply, BscExFlowWin } from "../lib/types";

const PAGE = 40;
const EX_OPEN_KEY = "wt-bscx-ex-open";
const iso = (x: string) => `⁦${x}⁩`;

const WIN_KEY: Record<FlowWin, Parameters<typeof t>[1]> = {
  "1": "big_win_1h",
  "6": "win_6h",
  "24": "big_win_24h",
  "168": "big_win_7d",
  "720": "big_win_30d",
};

function stamp(lang: string, ts: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      .format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
}

function useExFlow(): BscExFlowReply | null | undefined {
  // undefined — ещё грузится, null — сервер не ответил.
  const [data, setData] = useState<BscExFlowReply | null | undefined>(() => peekBscExFlow() ?? undefined);
  useEffect(() => {
    let alive = true;
    // Сбой сети не стирает показанное: остаётся последний годный ответ.
    void fetchBscExFlow().then((r) => {
      if (alive) setData((prev) => (r?.ok ? r : prev ?? null));
    });
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

/** Сводка за окно: куда идут деньги бирж в целом — как тренд NetFlow. */
function Head({ w, win, data }: { w: BscExFlowWin; win: FlowWin; data: BscExFlowReply }) {
  const lang = useApp((s) => s.lang);
  const [exOpen, setExOpenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(EX_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setExOpen = (v: boolean) => {
    setExOpenState(v);
    try {
      localStorage.setItem(EX_OPEN_KEY, v ? "1" : "0");
    } catch {
      // хранилище закрыто — просто не запомним
    }
  };
  return (
    <>
      <div className="trend">
        <p className="trend-ttl">
          <span>{t(lang, "ex_flows")} · {t(lang, WIN_KEY[win])}</span>
          <span>{num(w.coins.length)} {t(lang, "flow_coins")}</span>
        </p>
        <p className="trend-top">
          <b className={w.net >= 0 ? "up" : "dn"}>{iso(signed(w.net))}</b>
          <small>
            <span className="up">{usd(w.out)}</span>
            {" · "}
            <span className="dn">{usd(w.in)}</span>
          </small>
        </p>
        <TrendChart values={w.tr ?? []} />
        {/* Ширина: итог может держаться на одном USDT, пока остальные монеты
            заводят на биржи. Счёт монет это показывает. */}
        <BuySellBar buy={w.up ?? 0} sell={w.dn ?? 0} />
        <p className="trend-br">
          <span className="up">{num(w.up ?? 0)} {t(lang, "bscx_coins_out")}</span>
          <span className="dn">{num(w.dn ?? 0)} {t(lang, "bscx_coins_in")}</span>
        </p>
      </div>
      {w.ex.length ? (
        <>
          <button
            type="button"
            className="btc-ex-tg"
            aria-expanded={exOpen}
            onClick={() => {
              haptic("select");
              setExOpen(!exOpen);
            }}
          >
            <span>{t(lang, "btc_ex_list", { n: num(w.ex.length) })}</span>
            <i className={exOpen ? "on" : undefined} aria-hidden="true">▾</i>
          </button>
          {exOpen ? (
            <div className="btc-ex">
              {w.ex.map((e) => {
                const net = e.out - e.in;
                return (
                  <div key={e.ex} className="btc-ex-row bscx-row">
                    <b>{e.ex}</b>
                    <span className="up">↑ {iso(usd(e.out))}</span>
                    <span className="dn">↓ {iso(usd(e.in))}</span>
                    <span className={net >= 0 ? "up" : "dn"}>{iso(signed(net))}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
      {!w.full && data.since ? (
        <p className="note dim btc-part">{t(lang, "btc_partial", { d: stamp(lang, data.since) })}</p>
      ) : null}
    </>
  );
}

/** Сводка — над переключателями окна и стороны, как у NetFlow DEX. */
export function BscExHead() {
  const win = useApp((s) => s.bscxWin);
  const data = useExFlow();
  const w = data?.wins?.[win];
  if (!data || !w || (!w.in && !w.out)) return null;
  return <Head w={w} win={win} data={data} />;
}

/** Монеты по одной: вывели с бирж, завели на биржи, итог, линия. */
export function BscExBody() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const win = useApp((s) => s.bscxWin);
  const side = useApp((s) => s.bscxSide);
  const query = useApp((s) => s.bscxQuery).trim().toUpperCase();
  const data = useExFlow();
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [win, side, query]);

  if (data === undefined) return <Skeleton rows={3} />;
  const w = data?.wins?.[win];
  if (!data || !w || (!w.in && !w.out)) return <Empty text={t(lang, "bscx_empty")} />;

  // «in» — приток к монете, как в NetFlow: здесь это вывод с бирж (итог > 0).
  const rows = w.coins.filter((c) =>
    (side === "all" || (side === "in" ? c.net > 0 : c.net < 0)) &&
    (!query || c.sym.toUpperCase().includes(query) || (query.startsWith("0X") && c.token.toUpperCase() === query)),
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);
  const go = (to: number) => {
    if (to < 1 || to > pages || to === page) return;
    haptic("select");
    setPage(to);
  };

  return (
    <>
      {!shown.length ? <Empty text={t(lang, "flow_search_none")} /> : null}
      {shown.map((c) => (
        <div className="nf" key={c.token || c.sym}>
          <button
            type="button"
            className="nf-hit"
            onClick={() => open("coin", c.sym, c.token)}
          >
            <CoinIcon sym={c.sym} icon={c.icon} size={32} />
            <span className="nf-main">
              <span className="nf-ttl">
                <span>{c.sym}</span>
              </span>
              <span className="nf-sub">
                <i>{num(c.n)} {t(lang, "bscx_transfers")}</i>
                {/* Слева вывод — зелёный, как покупки в NetFlow DEX. */}
                <i className="nf-money">
                  <span className="up">{usd(c.out)}</span>
                  <span className="dn">{usd(c.in)}</span>
                </i>
              </span>
              <BuySellBar buy={c.out} sell={c.in} />
            </span>
            <span className="nf-val">
              <FlowSpark values={c.sp} />
              <b className={c.net >= 0 ? "up" : "dn"}>{signed(c.net)}</b>
            </span>
          </button>
          {c.token ? (
            <button
              type="button"
              className="nf-copy"
              aria-label={t(lang, "ui_copy")}
              onClick={async () => {
                haptic("light");
                const ok = await copyText(c.token);
                toast(t(lang, ok ? "ui_copied" : "ui_copy_failed"), ok ? undefined : "err");
              }}
            >
              <CopyGlyph size={16} />
            </button>
          ) : null}
        </div>
      ))}
      {pages > 1 ? (
        <nav className="pager" aria-label={t(lang, "flow_coins")}>
          <button type="button" disabled={page <= 1} onClick={() => go(page - 1)}
                  aria-label={t(lang, "back_button")}>←</button>
          <span>{num(page)} / {num(pages)}</span>
          <button type="button" disabled={page >= pages} onClick={() => go(page + 1)}
                  aria-label={t(lang, "ui_show_more")}>→</button>
        </nav>
      ) : null}
      <p className="note dim">{t(lang, "bscx_note")}</p>
    </>
  );
}
