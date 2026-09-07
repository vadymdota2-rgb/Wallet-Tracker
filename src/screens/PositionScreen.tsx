/**
 * Одна позиция на Hyperliquid: плечо, маржа, ликвидация.
 *
 * Запас до ликвидации считается только когда есть и цена ликвидации, и
 * текущая. Прошлая версия делила без проверки и показывала «NaN%».
 */
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive, walletByAddr } from "../store/live";
import { t } from "../i18n/t";
import { lev as levFmt, num, pct, px, signed, usd } from "../lib/format";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, SectionTitle, Tiles } from "../components/ui";

export function PositionScreen({ arg, arg2 }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const wallets = useLive((s) => s.wallets);

  const w = walletByAddr(wallets, arg);
  const idx = Number(arg2 ?? -1);
  const p = w && Number.isInteger(idx) ? w.pos[idx] : undefined;

  if (!w || !p) {
    return (
      <Frame title={t(lang, "hl_open_positions")}>
        <Empty text={t(lang, "hl_no_open_positions")} />
      </Frame>
    );
  }

  const cushion =
    p.liq > 0 && p.now > 0 ? ((p.long ? p.now - p.liq : p.liq - p.now) / p.now) * 100 : null;
  const shareOfAccount = w.bal > 0 ? (p.margin / w.bal) * 100 : null;

  return (
    <Frame
      title={
        <span className="ttl-coin">
          <CoinIcon sym={p.sym} size={30} />
          {p.sym}
        </span>
      }
      sub={`${p.long ? t(lang, "hl_side_long") : t(lang, "hl_side_short")} · ${levFmt(p.lev)} · ${
        p.isolated ? t(lang, "hl_isolated") : t(lang, "hl_cross")
      }`}
    >
      <Card>
        <SectionTitle note={pct(p.pct)}>{t(lang, "hl_unrealized")}</SectionTitle>
        <p className={`big ${p.pnl >= 0 ? "up" : "dn"}`}>{signed(p.pnl)}</p>
        <Tiles
          items={[
            { label: t(lang, "hl_position_size"), value: usd(p.size) },
            { label: t(lang, "hl_collateral"), value: usd(p.margin) },
            { label: t(lang, "hl_entry_price"), value: px(p.entry) },
            { label: t(lang, "hl_mark_price"), value: px(p.now) },
          ]}
        />
      </Card>

      <Card>
        <SectionTitle>{t(lang, "hl_liq")}</SectionTitle>
        <Tiles
          items={[
            { label: t(lang, "hl_liq"), value: p.liq > 0 ? px(p.liq) : "—" },
            {
              label: t(lang, "hl_of_account"),
              value: shareOfAccount === null ? "—" : `${num(shareOfAccount, 1)}%`,
            },
            {
              label: t(lang, "hl_leverage"),
              value: levFmt(p.lev),
            },
            {
              // Запас до ликвидации, а не «риск»: подпись должна называть
              // ровно то, что показано.
              label: t(lang, "ui_to_liq"),
              value: cushion === null ? "—" : pct(cushion, 1, false),
              tone: cushion === null ? "dim" : cushion > 20 ? "up" : "dn",
            },
          ]}
        />
      </Card>
    </Frame>
  );
}
