/**
 * «Аналитика» — кнопка 📊 бота со всеми её разделами: поток денег, крупнейшие
 * сделки и позиции, перекос фандинга, лонг против шорта. Ротация — то, чего в
 * чате показать было неудобно, а на экране видно.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t, bare } from "../i18n/t";
import type { DictKey } from "../i18n";
import type { LangCode } from "../i18n/types";
import { haptic } from "../lib/telegram";
import { toast } from "../components/Toast";
import { removeWallet } from "../lib/api";
import { syncNow } from "../lib/sync";
import { copyText } from "../lib/copy";
import { num, pct, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import {
  coinClass, fundingSideKey, isUpKind, levFromSide, showSym, tradeKind, tradeKindKey,
} from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { BuySellBar, FlowSpark, TrendChart } from "../components/Chart";
import {
  AllVenuesGlyph, Card, Chips, CopyGlyph, Empty, FundingGlyph, Locked, MinusGlyph,
  NetFlowGlyph, OrdersGlyph, PlusGlyph, PositionsGlyph, RotationGlyph, Row, SectionTitle,
  Segmented, Skeleton, StackGlyph, TileNav,
} from "../components/ui";
import { fetchBig, fetchFlow, fetchLs, fetchRot } from "../lib/api";
import type { BigSide, BigView, BigWin, FlowWin } from "../store/app";
import type {
  CoinClass, FlowRow, FlowSide, FundRow, LsRow, RotSide, RotSum, TradeRow, Trades,
} from "../lib/types";

/* Покупки и продажи — двумя кнопками, а не одним списком вперемешку. В общем
   списке крупная продажа и крупная покупка стоят рядом и спорят: доска
   отвечает то на «кто заходит», то на «кто выходит», а человек выбирает
   что-то одно. */
const BIG_SIDES: { id: BigSide; key: Parameters<typeof t>[1] }[] = [
  { id: "buy", key: "ui_side_buys" },
  { id: "sell", key: "ui_side_sells" },
];

/* Акции и металлы — не крипта ни по размеру, ни по настроению: в один список
   их мешать нельзя, иначе пара миллионов в NVDA теряется среди сотен
   миллионов в биткоине, а общий процент не говорит ни о том, ни о другом. */
const LS_CLASSES: { id: CoinClass; key: Parameters<typeof t>[1] }[] = [
  { id: "crypto", key: "ui_cls_crypto" },
  { id: "rwa", key: "ui_cls_rwa" },
];

/* Те же три кнопки, что у потока, но про перевес: монета лонговая, если
   больше половины денег зашло на рост. Состояние общее с потоком — человек
   один раз выбирает, что смотреть, и это держится в обоих разделах. */
const LS_SIDES: { id: FlowSide; key: Parameters<typeof t>[1] }[] = [
  { id: "all", key: "flow_side_all" },
  { id: "in", key: "ls_side_long" },
  { id: "out", key: "ls_side_short" },
];

/* Те же две кнопки, что у ордеров, только на перпах сторона зовётся иначе. */
const PERP_SIDES: { id: BigSide; key: Parameters<typeof t>[1] }[] = [
  { id: "buy", key: "ls_side_long" },
  { id: "sell", key: "ls_side_short" },
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
  venue?: "spot" | "perp";
  label: (t: (k: DictKey) => string) => string;
}[] = [
  { id: "flow", ic: <NetFlowGlyph size={22} />, venue: "spot", label: () => "NetFlow" },
  { id: "spot", ic: <OrdersGlyph size={22} />, venue: "spot", label: (tr) => tr("ui_tab_orders") },
  { id: "rot", ic: <RotationGlyph size={22} />, venue: "spot", label: (tr) => tr("ui_rotation") },
  { id: "ls", ic: <PositionsGlyph size={22} />, venue: "perp", label: (tr) => tr("ui_tab_ls") },
  { id: "perp", ic: <StackGlyph size={22} />, venue: "perp", label: (tr) => tr("ui_tab_positions") },
  /* Уголка площадки у фандинга нет: он теперь с нескольких бирж, и значок
     одной из них обещал бы, что остальных тут нет. */
  { id: "fund", ic: <FundingGlyph size={22} />, label: (tr) => tr("ui_tab_funding") },
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
            icon={<CoinIcon sym={r.sym} icon={r.icon} size={30} />}
            /* Значок ищется по полному имени — «xyz:AAPL», иначе его не
               найти; а в подписи приставка рынка лишняя. */
            title={showSym(r.sym)}
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
  return { data: rows ?? { spot: [], perp: [] }, loading: rows === null };
}

