/**
 * Состояние оболочки: язык, вкладка, стек экранов, выбранные фильтры.
 * Сохраняется в localStorage. Данные с сервера здесь не живут — они в
 * store/live.ts и заново приходят при каждом запуске.
 */
import { FREE } from "../lib/upsell";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LangCode } from "../i18n/types";
import type { CoinClass, FlowSide, RankKind, Venue } from "../lib/types";
import type { Timeframe } from "../lib/klines";

export type Tab = "wallets" | "top" | "analytics" | "digest" | "more";
/** Окно карты ликвидаций: сутки, неделя, месяц. */
export type LiqRange = "1d" | "7d" | "30d";

export type ScreenName =
  | "wallet" | "position" | "coin" | "deals"
  | "addWallet" | "threshold" | "lang" | "premium" | "help"
  | "alerts" | "chart" | "unlocks" | "liqmap" | "funding" | "fng" | "dom" | "etf" | "rename" | "spot"
  | "legal" | "btcWallet" | "token" | "bonus"
  // Замок «купить / бесплатно в Бонусах» отдельным экраном — значок
  // Премиума в шапке, когда дней ноль.
  | "lock";

interface Screen {
  name: ScreenName;
  /** Что открыли: адрес кошелька, тикер. */
  arg?: string;
  /** Второй ключ — например индекс позиции внутри кошелька. */
  arg2?: string;
  /** Открыт из бокового меню: «Назад» возвращает в меню, а не на вкладку. */
  menu?: boolean;
}

/** Окна крупных сделок — те же, что в боте. */
export type BigWin = "1h" | "6h" | "24h" | "7d" | "30d";
/** Сторона доски крупных ордеров. */
export type BigSide = "buy" | "sell";
/** Разделы аналитики — те же кнопки, что в меню бота. */
export type BigView = "flow" | "spot" | "perp" | "rot" | "ls" | "btc" | "bscx";
/** Площадка рейтинга: BSC, Hyperliquid и Bitcoin. */
export type RankVenue = Venue | "btc";
/** Порог крупных движений BTC, в монетах. */
export type BtcMin = 0.2 | 1 | 10 | 100;
/** Окна потока: часы. */
export type FlowWin = "1" | "6" | "24" | "168" | "720";
/** Окна рейтинга: дни. */
export type RankWin = "30" | "90" | "180" | "365";

interface AppState {
  lang: LangCode;
  /** Язык выбран человеком, а не подсказан Telegram. */
  langPinned: boolean;
  tab: Tab;
  stack: Screen[];
  /** Боковое меню открыто. Не сохраняется: запуск всегда без меню. */
  menuOpen: boolean;

  bigView: BigView;
  bigWin: BigWin;
  bigSide: BigSide;
  lsCls: CoinClass;
  flowWin: FlowWin;
  flowSide: FlowSide;
  flowQuery: string;
  /** Потоки бирж BSC — свои ручки: с NetFlow DEX не делятся. */
  bscxWin: FlowWin;
  bscxSide: FlowSide;
  bscxQuery: string;

  rankVenue: RankVenue;
  rankKind: RankKind;
  rankWin: RankWin;
  /** Крупные движения BTC: выводы с бирж или заводы, и от скольких монет. */
  btcSide: BigSide;
  btcMin: BtcMin;
  /** Биржа, по которой отфильтрован список крупных ордеров BTC; "" — все. */
  btcEx: string;

  chartTf: Timeframe;
  /** Монета полноэкранного графика TradingView — последняя открытая. */
  tvSym: string;
  /** Карта ликвидаций: монета и окно — последние выбранные. */
  liqSym: string;
  liqRange: LiqRange;
  /** Свои деньги в калькуляторе фандинга. Ноль — поле пустое, счёта нет. */
  fundAmount: number;
  /** Плечо: фандинг берут с объёма позиции, а он во столько раз больше. */
  fundLev: number;

