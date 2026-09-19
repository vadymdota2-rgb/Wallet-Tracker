/**
 * Состояние оболочки: язык, вкладка, стек экранов, выбранные фильтры.
 * Сохраняется в localStorage. Данные с сервера здесь не живут — они в
 * store/live.ts и заново приходят при каждом запуске.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LangCode } from "../i18n/types";
import type { CoinClass, FlowSide, RankKind, Venue } from "../lib/types";
import type { Timeframe } from "../lib/klines";

export type Tab = "wallets" | "top" | "analytics" | "cortex" | "more";

export type ScreenName =
  | "wallet" | "position" | "coin" | "signal" | "deals"
  | "addWallet" | "threshold" | "lang" | "premium" | "help"
  | "positions" | "history" | "model" | "rename" | "spot"
  | "legal";

export interface Screen {
  name: ScreenName;
  /** Что открыли: адрес кошелька, тикер, индекс сигнала. */
  arg?: string;
  /** Второй ключ — например индекс позиции внутри кошелька. */
  arg2?: string;
}

/** Окна крупных сделок — те же, что в боте. */
export type BigWin = "1h" | "6h" | "24h" | "7d" | "30d";
/** Сторона доски крупных ордеров. */
export type BigSide = "buy" | "sell";
/** Разделы аналитики — те же кнопки, что в меню бота. */
export type BigView = "flow" | "spot" | "perp" | "fund" | "rot" | "ls";
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
  bigSide: BigSide;
  lsCls: CoinClass;
  flowWin: FlowWin;
  flowSide: FlowSide;
  flowQuery: string;

  rankVenue: Venue;
  rankKind: RankKind;
  rankWin: RankWin;

  cortexVenue: Venue;
  chartTf: Timeframe;
  /** Свои деньги в калькуляторе фандинга. Ноль — поле пустое, счёта нет. */
  fundAmount: number;
  /** Плечо: фандинг берут с объёма позиции, а он во столько раз больше. */
  fundLev: number;

  setLang(lang: LangCode, pinned?: boolean): void;
  goTab(tab: Tab): void;
  open(name: ScreenName, arg?: string, arg2?: string): void;
  back(): void;
  reset(): void;

  setBigView(v: BigView): void;
  setBigWin(w: BigWin): void;
  setFlowWin(w: FlowWin): void;
  setBigSide(s: BigSide): void;
  setLsCls(c: CoinClass): void;
  setFlowSide(s: FlowSide): void;
  setFlowQuery(q: string): void;
  setRankVenue(v: Venue): void;
  setRankKind(k: RankKind): void;
  setRankWin(w: RankWin): void;
  setCortexVenue(v: Venue): void;
  setChartTf(tf: Timeframe): void;
  setFundAmount(v: number): void;
  setFundLev(v: number): void;
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
      bigSide: "buy",
      lsCls: "crypto",
      flowWin: "24",
      flowSide: "all",
      flowQuery: "",

      rankVenue: "spot",
      rankKind: "pnl",
      rankWin: "30",

      cortexVenue: "spot",
      chartTf: "1d",
      fundAmount: 0,
      fundLev: 1,

      setLang: (lang, pinned = true) => set({ lang, langPinned: pinned || get().langPinned }),
      goTab: (tab) => set({ tab, stack: [] }),
      open: (name, arg, arg2) => set({ stack: [...get().stack, { name, arg, arg2 }] }),
      back: () => set({ stack: get().stack.slice(0, -1) }),
      reset: () => set({ stack: [] }),

      setBigView: (bigView) => set({ bigView }),
      setBigWin: (bigWin) => set({ bigWin }),
      setFlowWin: (flowWin) => set({ flowWin }),
      setBigSide: (bigSide) => set({ bigSide }),
      setLsCls: (lsCls) => set({ lsCls }),
      setFlowSide: (flowSide) => set({ flowSide }),
      setFlowQuery: (flowQuery) => set({ flowQuery }),
      setRankVenue: (rankVenue) => set({ rankVenue }),
      setRankKind: (rankKind) => set({ rankKind }),
      setRankWin: (rankWin) => set({ rankWin }),
      setCortexVenue: (cortexVenue) => set({ cortexVenue }),
      setChartTf: (chartTf) => set({ chartTf }),
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
      /* Вторая версия — переименование Sonar в Cortex: поля звались
         sonarVenue и sonarWin, вкладка — "sonar", и без переноса человек
         открыл бы приложение на чужой вкладке. Третья убрала окно потока:
         модель работает только на суточном.

         Четвёртой версии больше нет: в ней вкладки делились на лонг и шорт,
         а спот с перпами лежали вместе, и от этого отказались. Но у тех, кто
         успел её открыть, в памяти осталось поле стороны и не осталось поля
         площадки — без пятой версии список у них оказался бы пустым: фильтр
         сравнивал бы площадку сигнала с «ничем». */
      version: 5,
      migrate: (prev, from) => {
        let s = prev as Record<string, unknown>;
        if (from < 1) s = { ...s, fundAmount: 0, fundLev: 1 };
        if (from < 2) {
          const { sonarVenue, sonarWin, ...rest } = s as {
            sonarVenue?: Venue; sonarWin?: number; [k: string]: unknown;
          };
          void sonarWin;   // окно снято третьей версией, переносить нечего
          s = { ...rest };
          if (sonarVenue !== undefined) s.cortexVenue = sonarVenue;
          if (s.tab === "sonar") s.tab = "cortex";
        }
        if (from < 3) {
          // Окна 1ч/6ч сняты: модель их никогда не видела, и сохранённый
          // выбор больше ни на что не влияет.
          const { cortexWin, ...rest } = s as { cortexWin?: number; [k: string]: unknown };
          void cortexWin;
          s = rest;
        }
        if (from < 5) {
          /* Возврат к делению по площадке: у побывавших на четвёртой версии
             лежит сторона и нет площадки, а без неё список пуст. */
          const { cortexSide, ...rest } = s as { cortexSide?: string; [k: string]: unknown };
          void cortexSide;
          s = rest;
          if (s.cortexVenue !== "spot" && s.cortexVenue !== "perp") s.cortexVenue = "spot";
        }
        return s;
      },
      // Стек экранов не сохраняем: запуск всегда начинается с вкладки.
      partialize: (s) => ({
        lang: s.lang,
        langPinned: s.langPinned,
        tab: s.tab,
        bigView: s.bigView,
        bigWin: s.bigWin,
        bigSide: s.bigSide,
        lsCls: s.lsCls,
        flowWin: s.flowWin,
        flowSide: s.flowSide,
        rankVenue: s.rankVenue,
        rankKind: s.rankKind,
        rankWin: s.rankWin,
        cortexVenue: s.cortexVenue,
        chartTf: s.chartTf,
        fundAmount: s.fundAmount,
        fundLev: s.fundLev,
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
