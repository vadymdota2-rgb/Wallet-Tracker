/**
 * Бонусы — дни Премиума бесплатно: за друга и за подписку на наши соцсети.
 *
 * Приглашение — та же карточка, что была в «Ещё» (InviteCard): +7 дней и
 * тебе, и другу. Ниже — соцсети, каждая один раз на аккаунт. Канал и
 * сообщество в Telegram сервер проверяет по-настоящему (getChatMember):
 * открыл, вернулся, «Получить». У X, TikTok, Instagram и YouTube проверки нет — одно нажатие
 * «Подписаться» открывает страницу и ставит бонус «на проверку»: через пять
 * минут сервер сам начисляет день (bonus_settle), а бот пишет «подписка
 * подтверждена». Второй раз кнопка уже не нажимается.
 *
 * Каналы партнёров (блогеры, взаимная реклама): подписка → «Проверить»
 * (сервер смотрит getChatMember) → через три дня сервер проверяет ещё раз и,
 * если человек всё ещё подписан, начисляет дни (partner_settle).
 *
 * Биржа (OKX): регистрация по нашей ссылке или коду (у кого аккаунт уже
 * есть — смена пригласившего на наш код, OKX даёт её один раз), депозит и
 * покупка от суммы, которую присылает сервер. Проверить приглашённых открыто
 * нельзя, поэтому человек присылает свой UID, а владелец одобряет его в боте
 * (exch_claims в API). Одобрили — дни начисляет сервер, бот пишет человеку.
 */
import { useEffect, useMemo, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { haptic, openExternal, openTg } from "../lib/telegram";
import { dateLong } from "../lib/format";
import { bonusAct, exchSubmit, fetchBonus, partnerJoin, type BonusReply } from "../lib/api";
import { SOCIALS, isTgChat, openSocial, type Social } from "../lib/social";
import { syncNow } from "../lib/sync";
import { copyText } from "../lib/copy";
import { toast } from "../components/Toast";
import { InviteCard, useRefInfo } from "../components/Invite";
import { Action, Card, SectionTitle } from "../components/ui";
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
  const exDays = Object.values(st?.exch ?? {}).reduce((a, c) => a + (c.status === "ok" ? c.days ?? 0 : 0), 0);
  const total = Object.values(got).reduce((a, b) => a + b, 0) + (ref?.days ?? 0) + exDays + (st?.pGot ?? 0);
  /** Сколько ещё можно забрать за подписки. */
  const left = (st?.items ?? []).reduce((a, i) => a + (got[i.id] ? 0 : i.days), 0);
  /* Канал и сообщество Telegram — первыми: за них больше всего дней, и подписку на них
     правда проверяем. */
  const socials = useMemo(() => {
    const rank = (id: string) => (id === "tg" ? 0 : id === "tgc" ? 1 : 2);
    return [...SOCIALS].sort((a, b) => rank(a.id) - rank(b.id));
  }, []);

  const open = (s: Social) => {
    haptic("select");
    openSocial(s);
    if (got[s.id]) return;
    // Не Telegram: одно нажатие — и бонус «на проверке» до начисления.
    if (!isTgChat(s.id)) {
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

      {(st?.exItems ?? []).map((ex) => (
        <ExchCard key={ex.id} ex={ex} claim={st?.exch?.[ex.id]}
          onSent={(uid) => setSt((x) => (x ? { ...x, exch: { ...x.exch, [ex.id]: { status: "wait", uid } } } : x))} />
      ))}

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
                    <b>{s.bonusName ?? s.name}</b>
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
                ) : !isTgChat(s.id) || !at ? (
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

      {st?.partners?.length ? <PartnersCard st={st} onChange={(x) => setSt(x)} /> : null}
    </Frame>
  );
}

/** Бирже по нашей ссылке или коду: ссылка/код → депозит → UID → «Отправить на проверку». */
function ExchCard({ ex, claim, onSent }: {
  ex: NonNullable<BonusReply["exItems"]>[number];
  claim?: NonNullable<BonusReply["exch"]>[string];
  onSent: (uid: string) => void;
}) {
  const lang = useApp((s) => s.lang);
  const [uid, setUid] = useState("");
  const [busy, setBusy] = useState(false);
  const status = claim?.status ?? "none";
  const vars = { name: ex.name, n: ex.days, m: ex.minDep ?? "", g: ex.gift ?? "" };

  async function send() {
    const v = uid.replace(/\s+/g, "");
    if (busy) return;
    if (!/^\d{6,20}$/.test(v)) {
      haptic("error");
      toast(t(lang, "bn_ex_bad_uid", vars), "err");
      return;
    }
    setBusy(true);
    const r = await exchSubmit(ex.id, v);
    setBusy(false);
    if (r?.ok) {
      haptic("success");
      toast(t(lang, "bn_ex_sent"));
      onSent(v);
      return;
    }
    haptic("error");
    const err = r?.error ?? "";
    // Заявка уже лежит (отправили с другого устройства) — показать её.
    if (err === "pending") {
      onSent(v);
      return;
    }
    toast(t(lang, err === "bad_uid" ? "bn_ex_bad_uid" : err === "uid_taken" ? "bn_ex_taken"
      : err === "limit" ? "bn_ex_limit" : err === "already" ? "bn_already" : "generic_error_retry", vars), "err");
  }

  return (
    <Card>
      <SectionTitle>{t(lang, "bn_ex_title", vars)}</SectionTitle>
      {status === "ok" ? (
        <div className="bn-row done">
          <span className="bn-name">
            <b>{t(lang, "bn_ex_ok")}</b>
            <small>UID {claim?.uid}</small>
          </span>
          <span className="bn-ok">✓ +{claim?.days ?? ex.days}</span>
        </div>
      ) : status === "wait" ? (
        <p className="bn-ex-wait">⏳ {t(lang, "bn_ex_wait", { uid: claim?.uid ?? "" })}</p>
      ) : (
        <>
          <p className="note dim">{t(lang, "bn_ex_d", vars)}</p>
          {ex.gift ? <p className="bn-ex-gift">🎁 {t(lang, "bn_ex_okx", vars)}</p> : null}
          {status === "no" ? <p className="bn-ex-no">{t(lang, "bn_ex_no", { uid: claim?.uid ?? "", m: vars.m })}</p> : null}
          <div className="stack-actions">
            <Action kind="ghost" onClick={() => openExternal(ex.link)}>{t(lang, "bn_ex_open", vars)}</Action>
          </div>
          {ex.code ? (
            <>
              <div className="bn-ex-code">
                <span className="bn-ex-code-t">
                  <span>{t(lang, "bn_ex_code")}</span>
                  <b className="mono">{ex.code}</b>
                </span>
                <button type="button" onClick={() => {
                  haptic("select");
                  void copyText(ex.code ?? "").then((ok) =>
                    toast(t(lang, ok ? "bn_ex_code_ok" : "ui_copy_failed"), ok ? undefined : "err"));
                }}>{t(lang, "ui_copy")}</button>
              </div>
              <p className="bn-note">{t(lang, "bn_ex_rebind", vars)}</p>
            </>
          ) : null}
          {ex.minDep ? <p className="bn-ex-label">{t(lang, "bn_ex_dep", vars)}</p> : null}
          <label className="bn-ex-label" htmlFor={`ex-uid-${ex.id}`}>{t(lang, "bn_ex_uid", vars)}</label>
          <input
            id={`ex-uid-${ex.id}`}
            className="find mono"
            value={uid}
            inputMode="numeric"
            placeholder="UID"
            maxLength={24}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setUid(e.target.value)}
          />
          <p className="bn-note">{t(lang, "bn_ex_hint", vars)}</p>
          <div className="stack-actions">
            <Action onClick={() => void send()} disabled={busy || !uid.trim()}>{t(lang, "bn_ex_send")}</Action>
          </div>
        </>
      )}
    </Card>
  );
}

