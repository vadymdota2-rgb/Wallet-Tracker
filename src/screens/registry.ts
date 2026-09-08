/** Имя экрана → компонент. Стек в store/app.ts хранит только имена. */
import type { ComponentType } from "react";
import type { ScreenName } from "../store/app";
import type { ScreenProps } from "./Screen";
import { WalletScreen } from "./WalletScreen";
import { PositionScreen } from "./PositionScreen";
import { PositionsScreen } from "./PositionsScreen";
import { SpotScreen } from "./SpotScreen";
import { CoinScreen } from "./CoinScreen";
import { TraderScreen } from "./TraderScreen";
import { SignalScreen } from "./SignalScreen";
import { AddWalletScreen } from "./AddWalletScreen";
import { RenameScreen } from "./RenameScreen";
import { ThresholdScreen } from "./ThresholdScreen";
import { LangScreen } from "./LangScreen";
import { PremiumScreen } from "./PremiumScreen";
import { HelpScreen } from "./HelpScreen";
import { HistoryScreen } from "./HistoryScreen";
import { ModelScreen } from "./ModelScreen";

export const SCREENS: Record<ScreenName, ComponentType<ScreenProps>> = {
  wallet: WalletScreen,
  position: PositionScreen,
  positions: PositionsScreen,
  spot: SpotScreen,
  coin: CoinScreen,
  trader: TraderScreen,
  signal: SignalScreen,
  addWallet: AddWalletScreen,
  rename: RenameScreen,
  threshold: ThresholdScreen,
  lang: LangScreen,
  premium: PremiumScreen,
  help: HelpScreen,
  history: HistoryScreen,
  model: ModelScreen,
};
