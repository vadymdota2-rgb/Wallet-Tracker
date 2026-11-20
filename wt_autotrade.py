# © 2026 Wallet Tracker. Все права защищены — см. LICENSE.
"""Автокопирование китов — закрытый модуль владельца (сторона API).

Только для владельца бота (OWNER_CHAT_ID). Никто другой о модуле не узнаёт:
маршрут отвечает чужим тем же 404, что и несуществующий адрес, приложение
показывает вкладку только владельцу, а проверка — на сервере по подписи
Telegram, а не скрытием кнопки.

Что делает сейчас (этап 1 — бэктест):
- раз в сутки (ночью по UTC) запускает бэктест бота
  (``<WhaleScanner>/tools/autotrade_backtest.py``) отдельным процессом;
  база Hyperliquid бота — только чтение (это обеспечивает сам бэктест:
  ``mode=ro``), свечи — с паузой 15 с между запросами, чтобы не съесть
  лимит Hyperliquid у бота; кеш свечей копится между запусками;
- итог (``summary.json``) кладёт в свой каталог — вне каталога бота;
- отдаёт его владельцу (вкладка «Автоторговля» в приложении).

Бумажная и реальная торговля (этапы 2–3) — только после «да» владельца по
отчёту бэктеста; их статистика появится здесь же.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

# Где лежит итог и кеш. Не в каталоге бота: бэктест туда писать отказывается.
DATA_DIR = os.path.abspath(os.path.expanduser(
    os.environ.get("WT_AUTOTRADE_DIR") or "~/.local/share/whale-autotrade"))
RUN_HOUR_UTC = 3
RUN_MINUTE = 17
PAUSE_SEC = 15          # между запросами к Hyperliquid
RUN_TIMEOUT_SEC = 6 * 3600
FIRST_RUN_DELAY_SEC = 15 * 60  # итога ещё нет — первый прогон вскоре после запуска API

_lock = threading.Lock()
_state: dict[str, Any] = {"running": False, "started": 0, "finished": 0, "error": "", "next": 0}


def script_path(ws_dir: str) -> str:
    return os.path.join(ws_dir, "tools", "autotrade_backtest.py")


def latest(data_dir: str = DATA_DIR) -> dict[str, Any] | None:
    """Последний итог бэктеста; нет или испорчен — None."""
    try:
        with open(os.path.join(data_dir, "latest", "summary.json"), encoding="utf-8") as f:
            got = json.load(f)
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) else None


def run_once(ws_dir: str, hl_db: str, data_dir: str = DATA_DIR,
             runner: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run) -> bool:
    """Один прогон: в новый каталог, удачный — становится latest (прежний —
    prev). Второй прогон, пока идёт первый, не начинается."""
    with _lock:
        if _state["running"]:
            return False
        _state.update(running=True, started=int(time.time()), error="")
    out = os.path.join(data_dir, "run")
    ok = False
    try:
        script = script_path(ws_dir)
        if not os.path.isfile(script):
            raise RuntimeError("нет скрипта бэктеста в каталоге бота")
        if not os.path.isfile(hl_db):
            raise RuntimeError("нет базы Hyperliquid бота")
        os.makedirs(data_dir, exist_ok=True)
        shutil.rmtree(out, ignore_errors=True)
        with open(os.path.join(data_dir, "last_run.log"), "w", encoding="utf-8") as log:
            r = runner([sys.executable, "-I", script, "--db", hl_db, "--out", out,
                        "--cache", os.path.join(data_dir, "cache"), "--pause", str(PAUSE_SEC)],
                       stdout=log, stderr=subprocess.STDOUT, timeout=RUN_TIMEOUT_SEC, check=False)
        if r.returncode != 0 or not os.path.isfile(os.path.join(out, "summary.json")):
            raise RuntimeError(f"бэктест завершился с кодом {r.returncode} (last_run.log)")
        prev, cur = os.path.join(data_dir, "prev"), os.path.join(data_dir, "latest")
        shutil.rmtree(prev, ignore_errors=True)
        if os.path.isdir(cur):
            os.replace(cur, prev)
        os.replace(out, cur)
        ok = True
    except (OSError, RuntimeError, subprocess.SubprocessError) as e:
        print(f"[AUTO] бэктест: {e}", flush=True)
        with _lock:
            _state["error"] = str(e)[:300]
    finally:
        with _lock:
            _state.update(running=False, finished=int(time.time()))
    return ok


def next_run(now: float) -> int:
    """Ближайшие RUN_HOUR_UTC:RUN_MINUTE по UTC после now."""
    day = int(now) // 86400 * 86400
    at = day + RUN_HOUR_UTC * 3600 + RUN_MINUTE * 60
    return at if at > now else at + 86400


def refresher(ws_dir: str, hl_db: str, data_dir: str = DATA_DIR) -> None:
    """Поток API: прогон раз в сутки; итога нет вовсе — вскоре после запуска."""
    first = time.time() + FIRST_RUN_DELAY_SEC if latest(data_dir) is None else 0.0
    while True:
        at = first or next_run(time.time())
        first = 0.0
        with _lock:
            _state["next"] = int(at)
        time.sleep(max(1.0, at - time.time()))
        run_once(ws_dir, hl_db, data_dir)


def start(ws_dir: str, hl_db: str) -> None:
    threading.Thread(target=refresher, args=(ws_dir, hl_db), daemon=True, name="autotrade").start()


def status(data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Ответ вкладке владельца: итог бэктеста и состояние прогона."""
    with _lock:
        st = dict(_state)
    return {"ok": True, "stage": "backtest", "backtest": latest(data_dir), "running": st["running"],
            "started": st["started"], "finished": st["finished"], "error": st["error"], "next": st["next"],
            "paper": None, "live": None}


def trigger(ws_dir: str, hl_db: str, data_dir: str = DATA_DIR) -> dict[str, Any]:
    """«Пересчитать сейчас» из вкладки: прогон в фоне, если не идёт."""
    with _lock:
        if _state["running"]:
            return {"ok": True, "running": True, "started": False}
    threading.Thread(target=run_once, args=(ws_dir, hl_db, data_dir), daemon=True, name="autotrade-now").start()
    return {"ok": True, "running": True, "started": True}
