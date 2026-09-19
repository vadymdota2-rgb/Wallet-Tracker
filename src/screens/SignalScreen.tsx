/**
 * Карточка сигнала.
 *
 * Сверху — то, что модель вообще сказала: вероятность роста за сутки, полосой
 * с отметкой на 50%. Расстояние от отметки и есть весь смысл числа.
 *
 * Ниже — уровни, и рядом с ценой всегда расстояние в процентах: «стоп
 * $21 494» ничего не говорит, «−2.5%» говорит всё.
 *
 * В конце — вклад признаков в эту оценку, полосами в обе стороны от нуля.
 * Доводы против показываются наравне с доводами за: прятать их значило бы
 * рисовать модель увереннее, чем она есть.
 */
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, px, signed } from "../lib/format";
import { whyKey } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Diverging, Empty, Meter, Row, SectionTitle, Tiles } from "../components/ui";
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
  /* Вероятность роста: у продажи на экране стоит уверенность в падении, а
     шкала всегда про рост — иначе отметка «монетка» поедет вместе со
     стороной, и сравнивать два сигнала станет нельзя. */
  const pUp = long ? s.conf : 100 - s.conf;
  const away = (v: number) => (s.entry > 0 ? ((v - s.entry) / s.entry) * 100 : 0);

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
      } · ${t(lang, s.model ? "ai_mode_model" : "ai_mode_formula")}`}
    >
      <Card>
        <div className="hero">
          <div className="hero-main">
            <div className={`hero-val ${long ? "up" : "dn"}`}>{pUp}%</div>
            <div className="hero-note">{t(lang, "ai_p_up")}</div>
          </div>
        </div>
        <Meter
          value={pUp / 100}
          mark={0.5}
          markLabel={t(lang, "ai_st_coin")}
          tone={pUp >= 50 ? "up" : "dn"}
        />
      </Card>

      <Card>
        <Tiles
          items={[
            { label: t(lang, "ai_entry"), value: px(s.entry) },
            { label: t(lang, "ai_stop"), value: px(s.stop), tone: "dn" },
            { label: `${t(lang, "ai_take_one")} 1`, value: px(s.t1), tone: "up" },
            { label: `${t(lang, "ai_take_one")} 2`, value: px(s.t2), tone: "up" },
          ]}
        />
        <Diverging
          items={[
            { name: t(lang, "ai_stop"), value: away(s.stop), label: pct(away(s.stop), 1) },
            { name: `${t(lang, "ai_take_one")} 1`, value: away(s.t1), label: pct(away(s.t1), 1) },
            { name: `${t(lang, "ai_take_one")} 2`, value: away(s.t2), label: pct(away(s.t2), 1) },
          ]}
        />
        <Tiles
          size="sm"
          items={[
            { label: t(lang, "ai_risk"), value: pct(s.stopPct, 1, false) },
            { label: t(lang, "hl_leverage"), value: venue === "perp" ? `${s.lev}×` : "1×" },
            { label: t(lang, "flow_wallets"), value: num(s.w) },
            /* Сырой поток за сутки — не то же, что вклад признака «поток» в
               оценку: первое в долларах, второе в процентных пунктах. */
            { label: t(lang, "flow_title"), value: signed(s.net),
              tone: s.net >= 0 ? "up" : "dn" },
          ]}
        />
      </Card>

      <Card>
        <SectionTitle>{t(lang, "ai_why")}</SectionTitle>
        {s.why.length === 0 ? (
          <p className="note dim">{t(lang, "ai_st_untrained")}</p>
        ) : (
          <Diverging
            items={s.why.map((w) => {
              const k = whyKey(w.k);
              return {
                name: k ? t(lang, k) : w.k,
                value: w.v,
                label: `${w.v >= 0 ? "+" : "−"}${Math.abs(w.v).toFixed(1)}`,
              };
            })}
          />
        )}
        <p className="note dim">{t(lang, "ai_trade_hint")}</p>
      </Card>

      <Card>
        <Row title={t(lang, "flow_title")} onClick={() => open("coin", s.sym)} value="→" />
      </Card>
    </Frame>
  );
}
