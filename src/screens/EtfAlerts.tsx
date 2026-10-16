/**
 * Алерты по биткоин-ETF на экране «Институциональные потоки».
 *
 * Бот пишет в Telegram:
 *   • итог дня по всем фондам — раз в сутки, когда фонды отчитались;
 *   • движения фондов в цепочке — сразу, как подтвердился блок с переводом
 *     в кошельки фонда или из них (свой сканер: BITB и фонды у хранителя),
 *     с порогом в биткоинах;
 *   • по отдельному фонду — колокольчик в списке фондов: его итог дня и его
 *     движения в цепочке.
 *
 * Подписки живут на сервере (wt_etfalert.py), одни на всех устройствах.
 * Переключатель меняется сразу; не сохранилось — возвращается и говорит
 * почему.
 */
import { useEffect, useState } from "react";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { haptic } from "../lib/telegram";
import { etfAlertList, etfAlertSet, savedEtfAlerts, type EtfAlertSub } from "../lib/api";
import { toast } from "../components/Toast";
import { Card, Chips, SectionTitle } from "../components/ui";

type Lang = Parameters<typeof t>[0];
const ALL = "*";
const MINS = [0, 1, 10, 100];

export interface EtfAlerts {
  subs: EtfAlertSub[] | null;
  get: (fund: string) => EtfAlertSub | undefined;
  save: (next: EtfAlertSub) => Promise<void>;
}

/** Подписки человека и сохранение одной из них. */
export function useEtfAlerts(lang: Lang): EtfAlerts {
  const [subs, setSubs] = useState<EtfAlertSub[] | null>(() => savedEtfAlerts());
  useEffect(() => {
    let alive = true;
    void etfAlertList().then((r) => {
      if (alive && r?.ok) setSubs(r.items ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);
  const get = (fund: string) => subs?.find((s) => s.fund === fund);
  const save = async (next: EtfAlertSub) => {
    const was = subs ?? [];
    const on = next.day || next.chain;
    const had = was.some((s) => s.fund === next.fund && (s.day || s.chain));
    setSubs(on ? [...was.filter((s) => s.fund !== next.fund), next] : was.filter((s) => s.fund !== next.fund));
    haptic("select");
    const r = await etfAlertSet(next, lang);
    if (r?.ok) {
      setSubs(r.items ?? []);
      if (on !== had) toast(t(lang, on ? "ef_al_on" : "ef_al_off"));
      return;
    }
    setSubs(was);
    toast(r?.error === "premium" ? t(lang, "ef_al_premium")
      : r?.error === "limit" ? t(lang, "ef_al_limit", { n: num(r.max ?? 40) })
        : t(lang, "ef_al_err"), "err");
  };
  return { subs, get, save };
}

/** Колокольчик у фонда в списке: его итог дня и его движения в цепочке. */
export function FundBell({ fund, al, lang }: { fund: string; al: EtfAlerts; lang: Lang }) {
  if (!al.subs) return null;
  const s = al.get(fund);
  const on = Boolean(s && (s.day || s.chain));
  return (
    <button type="button" className={on ? "ef-bell on" : "ef-bell"} aria-pressed={on}
      aria-label={t(lang, "ef_al_bell", { f: fund })}
      onClick={() => void al.save({ fund, day: !on, chain: !on, min: 0 })}>
      {on ? "🔔" : "🔕"}
    </button>
  );
}

export function EtfAlertsCard({ al, lang }: { al: EtfAlerts; lang: Lang }) {
  if (!al.subs) return null;
  const all = al.get(ALL) ?? { fund: ALL, day: false, chain: false, min: 0 };
  const funds = al.subs.filter((s) => s.fund !== ALL);
  const toggle = (key: "day" | "chain", label: string, hint: string) => (
    <button type="button" className={all[key] ? "dg-notify on ef-al-sw" : "dg-notify ef-al-sw"} aria-pressed={all[key]}
      onClick={() => void al.save({ ...all, [key]: !all[key] })}>
      <span aria-hidden="true">{all[key] ? "🔔" : "🔕"}</span>
      <span><b>{label}</b><small>{hint}</small></span>
      <i className="dg-switch" aria-hidden="true" />
    </button>
  );
  return (
    <>
      <SectionTitle>{t(lang, "ef_al_title")}</SectionTitle>
      <Card>
        {toggle("day", t(lang, "ef_al_day"), t(lang, "ef_al_day_hint"))}
        {toggle("chain", t(lang, "ef_al_chain"), t(lang, "ef_al_chain_hint"))}
        {all.chain ? (
          <Chips<number>
            value={all.min}
            onChange={(m) => void al.save({ ...all, min: m })}
            options={MINS.map((m) => ({ id: m, label: m ? t(lang, "ef_al_min", { n: num(m) }) : t(lang, "ef_al_any") }))}
          />
        ) : null}
        <p className="ef-al-h">{t(lang, "ef_al_funds")}</p>
        {funds.length ? (
          <div className="ef-al-funds">
            {funds.map((s) => (
              <button key={s.fund} type="button" className="ef-al-fund"
                aria-label={`${t(lang, "ef_al_bell", { f: s.fund })} · ${t(lang, "ef_al_off")}`}
                onClick={() => void al.save({ ...s, day: false, chain: false })}>
                🔔 {s.fund} <span aria-hidden="true">✕</span>
              </button>
            ))}
          </div>
        ) : null}
        <p className="lq-hint">{t(lang, "ef_al_funds_hint")}</p>
      </Card>
    </>
  );
}
