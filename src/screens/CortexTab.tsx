/**
 * Cortex: сигналы по потоку среди отслеживаемых кошельков.
 *
 * Всё, что на экране, посчитал бот: уверенность — вероятность роста от
 * модели, причины — вклад признаков именно в эту оценку. Приложение только
 * показывает. Прежняя версия считала то же самое второй раз в whale_api.py
 * своей формулой, и число «уверенности» не значило ничего.
 *
 * Переключателя окон 1ч/6ч/24ч больше нет. Модель обучена на суточном окне
 * потока и суточном горизонте; на часовом окне у неё не было ни одного
 * примера, и показывать её оценку там значило бы выдавать угадывание за счёт.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { whyKey, whySplit } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Row, SectionTitle, Segmented } from "../components/ui";
import type { Venue } from "../lib/types";

export function CortexTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const venue = useApp((s) => s.cortexVenue);
  const setVenue = useApp((s) => s.setCortexVenue);

  const cortex = useLive((s) => s.cortex);
  const model = venue === "perp" ? cortex.model?.perp : cortex.model?.spot;
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
        <Row
          title={model ? t(lang, "ai_mode_model") : t(lang, "ai_mode_formula")}
          sub={
            model
              ? `AUC ${model.auc.toFixed(3)}`
              : `${t(lang, "ai_st_ready")} ${num(venue === "perp" ? cortex.ready.perp : cortex.ready.spot)} / ${num(cortex.need)}`
          }
          value={model ? `${model.acc}%` : "—"}
          valueSub={t(lang, "ai_acc")}
          onClick={() => open("model")}
        />
      </Card>

      <Card>
        {list.length === 0 ? (
          <Empty text={t(lang, "ui_no_signals")} hint={t(lang, "ai_empty")} />
        ) : (
          list.map((s, i) => (
            <Row
              key={`${s.venue}-${s.sym}-${i}`}
              icon={<CoinIcon sym={s.sym} size={32} />}
              title={s.sym}
              badge={s.side === "buy" ? t(lang, "ai_long") : t(lang, "ai_short")}
              /* В строке — только главная причина оценки. Цена, число
                 кошельков и остальные доводы на карточке: по-русски
                 «12 кошельков · чистый поток» не влезает и в 390 точек, а
                 обрывок слова хуже, чем его отсутствие. */
              sub={
                s.why.length
                  ? (() => {
                      const { name } = whySplit(s.why[0] ?? "");
                      const k = whyKey(name);
                      return k ? t(lang, k) : name;
                    })()
                  : `${num(s.w)} ${t(lang, "flow_wallets")}`
              }
              value={`${s.conf}%`}
              tone={s.side === "buy" ? "up" : "dn"}
              valueSub={t(lang, "ai_conf")}
              onClick={() => open("signal", `${s.venue}:${i}`)}
            />
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
