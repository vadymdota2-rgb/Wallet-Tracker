"""Индекс страха и жадности — отдельный модуль API (/api/fng).

Индекс — alternative.me (0 — паника, 100 — эйфория), все дни с 1 февраля
2018 года; цена биткоина в те же дни — mempool.space. Чужого кода и данных
в репозитории нет, только запросы к их открытым API.

Права (проверено в октябре 2026):
  - alternative.me разрешает и коммерческое использование, если источник
    указан прямо рядом с данными — так в приложении (ссылка под индексом), в
    дайджесте и на его картинке. Выдавать себя за них и делать сервис,
    который можно спутать с их сайтом, нельзя: экран — наш, со своими
    расчётами, с их именем только как источника. Их лимит — 60 запросов в
    минуту, у нас — один раз в TTL;
  - mempool.space: условия сайта (Terms of Service) не ограничивают, как
    использовать данные открытого API, — только «как есть, без гарантий»;
    лимиты запросов соблюдаем (полная история цен — раз в PX_TTL);
  - цен бирж здесь нет: условия Binance и Coinbase запрещают показывать их
    рыночные данные без письменного согласия (раньше цена шла от них).

Запасная цена — Hyperliquid: закрытия BTC по дням с августа 2020, которые
уже держит модуль «Альтсезона» (wt_dom.btc_closes, подключает whale_api
через set_backup). Ни одного лишнего запроса к Hyperliquid: только то, что
уже в памяти или на диске. Берётся в день, где у mempool.space цены нет, а
в прошлом ответе — тоже (mempool молчит или в его истории дыра); такой
день помечен F_HL, и экран называет источник.

Цена дня — закрытие: цена в 00:00 UTC следующих суток. У mempool.space
история с 2023 года по часам (цена точная), до середины 2022 — по неделям:
дни между недельными точками досчитываются по прямой в логарифме цены, и у
такого дня в ответе флаг F_EST — экран показывает их цену как «≈». Идущий
день — по текущей цене. Пропуск в истории индекса (4 дня в апреле 2018, 2 —
в октябре 2024) заполняется прошлым днём с флагом F_FILL: экран считает
«неделю назад» и «через 30 дней» по порядку дней.

Ответ: {"ok": true, "days": [[день, индекс, цена, флаги], ...], "at": время
сборки} — один на всех, поэтому whale_api отдаёт его готовыми байтами с ETag
(телефону с той же копией — «304 не изменилось»). Тот же договор — FngReply
в src/lib/fng.ts и образец tests/fixtures/fng.json (в нём ещё now — время
«сейчас» для тестов).

Как у халвинга: устаревший ответ отдаётся сразу, свежий собирается в фоне
одним потоком; все источники молчат — ERR_TTL источники не трогаем. После
перезапуска — копия ответа с диска (set_cache_dir), свежий — в фоне.

Защита от атак через источник — как у wt_halving: только https и только к
HOSTS, без перенаправлений и прокси из окружения, сертификат проверяется,
ответ без сжатия, ограничен по размеру и по времени целиком; разбор — без
NaN, бесконечностей, огромных целых и сверхглубокой вложенности; в журнал —
без управляющих символов. От источника наружу не уходит ни одного символа
текста: в ответе только проверенные числа. Снаружи модуль ничего не
принимает: у /api/fng нет параметров. Какой код в модуле допустим,
проверяет tests/test_fng_policy.py.

Модуль ни от чего в whale_api не зависит: сеть — через _fetch (тесты
подменяют только её), часы — через _now.
"""
from __future__ import annotations

import bisect
import contextlib
import http.client
import json
import math
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:  # pragma: no cover — только для mypy, при запуске не выполняется
    from collections.abc import Callable, Mapping
    from typing import NotRequired

