"""Отсчёт до халвинга биткоина — отдельный модуль API (/api/halving).

Высота и время последнего блока — mempool.space (хеш последнего блока и
сам блок, без ключа: полкилобайта, а не 30 КБ списка из 15 блоков);
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
  - сертификат и имя сервера проверяются, TLS не старше 1.2; соединение
    напрямую — прокси из переменных окружения не берётся; ответ без сжатия
    (нет «zip-бомб»);
  - ответ — не больше заданного размера и не дольше своего срока целиком
    (источник, цедящий по байту, не держит поток часами);
  - разбор — без бесконечностей, NaN, чисел из тысяч цифр и сверхглубокой
    вложенности: всё это раньше роняло сборку (OverflowError,
    RecursionError) или жгло процессор и превращало каждый запрос в попытку;
  - любой сбой сборки — сбой источника: минута паузы, а не повтор на каждый
    запрос;
  - в журнал — без управляющих символов и не длиннее строки: текст ошибки
    от источника не подделает записи журнала;
  - от источника наружу не уходит ни одного символа текста: в ответе только
    проверенные числа и наши же строки («epoch», «no_data»…) — подсунуть
    человеку ссылку, скрипт или инструкцию для ИИ-агента нечем.

Снаружи модуль ничего не принимает: у /api/halving нет параметров, ответ
один на всех из кэша, сеть — не чаще раза в 5 минут, сколько бы ни было
запросов. Какой код в модуле допустим (импорты, адреса, ни eval, ни файлов,
ни процессов), проверяет tests/test_halving_policy.py.

Модуль ни от чего в whale_api не зависит: сеть — через _fetch (тесты
подменяют только её), часы — через _now.
"""
from __future__ import annotations

import contextlib
import http.client
import json
import math
import re
import socket
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
# лишь с Python 3.11, а модуль работает и на 3.10 (CI проверяет 3.10–3.13).
# Аннотации здесь — строки (from __future__ import annotations), при запуске
# их никто не читает.
if TYPE_CHECKING:  # pragma: no cover — только для mypy, при запуске не выполняется
    from collections.abc import Callable
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
# Все источники молчат — минуту отвечаем «нет данных» (или последним
# хорошим ответом), не пытаясь снова: иначе каждое открытие меню ждало бы
# сборку до BUDGET секунд.
ERR_TTL = 60.0
# Бюджет одной сборки и предел на один запрос, секунды. Меньше MIN_LEFT
# от бюджета — в сеть уже не идём: не хватит и на соединение.
BUDGET = 20.0
HOP = 6.0
MIN_LEFT = 0.2
# Время блока каждого прошлого халвинга, уже известное (дальше — из сети).
START_TS = {840_000: 1713571767}

# Заголовки запроса. identity — без сжатия: «бомба» в 1 МБ сжатого не
# развернётся в гигабайты.
_HEADERS = {"User-Agent": "wallet-tracker/1.0", "Accept-Encoding": "identity"}
# Куда модулю можно ходить — и больше никуда.
HOSTS = frozenset({"mempool.space", "blockstream.info", "blockchain.info"})
SCHEMES = frozenset({"https"})
# Самая длинная строка в журнале от модуля.
LOG_MAX = 300
# Ответ читается кусками по CHUNK байт. Целое в JSON — не длиннее INT_MAX
# цифр: разбор числа из миллиона цифр — секунды процессора (CVE-2020-10735).
CHUNK = 16_384
INT_MAX = 20
# Самый большой ответ-JSON, который модуль читает: блок — ~0,5 КБ, данные о
# сложности — ~0,3 КБ. Больше — не тот ответ.
JSON_MAX = 4096
# Сколько причин сбоя запросов помнит одна сборка (в сборке их до пяти).
WHY_MAX = 8
# Соединение с одним адресом источника — не дольше, с. У mempool.space
# восемь адресов, и часть может молчать с сервера: стандартный urllib ждал
# первый весь HOP и сдавался. curl в этом случае сразу идёт к следующему —
# так теперь и здесь (за HOP успевают минимум два адреса).
CONNECT = 2.5
ADDRS_MAX = 8


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Перенаправление не выполняется: 3xx — это ошибка, а не новый адрес."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


# Своя «открывалка»: напрямую (прокси из переменных окружения не берётся —
# подменённый HTTPS_PROXY не уведёт запросы), без перенаправлений, сертификат
# и имя сервера проверяются, TLS не старше 1.2 (так с Python 3.10 по
# умолчанию; tests/test_halving_policy.py следит, чтобы так и осталось).
# Тип сокета для подписей: проверка «в сеть — одна дверь» (test_halving_policy)
# ищет socket.socket внутри функций.
_Sock = socket.socket


