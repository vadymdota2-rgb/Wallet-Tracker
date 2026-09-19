/**
 * Состояние модели.
 *
 * Одной «точности» мало: при 54% роста в выборке прогноз «всегда вверх» даёт
 * те же 54%. Поэтому рядом всегда стоят AUC — упорядочивает ли модель события
 * лучше монетки, — потери против потерь постоянного прогноза и скользящая
 * проверка: среднее по четырём отрезкам времени, чтобы одна удачная неделя не
 * выдавала себя за умение. Числа с теста, которого модель при обучении не
 * видела.
 *
 * Пока модели нет, показываем не пустоту, а сколько исходов набралось: это
 * единственное, что в такой момент можно сказать честно.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { Card, Empty, Row, SectionTitle, Tiles } from "../components/ui";
import type { CortexModel } from "../lib/types";

function Venue({ m, title, ready, need }: {
  m: CortexModel | null | undefined;
  title: string;
  ready: number;
  need: number;
}) {
  const lang = useApp((s) => s.lang);
  if (!m) {
    return (
      <Card>
        <SectionTitle>{title}</SectionTitle>
        <Row title={t(lang, "ai_st_untrained")}
             sub={t(lang, "ai_st_ready")} value={`${num(ready)} / ${num(need)}`} />
      </Card>
    );
  }
  const hours = m.at ? Math.max(0, Math.round((Date.now() / 1000 - m.at) / 3600)) : 0;
  return (
    <Card>
      <SectionTitle note={`${num(m.trees)} ${t(lang, "ai_st_trees")}`}>{title}</SectionTitle>
      <Tiles
        cols={3}
        size="sm"
        items={[
          { label: "AUC", value: m.auc.toFixed(3) },
          { label: t(lang, "ai_acc"), value: `${m.acc}%` },
          { label: t(lang, "ai_st_samples"), value: num(m.samples) },
        ]}
      />
      <Row title={t(lang, "ai_st_loss")} sub={`${t(lang, "ai_st_base")} ${m.base.toFixed(3)}`}
           value={m.logloss.toFixed(3)} tone={m.logloss < m.base ? "up" : "dn"} />
      <Row title={t(lang, "ai_st_wf")} sub={`${num(m.test)} ${t(lang, "ai_st_samples")}`}
           value={m.wf.toFixed(3)} />
      {m.top?.length ? (
        <>
          <SectionTitle>{t(lang, "ai_st_top")}</SectionTitle>
          {m.top.slice(0, 5).map((f) => (
            <Row key={f.k} title={f.k} value={`${f.v}%`} />
          ))}
        </>
      ) : null}
      {hours > 0 ? (
        <p className="note dim">{`${hours} ${t(lang, "ai_hist_hours")}`}</p>
      ) : null}
    </Card>
  );
}

export function ModelScreen() {
  const lang = useApp((s) => s.lang);
  const cortex = useLive((s) => s.cortex);

  return (
    <Frame title={t(lang, "ai_st_title")}>
      <Card>
        <p className="note">{t(lang, "ai_hint")}</p>
      </Card>
      <Venue m={cortex.model?.spot} title={t(lang, "ai_spot")}
             ready={cortex.ready.spot} need={cortex.need} />
      <Venue m={cortex.model?.perp} title={t(lang, "ai_perp")}
             ready={cortex.ready.perp} need={cortex.need} />
      {!cortex.model?.spot && !cortex.model?.perp ? (
        <Card><Empty text={t(lang, "ai_mode_formula")} /></Card>
      ) : null}
    </Frame>
  );
}
