"""Алерты по биткоин-ETF — отдельный модуль API (/api/etfalert/*).

Человек выбирает на экране «Институциональные потоки», о чём ему писать:
  - итог дня по фондам из блокчейна — как только деньги торгового дня
    дошли до цепочки (те же цифры, что в карточке «По дням» на экране:
    фонды, чьи кошельки знает сканер; отчёты в SEC — раз в квартал, по дням
    их нет);
  - движения фондов в цепочке — сразу, как блок с переводом фонда лёг в
    цепочку и подтверждён следующим: приток в кошельки фонда и отток из них
    (свой сканер бота: BITB по кошелькам, которые фонд публикует сам, и
    фонды, найденные у хранителя и названные сверкой потоков);
  - по отдельному фонду — его итог дня и его движения в цепочке.

Подписка — строка (чат, фонд), «*» — все фонды. Что уже отправлено, помнит
etf_alert_sent (чат, ключ события): проход можно повторять сколько угодно,
второго письма не будет. Ушедшее с ошибкой пробуется ещё дважды.

Итог дня шлётся, когда строка дня перестала меняться (STABLE): фонды
отчитываются по одному, и первая версия дня бывает неполной. Человек,
подписавшийся после того, как день устоялся, этот день не получает — только
следующие.

Модуль ни от чего в whale_api не зависит: базы, ответ экрана ETF, отправка
и часы приходят параметрами (тесты подменяют их).
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Callable
from typing import Any

import wt_digest_img as dgi

SCHEMA = """
CREATE TABLE IF NOT EXISTS etf_alert_subs (
    chat_id TEXT NOT NULL,
    fund TEXT NOT NULL,
    day INTEGER NOT NULL DEFAULT 0,
    chain INTEGER NOT NULL DEFAULT 0,
    min_btc REAL NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'en',
    created INTEGER NOT NULL,
    PRIMARY KEY (chat_id, fund)
);
CREATE TABLE IF NOT EXISTS etf_alert_sent (
    chat_id TEXT NOT NULL,
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    tries INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, key)
);
CREATE TABLE IF NOT EXISTS etf_alert_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""
ALL = "*"
MAX_FUNDS = 40
MINS = (0.0, 1.0, 10.0, 100.0)
LANGS = ("en", "ru", "uk", "de", "es", "fr", "pt", "pl", "tr", "id", "vi", "hi", "ar", "ja", "ko", "zh")
_FUND = re.compile(r"[A-Z0-9]{1,12}")
# День считается сданным, когда его строка не менялась столько секунд.
STABLE = 45 * 60
# Движения в цепочке — не старше этого: догонка истории после простоя бота
# пишет старые блоки, и алерты о них были бы не новостью.
CHAIN_FRESH = 6 * 3600
# Отток — после двух блоков сверху: перевод на новый адрес фонда сканер
# иногда узнаёт как «свой» только в следующем блоке и снимает отток.
DEPTH_IN, DEPTH_OUT = 1, 2
KEEP_SENT = 10 * 86400
TRIES = 3

Send = Callable[[str, str], bool]


def open_schema(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)


# --- Подписки ----------------------------------------------------------------

def subs_list(con: sqlite3.Connection, chat: str) -> dict[str, Any]:
    rows = con.execute("SELECT fund, day, chain, min_btc FROM etf_alert_subs WHERE chat_id=? ORDER BY fund = ? DESC, fund",
                       (chat, ALL)).fetchall()
    return {"ok": True, "max": MAX_FUNDS, "mins": list(MINS),
            "items": [{"fund": r[0], "day": bool(r[1]), "chain": bool(r[2]), "min": float(r[3])} for r in rows]}