DAY = 86400
WEEK = 7 * DAY
HOUR = 3600
# Первый день индекса alternative.me — раньше его не бывает.
START = 1517443200  # 2018-02-01
# Сколько ответ живёт в кэше, с (приложение держит столько же — FNG_TTL_MS).
# Индекс выходит раз в сутки, цена идущего дня — раз в TTL.
TTL = 1800.0
# Полная история цен (1 МБ) — не чаще этого, с; между ними — только текущая
# цена (сотня байт). Закрытие вчерашнего дня уточняется за PX_TTL.
PX_TTL = 6 * 3600.0
# Все источники молчат — столько не пытаемся снова, с.
ERR_TTL = 120.0
# Бюджет одной сборки и предел на один запрос, с.
BUDGET = 25.0
HOP = 15.0
MIN_LEFT = 0.2

FNG_URL = "https://api.alternative.me/fng/?limit=0&format=json"
HIST_URL = "https://mempool.space/api/v1/historical-price?currency=USD"
LIVE_URL = "https://mempool.space/api/v1/prices"

# Флаги дня: цена досчитана между недельными точками; индекса за день не
# было — взят прошлый день.
F_EST = 1
F_FILL = 2
# Цена дня — запасная, Hyperliquid (mempool.space её не дал).
F_HL = 4
# Все известные флаги.
F_ALL = F_EST | F_FILL | F_HL
# Сколько последних дней без единой цены — повод пересобрать ответ скоро.
RECENT = 30
# Точка цены не дальше этого от 00:00 — цена точная, с.
EXACT = 3 * HOUR
# Между соседними точками дольше этого — день не досчитываем (цена 0).
GAP_MAX = 8 * DAY
# Правдоподобная цена биткоина с 2018 года, $ (меньше 3 тысяч не бывала).
PX_MIN, PX_MAX = 1000.0, 10_000_000.0
# Настоящая история — тысячи дней; меньше — обрезанный ответ, не верим.
MIN_DAYS = 1000
# Обрезанный ответ видно и по дырам: дней с индексом — не меньше этой доли
# от всех дней между первым и последним.
MIN_COVER = 0.95
# Насколько время от источника может быть впереди наших часов, с (часы
# сервера и источника расходятся); дальше — сбой источника.
MAX_FUTURE = 7200

_HEADERS = {"User-Agent": "wallet-tracker/1.0", "Accept-Encoding": "identity"}
HOSTS = frozenset({"api.alternative.me", "mempool.space"})
SCHEMES = frozenset({"https"})
LOG_MAX = 300
CHUNK = 65_536
INT_MAX = 20
# Самые большие ответы: индекс — 0,3 МБ, история цен — 1,1 МБ и растёт на
# ~0,3 МБ в год, текущая цена — сотня байт.
FNG_MAX = 2 << 20
HIST_MAX = 8 << 20
LIVE_MAX = 4096
# Сколько точек цены и дней индекса принимаем (с запасом на десятилетия).
ROWS_MAX = 200_000
# Файл копии ответа в папке кэша; недописанная копия старше TMP_AGE, с, —
# мусор от прерванной записи.
SAVED = "fng_days.json"
TMP_AGE = 3600.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Перенаправление не выполняется: 3xx — это ошибка, а не новый адрес."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect,
                                      urllib.request.HTTPSHandler(context=ssl.create_default_context()))


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
    with contextlib.suppress(OSError, ValueError):
        print(f"fng: {clean[:LOG_MAX]}", file=sys.stderr)


# День ответа: [начало суток UTC, индекс 0–100, цена закрытия $ (0 — нет), флаги].
Day = list[float]


class Reply(TypedDict):
    """Ответ /api/fng — тот же договор, что FngReply в src/lib/fng.ts и
    образец tests/fixtures/fng.json."""

    ok: bool
    error: NotRequired[str]
    days: NotRequired[list[Day]]
    at: NotRequired[int]


