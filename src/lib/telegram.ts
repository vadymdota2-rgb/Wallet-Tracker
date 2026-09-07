/** Мост к Telegram WebApp. Всё опционально: приложение обязано работать
 *  и в обычном браузере, где объекта Telegram нет вовсе. */

type Impact = "light" | "medium" | "heavy" | "rigid" | "soft";
type Notify = "error" | "success" | "warning";

interface HapticFeedback {
  impactOccurred?(style: Impact): void;
  notificationOccurred?(type: Notify): void;
  selectionChanged?(): void;
}

interface BackButton {
  show?(): void;
  hide?(): void;
  onClick?(cb: () => void): void;
  offClick?(cb: () => void): void;
}

export interface WebApp {
  initData?: string;
  initDataUnsafe?: { user?: { id?: number; language_code?: string } };
  colorScheme?: string;
  themeParams?: Record<string, string>;
  ready?(): void;
  expand?(): void;
  close?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  HapticFeedback?: HapticFeedback;
  BackButton?: BackButton;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

export function webApp(): WebApp | null {
  try {
    return window.Telegram?.WebApp ?? null;
  } catch {
    return null;
  }
}

export function initData(): string {
  return webApp()?.initData ?? "";
}

/** Язык из Telegram — подсказка, а не приказ: выбор пользователя главнее. */
export function telegramLang(): string {
  return webApp()?.initDataUnsafe?.user?.language_code ?? "";
}

export function haptic(kind: Impact | Notify | "select" = "light"): void {
  const h = webApp()?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === "select") h.selectionChanged?.();
    else if (kind === "error" || kind === "success" || kind === "warning") h.notificationOccurred?.(kind);
    else h.impactOccurred?.(kind);
  } catch {
    /* вибрация не критична */
  }
}

/** Разворачивает окно и красит шапку под тему приложения. */
export function bootTelegram(): void {
  const w = webApp();
  if (!w) return;
  try {
    w.ready?.();
    w.expand?.();
    w.setHeaderColor?.("#01030A");
    w.setBackgroundColor?.("#01030A");
  } catch {
    /* старый клиент — не беда */
  }
}
