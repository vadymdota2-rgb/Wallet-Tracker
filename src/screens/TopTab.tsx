/**
 * «Топ трейдеров» — кнопка 🏆 бота. Площадка, вид рейтинга и окно —
 * те же, что в hyperliquid_ui.cpp и ranking.cpp.
 *
 * Числа показываются ровно те, что отдал сервер. Прошлая версия умножала
 * прибыль на 1.85, 2.7 и 3.9, а доходность — на 0.72, 0.58 и 0.44 в
 * зависимости от выбранного окна, за окнами никуда не ходила, и люди
 * решали, за кем следовать, по несуществующим числам.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, shortAddr, signed } from "../lib/format";
import { holdTime } from "../lib/labels";
import { Card, Empty, Row, SectionTitle, Segmented } from "../components/ui";
import type { RankKind, RankTable, Trader, Venue } from "../lib/types";
import type { RankWin } from "../store/app";

const FREE_ROWS = 30;
const PREMIUM_ROWS = 100;

const KINDS: { id: RankKind; key: Parameters<typeof t>[1] }[] = [
  { id: "pnl", key: "rk_btn_top_pnl" },
  { id: "roi", key: "rk_btn_top_roi" },
  { id: "win", key: "rk_btn_top_winrate" },
  { id: "act", key: "rk_btn_most_active" },
];

/**
 * У спота доски ROI нет. Доходность считается от вложенного, а вложенное по
 * BSC собирается из цен DEX на момент покупки — половина монет куплена давно
 * и по ценам, которых уже не достать. Абсолютный PnL при этом остаётся
 * верным: он складывается из тех же сделок, но без деления на кривой
 * знаменатель. У фьючерсов иначе — там ROI считается от маржи, которую биржа
 * сообщает точно, поэтому доска остаётся.
 */
function kindsFor(venue: Venue): typeof KINDS {
  return venue === "spot" ? KINDS.filter((k) => k.id !== "roi") : KINDS;
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
  const kind = kinds.some((k) => k.id === rawKind) ? rawKind : "pnl";

  const table = pick(rank, venue, win);
  const cap = plan === "premium" ? PREMIUM_ROWS : FREE_ROWS;
  const rows: Trader[] = (table?.[kind] ?? []).slice(0, cap);

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
        <Segmented<Venue>
          value={venue}
          onChange={setVenue}
          options={[
            { id: "spot", label: t(lang, "hl_venue_spot") },
            { id: "perp", label: t(lang, "hl_venue_perp") },
          ]}
        />
        <Segmented<RankKind>
          value={kind}
          onChange={setKind}
          options={kinds.map((k) => ({ id: k.id, label: t(lang, k.key) }))}
        />
        <Segmented<RankWin>
          value={win}
          onChange={setWin}
          options={WINDOWS.map((w) => ({ id: w, label: `${w}${t(lang, "unit_day")}` }))}
        />
      </Card>

      <Card>
        {rows.length === 0 ? (
          <Empty
            text={table ? t(lang, "rk_no_completed_trades") : t(lang, "hl_rk_empty")}
            hint={t(lang, "rk_generating")}
          />
        ) : (
          rows.map((r, i) => {
            const hold = holdTime(r.hold, lang);
            return (
              <Row
                key={`${r.a}-${i}`}
                icon={<span className="rank-n">{i + 1}</span>}
                title={shortAddr(r.a)}
                sub={
                  <>
                    {num(r.tr)} {t(lang, "rk_trades")}
                    {r.win ? ` · ${num(r.win)}% ${t(lang, "ws_winrate")}` : ""}
                    {hold ? ` · ${hold}` : ""}
                    {r.lev ? ` · ${r.lev}×` : ""}
                  </>
                }
                value={value(r)}
                tone={kind === "pnl" ? (r.pnl >= 0 ? "up" : "dn") : undefined}
                onClick={() => open("trader", r.a, `${venue}:${win}:${kind}:${i}`)}
              />
            );
          })
        )}
        {plan !== "premium" && rows.length >= FREE_ROWS ? (
          <p className="note warn">{t(lang, "rk_unlock_top100")}</p>
        ) : null}
      </Card>
    </>
  );
}
