/**
 * «Аналитика» — кнопка 📊 бота со всеми её разделами: поток китов,
 * крупнейшие покупки, крупнейшие позиции, ликвидации, перекос фандинга.
 * Ротация — то, чего в чате показать было неудобно, а на экране видно.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t, bare } from "../i18n/t";
import type { DictKey } from "../i18n";
import { haptic } from "../lib/telegram";
import { toast } from "../components/Toast";
import { removeWallet } from "../lib/api";
import { syncNow } from "../lib/sync";
import { copyText } from "../lib/copy";
import { num, pct, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import { fundingSideKey, isUpKind, levFromSide, tradeKind, tradeKindKey } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { BuySellBar, FlowSpark, TrendChart } from "../components/Chart";
import {
  Card, CopyGlyph, Empty, Locked, MinusGlyph, NetFlowGlyph, OrdersGlyph, PlusGlyph,
  PositionsGlyph, Row, SectionTitle, Segmented, Skeleton, TileNav,
} from "../components/ui";
import { fetchBig, fetchFlow } from "../lib/api";
import type { BigSide, BigView, BigWin, FlowWin } from "../store/app";
import type { FlowRow, FlowSide, TradeRow, Trades } from "../lib/types";

/* Покупки и продажи — двумя кнопками, а не одним списком вперемешку. В общем
   списке крупная продажа и крупная покупка стоят рядом и спорят: доска
   отвечает то на «кто заходит», то на «кто выходит», а человек выбирает
   что-то одно. */
const BIG_SIDES: { id: BigSide; key: Parameters<typeof t>[1] }[] = [
  { id: "buy", key: "ui_side_buys" },
  { id: "sell", key: "ui_side_sells" },
];

const FLOW_SIDES: { id: FlowSide; key: Parameters<typeof t>[1] }[] = [
  { id: "all", key: "flow_side_all" },
  { id: "in", key: "flow_side_in" },
  { id: "out", key: "flow_side_out" },
];

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
 * Разделы аналитики: название говорит «что», значок площадки уголком — «где».
 *
 * Раньше плитки назывались вперемешку: «NetFlow» — по смыслу, «BSC» и
 * «Hyperliquid» — по площадке. Выходило, что NetFlow будто бы не с BSC, хотя
 * он ровно оттуда же, откуда и соседняя плитка; а «BSC» ничего не говорила
 * про то, что внутри крупные разовые сделки. Теперь по смыслу названы все
 * шесть, а площадка вынесена в значок — она у половины разделов одна и та же
 * и названием быть не может.
 */
const VIEWS: {
  id: BigView;
  ic: ReactNode;
  venue: "spot" | "perp";
  label: (t: (k: DictKey) => string) => string;
}[] = [
  { id: "flow", ic: <NetFlowGlyph size={22} />, venue: "spot", label: () => "NetFlow" },
  { id: "spot", ic: <OrdersGlyph size={22} />, venue: "spot", label: (tr) => tr("ui_tab_orders") },
  { id: "perp", ic: <PositionsGlyph size={22} />, venue: "perp", label: (tr) => tr("ui_tab_positions") },
  { id: "liq", ic: "💥", venue: "perp", label: (tr) => tr("ui_tab_liq") },
  { id: "fund", ic: "⚖️", venue: "perp", label: (tr) => tr("ui_tab_funding") },
  { id: "rot", ic: "🔄", venue: "spot", label: (tr) => tr("ui_rotation") },
];

/**
 * Лента крупных сделок. У каждой — кнопка подписки на её кошелёк.
 *
 * Плюс спрашивает имя на отдельном экране, где уже стоят все проверки: лимит
 * плана, забаненные киты, повтор. Подписан — на том же месте отписка, чтобы
 * не искать этот кошелёк потом в другом разделе.
 *
 * Кнопки нет у строк из старых ответов сервера: там приходил только
 * сокращённый адрес, а подписаться по «0x9702b7…d193» нельзя.
 */
