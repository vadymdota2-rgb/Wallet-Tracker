/**
 * Самоочистка хранилища на устройстве.
 *
 * Приложение кладёт в localStorage запасные ответы сервера и настройки
 * экранов. Ключи со временем меняются (версия в имени, убранные разделы), а
 * старые сами не исчезают: у давних пользователей копились мегабайты, которые
 * никто не читает, а место у WebView Telegram небольшое — кончится, и новые
 * запасы перестанут сохраняться.
 *
 * Раз за запуск, когда приложение уже нарисовано:
 *  1. ключ «wt-…», которого нет в списке ниже, — удаляется (старые версии и
 *     убранные разделы); чужие ключи (Telegram и прочие) не трогаем;
 *  2. в запасах вида { ключ: { at, v } } — удаляются записи старше месяца;
 *  3. отсчёт халвинга, который уже прошёл, — удаляется;
 *  4. время правки рисунков у монет, где рисунков нет и правили больше трёх
 *     месяцев назад, — удаляется (сервер такие строки тоже стирает).
 *
 * Новый ключ в коде обязан попасть в KEEP — иначе его сотрёт при следующем
 * запуске. Это проверяет tools/guard.py.
 */
const KEEP = new Set([
  "wt-miniapp-v7", "wt-snapshot-v1",
  "wt-unlocks-v1", "wt-unl-tip-v1", "wt-unl-detail",
  "wt-options-v1", "wt-oihist-v1", "wt-liqmap-v1", "wt-liqcoins-v1", "wt-halving-v1", "wt-fng-v1", "wt-fg-range",
  "wt-exflows-v1", "wt-etf-v1", "wt-etf-range", "wt-etf-mode", "wt-dom-v2", "wt-dom-range",
  "wt-dg-seen", "wt-dg-anon", "wt-calendar-v1", "wt-btc-ex-open", "wt-bscx-ex-open",
  "wt-chart-v1", "wt-chart-draw-v1", "wt-chart-draw-at-v1", "wt-chart-gest",
  "wt-digest-v1", "wt-btcw-v1",
]);

/** Запасы ответов: { ключ запроса: { at, v } }. */
const SAVED_MAPS = [
  "wt-options-v1", "wt-oihist-v1", "wt-liqmap-v1", "wt-liqcoins-v1", "wt-halving-v1", "wt-fng-v1",
  "wt-exflows-v1", "wt-etf-v1", "wt-dom-v2", "wt-calendar-v1", "wt-digest-v1", "wt-btcw-v1",
];
const SAVED_MAX_AGE = 30 * 24 * 3600_000;
const DRAW_AT_MAX_AGE = 90 * 24 * 3600_000;

function json(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function put(key: string, v: object): void {
  if (Object.keys(v).length) localStorage.setItem(key, JSON.stringify(v));
  else localStorage.removeItem(key);
}

export function sweepStorage(): void {
  try {
    const now = Date.now();
    // 1. Чужие для нас «wt-…»: старые версии и убранные разделы.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) if (k.startsWith("wt-") && !KEEP.has(k)) localStorage.removeItem(k);

    // 2. Старые запасы ответов.
    for (const key of SAVED_MAPS) {
      const all = json(key);
      if (!all || typeof all !== "object") continue;
      const map = all as Record<string, { at?: number; v?: { eta?: number } }>;
      let changed = false;
      for (const [k, e] of Object.entries(map)) {
        const at = Number(e?.at) || 0;
        // 3. Халвинг, который уже прошёл, — тоже в мусор.
        const gone = key === "wt-halving-v1" && Number(e?.v?.eta) > 0 && Number(e?.v?.eta) * 1000 < now;
        if (!at || now - at > SAVED_MAX_AGE || gone) {
          delete map[k];
          changed = true;
        }
      }
      if (changed) put(key, map);
    }

    const unl = json("wt-unlocks-v1") as { at?: number } | null;
    if (unl && now - (Number(unl.at) || 0) > SAVED_MAX_AGE) localStorage.removeItem("wt-unlocks-v1");

    // 4. Время правки рисунков у монет без рисунков.
    const draw = (json("wt-chart-draw-v1") ?? {}) as Record<string, unknown>;
    const ats = json("wt-chart-draw-at-v1");
    if (ats && typeof ats === "object") {
      const map = ats as Record<string, number>;
      let changed = false;
      for (const [sym, at] of Object.entries(map)) {
        if (!draw[sym] && now - (Number(at) || 0) > DRAW_AT_MAX_AGE) {
          delete map[sym];
          changed = true;
        }
      }
      if (changed) put("wt-chart-draw-at-v1", map);
    }
  } catch {
    // Хранилище закрыто или занято — уберёмся в следующий раз.
  }
}