@dataclass
class _State:
    """Кэш модуля; меняется только под _lock."""

    hit: tuple[float, Reply] | None = None  # (monotonic, ответ)
    err_at: float = float("-inf")  # когда источники последний раз молчали (monotonic)
    # История цен: время точек по возрастанию и цены; когда получена (monotonic).
    ts: list[int] = field(default_factory=list)
    px: list[float] = field(default_factory=list)
    px_at: float = float("-inf")
    # Где держать копию ответа (set_cache_dir); копия уже читалась.
    dir: str | None = None
    loaded: bool = False
    # Запасные закрытия BTC (set_backup); None — запасного источника нет.
    backup: Callable[[], Mapping[int, float]] | None = None


_st = _State()
_lock = threading.Lock()
_cold = threading.Lock()
_busy = threading.Event()
_dl = threading.local()


def _no_data() -> Reply:
    return {"ok": False, "error": "no_data"}


def _failed() -> bool:
    """Источники молчали меньше ERR_TTL назад. Вызывать под _lock."""
    return time.monotonic() - _st.err_at < ERR_TTL


def _now() -> int:
    return int(time.time())


def _fetch(url: str, limit: int) -> bytes | None:
    """GET. Любая ошибка сети и ответ больше limit байт — None. Внутри
    сборки — не дольше, чем осталось от бюджета."""
    if not _allowed(url):
        return None
    dl = getattr(_dl, "at", 0.0)
    left = dl - time.monotonic() if dl else HOP
    if left <= MIN_LEFT:
        return None
    hop = min(HOP, left)
    end = time.monotonic() + hop
    try:
        with _opener.open(urllib.request.Request(url, headers=_HEADERS), timeout=hop) as r:
            buf = bytearray()
            while len(buf) <= limit:
                if time.monotonic() > end:
                    return None
                chunk: bytes = r.read1(min(CHUNK, limit + 1 - len(buf)))
                if not chunk:
                    return bytes(buf)
                buf += chunk
            return None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def _finite(text: str) -> float:
    v = float(text)
    if not math.isfinite(v):
        raise ValueError("не конечное число")
    return v


def _short_int(text: str) -> int:
    if len(text) > INT_MAX:
        raise ValueError("слишком длинное число")
    return int(text)


def _no_constant(name: str) -> float:
    raise ValueError(f"{name} в JSON")


_DECODER = json.JSONDecoder(parse_float=_finite, parse_int=_short_int,
                            parse_constant=_no_constant)


def _parse(raw: bytes | None) -> object:
    try:
        return _DECODER.decode(raw.decode()) if raw else None
    except (ValueError, RecursionError):  # UnicodeDecodeError — тоже ValueError
        return None


def _json(url: str, limit: int) -> object:
    return _parse(_fetch(url, limit))


def _whole(v: object) -> int:
    """Целое из JSON; -1 — не целое (строка, дробь, True)."""
    return v if type(v) is int else -1


def _real(v: object) -> float:
    """Число из JSON, целое или дробное; 0.0 — не число."""
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


# Индекс и время у alternative.me — строки из цифр.
_DIGITS = re.compile(r"[0-9]{1,12}")


def _digits(v: object) -> int:
    """Число из строки ASCII-цифр; -1 — не такая строка. int() принял бы и
    «+5», и «1_0», и цифры других письменностей."""
    return int(v) if isinstance(v, str) and _DIGITS.fullmatch(v) else -1


def _index() -> dict[int, int] | None:
    """Индекс по дням (начало суток UTC → 0–100); None — ответа нет или он
    неправдоподобен (мало дней, дыры — обрезан)."""
    got = _json(FNG_URL, FNG_MAX)
    rows = got.get("data") if isinstance(got, dict) else None
    if not isinstance(rows, list):
        return None
    top = _now() + MAX_FUTURE
    out: dict[int, int] = {}
    for r in rows[:ROWS_MAX]:
        if not isinstance(r, dict):
            continue
        t, v = _digits(r.get("timestamp")), _digits(r.get("value"))
        # Только начало суток: индекс выходит раз в день в 00:00 UTC.
        if t % DAY == 0 and START <= t <= top and 0 <= v <= 100:
            out.setdefault(t, v)
    if len(out) < MIN_DAYS:
        return None
    span = (max(out) - min(out)) // DAY + 1
    if len(out) < span * MIN_COVER:
        return None
    return out


