/**
 * Cortex: сигналы по потоку среди отслеживаемых кошельков.
 *
 * Всё, что на экране, посчитал бот: уверенность — вероятность роста от
 * модели, причина — вклад признака именно в эту оценку. Приложение только
 * показывает.
 *
 * Уверенность идёт полосой с отметкой на 50%. Само по себе «61%» не значит
 * ничего: значит только расстояние от монетки, и без отметки человек читает
 * шесть десятых как «почти наверняка». То же у качества модели: AUC показан
 * на шкале, где видно и монетку, и порог, ниже которого модель в бой не
 * пускают.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t, title } from "../i18n/t";
import { num } from "../lib/format";
import { whyKey } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Meter, Row, SectionTitle, Segmented } from "../components/ui";
import type { Signal, Venue } from "../lib/types";

/** Порог приёмки модели: ниже него бот её в бой не пускает. */
const AUC_GATE = 0.55;

function SignalRow({ s, onOpen, lang }: {
  s: Signal;
  onOpen: () => void;
  lang: Parameters<typeof t>[0];
}) {
  const long = s.side === "buy";
  const top = s.why[0];
  const reason = top ? (whyKey(top.k) ? t(lang, whyKey(top.k)!) : top.k) : "";
  return (
    <button type="button" className="sig" onClick={onOpen}>
      <span className="sig-ico"><CoinIcon sym={s.sym} size={32} /></span>
      <span className="sig-main">
        <span className="sig-top">
          <b className="sig-sym">{s.sym}</b>
          <i className={`sig-side ${long ? "up" : "dn"}`}>
            {long ? t(lang, "ai_long") : t(lang, "ai_short")}
          </i>
          <em className={`sig-conf ${long ? "up" : "dn"}`}>{s.conf}%</em>
        </span>
        <span className="sig-meter">
          <Meter value={s.conf / 100} mark={0.5} tone={long ? "up" : "dn"} />
        </span>
        {/* Только главная причина: «много кошельков · 19 кошельков» и
            повторяется, и не влезает в 320 точек. Число кошельков — на
            карточке, вместе с остальными доводами. */}
        <span className="sig-sub">
          {reason || `${num(s.w)} ${t(lang, "flow_wallets")}`}
        </span>
      </span>
    </button>
  );
}

export function CortexTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const venue = useApp((s) => s.cortexVenue);
  const setVenue = useApp((s) => s.setCortexVenue);

  const cortex = useLive((s) => s.cortex);
  const model = venue === "perp" ? cortex.model?.perp : cortex.model?.spot;
  const ready = venue === "perp" ? cortex.ready.perp : cortex.ready.spot;
  const list = cortex.list.filter((s) => s.venue === venue);

  return (
    <>
      <Card>
        <SectionTitle note={t(lang, "ai_horizon")}>{t(lang, "ai_title")}</SectionTitle>
        <p className="note">{t(lang, "ai_hint").split("\n\n")[0]}</p>
        <Segmented<Venue>
          value={venue}
          onChange={setVenue}
          options={[
            { id: "spot", label: t(lang, "ai_spot") },
            { id: "perp", label: t(lang, "ai_perp") },
          ]}
        />
        {/* Состояние модели: обучена — её качество, нет — сколько исходов
            набралось из нужных. И то и другое — значение против предела. */}
        <button type="button" className="ora" onClick={() => open("model")}>
          <span className="ora-hd">
            <b>{model ? t(lang, "ai_mode_model") : t(lang, "ai_mode_formula")}</b>
            <em>{model ? `AUC ${model.auc.toFixed(3)}` : `${num(ready)} / ${num(cortex.need)}`}</em>
          </span>
          {model ? (
            <Meter
              value={model.auc}
              from={0.45}
              to={0.75}
              mark={0.5}
              markLabel={t(lang, "ai_st_coin")}
              tone={model.auc >= AUC_GATE ? "up" : "flat"}
              note={`${title(t(lang, "ai_st_acc"))} ${model.acc}% · ${num(model.samples)} ${t(lang, "ai_st_samples")}`}
            />
          ) : (
            <Meter value={ready} from={0} to={cortex.need} tone="flat"
                   note={title(t(lang, "ai_st_ready"))} />
          )}
        </button>
      </Card>

      <Card>
        {list.length === 0 ? (
          <Empty text={t(lang, "ui_no_signals")} hint={t(lang, "ai_empty")} />
        ) : (
          list.map((s, i) => (
            <SignalRow key={`${s.venue}-${s.sym}-${i}`} s={s} lang={lang}
                       onOpen={() => open("signal", `${s.venue}:${i}`)} />
          ))
        )}
      </Card>

      <Card>
        <Row
          title={t(lang, "ai_hist_btn")}
          sub={`${t(lang, "ai_hist_rate")} ${cortex.hist.of ? `${cortex.hist.hit}%` : "—"}`}
          value={cortex.hist.of ? num(cortex.hist.of) : "—"}
          onClick={() => open("history")}
        />
        <p className="note dim">{t(lang, "ai_trade_hint")}</p>
      </Card>
    </>
  );
}
