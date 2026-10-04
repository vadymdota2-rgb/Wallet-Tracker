/**
 * Официальные соцсети проекта — одним списком: из него собираются нижняя
 * строка ссылок (App) и бонусы за подписку («Ещё» → «Бонусы»). Ключи `id` —
 * те же, что SOCIAL_BONUS в whale_api.py: по ним сервер выдаёт дни.
 *
 * Канал Telegram открывается самим Telegram (openTg), остальное — его
 * встроенным браузером (openExternal): приложение остаётся открытым.
 */
import type { ReactNode } from "react";
import { openExternal, openTg } from "./telegram";

export type SocialId = "x" | "tg" | "tiktok" | "instagram" | "youtube";

export interface Social {
  id: SocialId;
  name: string;
  url: string;
  icon: (size: number) => ReactNode;
}

export const SOCIALS: Social[] = [
  {
    id: "x",
    name: "Twitter",
    url: "https://x.com/WalletTrackerX",
    icon: (s) => (
      <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">
        <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    id: "tg",
    name: "Telegram",
    url: "https://t.me/WalletTrackerOfficial",
    icon: (s) => (
      <svg viewBox="0 0 24 24" width={s + 1} height={s + 1} aria-hidden="true">
        <path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
      </svg>
    ),
  },
  {
    id: "tiktok",
    name: "TikTok",
    url: "https://www.tiktok.com/@wallettrackerbot",
    icon: (s) => (
      <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">
        <path fill="currentColor" d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
      </svg>
    ),
  },
  {
    id: "instagram",
    name: "Instagram",
    url: "https://www.instagram.com/wallettrackerbot",
    icon: (s) => (
      <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="17.4" cy="6.6" r="1.3" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "youtube",
    name: "YouTube",
    url: "https://www.youtube.com/@wallettracker",
    icon: (s) => (
      <svg viewBox="0 0 24 24" width={s + 1} height={s + 1} aria-hidden="true">
        <path fill="currentColor" d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z" />
      </svg>
    ),
  },
];

/** Открыть соцсеть: канал — самим Telegram, остальное — его браузером. */
export function openSocial(s: Social): void {
  if (s.id === "tg") openTg(s.url);
  else openExternal(s.url);
}