def subs_set(con: sqlite3.Connection, chat: str, body: dict[str, Any], now: int) -> dict[str, Any]:
    """Включить или поменять подписку на фонд (или «*»); выключенная целиком — снимается."""
    fund = str(body.get("fund") or "").strip().upper()
    if fund != ALL and not _FUND.fullmatch(fund):
        return {"ok": False, "error": "bad_args"}
    day, chain = bool(body.get("day")), bool(body.get("chain"))
    try:
        mn = float(body.get("min") or 0)
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad_args"}
    if mn not in MINS:
        return {"ok": False, "error": "bad_args"}
    lang = str(body.get("lang") or "en")
    lang = lang if lang in LANGS else "en"
    if not day and not chain:
        con.execute("DELETE FROM etf_alert_subs WHERE chat_id=? AND fund=?", (chat, fund))
        con.commit()
        return subs_list(con, chat)
    known = con.execute("SELECT 1 FROM etf_alert_subs WHERE chat_id=? AND fund=?", (chat, fund)).fetchone()
    n = con.execute("SELECT COUNT(*) FROM etf_alert_subs WHERE chat_id=?", (chat,)).fetchone()[0]
    if not known and n >= MAX_FUNDS:
        return {"ok": False, "error": "limit", "max": MAX_FUNDS}
    # created — с какого момента писать: при правке подписки не меняется.
    con.execute("INSERT INTO etf_alert_subs(chat_id, fund, day, chain, min_btc, lang, created) VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(chat_id, fund) DO UPDATE SET day=excluded.day, chain=excluded.chain, "
                "min_btc=excluded.min_btc, lang=excluded.lang", (chat, fund, int(day), int(chain), mn, lang, now))
    con.commit()
    return subs_list(con, chat)


# --- События -------------------------------------------------------------------

def _state(con: sqlite3.Connection, k: str) -> Any:
    r = con.execute("SELECT v FROM etf_alert_state WHERE k=?", (k,)).fetchone()
    try:
        return json.loads(r[0]) if r else None
    except ValueError:
        return None


def _put_state(con: sqlite3.Connection, k: str, v: Any) -> None:
    con.execute("INSERT OR REPLACE INTO etf_alert_state(k, v) VALUES(?,?)", (k, json.dumps(v)))


def day_event(con: sqlite3.Connection, reply: dict[str, Any] | None, now: int) -> dict[str, Any] | None:
    """Последний торговый день из ответа экрана ETF, если он устоялся:
    {"day", "usd" (весь поток $), "btc", "funds": {тикер: $}, "at" — когда
    устоялся}. Иначе None."""
    c = ((reply or {}).get("coins") or {}).get("btc") or {}
    days, funds = c.get("days") or [], c.get("funds") or []
    if not days or not funds:
        return None
    d = days[-1]
    try:
        day = int(d[0])
        per = {str(funds[i]["t"]): float(v) * 1000 for i, v in enumerate(d[4]) if i < len(funds) and v is not None}
        total, coins = float(d[1]) * 1000, float(d[2])
    except (TypeError, ValueError, KeyError, IndexError):
        return None
    # Как ляжет в JSON: кортежи стали бы списками, и день вечно был бы «новым».
    sig = [round(total), sorted([k, round(v)] for k, v in per.items())]
    st = _state(con, "day") or {}
    if st.get("day") != day or st.get("sig") != sig:
        st = {"day": day, "sig": sig, "since": now}
        _put_state(con, "day", st)
    if now - int(st["since"]) < STABLE or not per:
        return None
    return {"day": day, "usd": total, "btc": coins, "funds": per, "at": int(st["since"]) + STABLE}


