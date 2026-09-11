/**
 * «Топ трейдеров» — кнопка 🏆 бота. Площадка, вид рейтинга и окно —
 * те же, что в hyperliquid_ui.cpp и ranking.cpp.
 *
 * Числа показываются ровно те, что отдал сервер. Прошлая версия умножала
 * прибыль на 1.85, 2.7 и 3.9, а доходность — на 0.72, 0.58 и 0.44 в
 * зависимости от выбранного окна, за окнами никуда не ходила, и люди
 * решали, за кем следовать, по несуществующим числам.
 *
 * Каждый трейдер — карточка со всеми цифрами доски, а не строка, за
 * которой надо проваливаться. Набор полей тот же, что бот пишет в своей
 * карточке: у спота срок удержания и нет доходности, у фьючерсов среднее
 * плечо и ROI от маржи.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t, bare } from "../i18n/t";
import { num, pct, shortAddr, signed } from "../lib/format";
import { holdTime } from "../lib/labels";
import { venueName } from "../lib/rank";
import { removeWallet } from "../lib/api";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { haptic } from "../lib/telegram";
import {
  Card, DealsGlyph, Empty, MinusGlyph, PlusGlyph, SectionTitle, Segmented, Tiles,
} from "../components/ui";
import type { RankKind, RankTable, Trader, Venue } from "../lib/types";
import type { RankWin } from "../store/app";

const FREE_ROWS = 30;
const PREMIUM_ROWS = 100;

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
  const wallets = useLive((s) => s.wallets);

  const kinds = kindsFor(venue);
  // Пользователь мог стоять на ROI и переключиться на спот: доски там нет,
  // показываем прибыль, а не пустой экран.
  const kind = kinds.includes(rawKind) ? rawKind : "pnl";

  const table = pick(rank, venue, win);
  const cap = plan === "premium" ? PREMIUM_ROWS : FREE_ROWS;
  const rows: Trader[] = (table?.[kind] ?? []).slice(0, cap);

  const tracked = new Set(wallets.map((w) => w.addr.toLowerCase()));

  const label = (k: RankKind): string => {
    if (k === "win") return t(lang, "ws_winrate");
    if (k === "act") return t(lang, "rk_trades");
    return k === "roi" ? "ROI" : "PnL";
  };

  const unfollow = async (addr: string) => {
    haptic("light");
    const res = await removeWallet(addr);
    if (res?.ok) {
      toast(t(lang, "toast_wallet_removed"));
      void syncNow();
    } else toast(t(lang, "generic_error_retry"), "err");
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

      {rows.length === 0 ? (
        <Card>
          <Empty
            text={table ? t(lang, "rk_no_completed_trades") : t(lang, "hl_rk_empty")}
            hint={t(lang, "rk_generating")}
          />
        </Card>
      ) : (
        rows.map((r, i) => {
          const place = i + 1;
          const hold = holdTime(r.hold, lang);
          const on = tracked.has((r.a || "").toLowerCase());
          return (
            <Card key={`${r.a}-${i}`}>
              <div className="lb-hd">
                <span className={place <= 3 ? `rank-n m${place}` : "rank-n"}>{place}</span>
                <span className="lb-addr mono">{shortAddr(r.a)}</span>
                {/* Подписка прямо из рейтинга: плюс спрашивает имя на
                    отдельном экране, где уже есть все проверки — лимит
                    плана, забаненные киты, повтор. Подписан — на том же
                    месте отписка. */}
                {/* История идёт первой: посмотреть, чем человек торгует,
                    логично до того, как на него подписываться. */}
                <button
                  type="button"
                  className="lb-act"
                  aria-label={t(lang, "ui_deals")}
                  onClick={() => {
                    haptic("select");
                    open("deals", r.a, venue);
                  }}
                >
                  <DealsGlyph size={20} />
                </button>
                <button
                  type="button"
                  className={on ? "lb-act off" : "lb-act on"}
                  aria-label={bare(t(lang, on ? "remove_yes" : "menu_add_wallet"))}
                  onClick={() => {
                    if (on) return void unfollow(r.a);
                    haptic("select");
                    open("addWallet", r.a);
                  }}
                >
                  {on ? <MinusGlyph size={20} /> : <PlusGlyph size={20} />}
                </button>
              </div>
              <Tiles
                cols={3}
                size="sm"
                items={[
                  { label: "PnL", value: signed(r.pnl), tone: r.pnl >= 0 ? "up" : "dn" },
                  ...(venue === "perp"
                    ? [{ label: t(lang, "rk_roi_per_trade"), value: pct(r.roi, 1) }]
                    : []),
                  { label: t(lang, "ws_winrate"), value: `${num(r.win)}%` },
                  { label: t(lang, "rk_trades"), value: num(r.tr) },
                  venue === "perp"
                    ? { label: t(lang, "hl_rk_leverage"), value: r.lev ? `${r.lev}×` : "—" }
                    : { label: t(lang, "rk_avg_hold"), value: hold ?? "—" },
                  ...(r.top
                    ? [{ label: bare(t(lang, "rk_in_top")), value: `${num(r.top)} ${t(lang, "rk_days")}` }]
                    : []),
                ]}
              />
            </Card>
          );
        })
      )}

      {plan !== "premium" && rows.length >= FREE_ROWS ? (
        <Card>
          <p className="note warn">{t(lang, "rk_unlock_top100")}</p>
        </Card>
      ) : null}
    </>
  );
}
