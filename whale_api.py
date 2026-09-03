#!/usr/bin/env python3
"""Read-only(+mutations) JSON API over whale_bot.db + hyperliquid.db.
Stdlib only. Run from WhaleScanner working directory on the VPS."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HOST = os.environ.get("WHALE_API_HOST", "0.0.0.0")
PORT = int(os.environ.get("WHALE_API_PORT", "8090"))
DB = os.environ.get("WHALE_DB", os.path.abspath("whale_bot.db"))
HL_DB = os.environ.get("WHALE_HL_DB", os.path.abspath("hyperliquid.db"))
BOT_TOKEN = os.environ.get("WHALE_TG_TOKEN", "")
HL_INFO = "https://api.hyperliquid.xyz/info"

NANOS = 1_000_000_000.0
ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
COIN_RE = re.compile(r"\b([A-Z]{2,12})\b")
_hl_cache: dict[str, tuple[float, dict]] = {}


def now() -> int:
    return int(time.time())


def open_db(path: str, write: bool = False) -> sqlite3.Connection | None:
    if not path or not os.path.isfile(path):
        return None
    con = sqlite3.connect(path, timeout=8, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=8000")
    if not write:
        try:
            con.execute("PRAGMA query_only=ON")
        except sqlite3.Error:
            pass
    return con


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return bool(row)


def cols(con: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}


def usd(nanos) -> float:
    try:
        return float(nanos or 0) / NANOS
    except (TypeError, ValueError):
        return 0.0


def ago(ts: int) -> str:
    d = max(0, now() - int(ts or 0))
    if d < 60:
        return f"{d} сек"
    if d < 3600:
        return f"{d // 60} мин"
    if d < 86400:
        return f"{d // 3600} ч"
    return f"{d // 86400} д"


def short_addr(a: str) -> str:
    a = a or ""
    if len(a) < 12:
        return a
    return a[:6] + "…" + a[-4:]


def verify_init_data(raw: str) -> dict | None:
    if not raw:
        return None
    parts = {}
    for chunk in raw.split("&"):
        if "=" not in chunk:
            continue
        k, v = chunk.split("=", 1)
        parts[k] = unquote(v)
    got = parts.pop("hash", "")
    if BOT_TOKEN and got:
        check = "\n".join(f"{k}={parts[k]}" for k in sorted(parts))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        expect = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expect, got):
            return None
    user_raw = parts.get("user") or ""
    try:
        user = json.loads(user_raw) if user_raw else {}
    except json.JSONDecodeError:
        user = {}
    uid = user.get("id")
    if uid is None:
        return None
    return {"id": str(uid), "lang": user.get("language_code") or "ru"}


def hl_post(payload: dict, timeout: float = 6.0):
    req = urllib.request.Request(
        HL_INFO,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return None


def hl_state(addr: str) -> dict:
    key = addr.lower()
    hit = _hl_cache.get(key)
    if hit and time.monotonic() - hit[0] < 20:
        return hit[1]
    perp = hl_post({"type": "clearinghouseState", "user": addr}) or {}
    spot = hl_post({"type": "spotClearinghouseState", "user": addr}) or {}
    out = {"perp": perp, "spot": spot}
    _hl_cache[key] = (time.monotonic(), out)
    return out


def parse_positions(addr: str) -> tuple[list, dict, float]:
    st = hl_state(addr)
    perp = st.get("perp") or {}
    spot = st.get("spot") or {}
    ms = perp.get("marginSummary") or {}
    equity = {
        "total": float(ms.get("accountValue") or 0),
        "spot": 0.0,
        "perp": float(ms.get("accountValue") or 0),
        "hip3": 0.0,
        "vaults": 0.0,
    }
    for b in spot.get("balances") or []:
        try:
            equity["spot"] += float(b.get("total") or 0)
        except (TypeError, ValueError):
            pass
    equity["total"] = equity["spot"] + equity["perp"]
    pos = []
    for ap in perp.get("assetPositions") or []:
        p = ap.get("position") or ap
        try:
            szi = float(p.get("szi") or 0)
        except (TypeError, ValueError):
            continue
        if abs(szi) < 1e-12:
            continue
        lev = p.get("leverage") or {}
        try:
            lev_n = int(float(lev.get("value") or 1))
        except (TypeError, ValueError):
            lev_n = 1
        try:
            entry = float(p.get("entryPx") or 0)
            now_px = float(p.get("positionValue") or 0) / abs(szi) if szi else 0
            pnl = float(p.get("unrealizedPnl") or 0)
            margin = float(p.get("marginUsed") or 0)
            liq = float(p.get("liquidationPx") or 0) if p.get("liquidationPx") not in (None, "") else 0
        except (TypeError, ValueError):
            continue
        pos.append(
            {
                "sym": str(p.get("coin") or "?").upper(),
                "long": szi > 0,
                "lev": max(1, lev_n),
                "size": abs(szi) * now_px if now_px else abs(szi),
                "entry": entry,
                "now": now_px or entry,
                "margin": margin,
                "liq": liq,
                "pnl": pnl,
                "pct": (pnl / margin * 100.0) if margin else 0.0,
                "funding": 0.0,
                "held": "",
                "isolated": str(lev.get("type") or "") == "isolated",
                "hist": [],
            }
        )
    d1 = 0.0
    try:
        d1 = float((perp.get("marginSummary") or {}).get("totalNtlPos") or 0)
        if equity["total"]:
            d1 = 0.0
    except (TypeError, ValueError):
        d1 = 0.0
    return pos, equity, d1


def symbol_of(cur: sqlite3.Connection, token: str) -> str:
    token = token or ""
    if token.startswith("0x") and len(token) >= 8:
        if table_exists(cur, "token_cache"):
            row = cur.execute(
                "SELECT symbol FROM token_cache WHERE lower(address)=?", (token.lower(),)
            ).fetchone()
            if row and row[0]:
                return str(row[0]).upper()
        return token[:6].upper()
    return token.upper()[:12] or "?"


def spark(net: float) -> list[int]:
    base = 50
    step = 3 if net >= 0 else -3
    return [max(8, min(92, base + step * i + (i % 3))) for i in range(12)]


def parse_alert(msg: str, ts: int, name: str = "") -> dict:
    text = re.sub(r"<[^>]+>", " ", msg or "")
    text = re.sub(r"\s+", " ", text).strip()
    side = "LONG"
    if re.search(r"short|шорт|прода", text, re.I):
        side = "SHORT"
    elif re.search(r"long|лонг|куп", text, re.I):
        side = "LONG"
    skip = {"USD", "USDT", "USDC", "BSC", "HL", "PNL", "ROI", "WALLET", "ALERT"}
    sym = "—"
    for m in COIN_RE.findall(text.upper()):
        if m not in skip:
            sym = m
            break
    notional = 0.0
    m = re.search(r"\$[\s]?([0-9][0-9.,]*)[kKmMб]?", text)
    if m:
        raw = m.group(1).replace(",", "")
        try:
            notional = float(raw)
            if "m" in (m.group(0) or "").lower() or "м" in m.group(0).lower():
                notional *= 1_000_000
            elif "k" in (m.group(0) or "").lower() or "к" in m.group(0).lower():
                notional *= 1_000
        except ValueError:
            notional = 0.0
    return {
        "name": name or short_addr(""),
        "side": side,
        "sym": sym,
        "notional": notional,
        "account": 0,
        "margin": 0,
        "roi": 0,
        "t": ago(ts),
        "raw": text[:240],
    }


def load_me(cur: sqlite3.Connection, chat: str) -> dict:
    plan, thr, lang, prem_until = "free", 10000.0, "ru", 0
    if table_exists(cur, "users"):
        cset = cols(cur, "users")
        fields = ["threshold_nanos", "language"]
        if "is_premium" in cset:
            fields += ["is_premium", "premium_expire"]
        row = cur.execute(
            f"SELECT {', '.join(fields)} FROM users WHERE chat_id=?", (chat,)
        ).fetchone()
        if row:
            thr = max(50.0, usd(row["threshold_nanos"]))
            lang = row["language"] or "ru"
            if "is_premium" in cset and row["is_premium"] and int(row["premium_expire"] or 0) > now():
                plan = "premium"
                prem_until = int(row["premium_expire"]) * 1000
    alerts_today = alerts_30 = 0
    if table_exists(cur, "deliveries") and table_exists(cur, "alerts"):
        alerts_today = cur.execute(
            "SELECT COUNT(*) FROM deliveries d JOIN alerts a ON a.id=d.alert_id "
            "WHERE d.chat_id=? AND a.created_at>=?",
            (chat, now() - 86400),
        ).fetchone()[0]
        alerts_30 = cur.execute(
            "SELECT COUNT(*) FROM deliveries d JOIN alerts a ON a.id=d.alert_id "
            "WHERE d.chat_id=? AND a.created_at>=?",
            (chat, now() - 30 * 86400),
        ).fetchone()[0]
    return {
        "plan": plan,
        "limit": 50 if plan == "premium" else 1,
        "threshold": thr,
        "lang": lang,
        "alertsToday": int(alerts_today or 0),
        "alerts30d": int(alerts_30 or 0),
        "premUntil": prem_until,
        "updatedKey": "justNow",
    }


def load_wallets(cur: sqlite3.Connection, chat: str) -> list[dict]:
    if not table_exists(cur, "user_whales"):
        return []
    uw_cols = cols(cur, "user_whales")
    primary_sql = "uw.is_primary" if "is_primary" in uw_cols else "0"
    rows = cur.execute(
        f"SELECT wa.id AS id, wa.address AS addr, uw.label AS label, {primary_sql} AS is_primary "
        "FROM user_whales uw JOIN whale_addresses wa ON wa.id=uw.whale_id "
        "WHERE uw.user_id=? ORDER BY uw.is_primary DESC, uw.created_at ASC",
        (chat,),
    ).fetchall() if "is_primary" in uw_cols else cur.execute(
        "SELECT wa.id AS id, wa.address AS addr, uw.label AS label, 0 AS is_primary "
        "FROM user_whales uw JOIN whale_addresses wa ON wa.id=uw.whale_id "
        "WHERE uw.user_id=? ORDER BY uw.created_at ASC",
        (chat,),
    ).fetchall()
    wallets = []
    for i, r in enumerate(rows):
        addr = (r["addr"] or "").lower()
        name = (r["label"] or "").strip() or short_addr(addr)
        pos, equity, _ = parse_positions(addr)
        stats = wallet_stats(cur, addr)
        bal = equity.get("total") or stats["bal"] or 0
        d1 = (stats["net"] / bal * 100.0) if bal else 0.0
        wallets.append(
            {
                "id": f"w{r['id']}",
                "name": name,
                "addr": addr,
                "short": short_addr(addr),
                "primary": bool(r["is_primary"]),
                "score": stats["score"],
                "bal": bal,
                "trades": stats["tr"],
                "win": stats["win"],
                "pf": stats["pf"],
                "net": stats["net"],
                "dd": stats["dd"],
                "spot": stats["spot"],
                "perp": stats["perp"],
                "d1": d1,
                "equity": equity,
                "pos": pos,
            }
        )
    if wallets and not any(w["primary"] for w in wallets):
        wallets[0]["primary"] = True
    return wallets


def wallet_stats(cur: sqlite3.Connection, addr: str) -> dict:
    out = {"score": 50, "bal": 0, "tr": 0, "win": 0, "pf": 1, "net": 0, "dd": 0, "spot": "—", "perp": "—", "d1": 0}
    since = now() - 86400
    if table_exists(cur, "trades"):
        row = cur.execute(
            "SELECT COUNT(*) c, "
            "SUM(CASE WHEN is_buy=1 THEN usd_nanos ELSE 0 END) buy, "
            "SUM(CASE WHEN is_buy=0 THEN usd_nanos ELSE 0 END) sell "
            "FROM trades WHERE lower(wallet)=? AND timestamp>=?",
            (addr, since),
        ).fetchone()
        buy, sell = usd(row["buy"] if row else 0), usd(row["sell"] if row else 0)
        out["d1"] = 0.0
        out["tr"] = int(row["c"] or 0) if row else 0
        out["net"] = buy - sell
    if table_exists(cur, "ranking_cache"):
        payload = cur.execute(
            "SELECT payload FROM ranking_cache WHERE cache_key=?", ("global_pnl_30",)
        ).fetchone()
        if payload and payload[0]:
            try:
                arr = json.loads(payload[0])
                for i, e in enumerate(arr[:100]):
                    if str(e.get("w") or "").lower() == addr:
                        out["spot"] = f"#{i + 1}"
                        out["net"] = usd(e.get("p"))
                        out["win"] = float(e.get("wr") or 0)
                        out["tr"] = int(e.get("t") or out["tr"])
                        out["score"] = max(8, min(99, int(out["win"] * 0.6 + min(40, abs(out["net"]) / 200000))))
                        break
            except json.JSONDecodeError:
                pass
    return out


def load_alerts(cur: sqlite3.Connection, chat: str, wallets: list) -> tuple[list, list]:
    names = {w["addr"]: w["name"] for w in wallets}
    alerts, feed = [], []
    if not (table_exists(cur, "alerts") and table_exists(cur, "deliveries")):
        return alerts, feed
    rows = cur.execute(
        "SELECT a.message, a.created_at FROM alerts a "
        "JOIN deliveries d ON d.alert_id=a.id "
        "WHERE d.chat_id=? AND a.created_at>=? "
        "ORDER BY a.created_at DESC LIMIT 40",
        (chat, now() - 2 * 86400),
    ).fetchall()
    for r in rows:
        parsed = parse_alert(r["message"], r["created_at"], "")
        alerts.append(parsed)
        feed.append(
            {
                "t": parsed["t"],
                "sym": parsed["sym"] if parsed["sym"] != "—" else "BTC",
                "w": parsed["name"] or "бот",
                "act": "купил" if parsed["side"] == "LONG" else "продаёт",
                "v": parsed["notional"],
                "up": parsed["side"] == "LONG",
            }
        )
    if wallets:
        for a in alerts:
            if not a["name"]:
                a["name"] = wallets[0]["name"]
    _ = names
    return alerts, feed


def load_flow(cur: sqlite3.Connection) -> dict:
    out = {}
    if not table_exists(cur, "trades"):
        return out
    for win, sec in ((1, 3600), (6, 21600), (24, 86400), (168, 604800), (720, 2592000)):
        since = now() - sec
        rows = cur.execute(
            "SELECT token, "
            "SUM(CASE WHEN is_buy=1 THEN usd_nanos ELSE 0 END) buy, "
            "SUM(CASE WHEN is_buy=0 THEN usd_nanos ELSE 0 END) sell, "
            "COUNT(DISTINCT wallet) w "
            "FROM trades WHERE timestamp>=? GROUP BY token "
            "ORDER BY ABS(SUM(CASE WHEN is_buy=1 THEN usd_nanos ELSE -usd_nanos END)) DESC LIMIT 40",
            (since,),
        ).fetchall()
        coins = []
        buy_t = sell_t = 0.0
        for r in rows:
            b, s = usd(r["buy"]), usd(r["sell"])
            buy_t += b
            sell_t += s
            net = b - s
            coins.append(
                {
                    "sym": symbol_of(cur, r["token"]),
                    "net": net,
                    "buy": b,
                    "sell": s,
                    "w": int(r["w"] or 0),
                    "top": min(0.95, (b / (b + s)) if (b + s) else 0.5),
                    "c1": 0,
                    "c6": 0,
                    "c24": 0,
                    "sp": spark(net),
                }
            )
        out[str(win)] = {
            "net": buy_t - sell_t,
            "coins": len(coins),
            "buy": buy_t,
            "sell": sell_t,
            "rows": coins,
        }
    return out


def load_rank(cur: sqlite3.Connection) -> dict:
    rank: dict = {"spot": {"pnl": [], "roi": [], "win": [], "act": []}, "perp": {"pnl": [], "roi": [], "win": [], "act": []}}
    if not table_exists(cur, "ranking_cache"):
        return rank
    kind_map = {"pnl": "pnl", "roi": "roi", "winrate": "win", "active": "act"}
    for days in (30, 90, 180, 365):
        for kind, key in kind_map.items():
            row = cur.execute(
                "SELECT payload FROM ranking_cache WHERE cache_key=?",
                (f"global_{kind}_{days}",),
            ).fetchone()
            if not row or not row[0]:
                continue
            try:
                arr = json.loads(row[0])
            except json.JSONDecodeError:
                continue
            mapped = []
            for e in arr[:100]:
                hold_s = int(e.get("h") or 0)
                mapped.append(
                    {
                        "a": e.get("w") or "",
                        "pnl": usd(e.get("p")),
                        "roi": float(e.get("r") or 0),
                        "win": float(e.get("wr") or 0),
                        "tr": int(e.get("t") or 0),
                        "dd": 0,
                        "days": days,
                        "hold": f"{max(1, hold_s // 3600)}ч" if hold_s else None,
                    }
                )
            if days == 30:
                rank["spot"][key] = mapped
    # perp ranking lives in hl fills if ranking_cache has no venue split
    rank["perp"] = {k: list(v) for k, v in rank["spot"].items()}
    return rank


def load_trades(cur: sqlite3.Connection, hl: sqlite3.Connection | None) -> dict:
    spot, perp, liq = [], [], []
    if table_exists(cur, "trades"):
        rows = cur.execute(
            "SELECT wallet, token, is_buy, usd_nanos, timestamp FROM trades "
            "ORDER BY timestamp DESC LIMIT 40"
        ).fetchall()
        for r in rows:
            spot.append(
                {
                    "sym": symbol_of(cur, r["token"]),
                    "v": usd(r["usd_nanos"]),
                    "side": "покупка" if r["is_buy"] else "продажа",
                    "w": short_addr(r["wallet"] or ""),
                    "t": ago(r["timestamp"]),
                }
            )
    if hl and table_exists(hl, "hl_fills"):
        rows = hl.execute(
            "SELECT wallet, coin, dir, side, notional_nanos, ts, dir_code FROM hl_fills "
            "ORDER BY ts DESC LIMIT 40"
        ).fetchall()
        for r in rows:
            side = (r["dir"] or r["side"] or "").lower()
            row = {
                "sym": str(r["coin"] or "?").upper(),
                "v": usd(r["notional_nanos"]),
                "side": r["dir"] or r["side"] or "",
                "w": short_addr(r["wallet"] or ""),
                "t": ago(r["ts"]),
            }
            if int(r["dir_code"] or 0) >= 5 or "liq" in side:
                liq.append(row)
            else:
                perp.append(row)
    return {"spot": spot[:20], "perp": perp[:20], "liq": liq[:20]}


def load_feed_market(cur: sqlite3.Connection, hl: sqlite3.Connection | None) -> list:
    items = []
    if table_exists(cur, "trades"):
        for r in cur.execute(
            "SELECT wallet, token, is_buy, usd_nanos, timestamp FROM trades "
            "ORDER BY timestamp DESC LIMIT 20"
        ):
            items.append(
                {
                    "t": ago(r["timestamp"]),
                    "sym": symbol_of(cur, r["token"]),
                    "w": short_addr(r["wallet"] or ""),
                    "act": "купил" if r["is_buy"] else "продал",
                    "v": usd(r["usd_nanos"]),
                    "up": bool(r["is_buy"]),
                }
            )
    if hl and table_exists(hl, "hl_fills"):
        for r in hl.execute(
            "SELECT wallet, coin, dir, notional_nanos, ts FROM hl_fills ORDER BY ts DESC LIMIT 20"
        ):
            items.append(
                {
                    "t": ago(r["ts"]),
                    "sym": str(r["coin"] or "?").upper(),
                    "w": short_addr(r["wallet"] or ""),
                    "act": r["dir"] or "сделка",
                    "v": usd(r["notional_nanos"]),
                    "up": "buy" in (r["dir"] or "").lower() or "long" in (r["dir"] or "").lower(),
                }
            )
    items.sort(key=lambda x: x["t"])
    return items[:24]


def load_funding(hl: sqlite3.Connection | None) -> list:
    if not hl or not table_exists(hl, "hl_funding_rate"):
        return []
    rows = hl.execute(
        "SELECT coin, rate_nanos, oi_nanos FROM hl_funding_rate "
        "WHERE hour_ts=(SELECT MAX(hour_ts) FROM hl_funding_rate) "
        "ORDER BY ABS(rate_nanos) DESC LIMIT 12"
    ).fetchall()
    out = []
    for r in rows:
        rate = usd(r["rate_nanos"])
        out.append(
            {
                "sym": str(r["coin"] or "?").upper(),
                "rate": rate * 100,
                "apr": rate * 24 * 365 * 100,
                "oi": usd(r["oi_nanos"]),
                "side": "лонги платят" if rate >= 0 else "шорты платят",
            }
        )
    return out


def load_rot(cur: sqlite3.Connection) -> dict:
    rot = {"24": [], "168": []}
    if not table_exists(cur, "trades"):
        return rot
    for key, sec in (("24", 86400), ("168", 604800)):
        since = now() - sec
        rows = cur.execute(
            "SELECT wallet, token, is_buy, usd_nanos FROM trades WHERE timestamp>=? "
            "ORDER BY wallet, timestamp",
            (since,),
        ).fetchall()
        last_sell: dict[str, str] = {}
        agg: dict[tuple[str, str], list] = {}
        for r in rows:
            w = (r["wallet"] or "").lower()
            tok = symbol_of(cur, r["token"])
            if r["is_buy"]:
                src = last_sell.get(w)
                if src and src != tok:
                    slot = agg.setdefault((src, tok), [0.0, set()])
                    slot[0] += usd(r["usd_nanos"])
                    slot[1].add(w)
            else:
                last_sell[w] = tok
        links = [
            {"from": a, "to": b, "usd": v[0], "w": len(v[1])}
            for (a, b), v in agg.items()
            if v[0] > 0
        ]
        links.sort(key=lambda x: -x["usd"])
        rot[key] = links[:12]
    return rot


def load_sonar(cur: sqlite3.Connection) -> dict:
    sonar = {
        "need": 400,
        "ready": {"spot": 0, "perp": 0},
        "trained": False,
        "acc": None,
        "list": [],
        "hist": {"hit": 0, "of": 0, "won": 0, "tp": 0, "sl": 0, "missed": 0, "broken": 0, "avg": 0, "items": []},
    }
    if not table_exists(cur, "ai_events"):
        return sonar
    for venue, key in ((0, "spot"), (1, "perp")):
        n = cur.execute(
            "SELECT COUNT(*) FROM ai_events WHERE venue=? AND filled_at>0", (venue,)
        ).fetchone()[0]
        sonar["ready"][key] = int(n or 0)
    sonar["trained"] = sonar["ready"]["spot"] >= 400
    rows = cur.execute(
        "SELECT name, token, venue, buy_nanos, sell_nanos, wallets, score, price_then, window_days "
        "FROM ai_events WHERE hour_slot=(SELECT MAX(hour_slot) FROM ai_events) "
        "ORDER BY score DESC LIMIT 24"
    ).fetchall()
    for r in rows:
        buy, sell = usd(r["buy_nanos"]), usd(r["sell_nanos"])
        net = buy - sell
        px = usd(r["price_then"])
        side = "buy" if net >= 0 else "sell"
        sym = (r["name"] or symbol_of(cur, r["token"]) or "?").upper()
        stop_pct = 2.5
        sonar["list"].append(
            {
                "sym": sym,
                "side": side,
                "conf": max(40, min(95, int(abs(float(r["score"] or 0)) * 10 + 50))),
                "net": net,
                "w": int(r["wallets"] or 0),
                "entry": px,
                "lo": px * 0.995,
                "hi": px * 1.005,
                "stop": px * (0.985 if side == "buy" else 1.015),
                "stopPct": stop_pct,
                "t1": px * (1.022 if side == "buy" else 0.978),
                "t2": px * (1.045 if side == "buy" else 0.955),
                "risk": 4.5,
                "lev": 1 if r["venue"] == 0 else 3,
                "why": ["flow", "top100"] if net >= 0 else ["top100-out"],
                "winH": int(r["window_days"] or 24),
                "venue": "perp" if r["venue"] else "spot",
            }
        )
    hist_rows = cur.execute(
        "SELECT name, token, venue, buy_nanos, sell_nanos, price_then, price_24h, ts "
        "FROM ai_events WHERE filled_at>0 AND price_then>0 AND price_24h>0 "
        "ORDER BY ts DESC LIMIT 12"
    ).fetchall()
    won = 0
    items = []
    for r in hist_rows:
        long = usd(r["buy_nanos"]) >= usd(r["sell_nanos"])
        p0, p1 = usd(r["price_then"]), usd(r["price_24h"])
        ret = ((p1 - p0) / p0 * 100.0) if p0 else 0
        if not long:
            ret = -ret
        win = ret > 0
        won += int(win)
        items.append(
            {
                "sym": (r["name"] or symbol_of(cur, r["token"])).upper(),
                "long": long,
                "ret": ret,
                "t": ago(r["ts"]),
                "win": win,
            }
        )
    sonar["hist"]["items"] = items
    sonar["hist"]["of"] = len(items)
    sonar["hist"]["won"] = won
    sonar["hist"]["hit"] = int(100 * won / len(items)) if items else 0
    return sonar


def load_coins(flow: dict, wallets: list) -> dict:
    coins = {}
    rows = ((flow.get("24") or {}).get("rows") or []) + ((flow.get("6") or {}).get("rows") or [])
    who_by = {}
    for w in wallets:
        for p in w.get("pos") or []:
            who_by.setdefault(p["sym"], []).append({"w": w["name"], "v": p["size"], "t": "сейчас"})
    seen = set()
    for r in rows:
        sym = r["sym"]
        if sym in seen:
            continue
        seen.add(sym)
        coins[sym] = {
            "price": 0,
            "chg": r.get("c24") or 0,
            "entry": 0,
            "hist": r.get("sp") or spark(r["net"]),
            "net": r["net"],
            "buy": r["buy"],
            "sell": r["sell"],
            "w": r["w"],
            "mcap": "—",
            "liq": "—",
            "who": who_by.get(sym, []),
            "cons": {"top": min(24, r["w"]), "of": max(r["w"], 24), "first": "—", "also": []},
        }
    return coins


def bootstrap(chat: str) -> dict:
    cur = open_db(DB)
    hl = open_db(HL_DB)
    if not cur:
        return {"ok": False, "live": False, "error": "db_missing", "db": DB}
    try:
        me = load_me(cur, chat) if chat else {
            "plan": "free", "limit": 1, "threshold": 10000, "lang": "ru",
            "alertsToday": 0, "alerts30d": 0, "premUntil": 0, "updatedKey": "justNow",
        }
        wallets = load_wallets(cur, chat) if chat else []
        alerts, feed = load_alerts(cur, chat, wallets) if chat else ([], [])
        flow = load_flow(cur)
        rank = load_rank(cur)
        trades = load_trades(cur, hl)
        market_feed = load_feed_market(cur, hl)
        funding = load_funding(hl)
        rot = load_rot(cur)
        sonar = load_sonar(cur)
        coins = load_coins(flow, wallets)
        return {
            "ok": True,
            "live": True,
            "me": me,
            "wallets": wallets,
            "feed": feed,
            "alerts": alerts,
            "flow": flow,
            "rank": rank,
            "sonar": sonar,
            "trades": trades,
            "funding": funding,
            "rot": rot,
            "coins": coins,
            "marketFeed": market_feed,
        }
    finally:
        cur.close()
        if hl:
            hl.close()


def mutate(chat: str, kind: str, body: dict) -> dict:
    if not chat:
        return {"ok": False, "error": "no_user"}
    con = open_db(DB, write=True)
    if not con:
        return {"ok": False, "error": "db_missing"}
    try:
        con.execute("INSERT OR IGNORE INTO users(chat_id, language, threshold_nanos, created_at) VALUES(?,?,?,?)",
                    (chat, "ru", 100000000000, now()))
        if kind == "add":
            addr = (body.get("addr") or "").strip().lower()
            name = (body.get("name") or "").strip() or short_addr(addr)
            if not ADDR_RE.match(addr):
                return {"ok": False, "error": "bad_addr"}
            con.execute("INSERT OR IGNORE INTO whale_addresses(address) VALUES(?)", (addr,))
            wid = con.execute("SELECT id FROM whale_addresses WHERE address=?", (addr,)).fetchone()[0]
            exists = con.execute(
                "SELECT 1 FROM user_whales WHERE user_id=? AND whale_id=?", (chat, wid)
            ).fetchone()
            if exists:
                return {"ok": False, "error": "dup"}
            n = con.execute("SELECT COUNT(*) FROM user_whales WHERE user_id=?", (chat,)).fetchone()[0]
            first = n == 0
            con.execute(
                "INSERT INTO user_whales(user_id,whale_id,label,created_at,is_primary) VALUES(?,?,?,?,?)",
                (chat, wid, name, now(), 1 if first else 0),
            )
        elif kind == "remove":
            addr = (body.get("addr") or "").strip().lower()
            row = con.execute("SELECT id FROM whale_addresses WHERE address=?", (addr,)).fetchone()
            if not row:
                return {"ok": False, "error": "missing"}
            con.execute("DELETE FROM user_whales WHERE user_id=? AND whale_id=?", (chat, row[0]))
        elif kind == "primary":
            addr = (body.get("addr") or "").strip().lower()
            row = con.execute("SELECT id FROM whale_addresses WHERE address=?", (addr,)).fetchone()
            if not row:
                return {"ok": False, "error": "missing"}
            con.execute("UPDATE user_whales SET is_primary=0 WHERE user_id=?", (chat,))
            con.execute(
                "UPDATE user_whales SET is_primary=1 WHERE user_id=? AND whale_id=?",
                (chat, row[0]),
            )
        elif kind == "rename":
            addr = (body.get("addr") or "").strip().lower()
            name = (body.get("name") or "").strip()
            row = con.execute("SELECT id FROM whale_addresses WHERE address=?", (addr,)).fetchone()
            if not row or not name:
                return {"ok": False, "error": "missing"}
            con.execute(
                "UPDATE user_whales SET label=? WHERE user_id=? AND whale_id=?",
                (name, chat, row[0]),
            )
        elif kind == "threshold":
            usd_v = float(body.get("usd") or 0)
            if usd_v < 50:
                return {"ok": False, "error": "min"}
            con.execute(
                "UPDATE users SET threshold_nanos=? WHERE chat_id=?",
                (int(usd_v * NANOS), chat),
            )
        else:
            return {"ok": False, "error": "unknown"}
        con.commit()
        return {"ok": True}
    except Exception as e:
        try:
            con.rollback()
        except Exception:
            pass
        return {"ok": False, "error": str(e)}
    finally:
        con.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[api] " + (fmt % args) + "\n")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _json(self, code: int, obj: dict):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _user(self, qs: dict) -> str:
        init = self.headers.get("X-Telegram-Init-Data") or qs.get("init", [""])[0]
        parsed = verify_init_data(init)
        if parsed:
            return parsed["id"]
        return (qs.get("tg") or [""])[0].strip()

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        path = u.path.rstrip("/") or "/"
        if path in ("/health", "/api/health"):
            self._json(200, {"ok": True, "db": os.path.isfile(DB), "hl": os.path.isfile(HL_DB)})
            return
        if path in ("/bootstrap", "/api/bootstrap", "/api/me"):
            chat = self._user(qs)
            self._json(200, bootstrap(chat))
            return
        self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        path = u.path.rstrip("/") or "/"
        chat = self._user(qs)
        body = self._body()
        kind = {
            "/api/wallets": "add",
            "/api/wallets/remove": "remove",
            "/api/wallets/primary": "primary",
            "/api/wallets/rename": "rename",
            "/api/threshold": "threshold",
        }.get(path)
        if not kind:
            self._json(404, {"ok": False, "error": "not_found"})
            return
        res = mutate(chat, kind, body)
        if res.get("ok"):
            res = {**res, **bootstrap(chat)}
        self._json(200 if res.get("ok") else 400, res)


def main():
    print(f"[api] db={DB} hl={HL_DB} listen={HOST}:{PORT}", flush=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
