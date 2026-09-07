/**
 * История сигналов. Пока нет завершённых — так и написано.
 * Прошлая версия показывала нули как статистику.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct } from "../lib/format";
import { ago } from "../lib/relative";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Row, SectionTitle, Tiles } from "../components/ui";

export function HistoryScreen() {
  const lang = useApp((s) => s.lang);
  const hist = useLive((s) => s.sonar.hist);

  if (!hist.of) {
    return (
      <Frame title={t(lang, "ai_hist_title")}>
        <Card>
          <Empty text={t(lang, "ai_hist_empty")} />
        </Card>
      </Frame>
    );
  }

  return (
    <Frame title={t(lang, "ai_hist_title")} sub={`${num(hist.of)}`}>
      <Card>
        <Tiles
          items={[
            { label: t(lang, "ai_hist_rate"), value: `${hist.hit}%` },
            { label: t(lang, "ai_hist_avg"), value: pct(hist.avg) },
            { label: t(lang, "ai_hist_tp"), value: num(hist.tp), tone: "up" },
            { label: t(lang, "ai_hist_sl"), value: num(hist.sl), tone: "dn" },
          ]}
        />
      </Card>
      <Card>
        <SectionTitle note={t(lang, "ai_hist_plans")}>{t(lang, "ai_hist_title")}</SectionTitle>
        {hist.items.map((it, i) => (
          <Row
            key={i}
            icon={<CoinIcon sym={it.sym} size={30} />}
            title={it.sym}
            badge={it.long ? t(lang, "ai_long") : t(lang, "ai_short")}
            sub={`${it.venue === "perp" ? t(lang, "ai_perp") : t(lang, "ai_spot")} · ${ago(it.t)}`}
            value={pct(it.ret)}
            tone={it.win ? "up" : "dn"}
          />
        ))}
      </Card>
    </Frame>
  );
}
