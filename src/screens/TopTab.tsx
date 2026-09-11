/**
 * «Топ трейдеров» — кнопка 🏆 бота. Площадка, вид рейтинга и окно —
 * те же, что в hyperliquid_ui.cpp и ranking.cpp.
 *
 * Числа показываются ровно те, что отдал сервер. Прошлая версия умножала
 * прибыль на 1.85, 2.7 и 3.9, а доходность — на 0.72, 0.58 и 0.44 в
 * зависимости от выбранного окна, за окнами никуда не ходила, и люди
 * решали, за кем следовать, по несуществующим числам.
 *
 * Спотовая доска — на тысячу мест. Первая сотня приходит с общей выгрузкой
 * и рисуется сразу, остальное догружается кнопкой: держать тысячу строк на
 * каждую доску и каждое окно в стартовом ответе — это мегабайты при каждом
 * запуске ради страниц, куда заходят единицы.
 */
import { useEffect, useRef, useState } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, shortAddr, signed } from "../lib/format";
import { venueName } from "../lib/rank";
import { fetchRankPage } from "../lib/api";
import { Action, Card, Empty, Row, SectionTitle, Segmented } from "../components/ui";
import type { RankKind, RankTable, Trader, Venue } from "../lib/types";
import type { RankWin } from "../store/app";

const FREE_ROWS = 30;
/** Столько приходит с общей выгрузкой — дальше идёт догрузка. */
const BOOTSTRAP_ROWS = 100;
const PAGE = 100;
const MAX_ROWS = 1000;

/** Ключ доски на сервере: там они названы как в боте. */
const SERVER_KIND: Record<RankKind, string> = {
  pnl: "pnl",
  roi: "roi",
  win: "winrate",
  act: "active",
};

const KINDS: RankKind[] = ["pnl", "roi", "win", "act"];

/**
 * У спота доски ROI нет. Доходность считается от вложенного, а вложенное по
 * BSC собирается из цен DEX на момент покупки — половина монет куплена давно
 * и по ценам, которых уже не достать. Абсолютный PnL при этом остаётся
 * верным: он складывается из тех же сделок, но без деления на кривой
 * знаменатель. У фьючерсов иначе — там ROI считается от маржи, которую биржа
 * сообщает точно, поэтому доска остаётся.
 */
function kindsFor(venue: Venue): RankKind[] {
  return venue === "spot" ? KINDS.filter((k) => k !== "roi") : KINDS;
}

const WINDOWS: RankWin[] = ["30", "90", "180", "365"];

function pick(rank: ReturnType<typeof useLive.getState>["rank"], venue: Venue, win: RankWin): RankTable | null {
  if (win === "30") return rank[venue];
  const table = rank.wins?.[win]?.[venue];
  if (!table) return null;
  const any = table.pnl.length || table.roi.length || table.win.length || table.act.length;
  return any ? table : null;
}

