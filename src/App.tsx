/**
 * Оболочка: шапка, выдвижное меню, вкладки, стек экранов.
 *
 * Разделы повторяют главное меню бота: кошельки, топ трейдеров, аналитика,
 * сонар и всё остальное. Человек, пришедший из чата, находит те же пункты и
 * те же слова — словари взяты из бота.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "./store/app";
import { useLive } from "./store/live";
import { Gift } from "./components/Gift";
import { t, bare } from "./i18n/t";
import { ensureLang, isRtl, normalizeLang } from "./i18n";
import { setLocale } from "./lib/format";
import { bootTelegram, haptic, initData, telegramLang, waitForTelegram, webApp } from "./lib/telegram";
import { startSync, syncNow } from "./lib/sync";
import { Toaster, toast } from "./components/Toast";
import { Background } from "./components/Background";
import { AnalyticsGlyph, ChartGlyph, DigestGlyph, UnlockGlyph, TopGlyph, WalletGlyph } from "./components/ui";
import { SCREENS } from "./screens/registry";
import { WalletsTab } from "./screens/WalletsTab";
import { TopTab } from "./screens/TopTab";
import { AnalyticsTab } from "./screens/AnalyticsTab";
import { DigestTab } from "./screens/DigestTab";
import { MoreTab } from "./screens/MoreTab";
import type { DictKey } from "./i18n/types";
import type { ScreenName, Tab } from "./store/app";

declare const __BUILD__: string;

const TABS: { id: Tab; key: DictKey; glyph: ReactNode }[] = [
  { id: "wallets", key: "menu_my_wallets", glyph: <WalletGlyph /> },
  { id: "top", key: "menu_top_traders", glyph: <TopGlyph /> },
  { id: "analytics", key: "menu_big_trades", glyph: <AnalyticsGlyph /> },
  { id: "digest", key: "dg_title", glyph: <DigestGlyph /> },
  { id: "more", key: "ui_more", glyph: "⋯" },
];

/** Заголовок шапки — по активной вкладке или по открытому экрану. */
const SCREEN_TITLE: Record<ScreenName, DictKey> = {
  wallet: "account_title",
  position: "hl_open_positions",
  coin: "flow_title",
  addWallet: "add_wallet_title",
  rename: "rename_title",
  threshold: "threshold_title",
  lang: "lang_title",
  premium: "menu_premium",
  help: "help_title",
  alerts: "alerts_title",
  chart: "chart_title",
  unlocks: "unl_title",
  deals: "ui_deals",
  spot: "ui_spot_open",
  legal: "ui_legal",
};

/* Боковое меню — рыночные инструменты: график и разлоки. Порог, премиум,
   язык и помощь живут во вкладке «Ещё»; повторять их здесь значило держать
   две дороги к одному. */
const MENU: { name: ScreenName; key: DictKey; glyph: ReactNode }[] = [
  { name: "chart", key: "chart_title", glyph: <ChartGlyph /> },
  { name: "unlocks", key: "unl_title", glyph: <UnlockGlyph /> },
];

function TabBody({ tab }: { tab: Tab }) {
  switch (tab) {
    case "wallets":
      return <WalletsTab />;
    case "top":
      return <TopTab />;
    case "analytics":
      return <AnalyticsTab />;
    case "digest":
      return <DigestTab />;
    case "more":
      return <MoreTab />;
  }
}

