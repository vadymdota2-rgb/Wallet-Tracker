/**
 * Пейволл: откуда человек пришёл к премиуму и что ему показать.
 *
 * Экран премиума открывается там, где желание сильнее всего: упёрся в лимит
 * кошельков, открыл позицию Hyperliquid за замком, долистал до конца
 * бесплатного топа. Источник уходит на экран — заголовок говорит ровно про
 * то, за чем человек пришёл, — и в замер воронки, где видно, какой замок
 * продаёт, а какой только раздражает.
 *
 * Числа бесплатного тарифа — те же, что FREE_* в whale_api.py и
 * FREE_ALERT_WALLETS в main.cpp бота: сервер всё равно срежет лишнее, а
 * приложение должно честно сказать, сколько и чего за замком.
 */
import type { DictKey } from "../i18n/types";

export const FREE = {
  /** Сколько кошельков можно добавить бесплатно. */
  wallets: 3,
  /** С скольких из них идут алерты: только с основного. */
  alertWallets: 1,
  /** Дней пробного премиума при первом открытии (TRIAL_DAYS в whale_api.py). */
  trialDays: 14,
  premiumWallets: 50,
  top: 10,
  premiumTop: 100,
  /** Минут задержки у сделок китов. */
  delayMin: 15,
  deals: 10,
  premiumDeals: 50,
  /** Мест на витрине Hyperliquid. */
  showcase: 3,
} as const;

/** Окна, открытые всем. */
export const FREE_BIG_WINS = ["1h", "6h", "24h"] as const;
export const FREE_FLOW_WINS = ["1", "6", "24"] as const;

export type PaySrc =
  | "wallets"
  | "perp"
  | "top"
  | "window"
  | "delay"
  | "history"
  | "digest"
  | "more"
  | "help"
  | "gift"
  | "trial"
  // Кнопки бота: бесплатный алерт без цены входа, письма жизненного цикла.
  | "alert"
  | "intro"
  | "ended"
  | "renew"
  | "back"
  | "tg"
  // Меню: длинные окна карты ликвидаций, реакция цены на разлоки.
  | "liq"
  | "unlock";

/** Заголовок экрана премиума по поводу, с которым человек пришёл. Для общих
 *  входов (меню, помощь, подарок) — общий заголовок. */
export const SRC_HEAD: Partial<Record<PaySrc, DictKey>> = {
  wallets: "pw_h_wallets",
  perp: "pw_h_perp",
  top: "pw_h_top",
  window: "pw_h_window",
  delay: "pw_h_delay",
  history: "pw_h_history",
  digest: "pw_h_digest",
  alert: "pw_h_alert",
  trial: "pw_h_trial",
  intro: "pw_h_intro",
  ended: "pw_h_back",
  back: "pw_h_back",
  liq: "pw_h_liq",
  unlock: "pw_h_unlock",
};

export function isPaySrc(v: unknown): v is PaySrc {
  return typeof v === "string" && /^[a-z]{2,12}$/.test(v);
}
