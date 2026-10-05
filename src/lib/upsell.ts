/**
 * Пейволл: откуда человек пришёл к Премиуму и что ему показать.
 *
 * Без Премиума приложение закрыто целиком — вкладки, боковое меню, история
 * алертов (LockScreen); дни можно получить бесплатно в «Бонусах». Источник
 * уходит на экран Премиума — заголовок говорит про то, с чем человек пришёл
 * (письмо бота о конце пробы, скидка, алерт без цены входа), — и в замер
 * воронки.
 */
import type { DictKey } from "../i18n/types";

/** Числа тарифов — те же, что в whale_api.py и premium.cpp бота. */
export const FREE = {
  /** Первые шаги: сколько кошельков стоит добавить сразу. */
  wallets: 3,
  /** Дней пробного Премиума при первом открытии (TRIAL_DAYS в whale_api.py). */
  trialDays: 14,
  premiumWallets: 50,
  premiumTop: 100,
  premiumDeals: 50,
} as const;

export type PaySrc =
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
  // Замок на всё приложение.
  | "lock"
  // Значок Премиума в шапке.
  | "hdr";

/** Заголовок экрана Премиума по поводу, с которым человек пришёл. Для общих
 *  входов (меню, помощь, подарок, замок) — общий заголовок. */
export const SRC_HEAD: Partial<Record<PaySrc, DictKey>> = {
  alert: "pw_h_alert",
  trial: "pw_h_trial",
  intro: "pw_h_intro",
  ended: "pw_h_back",
  back: "pw_h_back",
};

export function isPaySrc(v: unknown): v is PaySrc {
  return typeof v === "string" && /^[a-z]{2,12}$/.test(v);
}

/** Экраны, открытые и без Премиума: где его получают, и служебные. */
export const LOCK_OPEN_SCREENS = ["premium", "bonus", "token", "lang", "help", "legal"] as const;
