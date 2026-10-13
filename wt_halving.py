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
в фоне одним потоком — запрос не ждёт источники, а сто
человек, открывших меню в одну минуту, не делают сто одинаковых запросов.
Если все источники молчат, минуту источники не трогаем.

У сборки общий бюджет времени BUDGET: источники зависли — сборка
заканчивается за 20 секунд, а не за сумму таймаутов всех адресов (раньше
это было до минуты — дольше, чем ждёт nginx).

Защита от атак через источник (взломан mempool или подменён ответ):
  - запросы — только https и только к трём известным адресам; перенаправления
    не выполняются: взломанный источник не отправит сервер ни на внутренние
    адреса машины (SSRF), ни на чужие;
  - сертификат проверяется (обычный контекст ssl);
  - ответ — не больше заданного размера и не дольше своего срока целиком
    (источник, цедящий по байту, не держит поток часами);
  - разбор — без бесконечностей, NaN, чисел из тысяч цифр и сверхглубокой
    вложенности: всё это раньше роняло сборку (OverflowError,
    RecursionError) или жгло процессор и превращало каждый запрос в попытку;
  - любой сбой сборки — сбой источника: минута паузы, а не повтор на каждый
    запрос;
  - в журнал — без управляющих символов и не длиннее строки: текст ошибки
    от источника не подделает записи журнала.

Модуль ни от чего в whale_api не зависит: сеть — через _fetch (тесты
подменяют только её), часы — через _now.
"""
from __future__ import annotations

import http.client
import json
import math
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import TYPE_CHECKING, TypedDict

# Literal и NotRequired нужны только проверке типов (mypy): NotRequired есть
# лишь с Python 3.11, а на сервере может стоять 3.8–3.10. Аннотации здесь —
# строки (from __future__ import annotations), при запуске их никто не читает.
if TYPE_CHECKING:  # pragma: no cover — только для mypy, при запуске не выполняется
    from typing import Literal, NotRequired

EVERY = 210_000
# Целевое время блока по правилам биткоина, с.
TARGET = 600.0
# Насколько блок по правилам сети может быть «из будущего» (2 часа), и
# старше какого последнего блока не бывает (сутки без блоков — сбой источника).
MAX_FUTURE, MAX_AGE = 7200, 86400
# Период сложности: столько блоков эпохи нужно, чтобы её среднему верить.
RETARGET = 2016
# Разумное среднее время блока, с: всё вне — сбой источника, а не сеть.
AVG_MIN, AVG_MAX = 480.0, 720.0
# Сеть прошла эту высоту ещё в 2023 году — меньше быть не может.
MIN_HEIGHT = 800_000
# Время генезис-блока. Выше, чем блок раз в 5 минут с него, высота быть не
# может (реальность — раз в ~10): источник, приславший 99 миллионов, врёт.
GENESIS_TS = 1231006505
FASTEST = 300
# Сколько ответ живёт в кэше, с (приложение держит столько же — HALVING_TTL_MS).
TTL = 300.0
# Все источники молчат — минуту отвечаем «нет данных», не пытаясь снова:
# иначе каждое открытие меню ждало бы четыре таймаута.
ERR_TTL = 60.0
# Бюджет одной сборки и предел на один запрос, секунды. Меньше MIN_LEFT
# от бюджета — в сеть уже не идём: не хватит и на соединение.
BUDGET = 20.0
HOP = 6.0
MIN_LEFT = 0.2
# Время блока каждого прошлого халвинга, уже известное (дальше — из сети).
START_TS = {840_000: 1713571767}

_UA = {"User-Agent": "wallet-tracker/1.0"}
# Куда модулю можно ходить — и больше никуда.
HOSTS = frozenset({"mempool.space", "blockstream.info", "blockchain.info"})
SCHEMES = frozenset({"https"})
# Самая длинная строка в журнале от модуля.
LOG_MAX = 300
# Ответ читается кусками по CHUNK байт. Целое в JSON — не длиннее INT_MAX
# цифр: разбор числа из миллиона цифр — секунды процессора (CVE-2020-10735).
CHUNK = 16_384
INT_MAX = 20


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Перенаправление не выполняется: 3xx — это ошибка, а не новый адрес."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


# Своя «открывалка»: без перенаправлений, сертификат проверяется.
_opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def _allowed(url: str) -> bool:
    """https и известный адрес — иначе в сеть не идём."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return u.scheme in SCHEMES and u.hostname in HOSTS and not u.username and not u.password


