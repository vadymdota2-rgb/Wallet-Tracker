import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { sweepStorage } from "./lib/storage";
import { polyfillFlags } from "./lib/flags";
import flagFont from "./assets/TwemojiCountryFlags.woff2?url";
import "./styles/index.css";

// Флаги стран на Windows — до первой отрисовки, чтобы не мигали буквами.
polyfillFlags(flagFont);

const host = document.getElementById("root");
if (host) createRoot(host).render(<StrictMode><App /></StrictMode>);
// Уборка хранилища — после первой отрисовки, чтобы не задерживать запуск.
setTimeout(sweepStorage, 4000);
