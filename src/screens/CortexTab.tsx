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
import { cortexList } from "../lib/cortex";
import { Brain } from "../components/Brain";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Meter, Row, SectionTitle, Segmented } from "../components/ui";
import type { CortexSide } from "../store/app";
import type { Cortex, Signal, Venue } from "../lib/types";

/** Порог приёмки модели: ниже него бот её в бой не пускает. */
const AUC_GATE = 0.55;

/** Состояние модели одной площадки: обучена — её качество, нет — сколько
 *  исходов набралось из нужных. И то и другое — значение против предела. */
function ModelRow({ venue, lang, cortex, onOpen }: {
  venue: Venue;
  lang: Parameters<typeof t>[0];
  cortex: Cortex;
  onOpen: () => void;
}) {
  const model = venue === "perp" ? cortex.model?.perp : cortex.model?.spot;
  const attempt = model ? null : (venue === "perp" ? cortex.try?.perp : cortex.try?.spot);
  const ready = venue === "perp" ? cortex.ready.perp : cortex.ready.spot;
  return (
    <button type="button" className="ora" onClick={onOpen}>
      {/* На главном экране — словами. AUC и потери никому ни о чём не
          говорят; кому надо, тот откроет состояние модели. */}
      <b className="ora-ttl">
        {t(lang, venue === "perp" ? "ai_perp" : "ai_spot")} ·{" "}
        {model ? t(lang, "ai_model_ok")
               : (attempt ? t(lang, "ai_not_passed") : t(lang, "ai_collecting"))}
      </b>
      {model ? (
        <Meter
          value={model.acc / 100}
          mark={0.5}
          markLabel={t(lang, "ai_st_coin")}
          tone="up"
          label={t(lang, "ai_hits_of", { n: model.acc })}
          note={`${num(model.samples)} ${t(lang, "ai_st_samples")}`}
        />
      ) : attempt ? (
        <Meter
          value={attempt.auc}
          from={0.45}
          to={0.75}
          mark={AUC_GATE}
          markLabel={t(lang, "ai_st_gate")}
          tone="flat"
          label={t(lang, "ai_like_coin")}
          note={`${num(attempt.samples)} ${t(lang, "ai_st_samples")}`}
        />
      ) : (
        <Meter value={ready} from={0} to={cortex.need} tone="flat"
               label={title(t(lang, "ai_st_ready"))}
               note={`${num(ready)} / ${num(cortex.need)}`} />
      )}
    </button>
  );
}

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
          {/* Во вкладке уже сказано, лонг это или шорт, — повторять на
              каждой строке незачем. А вот площадка теперь нигде больше не
              видна, и это она здесь. */}
          <i className="sig-side">
            {t(lang, s.venue === "perp" ? "ai_perp" : "ai_spot")}
          </i>
          {/* Число и подпись обязаны говорить одно. Раньше под «Продажей»
              стояло «67% шанс роста»: показывалась уверенность модели в
              падении, а подписана она была ростом. */}
          <em className={`sig-conf ${long ? "up" : "dn"}`}>
            {s.conf}%
            <i>{t(lang, long ? "ai_p_short" : "ai_p_short_dn")}</i>
          </em>
        </span>
        <span className="sig-meter">
          <Meter value={s.conf / 100} mark={0.5} tone={long ? "up" : "dn"} />
        </span>
        {/* Только главная причина: «много кошельков · 19 кошельков» и
            повторяется, и не влезает в 320 точек. Число кошельков — на
            карточке, вместе с остальными доводами. */}
        {/* В строке причины — только причина: «шанс роста» стоит подписью у
            самого числа, а вместе они не влезают ни во французский, ни в
            английский на 320 точках. */}
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
  const side = useApp((s) => s.cortexSide);
  const setSide = useApp((s) => s.setCortexSide);

  const cortex = useLive((s) => s.cortex);
  const list = cortexList(cortex.list, side);
  /* Мозгу показываем важности той модели, что лучше принята: списком теперь
     правит сторона, а моделей по-прежнему две — своя на каждую площадку. */
  const best = cortex.model?.perp && cortex.model?.spot
    ? (cortex.model.perp.auc >= cortex.model.spot.auc ? cortex.model.perp : cortex.model.spot)
    : (cortex.model?.perp ?? cortex.model?.spot);

  return (
    <>
      <Card>
        <SectionTitle>{t(lang, "ai_title")}</SectionTitle>
        {/* Вокруг картинки мелькают признаки, на которых обучена модель, —
            те же имена, что в ai_models, и в порядке их важности, когда она
            обучена. Это единственная картинка в приложении, которая ничего
            не считает; всё, что она показывает, — список того, на что
            оракул смотрит. */}
        <Brain lang={lang} top={best?.top} />
        <p className="note">{t(lang, "ai_hint").split("\n\n")[0]}</p>
        {/* Вкладки по стороне, а не по площадке: спот и перпы лежат вместе,
            потому что выбирать монету по тому, где она торгуется, незачем. */}
        <Segmented<CortexSide>
          value={side}
          onChange={setSide}
          options={[
            { id: "long", label: t(lang, "ai_long") },
            { id: "short", label: t(lang, "ai_short") },
          ]}
        />
        {/* Состояние модели: обучена — её качество, нет — сколько исходов
            набралось из нужных. Моделей две, по одной на площадку, и раз
            переключателя площадок больше нет, обе стоят здесь. Одной общей
            строкой их не свести: у спота модель может работать, а у перпов в
            это же время только собираться. */}
        {(["spot", "perp"] as const).map((v) => (
          <ModelRow key={v} venue={v} lang={lang} cortex={cortex}
                    onOpen={() => open("model")} />
        ))}
      </Card>

      <Card>
        {list.length === 0 ? (
          /* Две разные пустоты: бот ни разу не присылал сигналов — и бот
             посчитал, но ничего не прошло отбор. Раньше в обоих случаях
             стояло «в этом окне мало кошельков», причём окон уже нет. */
          <Empty
            text={cortex.at ? t(lang, "ai_none_now") : t(lang, "ai_wait_bot")}
            hint={cortex.at ? t(lang, "ai_empty") : undefined}
          />
        ) : (
          list.map((s, i) => (
            /* Номер — место в этом самом списке, и порядок тот же, что
               откроет карточка: она зовёт cortexList с теми же доводами. */
            <SignalRow key={`${s.venue}-${s.sym}-${i}`} s={s} lang={lang}
                       onOpen={() => open("signal", `${side}:${i}`)} />
          ))
        )}
      </Card>

      <Card>
        {/* Не «Угадано: 58%» и голое «26» рядом: по цели и по стопу — это
            то, что человек хочет знать о прошлых сигналах. */}
        <Row
          title={t(lang, "ai_hist_btn")}
          sub={
            cortex.hist.of
              /* Значками, а не словами: «tại mục tiêu 11 · tại cắt lỗ 8» не
                 влезает в 320 точек, а 🎯 и 🛑 понятны без перевода и стоят
                 в самой истории. */
              ? `🎯 ${num(cortex.hist.tp)} · 🛑 ${num(cortex.hist.sl)}`
              : t(lang, "ai_hist_empty")
          }
          value={cortex.hist.of ? `${cortex.hist.hit}%` : "—"}
          valueSub={cortex.hist.of ? title(t(lang, "ai_hist_rate")) : undefined}
          onClick={() => open("history")}
        />
        <p className="note dim">{t(lang, "ai_trade_hint")}</p>
      </Card>
    </>
  );
}