def _when(t: int, raw: dict[int, float]) -> int:
    """Когда на самом деле была цена точки t. mempool до почасовой истории
    хранит свечи по времени их НАЧАЛА с ценой ЗАКРЫТИЯ: точка четверга в
    00:00 UTC — недельная свеча (закрытие через 7 дней; недели Kraken
    начинаются по четвергам), другая точка в 00:00 — дневная (закрытие через
    сутки). Сверено с известными закрытиями: точка 24.12.2020 — $28 880
    (закрытие 30.12), 31.12.2020 — $36 877 (6.01). Остальные точки — цена в
    сам момент. Свечи встречаются и среди точек по часам (до весны 2023):
    точка в 00:00 рядом с ними — свеча, если её цена ближе к цене за час до
    закрытия свечи, чем к соседним точкам (час до и после)."""
    if t % DAY:
        return t
    span = WEEK if t // DAY % 7 == 0 else DAY  # 1.01.1970 (день 0) — четверг
    near = [p for p in (raw.get(t - HOUR), raw.get(t + HOUR)) if p is not None]
    if near:
        later = raw.get(t + span - HOUR)
        if later is None or abs(raw[t] - sum(near) / len(near)) <= abs(raw[t] - later):
            return t
    return t + span


def _history() -> tuple[list[int], list[float]] | None:
    """История цен mempool.space: время цены по возрастанию и цены с
    START−GAP_MAX; None — ответа нет или он неправдоподобен."""
    got = _json(HIST_URL, HIST_MAX)
    rows = got.get("prices") if isinstance(got, dict) else None
    if not isinstance(rows, list):
        return None
    raw: dict[int, float] = {}
    for r in rows[:ROWS_MAX]:
        if not isinstance(r, dict):
            continue
        t, p = _whole(r.get("time")), _real(r.get("USD"))
        # Точки задолго до START (история с 2010 года) не нужны; из будущего
        # отсекаются ниже — по времени самой цены, а не точки.
        if t >= START - GAP_MAX - WEEK and PX_MIN < p < PX_MAX:
            raw.setdefault(t, p)
    if len(raw) < MIN_DAYS:
        return None
    # Несколько точек на один миг: цена момента, потом дневная свеча, потом
    # недельная — чем подробнее, тем вернее. Цена из будущего (недельная
    # свеча, начатая вчера, или подделка) — не цена.
    top = _now() + MAX_FUTURE
    moved = [(_when(t, raw), t, p) for t, p in raw.items()]  # _when — один раз на точку
    pts: dict[int, float] = {}
    for span in (0, DAY, WEEK):
        for w, t, p in moved:
            if w - t == span and w <= top:
                pts.setdefault(w, p)
    ts = sorted(pts)
    return ts, [pts[t] for t in ts]


def _live() -> tuple[int, float] | None:
    """Текущая цена mempool.space; None — нет или неправдоподобна."""
    got = _json(LIVE_URL, LIVE_MAX)
    if not isinstance(got, dict):
        return None
    t, p = _whole(got.get("time")), _real(got.get("USD"))
    n = _now()
    # Цена не старше суток и не из будущего.
    if n - DAY <= t <= n + MAX_FUTURE and PX_MIN < p < PX_MAX:
        return t, p
    return None


