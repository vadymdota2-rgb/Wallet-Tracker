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
import { CG_LOGOS } from "./coin-logos";

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

export function CoinIcon({
  sym,
  size = 32,
  icon,
}: {
  sym: string;
  size?: number;
  /** Готовый список от сервера: локальный файл, PancakeSwap, Trust Wallet.
   *  Нужен там, где монеты нет в общей выдаче — например у покупок на BSC:
   *  без адреса токена искать было негде, и оставалась буква в кружке. */
  icon?: string[];
}) {
  const [step, setStep] = useState(0);
  const coins = useLive((s) => s.coins);

  const key = normalizeSym(sym);
  const coin = coins[sym] ?? coins[key];
  const alias = HL_ALIAS[key] ?? key;

  const urls: string[] = [];
  if (icon?.length) urls.push(...icon.filter(Boolean));
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
    /* Акции и металлы приходят как «xyz:AAPL» — с именем рынка HIP-3 впереди
       и строчными буквами. Hyperliquid раздаёт их значки по точному имени, а
       выше оно приведено к верхнему регистру, и «XYZ:AAPL.svg» отдавал не
       картинку, а страницу приложения — с кодом 200, так что даже на ошибку
       это не походило: перебор шёл дальше и заканчивался буквой.
       Поэтому пробуем имя как есть, а следом — тикер без приставки. */
    const raw = String(sym || "").trim();
    if (raw && raw !== alias) urls.push(`/hllogo/${raw}.svg`);
    const bare = raw.slice(raw.lastIndexOf(":") + 1);
    if (bare && bare !== raw) urls.push(`/coins/hl/${bare.toUpperCase()}.svg`);
  }
  /* Выверенный вручную адрес идёт первым, собранный по капитализации —
     следом: у выверенного известно, какой именно выпуск монеты имеется в
     виду, у собранного это просто самый крупный тикер. */
  const cg = CG_FALLBACK[key] ?? CG_LOGOS[key];
  if (cg) urls.push(cg);
  /* Монеты вроде 1000PEPE и kBONK на разных биржах зовутся по-разному, а
     логотип у них один. Множитель уже снят сервером, но строки из старых
     ответов и с других досок приходят как есть. */
  const bare = key.replace(/^(1000000|100000|10000|1000|1M|1K)/, "");
  if (bare !== key) {
    const alt = CG_FALLBACK[bare] ?? CG_LOGOS[bare];
    if (alt) urls.push(alt);
  }

  // Сменили монету — перебор начинается заново.
  useEffect(() => setStep(0), [key, icon?.[0]]);

  const src = urls[step];
  /* Буква берётся из исходного тикера, а не из нормализованного: тот
     оставляет только латиницу и цифры, поэтому у китайских и японских имён
     вроде «幻想» не оставалось ничего и в кружке стоял вопросительный знак.
     Первый знак имени — всегда лучше, чем «?». */
  const plain = String(sym || "").trim();
  const letter =
    [...plain.slice(plain.lastIndexOf(":") + 1)][0] || [...plain][0] || key.slice(0, 1) || "?";

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
