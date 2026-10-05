/**
 * Премиум: что даёт подписка и как её купить.
 *
 * Оба способа работают прямо здесь. Звёзды — окном Telegram: счёт выставляет
 * наш сервер, подтверждение платежа Telegram отправляет боту, и подписку
 * выдаёт он. USDT — только через TON Connect: кошелёк сам подставляет сумму,
 * адрес и памятку, приход видит бот и включает подписку сам. Ручного
 * перевода нет: ошибка в памятке или опоздание со счётом стоили бы денег.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { haptic } from "../lib/telegram";
import { toast } from "../components/Toast";
import { buyStars, payUsdt, usdtInvoice, warmWallet, type PayEnd, type Plan, type UsdtInvoice } from "../lib/pay";
import { trackEvent } from "../lib/api";
import { SRC_HEAD, isPaySrc } from "../lib/upsell";
import type { ScreenProps } from "./Screen";
import {
  Action,
  AnalyticsGlyph,
  BellGlyph,
  BoltGlyph,
  Card,
  DigestGlyph,
  Row,
  SectionTitle,
  TopGlyph,
  VenueMark,
  WalletGlyph,
} from "../components/ui";


type Step = "" | "wallet" | "sign" | "wait";
type Perk = {
  ic: ReactNode;
  /** Площадка уголком — как на плитках аналитики. */
  venue?: "spot" | "perp";
  title: Parameters<typeof t>[1];
  text: Parameters<typeof t>[1];
};

