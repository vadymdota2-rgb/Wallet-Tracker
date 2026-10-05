/**
 * Оболочка: шапка, выдвижное меню, вкладки, стек экранов.
 *
 * Разделы повторяют главное меню бота: кошельки, топ трейдеров, аналитика,
 * сонар и всё остальное. Человек, пришедший из чата, находит те же пункты и
 * те же слова — словари взяты из бота.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "./store/app";
import { useLive } from "./store/live";
import { Gift } from "./components/Gift";
import { PremBadge } from "./components/PremBadge";
import { LockScreen, LockSheet, useLocked } from "./components/LockScreen";
import { LOCK_OPEN_SCREENS } from "./lib/upsell";
import { HalvingCard } from "./components/HalvingCard";
import { t, bare } from "./i18n/t";
import { ensureLang, isRtl, normalizeLang } from "./i18n";
import { setLocale } from "./lib/format";
import { bootTelegram, haptic, initData, launchGo, telegramLang, waitForTelegram, webApp } from "./lib/telegram";
import { SOCIALS, openSocial } from "./lib/social";
import { startSync, syncNow } from "./lib/sync";
import { Toaster } from "./components/Toast";
import { Background } from "./components/Background";
import { AnalyticsGlyph, ChartGlyph, DigestGlyph, DomGlyph, EtfGlyph, FundLineGlyph, GaugeGlyph, LiqGlyph, UnlockGlyph, TopGlyph, WalletGlyph } from "./components/ui";
import { SCREENS } from "./screens/registry";
import { WalletsTab } from "./screens/WalletsTab";
import { TopTab } from "./screens/TopTab";
import { AnalyticsTab } from "./screens/AnalyticsTab";
import { DigestTab } from "./screens/DigestTab";
import { MoreTab } from "./screens/MoreTab";
import type { DictKey } from "./i18n/types";
import type { ScreenName, Tab } from "./store/app";



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
  liqmap: "lq_title",
  funding: "ui_tab_funding",
  fng: "fg_title",
  dom: "dm_title",
  etf: "ef_title",
  deals: "ui_deals",
  spot: "ui_spot_open",
  legal: "ui_legal",
  btcWallet: "btc_wallet_title",
  token: "tk_title",
  bonus: "bn_title",
  lock: "menu_premium",
};

/* Боковое меню — рыночные инструменты: график, разлоки, карта ликвидаций,
   фандинг, страх и жадность, доминация с альтсезоном, институциональные потоки.
   Порог, премиум,
   язык и помощь живут во вкладке «Ещё»; повторять их здесь значило держать
   две дороги к одному. */