/** Каналы партнёров: «Подписаться» → «Проверить» → «Засчитано · дни N» → «✓ +2». */
function PartnersCard({ st, onChange }: { st: BonusReply; onChange: (x: BonusReply) => void }) {
  const lang = useApp((s) => s.lang);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const claims = st.pclaims ?? {};
  const max = st.pMax ?? 7;
  const capped = (st.pGot ?? 0) >= max;
  const waitDays = Math.round((st.pWait ?? 259200) / 86400);

  const open = (handle: string) => {
    haptic("select");
    openTg(`https://t.me/${handle.replace(/^@/, "")}`);
    setOpened((o) => ({ ...o, [handle]: true }));
  };

  async function check(handle: string) {
    if (busy) return;
    haptic("select");
    setBusy(handle);
    const r = await partnerJoin(handle);
    setBusy("");
    if (r?.ok && r.checkAt) {
      haptic("success");
      onChange({ ...st, pclaims: { ...claims, [handle]: { status: "wait", checkAt: r.checkAt, days: 0 } } });
      return;
    }
    haptic("error");
    const err = r?.error ?? "";
    toast(t(lang, err === "not_member" ? "bn_pt_not" : err === "check" ? "bn_pt_err" : err === "cap" ? "bn_pt_cap"
      : err === "already" ? "bn_already" : "generic_error_retry"), "err");
  }

  return (
    <Card>
      <SectionTitle>{t(lang, "bn_pt_title")}</SectionTitle>
      <p className="note dim">{t(lang, "bn_pt_d", { w: waitDays, max })}</p>
      <ul className="bn-list">
        {(st.partners ?? []).map((p) => {
          const c = claims[p.handle];
          const done = c?.status === "ok";
          return (
            <li key={p.handle} className={done ? "bn-row done" : "bn-row"}>
              <button type="button" className="bn-net" onClick={() => open(p.handle)}>
                <span className="bn-ic" aria-hidden="true">📣</span>
                <span className="bn-name">
                  <b>{p.title}</b>
                  <small>{done ? t(lang, "bn_done") : c?.status === "left" ? t(lang, "bn_pt_left")
                    : `${p.handle} · ${t(lang, "bn_days", { n: p.days })}`}</small>
                </span>
              </button>
              {done ? (
                <span className="bn-ok">✓ +{c?.days}</span>
              ) : c?.status === "wait" ? (
                <span className="bn-wait">
                  {t(lang, "bn_pt_wait", { d: dateLong(c.checkAt) }).split(" · ").map((part, i) => <span key={i}>{part}</span>)}
                </span>
              ) : c || capped ? null : opened[p.handle] ? (
                <button type="button" className="bn-go claim" disabled={busy === p.handle} onClick={() => void check(p.handle)}>
                  {t(lang, "bn_pt_check")}
                </button>
              ) : (
                <button type="button" className="bn-go" onClick={() => open(p.handle)}>{t(lang, "bn_subscribe")}</button>
              )}
            </li>
          );
        })}
      </ul>
      {capped ? <p className="bn-note">{t(lang, "bn_pt_cap")}</p> : null}
    </Card>
  );
}
