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
import { venueName } from "../lib/rank";
import { num } from "../lib/format";
import { Bars, Card, Meter, Row, SectionTitle, Tiles } from "../components/ui";
import type { CortexModel, CortexTry } from "../lib/types";

/** Порог приёмки: ниже него бот модель в бой не пускает. */
const AUC_GATE = 0.55;

function Venue({ m, attempt, name, ready, need }: {
  m: CortexModel | null | undefined;
  attempt: CortexTry | null | undefined;
  name: string;
  ready: number;
  need: number;
}) {
  const lang = useApp((s) => s.lang);
  if (!m) {
    /* Модели нет по двум разным причинам: исходов ещё мало или модель не
       прошла порог. Во втором случае показываем, насколько не дотянула, —
       иначе «не обучена» при полном счётчике не объясняет ничего. */
    return (
      <Card>
        <SectionTitle note={attempt ? t(lang, "ai_not_passed") : t(lang, "ai_st_untrained")}>
          {name}
        </SectionTitle>
        {attempt ? (
          <>
            <Meter value={attempt.auc} from={0.45} to={0.75} mark={AUC_GATE}
                   markLabel={t(lang, "ai_st_gate")} tone="flat"
                   label="AUC" note={attempt.auc.toFixed(3)} />
            <p className="note dim">{t(lang, "ai_auc_hint")}</p>
            <Row title={title(t(lang, "ai_st_loss"))}
                 sub={`${t(lang, "ai_st_base")} ${attempt.base.toFixed(3)} · ${t(lang, "ai_loss_hint")}`}
                 value={attempt.logloss.toFixed(3)}
                 tone={attempt.logloss < attempt.base ? "up" : "dn"} />
            <Row title={title(t(lang, "ai_st_wf"))} sub={t(lang, "ai_wf_hint")}
                 value={attempt.wf.toFixed(3)} tone={attempt.wf >= 0.52 ? "up" : "dn"} />
          </>
        ) : (
          <Meter value={ready} from={0} to={need} tone="flat"
                 label={title(t(lang, "ai_st_ready"))} note={`${num(ready)} / ${num(need)}`} />
        )}
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
      {/* Каждое число объяснено строкой под ним: без этого экран читает
          только тот, кто и так знает, что такое AUC. */}
      <p className="note dim">{t(lang, "ai_auc_hint")}</p>
      <Tiles
        cols={3}
        size="sm"
        items={[
          { label: title(t(lang, "ai_st_acc")), value: `${m.acc}%`, tone: "up" },
          { label: t(lang, "ai_st_samples"), value: num(m.samples) },
          { label: t(lang, "ai_st_trees"), value: num(m.trees) },
        ]}
      />
      {/* Потери и скользящая проверка — два числа, и рисовать из них график
          незачем: полоса из одного значения не говорит больше самого
          значения. Рядом с потерями всегда стоит база. */}
      <Row title={title(t(lang, "ai_st_loss"))}
           sub={`${t(lang, "ai_st_base")} ${m.base.toFixed(3)} · ${t(lang, "ai_loss_hint")}`}
           value={m.logloss.toFixed(3)} tone={m.logloss < m.base ? "up" : "dn"} />
      <Row title={title(t(lang, "ai_st_wf"))} sub={t(lang, "ai_wf_hint")}
           value={m.wf.toFixed(3)} tone={m.wf >= 0.52 ? "up" : "dn"} />
      {/* Стоп и цели у модели свои, только когда она доказала, что угадывает
          ход лучше среднего. Иначе их считает формула от волатильности, и об
          этом честнее сказать. */}
      <Row title={t(lang, m.levels ? "ai_lv_model" : "ai_lv_formula")}
           value={m.levels ? "✓" : "—"} tone={m.levels ? "up" : undefined} />
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
      <Venue m={cortex.model?.spot} attempt={cortex.try?.spot} name={venueName("spot")}
             ready={cortex.ready.spot} need={cortex.need} />
      <Venue m={cortex.model?.perp} attempt={cortex.try?.perp} name={venueName("perp")}
             ready={cortex.ready.perp} need={cortex.need} />
    </Frame>
  );
}
