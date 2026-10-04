/**
 * Бонусы — дни Премиума бесплатно: за друга и за подписку на наши соцсети.
 *
 * Приглашение — та же карточка, что была в «Ещё» (InviteCard): +7 дней и
 * тебе, и другу. Ниже — соцсети, каждая один раз на аккаунт. Канал Telegram
 * сервер проверяет по-настоящему (getChatMember): открыл канал, вернулся,
 * «Получить». У X, TikTok, Instagram и YouTube проверки нет — одно нажатие
 * «Подписаться» открывает страницу и ставит бонус «на проверку»: через пять
 * минут сервер сам начисляет день (bonus_settle), а бот пишет «подписка
 * подтверждена». Второй раз кнопка уже не нажимается.
 */
import { useEffect, useMemo, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { haptic } from "../lib/telegram";
import { bonusAct, fetchBonus, type BonusReply } from "../lib/api";
import { SOCIALS, openSocial, type Social } from "../lib/social";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { InviteCard, useRefInfo } from "../components/Invite";
import { Card, SectionTitle } from "../components/ui";
import { useNow } from "../lib/tick";

/** Канал Telegram без прав бота: секунд между «открыл» и «можно забрать» —
 *  BONUS_WAIT_SEC в API. */
const BONUS_WAIT = 10;

export function BonusScreen() {
  const lang = useApp((s) => s.lang);
  const nowSec = useNow();
  const [st, setSt] = useState<BonusReply | null>(null);
  /* Когда человек открыл страницу — здесь, а не только на сервере: отсчёт до
     «Получить» должен идти сразу, без лишнего запроса. */
  const [opened, setOpened] = useState<Record<string, number>>({});
  /** До какого времени идёт «проверка» подписки (X, TikTok, Instagram, YouTube). */
  const [pending, setPending] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState("");
  const [tick, setTick] = useState(0);
  const ref = useRefInfo();

  useEffect(() => {
    let alive = true;
    void fetchBonus().then((r) => {
      if (!alive || !r?.ok) return;
      // Проверка закончилась, пока экран открыт: сказать и обновить срок
      // Премиума в приложении, а не только галочку в строке.
      const fresh = Object.keys(r.got ?? {}).filter((k) => pending[k] && !st?.got?.[k]);
      if (fresh.length) {
        const n = fresh.reduce((a, k) => a + (r.got?.[k] ?? 0), 0);
        haptic("success");
        toast(t(lang, "bn_got_toast", { n }));
        void syncNow();
      }
      setSt(r);
      setOpened((o) => ({ ...r.opened, ...o }));
      setPending((p) => {
        const next = { ...r.pending, ...p };
        for (const k of Object.keys(r.got ?? {})) delete next[k];
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // pending и st — снимок на момент запроса; сам запрос — по tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  /* Пока что-то «на проверке» и экран открыт — раз в полминуты спрашиваем
     сервер: начислил — строка сама станет «✓ +1». */
  const waiting = Object.keys(pending).some((k) => !st?.got?.[k]);
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [waiting]);

  const days = useMemo(() => Object.fromEntries((st?.items ?? []).map((i) => [i.id, i.days])), [st]);
  const got = st?.got ?? {};
  /* Итог — вместе с днями за друзей: «получено бонусами» без них было бы
     неправдой у того, кто уже пригласил. */
  const total = Object.values(got).reduce((a, b) => a + b, 0) + (ref?.days ?? 0);
  /** Сколько ещё можно забрать за подписки. */
  const left = (st?.items ?? []).reduce((a, i) => a + (got[i.id] ? 0 : i.days), 0);
  /* Канал Telegram — первым: за него больше всего дней, и подписку на него
     правда проверяем. */
  const socials = useMemo(() => [...SOCIALS].sort((a, b) => (a.id === "tg" ? -1 : b.id === "tg" ? 1 : 0)), []);

  const open = (s: Social) => {
    haptic("select");
    openSocial(s);
    if (got[s.id]) return;
    // Не Telegram: одно нажатие — и бонус «на проверке» до начисления.
    if (s.id !== "tg") {
      if (pending[s.id]) return;
      setPending((p) => ({ ...p, [s.id]: Math.floor(Date.now() / 1000) + 300 }));
      void bonusAct(s.id, "open").then((r) => {
        if (r?.ok && r.due) {
          setPending((p) => ({ ...p, [s.id]: r.due ?? 0 }));
          toast(t(lang, "bn_checking_toast"));
          return;
        }
        // Сервер не записал — не делаем вид, что проверка идёт.
        setPending((p) => {
          const next = { ...p };
          delete next[s.id];
          return next;
        });
        if (r?.error === "already") setSt((x) => (x ? { ...x, got: { ...x.got, [s.id]: days[s.id] ?? 0 } } : x));
        else toast(t(lang, "generic_error_retry"), "err");
      });
      return;
    }
    setOpened((o) => ({ ...o, [s.id]: o[s.id] ?? Math.floor(Date.now() / 1000) }));
    void bonusAct(s.id, "open");
  };

  async function claim(s: Social) {
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
  }

  return (
    <Frame title={t(lang, "bn_title")} sub={t(lang, "bn_sub")}>
      {/* Сверху — сколько ещё можно получить и сколько уже получено. */}
      <Card>
        <div className="bn-hero">
          <span className="bn-gift" aria-hidden="true">🎁</span>
          <div>
            <p className="bn-left">{t(lang, "bn_left", { n: left, r: ref?.bonus ?? 7 })}</p>
            {total > 0 ? <p className="bn-total">{t(lang, "bn_total", { n: total })}</p> : null}
          </div>
        </div>
      </Card>

      {/* Пригласить друга — +7 дней обоим. */}
      <InviteCard />

      <Card>
        <SectionTitle>{t(lang, "bn_social_title")}</SectionTitle>
        <p className="note dim">{t(lang, "bn_social_d")}</p>
        <ul className="bn-list">
          {socials.map((s) => {
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
                ) : pending[s.id] ? (
                  <span className="bn-wait">
                    {/* «Проверяем · ≈5 мин» — двумя строками: слово и срок. */}
                    {t(lang, "bn_checking", { m: Math.max(1, Math.ceil((pending[s.id]! - nowSec) / 60)) })
                      .split(" · ").map((part, i) => <span key={i}>{part}</span>)}
                  </span>
                ) : s.id !== "tg" || !at ? (
                  <button type="button" className="bn-go" disabled={busy === s.id} onClick={() => open(s)}>
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