  setLang(lang: LangCode, pinned?: boolean): void;
  goTab(tab: Tab): void;
  open(name: ScreenName, arg?: string, arg2?: string): void;
  /** Экран из бокового меню: меню закрывается, а «Назад» его вернёт. */
  openFromMenu(name: ScreenName): void;
  setMenu(open: boolean): void;
  back(): void;
  reset(): void;

  setBigView(v: BigView): void;
  setBigWin(w: BigWin): void;
  setFlowWin(w: FlowWin): void;
  setBigSide(s: BigSide): void;
  setLsCls(c: CoinClass): void;
  setFlowSide(s: FlowSide): void;
  setFlowQuery(q: string): void;
  setBscxWin(w: FlowWin): void;
  setBscxSide(s: FlowSide): void;
  setBscxQuery(q: string): void;
  setRankVenue(v: RankVenue): void;
  setBtcSide(s: BigSide): void;
  setBtcMin(m: BtcMin): void;
  setBtcEx(ex: string): void;
  setRankKind(k: RankKind): void;
  setRankWin(w: RankWin): void;
  setChartTf(tf: Timeframe): void;
  setTvSym(sym: string): void;
  setLiq(sym: string, range: LiqRange): void;
  setFundAmount(v: number): void;
  setFundLev(v: number): void;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      lang: "en",
      langPinned: false,
      /* Запуск всегда начинается с дайджеста: вкладка не сохраняется между
         запусками (см. partialize), и открытое вчера не решает за сегодня. */
      tab: "digest",
      stack: [],
      menuOpen: false,

      bigView: "flow",
      bigWin: "24h",
      bigSide: "buy",
      lsCls: "crypto",
      flowWin: "24",
      flowSide: "all",
      flowQuery: "",
      bscxWin: "24",
      bscxSide: "all",
      bscxQuery: "",

      rankVenue: "spot",
      rankKind: "pnl",
      rankWin: "30",
      btcSide: "buy",
      btcMin: 0.2,
      btcEx: "",

      chartTf: "1d",
      tvSym: "BTC",
      liqSym: "BTC",
      liqRange: "1d",
      fundAmount: 0,
      fundLev: 1,

      setLang: (lang, pinned = true) => set({ lang, langPinned: pinned || get().langPinned }),
      goTab: (tab) => set({ tab, stack: [] }),
      open: (name, arg, arg2) => set({ stack: [...get().stack, { name, arg, arg2 }] }),
      openFromMenu: (name) => set({ menuOpen: false, stack: [...get().stack, { name, menu: true }] }),
      setMenu: (menuOpen) => set({ menuOpen }),
      back: () => {
        const stack = get().stack;
        const top = stack[stack.length - 1];
        set({ stack: stack.slice(0, -1), menuOpen: Boolean(top?.menu) });
      },
      reset: () => set({ stack: [] }),

