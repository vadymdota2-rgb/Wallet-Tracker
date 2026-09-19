/** Карточка сигнала: вход, стоп, цели, уверенность, основания. */
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, px, signed } from "../lib/format";
import { whyKey, whySplit } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Row, SectionTitle, Tiles } from "../components/ui";
import type { Venue } from "../lib/types";

export function SignalScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const cortex = useLive((s) => s.cortex);

  const [venueRaw, idxRaw] = String(arg || "").split(":");
  const venue = (venueRaw === "perp" ? "perp" : "spot") as Venue;
  const idx = Number(idxRaw);

  const list = cortex.list.filter((s) => s.venue === venue);
  const s = list[idx];

  if (!s) {
    return (
      <Frame title={t(lang, "ai_title")}>
        <Empty text={t(lang, "ui_no_signals")} />
      </Frame>
    );
  }

  const long = s.side === "buy";

  return (
    <Frame
      title={
        <span className="ttl-coin">
          <CoinIcon sym={s.sym} size={30} />
          {s.sym}
        </span>
      }
      sub={`${long ? t(lang, "ai_long") : t(lang, "ai_short")} · ${
        venue === "perp" ? t(lang, "ai_perp") : t(lang, "ai_spot")
      } · ${t(lang, "ai_horizon")} · ${t(lang, s.model ? "ai_mode_model" : "ai_mode_formula")}`}
    >
      <Card>
        <SectionTitle note={t(lang, "ai_conf")}>
          <span className={long ? "up" : "dn"}>{s.conf}%</span>
        </SectionTitle>
        <Tiles
          items={[
            { label: t(lang, "ai_entry"), value: px(s.entry) },
            { label: t(lang, "ai_stop"), value: px(s.stop), tone: "dn" },
            { label: `${t(lang, "ai_take")} 1`, value: px(s.t1), tone: "up" },
            { label: `${t(lang, "ai_take")} 2`, value: px(s.t2), tone: "up" },
          ]}
        />
        <Tiles
          items={[
            { label: t(lang, "ai_risk"), value: pct(s.stopPct, 1, false) },
            { label: t(lang, "hl_leverage"), value: venue === "perp" ? `${s.lev}×` : "1×" },
            { label: t(lang, "flow_wallets"), value: num(s.w) },
            { label: t(lang, "ai_why_flow"), value: signed(s.net),
              tone: s.net >= 0 ? "up" : "dn" },
          ]}
        />
      </Card>

      <Card>
        <SectionTitle>{t(lang, "ai_why")}</SectionTitle>
        {s.why.length === 0 ? (
          <p className="note dim">{t(lang, "ai_st_untrained")}</p>
        ) : (
          s.why.map((w, i) => {
            const { up, name } = whySplit(w);
            const k = whyKey(name);
            /* Знак — за сигнал признак или против него. Показывать только
               доводы «за» значило бы рисовать модель умнее, чем она есть. */
            return (
              <Row key={i} title={k ? t(lang, k) : name} value={up ? "+" : "−"}
                   tone={up ? "up" : "dn"} />
            );
          })
        )}
        <p className="note dim">{t(lang, "ai_trade_hint")}</p>
      </Card>

      <Card>
        <Row title={t(lang, "flow_title")} onClick={() => open("coin", s.sym)} value="→" />
      </Card>
    </Frame>
  );
}