export function TopTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const venue = useApp((s) => s.rankVenue);
  const rawKind = useApp((s) => s.rankKind);
  const win = useApp((s) => s.rankWin);
  const setVenue = useApp((s) => s.setRankVenue);
  const setKind = useApp((s) => s.setRankKind);
  const setWin = useApp((s) => s.setRankWin);

  const rank = useLive((s) => s.rank);
  const plan = useLive((s) => s.me.plan);

  const kinds = kindsFor(venue);
  // Пользователь мог стоять на ROI и переключиться на спот: доски там нет,
  // показываем прибыль, а не пустой экран.
  const kind = kinds.includes(rawKind) ? rawKind : "pnl";

  /* Догруженные страницы. Ключ — доска целиком: сменил площадку, вид или
     окно — и это уже другой список, склеивать их нельзя. */
  const board = `${venue}:${kind}:${win}`;
  const [extra, setExtra] = useState<Trader[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const shownBoard = useRef(board);

  useEffect(() => {
    // Доска сменилась — прошлые страницы к ней отношения не имеют.
    shownBoard.current = board;
    setExtra([]);
    setTotal(0);
  }, [board]);

  const label = (k: RankKind): string => {
    if (k === "win") return t(lang, "ws_winrate");
    if (k === "act") return t(lang, "rk_trades");
    return k === "roi" ? "ROI" : "PnL";
  };

  const base = table(rank, venue, win, kind);
  const cap = plan === "premium" ? MAX_ROWS : FREE_ROWS;
  const rows: Trader[] = [...base, ...extra].slice(0, cap);

  /* Кнопка нужна только там, где есть что грузить: страницы лежат в кэше
     спотовой доски, у фьючерсов рейтинг считается на лету. */
  const pageable = venue === "spot" && plan === "premium";
  const more = pageable && rows.length >= BOOTSTRAP_ROWS && (total === 0 || rows.length < total);

  const loadMore = async () => {
    if (busy) return;
    setBusy(true);
    const forBoard = board;
    try {
      const res = await fetchRankPage(SERVER_KIND[kind], win, rows.length, PAGE);
      // Пока грузили, пользователь мог переключить доску — чужие строки
      // дописывать в неё нельзя.
      if (shownBoard.current !== forBoard || !res?.ok || !res.rows?.length) {
        if (shownBoard.current === forBoard) setTotal(rows.length);
        return;
      }
      setExtra((prev) => [...prev, ...(res.rows ?? [])]);
      setTotal(res.total ?? 0);
    } finally {
      setBusy(false);
    }
  };

  const value = (r: Trader): string => {
    if (kind === "roi") return pct(r.roi, 1);
    if (kind === "win") return `${num(r.win)}%`;
    if (kind === "act") return num(r.tr);
    return signed(r.pnl);
  };

  return (
    <>
      <Card>
        <SectionTitle note={t(lang, "hl_venue")}>{t(lang, "hl_venue_title")}</SectionTitle>
        {/* Подписи короткие: полные («BSC — Спот», «Топ по винрейту») не
            помещались в ряд и уезжали за край, а прокрутку внутри полосы
            переключателей никто не ищет. */}
        <Segmented<Venue>
          value={venue}
          onChange={setVenue}
          options={[
            { id: "spot", label: venueName("spot") },
            { id: "perp", label: venueName("perp") },
          ]}
        />
        <Segmented<RankKind>
          value={kind}
          onChange={setKind}
          options={kinds.map((k) => ({ id: k, label: label(k) }))}
        />
        <Segmented<RankWin>
          value={win}
          onChange={setWin}
          options={WINDOWS.map((w) => ({ id: w, label: `${w}${t(lang, "unit_day")}` }))}
        />
      </Card>

      <Card>
        {/* Шапка повторяет выбор — площадку и доску, — а справа стоит
            глубина: «100 / 1000» сразу говорит, что список длиннее
            показанного. Слово «Место» в шапке читалось как «место 100». */}
        <SectionTitle note={rows.length ? `${num(rows.length)}${total > rows.length ? ` / ${num(total)}` : ""}` : undefined}>
          {`${venueName(venue)} · ${label(kind)}`}
        </SectionTitle>
        {rows.length === 0 ? (
          <Empty
            text={base.length === 0 && pick(rank, venue, win) ? t(lang, "rk_no_completed_trades") : t(lang, "hl_rk_empty")}
            hint={t(lang, "rk_generating")}
          />
        ) : (
          rows.map((r, i) => {
            const place = i + 1;
            return (
              <Row
                key={`${r.a}-${i}`}
                icon={
                  <span className={place <= 3 ? `rank-n m${place}` : "rank-n"}>
                    {place}
                  </span>
                }
                title={shortAddr(r.a)}
                /* Два факта, а не четыре. На 360 пикселях подпись из
                   четырёх обрывалась многоточием у восьмидесяти строк из
                   ста, и обрывалось как раз последнее — то, ради чего его и
                   добавляли. Срок удержания и плечо остались в карточке
                   трейдера, куда строка и ведёт. */
                sub={
                  <>
                    {num(r.tr)} {t(lang, "rk_trades")}
                    {r.win ? ` · ${num(r.win)}%` : ""}
                  </>
                }
                value={value(r)}
                tone={kind === "pnl" ? (r.pnl >= 0 ? "up" : "dn") : undefined}
                onClick={() => open("trader", r.a, `${venue}:${win}:${kind}:${i}`)}
              />
            );
          })
        )}
        {more ? (
          <Action kind="ghost" disabled={busy} onClick={loadMore}>
            {t(lang, "ui_show_more")}
          </Action>
        ) : null}
        {plan !== "premium" && rows.length >= FREE_ROWS ? (
          <p className="note warn">{t(lang, "rk_unlock_top100")}</p>
        ) : null}
      </Card>
    </>
  );
}

/** Строки выбранной доски из общей выгрузки. */
function table(
  rank: ReturnType<typeof useLive.getState>["rank"],
  venue: Venue,
  win: RankWin,
  kind: RankKind,
): Trader[] {
  return pick(rank, venue, win)?.[kind] ?? [];
}
