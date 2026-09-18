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
import { useEffect, useRef, useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { haptic, webApp } from "../lib/telegram";
import { copyText } from "../lib/copy";
import { toast } from "../components/Toast";
import { buyStars, payUsdt, usdtInvoice, type PayEnd, type UsdtInvoice } from "../lib/pay";
import { Action, Card, Row, SectionTitle } from "../components/ui";

const BOT = "https://t.me/WalletTrackerOfficial";

type Step = "" | "wallet" | "sign" | "wait";

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

  const perks: Parameters<typeof t>[1][] = [
    "help_premium_1",
    "help_premium_2",
    "help_premium_3",
    "help_premium_4",
  ];

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
      sub={active ? `${t(lang, "pr_days_left")} ${num(days)}` : t(lang, "pr_unlock")}
    >
      <Card>
        <SectionTitle>{t(lang, "pr_includes")}</SectionTitle>
        {perks.map((k) => (
          <Row key={k} title={t(lang, k)} />
        ))}
      </Card>

      <Card>
        <SectionTitle note={t(lang, "pr_subscription_label")}>{t(lang, "pr_price_label")}</SectionTitle>
        <Row title={t(lang, "pay_stars_btn")} value={`${num(pay.stars)} ⭐`} />
        {pay.ton ? <Row title={t(lang, "pay_usdt_btn")} value={`${pay.usdt} USDT`} /> : null}
        {pay.ton ? <p className="note dim">{t(lang, "pay_note")}</p> : null}
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
      </Card>

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
        <p className="note dim">{t(lang, "pay_bot_note")}</p>
        <div className="stack-actions">
          <Action
            kind="ghost"
            onClick={() => {
              const w = webApp();
              if (w?.openTelegramLink) w.openTelegramLink(BOT);
              else window.open(BOT, "_blank", "noopener");
            }}
          >
            {t(lang, "ui_open_bot")}
          </Action>
        </div>
      </Card>
    </Frame>
  );
}
