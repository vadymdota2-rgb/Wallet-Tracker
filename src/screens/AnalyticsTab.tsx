/**
 * «Аналитика» — кнопка 📊 бота со всеми её разделами: поток китов,
 * крупнейшие покупки, крупнейшие позиции, ликвидации, перекос фандинга.
 * Ротация — то, чего в чате показать было неудобно, а на экране видно.
 */
import { useEffect, useState } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n";
import { venueName } from "../lib/rank";
import { haptic } from "../lib/telegram";
import { num, pct, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import { fundingSideKey, isUpKind, levFromSide, tradeKind, tradeKindKey } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { BuySellBar, FlowSpark } from "../components/Chart";
import { Card, Empty, Locked, Row, SectionTitle, Segmented, Skeleton } from "../components/ui";
import { fetchBig, fetchFlow } from "../lib/api";
import type { BigView, BigWin, FlowWin } from "../store/app";
import type { FlowRow, TradeRow, Trades } from "../lib/types";

const FLOW_WINS: { id: FlowWin; key: Parameters<typeof t>[1] }[] = [
  { id: "1", key: "ai_w1h" },
  { id: "6", key: "ai_w6h" },
  { id: "24", key: "big_win_24h" },
  { id: "168", key: "big_win_7d" },
  { id: "720", key: "big_win_30d" },
];

/* Тот же ряд, что у бота и что у потока: час, шесть часов, сутки, неделя,
   месяц. Между часом и сутками без шести часов слишком большой прыжок. */
const BIG_WINS: { id: BigWin; key: Parameters<typeof t>[1] }[] = [
  { id: "1h", key: "big_win_1h" },
  { id: "6h", key: "ai_w6h" },
  { id: "24h", key: "big_win_24h" },
  { id: "7d", key: "big_win_7d" },
  { id: "30d", key: "big_win_30d" },
];

/**
 * Подписи разделов — короткие.
 *
 * Полные («🟡 Крупнейшие покупки / продажи», «💢 Перекос фандинга») в ряд не
 * помещались: шесть таких уезжали за край, а прокрутку внутри полосы никто
 * не ищет. Подсказка над рядом и так говорит «выберите площадку», поэтому у
 * спота и фьючерсов стоят их имена, а не пересказ содержимого.
 */
const VIEWS: { id: BigView; label: (t: (k: DictKey) => string) => string }[] = [
  { id: "flow", label: () => "NetFlow" },
  { id: "spot", label: () => venueName("spot") },
  { id: "perp", label: () => venueName("perp") },
  { id: "liq", label: (tr) => tr("ui_tab_liq") },
  { id: "fund", label: (tr) => tr("ui_tab_funding") },
  { id: "rot", label: (tr) => tr("ui_rotation") },
];

function TradeList({ rows, empty }: { rows: TradeRow[]; empty: string }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  if (!rows.length) return <Empty text={empty} />;
  return (
    <>
      {rows.map((r, i) => {
        const kind = tradeKind(r.side);
        const lev = levFromSide(r.side);
        return (
          <Row
            key={`${r.sym}-${i}`}
            icon={<CoinIcon sym={r.sym} size={30} />}
            title={r.sym}
            sub={`${r.w} · ${ago(r.t)}`}
            value={usd(r.v)}
            tone={isUpKind(kind) ? "up" : "dn"}
            valueSub={`${t(lang, tradeKindKey(kind))}${lev ? ` ${lev}×` : ""}`}
            onClick={() => open("coin", r.sym)}
          />
        );
      })}
    </>
  );
}

/**
 * Крупнейшие сделки за выбранное окно. Сутки уже пришли в bootstrap — за
 * ними на сервер не ходим; остальные окна считаются по запросу.
 */
function useBigTrades(win: BigWin) {
  const cached = useLive((s) => s.trades);
  const [rows, setRows] = useState<Trades | null>(null);

  useEffect(() => {
    if (win === "24h") {
      setRows(null);
      return;
    }
    const ctrl = new AbortController();
    setRows(null);
    void fetchBig(win, ctrl.signal).then((r) => {
      if (!ctrl.signal.aborted) setRows(r);
    });
    return () => ctrl.abort();
  }, [win]);

  if (win === "24h") return { data: cached, loading: false };
  return { data: rows ?? { spot: [], perp: [], liq: [] }, loading: rows === null };
}

export function AnalyticsTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const view = useApp((s) => s.bigView);
  const setView = useApp((s) => s.setBigView);
  const flowWin = useApp((s) => s.flowWin);
  const setFlowWin = useApp((s) => s.setFlowWin);
  const query = useApp((s) => s.flowQuery);
  const setQuery = useApp((s) => s.setFlowQuery);
  const bigWin = useApp((s) => s.bigWin);
  const setBigWin = useApp((s) => s.setBigWin);

  const { funding, me } = useLive();
  const premium = me.plan === "premium";
  const big = useBigTrades(bigWin);
  const showWindows = view === "spot" || view === "perp" || view === "liq";

  const locked = (
    <Locked
      text={t(lang, "hl_locked_body")}
      cta={t(lang, "mw_upgrade")}
      onCta={() => {
        goTab("more");
        open("premium");
      }}
    />
  );

  return (
    <>
      <Card>
        <SectionTitle>{t(lang, "big_title")}</SectionTitle>
        <p className="note dim">{t(lang, "big_menu_hint")}</p>
        <Segmented<BigView>
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ id: v.id, label: v.label((k) => t(lang, k)) }))}
        />
        {showWindows ? (
          <Segmented<BigWin>
            value={bigWin}
            onChange={setBigWin}
            options={BIG_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
          />
        ) : null}
      </Card>

      {view === "flow" ? (
        <Card>
          {/* NetFlow — термин, он одинаков во всех языках, как PnL и ROI.
              Прежнее «Что покупают киты» описывало только половину: при
              оттоке киты как раз продают. */}
          <SectionTitle note={t(lang, "flow_hint")}>NetFlow</SectionTitle>
          <Segmented<FlowWin>
            value={flowWin}
            onChange={setFlowWin}
            options={FLOW_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
          />
          <input
            className="find"
            value={query}
            placeholder={t(lang, "flow_search_prompt")}
            onChange={(e) => setQuery(e.target.value)}
            inputMode="search"
            aria-label={t(lang, "flow_search_btn")}
          />
          <FlowBody />
        </Card>
      ) : null}

      {view === "spot" ? (
        <Card>
          <SectionTitle>{t(lang, "big_spot_title")}</SectionTitle>
          {big.loading ? <Skeleton rows={3} /> : <TradeList rows={big.data.spot} empty={t(lang, "big_empty")} />}
        </Card>
      ) : null}

      {view === "perp" ? (
        <Card>
          <SectionTitle>{t(lang, "big_perp_title")}</SectionTitle>
          {!premium ? locked : big.loading ? <Skeleton rows={3} /> : (
            <TradeList rows={big.data.perp} empty={t(lang, "big_empty")} />
          )}
        </Card>
      ) : null}

      {view === "liq" ? (
        <Card>
          <SectionTitle>{t(lang, "big_liq_title")}</SectionTitle>
          {big.loading ? <Skeleton rows={3} /> : <TradeList rows={big.data.liq} empty={t(lang, "big_empty")} />}
        </Card>
      ) : null}

      {view === "fund" ? (
        <Card>
          <SectionTitle note={t(lang, "fund_hint")}>{t(lang, "fund_title")}</SectionTitle>
          {!premium ? (
            locked
          ) : funding.length === 0 ? (
            <Empty text={t(lang, "fund_empty")} hint={t(lang, "fund_loading")} />
          ) : (
            funding.map((f) => (
              <Row
                key={f.sym}
                icon={<CoinIcon sym={f.sym} size={30} />}
                title={f.sym}
                sub={`${t(lang, fundingSideKey(f.rate))} · ${t(lang, "fund_oi")} ${usd(f.oi)}`}
                value={pct(f.rate, 4)}
                tone={f.rate >= 0 ? "up" : "dn"}
                valueSub={`${t(lang, "fund_apr")} ${pct(f.apr, 1)}`}
                onClick={() => open("coin", f.sym)}
              />
            ))
          )}
        </Card>
      ) : null}

      {view === "rot" ? (
        <Card>
          <SectionTitle note={t(lang, "ui_rot_hint")}>{t(lang, "ui_rotation")}</SectionTitle>
          <RotBody />
        </Card>
      ) : null}
    </>
  );
}