const MENU: { name: ScreenName; key: DictKey; glyph: ReactNode }[] = [
  { name: "chart", key: "chart_title", glyph: <ChartGlyph /> },
  { name: "unlocks", key: "unl_title", glyph: <UnlockGlyph /> },
  { name: "liqmap", key: "lq_title", glyph: <LiqGlyph /> },
  { name: "funding", key: "ui_tab_funding", glyph: <FundLineGlyph /> },
  { name: "fng", key: "fg_title", glyph: <GaugeGlyph /> },
  { name: "dom", key: "dm_title", glyph: <DomGlyph /> },
  { name: "etf", key: "ef_title", glyph: <EtfGlyph /> },
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
  const menuOpen = useApp((s) => s.menuOpen);
  const setMenu = useApp((s) => s.setMenu);
  const openFromMenu = useApp((s) => s.openFromMenu);
  const locked = useLocked();
  const [i18nReady, setReady] = useState(false);

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

  // Запуск кнопкой бота «Забрать скидку», «Продлить», «Открыть дайджест» —
  // сразу туда. Один раз за сессию: при перезагрузке страницы Telegram
  // оставляет тот же адрес, и экран оплаты не должен всплывать снова.
  useEffect(() => {
    const go = launchGo();
    if (!go) return;
    try {
      if (sessionStorage.getItem("wt-go") === "1") return;
      sessionStorage.setItem("wt-go", "1");
    } catch {
      // без sessionStorage — просто открываем
    }
    if (go.to === "digest") goTab("digest");
    else if (go.to === "token") open("token");
    else if (go.to === "bonus") open("bonus");
    else open("premium", go.src);
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

  // Аппаратная кнопка «назад» Telegram ведёт по стеку экранов. Экран из
  // бокового меню возвращает в меню; открытое меню она закрывает — иначе
  // «назад» при открытом меню закрывал бы всё приложение.
  useEffect(() => {
    const btn = webApp()?.BackButton;
    if (!btn) return;
    const onBack = () => {
      if (stack.length) back();
      else setMenu(false);
    };
    btn.onClick?.(onBack);
    if (stack.length || menuOpen) btn.show?.();
    else btn.hide?.();
    return () => btn.offClick?.(onBack);
  }, [stack.length, menuOpen, back, setMenu]);

  // Заставка из index.html уходит, когда есть что показать: язык загружен
  // и первые данные (или снимок прошлого запуска) уже на месте.
  const shown = i18nReady && status !== "boot";
  useEffect(() => {
    if (shown) window.__wtSplash?.();
  }, [shown]);

  // Пока язык не загружен, приложение пустое: его закрывает заставка.
  if (!i18nReady) return null;

  const top = stack[stack.length - 1];
  /* Без Премиума открыты только экраны, где его получают, и служебные;
     остальное (график, кошелёк, история алертов…) — замок в рамке экрана. */
  const Screen = top
    ? locked && !(LOCK_OPEN_SCREENS as readonly string[]).includes(top.name) ? LockSheet : SCREENS[top.name]
    : null;
  const titleKey: DictKey = top
    ? SCREEN_TITLE[top.name]
    : (TABS.find((x) => x.id === tab)?.key ?? "menu_title");

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
          <HdrTitle text={bare(t(lang, titleKey))} />
        </h1>
        {/* Сколько осталось Премиума — вместо кнопки «обновить»: данные
            приходят сами (lib/sync.ts). */}
        <PremBadge />
      </header>

      {status === "offline" ? <p className="banner">{t(lang, "ui_offline")}</p> : null}

      <main className="body">
        {/* Без Премиума вкладки закрыты; «Ещё» открыта — там Премиум,
            Бонусы, язык и документы. */}
        {locked && tab !== "more" ? <LockScreen /> : <TabBody tab={tab} />}
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
                      onClick={() => { haptic("select"); openFromMenu(m.name); }}>
                <span aria-hidden="true">{m.glyph}</span>
                {bare(t(lang, m.key))}
                {locked ? <em className="drawer-lock" aria-hidden="true">🔒</em> : null}
              </button>
            ))}
            {/* Внизу меню — отсчёт до халвинга; дата сборки здесь была
                служебной и человеку ничего не говорила. */}
            <HalvingCard />
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
        {/* Официальные X (Twitter), канал Telegram, TikTok, Instagram и YouTube
            — самой нижней строкой, под документами. Канал открывается самим
            Telegram, без браузера. На самых узких экранах — одни значки. */}
        <div className="social-bar">
          {SOCIALS.map((so) => (
            <button key={so.id} type="button" aria-label={so.name}
              onClick={() => { haptic("select"); openSocial(so); }}>
              {so.icon(12)}
              <span>{so.name}</span>
            </button>
          ))}
        </div>
      </div>

      <Toaster />
    </div>
  );
}

/** Заголовок вкладки в шапке — целиком, без многоточия: не помещается —
 *  сначала плотнее буквы, потом мельче шрифт (до 11px). Длинные названия
 *  («Mes portefeuilles», «Melhores traders») на узком телефоне иначе
 *  обрезались бы, а короткие остаются крупными. */
function HdrTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const h1 = el?.parentElement;
    if (!el || !h1) return;
    const fit = () => {
      h1.style.fontSize = "";
      h1.style.letterSpacing = "";
      const over = () => el.scrollWidth > el.clientWidth + 1;
      if (!over()) return;
      h1.style.letterSpacing = "0.02em";
      let size = parseFloat(getComputedStyle(h1).fontSize);
      while (over() && size > 11) {
        size -= 0.5;
        h1.style.fontSize = `${size}px`;
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [text]);
  return <span ref={ref} className="hdr-txt">{text}</span>;
}
