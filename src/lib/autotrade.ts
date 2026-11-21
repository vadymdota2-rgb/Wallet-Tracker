/**
 * Автоторговля — проверка ответа сервера (/api/owner/autotrade) до показа.
 *
 * Без React и сети. Ответ, где хоть одно поле, которое рисует вкладка, не
 * того типа (строка вместо числа, NaN, бесконечность, не массив), —
 * отвергается целиком: вкладка скажет «нет связи», а не упадёт и не
 * покажет мусор как цифры. Договор с сервером — тот же образец
 * (tests/fixtures/autotrade_*.json) и тест, который гоняет эту проверку
 * через Node на ответах сервера (tests/test_autotrade_contract.py).
 */
import type { AutotradeReply } from "./types";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown): v is boolean => typeof v === "boolean";
/** Необязательное поле: нет, null или нужного типа. */
const opt = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || v === null || ok(v);
const arr = (v: unknown, ok: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(ok);
const nums = (o: Obj, keys: readonly string[]): boolean => keys.every((k) => num(o[k]));
const pair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
const side = (v: unknown): boolean => v === 1 || v === -1;

const STATS = ["trades", "win_pct", "avg_win", "avg_loss", "net", "max_dd", "worst_streak", "worst_streak_usd"] as const;
const STATS_OPT = ["open", "unrealized", "max_mae", "longest_h", "max_open_at_once", "max_overlap_mae"] as const;

function stats(v: unknown): boolean {
  return isObj(v) && nums(v, STATS) && (v["pf"] === null || num(v["pf"])) && STATS_OPT.every((k) => opt(v[k], num));
}

const group = (v: unknown): boolean => isObj(v) && str(v["key"]) && stats(v);

function params(v: unknown): boolean {
  return isObj(v) && nums(v, ["delay", "min_notional", "cooldown", "wallets", "chase", "tp", "sl", "hold"])
    && bool(v["pnl30"]) && bool(v["whale"]) && opt(v["min_whale"], num) && opt(v["rest"], num) && opt(v["no_conflict"], bool);
}

const trade = (v: unknown): boolean =>
  isObj(v) && str(v["coin"]) && side(v["side"]) && str(v["whale"]) && nums(v, ["entry", "exit", "pct", "usd"])
  && str(v["why"]) && bool(v["holdout"]) && opt(v["px_in"], num) && opt(v["px_out"], num);

const active = (v: unknown): boolean =>
  isObj(v) && str(v["coin"]) && side(v["side"])
  && nums(v, ["whales", "entry", "px_in", "px_now", "tp", "at", "usd", "pct", "mae", "held_h"])
  && (v["to_tp_pct"] === null || num(v["to_tp_pct"]));

const okx = (v: unknown): boolean =>
  isObj(v) && ["ok", "mismatch", "missing", "unverified"].includes(v["status"] as string)
  && opt(v["inst"], str) && opt(v["scale"], num) && opt(v["ratio"], num);

function summary(v: unknown): boolean {
  if (!isObj(v)) return false;
  const c = v["criteria"], p = v["period"], s = v["sizing"], d = v["data"];
  return num(v["generated_at"]) && bool(v["verdict"])
    && isObj(c) && nums(c, ["net_gt", "pf_ge", "trades_ge", "max_dd_le"])
    && isObj(p) && nums(p, ["from", "to", "cut"])
    && isObj(s) && nums(s, ["deposit", "margin_pct", "leverage", "max_open", "notional", "cluster_hours", "liq_move_pct"])
    && bool(s["cross"]) && (s["markets"] === "all" || s["markets"] === "stocks") && opt(s["min_whale"], num)
    && isObj(d) && num(d["signals"]) && isObj(d["candles"]) && Object.values(d["candles"]).every(num)
    && arr(v["top"], (t) => isObj(t) && params(t["params"]) && stats(t["train"]) && stats(t["holdout"]) && bool(t["passes"]))
    && (v["full"] === null || stats(v["full"])) && opt(v["fade"], stats)
    && arr(v["equity"], pair)
    && ["by_coin", "by_whale", "by_session", "by_exit"].every((k) => arr(v[k], group))
    && arr(v["trades"], trade)
    && opt(v["active"], (a) => arr(a, active)) && opt(v["per_day"], num) && opt(v["entries_per_day"], num)
    && opt(v["okx"], (o) => isObj(o) && (o["venue"] === "hl" || o["venue"] === "okx") && isObj(o["map"])
      && Object.values(o["map"]).every(okx))
    && opt(v["by_chase"], (a) => arr(a, (x) => isObj(x) && num(x["chase"]) && stats(x["train"]) && stats(x["holdout"])))
    && opt(v["pace"], (a) => arr(a, (x) => isObj(x)
      && nums(x, ["max_open", "trades", "per_day", "median_tp_h", "open", "net", "max_dd", "bust"])));
}

const liveOpen = (v: unknown): boolean =>
  isObj(v) && str(v["coin"]) && str(v["inst"]) && side(v["side"])
  && nums(v, ["opened", "px", "size", "notional", "tp"]) && opt(v["whales"], num) && opt(v["mark"], num) && opt(v["upl"], num) && opt(v["margin_pct"], num);

const liveTrade = (v: unknown): boolean =>
  isObj(v) && str(v["coin"]) && str(v["inst"]) && side(v["side"])
  && nums(v, ["opened", "closed", "px_in", "px_out", "pnl"]) && opt(v["fee"], num) && opt(v["funding"], num) && str(v["why"]);

function live(v: unknown): boolean {
  if (!isObj(v)) return false;
  const s = v["stats"], skip = v["last_skip"], blocked = v["blocked"];
  return bool(v["alive"]) && num(v["heartbeat"]) && bool(v["simulated"]) && str(v["error"])
    && (v["equity"] === null || num(v["equity"]))
    && (v["open"] === null || liveOpen(v["open"]))
    && arr(v["positions"], (p) => isObj(p) && str(p["instId"]) && str(p["pos"]) && opt(p["upl"], str) && opt(p["avgPx"], str))
    && opt(skip, (k) => isObj(k) && str(k["coin"]) && side(k["side"]) && str(k["why"]) && num(k["at"]))
    && opt(blocked, (b) => isObj(b) && Object.values(b).every((x) => isObj(x) && num(x["at"]) && str(x["why"])))
    && arr(v["events"], str)
    && isObj(s) && nums(s, ["trades", "wins", "win_pct", "net", "avg_win", "avg_loss", "max_dd", "per_day", "fees", "funding"])
    && (s["pf"] === null || num(s["pf"]))
    && arr(v["equity_curve"], pair) && arr(v["trades"], liveTrade);
}

/** Ответ годен для вкладки (ok: true) — каждое поле, которое она рисует, нужного типа. */
export function validAutotrade(v: unknown): v is AutotradeReply {
  return isObj(v) && v["ok"] === true && ["backtest", "paper", "live"].includes(v["stage"] as string)
    && bool(v["on"]) && bool(v["running"]) && nums(v, ["started", "finished", "next"]) && str(v["error"])
    && (v["backtest"] === null || summary(v["backtest"]))
    && (v["live"] === null || live(v["live"]));
}

/** Ответ кнопки: годный — как есть; отказ с причиной (ok: false, error) —
 *  как есть, чтобы вкладка назвала причину; всё остальное — null («нет связи»).
 *  Испорчен только итог бэктеста (например, от старой версии) — без него:
 *  реальная торговля и кнопки важнее отчёта. */
export function checkAutotrade<T extends { ok?: unknown }>(r: T | null): T | null {
  if (r === null) return null;
  const o: unknown = r;
  if (isObj(o) && o["ok"] === false && str(o["error"])) return r;
  if (validAutotrade(r)) return r;
  if (isObj(o) && o["backtest"] !== null) {
    const rest = { ...o, backtest: null };
    if (validAutotrade(rest)) return rest as unknown as T;
  }
  return null;
}

/** Короткое имя контракта: «BTC-USDT-SWAP», «BTC-USD_UM_XPERP-310404» → «BTC». */
export const shortInst = (inst: string): string => inst.replace(/-USDT-SWAP$|-USD[CT]?_UM_XPERP-\d+$/, "");