      setBigView: (bigView) => set({ bigView }),
      setBigWin: (bigWin) => set({ bigWin }),
      setFlowWin: (flowWin) => set({ flowWin }),
      setBigSide: (bigSide) => set({ bigSide }),
      setLsCls: (lsCls) => set({ lsCls }),
      setFlowSide: (flowSide) => set({ flowSide }),
      setFlowQuery: (flowQuery) => set({ flowQuery }),
      setBscxWin: (bscxWin) => set({ bscxWin }),
      setBscxSide: (bscxSide) => set({ bscxSide }),
      setBscxQuery: (bscxQuery) => set({ bscxQuery }),
      setRankVenue: (rankVenue) => set({ rankVenue }),
      setRankKind: (rankKind) => set({ rankKind }),
      setRankWin: (rankWin) => set({ rankWin }),
      setBtcSide: (btcSide) => set({ btcSide }),
      setBtcMin: (btcMin) => set({ btcMin }),
      setBtcEx: (btcEx) => set({ btcEx }),
      setChartTf: (chartTf) => set({ chartTf }),
      setTvSym: (tvSym) => set({ tvSym }),
      setLiq: (liqSym, liqRange) => set({ liqSym, liqRange }),
      setFundAmount: (fundAmount) => set({ fundAmount: Math.max(0, fundAmount) }),
      /* Сто двадцать пять — предел самых щедрых бирж; выше плеча не бывает, а
         опечатка в поле не должна рисовать миллионные доходы. */
      setFundLev: (fundLev) => set({ fundLev: Math.min(125, Math.max(1, fundLev || 1)) }),
    }),
    {
      name: "wt-miniapp-v7",
      /* Поле суммы раньше приходило заполненным тысячей, и у всех, кто уже
         открывал приложение, она осталась в памяти. Считать за человека
         сумму, которой он не вводил, нельзя: переход на первую версию
         стирает её и оставляет поле пустым. */
      /* Шестая версия — Cortex убран, на его месте вкладка «Дайджест».
         Поля Cortex (площадка, окно, сторона) и старого Sonar стираются, а
         тех, кто закрыл приложение на вкладке сигналов, встречает дайджест. */
      /* Седьмая — вкладка больше не хранится: запуск всегда с дайджеста.
         У тех, кто открывал раньше, сохранённая вкладка стирается, иначе
         при загрузке она легла бы поверх дайджеста. */
      /* Восьмая — у крупных движений BTC порог по умолчанию стал 0,2 вместо
         1: прежняя «1» почти у всех стояла сама, по умолчанию.
         Девятая — у крупных ордеров BTC нет выбора «база / все» и порога
         «все» (он был только у базы); вместо них — фильтр по бирже. */
      version: 9,
      migrate: (prev, from) => {
        let s = prev as Record<string, unknown>;
        if (from < 1) s = { ...s, fundAmount: 0, fundLev: 1 };
        if (from < 6) {
          const { sonarVenue, sonarWin, cortexVenue, cortexWin, cortexSide, ...rest } = s as {
            sonarVenue?: unknown; sonarWin?: unknown; cortexVenue?: unknown;
            cortexWin?: unknown; cortexSide?: unknown; [k: string]: unknown;
          };
          void sonarVenue; void sonarWin; void cortexVenue; void cortexWin; void cortexSide;
          s = rest;
          if (s.tab === "sonar" || s.tab === "cortex") s.tab = "digest";
        }
        // Вкладка больше не хранится: запуск всегда с дайджеста.
        delete s.tab;
        if (from < 8 && s.btcMin === 1) s.btcMin = 0.2;
        if (from < 9) {
          delete s.btcBase;
          if (s.btcMin === 0) s.btcMin = 0.2;
        }
        return s;
      },
      // Стек экранов не сохраняем: запуск всегда начинается с вкладки.
      partialize: (s) => ({
        lang: s.lang,
        langPinned: s.langPinned,
        bigView: s.bigView,
        bigWin: s.bigWin,
        bigSide: s.bigSide,
        lsCls: s.lsCls,
        flowWin: s.flowWin,
        flowSide: s.flowSide,
        bscxWin: s.bscxWin,
        bscxSide: s.bscxSide,
        rankVenue: s.rankVenue,
        rankKind: s.rankKind,
        rankWin: s.rankWin,
        btcSide: s.btcSide,
        btcMin: s.btcMin,
        btcEx: s.btcEx,
        chartTf: s.chartTf,
        tvSym: s.tvSym,
        liqSym: s.liqSym,
        liqRange: s.liqRange,
        fundAmount: s.fundAmount,
        fundLev: s.fundLev,
      }),
    },
  ),
);

/** Лимит кошельков — то же число, что в premium.cpp бота: приложением
 *  пользуются только с Премиумом. У сервисного аккаунта лимита нет: он
 *  держит базу кошельков. */
export function walletLimit(service = false): number {
  return service ? Infinity : FREE.premiumWallets;
}
