/**
 * Место кошелька в рейтинге.
 *
 * Сервер поля `spot` и `perp` у кошелька всегда заполняет прочерком —
 * wallet_stats их не считает. Но сами рейтинги приходят списками адресов,
 * так что место ищется в них. Это настоящее «N-й по прибыли за 30 дней»,
 * а не выдуманная цифра.
 */
import type { Rank, RankTable } from "./types";

/** Позиция адреса в таблице (1-based) либо null, если его там нет. */
function placeIn(table: RankTable | undefined, addr: string): number | null {
  const rows = table?.pnl;
  if (!rows?.length || !addr) return null;
  const key = addr.toLowerCase();
  const i = rows.findIndex((r) => (r.a || "").toLowerCase() === key);
  return i < 0 ? null : i + 1;
}

export interface Place {
  spot: number | null;
  perp: number | null;
  /** Лучшее из двух — им подписывают строку списка. */
  best: number | null;
}

export function walletRank(rank: Rank, addr: string): Place {
  const spot = placeIn(rank.spot, addr);
  const perp = placeIn(rank.perp, addr);
  const found = [spot, perp].filter((v): v is number => v !== null);
  return { spot, perp, best: found.length ? Math.min(...found) : null };
}
