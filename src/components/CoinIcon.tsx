/**
 * Логотип монеты.
 *
 * Источник определяет площадка, а не тикер: у спотовых токенов BSC есть
 * адрес контракта, у перпов Hyperliquid его нет. Поиск по тикеру не годится —
 * тикеры не уникальны, и под `PUMP` с `HYPE` лежат чужие проекты; картинка
 * грузится успешно, ошибки нет, и до правильной очередь не доходит.
 *
 * Список кандидатов приходит с сервера полем `icon`: он считает контрольную
 * сумму адреса (EIP-55) и знает, какие файлы лежат в образе. Здесь остаётся
 * перебор по ошибке загрузки и буква под картинкой, пока та не пришла.
 */
import { useEffect, useState } from "react";
import { useLive } from "../store/live";
import { CG_FALLBACK } from "./coin-fallback";

/** Имена монет Hyperliquid, отличные от тикера. */
const HL_ALIAS: Record<string, string> = {
  PEPE: "kPEPE",
  FLOKI: "kFLOKI",
  SHIB: "kSHIB",
  BONK: "kBONK",
  NVDA: "xyz:NVDA",
  INTC: "xyz:INTC",
  GOOGL: "xyz:GOOGL",
  GOOG: "xyz:GOOGL",
};

/** Тикер в верхнем регистре без разделителей; `kPEPE` сводится к `PEPE`. */
export function normalizeSym(sym: string): string {
  const up = String(sym || "").toUpperCase().replace(/[^A-Z0-9:]/g, "");
  return up.startsWith("K") && ["PEPE", "FLOKI", "SHIB", "BONK", "DOGS", "NEIRO"].includes(up.slice(1))
    ? up.slice(1)
    : up;
}

export function CoinIcon({ sym, size = 32 }: { sym: string; size?: number }) {
  const [step, setStep] = useState(0);
  const coins = useLive((s) => s.coins);

  const key = normalizeSym(sym);
  const coin = coins[sym] ?? coins[key];
  const alias = HL_ALIAS[key] ?? key;

  const urls: string[] = [];
  const fromServer = coin?.icon;
  if (Array.isArray(fromServer)) urls.push(...fromServer.filter(Boolean));
  else if (typeof fromServer === "string" && fromServer.startsWith("/")) urls.push(fromServer);

  // Запасной путь на случай старого ответа API. Проверки «только если нет
  // адреса» здесь нет намеренно: у ZEC адрес есть — существует одноимённый
  // токен на BSC, — и такая проверка оставляла монету вовсе без иконки.
  if (key) {
    const safe = alias.replace(/:/g, "_");
    urls.push(`/coins/hl/${safe}.svg`, `/hllogo/${alias}.svg`);
    if (alias !== key) urls.push(`/hllogo/${key}.svg`);
  }
  const cg = CG_FALLBACK[key];
  if (cg) urls.push(cg);

  // Сменили монету — перебор начинается заново.
  useEffect(() => setStep(0), [key]);

  const src = urls[step];
  const letter = key.slice(0, 1) || "?";

  return (
    <span className="ci" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      <b>{letter}</b>
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setStep((n) => n + 1)}
        />
      ) : null}
    </span>
  );
}
