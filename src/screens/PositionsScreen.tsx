/** «Открытые позиции» — кнопка 📈 бота: все позиции всех кошельков сразу. */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { lev as levFmt, pct, px, signed } from "../lib/format";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, EyeGlyph, Row, SectionTitle } from "../components/ui";

export function PositionsScreen() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const wallets = useLive((s) => s.wallets);

  const rows = wallets.flatMap((w) => w.pos.map((p, i) => ({ w, p, i })));

  return (
    <Frame title={t(lang, "hl_open_positions")} sub={t(lang, "hl_positions_choose")}>
      <Card>
        {rows.length === 0 ? (
          <Empty text={t(lang, "hl_no_open_positions")} />
        ) : (
          <>
            <SectionTitle note={String(rows.length)}>{t(lang, "menu_positions")}</SectionTitle>
            {rows.map(({ w, p, i }) => (
              <Row
                key={`${w.addr}-${i}`}
                icon={<CoinIcon sym={p.sym} size={30} />}
                title={p.sym}
                badge={p.long ? t(lang, "hl_side_long") : t(lang, "hl_side_short")}
                sub={`${w.name} · ${levFmt(p.lev)} · ${t(lang, "hl_entry_price")} ${px(p.entry)}`}
                value={signed(p.pnl)}
                tone={p.pnl >= 0 ? "up" : "dn"}
                valueSub={pct(p.pct)}
                after={<EyeGlyph size={18} />}
                onClick={() => open("position", w.addr, String(i))}
              />
            ))}
          </>
        )}
      </Card>
    </Frame>
  );
}
