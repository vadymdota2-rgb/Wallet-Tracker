/**
 * История алертов и выбор, куда их слать.
 *
 * Список — то, что бот прислал человеку за двое суток (дольше бот доставки не
 * хранит), текстом как в чате. Открыли экран — счётчик новых в «Ещё»
 * обнуляется: на сервере запоминается время последнего показанного алерта,
 * так что пришедший после этого останется новым.
 *
 * «Только в приложении» — бот перестаёт писать в чат: алерт кладётся в
 * историю со статусом «не отправлялся», очередь Telegram его не берёт.
 */
import { useEffect, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { since } from "../lib/format";
import { haptic } from "../lib/telegram";
import { markAlertsSeen, setAlertMode } from "../lib/api";
import { toast } from "../components/Toast";
import { Card, Empty, SectionTitle, Segmented } from "../components/ui";
import { useNow } from "../lib/tick";

type Mode = "tg" | "app";

export function AlertsScreen() {
  const lang = useApp((s) => s.lang);
  const alerts = useLive((s) => s.alerts);
  const me = useLive((s) => s.me);
  const patchMe = useLive((s) => s.patchMe);
  const nowSec = useNow();
  const mode: Mode = me.alertTg === false ? "app" : "tg";
  const [busy, setBusy] = useState(false);

  /* Сколько было новых на момент открытия — их и подсвечиваем: счётчик в
     хранилище сейчас же обнулится, а человеку ещё надо увидеть, какие новые. */
  const [fresh] = useState(() => me.unread ?? 0);

  useEffect(() => {
    const upto = alerts.reduce((m, a) => Math.max(m, a.ts ?? 0), 0);
    patchMe({ unread: 0 });
    void markAlertsSeen(upto || Date.now());
    // Только при открытии: пришедшие потом должны оставаться новыми.
  }, []);

  const choose = async (next: Mode) => {
    if (next === mode || busy) return;
    haptic("select");
    setBusy(true);
    const was = me.alertTg;
    patchMe({ alertTg: next === "tg" });
    const res = await setAlertMode(next === "tg");
    setBusy(false);
    if (!res?.ok) {
      patchMe({ alertTg: was });
      toast(t(lang, "generic_error_retry"), "err");
    }
  };

  return (
    <Frame title={t(lang, "alerts_title")} sub={t(lang, "alerts_sub")}>
      <Card>
        <SectionTitle>{t(lang, "alerts_mode_title")}</SectionTitle>
        <Segmented<Mode>
          wrap
          value={mode}
          onChange={(m) => void choose(m)}
          options={[
            { id: "tg", label: t(lang, "alerts_mode_tg") },
            { id: "app", label: t(lang, "alerts_mode_app") },
          ]}
        />
        <p className="note dim">{t(lang, mode === "tg" ? "alerts_mode_hint_tg" : "alerts_mode_hint_app")}</p>
      </Card>

      <Card>
        <SectionTitle note={alerts.length ? String(alerts.length) : undefined}>{t(lang, "alerts_title")}</SectionTitle>
        {alerts.length === 0 ? (
          <Empty text={t(lang, "alerts_empty")} />
        ) : (
          <ul className="alert-list">
            {alerts.map((a, i) => (
              <li key={a.id ?? i} className={i < fresh ? "alert-row fresh" : "alert-row"}>
                <div className="alert-hd">
                  <span className="alert-t">
                    {a.ts ? since(Math.max(0, nowSec - Math.floor(a.ts / 1000))) : null}
                  </span>
                  {a.tg === false ? <em className="alert-tag">{t(lang, "alerts_app_only")}</em> : null}
                </div>
                <p className="alert-text">{a.text || `${a.sym} · ${a.name}`}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Frame>
  );
}
