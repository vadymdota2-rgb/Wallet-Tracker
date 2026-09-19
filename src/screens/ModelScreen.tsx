/**
 * Состояние модели.
 *
 * Одной «точности» мало: при 54% роста в выборке прогноз «всегда вверх» даёт
 * те же 54%. Поэтому AUC показан на шкале, где отмечены и монетка, и порог,
 * ниже которого модель в бой не пускают.
 *
 * Главное на экране — три условия приёмки, словами и с галочкой у каждого.
 * Раньше тут стояли те же числа порознь: AUC на шкале, потери рядом с базой,
 * скользящая проверка отдельной строкой, — и человек видел три числа, но не
 * видел, какое из них не пустило модель в бой. Теперь у каждого условия
 * написано, сколько получилось и сколько нужно, а под ним — зачем оно.
 *
 * Скользящая проверка, которую ещё не считали, стоит не нулём: ноль читается
 * как измеренная неудача, а на деле примеров просто не хватило на несколько
 * отрезков. В этом случае строка так и говорит — и показывает, сколько
 * примеров есть из нужных.
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
import type { LangCode } from "../i18n/types";
import type { CortexModel, CortexTry } from "../lib/types";

/** Порог приёмки: ниже него бот модель в бой не пускает. */
const AUC_GATE = 0.55;
/** Порог скользящей проверки: те же ворота, но на нескольких отрезках. */
const WF_GATE = 0.52;

/**
 * Три условия приёмки словами. Знак рядом с каждым — не только цвет: зелёный
 * с красным различим не для всех глаз, а «✓» и «✗» читаются всегда.
 *
 * Знаков три, а не два. Условие, которое ещё не проверяли, — не провал:
 * скользящей проверке не хватило примеров, и крест рядом с ней говорил бы
 * неправду. У такого условия знак нейтральный и цвет тусклый.
 */
function Gates({ lang, auc, logloss, base, wf, samples, need }: {
  lang: LangCode;
  auc: number;
  logloss: number;
  base: number;
  wf: number;
  samples: number;
  need: number;
}) {
  /* Скользящая проверка требует вдвое больше примеров, чем первое обучение:
     выборку режут на отрезки, и на каждом учат заново. Пока их не набралось,
     бот возвращает ноль — но это «не считали», а не «вышло ноль». */
  const wfNone = samples < need;
  type Gate = { state: "ok" | "no" | "wait"; text: string; hint: string };
  const items: Gate[] = [
    {
      state: auc >= AUC_GATE ? "ok" : "no",
      text: t(lang, "ai_gate_auc", { v: auc.toFixed(3), need: AUC_GATE.toFixed(2) }),
      hint: t(lang, "ai_auc_hint"),
    },
    {
      state: logloss < base ? "ok" : "no",
      text: t(lang, "ai_gate_loss", { v: logloss.toFixed(3), need: base.toFixed(3) }),
      hint: t(lang, "ai_loss_hint"),
    },
    wfNone
      ? {
          state: "wait",
          text: t(lang, "ai_gate_wf_none", { n: num(samples), need: num(need) }),
          hint: t(lang, "ai_wf_hint"),
        }
      : {
          state: wf >= WF_GATE ? "ok" : "no",
          text: t(lang, "ai_gate_wf", { v: wf.toFixed(3), need: WF_GATE.toFixed(2) }),
          hint: t(lang, "ai_wf_hint"),
        },
  ];
  const MARK = { ok: "✓", no: "✗", wait: "…" } as const;
  return (
    <>
      <SectionTitle>{title(t(lang, "ai_gate_title"))}</SectionTitle>
      <ul className="gates">
        {items.map((it, i) => (
          <li key={i} className={it.state}>
            <i aria-hidden="true">{MARK[it.state]}</i>
            <span>
              <b>{it.text}</b>
              {/* Пояснение переносится, а не обрезается: «на четырёх отрезк…»
                  не объясняет ничего. */}
              <em>{it.hint}</em>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

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
       прошла порог. Во втором случае показываем, какое именно условие не
       выполнено, — иначе «не обучена» при полном счётчике не объясняет
       ничего. */
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
            <Gates lang={lang} auc={attempt.auc} logloss={attempt.logloss}
                   base={attempt.base} wf={attempt.wf}
                   samples={attempt.samples} need={need} />
            {/* Чем занят бот, пока условия не выполнены: сигналы не
                пропадают, их считает формула от волатильности. */}
            <p className="note dim">{t(lang, "ai_gate_else")}</p>
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
      <Tiles
        cols={3}
        size="sm"
        items={[
          { label: title(t(lang, "ai_st_acc")), value: `${m.acc}%`, tone: "up" },
          { label: t(lang, "ai_st_samples"), value: num(m.samples) },
          { label: t(lang, "ai_st_trees"), value: num(m.trees) },
        ]}
      />
      {/* Те же три условия и у принятой модели: список показывает, чем она их
          прошла. Рисовать из потерь и скользящей проверки полосы незачем —
          полоса из одного значения не говорит больше самого значения, а вот
          «столько получилось, столько нужно» говорит. */}
      <Gates lang={lang} auc={m.auc} logloss={m.logloss} base={m.base}
             wf={m.wf} samples={m.samples} need={need} />
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
