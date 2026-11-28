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

const STATS = ["trades", "win_pct", "avg_win", "avg_loss", "net", "max_dd", "worst_streak", "worst_streak_usd",
  "open", "unrealized", "max_mae", "longest_h"] as const;

const stats = (v: unknown): boolean => isObj(v) && nums(v, STATS) && (v["pf"] === null || num(v["pf"])) && opt(v["fees"], num);

const group = (v: unknown): boolean => isObj(v) && str(v["key"]) && stats(v);

const trade = (v: unknown): boolean =>
  isObj(v) && str(v["coin"]) && side(v["side"])
  && nums(v, ["entry", "exit", "px_in", "px_out", "tp", "usd", "pct", "mae", "held_h"])
  && str(v["why"]);

/** Итог бэктеста-повтора (WhaleScanner/tools/autotrade_replay.py). Итог прежней
 *  сетки (на сервере мог остаться в latest/) сюда не проходит — вкладка покажет
 *  «итога ещё нет» до первого повтора. */
function summary(v: unknown): boolean {
  if (!isObj(v)) return false;
  const c = v["criteria"], p = v["period"], s = v["sizing"], d = v["data"], k = v["skips"];
  return num(v["generated_at"]) && bool(v["verdict"])
    && isObj(c) && nums(c, ["pf_ge", "trades_ge", "max_dd_le"])
    && isObj(p) && nums(p, ["from", "to"])
    && isObj(s) && nums(s, ["deposit", "deposit_end", "margin_pct", "leverage", "fee_taker_pct", "fee_maker_pct", "slippage_pct"])
    && isObj(d) && nums(d, ["signals", "requests", "errors"])
    && ["full", "first", "last"].every((x) => stats(v[x]))
    && arr(v["equity"], pair)
    && ["by_coin", "by_session", "by_exit"].every((x) => arr(v[x], group))
    && isObj(k) && Object.values(k).every(num) && num(v["per_day"])
    && arr(v["trades"], trade)
    && arr(v["active"], (a) => trade(a) && isObj(a) && (a["to_tp_pct"] === null || num(a["to_tp_pct"])))
    && opt(v["halves"], pair);
}

const liveOpen = (v: unknown): boolean =>
  isObj(v) && str(v["coin"]) && str(v["inst"]) && side(v["side"])
  && nums(v, ["opened", "px", "notional", "tp"]) && opt(v["whales"], num) && opt(v["mark"], num) && opt(v["upl"], num) && opt(v["margin_pct"], num)
  && opt(v["exit_why"], str) && opt(v["usd"], num) && opt(v["usd_against"], num) && opt(v["stop"], num) && opt(v["priority"], str)
  && opt(v["fade"], bool);

const liveTrade = (v: unknown): boolean =>
  isObj(v) && str(v["coin"]) && str(v["inst"]) && side(v["side"])
  && nums(v, ["opened", "closed", "px_in", "px_out", "pnl"]) && str(v["why"]);

function live(v: unknown): boolean {
  if (!isObj(v)) return false;
  const s = v["stats"], skip = v["last_skip"], blocked = v["blocked"];
  return bool(v["alive"]) && num(v["heartbeat"]) && bool(v["simulated"]) && str(v["error"])
    && (v["equity"] === null || num(v["equity"]))
    && (v["open"] === null || liveOpen(v["open"])) && opt(v["opens"], (x) => arr(x, liveOpen))
    && arr(v["positions"], (p) => isObj(p) && str(p["instId"]) && opt(p["upl"], str))
    && opt(skip, (k) => isObj(k) && str(k["coin"]) && side(k["side"]) && str(k["why"]) && num(k["at"]))
    && opt(blocked, (b) => arr(b, str))
    && opt(v["key_problem"], str) && opt(v["skips_24h"], (k) => isObj(k) && Object.values(k).every(num))
    && opt(v["pending"], (k) => isObj(k) && str(k["inst"]) && side(k["side"]) && nums(k, ["px", "until"]))
    && arr(v["events"], str)
    && isObj(s) && nums(s, ["trades", "win_pct", "net", "avg_win", "avg_loss", "max_dd", "per_day", "fees", "funding"])
    && (s["pf"] === null || num(s["pf"]))
    && arr(v["equity_curve"], pair) && arr(v["trades"], liveTrade);
}

/** Ответ годен для вкладки (ok: true) — каждое поле, которое она рисует, нужного типа. */
export function validAutotrade(v: unknown): v is AutotradeReply {
  return isObj(v) && v["ok"] === true
    && bool(v["on"]) && bool(v["running"]) && nums(v, ["started", "next"]) && str(v["error"])
    && opt(v["progress"], str)
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

/** Причины пропуска сигналов (коды службы whale-autotrade) — по-русски. */
export const SKIP_LABELS: Record<string, string> = {
  own_open: "у бота уже 3 позиции",
  own_same: "на бумаге уже позиция бота",
  limit_miss: "цена ушла хуже цены китов — вход не исполнился",
  entering: "прошлый ордер входа ещё не проверен",
  unverified: "позиции на счёте не проверены",
  own_unknown: "своя позиция без записи",
  coin_pause: "в бумагу входили < 3 ч назад",
  blocked: "OKX не даёт торговать бумагой",
  market: "ключу OKX закрыт рынок",
  manual_same: "на бумаге ваша позиция",
  no_inst: "бумаги нет на OKX",
  no_price: "нет цены OKX",
  other_asset: "другой актив на OKX",
  chase: "цена ушла от китов",
  no_equity: "капитал 0",
  bad_params: "неверные параметры бумаги",
  tick: "шаг цены слишком крупный",
  min_size: "меньше минимального ордера",
  rejected: "ордер отклонён",
  unconfirmed: "исполнение не подтверждено",
  canceled: "ордер отменён биржей",
  whale_exit: "кит уже вышел в убыток",
  bigger_against: "против — киты крупнее",
  stale: "китов уже меньше 2 (сигнал устарел)",
  level: "цена не у своего уровня (4ч × 24; правило убрано)",
  ma30: "цена не по ту сторону MA30 (15м)",
  candles: "свечи OKX не получены (сбой) — повтор",
  entered: "вошли",
};

/** Пропуски за сутки строкой: «ключу OKX закрыт рынок — 7 · цена ушла от китов — 2». */
export const skipsLine = (k: Record<string, number>): string =>
  Object.entries(k).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${SKIP_LABELS[c] ?? c} — ${n}`).join(" · ");