def _log(msg: str) -> None:
    """В журнал — одной строкой, без управляющих символов и не длиннее LOG_MAX."""
    clean = "".join(c if c.isprintable() else "?" for c in msg)
    print(f"halving: {clean[:LOG_MAX]}", file=sys.stderr)


class Reply(TypedDict):
    """Ответ /api/halving — тот же договор, что HalvingReply в
    src/lib/halving.ts и образец tests/fixtures/halving.json."""

    ok: bool
    error: NotRequired[str]
    height: NotRequired[int]
    next: NotRequired[int]
    every: NotRequired[int]
    avg: NotRequired[float]
    src: NotRequired[Literal["epoch", "period", "nominal"]]
    tip: NotRequired[int]
    eta: NotRequired[int]
    at: NotRequired[int]
    prev: NotRequired[int]
    now: NotRequired[int]


@dataclass
class _State:
    """Кэш модуля; меняется только под _lock."""

    hit: tuple[float, Reply] | None = None  # (monotonic, ответ)
    err_at: float = float("-inf")  # когда источники последний раз молчали (monotonic)


_st = _State()
_lock = threading.Lock()
_cold = threading.Lock()
_busy = threading.Event()  # идёт фоновая сборка
_dl = threading.local()  # срок текущей сборки (monotonic) — свой у каждого потока


def _no_data() -> Reply:
    return {"ok": False, "error": "no_data"}


def _failed() -> bool:
    """Источники молчали меньше ERR_TTL назад. Вызывать под _lock."""
    return time.monotonic() - _st.err_at < ERR_TTL


def _now() -> int:
    return int(time.time())


def _fetch(url: str, limit: int = 1 << 20) -> bytes | None:
    """GET; ответ не больше limit байт. Любая ошибка сети — None.
    Внутри сборки — не дольше, чем осталось от её бюджета."""
    if not _allowed(url):
        return None
    dl = getattr(_dl, "at", 0.0)
    left = dl - time.monotonic() if dl else HOP
    if left <= MIN_LEFT:
        return None
    hop = min(HOP, left)
    end = time.monotonic() + hop
    try:
        with _opener.open(urllib.request.Request(url, headers=_UA), timeout=hop) as r:
            # По кускам и со своим сроком: таймаут сокета — на каждый кусок,
            # и источник, цедящий по байту, держал бы поток часами.
            buf = bytearray()
            while len(buf) < limit:
                if time.monotonic() > end:
                    return None
                chunk: bytes = r.read1(min(CHUNK, limit - len(buf)))
                if not chunk:
                    break
                buf += chunk
            return bytes(buf)
    except (OSError, ValueError, http.client.HTTPException):  # URLError и таймаут — тоже OSError
        return None


def _finite(text: str) -> float:
    """Число из JSON — только конечное: 1e400 и Infinity не проходят."""
    v = float(text)
    if not math.isfinite(v):
        raise ValueError("не конечное число")
    return v


def _short_int(text: str) -> int:
    """Целое из JSON — не длиннее INT_MAX цифр."""
    if len(text) > INT_MAX:
        raise ValueError("слишком длинное число")
    return int(text)


def _no_constant(name: str) -> float:
    raise ValueError(f"{name} в JSON")


def _json(url: str) -> object:
    raw = _fetch(url)
    try:
        return json.loads(raw.decode(), parse_float=_finite, parse_int=_short_int,
                          parse_constant=_no_constant) if raw else None
    except (ValueError, RecursionError):  # RecursionError — сверхглубокая вложенность
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
    except (TypeError, ValueError, OverflowError):
        ts = 0
    # Запоминаем навсегда только правдоподобное: после 2023 года и не из
    # будущего. Иначе мусор от источника жил бы до перезапуска API и всю
    # эпоху отключал бы среднее по ней.
    if 1_700_000_000 < ts <= _now():
        START_TS[h] = ts
        return ts
    return 0


def _plausible(h: int) -> bool:
    """Высота в возможных пределах: не меньше уже пройденной и не больше,
    чем успело бы выйти при блоке раз в 5 минут с генезиса."""
    return MIN_HEIGHT < h <= (_now() - GENESIS_TS) // FASTEST