function TradeList({ rows, empty }: { rows: TradeRow[]; empty: string }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const wallets = useLive((s) => s.wallets);
  const tracked = new Set(wallets.map((w) => w.addr.toLowerCase()));

  const unfollow = async (addr: string) => {
    haptic("light");
    const res = await removeWallet(addr);
    if (res?.ok) {
      toast(t(lang, "toast_wallet_removed"));
      void syncNow();
    } else toast(t(lang, "generic_error_retry"), "err");
  };

  if (!rows.length) return <Empty text={empty} />;
  return (
    <>
      {rows.map((r, i) => {
        const kind = tradeKind(r.side);
        const lev = levFromSide(r.side);
        const addr = (r.wa || "").toLowerCase();
        const on = tracked.has(addr);
        return (
          <Row
            key={`${r.sym}-${i}`}
            icon={<CoinIcon sym={r.sym} size={30} />}
            title={r.sym}
            sub={`${r.w} · ${ago(r.t)}`}
            value={usd(r.v)}
            tone={isUpKind(kind) ? "up" : "dn"}
            valueSub={`${t(lang, tradeKindKey(kind))}${lev ? ` ${lev}×` : ""}`}
            action={addr ? (
              <button
                type="button"
                className={on ? "lb-act off" : "lb-act on"}
                aria-label={bare(t(lang, on ? "remove_yes" : "menu_add_wallet"))}
                onClick={() => {
                  if (on) return void unfollow(addr);
                  haptic("select");
                  open("addWallet", addr);
                }}
              >
                {on ? <MinusGlyph size={19} /> : <PlusGlyph size={19} />}
              </button>
            ) : undefined}
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
  const flowSide = useApp((s) => s.flowSide);
  const setFlowSide = useApp((s) => s.setFlowSide);
  const query = useApp((s) => s.flowQuery);
  const setQuery = useApp((s) => s.setFlowQuery);
  const bigWin = useApp((s) => s.bigWin);
  const setBigWin = useApp((s) => s.setBigWin);
  const bigSide = useApp((s) => s.bigSide);
  const setBigSide = useApp((s) => s.setBigSide);

  const { funding, me } = useLive();
  const premium = me.plan === "premium";
  const big = useBigTrades(bigWin);
  /* Окно стоит внутри своего раздела, а не в общей шапке: в шапке оно
     висело над плитками и выглядело настройкой всей аналитики, хотя
     половина разделов его не знает. Теперь оно там, где действует, — и
     ниже кнопок стороны: сперва выбирают, что смотреть, потом за какой
     срок. */
  const winPicker = (
    <Segmented<BigWin>
      value={bigWin}
      onChange={setBigWin}
      options={BIG_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
    />
  );
  /* Сторона приходит отдельным полем. Разбирать подпись нельзя: она на языке
     смотрящего, и «покупка» в ней есть не на всех. Старые ответы поля не
     знают — для них остаётся разбор, иначе доска опустеет до перезапуска
     сервера. */
  const spotRows = big.data.spot.filter((r) =>
    r.buy === undefined ? (tradeKind(r.side) === "buy") === (bigSide === "buy") : r.buy === (bigSide === "buy"),
  );

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
        {/* Подпись общая для всех разделов: прежняя обещала только крупные
            сделки, а под ней жили ещё и потоки, фандинг и ротация. */}
        <p className="note dim">{t(lang, "ui_analytics_hint")}</p>
        {/* Сеткой, а не лентой: шесть разделов в один ряд не помещались, и
            последний приходилось доставать прокруткой, о которой ничто не
            сообщало — «Ликвидации» просто обрывались на краю. */}
        <TileNav<BigView>
          value={view}
          onChange={setView}
          label={t(lang, "big_title")}
          options={VIEWS.map((v) => ({
            id: v.id,
            ic: v.ic,
            venue: v.venue,
            label: v.label((k) => t(lang, k)),
          }))}
        />
      </Card>

      {view === "flow" ? (
        <Card>
          {/* NetFlow — термин, он одинаков во всех языках, как PnL и ROI.
              Прежнее «Что покупают киты» описывало только половину: при
              оттоке киты как раз продают. */}
          <SectionTitle note={t(lang, "flow_hint")}>NetFlow</SectionTitle>
          <FlowTrend />
          <Segmented<FlowWin>
            value={flowWin}
            onChange={setFlowWin}
            options={FLOW_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
          />
          {/* Знак потока отдельной строкой от окна: это два независимых
              вопроса — «за какой срок» и «кого показывать». Одним рядом они
              бы выглядели как один выбор из восьми. */}
          <Segmented<FlowSide>
            value={flowSide}
            onChange={setFlowSide}
            options={FLOW_SIDES.map((v) => ({ id: v.id, label: t(lang, v.key) }))}
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
          {/* Заголовок тот же, что на плитке. Прежний «Крупнейшие покупки /
              продажи» перечислял обе стороны, а на экране теперь одна: он и
              противоречил кнопкам, и занимал две строки. */}
          <SectionTitle note={`${t(lang, bigSide === "buy" ? "ui_side_buys" : "ui_side_sells")} · ${num(spotRows.length)}`}>
            {t(lang, "ui_tab_orders")}
          </SectionTitle>
          <Segmented<BigSide>
            value={bigSide}
            onChange={setBigSide}
            options={BIG_SIDES.map((v) => ({ id: v.id, label: t(lang, v.key) }))}
          />
          {winPicker}
          {big.loading ? <Skeleton rows={3} /> : <TradeList rows={spotRows} empty={t(lang, "big_empty")} />}
        </Card>
      ) : null}

      {view === "perp" ? (
        <Card>
          <SectionTitle>{t(lang, "big_perp_title")}</SectionTitle>
          {winPicker}
          {!premium ? locked : big.loading ? <Skeleton rows={3} /> : (
            <TradeList rows={big.data.perp} empty={t(lang, "big_empty")} />
          )}
        </Card>
      ) : null}

      {view === "liq" ? (
        <Card>
          <SectionTitle>{t(lang, "big_liq_title")}</SectionTitle>
          {winPicker}
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

/**
 * Сводка по всему окну: куда движется рынок целиком.
 *
 * Стоит первой, до выбора окна и фильтра, потому что отвечает на вопрос,
 * который возникает раньше всех остальных: покупают сейчас или продают.
 * Списку монет она не подчиняется — ни фильтр, ни поиск её не меняют, иначе
 * на пустом фильтре пропала бы и причина, по которой он пуст.
 */
function FlowTrend() {
  const lang = useApp((s) => s.lang);
  const win = useApp((s) => s.flowWin);
  const bucket = useLive((s) => s.flow)[win];
  if (!bucket) return null;

  return (
    <div className="trend">
      <p className="trend-ttl">
        <span>
          {t(lang, "flow_trend")} ·{" "}
          {t(lang, FLOW_WINS.find((w) => w.id === win)?.key ?? "big_win_24h")}
        </span>
        <span>
          {num(bucket.coins)} {t(lang, "flow_coins")}
        </span>
      </p>
      <p className="trend-top">
        <b className={bucket.net >= 0 ? "up" : "dn"}>{signed(bucket.net)}</b>
        <small>
          <span className="up">{usd(bucket.buy)}</span>
          {" · "}
          <span className="dn">{usd(bucket.sell)}</span>
        </small>
      </p>
      <TrendChart values={bucket.tr ?? []} />
      {/* Ширина рынка: общий итог может держаться на одной крупной монете,
          пока продают почти всё остальное. Счёт монет — единственное, что
          эту разницу показывает. */}
      <BuySellBar buy={bucket.up ?? 0} sell={bucket.dn ?? 0} />
      <p className="trend-br">
        <span className="up">{num(bucket.up ?? 0)} {t(lang, "flow_in_coins")}</span>
        <span className="dn">{num(bucket.dn ?? 0)} {t(lang, "flow_out_coins")}</span>
      </p>
    </div>
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
  const side = useApp((s) => s.flowSide);
  const raw = useApp((s) => s.flowQuery);
  const flow = useLive((s) => s.flow);

  const query = raw.trim();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const [qTotal, setQTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const bucket = flow[win];
  /* Первая страница без поиска и без фильтра уже лежит в выгрузке. */
  const local = !query && side === "all" && page === 1;
  /* Сколько монет под фильтром — тоже из выгрузки: счётчик и число страниц
     видны сразу, ещё до того, как ответит сервер. */
  const sideTotal = side === "in" ? bucket?.up : side === "out" ? bucket?.dn : bucket?.coins;
  const total = (query ? qTotal : sideTotal) ?? 0;
  const pages = Math.max(1, Math.ceil(total / FLOW_PAGE));

  // Сменились окно, фильтр или запрос — это другой список, и он с начала.
  useEffect(() => setPage(1), [win, side, query]);

  useEffect(() => {
    if (!query && side === "all" && page === 1) {
      setRows(null);
      setBusy(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      void fetchFlow(win, query, (page - 1) * FLOW_PAGE, side, ctrl.signal).then((r) => {
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
  }, [win, side, query, page]);

  const shown: FlowRow[] = local ? bucket?.rows ?? [] : rows ?? [];

  const go = (to: number) => {
    if (to < 1 || to > pages || to === page || busy) return;
    haptic("select");
    setPage(to);
  };

  if (busy && !shown.length) return <Skeleton rows={3} />;
  if (!shown.length) {
    return <Empty text={query || side !== "all" ? t(lang, "flow_search_none") : t(lang, "flow_empty")} />;
  }

  return (
    <>
      {shown.map((r) => (
        /* Строка перестала быть кнопкой целиком: рядом появилась своя — копия
           адреса, — а кнопку в кнопку вложить нельзя. Нажимаемой осталась вся
           строка, кроме уголка с копией. */
        <div className="nf" key={r.token || r.sym}>
        <button
          type="button"
          className="nf-hit"
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
            {/* Разделители — промежутки, а не точки в тексте. При крупном
                системном шрифте строка переносится, и точка оставалась
                висеть в конце обрывка: «20 кошельков · $40,9K ·». */}
            <span className="nf-sub">
              <i>{num(r.w)} {t(lang, "flow_wallets")}</i>
              {/* Покупки и продажи держатся вместе: если строка переносится,
                  разделяться должны кошельки и деньги, а не одна сумма от
                  другой — рядом они читаются как пара, порознь никак. */}
              <i className="nf-money">
                <span className="up">{usd(r.buy)}</span>
                <span className="dn">{usd(r.sell)}</span>
              </i>
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
        {/* Адрес контракта целиком — по нему монету находят в обозревателе и
            на бирже. Показывать все сорок два знака в строке негде, поэтому
            кнопка: нажал — адрес в буфере. */}
        {r.addr || r.token ? (
          <button
            type="button"
            className="nf-copy"
            aria-label={t(lang, "ui_copy")}
            onClick={async () => {
              haptic("light");
              const ok = await copyText(r.addr || r.token || "");
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
