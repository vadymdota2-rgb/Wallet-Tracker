/**
 * Состояние модели.
 *
 * Одной «точности» мало: при 54% роста в выборке прогноз «всегда вверх» даёт
 * те же 54%. Поэтому AUC показан на шкале, где отмечены и монетка, и порог,
 * ниже которого модель в бой не пускают, а потери стоят рядом с потерями
 * постоянного прогноза — без этой пары число 0.66 не значит ничего.
 *
 * Все числа — с теста, которого модель при обучении не видела. Пока модели
 * нет, показываем не пустоту, а сколько исходов набралось: это единственное,
 * что в такой момент можно сказать честно.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t, title } from "../i18n/t";
import { num } from "../lib/format";
import { Bars, Card, Meter, Row, SectionTitle, Tiles } from "../components/ui";
import type { CortexModel } from "../lib/types";

/** Порог приёмки: ниже него бот модель в бой не пускает. */
const AUC_GATE = 0.55;

function Venue({ m, name, ready, need }: {
  m: CortexModel | null | undefined;
  name: string;
  ready: number;
  need: number;
}) {
  const lang = useApp((s) => s.lang);
  if (!m) {
    return (
      <Card>
        <SectionTitle note={t(lang, "ai_st_untrained")}>{name}</SectionTitle>
        <Meter value={ready} from={0} to={need} tone="flat"
               label={title(t(lang, "ai_st_ready"))} note={`${num(ready)} / ${num(need)}`} />
      </Card>
    );
  }
  const hours = m.at ? Math.max(0, Math.round((Date.now() / 1000 - m.at) / 3600)) : 0;
  return (
    <Card>
      <SectionTitle note={hours > 0 ? `${hours} ${t(lang, "ai_hist_hours")}` : undefined}>
        {name}
      </SectionTitle>
      <Meter
        value={m.auc}
        from={0.45}
        to={0.75}
        mark={0.5}
        markLabel={t(lang, "ai_st_coin")}
        tone={m.auc >= AUC_GATE ? "up" : "flat"}
        label="AUC"
        note={m.auc.toFixed(3)}
      />
      <Tiles
        cols={3}
        size="sm"
        items={[
          { label: title(t(lang, "ai_st_acc")), value: `${m.acc}%` },
          { label: t(lang, "ai_st_samples"), value: num(m.samples) },
          { label: t(lang, "ai_st_trees"), value: num(m.trees) },
        ]}
      />
      {/* Потери и скользящая проверка — два числа, и рисовать из них график
          незачем: полоса из одного значения не говорит больше самого
          значения. Рядом с потерями всегда стоит база. */}
      <Row title={title(t(lang, "ai_st_loss"))}
           sub={`${t(lang, "ai_st_base")} ${m.base.toFixed(3)}`}
           value={m.logloss.toFixed(3)} tone={m.logloss < m.base ? "up" : "dn"} />
      <Row title={title(t(lang, "ai_st_wf"))}
           sub={`${num(m.test)} ${t(lang, "ai_st_samples")}`}
           value={m.wf.toFixed(3)} tone={m.wf >= 0.52 ? "up" : "dn"} />
      {m.top?.length ? (
        <>
          <SectionTitle>{title(t(lang, "ai_st_top"))}</SectionTitle>
          <Bars items={m.top.slice(0, 5).map((f) => ({
            name: f.k, value: f.v, label: `${f.v}%`,
          }))} />
        </>
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
      <Venue m={cortex.model?.spot} name={t(lang, "ai_spot")}
             ready={cortex.ready.spot} need={cortex.need} />
      <Venue m={cortex.model?.perp} name={t(lang, "ai_perp")}
             ready={cortex.ready.perp} need={cortex.need} />
    </Frame>
  );
}
