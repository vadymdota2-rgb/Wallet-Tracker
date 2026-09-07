/**
 * Оболочка: шапка, вкладки, стек экранов.
 *
 * Вкладки повторяют главное меню бота: кошельки, топ трейдеров, аналитика,
 * сонар и всё остальное. Человек, пришедший из чата, находит те же разделы
 * и те же слова — словари взяты из бота.
 */
import { useEffect, useState } from "react";
import { useApp } from "./store/app";
import { useLive } from "./store/live";
import { t, bare } from "./i18n/t";
import { ensureLang, isRtl, normalizeLang } from "./i18n";
import { setLocale } from "./lib/format";
import { bootTelegram, haptic, telegramLang, webApp } from "./lib/telegram";
import { startSync, syncNow } from "./lib/sync";
import { Toaster, toast } from "./components/Toast";
import { SCREENS } from "./screens/registry";
import { WalletsTab } from "./screens/WalletsTab";
import { TopTab } from "./screens/TopTab";
import { AnalyticsTab } from "./screens/AnalyticsTab";
import { SonarTab } from "./screens/SonarTab";
import { MoreTab } from "./screens/MoreTab";
import type { Tab } from "./store/app";

declare const __BUILD__: string;

const TABS: { id: Tab; key: Parameters<typeof t>[1]; glyph: string }[] = [
  { id: "wallets", key: "menu_my_wallets", glyph: "💼" },
  { id: "top", key: "menu_top_traders", glyph: "🏆" },
  { id: "analytics", key: "menu_big_trades", glyph: "📊" },
  { id: "sonar", key: "ai_title", glyph: "📡" },
  { id: "more", key: "ui_more", glyph: "⋯" },
];

function TabBody({ tab }: { tab: Tab }) {
  switch (tab) {
    case "wallets":
      return <WalletsTab />;
    case "top":
      return <TopTab />;
    case "analytics":
      return <AnalyticsTab />;
    case "sonar":
      return <SonarTab />;
    case "more":
      return <MoreTab />;
  }
}

export default function App() {
  const lang = useApp((s) => s.lang);
  const langPinned = useApp((s) => s.langPinned);
  const setLang = useApp((s) => s.setLang);
  const tab = useApp((s) => s.tab);
  const goTab = useApp((s) => s.goTab);
  const stack = useApp((s) => s.stack);
  const back = useApp((s) => s.back);

  const status = useLive((s) => s.status);

  // Язык: выбор человека главнее подсказки Telegram. Прошлая версия при
  // отсутствии явного выбора принудительно ставила английский и выбор
  // языка в боте игнорировала.
  const [i18nReady, setReady] = useState(false);
  useEffect(() => {
    const guess = langPinned ? null : normalizeLang(telegramLang());
    const want = guess && guess !== lang ? guess : lang;
    let alive = true;
    void ensureLang(want).then(() => {
      if (!alive) return;
      setLocale(want);
      if (want !== lang) setLang(want, false);
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // Достаточно одного прохода на старте: дальше язык меняет applyLang,
    // который сначала грузит словарь и только потом трогает состояние.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLocale(lang);
    const root = document.documentElement;
    root.lang = lang;
    root.dir = isRtl(lang) ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    bootTelegram();
    return startSync();
  }, []);

  // Аппаратная кнопка «назад» Telegram ведёт по стеку экранов.
  useEffect(() => {
    const btn = webApp()?.BackButton;
    if (!btn) return;
    const onBack = () => back();
    btn.onClick?.(onBack);
    if (stack.length) btn.show?.();
    else btn.hide?.();
    return () => btn.offClick?.(onBack);
  }, [stack.length, back]);

  if (!i18nReady) return <div className="boot">WALLET TRACKER</div>;

  const top = stack[stack.length - 1];
  const Screen = top ? SCREENS[top.name] : null;

  return (
    <div className="app">
      <header className="hdr">
        <button
          type="button"
          className="brand"
          onClick={() => {
            haptic("light");
            goTab("wallets");
          }}
        >
          <span className="brand-mark" aria-hidden="true" />
          <span>Wallet Tracker</span>
        </button>
        <button
          type="button"
          className={`sync ${status}`}
          onClick={async () => {
            haptic("light");
            const ok = await syncNow();
            if (!ok) toast(t(lang, "ui_sync_failed"), "err");
          }}
          aria-label={t(lang, "ui_updated")}
        >
          <span className="dot" />
        </button>
      </header>

      {status === "offline" ? <p className="banner">{t(lang, "ui_offline")}</p> : null}

      <main className="body">
        <TabBody tab={tab} />
      </main>

      {Screen ? (
        <div className="sheet" role="dialog" aria-modal="true">
          <Screen arg={top?.arg} arg2={top?.arg2} />
        </div>
      ) : null}

      <nav className="tabs" aria-label="sections">
        {TABS.map((it) => (
          <button
            key={it.id}
            type="button"
            className={it.id === tab ? "on" : undefined}
            aria-current={it.id === tab}
            onClick={() => {
              haptic("select");
              goTab(it.id);
            }}
          >
            <span aria-hidden="true">{it.glyph}</span>
            <small>{bare(t(lang, it.key))}</small>
          </button>
        ))}
      </nav>

      <p className="build" aria-hidden="true">{__BUILD__}</p>
      <Toaster />
    </div>
  );
}
