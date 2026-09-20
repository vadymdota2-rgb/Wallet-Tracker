/**
 * Состояние модели.
 *
 * Одной «точности» мало: при 54% роста в выборке прогноз «всегда вверх» даёт
 * те же 54%. Поэтому качество показано на шкале, где отмечены и монетка, и
 * порог, ниже которого модель в бой не пускают.
 *
 * Экран публичный, и слов вроде «AUC», «потери» и «скользящая проверка» на
 * нём нет. Числа остались — они честные, — но подписаны тем, что значат:
 * отличает ли рост от падения, велика ли ошибка её оценок, держится ли она
 * на разных отрезках времени. Аббревиатура ничего не объясняет тому, кто её
 * не знает, а тому, кто знает, — и так видно, что это за шкала.
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
 * Карточка — на каждый горизонт каждой площадки, а не на площадку. Моделей
 * у площадки две: шестичасовая и суточная, и живут они врозь — своя выборка,
 * свой порог хода, своя приёмка. Пока карточка была одна, показывалась та, у
 * которой AUC выше: принятая шестичасовая закрывала собой проваленную
 * суточную, и человек читал «модель принята», не зная, что половина сигналов
 * всё равно считается формулой.
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
import { whyKey } from "../lib/labels";
import { num } from "../lib/format";
import { Bars, Card, Meter, Row, SectionTitle, Tiles } from "../components/ui";
import type { LangCode } from "../i18n/types";
import type { CortexHz, CortexModel, CortexTry, Venue as VenueId } from "../lib/types";

/** Порог приёмки: ниже него бот модель в бой не пускает. */
const AUC_GATE = 0.55;
/** Порог скользящей проверки по среднему. */
const WF_GATE = 0.52;
/** И по худшей складке: одна удачная не должна вытаскивать остальные. */
const WF_WORST_GATE = 0.5;

/** Горизонты бота — те же числа, что ORACLE_H6 и ORACLE_H24 в oracle.cpp. */
const HZ = [21600, 86400];

/**
 * Горизонт словами: в шестнадцати языках единица стоит по-разному.
 *
 * Пробел внутри неразрывный. В заголовке рядом с именем площадки перенос
 * приходится как раз на него, и «HYPERLIQUID · 6» с одинокой «ч» на
 * следующей строке читается как обрывок. Рвать заголовок можно, но по
 * разделителю, а не посреди числа с единицей.
 */
function hzWords(lang: LangCode, sec: number): string {
  return t(lang, "ai_hours", { n: Math.max(1, Math.round(sec / 3600)) })
    .replace(/\s+/g, "\u00A0");
}

/**
 * Три условия приёмки словами. Знак рядом с каждым — не только цвет: зелёный
 * с красным различим не для всех глаз, а «✓» и «✗» читаются всегда.
 *
 * Знаков три, а не два. Условие, которое ещё не проверяли, — не провал:
 * скользящей проверке не хватило примеров, и крест рядом с ней говорил бы
 * неправду. У такого условия знак нейтральный и цвет тусклый.
 */
