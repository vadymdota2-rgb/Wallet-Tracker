/**
 * Бонусы — дни Премиума бесплатно: за друга и за подписку на наши соцсети.
 *
 * Приглашение — та же карточка, что была в «Ещё» (InviteCard): +7 дней и
 * тебе, и другу. Ниже — соцсети, каждая один раз на аккаунт. Канал Telegram
 * сервер проверяет по-настоящему (getChatMember); у X, TikTok, Instagram и
 * YouTube проверки нет — человек открывает страницу, и через BONUS_WAIT
 * секунд кнопка «Получить» оживает. Время открытия сервер тоже запоминает и
 * раньше дни не выдаст.
 */
import { useEffect, useMemo, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { bonusAct, fetchBonus, type BonusReply } from "../lib/api";
import { SOCIALS, openSocial, type Social } from "../lib/social";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { InviteCard } from "../components/Invite";
import { Card, SectionTitle } from "../components/ui";
import { useNow } from "../lib/tick";

/** Секунд между «открыл страницу» и «можно забрать» — BONUS_WAIT_SEC в API. */
const BONUS_WAIT = 10;

export function BonusScreen() {
  const lang = useApp((s) => s.lang);
  const service = useLive((s) => s.me.service);
  const nowSec = useNow();
  const [st, setSt] = useState<BonusReply | null>(null);
  /* Когда человек открыл страницу — здесь, а не только на сервере: отсчёт до
     «Получить» должен идти сразу, без лишнего запроса. */
  const [opened, setOpened] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let alive = true;
    void fetchBonus().then((r) => {
      if (!alive || !r?.ok) return;
      setSt(r);
      setOpened((o) => ({ ...r.opened, ...o }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const days = useMemo(() => Object.fromEntries((st?.items ?? []).map((i) => [i.id, i.days])), [st]);
  const got = st?.got ?? {};
  const total = Object.values(got).reduce((a, b) => a + b, 0);

  const open = (s: Social) => {
    haptic("select");
    openSocial(s);
    if (got[s.id]) return;
    setOpened((o) => ({ ...o, [s.id]: o[s.id] ?? Math.floor(Date.now() / 1000) }));
    void bonusAct(s.id, "open");
  };

  const claim = async (s: Social) => {
    if (busy) return;
    haptic("select");
    setBusy(s.id);
    const r = await bonusAct(s.id, "claim");
    setBusy("");
    if (r?.ok && r.days) {
      haptic("success");
      setSt((x) => (x ? { ...x, got: { ...x.got, [s.id]: r.days ?? 0 } } : x));
      toast(t(lang, "bn_got_toast", { n: r.days }));
      void syncNow();
      return;
    }
    haptic("error");
    const err = r?.error ?? "";
    if (err === "already") setSt((x) => (x ? { ...x, got: { ...x.got, [s.id]: days[s.id] ?? 0 } } : x));
    toast(t(lang, err === "not_member" ? "bn_not_member" : err === "wait" ? "bn_wait" : err === "already"
      ? "bn_already" : "generic_error_retry"), "err");
  };

  return (
    <Frame title={t(lang, "bn_title")} sub={t(lang, "bn_sub")}>
      {total > 0 ? (
        <Card>
          <p className="bn-total">🎁 {t(lang, "bn_total", { n: total })}</p>
        </Card>
      ) : null}

      {/* Пригласить друга — +7 дней обоим. */}
      {service ? null : <InviteCard />}

      <Card>
        <SectionTitle>{t(lang, "bn_social_title")}</SectionTitle>
        <p className="note dim">{t(lang, "bn_social_d")}</p>
        <ul className="bn-list">
          {SOCIALS.map((s) => {
            const d = days[s.id] ?? 0;
            const done = got[s.id];
            const at = opened[s.id];
            const left = at ? Math.max(0, BONUS_WAIT - (nowSec - at)) : 0;
            return (
              <li key={s.id} className={done ? "bn-row done" : "bn-row"}>
                <button type="button" className="bn-net" onClick={() => open(s)}>
                  <span className="bn-ic">{s.icon(18)}</span>
                  <span className="bn-name">
                    <b>{s.name}</b>
                    <small>{done ? t(lang, "bn_done") : t(lang, "bn_days", { n: d })}</small>
                  </span>
                </button>
                {done ? (
                  <span className="bn-ok">✓ +{done}</span>
                ) : !at ? (
                  <button type="button" className="bn-go" onClick={() => open(s)}>
                    {t(lang, "bn_subscribe")}
                  </button>
                ) : (
                  <button type="button" className="bn-go claim" disabled={left > 0 || busy === s.id}
                    onClick={() => void claim(s)}>
                    {left > 0 ? `${left} ${t(lang, "unit_sec")}` : t(lang, "bn_claim", { n: d })}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="bn-note">{t(lang, "bn_once")}</p>
      </Card>
    </Frame>
  );
}
