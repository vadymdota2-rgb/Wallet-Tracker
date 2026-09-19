/**
 * Состояние модели.
 *
 * Показываем не одну «точность»: при шестидесяти процентах роста в выборке
 * прогноз «всегда вверх» даёт те же шестьдесят, и число это ничего не значит.
 * Рядом всегда стоят AUC (упорядочивает ли модель события лучше монетки),
 * потери против потерь постоянного прогноза и скользящая проверка — среднее
 * по четырём отрезкам времени, чтобы одна удачная неделя не выдавала себя
 * за умение.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { Card, Row, SectionTitle, Tiles } from "../components/ui";
import type { CortexModel } from "../lib/types";

function Model({ m, title }: { m: CortexModel | null | undefined; title: string }) {
  const lang = useApp((s) => s.lang);
  if (!m) return null;
  const hours = m.at ? Math.max(0, Math.round((Date.now() / 1000 - m.at) / 3600)) : 0;
  return (
    <Card>
      <SectionTitle note={`${num(m.trees)} ${t(lang, "ai_st_trees")}`}>{title}</SectionTitle>
      <Tiles
        cols={3}
        size="sm"
        items={[
          { label: "AUC", value: m.auc.toFixed(3) },
          { label: t(lang, "ai_st_acc").replace(":", ""), value: `${m.acc}%` },
          { label: t(lang, "ai_st_samples"), value: num(m.samples) },
        ]}
      />
      <Row title={t(lang, "ai_st_loss")} sub={`${t(lang, "ai_st_base")} ${m.base.toFixed(3)}`}
           value={m.logloss.toFixed(3)} />
      <Row title={t(lang, "ai_st_wf")} sub={`${num(m.test)} ${t(lang, "ai_st_samples")}`}
           value={m.wf.toFixed(3)} />
      {hours > 0 ? (
        <Row title={t(lang, "ai_mode_model")} sub={`${hours} ${t(lang, "ai_hist_hours")}`} value="" />
      ) : null}
    </Card>
  );
}

export function ModelScreen() {
  const lang = useApp((s) => s.lang);
  const cortex = useLive((s) => s.cortex);
  const model = cortex.model;

  return (
    <Frame title={t(lang, "ai_st_title")}>
      <Card>
        <p className="note">{t(lang, "ai_hint")}</p>
      </Card>
      <Card>
        <SectionTitle note={t(lang, "ai_st_samples")}>{t(lang, "ai_st_ready")}</SectionTitle>
        <Tiles
          items={[
            { label: t(lang, "ai_spot"), value: `${num(cortex.ready.spot)} / ${num(cortex.need)}` },
            { label: t(lang, "ai_perp"), value: `${num(cortex.ready.perp)} / ${num(cortex.need)}` },
          ]}
        />
      </Card>
      <Card>
        <SectionTitle>{t(lang, "ai_st_acc")}</SectionTitle>
        <Row
          title={t(lang, "ai_spot")}
          sub={cortex.trainedSpot ? t(lang, "ai_mode_model") : t(lang, "ai_st_untrained")}
          value={cortex.accSpot === null ? "—" : `${cortex.accSpot}%`}
        />
        <Row
          title={t(lang, "ai_perp")}
          sub={cortex.trainedPerp ? t(lang, "ai_mode_model") : t(lang, "ai_st_untrained")}
          value={cortex.accPerp === null ? "—" : `${cortex.accPerp}%`}
        />
      </Card>
      <Model m={model?.spot} title={t(lang, "ai_spot")} />
      <Model m={model?.perp} title={t(lang, "ai_perp")} />
    </Frame>
  );
}
