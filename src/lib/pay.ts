/**
 * Покупка премиума прямо в приложении.
 *
 * Звёзды: счёт создаёт наш API, окно открывает Telegram, а подписку по факту
 * оплаты выдаёт бот — ему Telegram присылает подтверждение платежа. Здесь
 * остаётся дождаться ответа окна и обновить своё состояние.
 *
 * USDT: счёт с памяткой создаёт наш API, перевод подписывает кошелёк через
 * TON Connect, а приход денег сервер видит сам и включает подписку. Тяжёлую
 * библиотеку кошельков подгружаем только в момент нажатия — ради экрана,
 * который открывают раз в месяц, держать её в общей сборке незачем.
 */
import { jettonTransfer } from "./ton";
import { initData, webApp } from "./telegram";
import { syncNow } from "./sync";

export interface UsdtInvoice {
  memo: string;
  units: number;
  amount: number;
  wallet: string;
  jetton: string;
  until: number;
  days: number;
}

/** Куда возвращается кошелёк после подписи: обратно в наш мини-апп. */
const APP_LINK = "https://t.me/WalletTrackerOfficial";

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const auth = initData();
  if (auth) headers.set("X-Telegram-Init-Data", auth);
  try {
    const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export type PayEnd = "paid" | "cancelled" | "failed" | "no_usdt" | "off";

/** Звёзды: ссылка на счёт от нашего API, окно оплаты — телеграмовское. */
export async function buyStars(lang: string): Promise<PayEnd> {
  const r = await post<{ ok: boolean; link?: string }>("/api/pay/stars", { lang });
  if (!r?.ok || !r.link) return "failed";
  const w = webApp();
  if (!w?.openInvoice) {
    // Обычный браузер: счёт открывается ссылкой, дальше человек в Telegram.
    window.open(r.link, "_blank", "noopener");
    return "cancelled";
  }
  const end = await new Promise<string>((done) => w.openInvoice!(r.link!, done));
  if (end !== "paid") return end === "cancelled" ? "cancelled" : "failed";
  // Подписку выдаёт бот по подтверждению от Telegram — ждём, пока дойдёт.
  await waitPremium(20000);
  return "paid";
}

/** Счёт на USDT: памятка, сумма и кошелёк получателя. */
export function usdtInvoice(): Promise<(UsdtInvoice & { ok: boolean; error?: string }) | null> {
  return post<UsdtInvoice & { ok: boolean; error?: string }>("/api/pay/usdt", {});
}

type Ui = {
  connected: boolean;
  account: { address: string } | null;
  openModal: () => Promise<void>;
  sendTransaction: (tx: {
    validUntil: number;
    messages: { address: string; amount: string; payload?: string }[];
  }) => Promise<unknown>;
  onStatusChange: (cb: (w: { account?: { address: string } } | null) => void) => () => void;
};

let ui: Ui | null = null;

async function wallet(): Promise<Ui> {
  if (ui) return ui;
  const { TonConnectUI } = await import("@tonconnect/ui");
  ui = new TonConnectUI({
    manifestUrl: `${location.origin}/tonconnect-manifest.json`,
    actionsConfiguration: { twaReturnUrl: APP_LINK as `${string}://${string}` },
  }) as unknown as Ui;
  return ui;
}

/** Ждём, пока кошелёк подключится: окно выбора закрывается раньше связи. */
function waitWallet(u: Ui, ms: number): Promise<string> {
  if (u.account?.address) return Promise.resolve(u.account.address);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      off();
      done("");
    }, ms);
    const off = u.onStatusChange((w) => {
      if (!w?.account?.address) return;
      clearTimeout(timer);
      off();
      done(w.account.address);
    });
  });
}

/**
 * Перевод USDT: подключаем кошелёк, считаем его жетонный адрес и отправляем
 * туда перевод с памяткой. Деньги идут на наш кошелёк, памятка говорит
 * серверу, чей это счёт.
 */
export async function payUsdt(inv: UsdtInvoice, step: (s: "wallet" | "sign" | "wait") => void): Promise<PayEnd> {
  let u: Ui;
  try {
    step("wallet");
    u = await wallet();
    if (!u.account?.address) await u.openModal();
  } catch {
    return "failed";
  }
  const owner = await waitWallet(u, 180000);
  if (!owner) return "cancelled";

  const jw = await post<{ ok: boolean; address?: string; error?: string }>("/api/pay/jetton", { owner });
  if (!jw?.ok || !jw.address) return jw?.error === "no_usdt" ? "no_usdt" : "failed";

  let payload: string;
  try {
    payload = jettonTransfer({
      units: BigInt(inv.units),
      to: inv.wallet,
      from: owner,
      comment: inv.memo,
    });
  } catch {
    return "failed";
  }

  try {
    step("sign");
    await u.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: [{
        address: jw.address,
        // На пересылку жетона и уведомление получателю. Остаток кошелёк
        // вернёт отправителю — это заложено в самом переводе.
        amount: "60000000",
        payload,
      }],
    });
  } catch {
    return "cancelled";
  }
  step("wait");
  return (await waitPremium(240000)) ? "paid" : "failed";
}

/** Опрос: сервер видит приход сам, нам остаётся дождаться ответа «премиум». */
export async function waitPremium(ms: number): Promise<boolean> {
  const till = Date.now() + ms;
  while (Date.now() < till) {
    const r = await post<{ ok: boolean; plan?: string }>("/api/pay/check", {});
    if (r?.plan === "premium") {
      await syncNow();
      return true;
    }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return false;
}
