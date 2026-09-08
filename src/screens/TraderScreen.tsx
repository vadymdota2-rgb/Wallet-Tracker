/** Трейдер из рейтинга: показатели за выбранное окно и кнопка «отслеживать». */
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, shortAddr, signed } from "../lib/format";
import { holdTime } from "../lib/labels";
import { addWallet } from "../lib/api";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { Action, Card, Empty, SectionTitle, Tiles } from "../components/ui";
import type { RankKind, RankTable, Venue } from "../lib/types";
import type { RankWin } from "../store/app";

export function TraderScreen({ arg, arg2 }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const back = useApp((s) => s.back);
  const rank = useLive((s) => s.rank);
  const wallets = useLive((s) => s.wallets);

  const addr = String(arg || "");
  const [venueRaw, winRaw, kindRaw, idxRaw] = String(arg2 || "").split(":");
  const venue = (venueRaw === "perp" ? "perp" : "spot") as Venue;
  const win = (winRaw || "30") as RankWin;
  const kind = (kindRaw || "pnl") as RankKind;
  const idx = Number(idxRaw);

  const table: RankTable | undefined = win === "30" ? rank[venue] : rank.wins?.[win]?.[venue];
  const row = table?.[kind]?.[idx];
  const tracked = wallets.some((w) => w.addr.toLowerCase() === addr.toLowerCase());

  if (!row) {
    return (
      <Frame title={shortAddr(addr)}>
        <Empty text={t(lang, "rk_generating")} />
      </Frame>
    );
  }

  const hold = holdTime(row.hold, lang);

  return (
    <Frame
      title={shortAddr(addr)}
      sub={`${venue === "perp" ? t(lang, "hl_venue_perp") : t(lang, "hl_venue_spot")} · ${win} ${t(lang, "rk_days")}`}
    >
      <Card>
        <SectionTitle note={`${t(lang, "rk_in_top")} ${idx + 1}`}>{t(lang, "hl_venue_title")}</SectionTitle>
        <Tiles
          items={[
            { label: "PnL", value: signed(row.pnl), tone: row.pnl >= 0 ? "up" : "dn" },
            { label: t(lang, "rk_roi_per_trade"), value: pct(row.roi, 1) },
            { label: t(lang, "ws_winrate"), value: `${num(row.win)}%` },
            { label: t(lang, "rk_trades"), value: num(row.tr) },
            venue === "perp"
              ? { label: t(lang, "hl_rk_leverage"), value: row.lev ? `${row.lev}×` : "—" }
              : { label: t(lang, "rk_avg_hold"), value: hold ?? "—" },
            ...(row.top
              ? [{
                  label: t(lang, "rk_in_top"),
                  value: `${num(row.top)} ${t(lang, "rk_days")}`,
                }]
              : []),
          ]}
        />
      </Card>

      <Card>
        <div className="stack-actions">
          <Action
            disabled={tracked}
            onClick={async () => {
              const res = await addWallet(addr, `${t(lang, "rk_track")} #${idx + 1}`);
              if (res?.ok) {
                toast(t(lang, "wc_track_done"));
                back();
                void syncNow();
              } else if (res?.error === "limit") {
                toast(t(lang, "limit_50_reached"), "err");
              } else if (res?.error === "dup") {
                toast(t(lang, "already_tracking"), "err");
              } else {
                toast(t(lang, "generic_error_retry"), "err");
              }
            }}
          >
            {tracked ? t(lang, "wc_tracked_btn") : t(lang, "rk_track")}
          </Action>
        </div>
      </Card>
    </Frame>
  );
}
