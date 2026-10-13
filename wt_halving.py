"""Отсчёт до халвинга биткоина — отдельный модуль API (/api/halving).

Высота и время последнего блока — mempool.space (/api/v1/blocks, без ключа);
запасной путь — blockstream.info и blockchain.info (тогда время блока не
знаем и берём текущее). Халвинг каждые 210 000 блоков.

Скорость блоков — СРЕДНЕЕ ЗА ВСЮ ЭПОХУ (от прошлого халвинга до последнего
блока), а не за текущий период сложности: тот длится две недели и гуляет от
9,3 до 10,5 минуты, а до халвинга полтора года — растянутое на 78 тысяч
блоков, такое среднее сдвигало дату на недели и прыгало после каждой
перенастройки сложности. Время блока, с которого началась эпоха, не
меняется: спрашиваем один раз, для 840 000 оно и так известно. В первые две
недели эпохи (меньше 2016 блоков) — среднее за период сложности, иначе 600 с.

Дата халвинга (eta) считается от времени последнего блока, а не от момента
запроса — блок мог выйти и десять минут назад.

Как у страха и жадности: устаревший ответ отдаётся сразу, свежий собирается
в фоне одним потоком — запрос не ждёт mempool по 8 секунд на адрес, а сто
человек, открывших меню в одну минуту, не делают сто одинаковых запросов.
Если все источники молчат, минуту источники не трогаем.

Модуль ни от чего в whale_api не зависит: сеть — через _fetch (тесты
подменяют только её), часы — через _now.
"""
from __future__ import annotations

import http.client
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request

EVERY = 210_000
TTL = 300.0
# Все источники молчат — минуту отвечаем «нет данных», не пытаясь снова:
# иначе каждое открытие меню ждало бы четыре таймаута.
ERR_TTL = 60.0
# Время блока каждого прошлого халвинга, уже известное (дальше — из сети).
START_TS = {840_000: 1713571767}

_UA = {"User-Agent": "wallet-tracker/1.0"}
_lock = threading.Lock()
_cold = threading.Lock()
_cache: dict = {}
_busy = False


def _now() -> int:
    return int(time.time())


def _fetch(url: str, limit: int = 1 << 20) -> bytes | None:
    """GET; ответ не больше limit байт. Любая ошибка сети — None."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=8) as r:
            return r.read(limit)
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        return None


def _json(url: str):
    raw = _fetch(url)
    try:
        return json.loads(raw.decode()) if raw else None
    except ValueError:
        return None


def _int(url: str) -> int:
    raw = _fetch(url, 64)
    try:
        return int(raw.decode().strip()) if raw else 0
    except ValueError:
        return 0


def _start_ts(h: int) -> int:
    """Время блока h (начала эпохи); 0 — не узнали."""
    ts = START_TS.get(h)
    if ts:
        return ts
    raw = _fetch(f"https://mempool.space/api/block-height/{h}", 200)
    bh = raw.decode(errors="replace").strip() if raw else ""
    # В адрес следующего запроса идёт только настоящий хеш блока.
    if not re.fullmatch(r"[0-9a-f]{64}", bh):
        return 0
    blk = _json(f"https://mempool.space/api/block/{bh}")
    try:
        ts = int(blk.get("timestamp") or 0) if isinstance(blk, dict) else 0
    except (TypeError, ValueError):
        ts = 0
    if ts > 1_700_000_000:
        START_TS[h] = ts
    return ts


def _tip() -> tuple[int, int]:
    """Высота и время последнего блока; время 0 — не знаем."""
    blocks = _json("https://mempool.space/api/v1/blocks")
    if isinstance(blocks, list) and blocks and isinstance(blocks[0], dict):
        try:
            h = int(blocks[0].get("height") or 0)
            if h > 800_000:
                return h, int(blocks[0].get("timestamp") or 0)
        except (TypeError, ValueError):
            pass
    for url in ("https://mempool.space/api/blocks/tip/height", "https://blockstream.info/api/blocks/tip/height",
                "https://blockchain.info/q/getblockcount"):
        h = _int(url)
        if h > 800_000:
            return h, 0
    return 0, 0


def build() -> dict:
    """Собрать ответ из сети и положить в кэш."""
    with _lock:
        hit = _cache.get("all")
    height, tip_ts = _tip()
    if not height:
        print("halving: нет высоты блока ни от одного источника", file=sys.stderr)
        with _lock:
            _cache["err"] = time.monotonic()
        return hit[1] if hit else {"ok": False, "error": "no_data"}
    t_now = _now()
    # Время блока из будущего или старше суток — не верим, считаем от «сейчас».
    if not (t_now - 86400 < tip_ts <= t_now + 7200):
        tip_ts = t_now
    start = height // EVERY * EVERY
    nxt = start + EVERY
    avg, src = 600.0, "nominal"
    start_ts = _start_ts(start)
    # Среднее за эпоху — когда в ней уже хотя бы один период сложности.
    if start_ts and height - start >= 2016 and tip_ts > start_ts:
        t = (tip_ts - start_ts) / (height - start)
        if 480 <= t <= 720:
            avg, src = t, "epoch"
    if src == "nominal":
        adj = _json("https://mempool.space/api/v1/difficulty-adjustment")
        try:
            t = float(adj.get("timeAvg") or 0) / 1000 if isinstance(adj, dict) else 0.0
        except (TypeError, ValueError):
            t = 0.0
        if 480 <= t <= 720:
            avg, src = t, "period"
    res = {"ok": True, "height": height, "next": nxt, "every": EVERY, "avg": round(avg, 1), "src": src,
           "tip": tip_ts, "eta": int(tip_ts + (nxt - height) * avg), "at": t_now}
    if start_ts:
        res["prev"] = start_ts  # время блока прошлого халвинга
    with _lock:
        _cache["all"] = (time.monotonic(), res)
    return res


def _bg() -> None:
    global _busy
    try:
        build()
    except Exception as e:  # noqa: BLE001 — фоновый поток не должен умирать молча
        print(f"halving: {e}", file=sys.stderr)
    finally:
        with _lock:
            _busy = False


def halving_data() -> dict:
    """Ответ /api/halving: из кэша, свежий собирается в фоне."""
    global _busy
    with _lock:
        hit = _cache.get("all")
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        failed = time.monotonic() - _cache.get("err", -1e9) < ERR_TTL
        # Источники только что молчали — не дёргаем их снова сразу: иначе при
        # сбое mempool фоновые сборки шли бы одна за другой без перерыва.
        if hit and not failed and not _busy:
            _busy = True
            threading.Thread(target=_bg, daemon=True).start()
        if hit:
            return hit[1]
        if failed:
            return {"ok": False, "error": "no_data"}
    # Холодный старт: первый собирает, остальные ждут его и берут готовое.
    with _cold:
        with _lock:
            hit = _cache.get("all")
            failed = time.monotonic() - _cache.get("err", -1e9) < ERR_TTL
        if hit:
            return hit[1]
        if failed:
            return {"ok": False, "error": "no_data"}
        return build()


def reply() -> dict:
    """Ответ для HTTP: now — время ответа (at — время сборки, оно до пяти
    минут старше); по нему приложение поправляет часы телефона."""
    return {**halving_data(), "now": _now()}
