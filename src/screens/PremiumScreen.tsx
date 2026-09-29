/**
 * Премиум: что даёт подписка и как её купить.
 *
 * Оба способа работают прямо здесь. Звёзды — окном Telegram: счёт выставляет
 * наш сервер, подтверждение платежа Telegram отправляет боту, и подписку
 * выдаёт он. USDT — переводом в сети TON на наш кошелёк с памяткой в
 * комментарии: приход видит сервер и включает подписку сам.
 *
 * Ручной перевод показан рядом с кнопкой намеренно: кошелёк, не знающий TON
 * Connect, тоже должен уметь заплатить — адрес, сумма и памятка для этого и
 * лежат на виду.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { haptic } from "../lib/telegram";
import { copyText } from "../lib/copy";
import { toast } from "../components/Toast";
import { buyStars, payUsdt, usdtInvoice, warmWallet, type PayEnd, type UsdtInvoice } from "../lib/pay";
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

export function PremiumScreen() {
  const lang = useApp((s) => s.lang);
  const me = useLive((s) => s.me);
  /* Цены и способы оплаты — с сервера: ценник в сборке приложения означал бы
     две правды сразу, а кнопку USDT без настроенного кошелька показывать
     нечестно. */
  const pay = useLive((s) => s.pay);
  const active = me.plan === "premium";
  const days = me.premUntil ? Math.max(0, Math.ceil((me.premUntil - Date.now()) / 86400000)) : 0;

  const [busy, setBusy] = useState<"" | "stars" | "usdt">("");
  const [step, setStep] = useState<Step>("");
  const [inv, setInv] = useState<UsdtInvoice | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  // Кошельки грузятся заранее: нажатие должно открывать кошелёк сразу, а не
  // ждать, пока к телефону приедет библиотека.
  useEffect(() => {
    if (pay.ton) warmWallet();
  }, [pay.ton]);

  /* Что даёт подписка — подробно, с пояснением к каждому пункту. Прежний
     список из четырёх строк обрезался на полуслове («Hyperliquid futures:
     ranking, alerts and…»), и за что платить, было не понять. Порядок и
     содержание — ровно то, что закрывают бот и сервер.

     Значки — те же, что в самом приложении: мозг, кошелёк, медаль и
     аналитика из нижнего меню, логотипы площадок — как на плитках. Уголком —
     площадка, к которой пункт относится. Системные эмодзи рядом с ними
     рисовались бы другим стилем и не совпадали с тем, куда пункт ведёт. */
  const perks: Perk[] = [
    { ic: <VenueMark venue="perp" size={26} />, title: "pr_perk_hl_t", text: "pr_perk_hl_d" },
    { ic: <WalletGlyph size={24} />, title: "pr_perk_wallets_t", text: "pr_perk_wallets_d" },
    { ic: <BellGlyph size={24} />, venue: "perp", title: "pr_perk_alerts_t", text: "pr_perk_alerts_d" },
    { ic: <TopGlyph size={24} />, venue: "spot", title: "pr_perk_top_t", text: "pr_perk_top_d" },
    { ic: <BoltGlyph size={24} />, title: "pr_perk_prio_t", text: "pr_perk_prio_d" },
  ];
  // Что остаётся без подписки: дайджест открыт всем, и это сказано прямо.
  const free: Perk[] = [
    { ic: <DigestGlyph size={24} />, title: "dg_title", text: "pr_free_digest_d" },
    { ic: <AnalyticsGlyph size={24} />, venue: "spot", title: "pr_free_market_t", text: "pr_free_market_d" },
    { ic: <WalletGlyph size={24} />, venue: "spot", title: "pr_free_wallet_t", text: "pr_free_wallet_d" },
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
    done(await buyStars(lang));
  };

  const onUsdt = async () => {
    if (busy) return;
    haptic("select");
    setBusy("usdt");
    const made = inv ?? (await usdtInvoice().then((r) => (r?.ok ? r : null)));
    if (!made) {
      done("off");
      return;
    }
    if (alive.current) setInv(made);
    done(await payUsdt(made, (s) => alive.current && setStep(s)));
  };

  const copy = async (text: string) => {
    haptic("select");
    const ok = await copyText(text);
    toast(t(lang, ok ? "ui_copied" : "ui_copy_failed"), ok ? "ok" : "err");
  };

  return (
    <Frame
      title={active ? t(lang, "pr_active_title") : t(lang, "pr_title")}
      sub={active ? `${t(lang, "pr_days_left")} ${me.service ? "∞" : num(days)}` : t(lang, "pr_unlock")}
    >
      {/* Сервисному аккаунту платить не за что: подписка у него бессрочная,
          как в боте. Вместо оплаты — одна строка, почему. */}
      {me.service ? (
        <Card>
          <p className="note">{t(lang, "pr_service_account")}</p>
        </Card>
      ) : null}
      {/* Оплата — первой: цена и срок видны сразу, а цена написана один раз,
          на самой кнопке. Прежде она стояла дважды — строкой и кнопкой. */}
      {me.service ? null : (
        <Card>
          <SectionTitle note={t(lang, "pr_subscription_label")}>
            {t(lang, active ? "pr_extend_title" : "pr_pay_title")}
          </SectionTitle>
          <div className="stack-actions">
            <Action onClick={onStars} disabled={busy !== "" || !pay.stars}>
              {busy === "stars"
                ? t(lang, "pay_wait_step")
                : `${t(lang, "pay_stars_btn")} · ${num(pay.stars)} ⭐`}
            </Action>
            {pay.ton ? (
              <Action kind="ghost" onClick={onUsdt} disabled={busy !== ""}>
                {busy === "usdt"
                  ? t(lang, step === "sign" ? "pay_sign_step" : step === "wait" ? "pay_wait_step" : "pay_wallet_step")
                  : `${t(lang, "pay_usdt_btn")} · ${pay.usdt} USDT`}
              </Action>
            ) : null}
          </div>
          {pay.ton ? <p className="note dim">{t(lang, "pay_note")}</p> : null}
          {active ? <p className="note dim">{t(lang, "pr_extend_note")}</p> : null}
        </Card>
      )}

      {inv ? (
        <Card>
          <SectionTitle note={t(lang, "pay_hour")}>{t(lang, "pay_manual")}</SectionTitle>
          <Row
            title={t(lang, "pay_amount")}
            value={`${inv.amount} USDT`}
            action={t(lang, "ui_copy")}
            onClick={() => copy(String(inv.amount))}
          />
          <Row
            title={t(lang, "pay_address")}
            sub={<span className="mono">{inv.wallet}</span>}
            action={t(lang, "ui_copy")}
            onClick={() => copy(inv.wallet)}
          />
          <Row
            title={t(lang, "pay_memo")}
            sub={<span className="mono">{inv.memo}</span>}
            action={t(lang, "ui_copy")}
            onClick={() => copy(inv.memo)}
          />
        </Card>
      ) : null}

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

      <Card>
        <SectionTitle>{t(lang, "pr_free_title")}</SectionTitle>
        {free.map((p) => (
          <Row
            key={p.title}
            wrap
            icon={perkIcon(p)}
            title={t(lang, p.title)}
            sub={t(lang, p.text)}
          />
        ))}
      </Card>
    </Frame>
  );
}
