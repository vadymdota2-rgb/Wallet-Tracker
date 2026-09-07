/**
 * Состояние оболочки: язык, вкладка, стек экранов, выбранные фильтры.
 * Сохраняется в localStorage. Данные с сервера здесь не живут — они в
 * store/live.ts и заново приходят при каждом запуске.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LangCode } from "../i18n/types";
import type { RankKind, Venue } from "../lib/types";

export type Tab = "wallets" | "top" | "analytics" | "sonar" | "more";

export type ScreenName =
  | "wallet" | "position" | "coin" | "trader" | "signal"
  | "addWallet" | "threshold" | "lang" | "premium" | "help"
  | "positions" | "history" | "model" | "rename";

export interface Screen {
  name: ScreenName;
  /** Что открыли: адрес кошелька, тикер, индекс сигнала. */
  arg?: string;
  /** Второй ключ — например индекс позиции внутри кошелька. */
  arg2?: string;
}

/** Окна крупных сделок — те же, что в боте. */
export type BigWin = "1h" | "24h" | "7d" | "30d";
/** Разделы аналитики — те же кнопки, что в меню бота. */
export type BigView = "flow" | "spot" | "perp" | "liq" | "fund" | "rot";
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

  bigView: BigView;
  bigWin: BigWin;
  flowWin: FlowWin;
  flowQuery: string;

  rankVenue: Venue;
  rankKind: RankKind;
  rankWin: RankWin;

  sonarVenue: Venue;
  sonarWin: number;
  chartTf: "1h" | "1d" | "1w";

  setLang(lang: LangCode, pinned?: boolean): void;
  goTab(tab: Tab): void;
  open(name: ScreenName, arg?: string, arg2?: string): void;
  back(): void;
  reset(): void;

  setBigView(v: BigView): void;
  setBigWin(w: BigWin): void;
  setFlowWin(w: FlowWin): void;
  setFlowQuery(q: string): void;
  setRankVenue(v: Venue): void;
  setRankKind(k: RankKind): void;
  setRankWin(w: RankWin): void;
  setSonarVenue(v: Venue): void;
  setSonarWin(h: number): void;
  setChartTf(tf: "1h" | "1d" | "1w"): void;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      lang: "en",
      langPinned: false,
      tab: "wallets",
      stack: [],

      bigView: "flow",
      bigWin: "24h",
      flowWin: "24",
      flowQuery: "",

      rankVenue: "spot",
      rankKind: "pnl",
      rankWin: "30",

      sonarVenue: "spot",
      sonarWin: 24,
      chartTf: "1d",

      setLang: (lang, pinned = true) => set({ lang, langPinned: pinned || get().langPinned }),
      goTab: (tab) => set({ tab, stack: [] }),
      open: (name, arg, arg2) => set({ stack: [...get().stack, { name, arg, arg2 }] }),
      back: () => set({ stack: get().stack.slice(0, -1) }),
      reset: () => set({ stack: [] }),

      setBigView: (bigView) => set({ bigView }),
      setBigWin: (bigWin) => set({ bigWin }),
      setFlowWin: (flowWin) => set({ flowWin }),
      setFlowQuery: (flowQuery) => set({ flowQuery }),
      setRankVenue: (rankVenue) => set({ rankVenue }),
      setRankKind: (rankKind) => set({ rankKind }),
      setRankWin: (rankWin) => set({ rankWin }),
      setSonarVenue: (sonarVenue) => set({ sonarVenue }),
      setSonarWin: (sonarWin) => set({ sonarWin }),
      setChartTf: (chartTf) => set({ chartTf }),
    }),
    {
      name: "wt-miniapp-v7",
      // Стек экранов не сохраняем: запуск всегда начинается с вкладки.
      partialize: (s) => ({
        lang: s.lang,
        langPinned: s.langPinned,
        tab: s.tab,
        bigView: s.bigView,
        bigWin: s.bigWin,
        flowWin: s.flowWin,
        rankVenue: s.rankVenue,
        rankKind: s.rankKind,
        rankWin: s.rankWin,
        sonarVenue: s.sonarVenue,
        sonarWin: s.sonarWin,
        chartTf: s.chartTf,
      }),
    },
  ),
);

/** Лимит кошельков по плану — те же числа, что в premium.cpp бота. */
export function walletLimit(plan: string): number {
  return plan === "premium" ? 50 : 1;
}

/** На бесплатном плане алерты идут только с основного кошелька. */
export function isPaused(plan: string, primary: boolean): boolean {
  return plan !== "premium" && !primary;
}
