/** Имя экрана → компонент. Стек в store/app.ts хранит только имена. */
import type { ComponentType } from "react";
import type { ScreenName } from "../store/app";
import type { ScreenProps } from "./Screen";
import { WalletScreen } from "./WalletScreen";
import { PositionScreen } from "./PositionScreen";
import { SpotScreen } from "./SpotScreen";
import { CoinScreen } from "./CoinScreen";
import { AddWalletScreen } from "./AddWalletScreen";
import { RenameScreen } from "./RenameScreen";
import { ThresholdScreen } from "./ThresholdScreen";
import { LangScreen } from "./LangScreen";
import { PremiumScreen } from "./PremiumScreen";
import { HelpScreen } from "./HelpScreen";
import { DealsScreen } from "./DealsScreen";
import { LegalScreen } from "./LegalScreen";
import { AlertsScreen } from "./AlertsScreen";
import { ChartScreen } from "./ChartScreen";
import { UnlocksScreen } from "./UnlocksScreen";
import { LiqMapScreen } from "./LiqMapScreen";

export const SCREENS: Record<ScreenName, ComponentType<ScreenProps>> = {
  wallet: WalletScreen,
  position: PositionScreen,
  spot: SpotScreen,
  coin: CoinScreen,
  addWallet: AddWalletScreen,
  rename: RenameScreen,
  threshold: ThresholdScreen,
  lang: LangScreen,
  premium: PremiumScreen,
  help: HelpScreen,
  deals: DealsScreen,
  legal: LegalScreen,
  alerts: AlertsScreen,
  chart: ChartScreen,
  unlocks: UnlocksScreen,
  liqmap: LiqMapScreen,
};
