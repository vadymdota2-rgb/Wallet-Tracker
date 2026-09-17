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

/* Товарные рынки, чей код совпадает с биржевым: NG на Gate и OKX — это
   природный газ, а не золотодобытчик NovaGold, которого отдаёт биржевой
   справочник. Своего рисунка для газа нет ни у кого из наших источников,
   поэтому здесь остаётся буква — она честнее чужого логотипа. */
const NOT_STOCK = new Set(["NG"]);

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
  /* Инструменты HIP-3 приходят с именем рынка впереди: «xyz:NVDA»,
     «para:TTWO», «mkts:GOLD». Hyperliquid раздаёт их значки по точному
     имени, а приставка у него строчная: «XYZ:SMSN.svg» отдаёт не картинку, а
     страницу приложения — с кодом 200, так что на ошибку это даже не похоже,
     перебор шёл дальше и заканчивался буквой. Поэтому приставку приводим к
     строчным, а тикер оставляем заглавным. */
  const raw = String(sym || "").trim();
  const cut = raw.indexOf(":");
  const dex = cut > 0 ? raw.slice(0, cut).toLowerCase() : "";
  const tick = normalizeSym(cut >= 0 ? raw.slice(cut + 1) : raw);

  if (key) {
    if (dex && tick) {
      urls.push(`/hllogo/${dex}:${tick}.svg`);
      /* Один и тот же рынок бывает у нескольких площадок HIP-3, а рисунок
         выложен не у всех: у «mkts:NVDA» своего значка нет, у «xyz:NVDA» —
         есть. Самая крупная площадка и служит общим запасным путём. */
      if (dex !== "xyz") urls.push(`/hllogo/xyz:${tick}.svg`);
      urls.push(`/coins/hl/${tick}.svg`, `/hllogo/${tick}.svg`);
    } else {
      urls.push(`/coins/hl/${alias.replace(/:/g, "_")}.svg`, `/hllogo/${alias}.svg`);
      if (alias !== key) urls.push(`/hllogo/${key}.svg`);
      if (raw && raw !== alias) urls.push(`/hllogo/${raw}.svg`);
    }
  }
  /* Выверенный вручную адрес идёт первым, собранный по капитализации —
     следом: у выверенного известно, какой именно выпуск монеты имеется в
     виду, у собранного это просто самый крупный тикер.
     Монеты вроде 1000PEPE и kBONK на разных биржах зовутся по-разному, а
     логотип у них один: множитель уже снят сервером, но строки из старых
     ответов и с других досок приходят как есть. */
  const byCg = (k: string) => CG_FALLBACK[k] ?? CG_LOGOS[k];
  for (const k of key === tick ? [key] : [key, tick]) {
    if (!k) continue;
    const u = byCg(k);
    if (u) urls.push(u);
    const plainKey = k.replace(/^(1000000|100000|10000|1000|1M|1K)/, "");
    if (plainKey !== k) {
      const alt = byCg(plainKey);
      if (alt) urls.push(alt);
    }
  }
  /* Акции. Их на биржах уже десятки: у Hyperliquid это рынки HIP-3
     («xyz:SHEIN»), у остальных — обычные тикеры (AMZN, TSLA, QQQ, MCD).
     Своего рисунка для них нет ни у кого из наших источников, поэтому
     последним звеном идёт биржевой логотип по тикеру.

     Он именно последний: до него доходят только строки, которым не нашлось
     ни файла в образе, ни рисунка площадки, ни монеты с таким тикером. Плата
     за это — редкая ошибка: у монеты с коротким именем, похожим на биржевой
     код, окажется логотип компании. Выбор здесь между редкой ошибкой и
     полусотней кружков с буквой, и второе хуже. */
  if (tick && /^[A-Z]{2,5}$/.test(tick) && !NOT_STOCK.has(tick)) {
    urls.push(`/stlogo/${tick}?format=png`);
    /* Токенизированные акции зовутся «AAPLx», «AMZNx»: биржевого кода с
       этим хвостом нет, а без него — есть. */
    if (tick.length >= 4 && tick.endsWith("X")) urls.push(`/stlogo/${tick.slice(0, -1)}?format=png`);
  }

  // Сменили монету — перебор начинается заново.
  useEffect(() => setStep(0), [key, icon?.[0]]);

  // Повторов в цепочке быть не должно: каждый лишний адрес — лишний запрос
  // впустую и лишний шаг до картинки, которая есть.
  const chain = urls.filter((u, i) => u && urls.indexOf(u) === i);
  const src = chain[step];
  /* Буква берётся из исходного тикера, а не из нормализованного: тот
     оставляет только латиницу и цифры, поэтому у китайских и японских имён
     вроде «幻想» не оставалось ничего и в кружке стоял вопросительный знак.
     Первый знак имени — всегда лучше, чем «?». */
  const letter =
    [...raw.slice(raw.lastIndexOf(":") + 1)][0] || [...raw][0] || key.slice(0, 1) || "?";

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
