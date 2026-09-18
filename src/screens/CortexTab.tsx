/**
 * «Сонар» — кнопка 📡 бота (ai.cpp). Сигналы по потоку среди отслеживаемых
 * кошельков: площадка, окно, сторона — те же переключатели, что в чате.
 *
 * Отбор идёт по полям, которые прислал сервер. Прошлая версия фильтровала
 * список по вшитым тикерам (BTC, SOL, CAKE, HYPE) в зависимости от окна —
 * это был не отбор по данным, а имитация.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, px } from "../lib/format";
import { whyKey } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Empty, Row, SectionTitle, Segmented } from "../components/ui";
import type { Venue } from "../lib/types";

const WINDOWS: { id: string; key: Parameters<typeof t>[1] }[] = [
  { id: "1", key: "ai_w1h" },
  { id: "6", key: "ai_w6h" },
  { id: "24", key: "ai_w24" },
];

export function CortexTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const venue = useApp((s) => s.cortexVenue);
  const setVenue = useApp((s) => s.setCortexVenue);
  const win = useApp((s) => s.cortexWin);
  const setWin = useApp((s) => s.setCortexWin);

  const cortex = useLive((s) => s.cortex);

  const trained = venue === "perp" ? cortex.trainedPerp : cortex.trainedSpot;
  const acc = venue === "perp" ? cortex.accPerp : cortex.accSpot;
  const ready = venue === "perp" ? cortex.ready.perp : cortex.ready.spot;

  const list = cortex.list.filter((s) => s.venue === venue && s.winH === win);

  return (
    <>
      <Card>
        <SectionTitle note={t(lang, "ai_horizon")}>{t(lang, "ai_title")}</SectionTitle>
        {/* Полный текст — на экране модели: здесь он занимал пол-экрана. */}
        <p className="note">{t(lang, "ai_hint").split("\n\n")[0]}</p>
        <Segmented<Venue>
          value={venue}
          onChange={setVenue}
          options={[
            { id: "spot", label: t(lang, "ai_spot") },
            { id: "perp", label: t(lang, "ai_perp") },
          ]}
        />
        <Segmented<string>
          value={String(win)}
          onChange={(v) => setWin(Number(v))}
          options={WINDOWS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
        />
        <Row
          title={trained ? t(lang, "ai_mode_model") : t(lang, "ai_mode_formula")}
          sub={`${t(lang, "ai_st_ready")} ${num(ready)} / ${num(cortex.need)}`}
          value={acc === null ? "—" : `${acc}%`}
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
              key={`${s.sym}-${s.winH}-${i}`}
              icon={<CoinIcon sym={s.sym} size={32} />}
              title={s.sym}
              badge={s.side === "buy" ? t(lang, "ai_long") : t(lang, "ai_short")}
              sub={
                <>
                  {px(s.entry)} · {num(s.w)} {t(lang, "flow_wallets")} ·{" "}
                  {s.why
                    .map((w) => {
                      const k = whyKey(w);
                      return k ? t(lang, k) : w;
                    })
                    .join(", ")}
                </>
              }
              value={`${s.conf}%`}
              tone={s.side === "buy" ? "up" : "dn"}
              valueSub={t(lang, "ai_conf")}
              onClick={() => open("signal", `${s.venue}:${s.winH}:${i}`)}
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