function Gates({ lang, auc, logloss, base, wf, wfMin, folds, samples, need }: {
  lang: LangCode;
  auc: number;
  logloss: number;
  base: number;
  wf: number;
  /** Худшая складка скользящей проверки. */
  wfMin?: number;
  /** Сколько отрезков отработало. Ноль — проверки не было. */
  folds?: number;
  samples: number;
  need: number;
}) {
  /* Проверка режет выборку на отрезки и на каждом учит заново; пока примеров
     мало, она не считается вовсе и бот возвращает ноль. Ноль читается как
     измеренная неудача, поэтому такой случай показывается словами.
     Смотрим и на число отрезков: примеров может хватать, а проверка всё
     равно не отработать — тогда ноль тем более не измерение. */
  const wfNone = samples < need || folds === 0;
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
          /* Проходит, только если и среднее, и худшая складка выше своих
             порогов: среднее одно скрывает случай «одна вытащила». */
          state: wf >= WF_GATE && (wfMin === undefined || wfMin >= WF_WORST_GATE)
            ? "ok" : "no",
          text: t(lang, "ai_gate_wf", { v: wf.toFixed(3), need: WF_GATE.toFixed(2) }),
          /* Вместо общих слов — само число худшей складки, когда оно есть:
             по нему и видно, на чём проверка споткнулась. */
          hint: wfMin === undefined
            ? t(lang, "ai_wf_hint")
            : t(lang, "ai_gate_wf_min", { v: wfMin.toFixed(3),
                                          need: WF_WORST_GATE.toFixed(2) }),
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
  /* Имена признаков переводятся здесь так же, как на карточке сигнала и
     вокруг мозга. Прежде сюда шло сырое `f.k`, и в русском интерфейсе под
     заголовком «Главные признаки» стояло «flow / vol 24h / RSI» — те же
     слова, что рядом на вкладке переведены. */
  const featName = (k: string) => {
    const key = whyKey(k);
    return key ? t(lang, key) : k;
  };
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
                   label={t(lang, "ai_st_quality")} note={attempt.auc.toFixed(3)} />
            <Gates lang={lang} auc={attempt.auc} logloss={attempt.logloss}
                   base={attempt.base} wf={attempt.wf} wfMin={attempt.wfMin}
                   folds={attempt.folds} samples={attempt.samples} need={need} />
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
        label={t(lang, "ai_st_quality")}
        note={m.auc.toFixed(3)}
      />
      {/* Сколько в модели деревьев — не дело читающего: это про её устройство,
          а не про то, стоит ли ей верить. Осталось то, что человек может
          соотнести с собой: как часто угадывает и на скольких примерах
          училась. */}
      <Tiles
        cols={2}
        size="sm"
        items={[
          { label: title(t(lang, "ai_st_acc")), value: `${m.acc}%`, tone: "up" },
          { label: t(lang, "ai_st_samples"), value: num(m.samples) },
        ]}
      />
      {/* Те же три условия и у принятой модели: список показывает, чем она их
          прошла. Рисовать из потерь и скользящей проверки полосы незачем —
          полоса из одного значения не говорит больше самого значения, а вот
          «столько получилось, столько нужно» говорит. */}
      <Gates lang={lang} auc={m.auc} logloss={m.logloss} base={m.base}
             wf={m.wf} wfMin={m.wfMin} folds={m.folds}
             samples={m.samples} need={need} />
      {/* Стоп и цели у модели свои, только когда она доказала, что угадывает
          ход лучше среднего. Иначе их считает формула от волатильности, и об
          этом честнее сказать. */}
      <Row title={t(lang, m.levels ? "ai_lv_model" : "ai_lv_formula")}
           value={m.levels ? "✓" : "—"} tone={m.levels ? "up" : undefined} />
      {m.top?.length ? (
        <>
          <SectionTitle>{title(t(lang, "ai_st_top"))}</SectionTitle>
          <Bars items={m.top.slice(0, 5).map((f) => ({
            name: featName(f.k), value: f.v, label: `${f.v}%`,
          }))} />
        </>
      ) : null}
    </Card>
  );
}

export function ModelScreen() {
  const lang = useApp((s) => s.lang);
  const cortex = useLive((s) => s.cortex);

  /* Разбор по горизонтам приходит с сервера. Если сервер старый и его нет,
     собираем те же две карточки из сводных полей: одна модель на площадку,
     горизонт берём из неё самой. Пустого экрана в этом случае быть не
     должно — он и так про то, чего ещё нет. */
  const rows = (v: VenueId): CortexHz[] => {
    const hz = cortex.hz?.[v];
    if (hz?.length) return [...hz].sort((a, b) => a.h - b.h);
    const m = v === "perp" ? cortex.model?.perp : cortex.model?.spot;
    const at = v === "perp" ? cortex.try?.perp : cortex.try?.spot;
    const ready = v === "perp" ? cortex.ready.perp : cortex.ready.spot;
    const h = m?.h ?? at?.h ?? HZ[HZ.length - 1]!;
    return [{ h, ready, model: m ?? null, try: at ?? null }];
  };

  return (
    <Frame title={t(lang, "ai_st_title")}>
      <Card>
        <p className="note">{t(lang, "ai_hint")}</p>
      </Card>
      {(["spot", "perp"] as const).flatMap((v) =>
        rows(v).map((r) => (
          <Venue
            key={`${v}-${r.h}`}
            m={r.model}
            attempt={r.try}
            /* Площадка и горизонт в одном заголовке: без горизонта две
               карточки одной площадки не отличить друг от друга. */
            name={`${venueName(v)} · ${hzWords(lang, r.h)}`}
            ready={r.ready}
            need={cortex.need}
          />
        )),
      )}
    </Frame>
  );
}
