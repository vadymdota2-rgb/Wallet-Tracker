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

Кнопки «Старт» и «Стоп» во вкладке: «Стоп» сразу прерывает идущий
пересчёт и выключает ночной, «Старт» включает. По умолчанию модуль
выключен и сам не включается; выбор владельца хранится в каталоге модуля
(switch.json) и переживает перезапуск API — включённым его оставил только
владелец. Позже те же кнопки включат бумажную, а затем реальную торговлю.

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
# По умолчанию — рядом с API (в git не попадает, .gitignore): служба
# whale-api видит домашний каталог только на чтение (ProtectHome=read-only),
# писать ей можно лишь в каталоги из ReadWritePaths — а каталог API из них.
DATA_DIR = os.path.abspath(os.path.expanduser(
    os.environ.get("WT_AUTOTRADE_DIR")
    or os.path.join(os.path.dirname(os.path.abspath(__file__)), "autotrade_data")))
RUN_HOUR_UTC = 3
RUN_MINUTE = 17
PAUSE_SEC = 15          # между запросами к Hyperliquid
RUN_TIMEOUT_SEC = 6 * 3600
# Предел памяти бэктеста. Бэктест — дочерний процесс API и живёт в её
# cgroup: у whale-api MemoryMax=1536M на всё вместе. Больше предела —
# бэктест останавливается сам (RLIMIT_AS, код 3), а не ядро убивает API.
MAX_MEM_MB = 1024
FIRST_RUN_DELAY_SEC = 15 * 60  # итога ещё нет — первый прогон вскоре после запуска API

_lock = threading.Lock()
_state: dict[str, Any] = {"running": False, "started": 0, "finished": 0, "error": "", "next": 0, "proc": None}


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


def _popen(cmd: list[str], *, stdout: Any, stderr: Any, timeout: float, check: bool) -> subprocess.CompletedProcess[Any]:
    """Как subprocess.run, но процесс виден кнопке «Стоп» (_state["proc"])."""
    del check
    # Низший приоритет процессора: бот и API отвечают людям первыми.
    p = subprocess.Popen(cmd, stdout=stdout, stderr=stderr,  # свой скрипт, аргументы списком — без оболочки
                         preexec_fn=lambda: os.nice(19))  # noqa: PLW1509 — только nice, без потоков и замков
    with _lock:
        _state["proc"] = p
    try:
        rc = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        raise
    finally:
        with _lock:
            _state["proc"] = None
    return subprocess.CompletedProcess(cmd, rc)


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
             runner: Callable[..., subprocess.CompletedProcess[Any]] = _popen) -> bool:
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
                        "--cache", os.path.join(data_dir, "cache"), "--pause", str(PAUSE_SEC),
                        "--max-mem-mb", str(MAX_MEM_MB)],
                       stdout=log, stderr=subprocess.STDOUT, timeout=RUN_TIMEOUT_SEC, check=False)
        if not is_on(data_dir):
            raise RuntimeError("остановлено кнопкой «Стоп»")
        if r.returncode == 3:
            raise RuntimeError(f"бэктесту не хватило предела памяти {MAX_MEM_MB} МБ — остановлен сам, сервер не тронут")
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
    """Поток API: прогон раз в сутки, пока модуль включён; итога нет вовсе —
    вскоре после запуска. Выключен — ночь пропускается."""
    first = time.time() + FIRST_RUN_DELAY_SEC if latest(data_dir) is None else 0.0
    while True:
        at = first or next_run(time.time())
        first = 0.0
        with _lock:
            _state["next"] = int(at)
        time.sleep(max(1.0, at - time.time()))
        if is_on(data_dir):
            run_once(ws_dir, hl_db, data_dir)


def start(ws_dir: str, hl_db: str) -> None:
    threading.Thread(target=refresher, args=(ws_dir, hl_db), daemon=True, name="autotrade").start()


def status(data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Ответ вкладке владельца: итог бэктеста и состояние прогона."""
    with _lock:
        st = dict(_state)
    return {"ok": True, "stage": "backtest", "on": is_on(data_dir), "backtest": latest(data_dir),
            "running": st["running"],
            "started": st["started"], "finished": st["finished"], "error": st["error"], "next": st["next"],
            "paper": None, "live": None}


def trigger(ws_dir: str, hl_db: str, data_dir: str = DATA_DIR) -> dict[str, Any]:
    """«Пересчитать сейчас» из вкладки: прогон в фоне, если включён и не идёт."""
    if not is_on(data_dir):
        return {"ok": False, "error": "stopped"}
    with _lock:
        if _state["running"]:
            return {"ok": True, "running": True, "started": False}
    threading.Thread(target=run_once, args=(ws_dir, hl_db, data_dir), daemon=True, name="autotrade-now").start()
    return {"ok": True, "running": True, "started": True}


def start_cmd(ws_dir: str, hl_db: str, data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Кнопка «Старт»: включить; итога ещё нет — сразу и пересчитать."""
    why = _try_set(True, data_dir)
    if why:
        return why
    print("[AUTO] старт (владелец)", flush=True)
    if latest(data_dir) is None:
        trigger(ws_dir, hl_db, data_dir)
    return status(data_dir)


def stop_cmd(data_dir: str = DATA_DIR) -> dict[str, Any]:
    """Кнопка «Стоп»: выключить и прервать идущий пересчёт."""
    why = _try_set(False, data_dir)
    if why:
        return why
    with _lock:
        proc = _state["proc"]
    if proc is not None:
        proc.terminate()
    print("[AUTO] стоп (владелец)" + (" — пересчёт прерван" if proc is not None else ""), flush=True)
    return status(data_dir)