/** Сколько монет на странице. То же число, что сервер кладёт в выгрузку. */
const FLOW_PAGE = 40;

/**
 * Поток денег по монетам.
 *
 * Страницами, а не бесконечной лентой. У ленты не видно, сколько осталось, и
 * вернуться к началу можно только прокруткой; со страницами номер и общее
 * число видны сразу, а первая страница приходит с общей выгрузкой и рисуется
 * мгновенно.
 *
 * Поиск идёт в базу: искать среди сорока строк выгрузки, когда в базе тысячи,
 * значит не найти. Запрос уходит через четверть секунды после последней буквы.
 */
function FlowBody() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const win = useApp((s) => s.flowWin);
  const raw = useApp((s) => s.flowQuery);
  const flow = useLive((s) => s.flow);

  const query = raw.trim();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const [qTotal, setQTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const bucket = flow[win];
  /* Общее число монет окна приходит с выгрузкой — поэтому счётчик виден
     сразу, ещё до того, как человек куда-то нажал. */
  const total = (query ? qTotal : bucket?.coins) ?? 0;
  const pages = Math.max(1, Math.ceil(total / FLOW_PAGE));

  // Сменились окно или запрос — это другой список, и начинается он заново.
  useEffect(() => setPage(1), [win, query]);

  useEffect(() => {
    /* Первая страница без поиска уже лежит в выгрузке: за ней на сервер
       ходить незачем, она и так на экране мгновенно. */
    if (!query && page === 1) {
      setRows(null);
      setBusy(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      void fetchFlow(win, query, (page - 1) * FLOW_PAGE, ctrl.signal).then((r) => {
        if (ctrl.signal.aborted) return;
        setRows(r?.ok ? r.rows ?? [] : []);
        if (query) setQTotal(r?.total ?? 0);
        setBusy(false);
      });
    }, query ? 250 : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [win, query, page]);

  const shown: FlowRow[] = !query && page === 1 ? bucket?.rows ?? [] : rows ?? [];

  if (busy && !shown.length) return <Skeleton rows={3} />;
  if (!shown.length) {
    return <Empty text={query ? t(lang, "flow_search_none") : t(lang, "flow_empty")} />;
  }

  const go = (to: number) => {
    if (to < 1 || to > pages || to === page || busy) return;
    haptic("select");
    setPage(to);
  };

  return (
    <>
      {/* Итог по окну — только для полного списка. При поиске он относился бы
          ко всему окну, а на экране стояли бы две монеты: число и список
          спорили бы друг с другом. */}
      {!query && bucket ? (
        <p className="flow-sum">
          <span className={bucket.net >= 0 ? "up" : "dn"}>{signed(bucket.net)}</span>
          <small>
            {num(total)} {t(lang, "flow_coins")}
          </small>
        </p>
      ) : null}

      {shown.map((r) => (
        <button
          type="button"
          className="nf"
          key={r.token || r.sym}
          /* Адрес контракта уезжает вторым: по нему экран монеты достаёт
             историю цены. По тикеру её не найти — тикеры не уникальны. */
          onClick={() => open("coin", r.sym, r.addr || r.token)}
        >
          <CoinIcon sym={r.sym} icon={r.icon} size={32} />
          <span className="nf-main">
            <span className="nf-ttl">
              {/* Имя отдельным элементом: во flex-строке обрезать многоточием
                  можно только элемент, голый текст под правило не попадает. */}
              <span>{r.sym}</span>
              {/* Под одним тикером на BSC живут разные контракты: копии
                  популярных имён делаются в два клика. Хвост адреса — то
                  единственное, чем они честно различаются. */}
              {r.tag ? <em className="nf-tag">{r.tag}</em> : null}
            </span>
            <span className="nf-sub">
              {num(r.w)} {t(lang, "flow_wallets")} · <span className="up">{usd(r.buy)}</span>
              {" · "}
              <span className="dn">{usd(r.sell)}</span>
            </span>
            {/* Доля покупок в обороте: число говорит «сколько», полоса —
                «насколько односторонне». Приток в $1K при обороте $1K и при
                обороте $1M — разные новости. */}
            <BuySellBar buy={r.buy} sell={r.sell} />
          </span>
          <span className="nf-val">
            <FlowSpark values={r.sp} />
            <b className={r.net >= 0 ? "up" : "dn"}>{signed(r.net)}</b>
          </span>
        </button>
      ))}

      {pages > 1 ? (
        <nav className="pager" aria-label={t(lang, "flow_coins")}>
          <button type="button" disabled={page <= 1 || busy} onClick={() => go(page - 1)}
                  aria-label={t(lang, "back_button")}>←</button>
          <span>{num(page)} / {num(pages)}</span>
          <button type="button" disabled={page >= pages || busy} onClick={() => go(page + 1)}
                  aria-label={t(lang, "ui_show_more")}>→</button>
        </nav>
      ) : null}
    </>
  );
}


function RotBody() {
  const lang = useApp((s) => s.lang);
  const rot = useLive((s) => s.rot);
  const win = useApp((s) => s.flowWin);
  const key = win === "168" || win === "720" ? "168" : "24";
  const links = rot[key] ?? [];
  if (!links.length) return <Empty text={t(lang, "flow_empty")} />;
  return (
    <>
      {links.map((l, i) => (
        <Row
          key={`${l.from}-${l.to}-${i}`}
          icon={<CoinIcon sym={l.to} size={30} />}
          title={
            <>
              {l.from} <span className="arrow">→</span> {l.to}
            </>
          }
          sub={`${num(l.w)} ${t(lang, "flow_wallets")}`}
          value={usd(l.usd)}
        />
      ))}
    </>
  );
}