def _tip() -> tuple[int, int]:
    """Высота и время последнего блока; время 0 — не знаем."""
    blocks = _json("https://mempool.space/api/v1/blocks")
    if isinstance(blocks, list) and blocks and isinstance(blocks[0], dict):
        try:
            h = int(blocks[0].get("height") or 0)
            if _plausible(h):
                return h, int(blocks[0].get("timestamp") or 0)
        except (TypeError, ValueError, OverflowError):
            pass
    for url in ("https://mempool.space/api/blocks/tip/height", "https://blockstream.info/api/blocks/tip/height",
                "https://blockchain.info/q/getblockcount"):
        h = _int(url)
        if _plausible(h):
            return h, 0
    return 0, 0


def build() -> Reply:
    """Собрать ответ из сети и положить в кэш — не дольше BUDGET секунд.

    Любая непредвиденная ошибка — сбой источника: минута паузы, как когда
    источники молчат. Иначе ответ, который роняет разбор, превращал бы
    каждый запрос в новую попытку — и в нагрузку на сервер."""
    _dl.at = time.monotonic() + BUDGET
    try:
        return _build()
    except Exception as e:  # noqa: BLE001 — граница модуля: наружу ошибка не выходит
        _log(f"сборка: {type(e).__name__}: {e}")
        with _lock:
            _st.err_at = time.monotonic()
            hit = _st.hit
        return hit[1] if hit else _no_data()
    finally:
        _dl.at = 0.0


def _build() -> Reply:
    with _lock:
        hit = _st.hit
    height, tip_ts = _tip()
    if not height:
        _log("нет высоты блока ни от одного источника")
        with _lock:
            _st.err_at = time.monotonic()
        return hit[1] if hit else _no_data()
    t_now = _now()
    # Время блока из будущего или старше суток — не верим, считаем от «сейчас».
    if not (t_now - MAX_AGE < tip_ts <= t_now + MAX_FUTURE):
        tip_ts = t_now
    start = height // EVERY * EVERY
    nxt = start + EVERY
    avg = TARGET
    src: Literal["epoch", "period", "nominal"] = "nominal"
    start_ts = _start_ts(start)
    # Среднее за эпоху — когда в ней уже хотя бы один период сложности.
    if start_ts and height - start >= RETARGET and tip_ts > start_ts:
        t = (tip_ts - start_ts) / (height - start)
        if AVG_MIN <= t <= AVG_MAX:
            avg, src = t, "epoch"
    if src == "nominal":
        adj = _json("https://mempool.space/api/v1/difficulty-adjustment")
        try:
            t = float(adj.get("timeAvg") or 0) / 1000 if isinstance(adj, dict) else 0.0
        except (TypeError, ValueError, OverflowError):
            t = 0.0
        if AVG_MIN <= t <= AVG_MAX:
            avg, src = t, "period"
    res: Reply = {"ok": True, "height": height, "next": nxt, "every": EVERY, "avg": round(avg, 1), "src": src,
           "tip": tip_ts, "eta": int(tip_ts + (nxt - height) * avg), "at": t_now}
    if start_ts:
        res["prev"] = start_ts  # время блока прошлого халвинга
    with _lock:
        _st.hit = (time.monotonic(), res)
    return res


def _bg() -> None:
    try:
        build()
    except Exception as e:  # noqa: BLE001 — фоновый поток не должен умирать молча
        _log(str(e))
    finally:
        _busy.clear()


def halving_data() -> Reply:
    """Ответ /api/halving: из кэша, свежий собирается в фоне."""
    with _lock:
        hit = _st.hit
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        failed = _failed()
        # Источники только что молчали — не дёргаем их снова сразу: иначе при
        # сбое mempool фоновые сборки шли бы одна за другой без перерыва.
        if hit and not failed and not _busy.is_set():
            _busy.set()
            try:
                threading.Thread(target=_bg, daemon=True).start()
            except RuntimeError as e:
                # Поток не запустился (кончились потоки) — флаг снимаем, иначе
                # «идёт сборка» висело бы вечно и ответ больше не обновлялся.
                _busy.clear()
                _log(f"фон не запущен: {e}")
        if hit:
            return hit[1]
        if failed:
            return _no_data()
    # Холодный старт: первый собирает, остальные ждут его и берут готовое.
    with _cold:
        with _lock:
            hit, failed = _st.hit, _failed()
        if hit:
            return hit[1]
        if failed:
            return _no_data()
        return build()


def reply() -> Reply:
    """Ответ для HTTP: now — время ответа (at — время сборки, оно до пяти
    минут старше); по нему приложение поправляет часы телефона."""
    return {**halving_data(), "now": _now()}