export function PremiumScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const me = useLive((s) => s.me);
  const open = useApp((s) => s.open);
  /* Откуда пришли: заголовок говорит про то, за чем человек открыл экран, —
     «следите за 50 кошельками», а не общее «раскройте потенциал». */
  const src = isPaySrc(arg) ? arg : "more";
  const trial = Boolean(me.trial) && me.plan === "premium";
  /* Пробному — всегда про то, что будет после пробы. */
  const head = SRC_HEAD[src] ?? (trial ? SRC_HEAD.trial : undefined);
  /* Цены и способы оплаты — с сервера: ценник в сборке приложения означал бы
     две правды сразу, а кнопку USDT без настроенного кошелька показывать
     нечестно. */
  const pay = useLive((s) => s.pay);
  const active = me.plan === "premium";
  const days = me.premUntil ? Math.max(0, Math.ceil((me.premUntil - Date.now()) / 86400000)) : 0;

  const [busy, setBusy] = useState<"" | "stars" | "usdt">("");
  /* Тариф. По умолчанию — вводная цена, если она сейчас есть, иначе год:
     он выгоднее и честно помечен скидкой; месяц рядом. Оба разовые. */
  const plans = pay.plans ?? {};
  const intro = pay.intro && pay.intro.until * 1000 > Date.now() ? pay.intro : undefined;
  const [plan, setPlan] = useState<Plan>(() => (intro ? "intro" : plans.y ? "y" : "m"));
  const chosen = plan === "intro" ? intro : plans[plan];
  const stars = chosen?.stars ?? pay.stars;
  const usdt = plan === "intro" ? 0 : (plans[plan]?.usdt ?? pay.usdt);
  const off = plans.m && plans.y ? Math.round((1 - plans.y.stars / (plans.m.stars * 12)) * 100) : 0;
  const [step, setStep] = useState<Step>("");
  const [inv, setInv] = useState<UsdtInvoice | null>(null);
  // Другой тариф — другой счёт USDT: старый с чужой суммой не показываем.
  useEffect(() => setInv(null), [plan]);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  // Кошельки грузятся заранее: нажатие должно открывать кошелёк сразу, а не
  // ждать, пока к телефону приедет библиотека.
  useEffect(() => {
    if (pay.ton) warmWallet();
  }, [pay.ton]);
  // Замер воронки: экран увидел тот, кому есть что покупать.
  useEffect(() => {
    if (!active || trial) trackEvent("paywall", src);
  }, [active, trial, src]);

  /* Что даёт подписка — подробно, с пояснением к каждому пункту. Прежний
     список из четырёх строк обрезался на полуслове («Hyperliquid futures:
     ranking, alerts and…»), и за что платить, было не понять. Порядок и
     содержание — ровно то, что закрывают бот и сервер.

     Значки — те же, что в самом приложении: мозг, кошелёк, медаль и
     аналитика из нижнего меню, логотипы площадок — как на плитках. Уголком —
     площадка, к которой пункт относится. Системные эмодзи рядом с ними
     рисовались бы другим стилем и не совпадали с тем, куда пункт ведёт. */
  const perks: Perk[] = [
    // Без Премиума закрыто всё приложение — об этом первым.
    { ic: <DigestGlyph size={24} />, title: "pr_perk_all_t", text: "pr_perk_all_d" },
    { ic: <BoltGlyph size={24} />, title: "pr_perk_live_t", text: "pr_perk_live_d" },
    { ic: <VenueMark venue="perp" size={26} />, title: "pr_perk_hl_t", text: "pr_perk_hl_d" },
    { ic: <WalletGlyph size={24} />, title: "pr_perk_wallets_t", text: "pr_perk_wallets_d" },
    { ic: <TopGlyph size={24} />, title: "pr_perk_top_t", text: "pr_perk_top_d" },
    { ic: <AnalyticsGlyph size={24} />, title: "pr_perk_deep_t", text: "pr_perk_deep_d" },
    { ic: <BellGlyph size={24} />, title: "pr_perk_prio_t", text: "pr_perk_prio_d" },
  ];
  const perkIcon = (p: Perk) => (
    <span className="perk-ic" aria-hidden="true">
      {p.ic}
      {p.venue ? (
        <span className="perk-tag">
          <VenueMark venue={p.venue} size={12} />
        </span>
      ) : null}
    </span>
  );

  /* Конец любой оплаты выглядит одинаково: сообщение и снятая занятость.
     Состояние экрана после ухода в кошелёк может уже никого не интересовать —
     поэтому проверка, что экран ещё открыт. */
  const done = (end: PayEnd) => {
    if (!alive.current) return;
    setBusy("");
    setStep("");
    if (end === "paid") {
      haptic("success");
      toast(t(lang, "pay_ok"));
      return;
    }
    haptic("error");
    const say: Record<Exclude<PayEnd, "paid">, Parameters<typeof t>[1]> = {
      cancelled: "pay_cancelled",
      failed: "pay_failed",
      no_usdt: "pay_no_usdt",
      off: "pay_off",
    };
    toast(t(lang, say[end]), "err");
  };

  const onStars = async () => {
    if (busy) return;
    haptic("select");
    setBusy("stars");
    done(await buyStars(lang, plan));
  };

  const onUsdt = async () => {
    if (busy) return;
    haptic("select");
    setBusy("usdt");
    const made = inv && inv.days === chosen?.days ? inv : await usdtInvoice(plan).then((r) => (r?.ok ? r : null));
    if (!made) {
      done("off");
      return;
    }
    if (alive.current) setInv(made);
    done(await payUsdt(made, (s) => alive.current && setStep(s)));
  };

  return (
    <Frame
      title={active ? t(lang, "pr_active_title") : t(lang, "pr_title")}
      sub={active ? `${t(lang, "pr_days_left")} ${num(days)}` : t(lang, "pr_unlock")}
    >
      {/* Сначала — зачем: одна фраза про то, за чем человек пришёл. Потом
          оплата: цена написана один раз, на кнопке. */}
      {(active && !trial) || !head ? null : (
        <Card>
          <p className="pw-why">{t(lang, head)}</p>
        </Card>
      )}
      <Card>
        <SectionTitle>{t(lang, active ? "pl_extend" : "pl_title")}</SectionTitle>
        {/* Тарифы карточками: цена, срок и чем каждый хорош. */}
        <div className="plans" role="radiogroup" aria-label={t(lang, "pl_title")}>
          {intro ? (
            <button type="button" role="radio" aria-checked={plan === "intro"}
              className={plan === "intro" ? "plan on" : "plan"} onClick={() => setPlan("intro")}>
              <span className="plan-hd">
                <b>{t(lang, "pl_intro")}</b>
                <span className="plan-badge">−{Math.round((1 - intro.stars / (plans.m?.stars ?? pay.stars)) * 100)}%</span>
              </span>
              <span className="plan-px">{num(intro.stars)} ⭐</span>
              <small>{t(lang, "pl_intro_d", { h: Math.max(1, Math.ceil((intro.until * 1000 - Date.now()) / 3600000)) })}</small>
            </button>
          ) : null}
          {plans.y ? (
            <button type="button" role="radio" aria-checked={plan === "y"}
              className={plan === "y" ? "plan on" : "plan"} onClick={() => setPlan("y")}>
              <span className="plan-hd">
                <b>{t(lang, "pl_year")}</b>
                {off > 0 ? <span className="plan-badge">−{off}%</span> : null}
              </span>
              <span className="plan-px">{num(plans.y.stars)} ⭐{pay.ton ? ` · ${plans.y.usdt} USDT` : ""}</span>
              <small>{t(lang, "pl_year_d", { s: num(Math.round(plans.y.stars / 12)) })}</small>
            </button>
          ) : null}
          <button type="button" role="radio" aria-checked={plan === "m"}
            className={plan === "m" ? "plan on" : "plan"} onClick={() => setPlan("m")}>
            <span className="plan-hd"><b>{t(lang, "pl_month")}</b></span>
            <span className="plan-px">{num(plans.m?.stars ?? pay.stars)} ⭐{pay.ton ? ` · ${plans.m?.usdt ?? pay.usdt} USDT` : ""}</span>
            <small>{t(lang, "pl_once")}</small>
          </button>
        </div>
        <div className="stack-actions">
          <Action onClick={onStars} disabled={busy !== "" || !stars}>
            {busy === "stars"
              ? t(lang, "pay_wait_step")
              : `${t(lang, "pay_stars_btn")} · ${num(stars)} ⭐`}
          </Action>
          {pay.ton && usdt ? (
            <Action kind="ghost" onClick={onUsdt} disabled={busy !== ""}>
              {busy === "usdt"
                ? t(lang, step === "sign" ? "pay_sign_step" : step === "wait" ? "pay_wait_step" : "pay_wallet_step")
                : `${t(lang, "pay_usdt_btn")} · ${usdt} USDT`}
            </Action>
          ) : null}
        </div>
        {pay.ton ? <p className="note dim">{t(lang, "pay_note")}</p> : null}
        {active ? <p className="note dim">{t(lang, "pr_extend_note")}</p> : null}
      </Card>

      <Card>
        <SectionTitle>{t(lang, "pr_includes")}</SectionTitle>
        {perks.map((p) => (
          <Row
            key={p.title}
            wrap
            icon={perkIcon(p)}
            title={t(lang, p.title)}
            sub={t(lang, p.text)}
          />
        ))}
      </Card>

      {/* Не готов платить — «Бонусы»: дни Премиума за друга и за подписки
          на соцсети. */}
      <Card>
        <Row
          icon={<span aria-hidden="true">🎁</span>}
          title={t(lang, "bn_title")}
          sub={t(lang, "bn_premium_sub")}
          onClick={() => open("bonus")}
        />
      </Card>
    </Frame>
  );
}