def chain_events(btc: sqlite3.Connection, now: int) -> list[dict[str, Any]]:
    """Движения фондов в цепочке за последние часы, по блоку и фонду:
    [{"h", "ts", "fund", "dir" (1 приток, −1 отток), "btc", "px"}]."""
    def has(t: str) -> bool:
        return btc.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone() is not None

    if not has("btc_blocks"):
        return []
    tip = btc.execute("SELECT MAX(height) FROM btc_blocks").fetchone()[0] or 0
    since = now - CHAIN_FRESH
    sums: dict[tuple[int, str, int], list[float]] = {}

    def add(h: int, ts: int, fund: str, sign: int, sats: int) -> None:
        if tip - h < (DEPTH_IN if sign > 0 else DEPTH_OUT):
            return
        acc = sums.setdefault((h, fund, sign), [0.0, float(ts)])
        acc[0] += sats / 1e8

    # Фонды по своим кошелькам (опубликованным и размеченным): бот пишет
    # каждое движение строкой.
    seeded: set[str] = set()
    labeled: set[str] = set()
    if has("btc_etf_moves") and has("btc_etf_addr"):
        seeded = {str(r[0]) for r in btc.execute("SELECT DISTINCT fund FROM btc_etf_addr WHERE how = 'seed'")}
        labeled = {str(r[0]) for r in btc.execute("SELECT address FROM btc_etf_addr")}
        for h, ts, fund, kind, sats in btc.execute(
                "SELECT height, ts, fund, kind, SUM(sats) FROM btc_etf_moves WHERE ts >= ? AND kind IN (1, 2) "
                "AND fund NOT LIKE '#%' GROUP BY height, fund, kind", (since,)):
            add(int(h), int(ts), str(fund), 1 if kind == 1 else -1, int(sats))
    # Фонды у хранителя: хранилища, названные сверкой потоков. Перевод в
    # хранилище фонда не из его же хранилища — приток, обратно — отток.
    if has("btc_cust_xfer") and has("btc_etf_learned"):
        vault = {str(a): str(f) for a, f in btc.execute("SELECT address, fund FROM btc_etf_learned")}
        if vault:
            for h, ts, src, dst, sats in btc.execute(
                    "SELECT height, ts, src, dst, sats FROM btc_cust_xfer WHERE ts >= ?", (since,)):
                fs, fd = vault.get(str(src)), vault.get(str(dst))
                if fs == fd:
                    continue
                # Хранилище уже в разметке бота (корзина разнесена по фонду) —
                # его движение есть в btc_etf_moves: второй раз не считаем.
                if fd and fd not in seeded and str(dst) not in labeled:
                    add(int(h), int(ts), fd, 1, int(sats))
                if fs and fs not in seeded and str(src) not in labeled:
                    add(int(h), int(ts), fs, -1, int(sats))
    px: dict[int, float] = {}
    if sums:
        lo = min(k[0] for k in sums)
        px = {int(h): p / 1e9 for h, p in btc.execute(
            "SELECT height, price_nanos FROM btc_blocks WHERE height >= ?", (lo,)) if p}
    return [{"h": h, "ts": int(v[1]), "fund": f, "dir": s, "btc": v[0], "px": px.get(h, 0.0)}
            for (h, f, s), v in sorted(sums.items()) if v[0] > 0]


# --- Тексты ------------------------------------------------------------------

def _day_word(lang: str, ts: int) -> str:
    return dgi.date_word(lang, ts)


def text_day_all(lang: str, ev: dict[str, Any]) -> str:
    out = [dgi.tr(lang, "etfa_day_all", d=_day_word(lang, ev["day"]), v=dgi.usd(ev["usd"], lang, sign=True),
                  b=dgi.btc_amt(ev["btc"], lang, sign=True))]
    moved = sorted(((t, v) for t, v in ev["funds"].items() if abs(v) >= 1e6), key=lambda x: -x[1])
    ins = [f"{t} {dgi.usd(v, lang, sign=True)}" for t, v in moved if v > 0]
    outs = [f"{t} {dgi.usd(v, lang, sign=True)}" for t, v in reversed(moved) if v < 0]
    if ins:
        out.append(f"🟢 {dgi.tr(lang, 'etfa_in')}: " + ", ".join(ins))
    if outs:
        out.append(f"🔴 {dgi.tr(lang, 'etfa_out')}: " + ", ".join(outs))
    return "\n".join(out)


