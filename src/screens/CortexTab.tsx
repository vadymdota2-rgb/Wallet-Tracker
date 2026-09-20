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
import { num, pct, since } from "../lib/format";
import { sideKey, whyKey } from "../lib/labels";
import { venueName } from "../lib/rank";
import { Brain } from "../components/Brain";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Meter, Row, SectionTitle, Segmented, VenueMark } from "../components/ui";
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
            {t(lang, sideKey(s.venue, long))}
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
        {/* Возраст и доход — строкой ниже, по краям.

            Своей строкой, а не рядом с причиной: вместе они не влезают в
            320 точек ни на одном языке, а обрезанная причина не причина.
            Возраст берётся от появления сигнала, а не от пересчёта: пересчёт
            идёт каждые пять минут, и по нему всё выглядело бы свежим.
            Доход считается в сторону сигнала, поэтому у шорта падение цены —
            плюс, и цвет у обоих читается одинаково. */}
        {s.at || s.roi !== undefined ? (
          <span className="sig-foot">
            <i>{s.at ? since(Math.max(0, Date.now() / 1000 - s.at)) : ""}</i>
            {s.roi === undefined ? null : (
              <b className={s.roi >= 0 ? "up" : "dn"}>{pct(s.roi)}</b>
            )}
          </span>
        ) : null}
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
  const attempt = model ? null : (venue === "perp" ? cortex.try?.perp : cortex.try?.spot);
  const ready = venue === "perp" ? cortex.ready.perp : cortex.ready.spot;
  const hist = cortex.hist[venue];
  const list = cortex.list.filter((s) => s.venue === venue);

  return (
    <>
      <Card>
        <SectionTitle>{t(lang, "ai_title")}</SectionTitle>
        {/* Вокруг картинки мелькают признаки, на которых обучена модель, —
            те же имена, что в ai_models, и в порядке их важности, когда она
            обучена. Это единственная картинка в приложении, которая ничего
            не считает; всё, что она показывает, — список того, на что
            оракул смотрит. */}
        <Brain lang={lang} top={model?.top} />
        <p className="note">{t(lang, "ai_hint").split("\n\n")[0]}</p>
        {/* Площадки названы своими именами и помечены своими логотипами:
            «спот» и «перпы» — это про вид сделки, а человек выбирает здесь
            биржу. Спот у нас один — токены BSC, перпы — Hyperliquid. */}
        <Segmented<Venue>
          value={venue}
          onChange={setVenue}
          options={(["spot", "perp"] as const).map((v) => ({
            id: v,
            label: (
              <span className="seg-venue">
                <VenueMark venue={v} size={16} />
                {venueName(v)}
              </span>
            ),
          }))}
        />
        {/* Состояние модели: обучена — её качество, нет — сколько исходов
            набралось из нужных. И то и другое — значение против предела. */}
        <button type="button" className="ora" onClick={() => open("model")}>
          {/* На главном экране — словами. AUC и потери никому ни о чём не
              говорят; кому надо, тот откроет состояние модели. Заголовок и
              пояснение стоят в столбик: рядом они не влезают ни на один
              телефон. */}
          <b className="ora-ttl">
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
          list.map((s) => (
            /* Открываем по имени монеты и стороне, а не по месту в списке.
               Список идёт по свежести, и новый сигнал каждые пять минут
               встаёт наверх, сдвигая всех на единицу. По номеру человек,
               открывший ZEC, через минуту смотрел бы уже на HYPE. */
            <SignalRow key={`${s.venue}-${s.side}-${s.sym}`} s={s} lang={lang}
                       onOpen={() => open("signal", s.venue, `${s.side}|${s.sym}`)} />
          ))
        )}
      </Card>

      <Card>
        {/* Не «Угадано: 58%» и голое «26» рядом: по цели и по стопу — это
            то, что человек хочет знать о прошлых сигналах.

            История — выбранной площадки, а не обеих сразу. Токены BSC и
            перпы Hyperliquid — разные рынки, и общая доля попаданий по ним
            не значит ничего: одна тянет вторую, а какая — не видно. */}
        <Row
          title={t(lang, "ai_hist_btn")}
          /* «Завершённых сигналов пока нет» — это и есть вся строка, и в
             320 точек по-русски она не влезает. Обрезанная многоточием, она
             не говорит ничего, поэтому переносится. */
          wrap
          sub={
            hist.of
              /* Значками, а не словами: «tại mục tiêu 11 · tại cắt lỗ 8» не
                 влезает в 320 точек, а 🎯 и 🛑 понятны без перевода и стоят
                 в самой истории. */
              ? `🎯 ${num(hist.tp)} · 🛑 ${num(hist.sl)}`
              : t(lang, "ai_hist_empty")
          }
          value={hist.of ? `${hist.hit}%` : "—"}
          valueSub={hist.of ? title(t(lang, "ai_hist_rate")) : undefined}
          onClick={() => open("history")}
        />
        <p className="note dim">{t(lang, "ai_trade_hint")}</p>
      </Card>
    </>
  );
}