def _close(ts: list[int], px: list[float], t: int, n: int) -> tuple[float, int]:
    """Цена закрытия дня t и флаг F_EST, если досчитана; (0, 0) — не знаем."""
    end = t + DAY
    if not ts:
        return 0.0, 0
    if end > n:
        # День идёт: закрытие — последняя цена, если она из этого дня.
        return (px[-1], 0) if ts[-1] >= t else (0.0, 0)
    i = bisect.bisect_left(ts, end)
    near = min((j for j in (i - 1, i) if 0 <= j < len(ts)), key=lambda j: abs(ts[j] - end))
    if abs(ts[near] - end) <= EXACT:
        return px[near], 0
    if 0 < i < len(ts) and ts[i] - ts[i - 1] <= GAP_MAX:
        a, b = ts[i - 1], ts[i]
        k = (end - a) / (b - a)
        return math.exp(math.log(px[i - 1]) + k * (math.log(px[i]) - math.log(px[i - 1]))), F_EST
    return 0.0, 0


def set_backup(fn: Callable[[], Mapping[int, float]] | None) -> None:
    """Откуда брать запасные закрытия BTC (начало суток UTC → $)."""
    _st.backup = fn


def _backup() -> dict[int, float]:
    """Запасные закрытия: только правдоподобные и только закрытые дни. Сбой
    запасного источника — просто без него."""
    fn = _st.backup
    if fn is None:
        return {}
    try:
        got = fn()
    except Exception as e:  # noqa: BLE001 — запасной источник не роняет сборку
        _log(f"запасная цена: {type(e).__name__}: {e}")
        return {}
    today = _now() // DAY * DAY
    return {t: float(p) for t, p in list(got.items())[:ROWS_MAX]
            if type(t) is int and t % DAY == 0 and START <= t < today
            and isinstance(p, (int, float)) and not isinstance(p, bool) and PX_MIN < p < PX_MAX}


def _days(idx: dict[int, int], ts: list[int], px: list[float], old: dict[int, tuple[float, int]],
          backup: Mapping[int, float]) -> list[Day]:
    """Дни ответа от первого до последнего дня индекса подряд. Цены нет в
    истории (mempool молчал) — из прошлого ответа, а нет и там — запасная
    (Hyperliquid, флаг F_HL)."""
    n = _now()
    out: list[Day] = []
    for t in range(min(idx), max(idx) + DAY, DAY):
        f = 0
        v = idx.get(t)
        if v is None:
            v, f = int(out[-1][1]), F_FILL  # первый день есть всегда: t начинается с min(idx)
        p, e = _close(ts, px, t, n)
        if not p and t in old:
            p, e = old[t]
        elif not p and t in backup:
            p, e = backup[t], F_HL
        out.append([t, v, round(p, 2), f | e])
    return out


def build() -> Reply:
    """Собрать ответ из сети и положить в кэш — не дольше BUDGET секунд.
    Любая непредвиденная ошибка — сбой источника: ERR_TTL паузы."""
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
        hit, ts, px, px_at = _st.hit, _st.ts, _st.px, _st.px_at
    idx = _index()
    if idx is None:
        _log("alternative.me: нет индекса")
        with _lock:
            _st.err_at = time.monotonic()
        return hit[1] if hit else _no_data()
    old_days = hit[1].get("days", []) if hit else []
    # Новый ответ не короче прошлого: источник, вдруг потерявший последние
    # дни, не откатывает экран назад.
    if old_days and max(idx) < old_days[-1][0]:
        _log("alternative.me: последний день раньше, чем в прошлом ответе")
        with _lock:
            _st.err_at = time.monotonic()
        return hit[1] if hit else _no_data()
    if not ts or time.monotonic() - px_at >= PX_TTL:
        got = _history()
        if got:
            ts, px = got
            with _lock:
                _st.ts, _st.px, _st.px_at = ts, px, time.monotonic()
        else:
            _log("mempool.space: нет истории цен")
    hist = bool(ts)
    live = _live()
    if live and (not ts or live[0] > ts[-1]):
        ts, px = [*ts, live[0]], [*px, live[1]]
    old = {int(d[0]): (float(d[2]), int(d[3]) & (F_EST | F_HL)) for d in old_days if d[2] > 0}
    days = _days(idx, ts, px, old, _backup())
    res: Reply = {"ok": True, "days": days, "at": _now()}
    # Цен за последний месяц нет ни от mempool, ни запасных — ответ живёт
    # только ERR_TTL: цена появится через пару минут, а не через полчаса.
    # С запасной ценой — обычный TTL: mempool не дёргаем чаще раза в TTL.
    priced = hist or any(d[2] > 0 for d in days[-RECENT:])
    born = time.monotonic() if priced else time.monotonic() - TTL + ERR_TTL
    with _lock:
        _st.hit = (born, res)
    _file_save(res)
    return res


