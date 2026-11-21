# © 2026 Wallet Tracker. Все права защищены — см. LICENSE.
"""Автокопирование китов — закрытый модуль владельца (сторона API).

Только для владельца бота (OWNER_CHAT_ID). Никто другой о модуле не узнаёт:
маршрут отвечает чужим тем же 404, что и несуществующий адрес, приложение
показывает вкладку только владельцу, а проверка — на сервере по подписи
Telegram, а не скрытием кнопки.

API сам ничего не считает и не торгует. Всё делает служба whale-autotrade
(``<WhaleScanner>/tools/autotrade_live.py``) — со своими ключами OKX и своим
пределом памяти:
- реальная торговля на OKX;
- бэктест — ночью и по кнопке «Пересчитать сейчас». Раньше он шёл внутри
  API и вместе с ней не помещался в её предел памяти (1,5 ГБ): ядро убивало
  всю службу API (oom-kill) — приложение не отвечало.

API только пишет в каталог модуля выбор владельца (switch.json — «Старт»/
«Стоп») и запрос на пересчёт (run.request), а читает оттуда состояние
службы (live/state.json, live/trades.jsonl), итог бэктеста
(latest/summary.json) и ход пересчёта (backtest_status.json).
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

# Каталог модуля. По умолчанию — рядом с API (в git не попадает,
# .gitignore): служба whale-api видит домашний каталог только на чтение
# (ProtectHome=read-only), писать ей можно лишь в каталоги из ReadWritePaths.
DATA_DIR = os.path.abspath(os.path.expanduser(
    os.environ.get("WT_AUTOTRADE_DIR")
    or os.path.join(os.path.dirname(os.path.abspath(__file__)), "autotrade_data")))


def is_on(data_dir: str = DATA_DIR) -> bool:
    """Включён ли модуль. Нет файла или он испорчен — выключен."""
    try:
        with open(os.path.join(data_dir, "switch.json"), encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(got, dict) and got.get("on") is True


def _set_on(on: bool, data_dir: str) -> None:
    os.makedirs(data_dir, exist_ok=True)
    tmp = os.path.join(data_dir, "switch.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"on": on, "at": int(time.time())}, f)
    os.replace(tmp, os.path.join(data_dir, "switch.json"))


def _try_set(on: bool, data_dir: str) -> dict[str, Any] | None:
    """Записать выбор владельца; не вышло — ответ с причиной (а не 500,
    которое приложение показало бы как «нет связи»)."""
    try:
        _set_on(on, data_dir)
    except OSError as e:
        print(f"[AUTO] {'старт' if on else 'стоп'}: не записать {data_dir}: {e.strerror or e}", flush=True)
        return {"ok": False, "error": "no_write", "dir": data_dir}
    return None


def latest(data_dir: str = DATA_DIR) -> dict[str, Any] | None:
    """Последний итог бэктеста; нет или испорчен — None."""
    try:
        with open(os.path.join(data_dir, "latest", "summary.json"), encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) else None


def start(_ws_dir: str = "", _hl_db: str = "") -> None:
    """При запуске API: ничего не запускаем — считает служба whale-autotrade."""
    print("[AUTO] бэктест и торговля — в службе whale-autotrade; API только показывает", flush=True)


def _request_run(data_dir: str) -> None:
    os.makedirs(data_dir, exist_ok=True)
    with open(os.path.join(data_dir, "run.request"), "w", encoding="utf-8") as f:
        json.dump({"at": int(time.time())}, f)


def backtest_status(data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Ход пересчёта — его пишет служба whale-autotrade."""
    try:
        with open(os.path.join(data_dir, "backtest_status.json"), encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        got = {}
    got = got if isinstance(got, dict) else {}
    return {"running": bool(got.get("running")), "started": int(got.get("started") or 0),
            "finished": int(got.get("finished") or 0), "error": str(got.get("error") or ""),
            "next": int(got.get("next") or 0),
            "requested": os.path.exists(os.path.join(data_dir, "run.request"))}


def live(data_dir: str = DATA_DIR, now: float | None = None) -> dict[str, Any] | None:
    """Реальная торговля (служба whale-autotrade, WhaleScanner/tools/autotrade_live.py):
    её состояние и закрытые сделки — из каталога модуля. Ключей там нет.
    Службы нет (не ставили) — None."""
    d = os.path.join(data_dir, "live")
    try:
        with open(os.path.join(d, "state.json"), encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(st, dict):
        return None
    trades: list[dict[str, Any]] = []
    try:
        with open(os.path.join(d, "trades.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    t = json.loads(line)
                except ValueError:
                    continue
                if isinstance(t, dict) and isinstance(t.get("pnl"), (int, float)):
                    trades.append(t)
    except OSError:
        pass
    pnl = [float(t["pnl"]) for t in trades]
    wins, losses = [x for x in pnl if x > 0], [x for x in pnl if x <= 0]
    eq = peak = dd = 0.0
    curve = []
    for t in sorted(trades, key=lambda x: x.get("closed", 0)):
        eq += float(t["pnl"])
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
        curve.append([int(t.get("closed", 0)), round(eq, 2)])
    first = min((int(t.get("opened", 0)) for t in trades), default=0)
    now_ms = int((now if now is not None else time.time()) * 1000)
    days = max(1.0, (now_ms - first) / 86_400_000) if first else 1.0
    beat = int(st.get("heartbeat") or 0)
    return {
        "alive": bool(beat) and now_ms - beat < 120_000, "heartbeat": beat, "simulated": bool(st.get("simulated")),
        "error": str(st.get("error") or ""), "equity": st.get("equity"), "open": st.get("open"),
        "positions": st.get("positions") or [], "last_skip": st.get("last_skip"), "rules": st.get("rules"),
        "events": (st.get("events") or [])[-20:],
        "stats": {"trades": len(pnl), "wins": len(wins), "win_pct": round(100 * len(wins) / len(pnl), 1) if pnl else 0.0,
                  "net": round(sum(pnl), 2), "avg_win": round(sum(wins) / len(wins), 2) if wins else 0.0,
                  "avg_loss": round(sum(losses) / len(losses), 2) if losses else 0.0,
                  "pf": round(sum(wins) / -sum(losses), 3) if losses and sum(losses) < 0 else None,
                  "max_dd": round(dd, 2), "per_day": round(len(pnl) / days, 2) if pnl else 0.0,
                  "fees": round(sum(float(t.get("fee") or 0) for t in trades), 2),
                  "funding": round(sum(float(t.get("funding") or 0) for t in trades), 2)},
        "equity_curve": curve[-500:],
        "trades": sorted(trades, key=lambda x: x.get("closed", 0))[-50:],
    }


def status(data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Ответ вкладке владельца: реальная торговля, итог бэктеста и ход пересчёта."""
    lv = live(data_dir)
    bs = backtest_status(data_dir)
    return {"ok": True, "stage": "live" if lv is not None else "backtest", "on": is_on(data_dir),
            "backtest": latest(data_dir), "running": bs["running"] or bs["requested"],
            "started": bs["started"], "finished": bs["finished"], "error": bs["error"], "next": bs["next"],
            "paper": None, "live": lv}


def trigger(_ws_dir: str = "", _hl_db: str = "", data_dir: str = DATA_DIR) -> dict[str, Any]:
    """«Пересчитать сейчас»: запрос службе whale-autotrade (она подхватит за
    секунды). Модуль выключен — отказ; уже идёт — «уже считается»."""
    if not is_on(data_dir):
        return {"ok": False, "error": "stopped"}
    if backtest_status(data_dir)["running"]:
        return {"ok": True, "running": True, "started": False}
    try:
        _request_run(data_dir)
    except OSError as e:
        print(f"[AUTO] пересчёт: не записать запрос в {data_dir}: {e.strerror or e}", flush=True)
        return {"ok": False, "error": "no_write"}
    print("[AUTO] пересчёт — запрос службе whale-autotrade (владелец)", flush=True)
    return {"ok": True, "running": True, "started": True}


def start_cmd(_ws_dir: str = "", _hl_db: str = "", data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Кнопка «Старт»: включить (служба начинает входить в сделки); итога
    бэктеста ещё нет — заодно запросить пересчёт."""
    why = _try_set(True, data_dir)
    if why:
        return why
    print("[AUTO] старт (владелец)", flush=True)
    if latest(data_dir) is None:
        trigger(data_dir=data_dir)
    return status(data_dir)


def stop_cmd(data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Кнопка «Стоп»: выключить — служба перестаёт входить в сделки и
    прерывает идущий пересчёт; открытая позиция и её тейк остаются."""
    why = _try_set(False, data_dir)
    if why:
        return why
    print("[AUTO] стоп (владелец)", flush=True)
    return status(data_dir)