def _connect(address: tuple[str, int], timeout: object = None, source_address: object = None) -> socket.socket:
    """Соединение с источником: адреса по очереди (IPv4 первыми), каждый не
    дольше CONNECT; молчащий адрес не съедает весь запрос. Только HOSTS:
    сюда приходит хост уже проверенного адреса (_fetch, без перенаправлений),
    но лишняя проверка дешевле ошибки."""
    host, port = address
    if host not in HOSTS:
        raise OSError(f"чужой хост: {host}")
    limit = timeout if isinstance(timeout, (int, float)) else HOP
    end = time.monotonic() + limit
    # DNS — в своём потоке: у getaddrinfo нет тайм-аута, а ждать его дольше
    # срока запроса незачем. Не успел — поток доживёт сам, ответ выбросим.
    box: list[object] = []
    dns = threading.Thread(target=_call, args=(box, socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM),
                           daemon=True)
    dns.start()
    dns.join(max(0.0, end - time.monotonic()))
    if not box:
        raise OSError(f"DNS {host}: не ответил за {limit:.0f} с")
    if isinstance(box[0], BaseException):
        raise box[0]
    infos = list(box[0])  # type: ignore[call-overload]
    infos.sort(key=lambda a: a[0] != socket.AF_INET)
    err: OSError = OSError(f"нет адреса: {host}")
    for family, kind, proto, _name, addr in infos[:ADDRS_MAX]:
        left = end - time.monotonic()
        if left <= MIN_LEFT:
            break
        sock = socket.socket(family, kind, proto)
        try:
            sock.settimeout(min(CONNECT, left))
            sock.connect(addr)
        except OSError as e:
            sock.close()
            err = e
            continue
        sock.settimeout(limit)
        _watch(sock, end)
        return sock
    raise err


def _call(box: list[object], fn: Callable[..., object], *args: object) -> None:
    """fn(*args) в чужом потоке: в box — результат или исключение."""
    try:
        box.append(fn(*args))
    except Exception as e:  # noqa: BLE001 — исключение передаётся вызывающему как есть
        box.append(e)


def _cut(watch: _Sock) -> None:
    with contextlib.suppress(OSError):
        watch.shutdown(socket.SHUT_RDWR)


def _watch(sock: _Sock, end: float) -> None:
    """Срок на всё соединение целиком — TLS, заголовки, тело.

    Тайм-аут сокета — на каждый кусок: источник, цедящий заголовки по байту
    раз в пять секунд, держал бы поток сколько угодно. В срок соединение
    обрывается (shutdown будит и того, кто ждёт в recv). Обрывается копия
    дескриптора: сам сокет TLS забирает себе и закрывает, и его номер может
    достаться чужому соединению; копию закрывает только _fetch."""
    cuts = getattr(_dl, "cuts", None)
    if cuts is None:  # не из _fetch — сроком управляет вызывающий
        return
    watch = sock.dup()
    timer = threading.Timer(max(0.0, end - time.monotonic()), _cut, (watch,))
    timer.daemon = True
    timer.start()
    cuts.append((timer, watch))


class _Conn(http.client.HTTPSConnection):
    """HTTPS-соединение через _connect (вместо socket.create_connection)."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self._create_connection = _connect


class _ConnPlain(http.client.HTTPConnection):
    """То же для http: в бою его нет (SCHEMES — только https), а тесты на
    локальном сервере ходят через тот же _connect, что и бой."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self._create_connection = _connect


class _Http(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_ConnPlain, req)


class _Https(urllib.request.HTTPSHandler):
    """HTTPS со своим соединением; сертификат проверяется как обычно."""

    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_Conn, req, context=self._context)  # type: ignore[attr-defined]


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect, _Http(),
                                      _Https(context=ssl.create_default_context()))


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
    # Журнал закрыт или сломан — работа модуля важнее записи о ней.
    with contextlib.suppress(OSError, ValueError):
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


def _why(msg: str) -> None:
    """Причина неудачного запроса — в список сборки: в журнал она идёт одной
    строкой, только если высоту не дал ни один источник (по «нет высоты»
    без причины не понять, что чинить; каждый сбой отдельно засорял бы
    журнал — сборка идёт раз в пять минут, запросов в ней до пяти)."""
    why = getattr(_dl, "why", None)
    if why is not None and len(why) < WHY_MAX:
        why.append(msg)