def text_day_fund(lang: str, ev: dict[str, Any], fund: str) -> str:
    v = ev["funds"][fund]
    return dgi.tr(lang, "etfa_day_fund", f=fund, d=_day_word(lang, ev["day"]),
                  dir=dgi.tr(lang, "etfa_in" if v > 0 else "etfa_out"), v=dgi.usd(v, lang, sign=True))


def text_chain(lang: str, ev: dict[str, Any]) -> str:
    b = ev["btc"] * ev["dir"]
    usd = f" ≈ {dgi.usd(b * ev['px'], lang, sign=True)}" if ev["px"] else ""
    return dgi.tr(lang, "etfa_chain", f=ev["fund"], h=dgi.num(ev["h"], lang),
                  dir=dgi.tr(lang, "etfa_in" if ev["dir"] > 0 else "etfa_out"),
                  b=dgi.btc_amt(b, lang, sign=True), v=usd) + f"\nhttps://mempool.space/block/{ev['h']}"


# --- Проход ------------------------------------------------------------------

class _Out:
    """Отправка за один проход: что ушло — в etf_alert_sent, второй раз не уйдёт."""

    def __init__(self, con: sqlite3.Connection, send: Send, now: int) -> None:
        self.con, self.send, self.now, self.sent = con, send, now, 0

    def __call__(self, chat: str, key: str, text: str) -> None:
        r = self.con.execute("SELECT ok, tries FROM etf_alert_sent WHERE chat_id=? AND key=?", (chat, key)).fetchone()
        if r and (r[0] or r[1] >= TRIES):
            return
        ok = bool(self.send(chat, text))
        self.con.execute("INSERT INTO etf_alert_sent(chat_id, key, at, ok, tries) VALUES(?,?,?,?,1) "
                         "ON CONFLICT(chat_id, key) DO UPDATE SET at=excluded.at, ok=excluded.ok, tries=tries+1",
                         (chat, key, self.now, int(ok)))
        self.sent += int(ok)


def check(con: sqlite3.Connection, btc: sqlite3.Connection | None, reply: dict[str, Any] | None,
          send: Send, now: int) -> int:
    """Один проход: итог дня и движения в цепочке — всем, кто подписан.
    Вернёт, сколько писем ушло."""
    open_schema(con)
    subs = con.execute("SELECT chat_id, fund, day, chain, min_btc, lang, created FROM etf_alert_subs").fetchall()
    out = _Out(con, send, now)
    day = day_event(con, reply, now)
    chain = chain_events(btc, now) if btc is not None and any(s[3] for s in subs) else []
    by_chat: dict[str, dict[str, tuple[Any, ...]]] = {}
    for s in subs:
        by_chat.setdefault(str(s[0]), {})[str(s[1])] = s
    for chat, mine in by_chat.items():
        everything = mine.get(ALL)
        if day:
            all_day = bool(everything and everything[2] and day["at"] >= everything[6])
            if everything and all_day:
                out(chat, f"d:{day['day']}:*", text_day_all(everything[5], day))
            for fund, s in mine.items():
                v = day["funds"].get(fund, 0.0)
                if fund == ALL or not s[2] or day["at"] < s[6] or abs(v) < 1:
                    continue
                # Итог по всем фондам уже называет каждый фонд от $1 млн.
                if all_day and abs(v) >= 1e6:
                    continue
                out(chat, f"d:{day['day']}:{fund}", text_day_fund(s[5], day, fund))
        for ev in chain:
            want = [s for s in (mine.get(ev["fund"]), everything)
                    if s and s[3] and ev["ts"] >= s[6] and ev["btc"] >= s[4]]
            if want:
                key = f"c:{ev['h']}:{ev['fund']}:{ev['dir']}"
                out(chat, key, text_chain(want[0][5], ev))
    con.execute("DELETE FROM etf_alert_sent WHERE at < ?", (now - KEEP_SENT,))
    con.commit()
    return out.sent