export function AnalyticsTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const saved = useApp((s) => s.bigView);
  const setView = useApp((s) => s.setBigView);
  /* У кого-то в браузере сохранён раздел, плитки которого больше нет —
     ликвидации. Оставить как есть нельзя: карточка показалась бы, а ни одна
     плитка не подсветилась, и это выглядело бы поломкой. Возвращаем к
     первому разделу. */
  const view = VIEWS.some((v) => v.id === saved) ? saved : "flow";
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
  const lsCls = useApp((s) => s.lsCls);
  const setLsCls = useApp((s) => s.setLsCls);

  const { me } = useLive();
  const rotSum = useLive((s) => s.rotSum)[flowWin];
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
  /* Класс считает сервер: у него карта площадок Hyperliquid, а по короткому
     имени «SP500» приложение индекс от монеты не отличит. Для строк из старых
     ответов остаётся запасное правило по имени.

     Направление — второй отбор, по той же кнопке, что покупки и продажи на
     споте: вопрос один и тот же, «кто ставит на рост», просто на разных
     площадках он называется по-разному. */
  const wantLong = bigSide === "buy";
  const perpRows = big.data.perp.filter(
    (r) =>
      (r.cls ?? coinClass(r.sym)) === lsCls &&
      (r.long === undefined ? tradeKind(r.side) === "long" : r.long) === wantLong,
  );
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

      {view === "ls" ? (
        <Card>
          <SectionTitle note={t(lang, "ls_hint")}>{t(lang, "ui_tab_ls")}</SectionTitle>
          {/* Класс инструментов стоит первым: это самый крупный выбор, всё
              остальное — окно, перевес, поиск — уточняет уже его. */}
          <Segmented<CoinClass>
            value={lsCls}
            onChange={setLsCls}
            options={LS_CLASSES.map((v) => ({ id: v.id, label: t(lang, v.key) }))}
          />
          <LsHead />
          <Segmented<FlowWin>
            value={flowWin}
            onChange={setFlowWin}
            options={FLOW_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
          />
          <Segmented<FlowSide>
            value={flowSide}
            onChange={setFlowSide}
            options={LS_SIDES.map((v) => ({ id: v.id, label: t(lang, v.key) }))}
          />
          <input
            className="find"
            value={query}
            placeholder={t(lang, "flow_search_prompt")}
            onChange={(e) => setQuery(e.target.value)}
            inputMode="search"
            aria-label={t(lang, "flow_search_btn")}
          />
          <LsBody />
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
          <SectionTitle note={`${t(lang, wantLong ? "ls_side_long" : "ls_side_short")} · ${num(perpRows.length)}`}>
            {t(lang, "big_perp_title")}
          </SectionTitle>
          {/* Тот же раздельник, что в «Лонг / Шорт», и та же выбранная
              кнопка: акции с металлами и крипта — разные рынки, а не разные
              разделы, и переключать их дважды человек не должен. */}
          <Segmented<CoinClass>
            value={lsCls}
            onChange={setLsCls}
            options={LS_CLASSES.map((v) => ({ id: v.id, label: t(lang, v.key) }))}
          />
          {/* Лонги и шорты — та же кнопка, что покупки и продажи на споте:
              человек один раз выбирает, чью сторону смотрит. */}
          <Segmented<BigSide>
            value={bigSide}
            onChange={setBigSide}
            options={PERP_SIDES.map((v) => ({ id: v.id, label: t(lang, v.key) }))}
          />
          {winPicker}
          {!premium ? locked : big.loading ? <Skeleton rows={3} /> : (
            <TradeList rows={perpRows} empty={t(lang, "big_empty")} />
          )}
        </Card>
      ) : null}

      {view === "fund" ? (
        <Card>
          <SectionTitle note={t(lang, "fund_hint")}>{t(lang, "fund_title")}</SectionTitle>
          {!premium ? locked : <FundBody />}
        </Card>
      ) : null}

      {view === "rot" ? (
        <Card>
          <SectionTitle note={t(lang, "ui_rot_hint")}>{t(lang, "ui_rotation")}</SectionTitle>
          {/* Окно перед таблицей, а не под ней: сперва выбирают срок, потом
              смотрят, что за него вышло. Сам выбор общий с потоком — оба
              раздела про одни и те же деньги на одной площадке. */}
          <Segmented<FlowWin>
            value={flowWin}
            onChange={setFlowWin}
            options={FLOW_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
          />
          {/* Пустое окно — без таблицы: «$0 переложено, 0 пар» и два пустых
              столбца выглядят как поломка, хотя это просто тихий час. */}
          {rotSum && rotSum.pairs > 0 ? (
            <RotBody sum={rotSum} win={flowWin} />
          ) : (
            <Empty text={t(lang, "flow_empty")} />
          )}
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


/**
 * Сводка по всему рынку: сколько денег зашло в лонг против шорта за окно.
 *
 * Стоит первой, как тренд у потока, и по той же причине: вопрос «рынок
 * ставит на рост или на падение» возникает раньше вопроса про отдельную
 * монету. Фильтру и поиску не подчиняется — она про всё окно.
 */
function LsHead() {
  const lang = useApp((s) => s.lang);
  const win = useApp((s) => s.flowWin);
  const cls = useApp((s) => s.lsCls);
  const side = useApp((s) => s.flowSide);
  const all = useLive((s) => s.ls)[win];
  /* Итог того класса, что выбран, а не рынка целиком: иначе на «Акциях и
     золоте» стояла бы цифра, посчитанная в основном по биткоину. Старые
     ответы разбивки не знают — для них берём общий итог, он хотя бы не
     врёт про сумму. */
  const b = (cls === "rwa" ? all?.rwa : all?.crypto) ?? all;
  if (!b || b.long + b.short <= 0) return null;
  const up = b.pct >= 50;
  /* Смотришь шорты — и число должно быть про шорты. Прежде и там, и там
     стояла доля лонга: под кнопкой «Шорты» это читалось как «11% в шорте»,
     хотя означало ровно обратное.

     Цвет при этом остаётся про монету, а не про показанное число: красный —
     значит по ней ставят вниз, каким бы боком мы на неё ни смотрели. */
  const short = side === "out";
  return (
    <div className="trend">
      <p className="trend-ttl">
        <span>
          {t(lang, "ls_title")} ·{" "}
          {t(lang, FLOW_WINS.find((w) => w.id === win)?.key ?? "big_win_24h")}
        </span>
        <span>
          {num(b.coins)} {t(lang, "flow_coins")}
        </span>
      </p>
      <p className="trend-top">
        <b className={up ? "up" : "dn"}>{pct(short ? 100 - b.pct : b.pct, 1, false)}</b>
        <small>
          <span className="up">{usd(b.long)}</span>
          {" · "}
          <span className="dn">{usd(b.short)}</span>
        </small>
      </p>
      <BuySellBar buy={b.long} sell={b.short} />
      <p className="trend-br">
        <span className="up">{t(lang, "ls_side_long")}</span>
        <span className="dn">{t(lang, "ls_side_short")}</span>
      </p>
    </div>
  );
}

/** Монеты раздела «Лонг / Шорт» — страницами, как у потока. */
function LsBody() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const win = useApp((s) => s.flowWin);
  const side = useApp((s) => s.flowSide);
  const cls = useApp((s) => s.lsCls);
  const raw = useApp((s) => s.flowQuery);
  const all = useLive((s) => s.ls)[win];
  const bucket = (cls === "rwa" ? all?.rwa : all?.crypto) ?? all;

  const query = raw.trim();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LsRow[] | null>(null);
  const [qTotal, setQTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const local = !query && side === "all" && page === 1;
  const total = (query || side !== "all" ? qTotal : bucket?.coins) ?? 0;
  const pages = Math.max(1, Math.ceil(total / FLOW_PAGE));

  useEffect(() => setPage(1), [win, side, cls, query]);

  useEffect(() => {
    if (!query && side === "all" && page === 1) {
      setRows(null);
      setBusy(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      void fetchLs(win, query, (page - 1) * FLOW_PAGE, side, cls, ctrl.signal).then((r) => {
        if (ctrl.signal.aborted) return;
        setRows(r?.ok ? r.rows ?? [] : []);
        setQTotal(r?.total ?? 0);
        setBusy(false);
      });
    }, query ? 250 : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [win, side, cls, query, page]);

  const shown: LsRow[] = local ? bucket?.rows ?? [] : rows ?? [];
  /* Выбраны шорты — и доля должна быть про шорты. Прежде под обеими кнопками
     стояла доля лонга, и «11% в лонге» под кнопкой «Шорты» читалось как «11%
     в шорте», то есть ровно наоборот. */
  const short = side === "out";

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
      {shown.map((r) => {
        const full = r.full || r.sym;
        return (
        <div className="nf" key={r.sym}>
          <button type="button" className="nf-hit" onClick={() => open("coin", r.sym)}>
            <CoinIcon sym={r.sym} icon={r.icon} size={32} />
            <span className="nf-main">
              <span className="nf-ttl">
                <span>{showSym(r.sym)}</span>
                {/* Полное имя показываем, только когда оно не равно короткому:
                    у «BTC» приписывать нечего, а «xyz:SP500» говорит, на какой
                    площадке этот индекс торгуется. */}
                {full !== showSym(r.sym) ? <em className="nf-tag">{full}</em> : null}
              </span>
              <span className="nf-sub">
                <i>{num(r.w)} {t(lang, "flow_wallets")}</i>
                <i className="nf-money">
                  <span className="up">{usd(r.long)}</span>
                  <span className="dn">{usd(r.short)}</span>
                </i>
              </span>
              {/* Полоса и число об одном: число говорит «насколько», полоса
                  показывает это же глазу, не заставляя сравнивать цифры. */}
              <BuySellBar buy={r.long} sell={r.short} />
            </span>
            <span className="nf-val">
              {/* Цвет про монету, а не про показанное число: красный значит
                  «ставят вниз», под какой бы кнопкой мы ни смотрели. */}
              <b className={r.pct >= 50 ? "up" : "dn"}>
                {pct(short ? 100 - r.pct : r.pct, 0, false)}
              </b>
              <small className="dim">{t(lang, short ? "ls_in_short" : "ls_in_long")}</small>
            </span>
          </button>
          {/* Контракта у перпов нет — это рынок, а не токен. Копируется его
              имя на бирже: по нему инструмент и находят. И сообщение своё:
              «Адрес скопирован» тут было бы неправдой. */}
          <button
            type="button"
            className="nf-copy"
            aria-label={t(lang, "ui_copy")}
            onClick={async () => {
              haptic("light");
              const ok = await copyText(full);
              toast(t(lang, ok ? "ui_copied_name" : "ui_copy_failed"), ok ? undefined : "err");
            }}
          >
            <CopyGlyph size={16} />
          </button>
        </div>
        );
      })}

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


/**
 * Биржи фандинга. Порядок и названия — здесь, а не на сервере: сервер
 * отдаёт только те доски, которые собрались, и приложение показывает кнопки
 * ровно для них. Биржа, до которой сервер не достучался, не появляется —
 * пустая вкладка с её именем выглядела бы как поломка у нас.
 *
 * Значок — монета самой биржи там, где она есть: HYPE у Hyperliquid, BNB у
 * Binance. Рисовать чужие логотипы по памяти хуже, чем честная буква в
 * кружке, которую CoinIcon и поставит.
 */
const FUND_VENUES: { id: string; name: string; logo: string }[] = [
  { id: "hl", name: "Hyperliquid", logo: "/cglogo/markets/images/1571/small/PFP.png" },
  { id: "bingx", name: "BingX", logo: "/cglogo/markets/images/812/small/YtFwQwJr_400x400.jpg" },
  { id: "binance", name: "Binance", logo: "/cglogo/markets/images/52/small/binance.jpg" },
  { id: "gate", name: "Gate", logo: "/cglogo/markets/images/60/small/Frame_1.png" },
];

const venueName = (ex: string) => FUND_VENUES.find((v) => v.id === ex)?.name ?? ex;

/**
 * Как часто биржа платит. Отдельной подписью для часа: «каждые 1 ч» — это не
 * по-русски, а раз в час платит Hyperliquid, то есть половина списка.
 */
function everyLabel(lang: LangCode, per: number): string {
  const hours = Math.round(24 / (per || 1));
  return hours <= 1
    ? t(lang, "fund_hourly")
    : t(lang, "fund_every").replace("{h}", String(hours));
}

/** Ставка за выплату: у часовых она сотые доли процента, у восьмичасовых — целые. */
const payRate = (v: number) => pct(Math.abs(v), Math.abs(v) < 0.1 ? 4 : 2, false);

/**
 * Частота коротко: «/4 ч». Деньги за выплату длиннее ставки, и со словами
 * («$18,72 каждые 4 ч») хвост уезжал под правый столбец. Рядом с суммой за
 * сутки строкой ниже косая черта читается однозначно.
 */
const everyShort = (lang: LangCode, per: number) =>
  `/${Math.round(24 / (per || 1))}${t(lang, "unit_hour")}`;

/**
 * Суточная ставка. Сервер прошлой версии присылал годовые — пока он не
 * перезапущен, суточные выводятся из них делением: строка с прочерком вместо
 * числа выглядела бы как сломанный раздел, хотя данные пришли.
 */
const dayRate = (f: FundRow) =>
  typeof f.day === "number" ? f.day : (f.apr ?? 0) / 365;

/** Быстрые суммы: столько, сколько обычно и заводят. */
const CALC_STEPS = [100, 1000, 10_000, 100_000];

/**
 * Размер позиции для всего списка.
 *
 * Поле одно на все монеты, а не своё у каждой: сумма у человека одна, а
 * сравнить он хочет, что она принесёт на разных монетах. Своя кнопка у
 * каждой строки заставляла бы вводить её заново и, главное, отнимала у
 * строки ширину — на узком экране от подписи оставались обрывки.
 *
 * Введённое остаётся после перезапуска: вводят один раз.
 */
function FundCalcBar() {
  const lang = useApp((s) => s.lang);
  const amount = useApp((s) => s.fundAmount);
  const setAmount = useApp((s) => s.setFundAmount);
  const [text, setText] = useState(amount ? String(amount) : "");

  return (
    <div className="calc">
      <label className="calc-in">
        <span>{t(lang, "calc_amount")}</span>
        <input
          value={text}
          onChange={(e) => {
            /* Пробелы и запятые — то, как сумму пишут руками; цифры из них
               достаём сами, иначе поле выглядит сломанным. */
            const raw = e.target.value.replace(/[^\d.,\s]/g, "");
            setText(raw);
            setAmount(Number(raw.replace(/\s/g, "").replace(",", ".")) || 0);
          }}
          inputMode="decimal"
          placeholder="1000"
          aria-label={t(lang, "calc_amount")}
        />
      </label>
      <Chips<number>
        value={amount}
        options={CALC_STEPS.map((v) => ({ id: v, label: usd(v) }))}
        onChange={(v) => {
          setAmount(v);
          setText(String(v));
        }}
      />
      {/* Оговорка одна на список: цена за это время тоже ходит, и её движение
          может перекрыть любую ставку. Обещать заработок нельзя. */}
      <p className="calc-note">{t(lang, "calc_note")}</p>
    </div>
  );
}

/**
 * Фандинг: где сейчас перекос и на какую сторону.
 *
 * Раздел был про одну биржу — Hyperliquid, — и её значок стоял уголком
 * плитки. Бирж теперь несколько, поэтому уголка нет, а выбор площадки стоит
 * внутри раздела, первой строкой: «Все» — общая доска перекосов, дальше по
 * биржам.
 *
 * Сравнивать ставки между биржами можно только приведя их к одному сроку:
 * Hyperliquid платит каждый час, остальные — раз в четыре или восемь, и одна
 * и та же цифра означает у них разное. Срок этот — сутки: в годовых те же
 * ставки дают «-1971%», а это не перекос, а бессмыслица — ставка держится
 * часы, а не год. Поэтому главное число строки — процент в сутки, а ставка
 * за выплату и её частота стоят подписью: по ним видно, откуда он взялся.
 */
function FundBody() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const fund = useLive((s) => s.fund);
  const [ex, setEx] = useState("all");
  const amount = useApp((s) => s.fundAmount);

  const have = FUND_VENUES.filter((v) => (fund[v.id] ?? []).length > 0);
  const rows = fund[ex] ?? [];

  if (!have.length) {
    return <Empty text={t(lang, "fund_empty")} hint={t(lang, "fund_loading")} />;
  }

  return (
    <>
      {/* Кнопка «Все» первой: вопрос «где сейчас самый перекос» возникает
          раньше, чем «что на такой-то бирже». */}
      <TileNav<string>
        value={ex}
        onChange={setEx}
        cols={have.length + 1 > 3 ? 3 : 2}
        label={t(lang, "fund_title")}
        options={[
          {
            id: "all",
            ic: <AllVenuesGlyph size={26} />,
            label: t(lang, "fund_all"),
          },
          ...have.map((v) => ({
            id: v.id,
            /* Логотип биржи идёт через тот же кружок, что и монеты: если
               картинка не дойдёт, на её месте останется буква, а не пустота. */
            ic: <CoinIcon sym={v.name} icon={[v.logo]} size={26} />,
            label: v.name,
          })),
        ]}
      />
      <FundCalcBar />
      {rows.length === 0 ? (
        <Empty text={t(lang, "fund_empty")} hint={t(lang, "fund_loading")} />
      ) : (
        /* Подписи здесь переносятся, а не обрезаются многоточием, как в
           остальных списках: в них стоит объяснение числа — сколько платят и
           как часто, — и обрубок «0,0749% каж…» не объясняет ничего. */
        <div className="fund-rows">{rows.map((f) => (
          <Row
            key={`${f.ex}-${f.sym}`}
            icon={<CoinIcon sym={f.sym} size={30} />}
            title={showSym(f.sym)}
            /* Биржа — меткой у названия: на общей доске одна монета стоит
               несколькими строками, и различает их только она. */
            badge={venueName(f.ex)}
            /* Кто кому платит и откуда взялся суточный процент: ставка за
               выплату и то, как часто её платят. */
            /* Введена сумма — на месте ставки за выплату стоят деньги за ту
               же выплату: это она и есть, только в долларах, и держать рядом
               оба числа значит занимать строку дважды одним и тем же. */
            sub={
              /* Разделители — промежутки, а не точки в тексте: подпись здесь
                 переносится, и точка оставалась висеть в конце обрывка.
                 Число с частотой — одним куском: перенос между «4» и «ч»
                 рвал именно то, ради чего эта подпись и стоит. */
              <span className="fund-sub">
                <i>{t(lang, fundingSideKey(f.rate))}</i>
                <i className={amount > 0 ? "nb calc-pay" : "nb"}>
                  {amount > 0
                    ? `${usd((amount * Math.abs(f.rate)) / 100)}${everyShort(lang, f.per)}`
                    : `${payRate(f.rate)} ${everyLabel(lang, f.per)}`}
                </i>
              </span>
            }
            /* Ликвидность второй строкой, а не в одну с первой: вместе они
               обрывались на многоточии ровно там, где стояла сумма. Биржа
               отдаёт что-то одно — открытый интерес или оборот. */
            sub2={
              <span className="fund-sub">
                {/* Суточные деньги — тоже слева, а не под процентом справа:
                    правый столбец от них разъезжался, и подписи слева
                    оставалось меньше ста пикселей. */}
                {amount > 0 ? (
                  <i className="nb calc-pay">
                    {usd((amount * Math.abs(dayRate(f))) / 100)} {t(lang, "fund_daily")}
                  </i>
                ) : null}
                <i className="nb">
                  {f.oi > 0
                    ? `${t(lang, "fund_oi")} ${usd(f.oi)}`
                    : `${t(lang, "fund_vol")} ${usd(f.vol)}`}
                </i>
              </span>
            }
            value={pct(dayRate(f), 2)}
            tone={dayRate(f) >= 0 ? "up" : "dn"}
            valueSub={t(lang, "fund_daily")}
            onClick={() => open("coin", f.sym)}
          />
        ))}</div>
      )}
    </>
  );
}

/** Монет в столбце на странице. */
const ROT_PAGE = 15;

/**
 * Ротация: из каких монет деньги уходят и в какие приходят.
 *
 * Пара считается так: кошелёк что-то продал, а следующей покупкой взял
 * другую монету — значит, деньги переложили. Пары складываются по монетам и
 * показываются двумя столбцами: слева те, из которых выходили, справа те, в
 * которые заходили.
 *
 * Списка самих пар («BEM → KII», сумма) под таблицей больше нет: он говорил
 * то же самое, только дробно — одна монета расходилась по нему десятком
 * строк, и сколько из неё вышло всего, по списку было не сложить.
 *
 * Столбцы рядом, а не один за другим: «откуда» и «куда» сравнивают друг с
 * другом, и разнесённые по вертикали они этого не позволяют.
 *
 * Страницами: монет в окне бывают сотни. Первая страница приходит с общей
 * выгрузкой и рисуется сразу, остальные достаются запросом — возить сотни
 * строк каждому запуску ради страницы, до которой дойдёт один из двадцати,
 * незачем.
 */
function RotBody({ sum, win }: { sum: RotSum; win: FlowWin }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState<{ src: RotSide[]; dst: RotSide[] } | null>(null);
  const [busy, setBusy] = useState(false);

  // Сменилось окно — это другая таблица, и она с начала.
  useEffect(() => {
    setPage(1);
    setMore(null);
  }, [win]);

  useEffect(() => {
    if (page === 1) {
      setMore(null);
      setBusy(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    void fetchRot(win, (page - 1) * ROT_PAGE, ROT_PAGE, ctrl.signal).then((r) => {
      if (ctrl.signal.aborted) return;
      setMore(r?.ok ? { src: r.src ?? [], dst: r.dst ?? [] } : { src: [], dst: [] });
      setBusy(false);
    });
    return () => ctrl.abort();
  }, [win, page]);

  const winKey = FLOW_WINS.find((w) => w.id === win)?.key ?? "big_win_24h";
  /* Сколько всего листается, знает сервер: в выгрузку уехала одна страница, и
     по ней числа страниц не узнать. */
  const deep = Math.max(sum.msrc ?? sum.src.length, sum.mdst ?? sum.dst.length);
  const pages = Math.max(1, Math.ceil(deep / ROT_PAGE));
  const at = Math.min(page, pages);

  const go = (to: number) => {
    if (to < 1 || to > pages || to === at || busy) return;
    haptic("select");
    setPage(to);
  };

  const col = (side: "src" | "dst") => {
    const all = (side === "src" ? sum.src : sum.dst) ?? [];
    const total = (side === "src" ? sum.msrc : sum.mdst) || all.length;
    /* Полоса меряется от первой монеты столбца, а не от итога окна: доли от
       итога у всех мелкие, и столбик из одинаковых обрубков не сравнить.
       Мера общая для всех страниц — она берётся с первой, которая всегда под
       рукой; иначе на второй странице полосы начали бы расти заново и монета
       помельче выглядела бы крупнее прежних. */
    const top = all[0]?.usd || 1;
    const rows = at === 1 ? all.slice(0, ROT_PAGE) : (side === "src" ? more?.src : more?.dst) ?? [];
    return (
      <div className="rot-col">
        <p className={`rot-col-ttl ${side === "src" ? "dn" : "up"}`}>
          <span>{t(lang, side === "src" ? "rot_from" : "rot_to")}</span>
          {/* Сколько монет в столбце: столько же, сколько можно пролистать —
              иначе подпись обещала бы монеты, до которых не добраться. */}
          <i>{num(total)}</i>
        </p>
        {busy && !rows.length ? <Skeleton rows={4} /> : null}
        {rows.map((x) => (
          <button
            key={x.sym}
            type="button"
            className="rot-line"
            onClick={() => { haptic("select"); open("coin", x.sym); }}
          >
            <span className={`rot-line-fill ${side === "src" ? "dn" : "up"}`}
                  style={{ width: `${Math.max(6, (x.usd / top) * 100)}%` }} />
            <CoinIcon sym={x.sym} size={16} />
            <span className="rot-line-nm">{showSym(x.sym)}</span>
            <i>{usd(x.usd)}</i>
          </button>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="trend rot-sum">
        <p className="trend-ttl">
          <span>{t(lang, "ui_rotation")} · {t(lang, winKey)}</span>
          <span>{num(sum.pairs)} {t(lang, "rot_pairs")}</span>
        </p>
        <p className="trend-top">
          <b>{usd(sum.usd)}</b>
          <small>{t(lang, "rot_moved")} · {num(sum.w)} {t(lang, "flow_wallets")}</small>
        </p>
        <div className="rot-cols">
          {col("src")}
          {col("dst")}
        </div>
      </div>

      {pages > 1 ? (
        <nav className="pager" aria-label={t(lang, "ui_rotation")}>
          <button type="button" disabled={at <= 1 || busy} onClick={() => go(at - 1)}
                  aria-label={t(lang, "back_button")}>←</button>
          <span>{num(at)} / {num(pages)}</span>
          <button type="button" disabled={at >= pages || busy} onClick={() => go(at + 1)}
                  aria-label={t(lang, "ui_show_more")}>→</button>
        </nav>
      ) : null}
    </>
  );
}