def _fetch(url: str, limit: int = 1 << 20) -> bytes | None:
    """GET. Любая ошибка сети и ответ больше limit байт — None (обрезанный
    ответ — не ответ), причина — в _why. Внутри сборки — не дольше, чем
    осталось от бюджета."""
    if not _allowed(url):
        return None
    host = urllib.parse.urlsplit(url).hostname
    dl = getattr(_dl, "at", 0.0)
    left = dl - time.monotonic() if dl else HOP
    if left <= MIN_LEFT:
        return None
    hop = min(HOP, left)
    end = time.monotonic() + hop
    # Срок — на весь запрос: DNS и соединение ждёт _connect, а TLS, заголовки
    # и тело обрывает в end сторож _watch (его копии сокетов — в _dl.cuts).
    _dl.cuts = []
    try:
        with _opener.open(urllib.request.Request(url, headers=_HEADERS), timeout=hop) as r:
            # По кускам: тело больше limit — не ответ. Срок за чтением следит
            # _watch: источник, цедящий по байту, обрывается в end.
            buf = bytearray()
            while len(buf) <= limit:
                chunk: bytes = r.read1(min(CHUNK, limit + 1 - len(buf)))
                if not chunk:
                    # Конец ответа — или его в срок оборвал _watch: обрезанный
                    # ответ — не ответ.
                    if time.monotonic() < end:
                        return bytes(buf)
                    break
                buf += chunk
            _why(f"{host}: ответ больше {limit} байт" if len(buf) > limit else f"{host}: не уложился в {hop:.0f} с")
            return None
    except (OSError, ValueError, http.client.HTTPException) as e:  # URLError и таймаут — тоже OSError
        _why(f"{host}: {type(e).__name__}: {e}")
        return None
    finally:
        for timer, watch in _dl.cuts:
            timer.cancel()
            watch.close()
        _dl.cuts = None


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


# Один разборщик на всё время работы, а не новый на каждый ответ (так делает
# json.loads с параметрами): вдвое быстрее и без лишней памяти.
_DECODER = json.JSONDecoder(parse_float=_finite, parse_int=_short_int,
                            parse_constant=_no_constant)


def _json(url: str) -> object:
    raw = _fetch(url, JSON_MAX)
    try:
        return _DECODER.decode(raw.decode()) if raw else None
    except (ValueError, RecursionError):  # RecursionError — сверхглубокая вложенность
        return None


def _whole(v: object) -> int:
    """Целое из разобранного JSON; 0 — не целое. Высота и время блока у
    источников всегда целые: строка, дробь, True — сбой источника."""
    return v if type(v) is int else 0


def _real(v: object) -> float:
    """Число из разобранного JSON, целое или дробное; 0.0 — не число."""
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def _int(url: str) -> int:
    """Число из ответа-строки; 0 — не число. Только ASCII-цифры: int() принял
    бы и «1_050_100», и «+1», и цифры других письменностей."""
    raw = (_fetch(url, 64) or b"").strip()
    return int(raw) if re.fullmatch(rb"[0-9]{1,20}", raw) else 0


def _block(url: str) -> dict[str, object] | None:
    """Блок по адресу, который отвечает его хешем; None — не узнали."""
    raw = _fetch(url, 200)
    bh = raw.decode(errors="replace").strip() if raw else ""
    # В адрес следующего запроса идёт только настоящий хеш блока.
    if not re.fullmatch(r"[0-9a-f]{64}", bh):
        return None
    blk = _json(f"https://mempool.space/api/block/{bh}")
    return blk if isinstance(blk, dict) else None


def _start_ts(h: int) -> int:
    """Время блока h (начала эпохи); 0 — не узнали."""
    ts = START_TS.get(h)
    if ts:
        return ts
    blk = _block(f"https://mempool.space/api/block-height/{h}")
    # Тот ли это блок: время чужого запомнилось бы до перезапуска API.
    ts = _whole(blk.get("timestamp")) if blk and _whole(blk.get("height")) == h else 0
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
    blk = _block("https://mempool.space/api/blocks/tip/hash")
    if blk:
        h = _whole(blk.get("height"))
        if _plausible(h):
            return h, _whole(blk.get("timestamp"))
    # Запасные — другие источники, а не другой адрес того же mempool: завис
    # mempool — второй запрос к нему съел бы ещё HOP секунд из бюджета.
    for url in ("https://blockstream.info/api/blocks/tip/height", "https://blockchain.info/q/getblockcount"):
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
    _dl.why = []
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
        _dl.why = None


def _build() -> Reply:
    with _lock:
        hit = _st.hit
    height, tip_ts = _tip()
    if not height:
        why = getattr(_dl, "why", None) or ["ответы неправдоподобны"]
        _log("нет высоты блока ни от одного источника: " + "; ".join(why))
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
        t = _real(adj.get("timeAvg")) / 1000 if isinstance(adj, dict) else 0.0
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
        build()  # сама не падает: любой сбой — минута паузы (см. build)
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
