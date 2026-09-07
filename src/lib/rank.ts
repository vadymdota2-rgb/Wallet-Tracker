/**
 * Место кошелька в рейтинге.
 *
 * Сервер поля `spot` и `perp` у кошелька всегда заполняет прочерком —
 * wallet_stats их не считает. Но сами рейтинги приходят списками адресов,
 * так что место ищется в них. Это настоящее «N-й в топе за 30 дней»,
 * а не выдуманная цифра.
 *
 * Досок четыре: прибыль, доходность, винрейт и активность. Искать только
 * в первой мало — по споту она покрывает 100 адресов, а все четыре вместе
 * 152. Берём лучшее место среди досок и помним, какая его дала.
 */
import type { Rank, RankKind, RankTable, Trader, Venue, Wallet } from "./types";

const BOARDS: RankKind[] = ["pnl", "roi", "win", "act"];

export interface VenuePlace {
  place: number;
  kind: RankKind;
  /** Сама строка доски: прибыль, доходность, винрейт, сделки за окно. */
  row: Trader;
}

/** Лучшее место адреса среди четырёх досок площадки. */
function bestIn(table: RankTable | undefined, addr: string): VenuePlace | null {
  if (!table || !addr) return null;
  const key = addr.toLowerCase();
  let best: VenuePlace | null = null;
  for (const kind of BOARDS) {
    const rows = table[kind];
    if (!rows?.length) continue;
    const i = rows.findIndex((r) => (r.a || "").toLowerCase() === key);
    if (i < 0) continue;
    const row = rows[i];
    if (row && (!best || i + 1 < best.place)) best = { place: i + 1, kind, row };
  }
  return best;
}

export interface Place {
  spot: VenuePlace | null;
  perp: VenuePlace | null;
  /** Лучшее из двух — им подписывают строку списка. */
  best: (VenuePlace & { venue: Venue }) | null;
}

export function walletRank(rank: Rank, addr: string): Place {
  const spot = bestIn(rank.spot, addr);
  const perp = bestIn(rank.perp, addr);
  let best: (VenuePlace & { venue: Venue }) | null = null;
  // Меньше — выше. При равенстве приоритет у спота.
  if (spot && (!perp || spot.place <= perp.place)) best = { ...spot, venue: "spot" };
  else if (perp) best = { ...perp, venue: "perp" };
  return { spot, perp, best };
}

/** Ключ словаря для названия доски — чтобы было видно, за что место. */
export function boardKey(kind: RankKind): "rk_btn_top_pnl" | "rk_btn_top_roi" | "rk_btn_top_winrate" | "rk_btn_most_active" {
  if (kind === "roi") return "rk_btn_top_roi";
  if (kind === "win") return "rk_btn_top_winrate";
  if (kind === "act") return "rk_btn_most_active";
  return "rk_btn_top_pnl";
}

/** Название площадки для подписи к месту. Бренды не переводятся. */
export function venueName(venue: Venue): string {
  return venue === "spot" ? "BSC" : "Hyperliquid";
}

/**
 * Площадка кошелька по его собственной работе, а не по рейтингу.
 *
 * В топ-100 попадает меньшинство, и у остальных площадку было видно
 * неоткуда. Но она выводится из данных: позиции и счёт на Hyperliquid,
 * сделки и спотовый остаток на BSC. Работает на обеих — берём ту, где
 * денег больше.
 */
export function walletVenue(w: Wallet): Venue | null {
  // Открытая позиция бывает только на Hyperliquid. Это факт, а не перевес
  // по деньгам, поэтому он решает до всякого сравнения остатков: иначе
  // кошелёк с глазиком подписывался BSC, где позиций не бывает вовсе.
  if (w.pos.length > 0) return "perp";
  const perp = (w.equity?.perp ?? 0) > 0;
  const spot = w.trades > 0 || (w.equity?.spot ?? 0) > 0;
  if (perp && spot) return (w.equity?.perp ?? 0) >= (w.equity?.spot ?? 0) ? "perp" : "spot";
  if (perp) return "perp";
  if (spot) return "spot";
  return null;
}

/**
 * Площадка для строки списка. Порядок по силе признака: открытая позиция —
 * факт, место в топе площадки — почти факт, остатки и сделки — догадка.
 */
export function rowVenue(w: Wallet, place: Place): Venue | null {
  if (w.pos.length > 0) return "perp";
  return place.best?.venue ?? walletVenue(w);
}

/**
 * Место на той площадке, значок которой стоит рядом. Место с чужой доски
 * рядом с логотипом Hyperliquid — это два разных факта, слепленных в один,
 * поэтому если на своей доске кошелька нет, кубок не рисуем вовсе.
 */
export function placeAt(place: Place, venue: Venue): VenuePlace | null {
  return venue === "spot" ? place.spot : place.perp;
}