# --- Копия ответа на диске ----------------------------------------------------

def set_cache_dir(path: str | None) -> None:
    """Где держать копию ответа (None — нигде)."""
    _st.dir = path


def _file() -> str | None:
    return os.path.join(_st.dir, SAVED) if _st.dir else None


def _file_save(res: Reply) -> None:
    path = _file()
    if not path:
        return
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(res, f, separators=(",", ":"))
        os.replace(tmp, path)
    except (OSError, TypeError, ValueError) as e:
        _log(f"копия на диске: {type(e).__name__}: {e}")
        with contextlib.suppress(OSError):
            os.remove(tmp)


def valid_days(days: object) -> list[Day] | None:
    """Дни ответа, если они такие, какие собирает модуль: подряд по суткам с
    START, индекс 0–100, цена 0 или правдоподобная, известные флаги. Так
    проверяется копия с диска — испорченная не попадёт к людям."""
    if not isinstance(days, list) or not MIN_DAYS <= len(days) <= ROWS_MAX:
        return None
    out: list[Day] = []
    for d in days:
        if not (isinstance(d, list) and len(d) == 4):
            return None
        t, v, f = _whole(d[0]), _whole(d[1]), _whole(d[3])
        p = _real(d[2])
        if t < START or (out and t != out[-1][0] + DAY) or not 0 <= v <= 100 \
                or not (p == 0 or PX_MIN < p < PX_MAX) or not 0 <= f <= F_ALL:
            return None
        out.append([t, v, p, f])
    return out if out[-1][0] <= _now() + MAX_FUTURE else None


def _file_load() -> Reply | None:
    path = _file()
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            got = _parse(f.read(HIST_MAX + 1))
    except OSError:
        return None
    if not isinstance(got, dict) or got.get("ok") is not True:
        return None
    days, at = valid_days(got.get("days")), _whole(got.get("at"))
    return {"ok": True, "days": days, "at": at} if days and at > 0 else None


# --- Ответ -------------------------------------------------------------------

def _bg() -> None:
    try:
        build()  # сама не падает: любой сбой — пауза ERR_TTL (см. build)
    finally:
        _busy.clear()


def _sweep() -> None:
    """Временные файлы копии, оставшиеся от прерванной записи (сервер
    остановили посреди неё), — удалить: сами они не исчезнут."""
    path = _file()
    if not path:
        return
    folder, name = os.path.split(path)
    with contextlib.suppress(OSError):
        for f in os.listdir(folder or "."):
            if f.startswith(name + ".") and f.endswith(".tmp"):
                full = os.path.join(folder, f)
                if time.time() - os.path.getmtime(full) > TMP_AGE:
                    os.remove(full)


def _warm() -> None:
    """После перезапуска — копия с диска как устаревший ответ (один раз);
    заодно — уборка недописанных копий."""
    if _st.loaded or not _st.dir:
        return
    _sweep()
    saved = _file_load()
    with _lock:
        _st.loaded = True
        if _st.hit is None and saved:
            _st.hit = (time.monotonic() - TTL - 1.0, saved)


def fng_data() -> Reply:
    """Ответ /api/fng: из кэша, свежий собирается в фоне."""
    _warm()
    with _lock:
        hit = _st.hit
        if hit and time.monotonic() - hit[0] < TTL:
            return hit[1]
        failed = _failed()
        if hit and not failed and not _busy.is_set():
            _busy.set()
            try:
                threading.Thread(target=_bg, daemon=True).start()
            except RuntimeError as e:
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