export default function App() {
  const lang = useApp((s) => s.lang);
  const langPinned = useApp((s) => s.langPinned);
  const setLang = useApp((s) => s.setLang);
  const tab = useApp((s) => s.tab);
  const unread = useLive((s) => s.me.unread ?? 0);
  const goTab = useApp((s) => s.goTab);
  const stack = useApp((s) => s.stack);
  const back = useApp((s) => s.back);
  const open = useApp((s) => s.open);

  const status = useLive((s) => s.status);
  const [menuOpen, setMenu] = useState(false);
  const [i18nReady, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  // Язык: выбор человека главнее подсказки Telegram. Прошлая версия при
  // отсутствии явного выбора принудительно ставила английский и выбор
  // языка в боте игнорировала.
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
    // Мост Telegram грузится параллельно и может опоздать. Экран уже
    // отрисован (данные — из сохранённого снимка), поэтому просто ждём
    // подписи, а не отрисовки: опрос без неё вернул бы только общее.
    let stop: (() => void) | null = null;
    let dead = false;
    void waitForTelegram().then(() => {
      if (dead) return;
      bootTelegram();
      const signed = Boolean(initData());
      stop = startSync();
      // Подпись обычно уже есть — из адреса запуска. Мост Telegram может
      // прийти позже: тогда разворачиваем окно, когда он придёт, а если
      // подписи не было вовсе — сразу спрашиваем заново, уже с ней.
      if (!webApp()) {
        const started = Date.now();
        const poll = () => {
          if (dead) return;
          if (webApp()) {
            bootTelegram();
            if (!signed && initData()) void syncNow();
            return;
          }
          if (Date.now() - started < 30000) setTimeout(poll, 100);
        };
        poll();
      }
    });
    return () => {
      dead = true;
      stop?.();
    };
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
  const titleKey: DictKey = top
    ? SCREEN_TITLE[top.name]
    : (TABS.find((x) => x.id === tab)?.key ?? "menu_title");

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    haptic("light");
    const ok = await syncNow();
    if (!ok) toast(t(lang, "ui_sync_failed"), "err");
    setBusy(false);
  };

  return (
    <div className="app">
      <Background />

      <header className="hdr">
        <button type="button" className="burger" onClick={() => { haptic("select"); setMenu(true); }}
                aria-label={t(lang, "ui_more")}>
          <span /><span /><span />
        </button>
        <h1 className="hdr-ttl">
          <span className="hdr-mark" aria-hidden="true">◱</span>
          {bare(t(lang, titleKey))}
        </h1>
        {/* Состояние — с приставкой: голое «boot» совпадало с классом заставки
            (.boot { position: fixed; inset: 0 }), и до первой выгрузки кнопка
            выпадала из шапки в левый верхний угол, поверх меню. */}
        <button type="button" className={`refresh st-${status}${busy ? " spin" : ""}`}
                onClick={refresh} aria-label={t(lang, "ui_updated")}>↻</button>
      </header>

      {status === "offline" ? <p className="banner">{t(lang, "ui_offline")}</p> : null}

      <main className="body">
        <TabBody tab={tab} />
      </main>

      <Gift />

      {Screen ? (
        <div className="sheet" role="dialog" aria-modal="true">
          <Screen arg={top?.arg} arg2={top?.arg2} />
        </div>
      ) : null}

      {menuOpen ? (
        <div className="drawer-wrap" onClick={() => setMenu(false)}>
          <nav className="drawer" onClick={(e) => e.stopPropagation()} aria-label={t(lang, "menu_title")}>
            <p className="drawer-ttl">{bare(t(lang, "menu_title"))}</p>
            {MENU.map((m) => (
              <button key={m.name} type="button" className="drawer-row"
                      onClick={() => { haptic("select"); setMenu(false); open(m.name); }}>
                <span aria-hidden="true">{m.glyph}</span>
                {bare(t(lang, m.key))}
              </button>
            ))}
            <p className="drawer-build">{__BUILD__}</p>
          </nav>
        </div>
      ) : null}

      <div className="dock">
        <nav className="tabs" aria-label="sections">
          {TABS.map((it) => (
            <button key={it.id} type="button" className={it.id === tab ? "on" : undefined}
                    aria-current={it.id === tab}
                    onClick={() => { haptic("select"); goTab(it.id); }}>
              <span aria-hidden="true">{it.glyph}</span>
              {/* Новые алерты — на вкладке «Ещё», где лежит их история: при
                  «только в приложении» это единственный знак, что что-то пришло. */}
              {it.id === "more" && unread > 0 ? (
                <i className="tab-badge" aria-label={`${unread} ${t(lang, "alerts_new")}`}>
                  {unread > 99 ? "99+" : unread}
                </i>
              ) : null}
              <small>{bare(t(lang, it.key))}</small>
            </button>
          ))}
        </nav>
        {/* Документы — с любого экрана, а не только из «Ещё». Кнопки две, по
            одной на документ: «Документы» одним словом не говорят, что внутри,
            а магазины приложений и сами люди спрашивают именно политику или
            именно условия. Экран общий, но каждая кнопка открывает его сразу
            на своём разделе — иначе выбор был бы обещанием без разницы. */}
        <div className="legal-bar">
          <button type="button" onClick={() => { haptic("select"); open("legal", "privacy"); }}>
            {bare(t(lang, "legal_btn_privacy"))}
          </button>
          <i aria-hidden="true">·</i>
          <button type="button" onClick={() => { haptic("select"); open("legal", "terms"); }}>
            {bare(t(lang, "legal_terms_title"))}
          </button>
        </div>
      </div>

      <Toaster />
    </div>
  );
}
