/**
 * История выданных сигналов.
 *
 * Здесь показывается только то, что человеку показали: сигнал, его уровни и
 * чем всё кончилось за сутки — цена дошла до цели, свалилась на стоп или не
 * случилось ни того ни другого. Прежняя версия считала строки журнала
 * обучения, то есть монеты, которые сигналами никогда не были, и подписывала
 * их «планов закрыто», «по цели», «по стопу». Совпадения между подписями и
 * числами не было никакого.
 *
 * Доля попаданий считается только среди решённых: сигнал, который за сутки не
 * дошёл ни до цели, ни до стопа, не был ни угадан, ни нет, и в знаменателе
 * ему делать нечего.
 *
 * Площадки — врозь, и переключатель тот же, что на вкладке. Токены BSC и
 * перпы Hyperliquid — разные рынки с разной ликвидностью и разными стопами;
 * общая доля попаданий по ним не значит ничего, потому что не видно, какая
 * из площадок тянет вторую. Модели у них тоже свои, и судить каждую надо по
 * её же сигналам.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t, title } from "../i18n/t";
import { num, pct } from "../lib/format";
import { ago } from "../lib/relative";
import { sideKey } from "../lib/labels";
import { venueName } from "../lib/rank";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Meter, Row, Segmented, Tiles, VenueMark } from "../components/ui";
import type { Venue } from "../lib/types";

export function HistoryScreen() {
  const lang = useApp((s) => s.lang);
  /* Площадка — та же, что выбрана на вкладке: человек пришёл сюда с неё, и
     увидеть здесь другую он не ждёт. */
  const venue = useApp((s) => s.cortexVenue);
  const setVenue = useApp((s) => s.setCortexVenue);
  const hist = useLive((s) => s.cortex.hist[venue]);

  /* Переключатель стоит и в пустом случае: «сигналов пока нет» — про эту
     площадку, а не про обе, и уйти со второй некуда, если его не показать. */
  const picker = (
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
  );

  if (!hist.of) {
    /* «Завершённых сигналов пока нет» само по себе не отличает «бот только
       что перезапустился» от «что-то сломалось». Если сигналы в работе есть,
       говорим сколько их и через сколько придёт первый итог: горизонт свой у
       каждого, и раньше него итога взяться неоткуда. */
    const open = hist.open ?? 0;
    const soon = Math.max(1, Math.round((hist.next ?? 0) / 3600));
    return (
      <Frame title={t(lang, "ai_hist_title")}>
        <Card>
          {picker}
          <Empty
            text={t(lang, "ai_hist_empty")}
            hint={open > 0
              ? t(lang, "ai_hist_open", { n: open, h: t(lang, "ai_hours", { n: soon }) })
              : undefined}
          />
        </Card>
      </Frame>
    );
  }

  const decided = hist.tp + hist.sl;

  return (
    <Frame title={t(lang, "ai_hist_title")} sub={`${num(hist.of)}`}>
      <Card>
        {picker}
        {/* Попадания — доля от решённых, и знаменатель написан рядом, иначе
            «42%» читается как доля от всех выданных. */}
        {/* Заголовок словами: «Угадано 58% · 11 / 19» человек читает как
            ребус, «11 из 19 сигналов дошли до цели» — как предложение. */}
        <p className="hist-head">{t(lang, "ai_hist_head", { a: hist.tp, b: decided })}</p>
        <p className="note dim">{t(lang, "ai_hist_rest")}</p>
        <Meter
          value={decided ? hist.tp / decided : 0}
          mark={0.5}
          markLabel={t(lang, "ai_st_coin")}
          tone={hist.hit >= 50 ? "up" : "dn"}
          note={`${hist.hit}%`}
        />
        <Tiles
          cols={3}
          size="sm"
          items={[
            { label: t(lang, "ai_hist_tp"), value: num(hist.tp), tone: "up" },
            { label: t(lang, "ai_hist_sl"), value: num(hist.sl), tone: "dn" },
            { label: t(lang, "ai_hist_none"), value: num(hist.missed) },
          ]}
        />
        <Row title={title(t(lang, "ai_hist_avg"))}
             sub={`${title(t(lang, "ai_hist_plans"))} ${num(hist.of)}`}
             value={pct(hist.avg)} tone={hist.avg >= 0 ? "up" : "dn"} />
      </Card>
      <Card>
        {hist.items.map((it, i) => {
          /* Значок исхода: цель, стоп или «мимо». Один только процент не
             говорит, чем кончилось: −0.4% у сигнала, который просто никуда
             не пошёл, и −2.5% по стопу — разные вещи. */
          const out = it.outcome ?? (it.win ? 1 : -1);
          const mark = out > 0 ? "🎯" : out < 0 ? "🛑" : "·";
          return (
            <Row
              key={i}
              icon={<CoinIcon sym={it.sym} size={30} />}
              title={it.sym}
              badge={t(lang, sideKey(it.venue, it.long))}
              /* Только значок и время: словами исход подписан в плитках
                 выше, а в строке «🎯 по цели · 5 ч назад» не влезает и в
                 320 точек. */
              sub={`${mark} ${ago(it.t)}`}
              value={pct(it.ret)}
              tone={it.ret >= 0 ? "up" : "dn"}
            />
          );
        })}
        <p className="note dim">{t(lang, "ai_trade_hint")}</p>
      </Card>
    </Frame>
  );
}
