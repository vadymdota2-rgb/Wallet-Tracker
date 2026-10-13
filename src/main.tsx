import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { sweepStorage } from "./lib/storage";
import "./styles/index.css";

const host = document.getElementById("root");
if (host) createRoot(host).render(<StrictMode><App /></StrictMode>);
// Уборка хранилища — после первой отрисовки, чтобы не задерживать запуск.
setTimeout(sweepStorage, 4000);
