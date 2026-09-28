#!/usr/bin/env python3
"""Read-only(+mutations) JSON API over whale_bot.db + hyperliquid.db.
Stdlib only. Run from WhaleScanner working directory on the VPS."""
from __future__ import annotations

import hashlib
import html
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# Петля по умолчанию: наружу API выходит только через nginx. Раньше здесь
# было 0.0.0.0, и обе базы бота слушали любой IP.
HOST = os.environ.get("WHALE_API_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHALE_API_PORT", "8090"))
WS_DIR = os.environ.get("WHALE_SCANNER_DIR") or (
    "/home/vadymdota2/WhaleScanner"
    if os.path.isdir("/home/vadymdota2/WhaleScanner")
    else os.path.abspath(os.path.expanduser("~/WhaleScanner"))
)
if not os.path.isdir(WS_DIR):
    WS_DIR = os.path.abspath(".")


def _db_path(env_key: str, name: str) -> str:
    env = os.environ.get(env_key)
    if env and os.path.isfile(env):
        return os.path.abspath(env)
    for folder in (WS_DIR, os.path.abspath("."), os.path.expanduser("~/WhaleScanner")):
        p = os.path.join(folder, name)
        if os.path.isfile(p):
            return os.path.abspath(p)
    return os.path.abspath(os.path.join(WS_DIR, name))


DB = _db_path("WHALE_DB", "whale_bot.db")
HL_DB = _db_path("WHALE_HL_DB", "hyperliquid.db")
BOT_TOKEN = os.environ.get("WHALE_TG_TOKEN", "")
HL_INFO = "https://api.hyperliquid.xyz/info"

# Кому разрешено обращаться из браузера. Пустой список = заголовок не
# отдаётся вовсе. Звёздочка означала бы, что любой сайт может дёргать API
# из вкладки жертвы её же правами.
ALLOWED_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get("WHALE_API_ORIGIN", "").split(",")
    if o.strip()
}
# Срок годности подписи Telegram. Без него однажды перехваченная initData
# работала бы вечно.
INIT_DATA_TTL = int(os.environ.get("WHALE_API_INITDATA_TTL", "86400"))
# Те же числа, что в premium.cpp и alert_settings.cpp. Раньше API их не знал
# и пускал мимо лимитов.
FREE_MAX_WALLETS = 1
PREMIUM_MAX_WALLETS = 50
# Сервисный аккаунт бота — тот, что держит базу кошельков. Бот (main.cpp,
# SERVICE_CHAT_ID; isPremium в premium.cpp) считает его подпиской навсегда и
# без лимита кошельков. API этого не знал: для него это был бесплатный
# аккаунт, и приложение ставило на паузу все его кошельки, кроме основного,
# а сервер срезал ему Hyperliquid. Номер тот же, что в боте.
SERVICE_CHAT_ID = os.environ.get("WHALE_SERVICE_CHAT", "7479880531").strip()
SERVICE_MAX_WALLETS = 1_000_000
# Глубина доски трейдеров. Те же числа, что FREE_TOP_TRADERS и
# PREMIUM_TOP_TRADERS в premium.cpp: приложение и чат обязаны показывать
# одинаково глубоко, иначе премиум значит разное в двух местах.
RANK_FREE_DEPTH = 30
RANK_MAX_DEPTH = 100
# Цена и срок — те же, что в premium.cpp: бот и приложение обязаны продавать
# одно и то же, иначе «премиум» значит разное в двух местах.
PREMIUM_DAYS = 30
PREMIUM_STARS = 250
PREMIUM_PAYLOAD = "premium_30_days"
# Цена в USDT. Отдельным числом, а не пересчётом звёзд: курс звезды плавает,
# а ценник в долларах человек видит заранее и без сюрпризов.
PREMIUM_USDT = float(os.environ.get("WHALE_PREMIUM_USDT", "3.99"))
# Кошелёк, на который приходят деньги. Тот же самый и тем же способом, что в
# tonWallet() из premium.cpp: переменная окружения, а если её нет — адрес по
# умолчанию. Требовать переменную только здесь нельзя: у бота и у API разные
# службы, и приложение осталось бы без кнопки оплаты на ровном месте.
TON_WALLET = (os.environ.get("TON_WALLET_ADDRESS", "").strip()
              or "UQDAiNYvy2KUIwjEcgD1ZxPVw-CPwdk4WbBQwpVsQQ5jsO6o")
# USD₮ в сети TON: мастер-контракт и шесть знаков после запятой.
USDT_MASTER = "0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE"
USDT_MASTER_UI = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
USDT_DECIMALS = 6
# Счёт живёт час — столько же, сколько у бота. Оплату по нему принимаем
# сутки: человек, заплативший с опозданием, не должен терять деньги.
PAY_TTL = 3600
PAY_GRACE = 86400
TONCENTER = "https://toncenter.com/api/v3/"
TONCENTER_KEY = os.environ.get("TONCENTER_API_KEY", "")
MIN_THRESHOLD_USD = 50.0
MAX_THRESHOLD_USD = 1_000_000_000.0
# Потолок запросов с одного адреса: перебор chat_id упирается в него.
RATE_LIMIT_RPM = int(os.environ.get("WHALE_API_RPM", "120"))
# Общий секрет с nginx. Порт 8090 виден Cloud Run, а значит и всем прочим;
# ключ делает прямое обращение в обход прокси бесполезным.
API_KEY = os.environ.get("WHALE_API_KEY", "")

NANOS = 1_000_000_000.0
ADDR_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
# Те же шестнадцать языков, что в ru.h бота. Мини-апп и чат пишут выбор в
# одну строку users, поэтому список обязан совпадать.
LANG_CODES = {
    "en", "ru", "es", "pt", "fr", "tr", "ar", "pl",
    "de", "uk", "hi", "id", "vi", "ko", "zh", "ja",
}
COIN_RE = re.compile(r"\b([A-Z]{2,12})\b")
_hl_cache: dict[str, tuple[float, dict]] = {}
_hl_lock = threading.Lock()
HL_TTL = 20.0
# Цены спотовых токенов Hyperliquid: один запрос на всех, живёт пять минут.
_spot_px: dict = {"t": 0.0, "map": {}}
_spot_px_lock = threading.Lock()
SPOT_PX_TTL = 300.0
_pub_lock = threading.Lock()
_pub: dict = {"t": 0.0, "data": None}
PUB_TTL = 30.0
# Сколько секунд отводится на сборку общего кэша. Восьми не хватало:
# rank, flow, sonar, trades и feed съедали их целиком, и coins, funding и
# rot не выполнялись НИ РАЗУ — мини-апп оставался без цен и фандинга.
# Ограничение имело смысл, пока ответа ждал пользователь; сейчас сборка
# идёт в фоне, а запросам отдаётся прошлый кэш, так что спешить некуда.
BUILD_BUDGET = float(os.environ.get("WHALE_API_BUILD_BUDGET", "25"))
_addr_by_sym: dict[str, str] = {}
_px_hist: dict[str, tuple[float, list]] = {}
_hl_candles: dict[str, tuple[float, list]] = {}
# Крупнейшие сделки считаются по запросу: четыре окна в общий кэш не лезут,
# а ходят по ним редко. Тридцати секунд хватает, чтобы не долбить базу.
_big_cache: dict[str, tuple[float, dict]] = {}
_big_lock = threading.Lock()
# Дольше, чем пауза refresher: тот переписывает все окна по часам, и между
# его кругами запись не должна протухать — иначе первое нажатие на «7д»
# после паузы опять уходило бы в базу.
BIG_TTL = 150.0
_big_busy: set[str] = set()
# Те же окна, что у бота в big_trades.cpp. Между часом и сутками без шести
# часов слишком большой прыжок: за час по монете бывает две сделки, а за
# сутки всё уже размазано.
BIG_WINDOWS = {"1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720}
HL_COIN = {
    "PEPE": "kPEPE",
    "FLOKI": "kFLOKI",
    "SHIB": "kSHIB",
    "BONK": "kBONK",
    "NVDA": "xyz:NVDA",
    "INTC": "xyz:INTC",
    "GOOGL": "xyz:GOOGL",
    "GOOG": "xyz:GOOGL",
}


# --- EIP-55 checksum: PancakeSwap и TrustWallet отдают логотипы только по
# --- адресу в смешанном регистре; в token_cache адреса в нижнем.
_KEC_RC=[0x0000000000000001,0x0000000000008082,0x800000000000808A,0x8000000080008000,
0x000000000000808B,0x0000000080000001,0x8000000080008081,0x8000000000008009,
0x000000000000008A,0x0000000000000088,0x0000000080008009,0x000000008000000A,
0x000000008000808B,0x800000000000008B,0x8000000000008089,0x8000000000008003,
0x8000000000008002,0x8000000000000080,0x000000000000800A,0x800000008000000A,
0x8000000080008081,0x8000000000008080,0x0000000080000001,0x8000000080008008]
_KEC_R=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]]
M=(1<<64)-1
def _rol(x,n): return ((x<<n)|(x>>(64-n)))&M
def _keccak_f(A):
    for rnd in range(24):
        C=[A[x][0]^A[x][1]^A[x][2]^A[x][3]^A[x][4] for x in range(5)]
        D=[C[(x-1)%5]^_rol(C[(x+1)%5],1) for x in range(5)]
        for x in range(5):
            for y in range(5): A[x][y]^=D[x]
        B=[[0]*5 for _ in range(5)]
        for x in range(5):
            for y in range(5): B[y][(2*x+3*y)%5]=_rol(A[x][y],_KEC_R[x][y])
        for x in range(5):
            for y in range(5): A[x][y]=B[x][y]^((~B[(x+1)%5][y])&B[(x+2)%5][y])&M
        A[0][0]^=_KEC_RC[rnd]
    return A
def keccak256(data: bytes) -> bytes:
    rate=136
    A=[[0]*5 for _ in range(5)]
    pad=data+b'\x01'+b'\x00'*((-len(data)-1)%rate)
    pad=bytearray(pad); pad[-1]^=0x80
    for off in range(0,len(pad),rate):
        blk=pad[off:off+rate]
        for i in range(rate//8):
            x,y=(i%5),(i//5)
            A[x][y]^=int.from_bytes(blk[i*8:i*8+8],'little')
        _keccak_f(A)
    out=b''
    for i in range(4):
        x,y=(i%5),(i//5)
        out+=A[x][y].to_bytes(8,'little')
    return out[:32]
def to_checksum(addr: str) -> str:
    a=(addr or '').lower().replace('0x','')
    if len(a)!=40: return addr or ''
    h=keccak256(a.encode()).hex()
    return '0x'+''.join(c.upper() if c.isalpha() and int(h[i],16)>=8 else c for i,c in enumerate(a))


# Логотипы, скачанные fetch_logos.py и уехавшие в образ Cloud Run.
# Манифест нужен, чтобы не предлагать фронту локальный адрес того, чего
# на диске нет: иначе каждый такой значок стоил бы лишнего запроса и 404.
LOGO_MANIFEST = os.environ.get(
    "WHALE_LOGO_MANIFEST",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "coins_manifest.json"),
)
_logo_local: dict[str, set[str]] = {"bsc": set(), "hl": set()}
_logo_mtime = 0.0


def _load_logo_manifest() -> None:
    global _logo_mtime
    try:
        m = os.path.getmtime(LOGO_MANIFEST)
    except OSError:
        return
    if m == _logo_mtime:
        return
    try:
        with open(LOGO_MANIFEST, encoding="utf-8") as f:
            raw = json.load(f)
        _logo_local["bsc"] = {str(x) for x in (raw.get("bsc") or [])}
        _logo_local["hl"] = {str(x) for x in (raw.get("hl") or [])}
        _logo_mtime = m
    except (OSError, ValueError):
        pass


def coin_icon(sym: str, addr: str = "") -> list[str]:
    """Список кандидатов по убыванию доверия. Площадку определяет адрес:
    он есть только у спотовых токенов BSC, у перпов Hyperliquid его нет.
    TradingView убран: он ищет по тикеру, а тикеры не уникальны — под PUMP
    и HYPE там лежали чужие проекты, и картинка грузилась успешно, из-за
    чего до правильной очередь не доходила. Источники по адресу контракта
    такой подмены не допускают: адрес уникален."""
    _load_logo_manifest()
    key = (sym or "").upper().replace(" ", "")
    out: list[str] = []
    a = (addr or "").lower()
    if a.startswith("0x") and len(a) == 42:
        sumaddr = to_checksum(a)
        if sumaddr in _logo_local["bsc"]:
            out.append(f"/coins/bsc/{sumaddr}.png")
        out.append(f"/pcslogo/{sumaddr}.png")
        out.append(f"/twlogo/{sumaddr}/logo.png")
        # DexScreener добирает то, чего нет у первых двух: на живой выдаче
        # это одиннадцать токенов из двадцати девяти безымянных. Адрес ему
        # нужен в нижнем регистре, в отличие от соседей.
        out.append(f"/dslogo/{a}.png")
        return out
    if not key:
        return out
    # Полное имя инструмента HIP-3 — «xyz:SP500», строчными. Биржа раздаёт
    # значки только по нему: и на «SP500.svg», и на «XYZ:SP500.svg» она
    # отвечает страницей приложения, причём с кодом 200 — на ошибку не похоже,
    # перебор шёл дальше и заканчивался буквой.
    #
    # Ищем по короткому имени: в базе оно встречается и с приставкой, и без, а
    # ключи карты короткие.
    bare = key.split(":")[-1]
    if ":" in key:
        # Приставка уже есть — значит площадка известна, и подменять её картой
        # нельзя: «ANTH» торгуется и на io, и на para, а значки у них разные.
        # Биржа пишет площадку строчными, тикер прописными.
        head, _, tail = key.partition(":")
        alias = f"{head.lower()}:{tail}"
    else:
        alias = HL_COIN.get(key) or hl_markets().get(key) or key
    for name in (alias, key) if alias != key else (alias,):
        if name in _logo_local["hl"]:
            safe = name.replace(":", "_").replace("/", "_")
            out.append(f"/coins/hl/{safe}.svg")
    out.append(f"/hllogo/{alias}.svg")
    for name in (key, bare):
        if name != alias:
            out.append(f"/hllogo/{name}.svg")
    return out



def now() -> int:
    return int(time.time())


class _Con(sqlite3.Connection):
    """Соединение, помнящее свой файл.

    Нужно кэшу table_exists: баз две, и без файла в ключе ответ про одну
    молча подставляется для другой.
    """
    path: str = ""


def open_db(path: str, write: bool = False) -> sqlite3.Connection | None:
    if not path or not os.path.isfile(path):
        return None
    con = sqlite3.connect(path, timeout=8, check_same_thread=False, factory=_Con)
    con.path = path
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=8000")
    if not write:
        try:
            con.execute("PRAGMA query_only=ON")
        except sqlite3.Error:
            pass
    return con


_table_ok: dict[tuple[str, str], bool] = {}
_sym_cache: dict[str, str] = {}
_building = False


def cap_cache(d: dict, limit: int) -> None:
    """Словари-кэши росли без предела. Переполнился — выкидываем половину
    самых старых по порядку вставки."""
    if len(d) <= limit:
        return
    for k in list(d.keys())[: len(d) - limit // 2]:
        d.pop(k, None)


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    """Есть ли таблица — с кэшем на каждую базу отдельно.

    Раньше ключом было одно имя таблицы. Баз две: в whale_bot.db нет
    hl_fills, в hyperliquid.db нет trades. Кто спросил первым, тот и записал
    ответ на всех: один вопрос про чужую таблицу навсегда выключал целую
    ветку в другой базе, и она молча возвращала пустоту — без ошибки, без
    записи в журнал.
    """
    key = (getattr(con, "path", ""), name)
    hit = _table_ok.get(key)
    if hit is not None:
        return hit
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    ok = bool(row)
    _table_ok[key] = ok
    return ok


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
    """Разбирает initData Telegram и возвращает пользователя ТОЛЬКО при
    сошедшейся подписи. Любая неудача — None, вызывающий обязан считать
    запрос анонимным."""
    # Проверять подпись нечем — значит доверять нечему. Раньше при пустом
    # токене данные принимались как есть.
    if not raw or not BOT_TOKEN:
        return None
    parts = {}
    for chunk in raw.split("&"):
        if "=" not in chunk:
            continue
        k, v = chunk.split("=", 1)
        parts[k] = unquote(v)
    got = parts.pop("hash", "")
    # hash обязателен. Раньше условие было `if BOT_TOKEN and got`, поэтому
    # запрос БЕЗ hash проверку целиком пропускал: достаточно было прислать
    # user={"id":...} и любой чужой аккаунт открывался.
    if not got:
        return None
    check = "\n".join(f"{k}={parts[k]}" for k in sorted(parts))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    expect = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, got):
        return None
    # Срок годности. Telegram кладёт время выдачи в auth_date; без проверки
    # однажды утёкшая строка оставалась бы ключом навсегда.
    try:
        auth_date = int(parts.get("auth_date") or 0)
    except ValueError:
        return None
    if auth_date <= 0:
        return None
    age = now() - auth_date
    # Небольшой запас назад: часы клиента могут немного убежать вперёд.
    if age > INIT_DATA_TTL or age < -300:
        return None
    user_raw = parts.get("user") or ""
    try:
        user = json.loads(user_raw) if user_raw else {}
    except json.JSONDecodeError:
        return None
    uid = user.get("id")
    # id обязан быть целым числом: строкой сюда можно было бы протащить
    # что угодно, а он идёт прямо в chat_id.
    if not isinstance(uid, int) or uid <= 0:
        return None
    return {"id": str(uid), "lang": user.get("language_code") or "ru"}


class RateLimiter:
    """Скользящее окно на минуту по ключу. Держим в памяти: процесс один."""

    def __init__(self, rpm: int):
        self.rpm = max(1, rpm)
        self.hits: dict[str, list[float]] = {}
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        t = time.monotonic()
        with self.lock:
            # Заодно подметаем чужие протухшие записи, иначе словарь растёт
            # ровно на столько адресов, сколько к нам стучалось.
            if len(self.hits) > 4096:
                for k in [k for k, v in self.hits.items() if not v or t - v[-1] > 60.0]:
                    self.hits.pop(k, None)
            seq = [x for x in self.hits.get(key, ()) if t - x < 60.0]
            if len(seq) >= self.rpm:
                self.hits[key] = seq
                return False
            seq.append(t)
            self.hits[key] = seq
            return True


_limiter = RateLimiter(RATE_LIMIT_RPM)


def wallet_banned(con: sqlite3.Connection, addr: str) -> bool:
    """Тот же критерий, что в isPermanentlyBanned() бота."""
    if not table_exists(con, "ignored_wallets"):
        return False
    row = con.execute(
        "SELECT 1 FROM ignored_wallets WHERE wallet=? AND permanent=1", (addr.lower(),)
    ).fetchone()
    return row is not None


def is_service(chat: str) -> bool:
    """Сервисный аккаунт бота: подписка навсегда, лимита кошельков нет."""
    return bool(SERVICE_CHAT_ID) and str(chat or "") == SERVICE_CHAT_ID


def is_premium(con: sqlite3.Connection, chat: str) -> bool:
    """Действует ли подписка — та же проверка, что isPremium() в premium.cpp."""
    if is_service(chat):
        return True
    if not chat or not table_exists(con, "users"):
        return False
    if "is_premium" not in cols(con, "users"):
        return False
    row = con.execute(
        "SELECT is_premium, premium_expire FROM users WHERE chat_id=?", (chat,)
    ).fetchone()
    return bool(row and row["is_premium"] and int(row["premium_expire"] or 0) > now())


def chat_premium(chat: str) -> bool:
    """is_premium() для обработчика, у которого своей базы под рукой нет."""
    if not chat:
        return False
    con = open_db(DB)
    if not con:
        return False
    try:
        return is_premium(con, chat)
    except sqlite3.Error:
        return False
    finally:
        con.close()


def for_plan(data: dict, prem: bool) -> dict:
    """Срезает из ответа то, что закрыто подпиской, — как это делает бот.

    Раньше замки стояли только в приложении: сервер отдавал бесплатному
    пользователю все сто мест доски, перпы Hyperliquid, фандинг и позиции
    кошельков, а приложение их просто не рисовало — и то не везде. Что закрыто,
    то не должно уходить с сервера вовсе. Выгрузка при этом не копируется
    глубоко: общий кэш остаётся целым для подписчиков.

    Закрыто всё, что про фьючерсы Hyperliquid: доска перпов, крупные позиции,
    лонги и шорты, фандинг, позиции кошельков. Cortex не срезается: он пока
    бесплатный.
    """
    if prem or not isinstance(data, dict):
        return data
    out = dict(data)
    rank = out.get("rank")
    if isinstance(rank, dict):
        spot = rank.get("spot") if isinstance(rank.get("spot"), dict) else {}
        perp = rank.get("perp") if isinstance(rank.get("perp"), dict) else {}
        out["rank"] = {
            "spot": {k: v[:RANK_FREE_DEPTH] if isinstance(v, list) else v for k, v in spot.items()},
            "perp": {k: [] for k in (perp or {"pnl": 0, "roi": 0, "win": 0, "act": 0})},
        }
    if isinstance(out.get("trades"), dict):
        out["trades"] = {**out["trades"], "perp": []}
    if isinstance(out.get("perp"), list):
        out["perp"] = []
    # Лонги и шорты — тоже Hyperliquid.
    for k in ("fund", "fundN", "ls"):
        if k in out:
            out[k] = {}
    if isinstance(out.get("marketFeed"), list):
        out["marketFeed"] = [r for r in out["marketFeed"]
                             if not (isinstance(r, dict) and r.get("venue") == "perp")]
    if isinstance(out.get("wallets"), list):
        out["wallets"] = [{**w, "pos": []} if isinstance(w, dict) else w for w in out["wallets"]]
    if isinstance(out.get("pos"), list):
        out["pos"] = []
    return out


def plan_of(boot: dict) -> bool:
    """Подписка по самой выгрузке: замки и строка «Премиум» не разойдутся."""
    me = boot.get("me") if isinstance(boot, dict) else None
    return isinstance(me, dict) and me.get("plan") == "premium"


# Бесплатная неделя премиума — при первом открытии мини-аппа. Раньше её
# выдавал бот по /start, и кто открывал только приложение, не получал ничего,
# а кто писал боту и в приложение не заходил — получал неделю впустую.
# Отметка «уже выдавалась» — та же таблица trial_granted, что вёл бот: второй
# раз неделю не дадут ни тем, кто получил её в боте, ни после удаления данных.
TRIAL_DAYS = 7


def grant_trial(chat: str, lang: str = "") -> bool:
    """Выдать неделю, если человеку её ещё не давали. True — выдали сейчас.

    Всё одной транзакцией: отметка и продление либо вместе, либо никак. Два
    одновременных первых запроса не выдадут неделю дважды — INSERT OR IGNORE
    в trial_granted пропустит только один. Продление — как grantPremiumDays в
    premium.cpp: к действующей подписке дни прибавляются, а не заменяют её."""
    if not chat or is_service(chat):
        return False
    con = open_db(DB, write=True)
    if not con:
        return False
    try:
        if not (table_exists(con, "trial_granted") and table_exists(con, "users")):
            return False
        ucols = cols(con, "users")
        if not {"is_premium", "premium_expire"} <= ucols:
            return False
        con.isolation_level = None
        con.execute("BEGIN IMMEDIATE")
        try:
            t = now()
            if con.execute("INSERT OR IGNORE INTO trial_granted(chat_id, granted_at) VALUES(?,?)",
                           (chat, t)).rowcount != 1:
                con.execute("ROLLBACK")
                return False
            code = (lang or "").strip().lower()[:2]
            con.execute("INSERT OR IGNORE INTO users(chat_id, language, threshold_nanos, created_at) VALUES(?,?,?,?)",
                        (chat, code if code in LANG_CODES else "en", 100000000000, t))
            has_start = "premium_start" in ucols
            row = con.execute(
                "SELECT is_premium, premium_expire" + (", premium_start" if has_start else "") +
                " FROM users WHERE chat_id=?", (chat,)).fetchone()
            expire = int(row["premium_expire"] or 0)
            active = bool(row["is_premium"]) and expire > t
            new_expire = (expire if active else t) + TRIAL_DAYS * 86400
            if has_start:
                start = int(row["premium_start"] or 0)
                new_start = start if active and start > 0 else t
                con.execute("UPDATE users SET is_premium=1, premium_start=?, premium_expire=? WHERE chat_id=?",
                            (new_start, new_expire, chat))
            else:
                con.execute("UPDATE users SET is_premium=1, premium_expire=? WHERE chat_id=?",
                            (new_expire, chat))
            con.execute("COMMIT")
            sys.stderr.write(f"[api] trial: {TRIAL_DAYS} days for {chat}\n")
            return True
        except sqlite3.Error:
            try:
                con.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] trial {chat}: {e}\n")
        return False
    finally:
        con.close()


def wallet_limit(con: sqlite3.Connection, chat: str) -> int:
    """Лимит кошельков по подписке — как в premium.cpp."""
    if is_service(chat):
        return SERVICE_MAX_WALLETS
    return PREMIUM_MAX_WALLETS if is_premium(con, chat) else FREE_MAX_WALLETS


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


def spot_prices() -> dict[int, float]:
    """
    Индекс спотового токена Hyperliquid → цена в долларах.

    Нужна, потому что в spotClearinghouseState поле `total` — это КОЛИЧЕСТВО
    токенов, а не их стоимость. Складывать эти числа как доллары нельзя:
    кошелёк с 2 271 MAX (по $0,0000003) и 100 HREKT показывал «баланс»
    в тысячи долларов, а на живых кошельках счёт шёл на миллиарды.

    Берём только пары к USDC — цена в них и есть цена в долларах. Сам USDC
    считаем за единицу. Не ответил сервер — возвращаем пустую карту, и
    вызывающий не подставляет вместо цен количества.
    """
    now = time.monotonic()
    with _spot_px_lock:
        if _spot_px["map"] and now - _spot_px["t"] < SPOT_PX_TTL:
            return _spot_px["map"]
    raw = hl_post({"type": "spotMetaAndAssetCtxs"})
    if not isinstance(raw, list) or len(raw) < 2:
        return _spot_px["map"] if _spot_px["map"] else {}
    meta, ctxs = raw[0] or {}, raw[1] or []
    mid = {}
    for c in ctxs:
        if not isinstance(c, dict):
            continue
        try:
            v = float(c.get("midPx") or c.get("markPx") or 0)
        except (TypeError, ValueError):
            continue
        if v > 0:
            mid[c.get("coin")] = v
    out: dict[int, float] = {}
    for u in meta.get("universe") or []:
        pair = u.get("tokens") or []
        if len(pair) != 2 or pair[1] != 0:  # котировка не в USDC — не наша
            continue
        px = mid.get(u.get("name"))
        if px:
            out[pair[0]] = px
    out[0] = 1.0  # USDC
    if out:
        with _spot_px_lock:
            _spot_px["t"] = now
            _spot_px["map"] = out
    return out


def hl_state(addr: str) -> dict:
    key = addr.lower()
    hit = _hl_cache.get(key)
    if hit and time.monotonic() - hit[0] < HL_TTL:
        return hit[1]
    perp = hl_post({"type": "clearinghouseState", "user": addr}) or {}
    spot = hl_post({"type": "spotClearinghouseState", "user": addr}) or {}
    out = {"perp": perp, "spot": spot}
    # Прогрев идёт из нескольких потоков: словарь чистим под замком, иначе
    # обход на удаление спотыкается о чужую вставку.
    with _hl_lock:
        _hl_cache[key] = (time.monotonic(), out)
        cap_cache(_hl_cache, 4096)
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
    # Количество токенов умножаем на цену. Нет цены — пропускаем позицию:
    # прошлая версия складывала сами количества, и спот выходил в миллиарды.
    px_map = spot_prices()
    for b in spot.get("balances") or []:
        try:
            qty = float(b.get("total") or 0)
        except (TypeError, ValueError):
            continue
        px = px_map.get(b.get("token"))
        if qty > 0 and px:
            equity["spot"] += qty * px
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
    hit = _sym_cache.get(token)
    if hit is not None:
        return hit
    if token.startswith("0x") and len(token) >= 8:
        if table_exists(cur, "token_cache"):
            row = cur.execute(
                "SELECT symbol FROM token_cache WHERE lower(address)=?", (token.lower(),)
            ).fetchone()
            if row and row[0]:
                s = str(row[0]).upper().strip()
                if s and s != "UNKNOWN":
                    _sym_cache[token] = s
                    return s
        _sym_cache[token] = ""
        return ""
    _sym_cache[token] = (token.upper()[:12] or "")
    cap_cache(_sym_cache, 8192)
    return _sym_cache[token]


def ts_sec(ts) -> int:
    try:
        v = int(ts or 0)
    except (TypeError, ValueError):
        return 0
    if v > 10_000_000_000:
        return v // 1000
    return v


MAX_SPOT_USD_NANOS = 10_000_000_000_000_000
# Сколько монет уходит в общую выгрузку. Остальные достаются поиском.
FLOW_ROWS = 40
# Нижняя граница — та же, что в saveTrade бота: $50.
MIN_TRADE_USD_NANOS = 50_000_000_000
HL_MIN_CLOSED = 5
HL_MAX_CLOSED_30D = 200
DIR_OPEN_LONG, DIR_OPEN_SHORT = 1, 2
# Коды направления те же, что проставляет бот в hyperliquid_core.cpp.
# Переворот (5) закрывает одну сторону и тут же открывает другую, а какую
# именно — из кода не видно: «Long > Short» и «Short > Long» оба пишутся
# пятёркой.
DIR_CLOSE_LONG, DIR_CLOSE_SHORT, DIR_FLIP = 3, 4, 5
DIR_LIQ_LONG, DIR_LIQ_SHORT, DIR_LIQ_OTHER = 6, 7, 8


FLOW_BUCKETS = 12
# От скольких сделок корзины меряются от первой сделки токена, а не от начала
# окна. Ниже порога интереснее не форма накопления (её там нет), а момент:
# когда именно внутри окна это произошло.
FLOW_DENSE = 3


# Линии монет: ключ — длина окна и адрес. Страницу листают туда-сюда, и
# пересчитывать одни и те же сорок линий на каждый шаг незачем.
_FLOW_SP: dict[tuple[int, str], tuple[float, list[float]]] = {}
_flow_sp_lock = threading.Lock()


def flow_series(cur: sqlite3.Connection, tokens: list[str], since: int,
                sec: int, buckets: int = FLOW_BUCKETS) -> dict[str, list[float]]:
    """Накопленный поток денег по каждому токену внутри окна.

    Именно накопленный, а не поокошный: линия тогда заканчивается ровно там,
    где стоит итоговое число, и её направление уже не может ему противоречить.

    У монеты с тремя и более сделками корзины считаются от её первой сделки, а
    не от начала окна. Иначе у монеты, по которой за месяц прошло три сделки за
    один день, одиннадцать корзин из двенадцати были нулевыми, и все такие
    линии выглядели одинаково: полка, ступенька, полка.

    А вот при одной-двух сделках формы накопления нет в принципе, и растягивать
    её от первой сделки незачем — получится ровная полка. Такие корзины меряем
    по всему окну: ступенька встаёт туда, когда сделка на самом деле прошла, и
    линия сообщает хотя бы это.

    Линия начинается с нуля: первая точка — пустой баланс до первой сделки.
    Без неё монета с единственной сделкой рисовалась горизонтальной чертой на
    итоговом значении, будто ничего и не происходило.
    """
    if not tokens:
        return {}

    out: dict[str, list[float]] = {}
    fresh = time.monotonic()
    with _flow_sp_lock:
        for tok in tokens:
            hit = _FLOW_SP.get((sec, tok))
            if hit and fresh - hit[0] < FLOW_ROWS_TTL:
                out[tok] = hit[1]
    tokens = [t for t in tokens if t not in out]
    if not tokens:
        return out

    marks = ",".join("?" * len(tokens))
    try:
        rows = cur.execute(
            f"SELECT t.token, t.timestamp ts, "
            f"CASE WHEN t.is_buy=1 THEN t.usd_nanos ELSE -t.usd_nanos END net "
            f"FROM trades t WHERE t.timestamp >= ? AND t.usd_nanos BETWEEN ? AND ? "
            f"AND t.token IN ({marks}) ORDER BY t.token, t.timestamp",
            (since, MIN_TRADE_USD_NANOS, MAX_SPOT_USD_NANOS, *tokens),
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] flow series: {e}\n")
        return out

    per: dict[str, list[tuple[int, float]]] = {}
    for r in rows:
        per.setdefault(r["token"] or "", []).append((int(r["ts"] or 0), usd(r["net"])))

    end = now()
    for tok, pts in per.items():
        if not pts:
            continue
        start = pts[0][0] if len(pts) >= FLOW_DENSE else max(0, since)
        if start <= 0 or start >= end:
            start = pts[0][0]
        width = max(1, end - start)
        step = max(1, width // buckets)
        arr = [0.0] * buckets
        for ts, v in pts:
            i = min(buckets - 1, max(0, (ts - start) // step))
            arr[i] += v
        acc, run = [0.0], 0.0
        for v in arr:
            run += v
            acc.append(round(run, 2))
        out[tok] = acc
    with _flow_sp_lock:
        stamp = time.monotonic()
        for tok in tokens:
            _FLOW_SP[(sec, tok)] = (stamp, out.get(tok) or [])
        cap_cache(_FLOW_SP, 8192)
    return out


PX_FLOOR = {
    "BTC": 5_000.0,
    "ETH": 200.0,
    "SOL": 10.0,
    "BNB": 100.0,
    "XRP": 0.2,
    "HYPE": 1.0,
}


def _px_ok(sym: str, px: float) -> bool:
    try:
        v = float(px or 0)
    except (TypeError, ValueError):
        return False
    if v <= 0:
        return False
    floor = PX_FLOOR.get((sym or "").upper())
    if floor is None:
        return True
    return v >= floor


def _looks_spark(vals: list) -> bool:
    if not vals or len(vals) < 2:
        return False
    try:
        xs = [float(v) for v in vals]
    except (TypeError, ValueError):
        return False
    return min(xs) >= 0 and max(xs) <= 130


def _as_spark(vals: list, last: float) -> list[float]:
    if not vals:
        return []
    try:
        px = float(last or 0) or float(vals[-1] or 0)
    except (TypeError, ValueError):
        return []
    if px <= 0:
        return []
    if _looks_spark(vals) and px > 200:
        return [max(0.0, min(130.0, float(v))) for v in vals]
    out: list[float] = []
    for v in vals:
        try:
            p = float(v)
        except (TypeError, ValueError):
            continue
        if p <= 0:
            continue
        out.append(round(max(0.0, min(140.0, (p / px - 0.9) * 220.0)), 3))
    return out


def _down(vals: list[float], n: int) -> list[float]:
    if not vals:
        return []
    if len(vals) <= n:
        return vals
    last = n - 1
    return [vals[int(round(i * (len(vals) - 1) / last))] for i in range(n)]


def _chg_at(pts: list[tuple[int, float]], hours: int) -> float:
    if len(pts) < 2:
        return 0.0
    last_t, last_p = pts[-1]
    if last_p <= 0:
        return 0.0
    want = last_t - hours * 3600
    prev = pts[0][1]
    for t, p in pts:
        if t <= want:
            prev = p
        else:
            break
    if prev <= 0:
        return 0.0
    return round(100.0 * (last_p - prev) / prev, 2)


def _ensure_addr_map(cur: sqlite3.Connection) -> None:
    if _addr_by_sym or not table_exists(cur, "token_cache"):
        return
    try:
        rows = cur.execute("SELECT address, symbol FROM token_cache").fetchall()
    except sqlite3.Error:
        return
    for r in rows:
        s = str(r["symbol"] or "").upper().strip()
        a = str(r["address"] or "").lower()
        if s and s != "UNKNOWN" and a.startswith("0x") and len(a) >= 40:
            _addr_by_sym.setdefault(s, a)


def addr_of_sym(cur: sqlite3.Connection, sym: str, token: str = "") -> str:
    tok = (token or "").lower()
    if tok.startswith("0x") and len(tok) >= 40:
        return tok
    _ensure_addr_map(cur)
    return _addr_by_sym.get((sym or "").upper(), "")


def token_series(cur: sqlite3.Connection, addr: str, days: int = 90) -> list[list]:
    """
    Почасовые цены токена за три месяца — из той же таблицы, что кормит
    карточку монеты. Бот пишет по точке в час и держит их девяносто дней,
    так что из них собираются настоящие свечи: четырёхчасовые, дневные,
    недельные. Часовых свечей отсюда не бывает — точка в час это одна цена,
    у такой «свечи» нет ни тела, ни теней.
    """
    if not addr or not table_exists(cur, "token_price_history"):
        return []
    try:
        rows = cur.execute(
            "SELECT ts, price_nanos FROM token_price_history "
            "WHERE address=? AND ts>=? AND price_nanos>0 ORDER BY ts",
            (addr, now() - days * 86400),
        ).fetchall()
    except sqlite3.Error:
        return []
    return [[int(r["ts"]), usd(r["price_nanos"])] for r in rows if r["price_nanos"]]


def hist_spot(cur: sqlite3.Connection, addr: str) -> list[tuple[int, float]]:
    if not addr or not table_exists(cur, "token_price_history"):
        return []
    hit = _px_hist.get(addr)
    if hit and time.monotonic() - hit[0] < 30:
        return hit[1]
    since = now() - 30 * 86400
    try:
        rows = cur.execute(
            "SELECT ts, price_nanos FROM token_price_history "
            "WHERE address=? AND ts>=? AND price_nanos>0 ORDER BY ts",
            (addr, since),
        ).fetchall()
    except sqlite3.Error:
        rows = []
    pts = [(int(r["ts"]), usd(r["price_nanos"])) for r in rows if r["price_nanos"]]
    pts = [(t, p) for t, p in pts if p > 0]
    _px_hist[addr] = (time.monotonic(), pts)
    return pts


def hl_mids() -> dict[str, float]:
    hit = _hl_cache.get("_mids")
    if hit and time.monotonic() - hit[0] < 20:
        return hit[1]
    raw = hl_post({"type": "allMids"}, timeout=3.0) or {}
    out: dict[str, float] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                out[str(k).upper()] = float(v)
            except (TypeError, ValueError):
                pass
    _hl_cache["_mids"] = (time.monotonic(), out)
    return out


def hist_perp(coin: str) -> list[tuple[int, float]]:
    key = (coin or "").upper()
    if not key:
        return []
    alias = HL_COIN.get(key, key)
    hit = _hl_candles.get(alias)
    if hit and time.monotonic() - hit[0] < 90:
        return hit[1]
    start = int((time.time() - 30 * 86400) * 1000)
    raw = hl_post(
        {
            "type": "candleSnapshot",
            "req": {"coin": alias, "interval": "1h", "startTime": start, "endTime": int(time.time() * 1000)},
        },
        timeout=3.0,
    )
    pts: list[tuple[int, float]] = []
    if isinstance(raw, list):
        for c in raw:
            if not isinstance(c, dict):
                continue
            try:
                px = float(c.get("c") or 0)
                ts = int(c.get("t") or 0)
            except (TypeError, ValueError):
                continue
            if px <= 0:
                continue
            if ts > 10_000_000_000:
                ts //= 1000
            pts.append((ts, px))
    pts.sort()
    _hl_candles[alias] = (time.monotonic(), pts)
    return pts


def _slices(pts: list[tuple[int, float]]) -> dict:
    if not pts:
        return {}
    tnow = pts[-1][0]
    def window(hours, n):
        cut = tnow - hours * 3600
        vals = [p for t, p in pts if t >= cut]
        if len(vals) < 2:
            vals = [p for _, p in pts[-max(2, n):]]
        return _down(vals, n)
    last = pts[-1][1]
    chg = _chg_at(pts, 24)
    return {
        "price": last,
        "chg": chg,
        "hists": {
            "1h": window(12, 12),
            "24h": window(24, 24),
            "7d": window(168, 28),
            "30d": window(720, 30),
        },
        "spark": window(24, 12),
        "c1": _chg_at(pts, 1),
        "c6": _chg_at(pts, 6),
        "c24": chg,
    }


def _sparkify(sl: dict, sym: str) -> dict:
    px = float(sl.get("price") or 0)
    if px <= 0:
        return sl
    hists = sl.get("hists") or {}
    out_h = {}
    for k, vals in hists.items():
        if not vals:
            out_h[k] = []
        elif _looks_spark(vals) and _px_ok(sym, px):
            out_h[k] = [float(v) for v in vals]
        else:
            out_h[k] = _as_spark(vals, px)
    sl["hists"] = out_h
    sp = sl.get("spark") or []
    if sp and not (_looks_spark(sp) and _px_ok(sym, px)):
        sl["spark"] = _as_spark(sp, px)
    return sl


def price_pack(cur: sqlite3.Connection, hl: sqlite3.Connection | None, sym: str, token: str = "", http: bool = False) -> dict:
    key = (sym or "").upper()
    addr = addr_of_sym(cur, sym, token)
    pts = hist_spot(cur, addr) if addr else []
    last = pts[-1][1] if pts else 0.0
    want_perp = (
        http
        or key in PX_FLOOR
        or len(pts) < 3
        or not _px_ok(key, last)
        or _looks_spark([p for _, p in pts])
    )
    if want_perp:
        extra = hist_perp(sym)
        if extra and (not _px_ok(key, last) or len(extra) >= max(3, len(pts))):
            pts = extra
    sl = _slices(pts)
    mids = hl_mids()
    mid = mids.get(key, 0.0)
    if mid > 0 and (not sl or not _px_ok(key, sl.get("price") or 0)):
        if sl:
            sl["price"] = mid
        else:
            # Истории нет — живая цена есть, а изменения неизвестны. Ноль
            # здесь был бы враньём: на экране он читается как «цена не
            # двигалась», и рядом с графиком, где за сутки восемь процентов,
            # это видно сразу. None доедет до приложения как прочерк.
            sl = {"price": mid, "chg": None, "hists": {}, "spark": [],
                  "c1": None, "c6": None, "c24": None}
    if not sl:
        return {}
    sl = _sparkify(sl, key)
    sl["addr"] = addr
    sl["icon"] = coin_icon(sym, addr)
    sl["real"] = True
    return sl


ALERT_KEEP_SEC = 2 * 86400
ALERT_HISTORY_MAX = 200


def alert_text(msg: str) -> str:
    """Текст алерта как он пришёл бы в чат, без разметки Telegram.

    Строки сохраняются: алерт бота — это несколько строк (кто, что, сколько,
    ссылка), и сплющенный в одну он не читается.
    """
    t = re.sub(r"<br\s*/?>", "\n", msg or "", flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in t.split("\n")]
    out: list[str] = []
    for ln in lines:
        if ln or (out and out[-1]):
            out.append(ln)
    return "\n".join(out).strip()


def alert_prefs(con: sqlite3.Connection, chat: str) -> tuple[bool, int]:
    """Куда слать алерты и когда человек последний раз открыл историю.

    Колонки заводит бот; если он ещё старый — по умолчанию «в Telegram» и
    «ничего не видел»."""
    cset = cols(con, "users") if table_exists(con, "users") else set()
    if "alert_tg" not in cset:
        return True, 0
    row = con.execute(
        "SELECT alert_tg, alerts_seen_at FROM users WHERE chat_id=?", (chat,)
    ).fetchone()
    if not row:
        return True, 0
    return bool(int(row["alert_tg"] if row["alert_tg"] is not None else 1)), int(row["alerts_seen_at"] or 0)


def ensure_alert_cols(con: sqlite3.Connection) -> None:
    """Те же колонки, что заводит бот (main.cpp): API может обновиться раньше."""
    cset = cols(con, "users")
    for name, ddl in (("alert_tg", "INTEGER NOT NULL DEFAULT 1"),
                      ("alerts_seen_at", "INTEGER NOT NULL DEFAULT 0")):
        if name not in cset:
            try:
                con.execute(f"ALTER TABLE users ADD COLUMN {name} {ddl}")
            except sqlite3.OperationalError:
                pass  # бот успел первым


def unread_alerts(con: sqlite3.Connection, chat: str, seen_at: int) -> int:
    if not (table_exists(con, "alerts") and table_exists(con, "deliveries")):
        return 0
    row = con.execute(
        "SELECT COUNT(*) FROM alerts a JOIN deliveries d ON d.alert_id=a.id "
        "WHERE d.chat_id=? AND a.created_at>? AND a.created_at>=?",
        (chat, seen_at, now() - ALERT_KEEP_SEC),
    ).fetchone()
    return int(row[0] or 0)


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
    alert_tg, seen_at = alert_prefs(cur, chat)
    unread = unread_alerts(cur, chat, seen_at)
    service = is_service(chat)
    if service:
        # Бессрочно: срока нет, и «осталось дней: 0» было бы неправдой.
        plan, prem_until = "premium", 0
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
        "limit": SERVICE_MAX_WALLETS if service else (50 if plan == "premium" else 1),
        "service": service,
        "alertTg": alert_tg,
        "unread": unread,
        "threshold": thr,
        "lang": lang,
        "alertsToday": int(alerts_today or 0),
        "alerts30d": int(alerts_30 or 0),
        "premUntil": prem_until,
        "updatedKey": "justNow",
    }


ZERO_EQUITY = {"total": 0.0, "spot": 0.0, "perp": 0.0, "hip3": 0.0, "vaults": 0.0}


def spot_open(cur: sqlite3.Connection, addr: str, dust: float = 50.0) -> list[dict]:
    """
    Покупки на BSC, ещё не проданные полностью.

    Учёт тот же, что в ranking.cpp: покупка добавляет количество и стоимость,
    продажа списывает их пропорционально. Осталось количество — значит токен
    у кошелька на руках, и это ровно то, о чём приходил алерт.

    Количество в базе лежит в атомах токена, а сколько у него знаков после
    запятой — не записано. Поэтому цены считаем на атом и переводим в
    привычные множителем 10^n: показатель берётся из отношения цены в
    истории к цене последней сделки и округляется до целой степени десяти —
    знаков после запятой не бывает дробное число, и округление снимает
    разницу между моментами замера.
    """
    if not table_exists(cur, "trades"):
        return []
    try:
        rows = cur.execute(
            "SELECT token, is_buy, usd_nanos, token_amount, timestamp FROM trades "
            "WHERE wallet=? ORDER BY token, timestamp, id",
            (addr,),
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] spot_open: {e}\n")
        return []

    held: dict[str, dict] = {}
    for r in rows:
        tok = r["token"] or ""
        try:
            amt = int(str(r["token_amount"] or "0").strip())
        except (TypeError, ValueError):
            continue
        if amt <= 0 or not tok:
            continue
        usd_n = int(r["usd_nanos"] or 0)
        h = held.setdefault(
            tok, {"qty": 0, "cost": 0, "first": 0, "last": 0, "buys": 0, "partial": False}
        )
        if r["is_buy"]:
            h["qty"] += amt
            h["cost"] += usd_n
            h["buys"] += 1
            h["first"] = h["first"] or int(r["timestamp"] or 0)
            h["last"] = int(r["timestamp"] or 0)
        else:
            # Продали больше, чем мы видели купленным, — значит часть монет
            # пришла раньше, чем кошелёк попал под наблюдение. Сделки живут
            # год, и до этого о кошельке мы не знали ничего. Дописать чужое
            # прошлое неоткуда, но сам факт виден, и о нём надо сказать.
            if amt > h["qty"]:
                h["partial"] = True
            take = min(amt, h["qty"])
            if take > 0:
                h["cost"] -= h["cost"] * take // h["qty"]
                h["qty"] -= take

    out = []
    for tok, h in held.items():
        if h["qty"] <= 0 or h["cost"] <= 0:
            continue
        pts = hist_spot(cur, tok)
        price = pts[-1][1] if pts else 0.0
        if price <= 0:
            continue
        dec = token_decimals(cur, tok)
        if dec:
            scale = 10 ** dec
        else:
            # Знаков в базе нет — восстанавливаем по данным: во сколько раз
            # привычная цена больше цены за атом. Их целое число, поэтому
            # округляем до степени десяти; это снимает и разницу во времени
            # замеров, и шум медианы.
            px_atom = token_px_atom(cur, tok)
            if px_atom <= 0:
                continue
            scale = 10 ** round(math.log10(price / px_atom))
        if not 1 <= scale <= 10 ** 30:
            continue
        qty = h["qty"] / scale                    # штуки, а не атомы
        if qty <= 0:
            continue
        cost = usd(h["cost"])
        value = qty * price
        # Смотрим на остаток, а не на вложенное: хвост в пару долларов от
        # распроданной позиции держат не нарочно, и списку он только мешает.
        if value < dust:
            continue
        pct = (value - cost) / cost * 100.0 if cost else 0.0
        # Заслон от мусора в базе: рост в сто раз бывает, в сто тысяч — нет.
        # Лучше не показать строку, чем написать «+222 000 000 000 000 %».
        if not -100.0 <= pct <= 100_000.0:
            sys.stderr.write(f"[api] spot {tok[:12]}: странная доходность {pct:.0f}%, пропуск\n")
            continue
        out.append({
            "token": tok,
            "sym": symbol_of(cur, tok) or short_addr(tok),
            "icon": coin_icon(symbol_of(cur, tok), tok),
            "cost": cost,
            "value": value,
            "pnl": value - cost,
            "pct": pct,
            "entry": cost / qty,
            "price": price,
            "buys": h["buys"],
            "partial": h["partial"],
            "since": h["first"],
        })
    out.sort(key=lambda x: -x["value"])
    return out[:20]


def token_decimals(cur: sqlite3.Connection, token: str) -> int:
    """Знаки после запятой из token_cache — их туда пишет бот при разборе
    токена. Есть настоящее значение — незачем его угадывать."""
    if not table_exists(cur, "token_cache"):
        return 0
    if "decimals" not in cols(cur, "token_cache"):
        return 0
    try:
        r = cur.execute(
            "SELECT decimals FROM token_cache WHERE lower(address)=?", (token.lower(),)
        ).fetchone()
    except sqlite3.Error:
        return 0
    d = int((r["decimals"] if r else 0) or 0)
    return d if 0 < d <= 30 else 0


def token_px_atom(cur: sqlite3.Connection, token: str, n: int = 25) -> float:
    """
    Цена токена за один атом — медиана по последним сделкам.

    По одной последней сделке считать нельзя: одна строка с крошечным
    количеством задирала цену на девять порядков, и покупка на $923
    показывалась как два триллиона долларов прибыли. Медиана двух десятков
    сделок к такой строке равнодушна.
    """
    try:
        rows = cur.execute(
            "SELECT usd_nanos, token_amount FROM trades WHERE token=? AND usd_nanos>0 "
            "ORDER BY timestamp DESC, id DESC LIMIT ?",
            (token, n),
        ).fetchall()
    except sqlite3.Error:
        return 0.0
    px = []
    for r in rows:
        try:
            amt = int(str(r["token_amount"] or "0").strip())
        except (TypeError, ValueError):
            continue
        if amt > 0:
            px.append(usd(r["usd_nanos"]) / amt)
    if not px:
        return 0.0
    px.sort()
    return px[len(px) // 2]


def wallet_live(cur: sqlite3.Connection, chat: str, addr: str) -> dict:
    """
    Позиции и остаток одного кошелька — живьём из Hyperliquid.

    Отдаём только свой: адрес сверяется со списком пользователя, иначе по
    чужому адресу можно было бы смотреть чей угодно счёт.
    """
    key = (addr or "").strip().lower()
    if not re.fullmatch(r"0x[0-9a-f]{40}", key):
        return {"ok": False, "error": "bad_addr"}
    if not table_exists(cur, "user_whales"):
        return {"ok": False, "error": "not_found"}
    own = cur.execute(
        "SELECT 1 FROM user_whales uw JOIN whale_addresses wa ON wa.id=uw.whale_id "
        "WHERE uw.user_id=? AND lower(wa.address)=?",
        (chat, key),
    ).fetchone()
    if not own:
        return {"ok": False, "error": "not_found"}
    try:
        pos, equity, _ = parse_positions(key)
    except Exception as e:
        sys.stderr.write(f"[api] wallet {key[:10]}: {e}\n")
        return {"ok": False, "error": "upstream"}
    stats = wallet_stats(cur, key)
    bal = equity.get("total") or stats["bal"] or 0
    return {
        "ok": True,
        "addr": key,
        "pos": pos,
        "holds": spot_open(cur, key),
        "equity": equity,
        "bal": bal,
        "d1": (stats["net"] / bal * 100.0) if bal else 0.0,
    }


def load_wallets(cur: sqlite3.Connection, chat: str,
                 hl: sqlite3.Connection | None = None) -> list[dict]:
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
    # Кто из них торгует на Hyperliquid — видно по базе сделок, без сети.
    # Раньше площадку выдавали открытые позиции; теперь их в списке нет, и
    # без этого признака кошелёк с перпами подписывался бы BSC.
    on_hl: set[str] = set()
    addrs = [(r["addr"] or "").lower() for r in rows if r["addr"]]
    if hl and addrs and table_exists(hl, "hl_fills"):
        try:
            marks = ",".join("?" * len(addrs))
            for row in hl.execute(
                f"SELECT DISTINCT lower(wallet) w FROM hl_fills WHERE lower(wallet) IN ({marks})",
                addrs,
            ).fetchall():
                on_hl.add(row["w"])
        except sqlite3.Error as e:
            sys.stderr.write(f"[api] hl wallets: {e}\n")

    # В Hyperliquid за позициями отсюда не ходим. Список кошельков читают
    # при каждом открытии приложения, а два запроса на кошелёк по 400 мс
    # складывались в секунды ожидания — ради цифры, которую смотрят, только
    # когда откроют сам кошелёк. Позиции и остаток отдаёт /api/wallet.
    wallets = []
    for i, r in enumerate(rows):
        addr = (r["addr"] or "").lower()
        name = (r["label"] or "").strip() or short_addr(addr)
        pos, equity = [], dict(ZERO_EQUITY)
        stats = wallet_stats(cur, addr)
        bal = stats["bal"] or 0
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
                "hlActive": addr in on_hl,
                "pos": pos,
            }
        )
    if wallets and not any(w["primary"] for w in wallets):
        wallets[0]["primary"] = True
    return wallets


def wallet_stats(cur: sqlite3.Connection, addr: str) -> dict:
    out = {"score": 50, "bal": 0, "tr": 0, "win": 0, "pf": 1, "net": 0, "dd": 0, "spot": "—", "perp": "—", "d1": 0}
    if table_exists(cur, "trades"):
        row = cur.execute(
            "SELECT COUNT(*) c, "
            "SUM(CASE WHEN is_buy=1 THEN usd_nanos ELSE 0 END) buy, "
            "SUM(CASE WHEN is_buy=0 THEN usd_nanos ELSE 0 END) sell "
            "FROM (SELECT is_buy, usd_nanos FROM trades WHERE wallet=? "
            "ORDER BY rowid DESC LIMIT 300)",
            (addr,),
        ).fetchone()
        buy, sell = usd(row["buy"] if row else 0), usd(row["sell"] if row else 0)
        out["d1"] = 0.0
        out["tr"] = int(row["c"] or 0) if row else 0
        out["net"] = buy - sell
    return out


def load_alerts(cur: sqlite3.Connection, chat: str, wallets: list) -> tuple[list, list]:
    names = {w["addr"]: w["name"] for w in wallets}
    alerts, feed = [], []
    if not (table_exists(cur, "alerts") and table_exists(cur, "deliveries")):
        return alerts, feed
    # История — сколько бот её хранит: доставки чистятся через двое суток.
    rows = cur.execute(
        "SELECT d.id, d.status, a.message, a.created_at FROM alerts a "
        "JOIN deliveries d ON d.alert_id=a.id "
        "WHERE d.chat_id=? AND a.created_at>=? "
        "ORDER BY a.created_at DESC, d.id DESC LIMIT ?",
        (chat, now() - ALERT_KEEP_SEC, ALERT_HISTORY_MAX),
    ).fetchall()
    for r in rows:
        parsed = parse_alert(r["message"], r["created_at"], "")
        parsed["id"] = int(r["id"])
        parsed["ts"] = int(r["created_at"] or 0) * 1000
        parsed["text"] = alert_text(r["message"])
        # 6 — «только в приложении»: в чат не отправлялся и не отправится.
        parsed["tg"] = int(r["status"] or 0) != 6
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


# Лонг/шорт: во что заходят деньги на Hyperliquid.
#
# Считается по открытиям позиций, а не по всем сделкам. Закрытие лонга — это
# не ставка вниз, а снятие ставки вверх; смешав их, получили бы число, у
# которого нет смысла. «Сколько денег зашло в лонг и сколько в шорт» —
# вопрос про открытия, на него и отвечаем.
#
# Переворот позиции (dir_code 5) не участвует: и «лонг больше шорта», и
# «шорт больше лонга» пишутся одной пятёркой, направление из неё не достать.
_LS_ROWS: dict[str, tuple[float, list[dict]]] = {}
_ls_lock = threading.Lock()
_ls_busy: set[str] = set()


# Карта рынков Hyperliquid: что крипта, а что акции, индексы и металлы.
#
# Взять её из имени нельзя. Биржа зовёт такие инструменты «xyz:SP500», но в
# сделки они приходят коротким именем — «SP500», «CL», «XYZ100», — и по нему
# они неотличимы от монеты. Из-за этого раздел «Акции и металлы» показывал
# ноль строк, а нефть с индексом S&P лежали среди крипты.
#
# Поэтому спрашиваем саму биржу: список площадок HIP-3 и состав каждой. Имена
# оттуда, которых нет на основной площадке, и есть «не крипта». Вычитание
# обязательно: на HIP-3 торгуют и биткоином — «hyna:BTC», — и без него BTC
# уехал бы в акции.
_HL_FULL: dict[str, str] = {}
# Все полные имена, прописными: одна и та же бумага бывает на нескольких
# площадках — «io:ANTH» и «para:ANTH», — и отбору в SQL нужны они все.
_HL_NAMES: set[str] = set()
_hl_mkt_lock = threading.Lock()
_hl_mkt_at = 0.0
_hl_mkt_busy = False
HL_MARKETS_TTL = 6 * 3600.0


def hl_markets() -> dict[str, str]:
    """Короткое имя инструмента HIP-3 → полное, с приставкой площадки.

    Отдаёт то, что есть сейчас, и при устаревании обновляется в стороне:
    одиннадцать запросов к бирже не должны задерживать ни сборку кэша, ни
    тем более чей-то экран.
    """
    global _hl_mkt_busy
    with _hl_mkt_lock:
        fresh = time.monotonic() - _hl_mkt_at < HL_MARKETS_TTL
        if _HL_FULL and fresh:
            return _HL_FULL
        if not _hl_mkt_busy:
            _hl_mkt_busy = True
            threading.Thread(target=_hl_markets_load, daemon=True).start()
        return _HL_FULL


def hl_names() -> set[str]:
    """Полные имена инструментов HIP-3, прописными."""
    hl_markets()
    return _HL_NAMES


def _hl_markets_load() -> None:
    global _HL_FULL, _HL_NAMES, _hl_mkt_at, _hl_mkt_busy
    try:
        main = {
            str(c.get("name") or "").upper()
            for c in ((hl_post({"type": "meta"}) or {}).get("universe") or [])
        }
        dexes = [
            str(d.get("name") or "")
            for d in (hl_post({"type": "perpDexs"}) or [])
            if isinstance(d, dict) and d.get("name")
        ]
        out: dict[str, str] = {}
        names: set[str] = set()
        for dex in dexes:
            uni = (hl_post({"type": "meta", "dex": dex}) or {}).get("universe") or []
            for c in uni:
                full = str(c.get("name") or "")
                bare = full.split(":")[-1].upper()
                if not bare or bare in main:
                    continue
                out.setdefault(bare, full)
                names.add(full.upper())
        # Пустой ответ не затирает прошлую карту: сеть отвалилась — работаем
        # по той, что есть, это лучше, чем внезапно считать всё криптой.
        if out:
            with _hl_mkt_lock:
                _HL_FULL = out
                _HL_NAMES = names
                _hl_mkt_at = time.monotonic()
            sys.stderr.write(f"[api] рынки HIP-3: {len(out)} инструментов\n")
    except Exception as e:
        sys.stderr.write(f"[api] hl markets: {e}\n")
    finally:
        with _hl_mkt_lock:
            _hl_mkt_busy = False


# Справочник монет для поиска на экране графика.
#
# Поиск раньше шёл только по монетам, которые уже есть в приложении (кошельки,
# сигналы, NetFlow), и «DOT» не находился вовсе — казалось, что такой монеты
# нет. Теперь это всё, что торгуется парой к USDT на Binance и Bybit, плюс
# перпы Hyperliquid, включая акции, индексы и металлы площадок HIP-3. Каждая
# запись знает, где монета торгуется, — это видно в результатах поиска.
#
# Собирается в стороне и живёт шесть часов: листинги меняются редко, а три
# биржи на каждый запрос — это медленно и невежливо к ним.
SYMS_TTL = 6 * 3600.0
_SYMS: list[dict] = []
_syms_at = 0.0
_syms_busy = False
_syms_lock = threading.Lock()


def _symbols_build() -> list[dict]:
    venues: dict[str, set[str]] = {}
    extra: dict[str, dict] = {}

    def add(sym: str, venue: str) -> None:
        s = re.sub(r"[^A-Z0-9]", "", str(sym or "").upper())
        if 1 <= len(s) <= 20:
            venues.setdefault(s, set()).add(venue)

    for url in ("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT",
                "https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT"):
        bn = get_json(url, timeout=25.0)
        rows = (bn or {}).get("symbols") if isinstance(bn, dict) else None
        if rows:
            for x in rows:
                if x.get("quoteAsset") == "USDT" and x.get("status") == "TRADING":
                    add(x.get("baseAsset"), "binance")
            break
    bb = get_json("https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000", timeout=25.0)
    for x in (((bb or {}).get("result") or {}).get("list") or []) if isinstance(bb, dict) else []:
        if x.get("quoteCoin") == "USDT" and x.get("status") == "Trading":
            add(x.get("baseCoin"), "bybit")
    for c in ((hl_post({"type": "meta"}, timeout=15.0) or {}).get("universe") or []):
        if isinstance(c, dict) and not c.get("isDelisted"):
            add(c.get("name"), "hl")
    # Акции, индексы и металлы HIP-3: открывать их надо полным именем
    # (xyz:NVDA), иначе график искал бы монету NVDA к доллару.
    hl_markets()
    with _hl_mkt_lock:
        hip3 = dict(_HL_FULL)
    for bare, full in hip3.items():
        b = re.sub(r"[^A-Z0-9]", "", bare.upper())
        if b and b not in venues:
            extra[b] = {"s": b, "v": ["hl"], "t": full, "c": "rwa"}
    out = [{"s": k, "v": sorted(v)} for k, v in venues.items()]
    out.extend(extra.values())
    # Сначала то, что торгуется на большем числе бирж: у тикера-двойника
    # мелкой монеты в поиске меньше шансов обогнать настоящую.
    out.sort(key=lambda r: (-len(r["v"]), r["s"]))
    return out


def _symbols_refresh() -> None:
    global _SYMS, _syms_at, _syms_busy
    try:
        rows = _symbols_build()
        # Пустой ответ не затирает прошлый справочник: биржи не ответили —
        # ищем по вчерашнему, это лучше, чем ничего не находить.
        if rows:
            with _syms_lock:
                _SYMS = rows
                _syms_at = time.monotonic()
            sys.stderr.write(f"[api] справочник монет: {len(rows)}\n")
    except Exception as e:
        sys.stderr.write(f"[api] symbols: {e}\n")
    finally:
        with _syms_lock:
            _syms_busy = False


def symbols() -> list[dict]:
    """Справочник как есть; устаревший обновляется в фоне."""
    global _syms_busy
    with _syms_lock:
        stale = not _SYMS or time.monotonic() - _syms_at >= SYMS_TTL
        if stale and not _syms_busy:
            _syms_busy = True
            threading.Thread(target=_symbols_refresh, daemon=True).start()
        return _SYMS


# Разлоки монет: когда на рынок выходят токены команды, инвесторов и фондов.
#
# Всё считаем сами, ни от кого не завися. Платные календари (DefiLlama,
# CryptoRank, Tokenomist) и справочники вроде CoinGecko здесь не участвуют:
#
#   * расписание — условия вестинга из документации проекта (ссылка лежит
#     рядом, она же видна в приложении); даты и объёмы движок выводит из
#     этих условий, а не хранит списком;
#   * монеты в обороте — тоже наш расчёт: опорное значение на известную
#     дату («circ») плюс все наши же разлоки после неё. Поэтому доля считается
#     от оборота на момент разлока, а не на сегодня: помесячная выдача MON в
#     декабре меряется оборотом уже после ноябрьской годовщины;
#   * цена — средняя Hyperliquid, откуда приложение и так берёт все цены;
#     монету, которой там нет, — последней сделкой на споте крупной биржи.
#
# «m» — ежемесячная выдача: день месяца, первый и последний месяц, сколько
# и кому. «o» — разовая выдача: дата, сколько и кому. Время — полночь UTC:
# точный час проекты почти никогда не публикуют. Когда проект меняет
# условия, правится одна строка здесь.
#
# «est» — объёмы оценочные: проект не публикует точной помесячной раскладки
# и цифры сведены по открытым сводкам; в приложении такие помечены.
#
# Кому: team — команда и ранние участники, investors — инвесторы,
# treasury — казна компании, community — сообщество и экосистема,
# foundation — фонд, mixed — несколько групп сразу без раскладки.
UNLOCK_BOOK: list[dict] = [
    {"s": "ENA", "n": "Ethena",
     "src": "https://docs.ethena.fi/overview/ena/tokenomics",
     "est": True,
     # Инвесторы: остаток помесячного графика выдаётся одним разом
     # (решение фонда в августе 2026). Объём — оценка по прежнему графику.
     "circ": ("2026-09-27", 10_095_312_500),
     "plan": [("o", "2026-10-05", 1_410_000_000, "investors"),
              # Помесячно 2-го — 40,63 млн через фонд (так идёт выдача в 2026-м;
              # по документам это доля участников, 25% через год и 36 месяцев).
              # Дальше весны 2027 раскладку фонд не публиковал.
              ("m", 2, "2025-05", "2027-03", 40_630_000, "foundation")]},
    {"s": "2Z", "n": "DoubleZero",
     "src": "https://cryptoticker.io/en/doublezero-2z-unlock-dilution/",
     # 02.10.2026 разом: Jump, Malbec, институционалы и продажа валидаторам
     # 1,255 млрд, команда, участники и билдеры 0,4 млрд. С того же дня —
     # равномерно ~31,1 млн в неделю (здесь сложено по месяцам на 2-е):
     # инвесторам ~23,5 млн, команде ~7,7 млн, около трёх лет.
     "est": True,
     "circ": ("2026-09-27", 3_469_487_454),
     "plan": [("o", "2026-10-02", 1_255_000_000, "investors"),
              ("o", "2026-10-02", 400_000_000, "team"),
              ("m", 2, "2026-11", "2029-10", 101_700_000, "investors"),
              ("m", 2, "2026-11", "2029-10", 33_200_000, "team")]},
    {"s": "APT", "n": "Aptos",
     "src": "https://aptosfoundation.org/currents/aptos-tokenomics-overview",
     # Последняя выдача инвесторам и команде по четырёхлетнему графику.
     "circ": ("2026-09-27", 870_857_391),
     "plan": [("o", "2026-10-12", 3_960_000, "team"),
              ("o", "2026-10-12", 2_440_000, "investors"),
              ("o", "2026-10-12", 3_210_000, "community"),
              ("o", "2026-10-12", 1_700_000, "foundation"),
              # Эмиссия: с 2026 года стейкинг платит ~2,6% годовых вместо 5,19%
              # (жёсткий потолок 2,1 млрд) — около 23 млн APT в год.
              ("m", 1, "2026-10", None, 1_900_000, "emission", "est")]},
    {"s": "ARB", "n": "Arbitrum",
     "src": "https://docs.arbitrum.foundation/token-supply",
     # Команда 26,94% и инвесторы 17,53% от 10 млрд: четверть через год,
     # остальное равными долями 36 месяцев.
     "circ": ("2026-09-27", 6_785_574_605),
     "plan": [("m", 16, "2024-04", "2027-03", 56_125_000, "team"),
              ("m", 16, "2024-04", "2027-03", 36_520_000, "investors")]},
    {"s": "STRK", "n": "Starknet",
     "src": "https://docs.starknet.io/learn/protocol/strk",
     "circ": ("2026-09-27", 7_350_605_580),
     "plan": [("m", 15, "2025-04", "2027-03", 64_000_000, "team"),
              ("m", 15, "2025-04", "2027-03", 63_000_000, "investors"),
              # Эмиссия стейкинга: 1,6% × √(доля в стейкинге) от 10 млрд —
              # при ~8% в стейкинге около 45 млн STRK в год.
              ("m", 1, "2026-10", None, 3_750_000, "emission", "est")]},
    {"s": "ZK", "n": "ZKsync",
     "src": "https://docs.zknation.io/zk-token/zk-token",
     # Инвесторы 19,78% и команда 13,55% от 21 млрд: 3,6% в июне 2025,
     # остальное 36 месяцев до июня 2028.
     "circ": ("2026-09-27", 10_816_539_153),
     "plan": [("m", 17, "2025-07", "2028-06", 102_940_000, "investors"),
              ("m", 17, "2025-07", "2028-06", 70_500_000, "team")]},
    {"s": "EIGEN", "n": "EigenCloud",
     "src": "https://docs.eigenfoundation.org/eigen-token/key-info",
     # Инвесторы 29,5% и ранние участники 25,5% начального выпуска:
     # по 4% в месяц после годовой блокировки.
     "circ": ("2026-09-27", 927_642_651),
     "plan": [("m", 1, "2025-11", "2027-09", 19_750_000, "investors"),
              ("m", 1, "2025-11", "2027-09", 17_070_000, "team"),
              # Эмиссия: 4% начального выпуска в год стейкерам и операторам.
              ("m", 1, "2026-10", None, 5_578_822, "emission")]},
    {"s": "MON", "n": "Monad",
     "src": "https://cryptoticker.io/en/monad-mon-unlock-lock-up-expiry/",
     "est": True,
     # Годовщина основной сети: команда получает 10,7 млрд сразу, инвесторы
     # и казна — 12/48 своей доли; дальше всё помесячно до ноября 2029.
     "circ": ("2026-09-27", 11_825_165_000),
     "plan": [("o", "2026-11-24", 10_700_000_000, "team"),
              ("o", "2026-11-24", 4_920_750_000, "investors"),
              ("o", "2026-11-24", 988_250_000, "treasury"),
              ("m", 24, "2026-12", "2029-11", 452_470_000, "team"),
              ("m", 24, "2026-12", "2029-11", 410_060_000, "investors"),
              ("m", 24, "2026-12", "2029-11", 82_350_000, "treasury"),
              # Эмиссия: 18 MON за блок (с июля 2026), около 1,9 млрд в год.
              ("m", 1, "2026-10", None, 157_700_000, "emission")]},
    {"s": "ONDO", "n": "Ondo",
     "src": "https://docs.ondo.foundation/ondo-token",
     "circ": ("2026-09-27", 4_869_330_647),
     "plan": [("o", "2027-01-18", 1_940_000_000, "mixed"),
              ("o", "2028-01-18", 1_940_000_000, "mixed")]},
    {"s": "PYTH", "n": "Pyth Network",
     "src": "https://www.pyth.network/blog/understanding-the-pyth-tokenomics",
     # 85% выпуска заперто и выходит четырьмя равными частями через 6, 18,
     # 30 и 42 месяца после запуска (20 ноября 2023).
     "circ": ("2026-09-27", 7_874_959_375),
     "plan": [("o", "2027-05-20", 2_125_000_000, "mixed")]},
    {"s": "HYPE", "n": "Hyperliquid",
     "src": "https://cryptoticker.io/en/hyperliquid-hype-unlock-dilution/",
     # Ключевые участники: 238 млн после годовой блокировки, 24 равные
     # выдачи 6-го числа. Забирают на деле малую долю — это право, не продажа.
     "circ": ("2026-09-27", 222_445_714),
     "plan": [("m", 6, "2026-01", "2027-12", 9_920_000, "team")]},
    {"s": "SEI", "n": "Sei",
     "src": "https://www.sei.io/",
     # Команда: 20% от 10 млрд, помесячно 15-го до августа 2027.
     "circ": ("2026-09-27", 6_733_333_333),
     "plan": [("m", 15, "2024-09", "2027-08", 55_560_000, "team")]},
    {"s": "ZRO", "n": "LayerZero",
     "src": "https://cryptoticker.io/en/layerzero-zro-unlock-monthly-dilution/",
     # Стратегические партнёры 32,2% и команда 25,5%: год блокировки, потом
     # помесячно 20-го до мая 2027.
     "circ": ("2026-09-27", 353_313_325),
     "plan": [("m", 20, "2025-07", "2027-05", 14_000_000, "investors"),
              ("m", 20, "2025-07", "2027-05", 11_080_000, "team")]},
    {"s": "JTO", "n": "Jito",
     "src": "https://www.jito.network/",
     # Команда 24,5% и инвесторы 16,2%: последние выдачи 7-го, до ноября 2026.
     "circ": ("2026-09-27", 525_958_473),
     "plan": [("m", 7, "2025-01", "2026-11", 6_810_000, "team"),
              ("m", 7, "2025-01", "2026-11", 4_500_000, "investors")]},
    {"s": "PUMP", "n": "Pump.fun",
     "src": "https://cryptobriefing.com/pump-fun-pump-token-unlock-pressure/",
     # Команда 20% и инвесторы 13% от триллиона: четверть в июле 2026,
     # остальное 36 месяцев 12-го числа.
     "circ": ("2026-09-27", 465_964_405_618),
     "plan": [("m", 12, "2026-08", "2029-07", 4_166_670_000, "team"),
              ("m", 12, "2026-08", "2029-07", 2_708_330_000, "investors")]},
    {"s": "BERA", "n": "Berachain",
     "src": "https://docs.berachain.com/general/tokens/bera",
     "est": True,
     # Помесячно 6-го: инвесторы, команда, сообщество и экосистема. Конец —
     # по двухлетнему графику после годовщины запуска (февраль 2028).
     "circ": ("2026-09-27", 335_324_207),
     "plan": [("m", 6, "2026-03", "2028-01", 5_950_000, "investors"),
              ("m", 6, "2026-03", "2028-01", 2_920_000, "team"),
              ("m", 6, "2026-03", "2028-01", 4_390_000, "community"),
              # Эмиссия BGT (меняется на BERA один к одному): с 2026 года ~5%
              # в год против прежних ~8% — около 27 млн в год.
              ("m", 1, "2026-10", None, 2_250_000, "emission", "est")]},
    {"s": "SUI", "n": "Sui",
     "src": "https://blog.sui.io/sui-tokenomics/",
     "est": True,
     # Объём у Sui меняется от месяца к месяцу; до конца 2026 — около
     # 64 млн 1-го числа, дальше проект помесячной раскладки не публикует.
     "circ": ("2026-09-27", 4_096_537_146),
     "plan": [("m", 1, "2026-10", "2026-12", 64_200_000, "mixed")]},
    {"s": "OP", "n": "Optimism",
     "src": "https://community.optimism.io/op-token/op-token-overview",
     "est": True,
     "circ": ("2026-09-27", 2_299_624_975),
     "plan": [("m", 30, "2026-05", "2027-04", 31_340_000, "mixed")]},
    {"s": "TIA", "n": "Celestia",
     "src": "https://docs.celestia.org/learn/TIA/staking-governance-supply/",
     "est": True,
     # Линейная выдача, здесь сложена по месяцам — в последний день месяца.
     "circ": ("2026-09-27", 973_802_843),
     "plan": [("m", 31, "2025-11", "2027-09", 17_340_000, "mixed"),
              # Эмиссия стейкинга: ~2,5% годовых, около 55 млн TIA в год; ставка
              # снижается на 6,7% в год до 1,5%.
              ("m", 1, "2026-10", "2027-10", 4_580_000, "emission"),
              ("m", 1, "2027-11", None, 4_270_000, "emission", "est")]},
    {"s": "XPL", "n": "Plasma",
     "src": "https://www.plasma.org/docs/get-started/xpl/tokenomics",
     # Команда и инвесторы по 25% от 10 млрд: треть 25.09.2026, остальное
     # 24 месяца; экосистема 3,2 млрд — 36 месяцев. Всё — до 25.09.2028.
     "circ": ("2026-09-27", 4_533_333_333),
     "plan": [("m", 25, "2026-10", "2028-09", 69_444_444, "team"),
              ("m", 25, "2026-10", "2028-09", 69_444_444, "investors"),
              ("m", 25, "2025-10", "2028-09", 88_888_889, "community")]},
    {"s": "CRO", "n": "Cronos",
     "src": "https://crypto.com/en/market-updates/crypto-market-pulse-weekly-10-03-2025",
     # Стратегический резерв: 70 млрд, возвращённые голосованием в 2025-м,
     # выходят равными долями 60 месяцев, 17-го числа.
     "circ": ("2026-09-27", 49_746_917_935),
     "plan": [("m", 17, "2025-04", "2030-03", 1_166_666_667, "treasury")]},
    {"s": "WLD", "n": "World",
     "src": "https://world.org/blog/foundational-topics/tokenomics-milestone-wld-unlock-rate-to-decrease-by-43-in-july",
     "est": True,
     # Выдача ежедневная: с 24.07.2026 — 1,3 млн в день инвесторам и команде
     # TFH и 1,6 млн сообществу. Здесь сложена по месяцам на 1-е число;
     # следующее снижение ставки проект пока не объявлял — считаем на год.
     "circ": ("2026-09-27", 3_716_605_842),
     "plan": [("m", 1, "2026-10", "2027-07", 39_540_000, "investors"),
              ("m", 1, "2026-10", "2027-07", 48_670_000, "community")]},
    {"s": "ASTER", "n": "Aster",
     "src": "https://www.kucoin.com/news/flash/aster-extends-team-token-unlock-period-for-400m-aster-until-september-2027",
     "est": True,
     # Команда: 400 млн заперты до 17.09.2027, дальше по 10 млн в месяц.
     # Экосистема с 2026-го выходит только наградами за стейкинг.
     "circ": ("2026-09-27", 2_710_487_455),
     "plan": [("m", 17, "2027-09", "2030-12", 10_000_000, "team")]},
    {"s": "LIT", "n": "Lighter",
     "src": "https://insights.unlocks.app/lighter-lit-tokenomics-robinhood-hype-a-real-burn-and-the-december-2026-cliff-2/",
     "est": True,
     # Команда 26% и инвесторы 24% от миллиарда: год блокировки до
     # 27.12.2026, потом три года равномерно (~3,2 млн в неделю). Здесь
     # сложено по месяцам на 27-е.
     "circ": ("2026-09-27", 250_000_000),
     "plan": [("m", 27, "2027-01", "2029-12", 7_222_222, "team"),
              ("m", 27, "2027-01", "2029-12", 6_666_667, "investors")]},
    {"s": "MOVE", "n": "Movement",
     "src": "https://www.movementnetwork.xyz/article/movement-foundation-move-token",
     "est": True,
     # Ранние инвесторы 22,5% и участники 17,5%: помесячно 9-го.
     "circ": ("2026-09-27", 4_495_833_333),
     "plan": [("m", 9, "2026-01", "2027-12", 92_580_000, "investors"),
              ("m", 9, "2026-01", "2027-12", 72_000_000, "team")]},
    {"s": "PENGU", "n": "Pudgy Penguins",
     "src": "https://www.coindesk.com/markets/2026/04/27/pudgy-penguins-rally-coincides-with-token-unlock-as-analyst-flags-exit-liquidity-risk",
     "est": True,
     "circ": ("2026-09-27", 62_860_396_090),
     "plan": [("m", 17, "2026-01", "2027-12", 723_000_000, "mixed")]},
    {"s": "KAITO", "n": "Kaito",
     "src": "https://cryptodaily.co.uk/2026/07/kaito-unlock-core-contributors-july-20",
     "est": True,
     "circ": ("2026-09-27", 241_388_889),
     "plan": [("m", 20, "2026-01", "2027-12", 6_940_000, "team"),
              ("m", 20, "2026-01", "2027-12", 10_860_000, "mixed")]},
    {"s": "TRUMP", "n": "Official Trump",
     "src": "https://tokenomist.ai/official-trump",
     "est": True,
     # Доли создателей и CIC Digital выходят до 18.12.2027; остаток после
     # августа 2026 (~279 млн) разложен поровну на оставшиеся месяцы.
     "circ": ("2026-09-27", 281_867_936),
     "plan": [("m", 18, "2026-09", "2027-12", 17_440_000, "team")]},
    {"s": "MANTA", "n": "Manta Network",
     "src": "https://www.coingabbar.com/en/crypto-blogs-details/crypto-token-unlocks-august-2026-full-breakdown",
     "est": True,
     "circ": ("2026-09-27", 482_016_891),
     "plan": [("m", 18, "2026-01", "2027-01", 3_490_000, "investors"),
              ("m", 18, "2026-01", "2027-01", 3_370_000, "community"),
              ("m", 18, "2026-01", "2027-01", 6_940_000, "mixed")]},
    {"s": "MYX", "n": "MYX Finance",
     "src": "https://www.coingabbar.com/en/crypto-blogs-details/crypto-token-unlocks-august-2026-full-breakdown",
     "est": True,
     "circ": ("2026-09-27", 235_212_849),
     "plan": [("m", 6, "2026-01", "2027-04", 8_330_000, "team"),
              ("m", 6, "2026-01", "2027-04", 7_290_000, "investors")]},
    {"s": "FF", "n": "Falcon Finance",
     "src": "https://cryptoticker.io/en/falcon-ff-unlock-lock-up-expiry/",
     # Год блокировки с запуска 29.09.2025, дальше каждый месяц 29-го
     # одинаковыми долями до июля 2029: экосистема, фонд, команда, инвесторы.
     "circ": ("2026-09-27", 3_140_000_000),
     "plan": [("m", 29, "2026-09", "2029-07", 75_000_000, "community"),
              ("m", 29, "2026-09", "2029-07", 60_000_000, "foundation"),
              ("m", 29, "2026-09", "2029-07", 55_555_556, "team"),
              ("m", 29, "2026-09", "2029-07", 12_500_000, "investors")]},
    {"s": "STABLE", "n": "Stable",
     "src": "https://docs.stable.xyz/en/reference/tokenomics/",
     "est": True,
     # Команда и инвесторы по 25% от 100 млрд: год блокировки до 08.12.2026,
     # дальше равномерно до декабря 2029 — у отметки года выходит четверть
     # их доли. Экосистема выходит помесячно (~0,89 млрд) до конца 2029.
     "circ": ("2026-09-27", 26_705_049_725),
     "plan": [("o", "2026-12-08", 6_250_000_000, "team"),
              ("o", "2026-12-08", 6_250_000_000, "investors"),
              ("m", 8, "2027-01", "2029-12", 520_833_333, "team"),
              ("m", 8, "2027-01", "2029-12", 520_833_333, "investors"),
              ("m", 8, "2026-01", "2029-12", 888_800_000, "community")]},
    {"s": "BEAT", "n": "Audiera",
     "src": "https://docs.audiera.fi/protocol-design/system-architecture/economic-flow/editor",
     # Миллиард, запуск 1.11.2025, выдачи 1-го числа. Сообщество 40% и фонд
     # 14% — 48 месяцев; советники 13,07% и команда 8% — год блокировки и
     # 36 месяцев; второй аирдроп 2% — после года четырьмя долями.
     "circ": ("2026-09-27", 341_766_666),
     "plan": [("m", 1, "2025-12", "2029-11", 8_333_333, "community"),
              ("m", 1, "2025-12", "2029-11", 2_916_667, "foundation"),
              ("m", 1, "2026-11", "2029-10", 3_630_556, "investors"),
              ("m", 1, "2026-11", "2029-10", 2_222_222, "team"),
              ("m", 1, "2026-11", "2027-02", 5_000_000, "community")]},
    {"s": "RIVER", "n": "River",
     "src": "https://www.bittime.com/en/blog/apa-itu-river-crypto",
     "est": True,
     # Сто миллионов, запуск 22.09.2025, выдачи раз в полгода — 22 марта и
     # 22 сентября. Команда 15% и советники 3%: год блокировки, потом 30
     # месяцев полугодовыми долями; фонд 10% — по миллиону раз в полгода.
     # График инвесторов (15%, 24 месяца) проект по долям не раскрывает.
     "circ": ("2026-09-27", 19_600_000),
     # Советники идут вместе с командой: 2,5 млн + 0,5 млн за раз.
     "plan": [("o", d, 3_000_000, "team") for d in (
                  "2027-03-22", "2027-09-22", "2028-03-22", "2028-09-22", "2029-03-22")]
             + [("o", d, 1_000_000, "foundation") for d in (
                  "2027-03-22", "2027-09-22", "2028-03-22", "2028-09-22",
                  "2029-03-22", "2029-09-22", "2030-03-22", "2030-09-22")]},
    {"s": "AVNT", "n": "Veranta (Avantis)",
     "src": "https://bingx.com/en/learn/article/what-is-avantis-avnt-rwa-and-how-does-it-work",
     "est": True,
     # Запуск 09.09.2025, выдачи 9-го. Инвесторы 266 млн — год блокировки,
     # потом 20 месяцев; команда 133 млн — год, потом 30 месяцев; награды
     # 286 млн — 42 месяца с запуска.
     "circ": ("2026-09-27", 354_800_647),
     "plan": [("m", 9, "2026-10", "2028-05", 13_300_000, "investors"),
              ("m", 9, "2026-10", "2029-03", 4_433_333, "team"),
              ("m", 9, "2025-10", "2029-03", 6_809_524, "community")]},
    {"s": "SOL", "n": "Solana",
     "src": "https://247wallst.com/investing/cryptocurrency/2026/09/26/solana-doubles-its-disinflation-implications-for-sol-supply/",
     "est": True,
     # Разлоков нет — давит эмиссия стейкинга. В сентябре 2026 — 3,63% в
     # год от ~635 млн (~23 млн SOL); с августа 2026 ставка снижается на 30%
     # в год, пол 1,5% — в первой половине 2029-го.
     "circ": ("2026-09-27", 587_781_945),
     "plan": [("m", 1, "2026-10", "2027-08", 1_920_000, "emission"),
              ("m", 1, "2027-09", "2028-08", 1_390_000, "emission"),
              ("m", 1, "2028-09", "2029-05", 990_000, "emission"),
              ("m", 1, "2029-06", None, 850_000, "emission")]},
    {"s": "ETH", "n": "Ethereum",
     "src": "https://ethereum.org/roadmap/merge/issuance/",
     "est": True,
     # Награды валидаторам ~2 800 ETH в день (~1 млн в год). Сжигание комиссий
     # в 2026-м мало, прирост предложения около 0,8% в год.
     "circ": ("2026-09-27", 122_087_473),
     "plan": [("m", 1, "2026-10", None, 85_000, "emission")]},
    {"s": "NEAR", "n": "NEAR Protocol",
     "src": "https://cryptorank.io/news/feed/de98d-near-protocol-near-slashes-inflation-to-2-5-after-successful-halving-upgrade",
     # С 30.10.2025 инфляция 2,5% в год — около 32 млн NEAR.
     "circ": ("2026-09-27", 1_307_529_810),
     "plan": [("m", 1, "2026-10", None, 2_670_000, "emission")]},
    {"s": "DOT", "n": "Polkadot",
     "src": "https://phemex.com/blogs/polkadot-halving-tokenomics-explained",
     # Разлоков у Polkadot нет — давит эмиссия. С 14.03.2026 выпуск ~56,88 млн
     # DOT в год (стейкинг и казна), здесь сложен по месяцам на 1-е число;
     # 14.03.2028 он снижается на 13,14%.
     "circ": ("2026-09-27", 1_704_879_082),
     "plan": [("m", 1, "2026-10", "2028-03", 4_740_000, "emission"),
              ("m", 1, "2028-04", None, 4_117_000, "emission")]},
    # --- По капитализации сверху вниз (сентябрь 2026) ---------------------
    {"s": "BTC", "n": "Bitcoin",
     "src": "https://en.bitcoin.it/wiki/Controlled_supply",
     # Разлоков нет — майнинг: 3,125 BTC за блок, ~144 блока в сутки
     # (450 BTC в день). Халвинг — около апреля 2028.
     "circ": ("2026-09-27", 20_090_481),
     "plan": [("m", 1, "2026-10", "2028-04", 13_690, "emission"),
              ("m", 1, "2028-05", None, 6_845, "emission")]},
    {"s": "XRP", "n": "XRP",
     "src": "https://crypto.news/how-ripples-xrp-escrow-works-monthly-unlock-explained/",
     "est": True,
     # Эскроу Ripple: 1-го числа открывается 1 млрд XRP, 60–80% Ripple в тот
     # же месяц кладёт обратно. На рынок остаётся ~200–300 млн — берём 250.
     "circ": ("2026-09-27", 62_879_209_849),
     "plan": [("m", 1, "2026-10", None, 250_000_000, "treasury")]},
    {"s": "TRX", "n": "TRON",
     "src": "https://trondao.org/research/tron-q1-2026-quarterly-report",
     "est": True,
     # Выпуск ~117 млн TRX в месяц, сжигание ~90 млн: чистый прирост в
     # 2026-м — 70–87 млн за квартал. Берём чистый, ~26 млн в месяц.
     "circ": ("2026-09-27", 94_972_937_401),
     "plan": [("m", 1, "2026-10", None, 26_000_000, "emission")]},
    {"s": "ZEC", "n": "Zcash",
     "src": "https://z.cash/learn/what-is-the-zcash-halving/",
     # Майнинг: 1,5625 ZEC за блок, 1 152 блока в сутки (1 800 ZEC в день).
     # Халвинг — около ноября 2028.
     "circ": ("2026-09-27", 16_954_918),
     "plan": [("m", 1, "2026-10", "2028-11", 54_750, "emission"),
              ("m", 1, "2028-12", None, 27_375, "emission")]},
    {"s": "DOGE", "n": "Dogecoin",
     "src": "https://dogecoin.com/dogepedia/faq/",
     # 10 000 DOGE каждую минуту, без потолка и халвингов.
     "circ": ("2026-09-27", 156_104_906_383),
     "plan": [("m", 1, "2026-10", None, 438_300_000, "emission")]},
    {"s": "LINK", "n": "Chainlink",
     "src": "https://coinpedia.org/news/chainlink-unlocks-19m-link-165m-moved-to-market/",
     "est": True,
     # Раз в квартал Chainlink выводит из некотирующихся адресов ~19–21 млн
     # LINK (часть — сразу на биржу). Точный день в квартале плавает.
     "circ": ("2026-09-27", 748_099_970),
     "plan": [("o", d, 19_000_000, "treasury") for d in (
                  "2026-10-01", "2027-01-01", "2027-04-01", "2027-07-01", "2027-10-01",
                  "2028-01-01", "2028-04-01", "2028-07-01", "2028-10-01")]},
    {"s": "XMR", "n": "Monero",
     "src": "https://www.getmonero.org/resources/moneropedia/tail-emission.html",
     # Хвостовая эмиссия навсегда: 0,6 XMR за блок, ~720 блоков в сутки.
     "circ": ("2026-09-27", 18_810_613),
     "plan": [("m", 1, "2026-10", None, 13_150, "emission")]},
    {"s": "ADA", "n": "Cardano",
     "src": "https://docs.cardano.org/about-cardano/explore-more/monetary-policy",
     "est": True,
     # Из резерва выходит 0,3% за эпоху (5 дней) — около 2% в год от
     # оборота, стейкерам и в казну.
     "circ": ("2026-09-27", 37_535_193_928),
     "plan": [("m", 1, "2026-10", None, 62_000_000, "emission")]},
    {"s": "BCH", "n": "Bitcoin Cash",
     "src": "https://en.wikipedia.org/wiki/Bitcoin_Cash",
     # Майнинг как у BTC: 3,125 BCH за блок, 144 блока в сутки. Халвинг —
     # около апреля 2028.
     "circ": ("2026-09-27", 20_095_599),
     "plan": [("m", 1, "2026-10", "2028-04", 13_690, "emission"),
              ("m", 1, "2028-05", None, 6_845, "emission")]},
    {"s": "LTC", "n": "Litecoin",
     "src": "https://litecoin.info/docs/key-concepts/halving",
     # Майнинг: 6,25 LTC за блок, 576 блоков в сутки (3 600 LTC в день).
     # Халвинг — около июля 2027.
     "circ": ("2026-09-27", 77_657_260),
     "plan": [("m", 1, "2026-10", "2027-07", 109_500, "emission"),
              ("m", 1, "2027-08", None, 54_750, "emission")]},
    {"s": "AVAX", "n": "Avalanche",
     "src": "https://www.stakingrewards.com/asset/avalanche/analytics",
     "est": True,
     # Награды стейкинга чеканятся под потолок 720 млн: ~6,6% годовых на
     # застейканные — около 15 млн AVAX в год. Комиссии сжигаются.
     "circ": ("2026-09-27", 469_753_866),
     "plan": [("m", 1, "2026-10", None, 1_250_000, "emission")]},
    {"s": "GRAM", "n": "Toncoin",
     "src": "https://www.dextools.io/tutorials/ton-tokenomics-toncoin-supply-distribution-inflation-guide-2026",
     "est": True,
     # Фонд «верующих»: ~1,31 млрд TON ранних майнеров и инвесторов выходят
     # помесячно с октября 2025 по октябрь 2028. Плюс эмиссия валидаторов
     # ~88 тыс. в день (половина комиссий сжигается).
     "circ": ("2026-09-27", 2_815_210_027),
     "plan": [("m", 28, "2025-11", "2028-10", 36_400_000, "investors"),
              ("m", 1, "2026-10", None, 2_680_000, "emission")]},
]
UNLOCK_WHO = ("team", "investors", "treasury", "community", "foundation", "mixed", "emission")

# Эмиссия — новые монеты сети (награды стейкинга, блоков), давит на цену так
# же, как разлок. У монет выше она записана строкой «emission»; у остальных
# её нет, и почему — сказано здесь. Новая монета в книге обязана попасть или
# туда, или сюда: это проверяет tools/cortex-guard.py.
NO_EMISSION = {
    "ENA": "выпуск 15 млрд создан сразу",
    "2Z": "валидаторам платят из платы подписчиков, а не выпуском",
    "ARB": "10 млрд созданы сразу; право DAO на 2% в год не используется",
    "ZK": "21 млрд под потолком, награды из готовых долей",
    "ONDO": "10 млрд созданы сразу",
    "PYTH": "10 млрд созданы сразу",
    "HYPE": "1 млрд, награды из заранее выделенной доли",
    "SEI": "награды стейкинга из заранее созданного резерва экосистемы",
    "ZRO": "1 млрд создан сразу",
    "JTO": "1 млрд создан сразу",
    "PUMP": "1 трлн создан сразу",
    "SUI": "10 млрд созданы сразу, награды из фонда субсидий",
    "OP": "инфляция 2% в год предусмотрена, но не включена",
    "XPL": "эмиссия 5% начнётся с внешними валидаторами — ещё не запущена",
    "CRO": "потолок 100 млрд, резерв уже учтён разлоками",
    "WLD": "10 млрд созданы сразу",
    "ASTER": "8 млрд созданы сразу, награды из доли экосистемы",
    "LIT": "1 млрд создан сразу",
    "MOVE": "10 млрд созданы сразу",
    "PENGU": "выпуск создан сразу",
    "KAITO": "1 млрд создан сразу",
    "TRUMP": "1 млрд создан сразу",
    "MANTA": "1 млрд создан сразу",
    "MYX": "1 млрд создан сразу",
    "FF": "10 млрд созданы сразу",
    "STABLE": "100 млрд созданы сразу",
    "BEAT": "1 млрд создан сразу",
    "RIVER": "100 млн созданы сразу",
    "AVNT": "1 млрд создан сразу, награды из доли",
    "XRP": "100 млрд созданы сразу, выход — только из эскроу Ripple",
    "LINK": "1 млрд создан сразу, выход — из некотирующихся адресов",
}
# Проверены по капитализации, но в календарь не попали: ни разлоков, ни
# эмиссии нет, или данных нет, которым можно верить. Держим списком, чтобы
# при проходе по рейтингу было видно, что монета не пропущена, а отсеяна.
UNLOCK_SKIPPED = {
    "BNB": "выпуск закончен, раз в квартал сжигание",
    "LEO": "без выпуска, выкупы и сжигание",
    "XLM": "инфляция отключена в 2019-м",
    "UNI": "выдачи закончились в 2024-м, инфляция не включена",
    "WBT": "токен биржи, графика выдач нет",
    "RAIN": "график раскрыт только в платных сервисах",
    "HBAR": "прогнозы выдач казны расходятся с фактом в 10–20 раз",
    "CC": "эмиссия раундами без опубликованной ставки",
}

# Эмиссия бессрочна: строка без последнего месяца тянется на столько вперёд.
EMISSION_MONTHS = 36


def _day_ts(y: int, m: int, d: int) -> int:
    """Полночь UTC; 31-е в коротком месяце становится последним днём."""
    import calendar
    d = min(d, calendar.monthrange(y, m)[1])
    return calendar.timegm((y, m, d, 0, 0, 0))


def _date_ts(s: str) -> int:
    y, m, d = (int(x) for x in s.split("-"))
    return _day_ts(y, m, d)


def _plan_steps(coin: dict, now: float | None = None) -> list[tuple[int, str, float, str, bool]]:
    """Все выдачи монеты по её условиям: (день, вид, сколько, кому, оценка).

    Последним элементом строки может стоять "est" — оценка именно этой
    выдачи, когда остальное у монеты точное. Месяц окончания None — строка
    бессрочная (эмиссия) и тянется на EMISSION_MONTHS вперёд от сегодня.
    """
    out = []
    for step in coin["plan"]:
        est = step[-1] == "est"
        step = step[:-1] if est else step
        if step[0] == "o":
            out.append((_date_ts(step[1]), "cliff", step[2], step[3], est))
            continue
        day, first, last, amt, who = step[1:]
        y, m = (int(x) for x in first.split("-"))
        if last is None:
            t = time.gmtime(now if now is not None else time.time())
            k = t.tm_year * 12 + t.tm_mon - 1 + EMISSION_MONTHS
            ly, lm = k // 12, k % 12 + 1
        else:
            ly, lm = (int(x) for x in last.split("-"))
        while (y, m) <= (ly, lm):
            out.append((_day_ts(y, m, day), "monthly", amt, who, est))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def unlock_events(now: float, book: list[dict] | None = None) -> list[dict]:
    """Будущие разлоки по книге, ближайшие первыми.

    Выдачи одной монеты в один день складываются в одно событие с раскладкой
    по получателям. У события есть «circ» — монеты в обороте накануне
    разлока по нашему же расчёту: опорное значение плюс всё, что книга
    выдала после опорной даты и до этого дня.
    """
    day0 = int(now // 86400 * 86400)
    out: list[dict] = []
    for coin in book if book is not None else UNLOCK_BOOK:
        by: dict[int, dict] = {}
        for ts, kind, amt, who, est in _plan_steps(coin, now):
            ev = by.setdefault(ts, {
                "sym": coin["s"], "name": coin["n"], "ts": ts, "tokens": 0.0,
                "kind": kind, "who": {}, "src": coin["src"],
                # Часть цифр — оценка по сводкам, а не условие из документов
                # проекта: приложение так и подписывает.
                "est": bool(coin.get("est")),
            })
            ev["tokens"] += amt
            ev["who"][who] = ev["who"].get(who, 0.0) + amt
            if est:
                ev["est"] = True
            # Разовая выдача в день регулярной — всё равно обвал предложения.
            if kind == "cliff":
                ev["kind"] = "cliff"
        anchor = coin.get("circ")
        base_ts = _date_ts(anchor[0]) if anchor else 0
        circ = float(anchor[1]) if anchor else 0.0
        for ts in sorted(by):
            ev = by[ts]
            ev["circ"] = round(circ) if anchor else None
            if anchor and ts > base_ts:
                circ += ev["tokens"]
            if ts >= day0:
                out.append(ev)
    return sorted(out, key=lambda e: (e["ts"], e["sym"]))


# Цена монеты, которой нет на Hyperliquid (CRO, MYX, RIVER), — последняя сделка на
# споте: Bybit, потом OKX, KuCoin, Gate, Bitget и MEXC — кто первым ответит. Пять минут в памяти,
# и неудача тоже: монеты без спота не должны каждый раз ждать трёх бирж.
SPOT_PX_TTL_S = 300.0
_spot_px_cache: dict[str, tuple[float, float]] = {}


def spot_px(sym: str) -> float:
    s = re.sub(r"[^A-Z0-9]", "", (sym or "").upper())
    if not s:
        return 0.0
    hit = _spot_px_cache.get(s)
    if hit and time.monotonic() - hit[0] < SPOT_PX_TTL_S:
        return hit[1]
    px = 0.0
    bb = get_json(f"https://api.bybit.com/v5/market/tickers?category=spot&symbol={s}USDT", timeout=5.0)
    for x in (((bb or {}).get("result") or {}).get("list") or []) if isinstance(bb, dict) else []:
        px = _fnum(x.get("lastPrice"))
    if not px:
        ok = get_json(f"https://www.okx.com/api/v5/market/ticker?instId={s}-USDT", timeout=5.0)
        for x in ((ok or {}).get("data") or []) if isinstance(ok, dict) else []:
            px = _fnum(x.get("last"))
    if not px:
        kc = get_json(f"https://api.kucoin.com/api/v1/market/orderbook/level1?symbol={s}-USDT", timeout=5.0)
        px = _fnum(((kc or {}).get("data") or {}).get("price")) if isinstance(kc, dict) else 0.0
    if not px:
        gt = get_json(f"https://api.gateio.ws/api/v4/spot/tickers?currency_pair={s}_USDT", timeout=5.0)
        for x in gt if isinstance(gt, list) else []:
            px = _fnum(x.get("last"))
    if not px:
        bg = get_json(f"https://api.bitget.com/api/v2/spot/market/tickers?symbol={s}USDT", timeout=5.0)
        for x in ((bg or {}).get("data") or []) if isinstance(bg, dict) else []:
            px = _fnum(x.get("lastPr"))
    if not px:
        mx = get_json(f"https://api.mexc.com/api/v3/ticker/price?symbol={s}USDT", timeout=5.0)
        px = _fnum((mx or {}).get("price")) if isinstance(mx, dict) else 0.0
    _spot_px_cache[s] = (time.monotonic(), px)
    return px


def _unlocks_build() -> dict:
    """Календарь разлоков с ценой и долей от оборота — сборка целиком.

    Не ответил Hyperliquid — список всё равно отдаётся, с количеством монет
    и долей оборота, без долларов. Цены монет, которых на Hyperliquid нет,
    спрашиваются у бирж все сразу, а не по одной: по одной это было по
    секунде-две на монету, и первый после паузы запрос ждал их все.
    """
    now = time.time()
    events = unlock_events(now)
    mids = hl_mids()
    need = sorted({e["sym"] for e in events if not mids.get(e["sym"])})
    spot: dict[str, float] = {}
    if need:
        with ThreadPoolExecutor(max_workers=min(8, len(need))) as pool:
            for sym, px in zip(need, pool.map(spot_px, need)):
                spot[sym] = px
    items = []
    for e in events:
        price = mids.get(e["sym"], 0.0) or spot.get(e["sym"], 0.0)
        circ = e["circ"]
        e["price"] = price or None
        e["usd"] = round(e["tokens"] * price) if price else None
        # Давление на цену — доля от того, что уже в обороте: 1% от оборота
        # у монеты с тонкой ликвидностью весит больше, чем круглая сумма.
        e["pct"] = round(e["tokens"] / circ * 100, 2) if circ else None
        e["mcap"] = round(circ * price) if circ and price else None
        items.append(e)
    return {"ok": True, "at": int(now), "priced": bool(mids), "items": items}


# Готовый календарь в памяти. Раньше он собирался на каждый запрос, и экран
# открывался секунды: цены с Hyperliquid живут двадцать секунд, биржевые —
# минуту, и первый запрос после них ждал сеть. Теперь запрос отдаёт готовое
# сразу, а свежее собирается в стороне раз в минуту.
UNLOCKS_TTL_S = 60.0
_UNL_READY: dict = {}
_unl_ready_at = 0.0
_unl_building = False
_unl_ready_lock = threading.Lock()


def _unlocks_refresh() -> None:
    global _UNL_READY, _unl_ready_at, _unl_building
    try:
        data = _unlocks_build()
        with _unl_ready_lock:
            # Без цен свежая сборка хуже прошлой с ценами — оставляем прошлую.
            if data["priced"] or not _UNL_READY:
                _UNL_READY = data
            _unl_ready_at = time.monotonic()
    except Exception as e:
        sys.stderr.write(f"[api] unlocks: {e}\n")
    finally:
        with _unl_ready_lock:
            _unl_building = False


def unlocks() -> dict:
    """Календарь из памяти; устаревший обновляется в фоне. Прошедшие дни
    отсекаются на каждом ответе — сборка могла случиться до полуночи."""
    global _unl_building
    with _unl_ready_lock:
        have = bool(_UNL_READY)
        if not have:
            _unl_building = True
    if not have:
        _unlocks_refresh()
    with _unl_ready_lock:
        if time.monotonic() - _unl_ready_at >= UNLOCKS_TTL_S and not _unl_building:
            _unl_building = True
            threading.Thread(target=_unlocks_refresh, daemon=True, name="unlocks").start()
        data = _UNL_READY
    day0 = int(time.time() // 86400 * 86400)
    return {**data, "items": [e for e in data.get("items", []) if e["ts"] >= day0]}


# Токенизированные металлы торгуются и обычным перпом, без двоеточия в имени.
# Держим список отдельно, чтобы они не оседали в крипте: XAU — золото, XAG —
# серебро, XPT — платина, XPD — палладий; остальное это их обёртки.
METAL_SYMS = {
    "XAU", "PAXG", "XAUT", "KAU", "GOLD",
    "XAG", "KAG", "SILVER",
    "XPT", "XPD",
}


def hl_full_name(sym: str) -> str:
    """Имя инструмента так, как его пишет биржа: «xyz:SP500».

    Контракта у перпов нет — это не токен, а рынок, — и единственное, что тут
    можно скопировать и куда-то вставить, это его полное имя.
    """
    key = (sym or "").upper().replace(" ", "")
    if not key:
        return ""
    if ":" in key:
        head, _, tail = key.partition(":")
        return f"{head.lower()}:{tail}"
    return HL_COIN.get(key) or hl_markets().get(key) or key


def coin_class(coin: str) -> str:
    """Крипта или «не крипта» — акции, индексы, металлы, сырьё.

    Главный признак — состав площадок HIP-3, взятый у самой биржи. Пока карта
    не загрузилась, работает запасное правило: двоеточие в имени и список
    тикеров металлов. Оно ловит меньше, зато не требует сети.
    """
    c = (coin or "").upper()
    # Имя приходит по-разному: у одних площадок с приставкой — «XYZ:CL», — у
    # других коротким. Смотрим в карту по короткому: в ней ключи такие.
    bare = c.split(":")[-1]
    # Металлы остаются металлами даже когда торгуются обычным перпом на
    # основной площадке: PAXG и XAUT это золото, а не монета сама по себе.
    if bare in METAL_SYMS:
        return "rwa"
    mkt = hl_markets()
    if mkt:
        # Приставка сама по себе ничего не решает: на HIP-3 торгуют и
        # биткоином, «HYNA:BTC», а он крипта. В карте таких имён нет —
        # они отсеяны по основной площадке, — поэтому ответ верный.
        return "rwa" if bare in mkt else "crypto"
    return "rwa" if ":" in c or c in METAL_SYMS else "crypto"


def ls_scan(hl: sqlite3.Connection | None, since: int) -> list[dict]:
    """Все монеты окна: сколько денег двинуло цену вверх и сколько вниз.

    Считается всё движение, а не одни открытия: закрытие позиции — такая же
    сделка на рынке, как и открытие, и ликвидация тоже. Раньше сюда шли
    только открытия, и карточка показывала «96% в лонге» в час, когда киты
    лонги как раз распродавали.
    """
    if not hl or not table_exists(hl, "hl_fills"):
        return []
    cset = cols(hl, "hl_fills")
    if "dir_code" not in cset:
        return []
    # Переворот позиции в dir_code потерял направление: и «Long > Short», и
    # «Short > Long» записаны одной пятёркой. Исходный текст лежит рядом, в
    # колонке dir, и по нему направление восстанавливается. Нет колонки —
    # перевороты просто не считаем, как было раньше.
    has_dir = "dir" in cset
    flip_up = " OR (dir_code=5 AND dir LIKE '%Short > Long%')" if has_dir else ""
    flip_dn = " OR (dir_code=5 AND dir LIKE '%Long > Short%')" if has_dir else ""
    flip_any = (" OR (dir_code=5 AND (dir LIKE '%Short > Long%' "
                "OR dir LIKE '%Long > Short%'))") if has_dir else ""
    ban = (
        "AND wallet NOT IN (SELECT wallet FROM hl_banned) "
        if table_exists(hl, "hl_banned")
        else ""
    )
    try:
        # Вверх тянут не только открытые лонги: закрытый шорт — это выкуп,
        # то есть та же покупка, а вынесенный по ликвидации шорт — выкуп
        # принудительный. Вниз — открытый шорт, закрытый лонг и вынесенный
        # лонг. Считать одни открытия значило не видеть распродажи вовсе:
        # кит мог сливать лонг на миллион, а карточка показывала «в лонге»,
        # потому что кто-то рядом открыл лонг на тысячу.
        #
        #   1 открыл лонг   4 закрыл шорт   7 вынесло шорт   → вверх
        #   2 открыл шорт   3 закрыл лонг   6 вынесло лонг   → вниз
        #
        # Код 8 — ликвидация, у которой сторона неизвестна: её не считаем
        # ни туда, ни сюда, приписывать наугад хуже, чем пропустить.
        rows = hl.execute(
            "SELECT coin, "
            f"SUM(CASE WHEN dir_code IN (1,4,7){flip_up} "
            "     THEN notional_nanos ELSE 0 END) lng, "
            f"SUM(CASE WHEN dir_code IN (2,3,6){flip_dn} "
            "     THEN notional_nanos ELSE 0 END) shrt, "
            "COUNT(DISTINCT wallet) w "
            "FROM hl_fills "
            "WHERE ts >= ? AND notional_nanos > 0 "
            f"AND (dir_code IN (1,2,3,4,6,7){flip_any}) "
            f"{ban}"
            "GROUP BY coin",
            (since * 1000,),
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] ls scan: {e}\n")
        return []

    out: list[dict] = []
    for r in rows:
        lng, shrt = usd(r["lng"]), usd(r["shrt"])
        total = lng + shrt
        if total <= 0:
            continue
        sym = str(r["coin"] or "?").upper()
        out.append({
            "sym": sym,
            # Полное имя — то, что можно скопировать. Считает сервер: у него
            # карта площадок, а в базе имя лежит вперемешку, с приставкой и без.
            "full": hl_full_name(sym),
            # Значок собирает сервер: только он знает, под каким полным именем
            # инструмент лежит у биржи.
            "icon": coin_icon(sym),
            "cls": coin_class(sym),
            "long": lng,
            "short": shrt,
            "net": lng - shrt,
            # Доля денег в лонге, в процентах. Читается без деления в уме:
            # 70 — семь десятых денег ставят на рост.
            "pct": round(lng / total * 100, 1),
            "w": int(r["w"] or 0),
        })
    # По обороту, а не по перекосу: монета с миллионом в лонге интереснее той,
    # где сто долларов и все в лонг.
    out.sort(key=lambda r: -(r["long"] + r["short"]))
    return out


def ls_rows_cached(hl: sqlite3.Connection | None, win: str) -> list[dict]:
    """Список монет окна из памяти, с фоновым обновлением — как у потока."""
    sec = FLOW_WINDOWS.get(win)
    if not sec:
        return []
    with _ls_lock:
        hit = _LS_ROWS.get(win)
        if hit:
            if time.monotonic() - hit[0] >= FLOW_ROWS_TTL and win not in _ls_busy:
                _ls_busy.add(win)
                threading.Thread(target=_ls_rebuild, args=(win, sec), daemon=True).start()
            return hit[1]
    rows = ls_scan(hl, now() - sec)
    ls_rows_put(win, rows)
    return rows


def ls_rows_put(win: str, rows: list[dict]) -> None:
    with _ls_lock:
        _LS_ROWS[win] = (time.monotonic(), rows)


def _ls_rebuild(win: str, sec: int) -> None:
    con = None
    try:
        con = open_db(HL_DB)
        if con:
            ls_rows_put(win, ls_scan(con, now() - sec))
    except Exception as e:
        sys.stderr.write(f"[api] ls rows {win}: {e}\n")
    finally:
        if con:
            try:
                con.close()
            except Exception:
                pass
        with _ls_lock:
            _ls_busy.discard(win)


def load_ls(hl: sqlite3.Connection | None) -> dict:
    """Лонг/шорт по окнам — в общую выгрузку, как и поток."""
    tnow = now()
    by_win = {}
    for key, sec in FLOW_WINDOWS.items():
        coins = ls_scan(hl, tnow - sec)
        ls_rows_put(key, coins)
        def totals(rows: list[dict]) -> dict:
            lng = sum(c["long"] for c in rows)
            shrt = sum(c["short"] for c in rows)
            return {
                "long": lng,
                "short": shrt,
                "net": lng - shrt,
                "pct": round(lng / (lng + shrt) * 100, 1) if lng + shrt > 0 else 0.0,
                "coins": len(rows),
            }

        # Итоги считаются отдельно для крипты и для акций с золотом: у них
        # разные размеры и разные настроения, и общая цифра, где сотня
        # миллионов биткоина смешана с парой миллионов в акциях, не говорит
        # ни о том, ни о другом.
        crypto = [c for c in coins if c["cls"] == "crypto"]
        rwa = [c for c in coins if c["cls"] == "rwa"]
        by_win[key] = {
            **totals(coins),
            "crypto": {**totals(crypto), "rows": [dict(c) for c in crypto[:FLOW_ROWS]]},
            "rwa": {**totals(rwa), "rows": [dict(c) for c in rwa[:FLOW_ROWS]]},
            "rows": [dict(c) for c in coins[:FLOW_ROWS]],
        }
    return by_win


def ls_search(hl: sqlite3.Connection | None, win: str, q: str, limit: int = 40,
              offset: int = 0, side: str = "all", cls: str = "crypto") -> dict:
    """Страница лонг/шорта: те же поиск, фильтр и смещение, что у потока."""
    if win not in FLOW_WINDOWS:
        return {"rows": [], "total": 0}
    limit = max(1, min(int(limit or 40), 100))
    offset = max(0, min(int(offset or 0), 5000))
    allrows = ls_rows_cached(hl, win)
    if cls in ("crypto", "rwa"):
        allrows = [r for r in allrows if r["cls"] == cls]
    needle = (q or "").strip().upper()
    if needle:
        allrows = [r for r in allrows if needle in (r["sym"] or "")]
    # «Лонг» и «шорт» здесь — перевес, а не знак: монета попадает в лонговые,
    # если больше половины денег зашло на рост.
    if side == "in":
        allrows = [r for r in allrows if r["pct"] >= 50]
    elif side == "out":
        allrows = [r for r in allrows if r["pct"] < 50]
    return {"rows": [dict(r) for r in allrows[offset:offset + limit]], "total": len(allrows)}


def load_flow(cur: sqlite3.Connection) -> dict:
    windows = (("1", 3600), ("6", 21600), ("24", 86400), ("168", 604800), ("720", 2592000))
    tnow = now()
    by_win = {}
    for key, sec in windows:
        coins = flow_scan(cur, tnow - sec)
        # Тот же список пригодится страницам и фильтрам — незачем считать его
        # там заново.
        flow_rows_put(key, coins)
        buy_t = sum(c["buy"] for c in coins)
        sell_t = sum(c["sell"] for c in coins)
        # Копии: строки показанной страницы обрастают логотипом, хвостом
        # адреса и линией, а в кэше должен лежать чистый результат обхода.
        shown = [dict(c) for c in coins[:FLOW_ROWS]]
        flow_finish(cur, shown, tnow - sec, sec)
        by_win[key] = {
            "net": buy_t - sell_t,
            # Число монет окна целиком, а не длина показанного куска.
            "coins": len(coins),
            "buy": buy_t,
            "sell": sell_t,
            # Сколько монет в притоке и сколько в оттоке. Одна крупная монета
            # способна увести общий итог в плюс, когда продают почти всё
            # остальное; счёт монет — единственное, что это показывает. Он же
            # служит счётчиком для отфильтрованного списка, поэтому число над
            # списком видно до первого запроса.
            "up": sum(1 for c in coins if c["net"] > 0),
            "dn": sum(1 for c in coins if c["net"] < 0),
            "tr": market_trend(cur, tnow - sec, sec),
            "rows": shown,
        }
    # Здесь стоял проход по всем показанным строкам с price_pack ради полей
    # c1, c6 и c24 — изменения цены за час, шесть часов и сутки. Их не читает
    # ни один экран: карточка монеты берёт эти числа из своего справочника
    # coins, а не из строки потока. А стоил проход дорого — двести вызовов,
    # каждый с выборкой истории цены, восемьдесят секунд на боевой базе. И
    # это на каждую перестройку тридцатисекундного кэша.
    #
    # Адрес контракта в строке уже есть: его кладёт flow_scan.
    return by_win


FLOW_WINDOWS = {"1": 3600, "6": 21600, "24": 86400, "168": 604800, "720": 2592000}


_SYM_MAP: dict[str, str] = {}
_SYM_MAP_AT = 0.0


def symbol_map(cur: sqlite3.Connection) -> dict[str, str]:
    """Все тикеры разом — вместо похода в базу на каждую строку.

    Отбор «у токена есть тикер» раньше стоял прямо в запросе, через EXISTS с
    lower() по обе стороны. lower() убивает индекс token_cache: на боевой
    базе один такой запрос занимал 109 секунд вместо 0,24, а выполнялся он
    по разу на каждое из пяти окон плюс столько же на подсчёт. Перестройка
    кэша не заканчивалась никогда, и приложение теряло сервер.

    Альтернатива — спрашивать тикер построчно, как symbol_of, — не лучше:
    двенадцать тысяч отдельных SELECT'ов это девять секунд. Один обход
    таблицы отдаёт тот же ответ за миллисекунды.
    """
    global _SYM_MAP, _SYM_MAP_AT
    if _SYM_MAP and time.time() - _SYM_MAP_AT < 60:
        return _SYM_MAP
    out: dict[str, str] = {}
    if table_exists(cur, "token_cache"):
        try:
            for a, sym in cur.execute("SELECT address, symbol FROM token_cache"):
                s = str(sym or "").upper().strip()
                if a and s and s != "UNKNOWN":
                    out[str(a).lower()] = s
        except sqlite3.Error as e:
            sys.stderr.write(f"[api] symbol map: {e}\n")
            return _SYM_MAP
    _SYM_MAP, _SYM_MAP_AT = out, time.time()
    return out


TREND_BUCKETS = 24


def market_trend(cur: sqlite3.Connection, since: int, sec: int,
                 buckets: int = TREND_BUCKETS) -> list[float]:
    """Накопленный поток по всему окну — одной линией на весь рынок.

    Считается по тем же монетам, что стоят в списке: только с известным
    тикером. Иначе конец линии не сошёлся бы с числом над ней, а это ровно та
    ошибка, из-за которой линия монеты когда-то противоречила своему итогу.

    Поэтому группируем по паре «монета и корзина», а не по одной корзине:
    отсев по тикеру возможен только когда монета в строке есть.
    """
    if not table_exists(cur, "trades") or sec <= 0:
        return []
    ban = (
        "AND NOT EXISTS (SELECT 1 FROM ignored_wallets iw "
        "WHERE iw.wallet = t.wallet AND iw.permanent = 1) "
        if table_exists(cur, "ignored_wallets")
        else ""
    )
    step = max(1, sec // buckets)
    try:
        rows = cur.execute(
            "SELECT t.token, (t.timestamp - ?) / ? b, "
            "SUM(CASE WHEN t.is_buy=1 THEN t.usd_nanos ELSE -t.usd_nanos END) net "
            "FROM trades t "
            "WHERE t.timestamp >= ? AND t.usd_nanos BETWEEN ? AND ? "
            f"{ban}"
            "GROUP BY t.token, b",
            (since, step, since, MIN_TRADE_USD_NANOS, MAX_SPOT_USD_NANOS),
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] market trend: {e}\n")
        return []

    syms = symbol_map(cur)
    arr = [0.0] * buckets
    for r in rows:
        if not syms.get((r["token"] or "").lower()):
            continue
        i = min(buckets - 1, max(0, int(r["b"] or 0)))
        arr[i] += usd(r["net"])
    # Первая точка — ноль: отсчёт начинается с пустого баланса, и тогда высота
    # линии в любой момент читается как «столько денег пришло с начала окна».
    out, run = [0.0], 0.0
    for v in arr:
        run += v
        out.append(round(run, 2))
    return out


# Полный список монет каждого окна — тот самый, из которого собираются и
# счётчик, и любая страница. Держим его в памяти: обход месяца сделок занимает
# на боевой базе 1,4 секунды, а делался он заново на каждое нажатие «вперёд» и
# на каждую смену фильтра. Заполняется при перестройке общего кэша, то есть
# даром: load_flow этот список и так считает.
_FLOW_ROWS: dict[str, tuple[float, list[dict]]] = {}
_flow_rows_lock = threading.Lock()
_flow_busy: set[str] = set()
FLOW_ROWS_TTL = 90.0


def flow_rows_cached(cur: sqlite3.Connection, win: str) -> list[dict]:
    """Список монет окна из памяти.

    Устаревший список отдаётся сразу, а пересчёт уходит в фоновый поток.
    Срок жизни здесь — повод обновиться, а не повод заставить ждать: мерил,
    перестройка общего кэша на боевой базе идёт дольше этого срока, и запись
    успевала протухнуть между кругами. Тогда очередной страницей человек
    оплачивал обход месяца сделок — полторы секунды вместо двадцати
    миллисекунд.

    Синхронно считаем только когда в памяти нет вообще ничего: первый запрос
    после запуска, если планового обновления ещё не было.
    """
    sec = FLOW_WINDOWS.get(win)
    if not sec:
        return []
    with _flow_rows_lock:
        hit = _FLOW_ROWS.get(win)
        if hit:
            if time.monotonic() - hit[0] >= FLOW_ROWS_TTL and win not in _flow_busy:
                _flow_busy.add(win)
                threading.Thread(target=_flow_rows_rebuild, args=(win, sec),
                                 daemon=True).start()
            return hit[1]
    rows = flow_scan(cur, now() - sec)
    flow_rows_put(win, rows)
    return rows


def _flow_rows_rebuild(win: str, sec: int) -> None:
    """Пересчёт списка окна в стороне от запроса, со своим соединением."""
    con = None
    try:
        con = open_db(DB)
        if con:
            flow_rows_put(win, flow_scan(con, now() - sec))
    except Exception as e:
        sys.stderr.write(f"[api] flow rows {win}: {e}\n")
    finally:
        if con:
            try:
                con.close()
            except Exception:
                pass
        with _flow_rows_lock:
            _flow_busy.discard(win)


def flow_rows_put(win: str, rows: list[dict]) -> None:
    with _flow_rows_lock:
        _FLOW_ROWS[win] = (time.monotonic(), rows)


def flow_scan(cur: sqlite3.Connection, since: int, tokens: list[str] | None = None) -> list[dict]:
    """Все монеты окна с их потоком, по убыванию модуля потока.

    Без ограничения строк: отсюда берётся и число монет в шапке, и любая
    страница списка. Считать по обрезанному списку нельзя — на экране стояло
    «40 монет» при сорок первой, доступной по кнопке.

    Строки без тикера отсеиваются здесь же, по общему справочнику. Раз и
    список, и счётчик, и страницы строятся из одного массива, смещение не
    может разъехаться с тем, что человек видит.
    """
    if not table_exists(cur, "trades"):
        return []
    ban = (
        "AND NOT EXISTS (SELECT 1 FROM ignored_wallets iw "
        "WHERE iw.wallet = t.wallet AND iw.permanent = 1) "
        if table_exists(cur, "ignored_wallets")
        else ""
    )
    where_tok, args = "", [since, MIN_TRADE_USD_NANOS, MAX_SPOT_USD_NANOS]
    if tokens is not None:
        if not tokens:
            return []
        where_tok = f"AND t.token IN ({','.join('?' * len(tokens))}) "
        args += tokens
    try:
        rows = cur.execute(
            "SELECT t.token, "
            "SUM(CASE WHEN t.is_buy=1 THEN t.usd_nanos ELSE 0 END) buy, "
            "SUM(CASE WHEN t.is_buy=0 THEN t.usd_nanos ELSE 0 END) sell, "
            "COUNT(DISTINCT t.wallet) w "
            "FROM trades t "
            "WHERE t.timestamp >= ? AND t.usd_nanos BETWEEN ? AND ? "
            f"{ban}{where_tok}"
            "GROUP BY t.token "
            "ORDER BY ABS(SUM(CASE WHEN t.is_buy=1 THEN t.usd_nanos ELSE -t.usd_nanos END)) DESC",
            args,
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] flow scan: {e}\n")
        return []

    syms = symbol_map(cur)
    out: list[dict] = []
    for r in rows:
        tok = (r["token"] or "")
        sym = syms.get(tok.lower())
        if not sym:
            continue
        b, sl = usd(r["buy"]), usd(r["sell"])
        out.append({
            "sym": sym,
            "token": tok,
            "addr": tok,
            "net": b - sl,
            "buy": b,
            "sell": sl,
            "w": int(r["w"] or 0),
            "sp": [],
        })
    return out


def flow_finish(cur: sqlite3.Connection, rows: list[dict], since: int, sec: int) -> list[dict]:
    """Логотипы, линии и различение одинаковых тикеров.

    Под одним тикером на BSC живут разные контракты — копии популярных имён
    делаются в два клика. Сгруппировано по адресу, поэтому в списке честно
    оказываются две строки «幻想», и выглядит это как дубликат. Раз имена
    совпадают, к повторам дописываем хвост адреса: он у контрактов
    единственное, что действительно различается.
    """
    for r in rows:
        r["icon"] = coin_icon(r["sym"], r.get("token") or "")

    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(r["sym"], []).append(r)
    for grp in groups.values():
        if len(grp) < 2:
            continue
        toks = [(r.get("token") or "") for r in grp]
        if any(len(t) < 42 for t in toks):
            continue
        # Ставим адрес контракта — в сокращённом виде, но узнаваемом: «0x» и
        # многоточие говорят, что это адрес, а не случайные буквы.
        #
        # Раньше здесь стоял голый хвост в четыре знака, и две разные копии
        # 4STOCK получили одинаковое «ffff»: метка не сделала ровно того,
        # ради чего существует. Хвосты как раз совпадают чаще всего — их
        # подбирают нарочно, чтобы адрес красиво заканчивался.
        #
        # Поэтому длина начала подбирается: берём столько знаков, сколько
        # нужно, чтобы контракты в этой группе различались. Совпадут и
        # начало, и конец — покажем адрес целиком, лишь бы не выдать два
        # разных контракта за один.
        for k in (4, 6, 8, 12, 16):
            short = [f"{t[:2 + k]}…{t[-4:]}" for t in toks]
            if len(set(short)) == len(short):
                break
        else:
            short = toks
        for r, tag in zip(grp, short):
            r["tag"] = tag
    series = flow_series(cur, [r.get("token") or "" for r in rows], since, sec)
    for r in rows:
        r["sp"] = series.get(r.get("token") or "") or []
    return rows


def flow_search(cur: sqlite3.Connection, win: str, q: str, limit: int = 40,
                offset: int = 0, side: str = "all") -> dict:
    """Страница потока: по всем монетам окна или по совпадению тикера.

    Фильтр по тикеру сводится к списку адресов заранее: считать поток по
    всей базе, чтобы потом оставить одну монету, значит суммировать месяц
    сделок впустую.

    Знак потока отбирается уже на готовом списке: он посчитан, и второй
    проход по базе ради сравнения с нулём ничего не ускорит. Порядок
    сохраняется — список и так идёт по убыванию модуля, то есть внутри
    притока сверху самый крупный приток, внутри оттока — самый крупный отток.
    """
    sec = FLOW_WINDOWS.get(win)
    if not sec:
        return {"rows": [], "total": 0}
    since = now() - sec
    limit = max(1, min(int(limit or 40), 100))
    offset = max(0, min(int(offset or 0), 5000))

    allrows = flow_rows_cached(cur, win)

    # Поиск и фильтр по знаку — на готовом списке. Раньше поиск уходил в базу
    # отдельным обходом, хотя искать нужно среди тех же самых монет, которые
    # уже посчитаны и лежат в памяти.
    needle = (q or "").strip().upper()
    if needle:
        allrows = [r for r in allrows if needle in (r["sym"] or "").upper()]
    if side == "in":
        allrows = [r for r in allrows if r["net"] > 0]
    elif side == "out":
        allrows = [r for r in allrows if r["net"] < 0]

    # Копия страницы: flow_finish дописывает строкам логотип, хвост адреса и
    # линию, а строки эти общие — они лежат в кэше и раздаются всем.
    page = [dict(r) for r in allrows[offset:offset + limit]]
    return {"rows": flow_finish(cur, page, since, sec), "total": len(allrows)}


def _map_rank(arr, days: int, n: int = 100, offset: int = 0) -> list:
    mapped = []
    for e in arr[offset:offset + n]:
        if not isinstance(e, dict):
            continue
        hold_s = int(e.get("h") or 0)
        mapped.append(
            {
                "a": e.get("w") or "",
                "pnl": usd(e.get("p")),
                # Поля roi здесь нет намеренно: доски ROI по споту не
                # существует, и число, которое никому не показывают, лучше не
                # возить — однажды его покажут.
                "win": float(e.get("wr") or 0),
                "tr": int(e.get("t") or 0),
                "dd": 0,
                "days": days,
                # Секунды, а не «9ч»: бот пишет «21д 15ч» и «8ч 30м», а строка
                # с русской буквой ещё и не переводилась.
                "hold": hold_s or None,
            }
        )
    return mapped


def _rank_payload(cur, key: str) -> list:
    """Сырой разобранный массив доски из кэша бота."""
    row = cur.execute("SELECT payload FROM ranking_cache WHERE cache_key=?", (key,)).fetchone()
    if not row or not row[0]:
        return []
    raw = row[0]
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "ignore")
    if not (isinstance(raw, str) and raw.lstrip().startswith("[")):
        return []
    try:
        arr = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return arr if isinstance(arr, list) else []


def _read_rank_key(cur, key: str, days: int) -> list:
    """Доска целиком — сто мест, как в боте."""
    return _map_rank(_rank_payload(cur, key), days, RANK_MAX_DEPTH)


def perp_closed_usd(px, sz, side, start_pos, notional_nanos) -> float:
    """Сколько долларов номинала закрыла строка филов.

    Закрыто не больше, чем стояло в позиции: у переворота (лонг в шорт)
    половина объёма открывает новую, и закрытой она не была. Долив в ту же
    сторону не закрывает ничего — ноль. Размера позиции или стороны нет —
    считаем по всему филу: строка сюда попадает как закрывающая.
    """
    try:
        price = float(px or 0)
        size = float(sz or 0)
    except (TypeError, ValueError):
        return 0.0
    if size <= 0:
        return 0.0
    if start_pos is None or side not in ("A", "B"):
        shut = size
    else:
        had = int(start_pos) / NANOS
        buy = side == "B"
        if had > 0 and not buy:
            shut = min(size, had)
        elif had < 0 and buy:
            shut = min(size, -had)
        else:
            shut = 0.0
    if shut <= 0:
        return 0.0
    if price > 0:
        return shut * price
    return usd(notional_nanos) * (shut / size)


def perp_close_sql(cset: set, alias: str = "") -> str:
    """Условие «строка что-то закрыла» — одно на числитель и знаменатель.

    Пока условий было два, доска врала: прибыль считалась по каждому
    закрытию, а маржа — только по строкам `flat=1` или `dir_code>=5`, то есть
    по полным закрытиям, переворотам и ликвидациям. Частичное закрытие у бота
    получает код 3 или 4 (`dirCode()` в hyperliquid_internal.h) и флага
    `flat` не имеет: прибыль с него шла в числитель, а маржа в знаменатель не
    попадала. Кто выходит из позиции частями, получал доходность в разы
    выше настоящей — у 0x767a…ace выходило 31660% вместо 188%.
    """
    a = f"{alias}." if alias else ""
    parts = [f"{a}closed_pnl_nanos != 0"] if "closed_pnl_nanos" in cset else []
    if "flat" in cset:
        parts.append(f"{a}flat = 1")
    if "dir_code" in cset:
        # 3 и 4 — закрытие лонга и шорта (в том числе частичное), 5 —
        # переворот, 6..8 — ликвидации.
        parts.append(f"{a}dir_code >= 3")
    return "(%s)" % " OR ".join(parts) if parts else "1"


def perp_margin(hl: sqlite3.Connection, wallets: list[str] | None, since_ms: int) -> dict[str, float]:
    """Маржа, которой человек рисковал в закрытых сделках, — знаменатель ROI.

    Считаем по самим закрытиям: сколько номинала строка закрыла, делённое на
    плечо. Закрытый номинал — это размер фила по его цене, но не больше, чем
    было в позиции: у переворота (лонг в шорт) половина объёма открывает
    новую, и считать её закрытой нельзя. Строки, которые позицию только
    наращивают, в знаменатель не идут вовсе.

    Прежний способ брал наибольшую маржу среди филов серии, а маржа бралась
    из снимка позиции. Снимок есть не у каждого фила, и открытия у нас вообще
    могут отсутствовать — кошелёк попал в наблюдение позже, — тогда как
    прибыль приходит с закрытий и в расчёт попадает целиком. Размер позиции
    биржа сообщает в каждом филе, поэтому новый счёт от собранного не зависит.

    wallets=None — посчитать всем, кто торговал в окне: доска ROI обязана
    быть глобальной, а не «ROI среди самой прибыльной сотни».
    """
    if wallets is not None and not wallets:
        return {}
    cset = cols(hl, "hl_fills")
    if "leverage" not in cset and "margin_nanos" not in cset:
        return {}
    marg = "COALESCE(margin_nanos,0)" if "margin_nanos" in cset else "0"
    lev = "COALESCE(leverage,0)" if "leverage" in cset else "0"
    ntl = "COALESCE(notional_nanos,0)" if "notional_nanos" in cset else "0"
    start = "start_pos_nanos" if "start_pos_nanos" in cset else "NULL"
    px = "COALESCE(px,'0')" if "px" in cset else "'0'"
    sz = "COALESCE(sz,'0')" if "sz" in cset else "'0'"
    side = "COALESCE(side,'')" if "side" in cset else "''"
    out: dict[str, float] = {}
    where = "ts >= ? AND " + perp_close_sql(cset)
    args: tuple = (since_ms,)
    if wallets is not None:
        where += " AND wallet IN (%s)" % ",".join("?" * len(wallets))
        args = (since_ms, *wallets)
    sql = (
        f"SELECT wallet, {marg} m, {lev} lv, {ntl} n, "
        f"{start} sp, {px} px, {sz} sz, {side} sd "
        f"FROM hl_fills WHERE {where}"
    )
    try:
        rows = hl.execute(sql, args).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] perp margin: {e}\n")
        return {}
    # Среднее плечо кошелька — на случай филов, где его не записали.
    lev_sum: dict[str, float] = {}
    lev_n: dict[str, int] = {}
    for r in rows:
        lv = int(r["lv"] or 0)
        if lv > 0:
            w = r["wallet"]
            lev_sum[w] = lev_sum.get(w, 0.0) + lv
            lev_n[w] = lev_n.get(w, 0) + 1
    for r in rows:
        w = r["wallet"]
        ntl_usd = perp_closed_usd(r["px"], r["sz"], r["sd"], r["sp"], r["n"])
        if ntl_usd <= 0:
            # Строка ничего не закрыла — доливка в ту же сторону. Снимок
            # маржи брать тем более нельзя: он про всю позицию целиком.
            continue
        lv = int(r["lv"] or 0)
        if lv <= 0 and lev_n.get(w):
            lv = max(1, int(round(lev_sum[w] / lev_n[w])))
        if lv > 0:
            out[w] = out.get(w, 0.0) + ntl_usd / lv
        elif int(r["m"] or 0) > 0:
            # Плеча нет вовсе — остаётся снимок маржи позиции.
            out[w] = out.get(w, 0.0) + usd(r["m"])
    return out


def load_perp_rank(hl: sqlite3.Connection | None, days: int = 30) -> dict:
    empty = {"pnl": [], "roi": [], "win": [], "act": []}
    if not hl or not table_exists(hl, "hl_fills"):
        return empty
    since_ms = (now() - days * 86400) * 1000
    max_tr = max(HL_MIN_CLOSED, (HL_MAX_CLOSED_30D * days + 29) // 30)
    cset = cols(hl, "hl_fills")
    if "closed_pnl_nanos" not in cset:
        return empty
    fee = "COALESCE(fee_nanos,0)" if "fee_nanos" in cset else "0"
    lev = "leverage" if "leverage" in cset else "0"
    ban = (
        "AND NOT EXISTS (SELECT 1 FROM hl_banned b WHERE b.wallet = f.wallet)"
        if table_exists(hl, "hl_banned")
        else ""
    )
    # То же условие, что у знаменателя: две разные формулы уже разошлись
    # однажды и завысили доходность в разы.
    close_f = "AND " + perp_close_sql(cset, "f")
    # Без LIMIT и без сортировки по прибыли: доски строятся каждая по своему
    # признаку, и отбирать кандидатов прибылью значило бы показывать «лучший
    # винрейт среди самых прибыльных», а не лучший винрейт вообще. Перебор
    # всё равно идёт по всем строкам окна — отсечение сотней экономило только
    # передачу результата.
    sql = (
        f"SELECT f.wallet, "
        f"SUM(f.closed_pnl_nanos) pnl, SUM({fee}) fees, COUNT(*) trades, "
        f"SUM(CASE WHEN f.closed_pnl_nanos > 0 THEN 1 ELSE 0 END) wins, "
        f"AVG(CASE WHEN {lev} > 0 THEN {lev} END) lev "
        f"FROM hl_fills f WHERE f.ts >= ? {close_f} {ban} "
        f"GROUP BY f.wallet HAVING COUNT(*) >= ? AND COUNT(*) <= ?"
    )
    try:
        rows = hl.execute(sql, (since_ms, HL_MIN_CLOSED, max_tr)).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] perp rank: {e}\n")
        return empty
    mapped = []
    # Знаменатель ROI — вложенная маржа, как в боте. Формула
    # 100*pnl/max(|pnl|*0.4,1) здесь когда-то давала ровно ±250 почти всем.
    # Считаем всем, кто торговал в окне: на базе в четверть миллиона филов
    # обход занимает меньше секунды, а доска от этого становится настоящей.
    t0 = time.monotonic()
    margins = perp_margin(hl, None, since_ms)
    for r in rows:
        pnl = usd(r["pnl"]) - usd(r["fees"])
        tr = int(r["trades"] or 0)
        wins = int(r["wins"] or 0)
        lev_v = float(r["lev"] or 0)
        marg = margins.get(r["wallet"] or "", 0.0)
        # Сотня долларов маржи — порог здравого смысла: на меньшей одна
        # удачная сделка даёт тысячи процентов, и доска превращается в
        # витрину случайностей.
        mapped.append(
            {
                "a": r["wallet"] or "",
                "pnl": pnl,
                "roi": (100.0 * pnl / marg) if marg >= 100.0 else None,
                "win": int(round(100.0 * wins / tr)) if tr else 0,
                "tr": tr,
                "dd": 0,
                "days": days,
                "lev": int(round(lev_v)) if lev_v else None,
            }
        )
    sys.stderr.write(
        f"[api] перпы: {len(rows)} кошельков, маржа у {len(margins)}, "
        f"{time.monotonic() - t0:.1f}с\n")

    def top(rows_in, key):
        return sorted(rows_in, key=key)[:RANK_MAX_DEPTH]

    return {
        # Каждая доска — своя сотня, отобранная по своему признаку.
        "pnl": top(mapped, lambda x: -x["pnl"]),
        # Доска ROI была пуста, пока знаменателя не существовало: делить
        # прибыль оказалось не на что, и вместо рейтинга получался выдуманный
        # порядок. Теперь маржа считается обходом филов, и доска собирается из
        # тех строк, где её удалось посчитать. Кошельки без маржи не
        # обнуляются, а не попадают на доску вовсе: ноль там означал бы
        # «торговал без прибыли», а это неправда — про них просто нечего
        # сказать.
        "roi": top([r for r in mapped if r["roi"] is not None], lambda x: -x["roi"]),
        # При равном проценте выше тот, кто сделал больше сделок: сто
        # процентов на пяти сделках — это удача, а не мастерство. Тот же
        # порядок, что у спотовых досок бота.
        "win": top(mapped, lambda x: (-x["win"], -x["tr"])),
        "act": top(mapped, lambda x: (-x["tr"], -x["pnl"])),
    }


def rank_presence(cur: sqlite3.Connection) -> dict[str, dict[str, int]]:
    """Сколько дней кошелёк держится в топе — по площадкам. Одним запросом
    на всех: бот спрашивает по одному кошельку, нам так нельзя."""
    out: dict[str, dict[str, int]] = {"spot": {}, "perp": {}}
    if not table_exists(cur, "rank_presence"):
        return out
    try:
        rows = cur.execute(
            "SELECT venue, wallet, COUNT(*) n FROM rank_presence GROUP BY venue, wallet"
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] rank_presence: {e}\n")
        return out
    for r in rows:
        v = str(r["venue"] or "")
        if v in out and r["wallet"]:
            out[v][str(r["wallet"]).lower()] = int(r["n"] or 0)
    return out


def load_rank(cur: sqlite3.Connection, hl: sqlite3.Connection | None = None) -> dict:
    empty = {"pnl": [], "roi": [], "win": [], "act": []}
    seen = rank_presence(cur)
    rank = {"spot": {k: [] for k in empty}, "perp": {k: [] for k in empty}, "wins": {}}
    kind_map = {"pnl": "pnl", "roi": "roi", "winrate": "win", "active": "act"}
    has_cache = table_exists(cur, "ranking_cache")
    for days in (30, 90, 180, 365):
        spot = {k: [] for k in empty}
        if has_cache:
            for kind, key in kind_map.items():
                # ROI по споту не отдаём вовсе: знаменатель собирается из цен
                # DEX на момент покупки, часть монет куплена по ценам, которых
                # уже не восстановить, а порог отсечения у бота — десять
                # долларов оборота. Доски ROI для BSC нет ни в боте, ни здесь;
                # остаётся абсолютный PnL, который считается из тех же сделок,
                # но ни на что не делится.
                if key == "roi":
                    continue
                rows = _read_rank_key(cur, f"global_{kind}_{days}", days)
                if not rows and days == 30:
                    rows = _read_rank_key(cur, f"global_{kind}", 30)
                spot[key] = rows
            if not spot["act"]:
                spot["act"] = list(spot["pnl"])
        perp = load_perp_rank(hl, days) if days == 30 else {k: [] for k in empty}
        for venue, table in (("spot", spot), ("perp", perp)):
            for board in table.values():
                for row in board:
                    row["top"] = seen[venue].get(str(row.get("a") or "").lower()) or None
        rank["wins"][str(days)] = {"spot": spot, "perp": perp}
        if days == 30:
            rank["spot"] = spot
            rank["perp"] = perp
    return rank


def wallet_deals(cur: sqlite3.Connection, hl: sqlite3.Connection | None,
                 addr: str, venue: str, n: int = 10) -> list[dict]:
    """Последние завершённые сделки одного кошелька из рейтинга.

    Завершённые, а не отдельные переводы: покупка сама по себе ничего не
    говорит о трейдере, смысл появляется, когда видно за сколько взял, за
    сколько отдал и что осталось в кармане.

    Ничего нового наружу это не открывает: доска и так публикует прибыль и
    число сделок каждого кошелька, а лента крупных сделок — их адреса,
    монеты и суммы.

    Сторона сделки уходит флагом, а не словом: в ленте крупных сделок стоит
    захардкоженное русское «покупка», и повторять эту ошибку в новом месте
    незачем — подписи есть в словаре на всех шестнадцати языках.
    """
    key = (addr or "").strip().lower()
    if not ADDR_RE.match(key):
        return []
    n = max(1, min(int(n or 10), 50))

    if venue == "perp":
        return _perp_deals(hl, key, n)
    return _spot_deals(cur, key, n)


def _perp_deals(hl: sqlite3.Connection | None, key: str, n: int) -> list[dict]:
    """Закрытия позиций на Hyperliquid.

    Закрытие — это фил с ненулевым closed_pnl: биржа сама считает результат
    и кладёт его в филл. Цену входа она не хранит, но из результата её видно
    точно: у лонга прибыль это (выход − вход) × объём, у шорта наоборот,
    значит вход = выход ∓ прибыль/объём.

    ROI берём от маржи, как «ROI за сделку» в боте: это те деньги, которыми
    трейдер рисковал. Маржа не записана — считаем от номинала и плеча.
    """
    if not hl or not table_exists(hl, "hl_fills"):
        return []
    cset = cols(hl, "hl_fills")
    if "closed_pnl_nanos" not in cset:
        return []
    dirc = "dir_code" if "dir_code" in cset else "0"
    lev = "leverage" if "leverage" in cset else "0"
    marg = "margin_nanos" if "margin_nanos" in cset else "0"

    # Что считать закрытием — ровно то же, что считает доска в
    # load_perp_rank: одно условие на всех, `perp_close_sql`. Одного лишь
    # ненулевого closed_pnl мало: бот помечает закрытия ещё и флагом flat, а
    # направление кодом от тройки. По узкому условию история оказывалась
    # пустой у кошельков, у которых доска показывает десятки сделок, и
    # получалось, что рейтинг считает одно, а история — другое.
    close_f = "AND " + perp_close_sql(cset)
    sp = "start_pos_nanos" if "start_pos_nanos" in cset else "NULL"
    side = "COALESCE(side,'')" if "side" in cset else "''"
    try:
        rows = hl.execute(
            f"SELECT coin, px, sz, notional_nanos, closed_pnl_nanos pnl, "
            f"{dirc} dirc, {lev} lev, {marg} marg, {sp} sp, {side} sd, ts "
            f"FROM hl_fills WHERE lower(wallet)=? {close_f} "
            f"ORDER BY ts DESC LIMIT ?",
            (key, n),
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] deals perp {key[:10]}: {e}\n")
        return []

    out: list[dict] = []
    for r in rows:
        code = int(r["dirc"] or 0)
        liq = code in (DIR_LIQ_LONG, DIR_LIQ_SHORT, DIR_LIQ_OTHER)
        long_side = code in (DIR_CLOSE_LONG, DIR_LIQ_LONG)
        known_side = code in (DIR_CLOSE_LONG, DIR_CLOSE_SHORT, DIR_LIQ_LONG, DIR_LIQ_SHORT)
        pnl = usd(r["pnl"])
        exit_px = _f(r["px"])
        size = _f(r["sz"])
        entry_px = None
        # У переворота сторона неизвестна, а от неё зависит знак: посчитать
        # вход, не зная, что закрывали, значит получить цену наугад.
        #
        # Нулевой результат тоже не годится: вход вышел бы равен выходу, а
        # это ничего не сообщает — и вдобавок ноль в базе значит не только
        # «в ноль», но и «биржа результата не прислала».
        if known_side and pnl != 0 and exit_px > 0 and size > 0:
            entry_px = exit_px - pnl / size if long_side else exit_px + pnl / size
            if entry_px <= 0:
                entry_px = None
        lv = int(r["lev"] or 0)
        # Знаменатель тот же, что на доске: маржа закрытой части, а не всей
        # позиции. Снимок `margin_nanos` — про позицию целиком, и у
        # частичного закрытия он занижал доходность сделки во столько раз,
        # какую долю позиции закрыли.
        closed = perp_closed_usd(r["px"], r["sz"], r["sd"], r["sp"], r["notional_nanos"])
        margin = closed / lv if lv > 0 and closed > 0 else usd(r["marg"])
        sym = str(r["coin"] or "?").upper()
        out.append({
            "sym": sym,
            "icon": coin_icon(sym),
            "v": usd(r["notional_nanos"]),
            "long": long_side if known_side else None,
            "liq": liq,
            "lev": lv or None,
            "buy": entry_px,
            "sell": exit_px or None,
            "pnl": pnl,
            "roi": (100.0 * pnl / margin) if margin > 0 else None,
            "ts": ts_sec(r["ts"]),
        })
    return out


def _spot_deals(cur: sqlite3.Connection, key: str, n: int) -> list[dict]:
    """Продажи на BSC со средней ценой покупки.

    Учёт тот же, что в ranking.cpp и в spot_open: покупка добавляет
    количество и стоимость, продажа списывает их пропорционально. Поэтому
    пройти нужно всю историю кошелька, а не последние десять строк — без
    покупок не из чего считать цену входа.

    Количество лежит в атомах. Для прибыли это неважно — она считается в
    долларах, — а для цены нужны знаки после запятой. Нет их в token_cache —
    показываем сделку без цен, но с результатом: врать про цену хуже, чем
    её не показать.

    ROI по споту не отдаём. Знаменатель — вложенное — восстанавливается из
    цен DEX на момент покупки и для старых монет недостоверен; ровно по этой
    причине доску ROI по BSC сняли и в боте, и в приложении.
    """
    if not table_exists(cur, "trades"):
        return []
    try:
        rows = cur.execute(
            "SELECT token, is_buy, usd_nanos, token_amount, timestamp FROM trades "
            # Те же границы, что у рейтинга: сделки с выдуманными decimals не
            # должны всплыть в истории после того, как их убрали из доски.
            "WHERE wallet=? AND usd_nanos BETWEEN ? AND ? "
            "ORDER BY token ASC, timestamp ASC, id ASC",
            (key, MIN_TRADE_USD_NANOS, MAX_SPOT_USD_NANOS),
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] deals spot {key[:10]}: {e}\n")
        return []

    held: dict[str, dict] = {}
    closed: list[dict] = []
    for r in rows:
        tok = (r["token"] or "").lower()
        try:
            amt = int(r["token_amount"] or 0)
        except (TypeError, ValueError):
            continue
        if amt <= 0:
            continue
        usd_n = int(r["usd_nanos"] or 0)
        h = held.setdefault(tok, {"qty": 0, "cost": 0})
        if r["is_buy"]:
            h["qty"] += amt
            h["cost"] += usd_n
            continue
        if h["qty"] <= 0:
            # Продажа без покупки в нашей истории: цену входа брать неоткуда,
            # а выдумывать её — то же самое, что выдумывать прибыль.
            continue
        take = min(amt, h["qty"])
        cost = h["cost"] * take // h["qty"]
        proceeds = usd_n * take // amt
        h["cost"] -= cost
        h["qty"] -= take
        closed.append({
            "tok": tok,
            "take": take,
            "cost": usd(cost),
            "proceeds": usd(proceeds),
            "ts": int(r["timestamp"] or 0),
        })

    closed.sort(key=lambda d: d["ts"], reverse=True)
    out: list[dict] = []
    for d in closed[:n]:
        dec = token_decimals(cur, d["tok"])
        qty = d["take"] / (10 ** dec) if dec else 0.0
        sym = symbol_of(cur, d["tok"]) or short_addr(d["tok"])
        out.append({
            "sym": sym,
            # Логотип ищется по адресу контракта, а не по тикеру: тикеры не
            # уникальны, и под чужим PEPE подставилась бы чужая картинка.
            "icon": coin_icon(sym, d["tok"]),
            "v": d["proceeds"],
            "buy": (d["cost"] / qty) if qty > 0 else None,
            "sell": (d["proceeds"] / qty) if qty > 0 else None,
            "pnl": d["proceeds"] - d["cost"],
            "ts": d["ts"],
        })
    return out


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# Сколько крупнейших сделок отдаём на каждую сторону в каждом окне.
BIG_ROWS = 100


def load_trades(cur: sqlite3.Connection, hl: sqlite3.Connection | None, hours: int = 24) -> dict:
    """Крупнейшие сделки за окно. Окна те же, что в big_trades.cpp бота:
    час, сутки, неделя, месяц."""
    spot, perp = [], []
    since = now() - max(1, int(hours)) * 3600
    ign = table_exists(cur, "ignored_wallets")
    if table_exists(cur, "trades"):
        ban = (
            "AND NOT EXISTS (SELECT 1 FROM ignored_wallets iw "
            "WHERE iw.wallet = t.wallet AND iw.permanent = 1) "
            if ign
            else ""
        )
        # Покупки и продажи выбираются порознь, по сотне каждых. Одним
        # запросом с общим пределом так не выйдет: в окне, где продают почти
        # всё, сотня крупнейших сделок оказалась бы сплошь продажами, и
        # кнопка «Покупки» вела бы на три строки.
        #
        # По одной сделке на кошелёк и на сторону: иначе один кит с десятком
        # заходов занимал бы всю доску собой. Раньше сторона в группировке не
        # участвовала, и у кошелька, который в этом окне и покупал, и
        # продавал, одна из сделок пропадала вовсе.
        syms = symbol_map(cur)
        for want_buy in (1, 0):
            # MAX стоит в выборке, а не в HAVING: только в этой форме SQLite
            # обещает, что остальные поля строки — монета и время — возьмутся
            # именно из той сделки, где достигнут максимум. Прежняя запись
            # давала тот же ответ, но опиралась на поведение, которого никто
            # не обещал.
            #
            # Берём с запасом: у части адресов нет тикера, такие строки
            # отсеиваются уже здесь, и без запаса вместо сотни доходило
            # девяносто с небольшим.
            rows = cur.execute(
                "SELECT t.wallet, t.token, MAX(t.usd_nanos) v, t.timestamp "
                "FROM trades t "
                "WHERE t.timestamp >= ? AND t.usd_nanos > 0 AND t.usd_nanos <= ? "
                "AND t.is_buy = ? "
                f"{ban}"
                "GROUP BY t.wallet "
                "ORDER BY v DESC LIMIT ?",
                (since, MAX_SPOT_USD_NANOS, want_buy, BIG_ROWS * 2),
            ).fetchall()
            taken = 0
            for r in rows:
                if taken >= BIG_ROWS:
                    break
                sym = syms.get((r["token"] or "").lower())
                if not sym:
                    continue
                taken += 1
                spot.append(
                    {
                        "sym": sym,
                        "v": usd(r["v"]),
                        "side": "покупка" if want_buy else "продажа",
                        # Сторона отдельным полем: по слову её приходилось
                        # угадывать разбором текста, а слово ещё и переводится.
                        "buy": bool(want_buy),
                        "w": short_addr(r["wallet"] or ""),
                        # Полный адрес — чтобы подписаться прямо из ленты. В
                        # сокращённом виде «0x9702b7…d193» кошелёк не найти:
                        # подписка требует всех сорока двух знаков.
                        "wa": (r["wallet"] or "").lower(),
                        "t": ago(r["timestamp"]),
                    }
                )
    if hl and table_exists(hl, "hl_fills"):
        since_ms = since * 1000
        ban = (
            "AND wallet NOT IN (SELECT wallet FROM hl_banned) "
            if table_exists(hl, "hl_banned")
            else ""
        )
        cset = cols(hl, "hl_fills")
        dirc = "dir_code" if "dir_code" in cset else "0"
        lev = "leverage" if "leverage" in cset else "0"
        # Крипта и «не крипта» выбираются порознь, по сотне каждых. Одним
        # запросом с общим пределом акции с металлами не показать: их обороты
        # на порядок меньше, и в сотне крупнейших позиций не окажется ни
        # одной — ровно поэтому раздел и показывал ноль строк.
        #
        # Не загрузилась карта рынков — берём одним запросом, как раньше:
        # лучше общий список, чем пустой.
        # В базе имя лежит и коротким, и с приставкой — «CL» и «XYZ:CL», — а
        # сравнение идёт по верхнему регистру. Кладём в список обе формы,
        # иначе отбор не находил ничего и раздел «Акции и металлы» доставался
        # из общей сотни остатками.
        mkt = hl_markets()
        rwa = sorted(set(mkt) | hl_names())
        packs: list[tuple[str, list]] = []
        if rwa:
            marks = ",".join("?" * len(rwa))
            packs.append((f"AND upper(coin) IN ({marks}) ", rwa))
            packs.append((f"AND upper(coin) NOT IN ({marks}) ", rwa))
        else:
            packs.append(("", []))
        # Лонги и шорты тоже порознь. Причина та же, что у покупок с продажами
        # на споте: в окне, где рынок стоит в шорт, сотня крупнейших позиций
        # окажется сплошь шортами, и вкладка лонгов будет почти пустой.
        #
        # Нет колонки направления — деления нет: одним запросом, как раньше.
        dirs = [(DIR_OPEN_LONG, True), (DIR_OPEN_SHORT, False)] if dirc != "0" else [(0, None)]
        for extra, args in packs:
          for want, is_long in dirs:
            one = f"AND {dirc} = ? " if is_long is not None else f"AND {dirc} IN (1,2) "
            dir_args = [want] if is_long is not None else []
            q = (
                f"SELECT wallet, coin, dir, notional_nanos, {lev} lev, {dirc} dirc, ts "
                f"FROM hl_fills WHERE ts >= ? AND notional_nanos > 0 {ban} "
                f"{one}{extra}"
                f"GROUP BY wallet HAVING notional_nanos = MAX(notional_nanos) "
                f"ORDER BY notional_nanos DESC LIMIT ?"
            )
            try:
                for r in hl.execute(q, (since_ms, *dir_args, *args, BIG_ROWS)):
                    code = int(r["dirc"] or 0)
                    lv = int(r["lev"] or 0)
                    side = f"{'лонг' if code == DIR_OPEN_LONG else 'шорт'} {lv}×" if lv else ("лонг" if code == 1 else "шорт")
                    psym = str(r["coin"] or "?").upper()
                    perp.append(
                        {
                            "sym": psym,
                            "icon": coin_icon(psym),
                            # Класс считает сервер: карта площадок есть только
                            # у него, а по короткому имени «SP500» приложение
                            # отличить индекс от монеты не может.
                            "cls": coin_class(psym),
                            # Направление отдельным полем: подпись «лонг 5×»
                            # переводится, и разбирать её приложению нельзя.
                            "long": code == DIR_OPEN_LONG,
                            "v": usd(r["notional_nanos"]),
                            "side": side,
                            "w": short_addr(r["wallet"] or ""),
                            "wa": (r["wallet"] or "").lower(),
                            "t": ago(ts_sec(r["ts"])),
                        }
                    )
            except sqlite3.Error as e:
                sys.stderr.write(f"[api] perp trades: {e}\n")
        perp.sort(key=lambda x: -x["v"])
    # По сотне на каждое сочетание: у спота это покупка и продажа, у перпа
    # площадка (крипта или акции с металлами) и направление. Общий предел
    # выкинул бы одну из сторон целиком.
    return {"spot": spot[:BIG_ROWS * 2], "perp": perp[:BIG_ROWS * 4]}


def _big_rebuild(win: str, hours: int) -> None:
    """Обновление окна крупных сделок в стороне от запроса."""
    try:
        big_trades(win, hours, force=True)
    except Exception as e:
        sys.stderr.write(f"[api] big rebuild {win}: {e}\n")
    finally:
        with _big_lock:
            _big_busy.discard(win)


def big_trades(win: str, hours: int, force: bool = False) -> dict:
    """Крупнейшие сделки за окно, со своим кэшем.

    force — для планового обновления: запись перезаписывается, не дожидаясь,
    пока протухнет. Так все пять окон всегда готовы, и человек, который
    впервые за день нажал «30д», не ждёт обхода месяца сделок.
    """
    if not force:
        with _big_lock:
            hit = _big_cache.get(win)
            if hit:
                if time.monotonic() - hit[0] >= BIG_TTL and win not in _big_busy:
                    _big_busy.add(win)
                    threading.Thread(target=_big_rebuild, args=(win, hours),
                                     daemon=True).start()
                return hit[1]
    cur = open_db(DB)
    hl = open_db(HL_DB)
    if not cur:
        return {"spot": [], "perp": [], "win": win}
    try:
        data = load_trades(cur, hl, hours)
        data["win"] = win
    except Exception as e:
        sys.stderr.write(f"[api] big {win}: {e}\n")
        data = {"spot": [], "perp": [], "win": win}
    finally:
        try:
            cur.close()
        except Exception:
            pass
        if hl:
            try:
                hl.close()
            except Exception:
                pass
    with _big_lock:
        _big_cache[win] = (time.monotonic(), data)
        cap_cache(_big_cache, 16)
    return data


def load_feed_market(cur: sqlite3.Connection, hl: sqlite3.Connection | None) -> list:
    items = []
    ign = table_exists(cur, "ignored_wallets")
    if table_exists(cur, "trades"):
        ban = (
            "AND NOT EXISTS (SELECT 1 FROM ignored_wallets iw "
            "WHERE iw.wallet = t.wallet AND iw.permanent = 1) "
            if ign
            else ""
        )
        for r in cur.execute(
            "SELECT t.wallet, t.token, t.is_buy, t.usd_nanos, t.timestamp FROM trades t "
            f"WHERE t.usd_nanos > 0 AND t.usd_nanos <= ? {ban} "
            "ORDER BY t.timestamp DESC LIMIT 20",
            (MAX_SPOT_USD_NANOS,),
        ):
            sym = symbol_of(cur, r["token"])
            if not sym:
                continue
            items.append(
                {
                    "t": ago(r["timestamp"]),
                    "sym": sym,
                    "w": short_addr(r["wallet"] or ""),
                    "act": "купил" if r["is_buy"] else "продал",
                    "v": usd(r["usd_nanos"]),
                    "up": bool(r["is_buy"]),
                    "_ts": int(r["timestamp"] or 0),
                    "venue": "spot",
                }
            )
    if hl and table_exists(hl, "hl_fills"):
        ban = (
            "AND wallet NOT IN (SELECT wallet FROM hl_banned) "
            if table_exists(hl, "hl_banned")
            else ""
        )
        cset = cols(hl, "hl_fills")
        dirc = "dir_code" if "dir_code" in cset else "0"
        for r in hl.execute(
            f"SELECT wallet, coin, dir, notional_nanos, ts, {dirc} dirc FROM hl_fills "
            f"WHERE notional_nanos > 0 {ban} ORDER BY ts DESC LIMIT 20"
        ):
            code = int(r["dirc"] or 0)
            up = code in (DIR_OPEN_LONG, 4, DIR_LIQ_SHORT)
            items.append(
                {
                    "t": ago(ts_sec(r["ts"])),
                    "sym": str(r["coin"] or "?").upper(),
                    "w": short_addr(r["wallet"] or ""),
                    "act": r["dir"] or "сделка",
                    "v": usd(r["notional_nanos"]),
                    "up": up,
                    "_ts": ts_sec(r["ts"]),
                    "venue": "perp",
                }
            )
    items.sort(key=lambda x: -x.get("_ts", 0))
    for it in items:
        it.pop("_ts", None)
    return items[:24]


# ——— Фандинг ————————————————————————————————————————————————————————————
#
# Ставка сама по себе ничего не говорит: Hyperliquid платит каждый час,
# остальные — раз в четыре или восемь, и «-0,08%» у первого и у второго
# отличаются в разы. Поэтому всё приводится к суточным: и сравнивать, и
# сортировать можно только их.
#
# Именно к суточным, а не к годовым: в годовых те же числа превращаются в
# «-1971%», и это не преувеличение, а бессмыслица — ставка держится часы, а
# не год, и годовой пересчёт обещает то, чего никогда не случится.
#

# Пороги ликвидности. Без них в вершине списка стояли монеты, которых нет:
# у мёртвого контракта ставка гуляет как угодно, потому что её некому
# сбивать, и «перекос» там означает лишь, что торгов нет.
FUND_MIN_VOL = 1_000_000.0
FUND_MIN_OI = 250_000.0
# Ставка больше пяти процентов за выплату — это не перекос, а сбой на той
# стороне: биржи такие значения ограничивают своими же лимитами.
FUND_MAX_RATE = 0.05
FUND_TTL = 600.0

# Биржи, с которых берём ставки. Порядок — тот же, что в приложении.
FUND_VENUES = ("hl", "binance", "bybit", "okx", "bitget", "bingx",
               "gate", "mexc", "kucoin", "kraken", "coinbase", "aster")
# Строк на биржу в общей выгрузке — ровно одна страница. Остальные доски
# достаются по запросу: перекосов на крупной бирже под тысячу, и возить их
# все каждому запуску незачем.
FUND_PAGE = 20
_FUND: dict[str, tuple[float, list]] = {}
_fund_lock = threading.Lock()


def get_json(url: str, timeout: float = 10.0):
    """GET с разбором JSON. Ошибка сети — это None, а не исключение."""
    req = urllib.request.Request(url, headers={"User-Agent": "wallet-tracker/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError, OSError):
        return None


def _fnum(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f and abs(f) != float("inf") else 0.0


# Обёртки BingX на чужие рынки: акции, товары, индексы и валютные пары.
# Внутри имени — настоящий инструмент, снаружи — четыре буквы и валюта
# расчёта. Перечислены поимённо: «NC» с двумя буквами встречается и у монет
# (NCASH), и правило по маске съело бы их.
FUND_WRAP = ("NCSK", "NCCO", "NCSI", "NCFX")


def fund_sym(raw: str) -> str:
    """Тикер биржи → тикер монеты: BTC-USDT, BTC_USDT, BTCUSDT → BTC.

    Множители в имени (1000PEPE, 1MBABYDOGE) снимаются: ставка от размера
    лота не зависит, а значок и название монеты находятся только по чистому
    тикеру.

    Обёртки BingX на акции и индексы приходят как NCSKSOXX2USD — под этим
    именем ни человек, ни справочник значков ничего не найдут. Разворачиваем
    так же, как это делает бот: снимаем приставку и хвост, остаётся SOXX.
    """
    s = str(raw or "").upper().strip()
    s = s.split("-")[0].split("_")[0]
    if s[:4] in FUND_WRAP and len(s) > 8:
        kind, inner, cur = s[2:4], s[4:], ""
        # Хвост — «2» и валюта расчёта: 2USD у американских бумаг, 2JPY у
        # японских. Снимаем любую, иначе часть имён так и осталась бы
        # нечитаемой.
        if len(inner) > 4 and inner[-4] == "2" and inner[-3:].isalpha():
            cur, inner = inner[-3:], inner[:-4]
        else:
            # Часть обёрток идёт без «2»: NCSKSITMUSDT — это SITM, а не
            # SITMUSDT. Валюту расчёта снимаем и в этом случае.
            for quote in ("USDT", "USDC", "USD"):
                if inner.endswith(quote) and len(inner) > len(quote):
                    inner = inner[: -len(quote)]
                    break
        # У валютных пар вторая валюта — половина смысла: NCFXEUR2JPY это
        # EURJPY, а не EUR. У остальных обёрток это лишь валюта расчёта.
        if kind == "FX" and cur:
            inner += cur
        if inner and len(inner) <= 12:
            return inner
    for quote in ("USDT", "USDC", "USD"):
        if s.endswith(quote) and len(s) > len(quote):
            s = s[: -len(quote)]
            break
    for mul in ("1000000", "100000", "10000", "1000", "1M", "1K"):
        if s.startswith(mul) and len(s) > len(mul):
            s = s[len(mul):]
            break
    return s


def fund_next(ts: float) -> int:
    """Время следующей выплаты, если оно похоже на правду.

    Биржи иногда отдают ноль или прошлогоднюю метку — показывать по ней
    обратный отсчёт хуже, чем не показывать ничего: часы, идущие в минус,
    выглядят как поломка.
    """
    n = int(ts or 0)
    return n if now() - 60 <= n <= now() + 2 * 86400 else 0


def fund_row(sym: str, rate: float, per: float, oi: float, vol: float, ex: str,
             known: bool = True, nxt: float = 0) -> dict | None:
    """Строка фандинга, если она проходит отбор.

    rate — доля за одну выплату (0,0001 = 0,01%), per — выплат в сутки.
    known говорит, знаем ли мы ликвидность вообще: если биржа не отдаёт ни
    интереса, ни оборота, отбрасывать по ним нельзя — так отсеялись бы все.
    """
    if not sym or not (abs(rate) > 0) or abs(rate) > FUND_MAX_RATE or per <= 0:
        return None
    if known and vol < FUND_MIN_VOL and oi < FUND_MIN_OI:
        return None
    return {
        "sym": sym,
        "ex": ex,
        "rate": rate * 100,
        # Суточная ставка — то, чем биржи сравнимы между собой.
        "day": rate * per * 100,
        "per": per,
        "oi": oi,
        "vol": vol,
        # Когда биржа спишет следующую выплату, в секундах эпохи.
        "next": fund_next(nxt),
    }


def fund_hl(hl: sqlite3.Connection | None) -> list:
    """Hyperliquid — из своей же базы: её наполняет бот, ходить некуда."""
    if not hl or not table_exists(hl, "hl_funding_rate"):
        return []
    cset = cols(hl, "hl_funding_rate")
    oi_sel = "oi_nanos" if "oi_nanos" in cset else "0"
    vol_sel = "day_vlm_nanos" if "day_vlm_nanos" in cset else "0"
    # Старая база без этих столбцов ликвидности не знает — тогда и отбирать по
    # ней нельзя, иначе Hyperliquid исчезнет из раздела целиком.
    known = oi_sel != "0" or vol_sel != "0"
    try:
        rows = hl.execute(
            f"SELECT coin, rate_nanos, {oi_sel} oi, {vol_sel} vol FROM hl_funding_rate "
            "WHERE hour_ts=(SELECT MAX(hour_ts) FROM hl_funding_rate)"
        ).fetchall()
    except sqlite3.Error:
        return []
    # Hyperliquid списывает фандинг в начале каждого часа — своего времени
    # выплаты у монеты нет, оно общее и считается от часов.
    nxt = (now() // 3600 + 1) * 3600
    out = []
    for r in rows:
        # Ставка Hyperliquid — часовая, поэтому выплат в сутки двадцать четыре.
        row = fund_row(str(r["coin"] or "").upper(), usd(r["rate_nanos"]), 24.0,
                       usd(r["oi"]), usd(r["vol"]), "hl", known, nxt)
        if row:
            out.append(row)
    return out


def fund_bingx() -> list:
    """BingX: ставки одним запросом, оборот — вторым."""
    prem = get_json("https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex")
    data = (prem or {}).get("data")
    if not isinstance(data, list):
        return []
    tick = get_json("https://open-api.bingx.com/openApi/swap/v2/quote/ticker")
    vols: dict[str, float] = {}
    for it in ((tick or {}).get("data") or []):
        if isinstance(it, dict):
            vols[str(it.get("symbol") or "")] = _fnum(it.get("quoteVolume"))
    out = []
    for it in data:
        if not isinstance(it, dict):
            continue
        raw = str(it.get("symbol") or "")
        hours = _fnum(it.get("fundingIntervalHours")) or 8.0
        row = fund_row(fund_sym(raw), _fnum(it.get("lastFundingRate")), 24.0 / hours,
                       0.0, vols.get(raw, 0.0), "bingx",
                       nxt=_fnum(it.get("nextFundingTime")) / 1000.0)
        if row:
            out.append(row)
    return out


CG_DERIV = {"binance": "binance_futures", "bybit": "bybit"}
# У бесплатного ключа CoinGecko счёт запросов месячный, а ставки там всё
# равно восьмичасовые: обновлять их чаще, чем раз в двадцать минут, незачем.
FUND_CG_TTL = 1200.0
_FUND_CG: dict[str, tuple[float, list]] = {}


def fund_cg(ex: str) -> list:
    """Запасной источник ставок — доска деривативов CoinGecko.

    Binance и Bybit отвечают на облачные адреса отказом по региону (451 и
    403), и с наших машин их собственный API недоступен. Тогда берём ставки
    у CoinGecko: там те же пары, открытый интерес и оборот в долларах.

    Чего там нет — шага выплат и времени следующей. У обеих бирж шаг по
    умолчанию восемь часов, отсчёт ведём до ближайшей границы 00/08/16 UTC.
    Для пар с другим шагом (у Binance такие есть) это приблизительно —
    точные значения приходят, только когда доступен API самой биржи.
    """
    slug = CG_DERIV.get(ex)
    if not slug:
        return []
    was = _FUND_CG.get(ex)
    if was and time.monotonic() - was[0] < FUND_CG_TTL:
        return list(was[1])
    data = get_json("https://api.coingecko.com/api/v3/derivatives/exchanges/"
                    f"{slug}?include_tickers=unexpired", timeout=25.0)
    rows_in = (data or {}).get("tickers")
    if not isinstance(rows_in, list):
        # Чаще всего это лимит запросов бесплатного ключа. Доска при этом не
        # обнуляется: fund_pull оставляет прошлый ответ до следующего круга.
        sys.stderr.write(f"[api] фандинг {ex}: CoinGecko не ответил\n")
        return []
    nxt = (int(time.time()) // 28800 + 1) * 28800
    out = []
    for it in rows_in:
        if not isinstance(it, dict) or it.get("contract_type") != "perpetual":
            continue
        # funding_rate у CoinGecko — проценты за выплату, у нас доля.
        vol = (it.get("converted_volume") or {}).get("usd")
        row = fund_row(fund_sym(str(it.get("symbol") or "")),
                       _fnum(it.get("funding_rate")) / 100.0, 3.0,
                       _fnum(it.get("open_interest_usd")), _fnum(vol),
                       ex, nxt=nxt)
        if row:
            out.append(row)
    if out:
        _FUND_CG[ex] = (time.monotonic(), out)
        sys.stderr.write(f"[api] фандинг {ex}: биржа недоступна, взяли CoinGecko ({len(out)})\n")
    return out


# Тот же API Binance отдаёт и основной домен фьючерсов, и домен сайта.
# Первый отказывает облачным адресам по региону (451), второй — не всегда,
# и лишний домен в списке дешевле, чем приблизительные ставки с CoinGecko.
BINANCE_HOSTS = ("https://fapi.binance.com", "https://www.binance.com")


def fund_binance() -> list:
    """Binance: ставки и обороты двумя запросами.

    Шаг выплат в premiumIndex не приходит: у большинства пар он восемь часов,
    у остальных его отдаёт fundingInfo — оттуда и берём исключения.

    Если не ответил ни один домен, остаётся CoinGecko: там те же пары, но без
    шага выплат и времени следующей.
    """
    host, prem = "", None
    for h in BINANCE_HOSTS:
        prem = get_json(f"{h}/fapi/v1/premiumIndex")
        if isinstance(prem, list) and prem:
            host = h
            break
    if not host:
        return fund_cg("binance")
    tick = get_json(f"{host}/fapi/v1/ticker/24hr")
    vols: dict[str, float] = {}
    for it in (tick if isinstance(tick, list) else []):
        if isinstance(it, dict):
            vols[str(it.get("symbol") or "")] = _fnum(it.get("quoteVolume"))
    steps: dict[str, float] = {}
    for it in (get_json(f"{host}/fapi/v1/fundingInfo") or []):
        if isinstance(it, dict):
            h = _fnum(it.get("fundingIntervalHours"))
            if h > 0:
                steps[str(it.get("symbol") or "")] = h
    out = []
    for it in prem:
        if not isinstance(it, dict):
            continue
        raw = str(it.get("symbol") or "")
        row = fund_row(fund_sym(raw), _fnum(it.get("lastFundingRate")),
                       24.0 / steps.get(raw, 8.0), 0.0, vols.get(raw, 0.0), "binance",
                       nxt=_fnum(it.get("nextFundingTime")) / 1000.0)
        if row:
            out.append(row)
    return out


def fund_gate() -> list:
    """Gate: ставка, шаг и открытый интерес приходят одним списком контрактов.

    Открытый интерес там в контрактах, а не в долларах: умножаем на размер
    контракта и цену — иначе порог ликвидности сравнивал бы штуки с долларами.
    """
    data = get_json("https://api.gateio.ws/api/v4/futures/usdt/contracts")
    if not isinstance(data, list):
        return []
    out = []
    for it in data:
        if not isinstance(it, dict) or it.get("in_delisting"):
            continue
        step = _fnum(it.get("funding_interval")) or 28800.0
        mark = _fnum(it.get("mark_price"))
        oi = _fnum(it.get("position_size")) * _fnum(it.get("quanto_multiplier")) * mark
        row = fund_row(fund_sym(it.get("name")), _fnum(it.get("funding_rate")),
                       86400.0 / step, oi, 0.0, "gate",
                       nxt=_fnum(it.get("funding_next_apply")))
        if row:
            out.append(row)
    return out




def fund_pull(ex: str) -> None:
    """Сходить на биржу и положить её ставки в кэш.

    Биржа, до которой не достучались, просто не появляется в приложении:
    пустая вкладка с её именем выглядела бы как поломка у нас, хотя отказали
    там. Прошлый ответ при этом не затирается — ставки живут часами, и вчерашний
    перекос ближе к правде, чем пустота.
    """
    fn = FUND_FETCH.get(ex)
    if not fn:
        return
    try:
        rows = fn()
    except Exception as e:
        sys.stderr.write(f"[api] фандинг {ex}: {e}\n")
        return
    if not rows:
        sys.stderr.write(f"[api] фандинг {ex}: пусто, оставляем прошлый ответ\n")
        return
    with _fund_lock:
        _FUND[ex] = (time.monotonic(), rows)


def fund_refresher() -> None:
    """Опрос бирж своим потоком, а не внутри сборки общего кэша.

    У сборки есть бюджет в двадцать пять секунд, и пять из них, потраченные
    на три чужих сервера, отнимались бы у того, что считается после, — у
    ротации и справочника монет. Здесь же ожидание никому не мешает: ставки
    меняются раз в час-восемь, и десятиминутный круг их не упускает.
    """
    while True:
        for ex in FUND_FETCH:
            fund_pull(ex)
        time.sleep(FUND_TTL)


def fund_bybit() -> list:
    """Bybit: ставки и ликвидность одним запросом, шаг выплат — вторым."""
    tick = get_json("https://api.bybit.com/v5/market/tickers?category=linear")
    rows_in = (((tick or {}).get("result") or {}).get("list")) or []
    if not rows_in:
        return fund_cg("bybit")
    steps: dict[str, float] = {}
    info = get_json("https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000")
    for it in ((((info or {}).get("result") or {}).get("list")) or []):
        if isinstance(it, dict):
            # fundingInterval приходит в минутах
            mins = _fnum(it.get("fundingInterval"))
            if mins > 0:
                steps[str(it.get("symbol") or "")] = mins / 60.0
    out = []
    for it in rows_in:
        if not isinstance(it, dict):
            continue
        raw = str(it.get("symbol") or "")
        row = fund_row(fund_sym(raw), _fnum(it.get("fundingRate")),
                       24.0 / steps.get(raw, 8.0),
                       _fnum(it.get("openInterestValue")), _fnum(it.get("turnover24h")),
                       "bybit", nxt=_fnum(it.get("nextFundingTime")) / 1000.0)
        if row:
            out.append(row)
    return out


def fund_okx() -> list:
    """OKX: ставки всех бессрочных одним запросом — instId=ANY.

    Шаг выплат у OKX разный (четыре часа и восемь), но в ответе есть время
    прошлой и следующей: разница между ними и есть шаг.
    """
    prem = get_json("https://www.okx.com/api/v5/public/funding-rate?instId=ANY", timeout=20.0)
    data = (prem or {}).get("data")
    if not isinstance(data, list):
        return []
    # Оборот считаем по тикерам: объём там в монетах, переводим ценой.
    vols: dict[str, float] = {}
    tick = get_json("https://www.okx.com/api/v5/market/tickers?instType=SWAP", timeout=20.0)
    for it in ((tick or {}).get("data") or []):
        if isinstance(it, dict):
            vols[str(it.get("instId") or "")] = _fnum(it.get("volCcy24h")) * _fnum(it.get("last"))
    out = []
    for it in data:
        if not isinstance(it, dict):
            continue
        inst = str(it.get("instId") or "")
        nxt = _fnum(it.get("nextFundingTime")) / 1000.0
        prev = _fnum(it.get("fundingTime")) / 1000.0
        step = (nxt - prev) / 3600.0
        row = fund_row(fund_sym(inst.replace("-SWAP", "")), _fnum(it.get("fundingRate")),
                       24.0 / step if 0.9 <= step <= 24.5 else 3.0,
                       0.0, vols.get(inst, 0.0), "okx", nxt=nxt)
        if row:
            out.append(row)
    return out


def fund_kraken() -> list:
    """Kraken Futures: всё одним запросом.

    Ставка там абсолютная — столько долларов на контракт, — и сравнивать её
    с процентами других бирж нельзя, пока не поделишь на цену.
    """
    data = (get_json("https://futures.kraken.com/derivatives/api/v3/tickers") or {}).get("tickers")
    if not isinstance(data, list):
        return []
    out = []
    for it in data:
        if not isinstance(it, dict) or it.get("tag") != "perpetual" or it.get("suspended"):
            continue
        mark = _fnum(it.get("markPrice"))
        if mark <= 0:
            continue
        sym = str(it.get("symbol") or "").upper()
        if sym.startswith("PF_"):
            sym = sym[3:]
        # Kraken платит фандинг каждый час.
        row = fund_row(fund_sym(sym), _fnum(it.get("fundingRate")) / mark, 24.0,
                       _fnum(it.get("openInterest")) * mark, _fnum(it.get("volumeQuote")),
                       "kraken", nxt=(now() // 3600 + 1) * 3600)
        if row:
            out.append(row)
    return out


def fund_coinbase() -> list:
    """Coinbase International: ставка, шаг и ликвидность — в списке инструментов."""
    data = get_json("https://api.international.coinbase.com/api/v1/instruments", timeout=20.0)
    if not isinstance(data, list):
        return []
    out = []
    for it in data:
        if not isinstance(it, dict) or it.get("type") != "PERP":
            continue
        q = it.get("quote") or {}
        mark = _fnum(q.get("mark_price"))
        # Шаг выплат приходит в наносекундах.
        step = _fnum(it.get("funding_interval")) / 3.6e12
        row = fund_row(fund_sym(str(it.get("symbol") or "").replace("-PERP", "")),
                       _fnum(q.get("predicted_funding")),
                       24.0 / step if 0.9 <= step <= 24.5 else 24.0,
                       _fnum(it.get("open_interest")) * mark, _fnum(it.get("notional_24hr")),
                       "coinbase", nxt=(now() // 3600 + 1) * 3600)
        if row:
            out.append(row)
    return out


def fund_bitget() -> list:
    """Bitget: ставки и шаг выплат одним запросом, ликвидность — вторым.

    Шаг приходит прямо в часах, а время следующей выплаты — отдельным полем:
    гадать, как у бирж без этих полей, не приходится. Открытый интерес там в
    монетах, поэтому переводим его ценой.
    """
    data = get_json("https://api.bitget.com/api/v2/mix/market/"
                    "current-fund-rate?productType=USDT-FUTURES", timeout=20.0)
    rows_in = (data or {}).get("data")
    if not isinstance(rows_in, list):
        return []
    tick = get_json("https://api.bitget.com/api/v2/mix/market/"
                    "tickers?productType=USDT-FUTURES", timeout=20.0)
    liq: dict[str, tuple[float, float]] = {}
    for it in ((tick or {}).get("data") or []):
        if isinstance(it, dict):
            mark = _fnum(it.get("markPrice")) or _fnum(it.get("lastPr"))
            liq[str(it.get("symbol") or "")] = (_fnum(it.get("holdingAmount")) * mark,
                                                _fnum(it.get("usdtVolume")))
    out = []
    for it in rows_in:
        if not isinstance(it, dict):
            continue
        raw = str(it.get("symbol") or "")
        step = _fnum(it.get("fundingRateInterval"))
        oi, vol = liq.get(raw, (0.0, 0.0))
        row = fund_row(fund_sym(raw), _fnum(it.get("fundingRate")),
                       24.0 / step if 0.9 <= step <= 24.5 else 3.0, oi, vol, "bitget",
                       nxt=_fnum(it.get("nextUpdate")) / 1000.0)
        if row:
            out.append(row)
    return out


MEXC_SIZE_TTL = 21600.0
_MEXC_SIZE: tuple[float, dict[str, float]] = (0.0, {})


def mexc_sizes() -> dict[str, float]:
    """Размер контракта по каждой паре MEXC.

    Без него открытый интерес остаётся в контрактах и сравнивать его с
    долларовым порогом нельзя. Выгрузка на два мегабайта и меняется редко —
    держим её шесть часов, а не тянем каждый круг.
    """
    global _MEXC_SIZE
    was = _MEXC_SIZE
    if was[1] and time.monotonic() - was[0] < MEXC_SIZE_TTL:
        return was[1]
    data = get_json("https://api.mexc.com/api/v1/contract/detail", timeout=30.0)
    out: dict[str, float] = {}
    for it in ((data or {}).get("data") or []):
        if isinstance(it, dict):
            size = _fnum(it.get("contractSize"))
            if size > 0:
                out[str(it.get("symbol") or "")] = size
    if not out:
        return was[1]
    _MEXC_SIZE = (time.monotonic(), out)
    return out


def fund_mexc() -> list:
    """MEXC: ставка с шагом одним запросом, ликвидность — вторым.

    Домен фьючерсов (contract.mexc.com) отказывает облачным адресам, тот же
    API отдаёт api.mexc.com — по нему и ходим. Открытый интерес приходит в
    контрактах: переводим его размером контракта и ценой.
    """
    data = get_json("https://api.mexc.com/api/v1/contract/funding_rate", timeout=25.0)
    rows_in = (data or {}).get("data")
    if not isinstance(rows_in, list):
        return []
    tick = get_json("https://api.mexc.com/api/v1/contract/ticker", timeout=25.0)
    sizes = mexc_sizes()
    liq: dict[str, tuple[float, float]] = {}
    for it in ((tick or {}).get("data") or []):
        if isinstance(it, dict):
            raw = str(it.get("symbol") or "")
            price = _fnum(it.get("fairPrice")) or _fnum(it.get("lastPrice"))
            liq[raw] = (_fnum(it.get("holdVol")) * sizes.get(raw, 0.0) * price,
                        _fnum(it.get("amount24")))
    out = []
    for it in rows_in:
        if not isinstance(it, dict):
            continue
        raw = str(it.get("symbol") or "")
        # collectCycle — шаг выплат в часах.
        step = _fnum(it.get("collectCycle"))
        oi, vol = liq.get(raw, (0.0, 0.0))
        row = fund_row(fund_sym(raw), _fnum(it.get("fundingRate")),
                       24.0 / step if 0.9 <= step <= 24.5 else 3.0,
                       oi, vol, "mexc",
                       nxt=_fnum(it.get("nextSettleTime")) / 1000.0)
        if row:
            out.append(row)
    return out


def fund_kucoin() -> list:
    """KuCoin Futures: ставка, шаг, интерес и оборот — одним запросом.

    Имена там свои: биткойн зовётся XBT, а к контракту добавлена M. Берём
    базовую валюту из ответа, а не разбираем имя — так надёжнее.
    """
    data = get_json("https://api-futures.kucoin.com/api/v1/contracts/active", timeout=20.0)
    rows_in = (data or {}).get("data")
    if not isinstance(rows_in, list):
        return []
    out = []
    for it in rows_in:
        if not isinstance(it, dict) or it.get("status") != "Open" or it.get("expireDate"):
            continue
        if str(it.get("settleCurrency") or "").upper() != "USDT":
            continue
        base = str(it.get("baseCurrency") or "").upper()
        if base == "XBT":
            base = "BTC"
        mark = _fnum(it.get("markPrice"))
        # Шаг выплат приходит в миллисекундах.
        step = _fnum(it.get("currentFundingRateGranularity")
                     or it.get("fundingRateGranularity")) / 3.6e6
        row = fund_row(fund_sym(base), _fnum(it.get("fundingFeeRate")),
                       24.0 / step if 0.9 <= step <= 24.5 else 3.0,
                       _fnum(it.get("openInterest")) * _fnum(it.get("multiplier")) * mark,
                       _fnum(it.get("turnoverOf24h")), "kucoin",
                       nxt=_fnum(it.get("nextFundingRateDateTime")) / 1000.0)
        if row:
            out.append(row)
    return out


def fund_aster() -> list:
    """Aster: порядок тот же, что у Binance, — её API построен по образцу."""
    prem = get_json("https://fapi.asterdex.com/fapi/v1/premiumIndex", timeout=20.0)
    if not isinstance(prem, list):
        return []
    tick = get_json("https://fapi.asterdex.com/fapi/v1/ticker/24hr", timeout=20.0)
    vols: dict[str, float] = {}
    for it in (tick if isinstance(tick, list) else []):
        if isinstance(it, dict):
            vols[str(it.get("symbol") or "")] = _fnum(it.get("quoteVolume"))
    steps: dict[str, float] = {}
    for it in (get_json("https://fapi.asterdex.com/fapi/v1/fundingInfo", timeout=20.0) or []):
        if isinstance(it, dict):
            h = _fnum(it.get("fundingIntervalHours"))
            if h > 0:
                steps[str(it.get("symbol") or "")] = h
    out = []
    for it in prem:
        if not isinstance(it, dict):
            continue
        raw = str(it.get("symbol") or "")
        row = fund_row(fund_sym(raw), _fnum(it.get("lastFundingRate")),
                       24.0 / steps.get(raw, 8.0), 0.0, vols.get(raw, 0.0), "aster",
                       nxt=_fnum(it.get("nextFundingTime")) / 1000.0)
        if row:
            out.append(row)
    return out


# --- Оплата премиума из приложения ------------------------------------------
#
# Своей выдачи подписки здесь нет намеренно: она уже написана в premium.cpp и
# должна остаться в одном месте. Бот проверяет оплату, продлевает срок и
# пишет платёж в историю — что для звёзд, что для USD₮.
#
# Звёзды: счёт создаёт этот API (createInvoiceLink), подтверждение Telegram
# шлёт боту — он и выдаёт подписку, как при покупке из чата.
#
# USD₮: счёт кладётся в таблицу ton_invoices бота с пометкой kind='usdt', а
# приход денег видит его же опрос (pollUsdtPayments) и выдаёт подписку.


def tg_api(method: str, data: dict, timeout: float = 15.0):
    """Вызов Bot API. Ошибка сети или отказ Telegram — это None."""
    if not BOT_TOKEN:
        return None
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
        data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError, OSError) as e:
        sys.stderr.write(f"[api] {method}: {e}\n")
        return None
    if not isinstance(out, dict) or not out.get("ok"):
        sys.stderr.write(f"[api] {method}: {str(out)[:200]}\n")
        return None
    return out.get("result")


def usdt_ready(con: sqlite3.Connection | None) -> bool:
    """Готов ли бот принимать USD₮.

    Признак — столбец kind в его таблице счетов: он появляется вместе с
    опросом переводов USD₮. Пока бот старый, кнопку показывать нельзя: счёт
    выставился бы, деньги ушли, а подписку выдать было бы некому.
    """
    if not TON_WALLET or not con or not table_exists(con, "ton_invoices"):
        return False
    return "kind" in cols(con, "ton_invoices")


def pay_memo() -> str:
    """Памятка к переводу. Буквы без похожих друг на друга: человек иногда
    перебивает её руками, и «0» с «O» в этот момент стоят денег."""
    abc = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
    return "WT-" + "".join(secrets.choice(abc) for _ in range(5))


# Названия счёта на языке человека. Их всего два, и тащить ради них весь
# словарь приложения незачем — но и по-английски человеку, который выбрал
# русский, счёт показывать не дело.
PAY_TEXT = {
    "title": {
        "en": "Wallet Tracker Premium", "ru": "Wallet Tracker Премиум",
        "uk": "Wallet Tracker Преміум", "es": "Wallet Tracker Premium",
        "pt": "Wallet Tracker Premium", "de": "Wallet Tracker Premium",
        "fr": "Wallet Tracker Premium", "tr": "Wallet Tracker Premium",
        "pl": "Wallet Tracker Premium", "id": "Wallet Tracker Premium",
        "vi": "Wallet Tracker Premium", "ja": "Wallet Tracker プレミアム",
        "ko": "Wallet Tracker 프리미엄", "zh": "Wallet Tracker 高级版",
        "hi": "Wallet Tracker प्रीमियम", "ar": "Wallet Tracker بريميوم",
    },
    "desc": {
        "en": "30 days: 50 wallets, Hyperliquid futures, full Top-100",
        "ru": "30 дней: 50 кошельков, фьючерсы Hyperliquid, полный Топ-100",
        "uk": "30 днів: 50 гаманців, ф’ючерси Hyperliquid, повний Топ-100",
        "es": "30 días: 50 carteras, futuros de Hyperliquid, Top-100 completo",
        "pt": "30 dias: 50 carteiras, futuros da Hyperliquid, Top-100 completo",
        "de": "30 Tage: 50 Wallets, Hyperliquid-Futures, komplette Top-100",
        "fr": "30 jours : 50 portefeuilles, futures Hyperliquid, Top-100 complet",
        "tr": "30 gün: 50 cüzdan, Hyperliquid vadeli işlemler, tam Top-100",
        "pl": "30 dni: 50 portfeli, kontrakty Hyperliquid, pełny Top-100",
        "id": "30 hari: 50 dompet, futures Hyperliquid, Top-100 penuh",
        "vi": "30 ngày: 50 ví, futures Hyperliquid, Top-100 đầy đủ",
        "ja": "30日間：ウォレット50個、Hyperliquid先物、トップ100すべて",
        "ko": "30일: 지갑 50개, Hyperliquid 선물, 전체 Top-100",
        "zh": "30 天：50 个钱包、Hyperliquid 合约、完整前 100",
        "hi": "30 दिन: 50 वॉलेट, Hyperliquid फ्यूचर्स, पूरा टॉप-100",
        "ar": "30 يومًا: 50 محفظة، عقود Hyperliquid، أفضل 100 كاملة",
    },
}


def t_pay(lang: str, key: str) -> str:
    box = PAY_TEXT[key]
    return box.get((lang or "en").lower(), box["en"])


def pay_stars(chat: str, lang: str) -> dict:
    """Ссылка на счёт в звёздах.

    Полезная нагрузка и сумма — ровно те, что ждёт бот: он проверяет их у
    себя и с чужим счётом подписку не выдаст.
    """
    link = tg_api("createInvoiceLink", {
        "title": t_pay(lang, "title"),
        "description": t_pay(lang, "desc"),
        "payload": PREMIUM_PAYLOAD,
        # Для звёзд поставщик не нужен, и поле обязано быть пустым.
        "provider_token": "",
        "currency": "XTR",
        "prices": [{"label": t_pay(lang, "title"), "amount": PREMIUM_STARS}],
    })
    if not isinstance(link, str) or not link:
        return {"ok": False, "error": "invoice_failed"}
    return {"ok": True, "link": link, "stars": PREMIUM_STARS, "days": PREMIUM_DAYS}


def pay_usdt(chat: str) -> dict:
    """Счёт на USD₮: памятка, сумма и кошелёк.

    Строка кладётся в таблицу счетов бота — ту же, что он завёл для TON, с
    пометкой вида. Проверять оплату и выдавать подписку будет он.

    Пока счёт жив, повторный запрос отдаёт тот же: два счёта на одного
    человека означали бы, что один перевод закрывает не тот из них.
    """
    con = open_db(DB, write=True)
    if not con:
        return {"ok": False, "error": "db_missing"}
    try:
        if not usdt_ready(con):
            return {"ok": False, "error": "ton_off"}
        units = int(round(PREMIUM_USDT * (10 ** USDT_DECIMALS)))
        row = con.execute(
            "SELECT memo, nano_amount, created_at FROM ton_invoices "
            "WHERE chat_id=? AND status='active' AND kind='usdt' AND created_at>? "
            "ORDER BY created_at DESC LIMIT 1",
            (chat, now() - PAY_TTL)).fetchone()
        if row:
            memo, units, made = row["memo"], int(row["nano_amount"]), int(row["created_at"])
        else:
            memo, made = pay_memo(), now()
            con.execute(
                "INSERT INTO ton_invoices(memo, chat_id, nano_amount, status, created_at, kind) "
                "VALUES(?,?,?,'active',?,'usdt')", (memo, chat, units, made))
            con.commit()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] счёт USD₮: {e}\n")
        return {"ok": False, "error": "db_error"}
    finally:
        con.close()
    return {
        "ok": True,
        "memo": memo,
        "units": units,
        "amount": units / (10 ** USDT_DECIMALS),
        "wallet": TON_WALLET,
        "jetton": USDT_MASTER_UI,
        "decimals": USDT_DECIMALS,
        "until": made + PAY_TTL,
        "days": PREMIUM_DAYS,
    }


def pay_jetton(owner: str) -> dict:
    """Адрес кошелька USD₮ у плательщика.

    Перевод жетона отправляется не получателю, а собственному жетонному
    кошельку отправителя — он и рассылает дальше. Адрес считает сеть, и
    спрашиваем её мы, а не приложение: ходить наружу из браузера незачем.
    """
    own = (owner or "").strip()
    # Кошелёк отдаёт сырой вид (`0:…`), сервер — человеческий: годятся оба.
    if not (re.fullmatch(r"[A-Za-z0-9_-]{48}", own) or re.fullmatch(r"-?\d+:[0-9a-fA-F]{64}", own)):
        return {"ok": False, "error": "bad_owner"}
    url = (f"{TONCENTER}jetton/wallets?owner_address={urllib.parse.quote(own)}"
           f"&jetton_address={USDT_MASTER_UI}&limit=1")
    if TONCENTER_KEY:
        url += f"&api_key={TONCENTER_KEY}"
    data = get_json(url, timeout=20.0)
    rows = (data or {}).get("jetton_wallets")
    if not isinstance(rows, list) or not rows:
        # Кошелька USD₮ нет — значит этих денег у человека тоже нет.
        return {"ok": False, "error": "no_usdt"}
    book = (data or {}).get("address_book") or {}
    raw = str(rows[0].get("address") or "")
    nice = (book.get(raw) or {}).get("user_friendly") or raw
    return {"ok": True, "address": nice}


def pay_check(chat: str) -> dict:
    """Что со счётом и с подпиской.

    Оплату находит бот своим опросом раз в двадцать секунд — здесь только
    смотрим, что он уже записал.
    """
    con = open_db(DB)
    if not con:
        return {"ok": False, "error": "db_missing"}
    try:
        status, until = "none", 0
        if table_exists(con, "ton_invoices") and "kind" in cols(con, "ton_invoices"):
            row = con.execute(
                "SELECT status, created_at FROM ton_invoices "
                "WHERE chat_id=? AND kind='usdt' ORDER BY created_at DESC LIMIT 1",
                (chat,)).fetchone()
            if row:
                status = row["status"]
                until = int(row["created_at"]) + PAY_TTL
                if status == "active" and until < now():
                    status = "expired"
        prem = is_premium(con, chat)
        row = con.execute(
            "SELECT premium_expire FROM users WHERE chat_id=?", (chat,)).fetchone() if prem else None
        return {
            "ok": True,
            "status": status,
            "plan": "premium" if prem else "free",
            "premUntil": int(row["premium_expire"]) * 1000 if row else 0,
            "until": until,
        }
    except sqlite3.Error as e:
        return {"ok": False, "error": str(e)}
    finally:
        con.close()


FUND_FETCH = {
    "bingx": fund_bingx,
    "bitget": fund_bitget,
    "mexc": fund_mexc,
    "kucoin": fund_kucoin,
    "aster": fund_aster,
    "binance": fund_binance,
    "bybit": fund_bybit,
    "okx": fund_okx,
    "gate": fund_gate,
    "kraken": fund_kraken,
    "coinbase": fund_coinbase,
}


def fund_venue(ex: str, hl: sqlite3.Connection | None) -> list:
    """Строки одной биржи. Hyperliquid — из своей базы, прочие — из кэша."""
    if ex == "hl":
        return fund_hl(hl)
    with _fund_lock:
        hit = _FUND.get(ex)
    return hit[1] if hit else []


# Полные доски по биржам, из которых нарезаются страницы. Подменяются
# целиком, как и столбцы ротации: читающий поток видит либо прошлый набор,
# либо новый, но не половину нового.
_FUND_ALL: dict[str, list] = {}


def load_funding(hl: sqlite3.Connection | None) -> dict:
    """Первые страницы досок по биржам. Полные лежат в _FUND_ALL.

    Общей доски «со всех бирж» больше нет: одна и та же монета стояла в ней
    несколько раз — по строке на биржу, — и список превращался в перечень
    повторов, где биржа была единственным различием. Вопрос «где сейчас
    платят» — это вопрос про конкретную биржу, ей и отвечаем.

    Перекосы отдаём все, а не первые сорок: на крупной бирже их под тысячу, и
    обрывать список там, где кончается витрина, значит прятать половину.
    Возить их все каждому запуску незачем — остальные страницы достаются по
    запросу, как страницы ротации.
    """
    global _FUND_ALL
    out: dict[str, list] = {}
    full: dict[str, list] = {}
    for ex in FUND_VENUES:
        rows = fund_venue(ex, hl)
        if not rows:
            continue
        rows.sort(key=lambda r: -abs(r["day"]))
        full[ex] = rows
        out[ex] = rows[:FUND_PAGE]
    _FUND_ALL = full
    return out


def fund_counts() -> dict:
    """Сколько перекосов на каждой бирже: по ним рисуются страницы."""
    return {ex: len(rows) for ex, rows in _FUND_ALL.items()}


# Окна ротации — те же пять, что у потока: раздел отвечает на тот же вопрос
# «за какой срок», и два разных набора окон в соседних разделах человек
# читал бы как разные сроки под одинаковыми подписями.
ROT_WINDOWS = FLOW_WINDOWS
# Монет в каждом столбце общей выгрузки — ровно одна страница. Пятёрки
# хватало на витрину, но не на ответ: за месяц монет, из которых выходят,
# сотни. Возить их все каждому запуску незачем — остальные страницы
# достаются по запросу, как страницы потока.
ROT_COINS = 15
# Сколько монет держим для листания. Дальше идут монеты на сотню-другую
# долларов: это уже не ротация, а пыль, и листать до неё никто не станет.
ROT_KEEP = 400

# Полные столбцы окна, из которых нарезаются страницы. Пересобираются вместе
# с общим кэшем и подменяются целиком: читающий поток видит либо прошлый
# набор, либо новый, но не половину нового.
_ROT_ALL: dict[str, dict[str, list]] = {}


def empty_rot() -> dict:
    return {k: None for k in ROT_WINDOWS}


def rot_page(rows: list, offset: int, limit: int) -> list[dict]:
    """Страница столбца: пары (тикер, сумма) — в то, что понимает приложение."""
    return [{"sym": s, "usd": u} for s, u in rows[max(0, offset):max(0, offset) + limit]]


def load_rot(cur: sqlite3.Connection) -> dict:
    """Переходы денег из монеты в монету по всем окнам за один обход базы.

    Пара считается так: кошелёк что-то продал, а следующей покупкой взял
    другую монету — значит, деньги переложили. В окно пара попадает, только
    если в него попали обе половины; продажа трёхдневной давности ничего не
    говорит о том, что происходило за последний час.

    Окна раньше считались отдельными запросами — сутки и неделя. Пять
    отдельных запросов стоили бы пяти сортировок сотен тысяч строк, а нужен
    ровно один: строки идут по кошельку и времени, и каждая найденная пара
    сразу раскладывается по всем окнам, куда она попадает. Обходится это
    одним сравнением на окно, а самый длинный запрос — тот же, что и был.

    Отдаётся не список пар, а свод по монетам: из каких деньги уходили и в
    какие приходили, со своими суммами. Пары нужны, чтобы это посчитать, но
    показывать их отдельным списком незачем — он говорит то же самое, только
    дробно: одна и та же монета расходится по нему десятком строк, и
    насколько из неё вышли всего, по списку не сложить.

    Суммы столбцов считаются по всем парам окна, а не по тем, что доехали до
    приложения: там лежат только верхние монеты, и сложить их значило бы
    выдать часть за целое.
    """
    global _ROT_ALL
    out = empty_rot()
    # Новый набор собирается отдельно и подменяет прежний одним присваиванием
    # в самом конце: до тех пор страницы листаются по прошлому.
    page: dict[str, dict[str, list]] = {}
    if not table_exists(cur, "trades"):
        return out
    ign = table_exists(cur, "ignored_wallets")
    ban = (
        "AND NOT EXISTS (SELECT 1 FROM ignored_wallets iw "
        "WHERE iw.wallet = t.wallet AND iw.permanent = 1) "
        if ign
        else ""
    )
    stamp = now()
    # От самого длинного окна к короткому: длинное включает в себя все
    # остальные, поэтому обходим строки один раз.
    cuts = sorted(((k, stamp - sec) for k, sec in ROT_WINDOWS.items()), key=lambda x: x[1])
    agg: dict[str, dict[tuple[str, str], list]] = {k: {} for k in ROT_WINDOWS}
    # Тикер из общего справочника, а не отдельным запросом на строку: за
    # неделю строк сотни тысяч, и поход в базу на каждую превращал сбор
    # ротации в десять секунд на каждой перестройке кэша.
    syms = symbol_map(cur)
    last_sell: dict[str, tuple[str, int]] = {}
    # Курсор читаем на ходу, без fetchall: за месяц это полмиллиона строк, и
    # держать их все в памяти незачем — каждая нужна ровно один раз.
    #
    # Порядок — по времени, а не «кошелёк, время»: последняя продажа хранится
    # на каждый кошелёк отдельно, и общего хода времени для этого хватает.
    # Зато это просмотр отрезка индекса по времени без сортировки выборки —
    # с сортировкой месяц сделок разбирался дольше, чем сборке кэша отведено
    # всего, и ротация на проде не доживала до ответа.
    rows = cur.execute(
        "SELECT t.wallet, t.token, t.is_buy, t.usd_nanos, t.timestamp FROM trades t "
        f"WHERE t.timestamp >= ? AND t.usd_nanos > 0 AND t.usd_nanos <= ? {ban} "
        "ORDER BY t.timestamp, t.id",
        (cuts[0][1], MAX_SPOT_USD_NANOS),
    )
    for r in rows:
        w = (r["wallet"] or "").lower()
        tok = syms.get((r["token"] or "").lower())
        if not tok:
            continue
        if r["is_buy"]:
            prev = last_sell.get(w)
            if prev and prev[0] != tok:
                src, sold_at = prev
                val = usd(r["usd_nanos"])
                # Строки кошелька идут по времени, поэтому покупка не раньше
                # своей продажи: хватает проверить попадание продажи.
                for key, cut in cuts:
                    if sold_at < cut:
                        continue
                    slot = agg[key].setdefault((src, tok), [0.0, set()])
                    slot[0] += val
                    slot[1].add(w)
        else:
            last_sell[w] = (tok, r["timestamp"])

    for key in ROT_WINDOWS:
        a = agg[key]
        src_sum: dict[str, float] = {}
        dst_sum: dict[str, float] = {}
        seen: set[str] = set()
        total = 0.0
        pairs = 0
        for (s, d), v in a.items():
            if v[0] <= 0:
                continue
            pairs += 1
            total += v[0]
            src_sum[s] = src_sum.get(s, 0.0) + v[0]
            dst_sum[d] = dst_sum.get(d, 0.0) + v[0]
            seen |= v[1]
        keep = lambda m: sorted(m.items(), key=lambda kv: -kv[1])[:ROT_KEEP]  # noqa: E731
        full_src, full_dst = keep(src_sum), keep(dst_sum)
        page[key] = {"src": full_src, "dst": full_dst}
        out[key] = {
            "usd": total,
            "pairs": pairs,
            "w": len(seen),
            "src": rot_page(full_src, 0, ROT_COINS),
            "dst": rot_page(full_dst, 0, ROT_COINS),
            # Сколько монет в столбце. Это число — и подпись в заголовке, и
            # число страниц: сколько написано, столько и можно пролистать.
            # Поэтому считается по тому, что оставлено для листания, а не по
            # всем найденным: обещать монету, до которой не долистать, хуже,
            # чем не назвать хвост, в котором лежат сотни долларов.
            "msrc": len(full_src),
            "mdst": len(full_dst),
        }
    _ROT_ALL = page
    return out


# Ротация считается своим потоком, как ставки бирж, а не внутри сборки кэша.
#
# Внутри сборки она стояла почти последней, с бюджетом в двадцать пять секунд
# на всё, и на проде до неё не доходила очередь: каждая сборка начиналась с
# пустой ротации и такой же её отдавала — «за это окно данных пока нет» во
# всех пяти окнах. Здесь её ничто не торопит, а сборка берёт готовое.
ROT_TTL = 180.0
_ROT_SUM: dict = {}
_rot_lock = threading.Lock()


def rot_latest() -> dict:
    """Последний посчитанный свод; до первого круга — пустые окна."""
    with _rot_lock:
        return _ROT_SUM or empty_rot()


def rot_refresh_once() -> float:
    """Один пересчёт; сколько он занял. Неудача оставляет прошлый свод."""
    global _ROT_SUM
    t0 = time.monotonic()
    cur = open_db(DB)
    if not cur:
        return 0.0
    try:
        data = load_rot(cur)
        if any(data.values()):
            with _rot_lock:
                _ROT_SUM = data
        took = time.monotonic() - t0
        sys.stderr.write(f"[api] ротация: {took:.1f}с, пар за сутки "
                         f"{(data.get('24') or {}).get('pairs', 0)}\n")
        return took
    except Exception as e:
        sys.stderr.write(f"[api] ротация: {e}\n")
        return time.monotonic() - t0
    finally:
        try:
            cur.close()
        except Exception:
            pass


def rot_refresher() -> None:
    while True:
        took = rot_refresh_once()
        # Долгий пересчёт — реже: база не должна быть занята им постоянно.
        time.sleep(max(ROT_TTL, took * 4))


ORACLE_FEATURES = (
    # Порядок обязан совпадать с FEAT_NAME в oracle.cpp: важности приходят
    # массивом без имён, и сдвиг на единицу подписал бы чужие колонки.
    "flow", "volume", "wallets", "spread", "accel",
    "trades", "ticket", "top100", "top dir", "both",
    "ret 1h", "ret 6h", "ret 24h", "vol 24h", "vol jump",
    "to high", "from low", "RSI", "trend", "ATR",
    "funding", "funding z", "OI 1h", "OI 24h", "OI/vlm",
    "vlm 24h", "liq skew", "liq/OI", "leverage", "liquidity",
    "BTC 24h", "BTC vol", "breadth", "hour", "hour 2",
    "MACD", "MACD sig", "MACD hist",
    # Событие: возраст монеты в рядах (он же — давность листинга), всплеск
    # объёма против собственной недели и сила удара за последние часы.
    "age", "vlm z", "shock",
    # Разметка ряда на колена: глубина отката, близость к уровню Фибоначчи,
    # длина текущего хода против предыдущего, сколько колен подряд рынок
    # идёт в одну сторону, идёт ли нынешнее заодно с ними и длиннее ли оно.
    "fib back", "fib level", "fib ext", "wave run", "wave with", "wave grow",
)

# Горизонты — те же числа, что в oracle.cpp (ORACLE_H6, ORACLE_H24). Держать
# их здесь приходится: питон не позовёт C++. Зато они стоят одним местом и с
# именами, а не числом внутри SQL, как было раньше, — и видно, что менять,
# если бот изменится.
ORACLE_H6 = 6 * 3600
ORACLE_H24 = 86400
ORACLE_HZ = (ORACLE_H6, ORACLE_H24)


def _count_ready(cur: sqlite3.Connection, perp: bool, horizon: int = ORACLE_H24) -> int:
    """Сколько размеченных исходов набралось на этом горизонте.

    Условия обязаны совпадать с loadSamples в oracle.cpp: один пример на
    монету в окно длиной с горизонт. Раньше здесь стояло своё — порог хода
    числом 50 прямо в SQL, лишнее `buy_nanos!=sell_nanos` и только суточный
    горизонт, — и полоса на экране считала не то, чего ждёт обучение.

    Порога хода здесь нет намеренно. Бот тихие исходы больше не выбрасывает:
    они остаются с весом в четверть, потому что «цена никуда не пошла» — это
    тоже ответ, и выбрасывать его значит учить модель на одних только
    сильных ходах. Появись порог здесь снова — счётчик показывал бы меньше,
    чем ждёт обучение, и полоса упиралась бы в предел, которого нет.

    Шаг прореживания равен горизонту, а не суткам: журнал пишется каждый час,
    и соседние часы по одной монете почти одинаковы, а окна их исходов
    перекрываются. Непересекающихся шестичасовых окон в сутках четыре, и
    обучение берёт все четыре — счётчик обязан считать так же.
    """
    px = "price_6h" if horizon == ORACLE_H6 else "price_24h"
    filled = "filled_6h" if horizon == ORACLE_H6 else "filled_at"
    cset = cols(cur, "ai_events")
    if px not in cset or filled not in cset:
        return 0
    try:
        row = cur.execute(
            f"SELECT COUNT(*) n FROM ai_events e "
            f"WHERE e.{filled}>0 AND e.price_then>0 AND e.{px}>0 "
            f"AND e.window_days=24 AND e.venue=? "
            f"AND NOT EXISTS ("
            f"  SELECT 1 FROM ai_events e2 WHERE e2.token=e.token AND e2.venue=e.venue "
            f"  AND e2.window_days=24 AND e2.{filled}>0 AND e2.price_then>0 AND e2.{px}>0 "
            f"  AND e2.ts/{int(horizon)}=e.ts/{int(horizon)} AND e2.id<e.id)",
            (1 if perp else 0,),
        ).fetchone()
        return int(row["n"] if row else 0)
    except sqlite3.Error:
        return 0


def _ai_trained(cur: sqlite3.Connection, perp: bool) -> tuple[bool, float | None]:
    if not table_exists(cur, "ai_weights"):
        return False, None
    n_key, acc_key = (300, 302) if perp else (100, 102)
    w0, w1 = (500, 511) if perp else (400, 411)
    try:
        n = cur.execute("SELECT v FROM ai_weights WHERE k=?", (n_key,)).fetchone()
        acc = cur.execute("SELECT v FROM ai_weights WHERE k=?", (acc_key,)).fetchone()
        got = cur.execute(
            "SELECT COUNT(*) c FROM ai_weights WHERE k>=? AND k<?", (w0, w1)
        ).fetchone()
        ns = float(n["v"]) if n else 0
        trained = bool(got and got["c"] >= 11 and ns >= 400)
        a = float(acc["v"]) if acc and trained else None
        return trained, a
    except sqlite3.Error:
        return False, None


def _why_parts(raw) -> list:
    """Разбор причин: «имя:вклад» через запятую."""
    out = []
    for part in str(raw or "").split(","):
        name, _, val = part.rpartition(":")
        if not name:
            continue
        try:
            bp = int(val)
        except ValueError:
            continue
        out.append({"k": name, "v": round(bp / 100.0, 2)})
    return out


def _signals(cur: sqlite3.Connection) -> list:
    """Сигналы, посчитанные ботом.

    Раньше их считал этот файл: уверенность выходила как «50 + модуль потока
    × 8», причины были вшитым списком правил, а обученная модель жила в боте
    и до приложения не доходила вовсе — на экране стояло 99%, которых никто
    не считал. Повторять здесь тридцать пять признаков и лес деревьев нельзя:
    две реализации разойдутся, и заметить это будет не по чему. Поэтому счёт
    один, в oracle.cpp, а здесь выдача.

    План берётся из журнала, а не из ai_signals. В ai_signals он каждые пять
    минут пересчитывается от свежей цены: вход там равен цене прямо сейчас,
    и стоп с целями переезжают вместе с ней. Человек, открывший карточку в
    десять, и он же в десять ноль пять видели разные сделки, а исход потом
    считался по уровням журнала — по тем, которых он мог и не видеть.
    Поэтому уровни, горизонт, плечо и доля депозита приходят из открытой
    строки журнала: сигнал показывается таким, каким вышел.

    Живого в нём двое: возраст — от той же строки журнала, по ней и видно,
    сколько сигнал висит, — и доход с момента выдачи. Доход считается как
    раз из расхождения двух входов: журнального, записанного один раз, и
    текущего из ai_signals, который и есть сегодняшняя цена. Второго
    источника цен для этого не нужно, и разойтись им негде.
    """
    if not table_exists(cur, "ai_signals"):
        return []
    # Столбцы появились позже: у базы, которую ещё не трогал новый бот, их нет.
    cset = cols(cur, "ai_signals")
    share = "s.risk_share" if "risk_share" in cset else "0"
    hz = "s.horizon" if "horizon" in cset else "86400"
    # Журнал мог и не успеть обрасти столбцами плана: тогда берём из ai_signals.
    lset = cols(cur, "ai_signal_log") if table_exists(cur, "ai_signal_log") else set()
    def logged(name: str, fallback: str) -> str:
        """Поле из журнала, если оно там есть; иначе — из свежей публикации."""
        return f"COALESCE(g.{name}, {fallback})" if name in lset else fallback

    # COALESCE тут не спасает: столбцы добавлены с NOT NULL DEFAULT, и у
    # строки, заведённой до миграции, лежит не NULL, а ноль и единица. Пустое
    # значение от настоящего отличает доля депозита: любой построенный план
    # ставит её больше нуля, обоими путями. Ноль в ней — признак того, что
    # строка старше миграции, и тогда план добираем из свежей публикации.
    fresh = "g.risk_share > 0" if "risk_share" in lset else "0"
    def logged_plan(name: str, fallback: str) -> str:
        return (f"CASE WHEN {fresh} THEN g.{name} ELSE {fallback} END"
                if name in lset else fallback)
    join = ("LEFT JOIN ai_signal_log g ON g.venue=s.venue AND g.token=s.token "
            "AND g.side=s.side AND g.closed_at=0 ") if lset else ""
    at = "COALESCE(g.made_at, s.made_at)" if lset else "s.made_at"
    # Доводы пустой строкой — это «в журнале их нет», а не «доводов нет».
    why_col = "COALESCE(NULLIF(g.why, ''), s.why)" if "why" in lset else "s.why"
    sql = (
        f"SELECT s.venue venue, s.sym sym, s.side side, s.net_nanos net_nanos, "
        f"s.wallets wallets, s.token token, s.entry live_px, "
        f"{at} at, {logged('conf', 's.conf')} conf, "
        f"{logged('modelled', 's.modelled')} modelled, "
        f"{logged('entry', 's.entry')} entry, {logged('stop', 's.stop')} stop, "
        f"{logged('take1', 's.take1')} take1, {logged('take2', 's.take2')} take2, "
        f"{logged('horizon', hz)} horizon, {logged_plan('risk_share', share)} share, "
        f"{logged_plan('lev', 's.lev')} lev, {why_col} why "
        f"FROM ai_signals s {join}"
        # Сверху свежие. Прежде список шёл по уверенности, и рядом с сигналом
        # четвертьчасовой давности стоял вчерашний — по числу они соседи, а
        # по делу разные вещи: у одного план ещё в силе, у другого прошло
        # полгоризонта. Возраст и есть первое, что о сигнале нужно знать.
        # Уверенность осталась вторым ключом — для выданных в одну секунду.
        "ORDER BY at DESC, conf DESC"
    )
    try:
        rows = cur.execute(sql).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] сигналы: {e}\n")
        return []
    out = []
    for r in rows:
        entry = float(r["entry"] or 0)
        if entry <= 0:
            continue
        live_px = float(r["live_px"] or 0)
        long_ = bool(int(r["side"] or 0))
        # Доход с момента выдачи, в сторону сигнала: у шорта падение — плюс.
        roi = 0.0
        if live_px > 0:
            roi = (live_px - entry) / entry * 100.0
            if not long_:
                roi = -roi
        stop = float(r["stop"] or 0)
        # Расстояние до стопа считается по показанной паре, а не берётся из
        # свежей публикации: там оно от другого входа.
        stop_pct = abs(stop - entry) / entry * 100.0 if stop > 0 else 0.0
        out.append({
            "sym": str(r["sym"] or "").upper(),
            "side": "buy" if int(r["side"] or 0) else "sell",
            "conf": int(r["conf"] or 0),
            # Считала модель или осталась формула — на экране это разные слова.
            "model": bool(int(r["modelled"] or 0)),
            "net": usd(r["net_nanos"]),
            "w": int(r["wallets"] or 0),
            "entry": entry,
            "stop": stop,
            "stopPct": round(stop_pct, 2),
            "t1": float(r["take1"] or 0),
            "t2": float(r["take2"] or 0),
            "lev": int(r["lev"] or 1),
            # Когда сигнал появился и как он с тех пор идёт. Возраст — из
            # журнала: в самой публикации время всегда «только что», её
            # переписывают каждые пять минут.
            "at": int(r["at"] or 0),
            "roi": round(roi, 2),
            # Цена прямо сейчас — от неё и считается доход. Отдаём, чтобы на
            # карточке было видно, откуда он взялся.
            "now": live_px,
            # Доля депозита под риском и горизонт — решения модели, а не
            # настройки приложения.
            "share": round(float(r["share"] or 0), 2),
            "h": int(r["horizon"] or 86400),
            # «flow:412» — имя признака и его вклад в сотых долях процента
            # вероятности. Отдаём процентными пунктами: приложению нужна
            # длина полосы, а не сырые базисные пункты.
            "why": _why_parts(r["why"]),
            "venue": "perp" if int(r["venue"] or 0) else "spot",
            # Адрес контракта у спотового сигнала: без него не достать
            # историю цены токена — тикеры не уникальны, искать по ним
            # нельзя. У перпов здесь имя монеты, и оно не адрес.
            "addr": str(r["token"] or ""),
        })
    return out


def _oracle_try(cur: sqlite3.Connection, perp: bool, horizon: int | None = None) -> dict | None:
    """Последняя попытка обучения, принятая или нет.

    «Модель ещё не обучена» при 2468 готовых исходах не объясняет ничего:
    непонятно, ждать ли данных или модель раз за разом не проходит порог.

    Горизонт: у площадки их два, и строка в таблице своя у каждого. Без
    фильтра сюда попадала та, у которой AUC выше, а вторая не показывалась
    вовсе — в том числе провалившаяся рядом с принятой.
    """
    if not table_exists(cur, "ai_model_try"):
        return None
    where = "venue=?" + (" AND horizon=?" if horizon else "")
    args = (1 if perp else 0,) + ((horizon,) if horizon else ())
    try:
        tset = cols(cur, "ai_model_try")
        wmin = "wf_min" if "wf_min" in tset else "0"
        wfol = "wf_folds" if "wf_folds" in tset else "0"
        wpas = "passes" if "passes" in tset else "0"
        wece = "ece" if "ece" in tset else "0"
        wflo = "ece_floor" if "ece_floor" in tset else "0"
        row = cur.execute(
            "SELECT at,samples,auc,logloss,base_logloss,wf_auc,accepted,horizon,"
            f"{wmin} wf_min,{wfol} wf_folds,{wpas} passes,{wece} ece,{wflo} ece_floor "
            f"FROM ai_model_try WHERE {where} ORDER BY auc DESC LIMIT 1",
            args,
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    return {
        "h": int(row["horizon"] or ORACLE_H24),
        "at": int(row["at"] or 0),
        "samples": int(row["samples"] or 0),
        "auc": round(float(row["auc"] or 0), 3),
        "logloss": round(float(row["logloss"] or 0), 3),
        "base": round(float(row["base_logloss"] or 0), 3),
        "wf": round(float(row["wf_auc"] or 0), 3),
        # Худшая складка и их число: по ним видно, что среднее не вытащила
        # одна удачная. Приёмка смотрит именно сюда.
        "wfMin": round(float(row["wf_min"] or 0), 3),
        "folds": int(row["wf_folds"] or 0),
        # Сколько раз подряд проверка сошлась. Одного раза мало: бот пробует
        # обучиться каждый день, и рано или поздно порог берётся случайно.
        # В бой модель идёт, подтвердившись на новых данных.
        "passes": int(row["passes"] or 0),
        # Насколько обещанное разошлось со сбывшимся и сколько дала бы сама
        # случайность. Голое первое число ни о чём не говорит: на полутора
        # сотнях строк и идеальная модель даст заметную величину.
        "ece": round(float(row["ece"] or 0), 3),
        "eceFloor": round(float(row["ece_floor"] or 0), 3),
        "ok": bool(int(row["accepted"] or 0)),
    }


def _oracle_model(cur: sqlite3.Connection, perp: bool, horizon: int | None = None) -> dict | None:
    """Состояние обученного оракула: то, что бот записал в ai_models.

    Точность сама по себе ничего не говорит — при шестидесяти процентах роста
    в выборке «всегда вверх» даёт те же шестьдесят. Поэтому рядом всегда идут
    AUC, потери и потери постоянного прогноза: по ним видно, есть ли в модели
    хоть что-то сверх угадывания частоты.
    """
    if not table_exists(cur, "ai_models"):
        return None
    # Столбец levels появился позже: у базы, которую ещё не трогал новый бот,
    # его нет, и запрос в лоб уронил бы весь экран состояния.
    mset = cols(cur, "ai_models")
    lvl = "levels" if "levels" in mset else "0"
    wmin = "wf_min" if "wf_min" in mset else "0"
    wfol = "wf_folds" if "wf_folds" in mset else "0"
    mece = "ece" if "ece" in mset else "0"
    mflo = "ece_floor" if "ece_floor" in mset else "0"
    where = "venue=?" + (" AND horizon=?" if horizon else "")
    args = (1 if perp else 0,) + ((horizon,) if horizon else ())
    try:
        row = cur.execute(
            "SELECT created_at,samples,test_n,trees,auc,logloss,acc,brier,"
            f"base_logloss,base_rate,wf_auc,gain,{lvl} levels,horizon,"
            f"{wmin} wf_min,{wfol} wf_folds,{mece} ece,{mflo} ece_floor FROM ai_models "
            f"WHERE {where} ORDER BY auc DESC LIMIT 1",
            args,
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row or not row["trees"]:
        return None
    top = []
    raw = row["gain"]
    if isinstance(raw, (bytes, bytearray)) and len(raw) == 8 * len(ORACLE_FEATURES):
        vals = struct.unpack(f"<{len(ORACLE_FEATURES)}d", raw)
        total = sum(vals) or 1.0
        pairs = sorted(zip(ORACLE_FEATURES, vals), key=lambda x: -x[1])[:5]
        top = [{"k": n, "v": round(100.0 * v / total, 1)} for n, v in pairs if v > 0]
    return {
        "at": int(row["created_at"] or 0),
        "samples": int(row["samples"] or 0),
        "test": int(row["test_n"] or 0),
        "trees": int(row["trees"] or 0),
        "auc": round(float(row["auc"] or 0), 3),
        "logloss": round(float(row["logloss"] or 0), 3),
        "base": round(float(row["base_logloss"] or 0), 3),
        "acc": round(100.0 * float(row["acc"] or 0)),
        "brier": round(float(row["brier"] or 0), 3),
        "wf": round(float(row["wf_auc"] or 0), 3),
        "wfMin": round(float(row["wf_min"] or 0), 3),
        "ece": round(float(row["ece"] or 0), 3),
        "eceFloor": round(float(row["ece_floor"] or 0), 3),
        "folds": int(row["wf_folds"] or 0),
        "up": round(100.0 * float(row["base_rate"] or 0)),
        # Уровни от модели или по формуле от волатильности — на экране это
        # разные вещи, и человек вправе знать, что именно он видит.
        "levels": bool(int(row["levels"] or 0)),
        "h": int(row["horizon"] or 86400),
        "top": top,
    }


def _oracle_rows(cur: sqlite3.Connection, perp: bool) -> list:
    """Площадка по горизонтам: у каждого своя модель, своя попытка, свой счёт.

    Экран состояния показывал одну карточку на площадку — ту, у которой AUC
    выше. Вторая модель не показывалась вообще: принятая шестичасовая
    закрывала собой проваленную суточную, и человек читал «модель принята»,
    не зная, что половина сигналов всё равно идёт от формулы.
    """
    has_events = table_exists(cur, "ai_events")
    return [{
        "h": h,
        "ready": _count_ready(cur, perp, h) if has_events else 0,
        "model": _oracle_model(cur, perp, h),
        "try": _oracle_try(cur, perp, h),
    } for h in ORACLE_HZ]


def _signals_at(cur: sqlite3.Connection) -> int | None:
    """Когда бот в последний раз считал сигналы.

    Не «когда выдал»: пустая таблица не отличает «бот ни разу не считал» от
    «посчитал и ничего не прошло отбор», а на экране это совсем разные вещи.
    Поэтому у бота есть отдельная отметка расчёта, и она тут главнее: сами
    сигналы могли и не появиться.
    """
    at = None
    if table_exists(cur, "ai_signals"):
        try:
            row = cur.execute("SELECT MAX(made_at) m FROM ai_signals").fetchone()
            at = int(row["m"]) if row and row["m"] else None
        except sqlite3.Error:
            at = None
    if at:
        return at
    if not table_exists(cur, "ai_weights"):
        return None
    try:
        row = cur.execute("SELECT v FROM ai_weights WHERE k=900").fetchone()
    except sqlite3.Error:
        return None
    return int(row["v"]) if row and row["v"] else None


def _reliability(cur: sqlite3.Connection, venue: int) -> list:
    """Совпадает ли обещанное со сбывшимся, по корзинам уверенности.

    Модель говорит человеку число: «61% шанс роста». Общая доля попаданий
    этого не проверяет — она складывает шестидесятипроцентные сигналы с
    восьмидесятипроцентными и говорит одно среднее. А проверять надо иначе:
    когда он сказал шестьдесят, сбылось ли шестьдесят.

    Считается только по решённым сигналам — дошедшим до цели или до стопа.
    Тот, что за горизонт не дошёл никуда, не был ни угадан, ни нет, и в
    знаменателе ему делать нечего.

    Число в корзине отдаётся рядом: на пяти сигналах «сбылось 80%» не значит
    ничего, и человек должен это видеть.
    """
    if not table_exists(cur, "ai_signal_log"):
        return []
    edges = [(50, 60), (60, 70), (70, 80), (80, 101)]
    out = []
    try:
        # Только сигналы модели. У формулы «уверенность» — это оценка,
        # втиснутая в проценты (40 + счёт×5, зажато в 35…80), а не
        # вероятность: сверять её со сбывшимся значит ловить формулу на
        # числе, которое никогда не было обещанием. Блок и поймал её сразу —
        # «обещал 57%, сбылось 31%», — только судил не того.
        mset = cols(cur, "ai_signal_log")
        only_model = " AND modelled=1" if "modelled" in mset else " AND 0"
        rows = cur.execute(
            "SELECT conf, outcome FROM ai_signal_log "
            f"WHERE closed_at>0 AND venue=? AND outcome!=0{only_model}", (venue,)
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] сверка обещанного: {e}\n")
        return []
    for lo, hi in edges:
        got = [r for r in rows if lo <= int(r["conf"] or 0) < hi]
        if not got:
            continue
        won = sum(1 for r in got if int(r["outcome"] or 0) > 0)
        out.append({
            "from": lo,
            "to": min(hi, 100),
            # Обещано — среднее по корзине, а не её середина: в корзине
            # 60–70 сигналы могут лежать все у нижнего края.
            "said": round(sum(int(r["conf"] or 0) for r in got) / len(got)),
            "got": int(round(100.0 * won / len(got))),
            "n": len(got),
        })
    return out


def _signal_history(cur: sqlite3.Connection, perp: bool) -> dict:
    """История выданных сигналов одной площадки: что показали и чем кончилось.

    Раньше здесь считались строки журнала обучения — монеты, которые сигналами
    никогда не были, — а «угадано» означало «поток угадал направление». На
    экране это стояло рядом с подписями «планов закрыто», «по цели», «по
    стопу», которых в тех данных не было вовсе. Теперь считается только то,
    что человеку показали: дошла цена до цели, свалилась на стоп или не
    случилось ни того ни другого за горизонт.

    Площадки считаются врозь. Токены BSC и перпы Hyperliquid — разные рынки с
    разной ликвидностью и разными стопами, и общая доля попаданий по ним не
    значит ничего: одна площадка тянет вторую, а какая именно — не видно.
    Модели у них тоже свои, и судить каждую надо по её же сигналам.
    """
    venue = 1 if perp else 0
    empty = {"hit": 0, "of": 0, "won": 0, "tp": 0, "sl": 0, "missed": 0,
             "broken": 0, "avg": 0, "items": [], "open": 0, "next": 0, "rel": []}
    if not table_exists(cur, "ai_signal_log"):
        return empty
    try:
        rows = cur.execute(
            "SELECT sym,venue,side,conf,made_at,closed_at,outcome,ret_bp,entry,exit_px,"
            + ("modelled " if "modelled" in cols(cur, "ai_signal_log") else "0 modelled ") +
            "FROM ai_signal_log WHERE closed_at>0 AND venue=? "
            "ORDER BY closed_at DESC LIMIT 40", (venue,)
        ).fetchall()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] история сигналов: {e}\n")
        return empty
    items = []
    for r in rows:
        out = int(r["outcome"] or 0)
        ret = float(r["ret_bp"] or 0) / 100.0
        items.append({
            "sym": str(r["sym"] or "?").upper(),
            "long": bool(int(r["side"] or 0)),
            # Доход считается в сторону сигнала: у шорта падение цены — плюс.
            "ret": round(ret, 1),
            "t": ago(int(r["closed_at"] or 0)),
            "win": out > 0,
            "outcome": out,
            "venue": "perp" if int(r["venue"] or 0) else "spot",
            "model": bool(int(r["modelled"] or 0)),
        })
    # Список — последние сорок, итоги — по всему журналу.
    #
    # Раньше и то и другое считалось по одной выборке с LIMIT 40: «угадано
    # 58%», «11 из 19», «планов 26» были про последние сорок сигналов, а
    # подписаны как весь послужной список. Сорок строк — это про длину
    # списка на экране, и к доле попаданий отношения не имеет.
    of = tp = sl = 0
    avg = 0.0
    try:
        agg = cur.execute(
            "SELECT COUNT(*) n, "
            "SUM(CASE WHEN outcome>0 THEN 1 ELSE 0 END) tp, "
            "SUM(CASE WHEN outcome<0 THEN 1 ELSE 0 END) sl, "
            "AVG(ret_bp) avg FROM ai_signal_log WHERE closed_at>0 AND venue=?",
            (venue,)
        ).fetchone()
        if agg:
            of = int(agg["n"] or 0)
            tp = int(agg["tp"] or 0)
            sl = int(agg["sl"] or 0)
            avg = float(agg["avg"] or 0) / 100.0
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] итоги истории: {e}\n")
    decided = tp + sl
    # Итоги модели и формулы врозь. Оракул судят по его сигналам: формула с
    # нулевым преимуществом, сложенная с ним в одну строку, топила бы его
    # долю, а он — поднимал бы её. Ни то, ни другое не про оракул.
    by_src = {}
    try:
        mset = cols(cur, "ai_signal_log")
        if "modelled" in mset:
            for r in cur.execute(
                "SELECT modelled m, COUNT(*) n, "
                "SUM(CASE WHEN outcome>0 THEN 1 ELSE 0 END) tp, "
                "SUM(CASE WHEN outcome<0 THEN 1 ELSE 0 END) sl, "
                "AVG(ret_bp) avg FROM ai_signal_log "
                "WHERE closed_at>0 AND venue=? GROUP BY modelled", (venue,)
            ).fetchall():
                k = "model" if int(r["m"] or 0) else "formula"
                t_, s_ = int(r["tp"] or 0), int(r["sl"] or 0)
                by_src[k] = {
                    "of": int(r["n"] or 0), "tp": t_, "sl": s_,
                    "hit": int(round(100.0 * t_ / (t_ + s_))) if t_ + s_ else 0,
                    "avg": round(float(r["avg"] or 0) / 100.0, 1),
                }
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] история по источнику: {e}\n")
    # Сколько сигналов ещё в работе и через сколько закроется ближайший.
    # «Завершённых сигналов пока нет» само по себе не отличает «бот только что
    # перезапустился» от «что-то сломалось»: первый итог приходит не раньше,
    # чем пройдёт горизонт самого раннего сигнала.
    opened, soon = 0, 0
    try:
        row = cur.execute(
            "SELECT COUNT(*) n, MIN(made_at+horizon) t FROM ai_signal_log "
            "WHERE closed_at=0 AND venue=?", (venue,)
        ).fetchone()
        opened = int(row["n"] or 0)
        soon = max(0, int(row["t"] or 0) - int(time.time())) if row["t"] else 0
    except sqlite3.Error:
        pass
    return {
        "open": opened,
        "next": soon,
        # Доля попаданий считается только среди решённых: сигнал, который за
        # сутки не дошёл ни до цели, ни до стопа, не был ни угадан, ни нет.
        "hit": int(round(100.0 * tp / decided)) if decided else 0,
        "of": of,
        "won": tp,
        "tp": tp,
        "sl": sl,
        "missed": of - decided,
        "broken": sl,
        "avg": round(avg, 1),
        "items": items,
        "rel": _reliability(cur, venue),
        # Итоги модели и формулы врозь; нет ключа — таких сигналов не было.
        "model": by_src.get("model"),
        "formula": by_src.get("formula"),
    }


def load_sonar(cur: sqlite3.Connection, hl: sqlite3.Connection | None = None) -> dict:
    sonar = {
        # Сколько готовых исходов нужно, чтобы модель могла быть принята —
        # то же число, что ORACLE_MIN_ACCEPT в oracle.h.
        #
        # Обучение начинается с 400, скользящая проверка считается с 600, но
        # принимать модель по такой выборке нельзя: тестовый кусок это 15% от
        # неё, на шестистах примерах в нём восемьдесят строк, и погрешность
        # AUC там ±0.13. Измеренное на восьмидесяти число 0.55 неотличимо ни
        # от 0.42, ни от 0.68. При 1200 складки скользящей проверки получают
        # по полтораста строк каждая — уже не горстка.
        "need": 1200,
        # Столько раз подряд проверка должна сойтись — ORACLE_CONFIRMS у бота.
        # Одна удачная попытка ничего не значит: бот пробует каждый день.
        "confirms": 2,
        "ready": {"spot": 0, "perp": 0},
        "trained": False,
        "trainedSpot": False,
        "trainedPerp": False,
        "acc": None,
        "accSpot": None,
        "accPerp": None,
        "at": None,
        "list": [],
        "hist": {v: {"hit": 0, "of": 0, "won": 0, "tp": 0, "sl": 0, "missed": 0, "broken": 0, "avg": 0, "items": [], "rel": []} for v in ("spot", "perp")},
    }
    # Разбор по горизонтам — для экрана состояния: там у каждой модели своя
    # карточка. Сводные поля ниже остаются для вкладки, где строка одна.
    sonar["hz"] = {"spot": _oracle_rows(cur, False), "perp": _oracle_rows(cur, True)}
    for v in ("spot", "perp"):
        sonar["ready"][v] = max((r["ready"] for r in sonar["hz"][v]), default=0)
    ts, accs = _ai_trained(cur, False)
    tp, accp = _ai_trained(cur, True)
    # Оракул старше линейной модели: если он обучен, на экране его числа.
    os_, op = _oracle_model(cur, False), _oracle_model(cur, True)
    sonar["try"] = {"spot": _oracle_try(cur, False), "perp": _oracle_try(cur, True)}
    sonar["model"] = {"spot": os_, "perp": op}
    sonar["trainedSpot"] = bool(os_) or ts
    sonar["trainedPerp"] = bool(op) or tp
    sonar["trained"] = sonar["trainedSpot"]
    sonar["accSpot"] = os_["acc"] if os_ else (round(accs * 100) if accs else None)
    sonar["accPerp"] = op["acc"] if op else (round(accp * 100) if accp else None)
    sonar["acc"] = sonar["accSpot"]

    sonar["list"] = _signals(cur)
    # Когда бот в последний раз считал сигналы. Пусто — значит не считал ни
    # разу: пустой список тогда означает не «нечего показать», а «нечему
    # взяться», и на экране это разные слова.
    sonar["at"] = _signals_at(cur)

    sonar["hist"] = {"spot": _signal_history(cur, False),
                     "perp": _signal_history(cur, True)}
    return sonar


def load_coins(cur: sqlite3.Connection, hl: sqlite3.Connection | None, flow: dict, wallets: list) -> dict:
    coins = {}
    flow24 = {(r.get("sym") or ""): r for r in ((flow.get("24") or {}).get("rows") or []) if r.get("sym")}
    rows = []
    for k in ("24", "6", "1", "168", "720"):
        rows.extend((flow.get(k) or {}).get("rows") or [])
    who_by: dict[str, list] = {}
    extra_sym = []
    entry_w: dict[str, list[tuple[float, float]]] = {}
    for w in wallets or []:
        for p in w.get("pos") or []:
            sym = p.get("sym") or ""
            if not sym:
                continue
            who_by.setdefault(sym, []).append({"w": w.get("name") or "", "v": p.get("size") or 0, "t": "сейчас"})
            extra_sym.append({"sym": sym, "net": 0, "buy": 0, "sell": 0, "w": 0, "token": "", "c24": 0, "sp": []})
            try:
                ent = float(p.get("entry") or 0)
                sz = abs(float(p.get("size") or 0))
            except (TypeError, ValueError):
                continue
            if ent > 0 and sz > 0:
                entry_w.setdefault(sym, []).append((ent, sz))
    seen = set()
    need_http: list[str] = []
    ordered = rows + extra_sym
    for r in ordered:
        sym = r.get("sym") or ""
        if not sym or sym in seen:
            continue
        seen.add(sym)
        r24 = flow24.get(sym) or r
        pack = price_pack(cur, hl, sym, r24.get("token") or r.get("token") or r.get("addr") or "", http=True)
        if not pack.get("hists") or not _px_ok(sym, pack.get("price") or 0):
            need_http.append(sym)
        # Последним звеном стоял генератор выдуманной линии от знака потока.
        # Его больше нет: нет точек — нет графика, экран скажет об этом
        # словами. Рисовать зигзаг, похожий на данные, хуже, чем не рисовать.
        hist24 = (pack.get("hists") or {}).get("24h") or pack.get("spark") or r.get("sp") or []
        ww = int(r24.get("w") or r.get("w") or 0)
        wsum = 0.0
        wtot = 0.0
        for ent, sz in entry_w.get(sym) or []:
            wsum += ent * sz
            wtot += sz
        entry = (wsum / wtot) if wtot else 0.0
        coins[sym] = {
            "price": pack.get("price") or 0,
            "chg": pack.get("chg") if pack else (r24.get("c24") or 0),
            "entry": entry,
            "hist": hist24,
            "hists": pack.get("hists") or {},
            "real": bool(pack.get("real")),
            "addr": pack.get("addr") or r.get("addr") or "",
            "icon": pack.get("icon") or coin_icon(sym, pack.get("addr") or r.get("addr") or ""),
            "spark": pack.get("spark") or hist24,
            # `or 0` тут превращало «неизвестно» в «ноль процентов»: любое
            # ложное значение, включая None, становилось уверенным нулём.
            # Неизвестное обязано доехать неизвестным.
            "c1": pack.get("c1"),
            "c6": pack.get("c6"),
            "c24": (pack.get("c24") if pack.get("c24") is not None
                    else pack.get("chg") if pack.get("chg") is not None
                    else (r24.get("c24") or 0)),
            "net": r24.get("net") or 0,
            "buy": r24.get("buy") or 0,
            "sell": r24.get("sell") or 0,
            "w": ww,
            "mcap": "—",
            "liq": "—",
            "who": who_by.get(sym, []),
            "cons": {"top": min(24, ww), "of": max(ww, 24), "first": "—", "also": []},
        }
    if need_http:
        lock = threading.Lock()

        def pull(sym: str):
            pts = hist_perp(sym)
            if len(pts) < 3:
                return
            sl = _sparkify(_slices(pts), sym)
            if not sl:
                return
            with lock:
                c = coins.get(sym)
                if not c:
                    return
                if _px_ok(sym, sl.get("price") or 0):
                    c["price"] = sl["price"]
                c["chg"] = sl["chg"]
                c["hist"] = (sl.get("hists") or {}).get("24h") or sl.get("spark") or c["hist"]
                c["hists"] = sl.get("hists") or {}
                c["spark"] = sl.get("spark") or c.get("spark")
                for fld in ("c1", "c6", "c24"):
                    v = sl.get(fld)
                    c[fld] = v if v is not None else c.get(fld)
                c["real"] = True
                c["icon"] = c.get("icon") or coin_icon(sym)

        th = []
        for sym in need_http[:24]:
            t = threading.Thread(target=pull, args=(sym,), daemon=True)
            t.start()
            th.append(t)
        for t in th:
            t.join(timeout=6.0)
    mids = hl_mids()
    for sym, c in coins.items():
        mid = mids.get(sym.upper())
        if mid and (not _px_ok(sym, c.get("price") or 0)):
            c["price"] = mid
        elif mid and not c.get("price"):
            c["price"] = mid
    return coins


def build_public(cur: sqlite3.Connection, hl: sqlite3.Connection | None) -> dict:
    t0 = time.monotonic()
    ls: dict = {}
    rot = empty_rot()
    flow, rank, trades, market_feed, funding, sonar = {}, {}, {"spot": [], "perp": []}, [], {}, {
        "need": 1200, "confirms": 2, "ready": {"spot": 0, "perp": 0}, "trained": False, "acc": None,
        "hz": {"spot": [], "perp": []},
        "list": [], "hist": {v: {"hit": 0, "of": 0, "won": 0, "tp": 0, "sl": 0, "missed": 0, "broken": 0, "avg": 0, "items": [], "rel": []} for v in ("spot", "perp")},
    }

    def take(name, fn, fallback, must=False):
        if not must and time.monotonic() - t0 > BUILD_BUDGET:
            sys.stderr.write(f"[api] cache skip {name} (бюджет {BUILD_BUDGET:.0f}с исчерпан)\n")
            return fallback
        started = time.monotonic()
        try:
            return fn()
        except Exception as e:
            sys.stderr.write(f"[api] cache {name}: {e}\n")
            return fallback
        finally:
            sys.stderr.write(f"[api] cache {name}: {time.monotonic() - started:.1f}с\n")

    rank = take("rank", lambda: load_rank(cur, hl), rank, True)
    flow = take("flow", lambda: load_flow(cur), flow, True)
    sonar = take("sonar", lambda: load_sonar(cur, hl), sonar, True)
    trades = take("trades", lambda: load_trades(cur, hl), trades, True)
    market_feed = take("feed", lambda: load_feed_market(cur, hl), market_feed, True)
    funding = take("funding", lambda: load_funding(hl), funding)
    # Ротацию считает свой поток (rot_refresher) — здесь только готовое.
    rot = rot_latest()
    ls = take("ls", lambda: load_ls(hl), {})
    coins = take("coins", lambda: load_coins(cur, hl, flow, []), {})
    return {
        "flow": flow,
        "ls": ls,
        "rank": rank,
        "trades": trades,
        "marketFeed": market_feed,
        # Ключ funding сменился на fund: под прежним лежал один список с
        # Hyperliquid, а теперь это доски по биржам. Старая сборка, открытая в
        # этот момент, увидит пустой фандинг, а не строки не с той биржи.
        "fund": funding,
        # Сколько перекосов на каждой бирже всего: в выгрузке лежит первая
        # страница, и без этих чисел приложению не из чего считать страницы.
        "fundN": fund_counts(),
        # Ключ rot больше не отдаётся: там лежал список пар, которого в
        # приложении нет. Старая сборка, открытая в этот момент, увидит на
        # месте ротации «данных нет» и исправится сама при следующем запуске.
        "rotSum": rot or {},
        # Sonar переименован в Cortex. Ключ отдаётся под обоими именами:
        # приложение обновляется само, а API на машине перезапускают
        # руками — сборка, открытая между этими двумя событиями, должна
        # читать хоть что-то. Старое имя убрать, когда обновятся все.
        "cortex": sonar,
        "sonar": sonar,
        "coins": coins,
        "cachedAt": now(),
        "buildSec": round(time.monotonic() - t0, 1),
    }


def get_public(cur: sqlite3.Connection, hl: sqlite3.Connection | None) -> dict:
    global _building
    with _pub_lock:
        data, ts = _pub["data"], _pub["t"]
        building = _building
    if data is not None and (time.monotonic() - ts) < PUB_TTL:
        return data
    if data is not None:
        if not building:
            threading.Thread(target=_bg_refresh, daemon=True).start()
        return data
    started = False
    with _pub_lock:
        if not _building:
            _building = True
            started = True
    if not started:
        t_end = time.monotonic() + 12.0
        while time.monotonic() < t_end:
            time.sleep(0.05)
            with _pub_lock:
                if _pub["data"] is not None:
                    return _pub["data"]
        return {}
    try:
        data = build_public(cur, hl)
        with _pub_lock:
            _pub["data"] = data
            _pub["t"] = time.monotonic()
        return data
    except Exception as e:
        sys.stderr.write(f"[api] build_public: {e}\n")
        return {}
    finally:
        with _pub_lock:
            _building = False


def _bg_refresh() -> None:
    """Перестройка по требованию: кто-то пришёл за данными, а они протухли.

    Обычно до этого не доходит — кэш обновляет refresher по часам. Остаётся
    на случай, когда тот ещё не успел сделать первый круг.
    """
    cur = open_db(DB)
    hl = open_db(HL_DB)
    if not cur:
        return
    try:
        build_public_into_cache(cur, hl)
    finally:
        for c in (cur, hl):
            if c:
                try:
                    c.close()
                except Exception:
                    pass


def warmup() -> None:
    time.sleep(0.3)
    # Карта площадок нужна до первой сборки кэша: без неё акции и индексы
    # уедут в крипту, а значки запросятся по короткому имени — и то и другое
    # продержится до следующего обновления. Одиннадцать запросов к бирже
    # занимают пару секунд и идут в стороне от чьего-либо экрана.
    _hl_markets_load()
    # Ставки бирж — своим потоком: первый круг успевает до первой сборки, а
    # дальше он обновляет их сам и в бюджет сборки не лезет.
    threading.Thread(target=fund_refresher, daemon=True, name="funding").start()
    threading.Thread(target=rot_refresher, daemon=True, name="rotation").start()
    cur = open_db(DB)
    hl = open_db(HL_DB)
    if not cur:
        return
    try:
        get_public(cur, hl)
        sys.stderr.write("[api] public cache ready\n")
        symbols()
        # Календарь разлоков — сразу, чтобы первый открывший экран не ждал.
        unlocks()
    except Exception as e:
        sys.stderr.write(f"[api] warmup: {e}\n")
    finally:
        try:
            cur.close()
        except Exception:
            pass
        if hl:
            try:
                hl.close()
            except Exception:
                pass


# История сделок кошелька и история цены монеты. Обе открываются нажатием на
# карточку, обе одинаковы для всех, кто их открыл, и обе за минуту не
# меняются настолько, чтобы ради этого идти в базу каждому.
_DEALS: dict[tuple[str, str, int], tuple[float, list]] = {}
# Живой кошелёк: срок короче общего, потому что человек смотрит собственный
# счёт и ждёт от него сегодняшних чисел, а не минутной давности.
_WALLET: dict[tuple[str, str], tuple[float, dict]] = {}
WALLET_TTL = 20.0
_TOKEN_HIST: dict[str, tuple[float, list]] = {}
_small_lock = threading.Lock()
SMALL_TTL = 60.0


def cached_small(store: dict, key, ttl: float, build):
    """Значение из словаря-кэша, либо построенное и положенное туда.

    Считается вне замка: под замком держится только словарь. Иначе один
    медленный запрос к базе останавливал бы всех, кто в это время читает
    совсем другие ключи.
    """
    with _small_lock:
        hit = store.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
    val = build()
    with _small_lock:
        store[key] = (time.monotonic(), val)
        cap_cache(store, 2048)
    return val


_COINS: dict[str, tuple[float, dict]] = {}


def _coins_key(wallets: list) -> str:
    mark = [
        [w.get("name") or "",
         sorted((p.get("sym") or "", round(float(p.get("size") or 0)))
                for p in (w.get("pos") or []))]
        for w in (wallets or [])
    ]
    return hashlib.sha1(
        json.dumps(mark, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def coins_known(wallets: list) -> dict | None:
    """Справочник монет из памяти любой давности — без похода в сеть.

    Для быстрой выгрузки: лучше вчерашняя цена монеты на первом экране, чем
    двадцать пять секунд пустоты, пока справочник заново опрашивает биржи.
    """
    with _small_lock:
        hit = _COINS.get(_coins_key(wallets))
    return hit[1] if hit else None


def coins_cached(cur: sqlite3.Connection, hl: sqlite3.Connection | None,
                 flow: dict, wallets: list) -> dict:
    """Справочник монет — общий, но с оглядкой на кошельки смотрящего.

    load_coins дописывает к монетам открытые позиции владельца, поэтому в
    общую выгрузку он целиком не уходит. Зато у двух запусков одного и того
    же человека набор позиций один и тот же, а у большинства он и вовсе
    пустой — и тогда ответ общий на всех. Ключ — отпечаток позиций, так что
    сменилась позиция, сменился и ключ.
    """
    key = _coins_key(wallets)
    return cached_small(_COINS, key, SMALL_TTL,
                        lambda: load_coins(cur, hl, flow, wallets))


# Личная выгрузка целиком: она у каждого своя, но у одного человека за
# двадцать секунд не меняется ничем, кроме его же действий, — а те кэш и
# сбрасывают. Без этого каждое нажатие «обновить» заново собирало профиль,
# кошельки, алерты и справочник монет.
_BOOT: dict[str, tuple[float, dict]] = {}
_boot_lock = threading.Lock()
_boot_busy: set[str] = set()
BOOT_TTL = 30.0


def bootstrap_cached(chat: str) -> dict:
    """Выгрузка из памяти; устаревшая отдаётся сразу, пересборка идёт в фоне.

    Пересобирать прямо в запросе оказалось нельзя. Мерил под нагрузкой:
    сборка упирается в справочник монет, а тот ходит в сеть за ценами, и на
    ответ уходило в среднем 3,6 секунды, в худшем случае 38. Человек, нажавший
    «обновить», всё это время смотрел на пустой экран — притом что данные у
    сервера уже были, просто чуть постарше.

    Ждать приходится ровно один раз: при самом первом запуске, когда в памяти
    нет ничего.
    """
    key = chat or ""
    with _boot_lock:
        hit = _BOOT.get(key)
        if hit:
            if time.monotonic() - hit[0] >= BOOT_TTL and key not in _boot_busy:
                _boot_busy.add(key)
                threading.Thread(target=_boot_rebuild, args=(key,), daemon=True).start()
            return hit[1]
    # В памяти ничего: первый заход после перезапуска службы или после
    # изменения кошельков. Полная сборка ждёт справочник монет, а тот ходит
    # в сеть — на боевом сервере это занимало до двадцати пяти секунд, дольше,
    # чем приложение ждёт ответа, и человек видел старое, пока не нажмёт
    # «обновить». Теперь сразу отдаём быструю, а полную собираем в фоне.
    data = _boot_build(key, fast=True)
    with _boot_lock:
        if key not in _boot_busy:
            _boot_busy.add(key)
            threading.Thread(target=_boot_rebuild, args=(key,), daemon=True).start()
    return data


def _boot_build(key: str, fast: bool = False) -> dict:
    data = bootstrap(key, fast)
    # Неудачную сборку не запоминаем: иначе временный сбой базы залипал бы на
    # экране до конца срока жизни записи. Быструю кладём уже устаревшей:
    # следующий же запрос возьмёт её и попросит полную.
    if data.get("ok"):
        with _boot_lock:
            _BOOT[key] = (time.monotonic() - (BOOT_TTL if fast else 0), data)
            cap_cache(_BOOT, 4096)
    return data


def _boot_rebuild(key: str) -> None:
    try:
        _boot_build(key)
    except Exception as e:
        sys.stderr.write(f"[api] boot rebuild: {e}\n")
    finally:
        with _boot_lock:
            _boot_busy.discard(key)


def boot_drop(chat: str) -> None:
    """Человек что-то изменил — его записи больше не годятся.

    Вместе с выгрузкой уходит и живой кошелёк: после удаления адрес перестал
    быть своим, и ответ по нему из памяти был бы неправдой. Справочник монет
    сбрасывать не нужно — он и так помнится по отпечатку позиций, а тот
    меняется вместе с ними.
    """
    key = chat or ""
    with _boot_lock:
        _BOOT.pop(key, None)
    with _small_lock:
        for k in [k for k in _WALLET if k[0] == key]:
            _WALLET.pop(k, None)


def refresher() -> None:
    """Держит общий кэш тёплым, не дожидаясь запроса.

    Раньше кэш перестраивался только тогда, когда кто-то за ним пришёл и
    обнаружил, что тот протух. Первый после затишья получал прошлые данные, а
    свежие доставались следующему. Теперь перестройка идёт сама по себе, и
    нажавший «обновить» забирает готовое.

    Пауза не меньше срока жизни кэша и не меньше четырёх длительностей
    последней перестройки: на медленной машине сборка не должна идти
    непрерывно, занимая базу собой.
    """
    while True:
        try:
            cur = open_db(DB)
            hl = open_db(HL_DB)
            if not cur:
                time.sleep(PUB_TTL)
                continue
            t0 = time.monotonic()
            try:
                build_public_into_cache(cur, hl)
                # Окна крупных сделок — отдельным кэшем и отдельным запросом
                # к базе, в общую выгрузку они не входят.
                for bwin, bhours in BIG_WINDOWS.items():
                    big_trades(bwin, bhours, force=True)
            finally:
                for c in (cur, hl):
                    if c:
                        try:
                            c.close()
                        except Exception:
                            pass
            took = time.monotonic() - t0
        except Exception as e:
            sys.stderr.write(f"[api] refresher: {e}\n")
            took = 0.0
        time.sleep(max(PUB_TTL, took * 4))


def build_public_into_cache(cur: sqlite3.Connection, hl: sqlite3.Connection | None) -> None:
    """Перестройка общего кэша под флагом занятости — как в _bg_refresh."""
    global _building
    with _pub_lock:
        if _building:
            return
        _building = True
    try:
        data = build_public(cur, hl)
        with _pub_lock:
            _pub["data"] = data
            _pub["t"] = time.monotonic()
    except Exception as e:
        sys.stderr.write(f"[api] refresh: {e}\n")
    finally:
        with _pub_lock:
            _building = False


def bootstrap(chat: str, fast: bool = False) -> dict:
    """Выгрузка человека. `fast` — без похода в сеть за ценами монет: справочник
    берётся из памяти (или общий), а свежий дособирается следом в фоне."""
    cur = open_db(DB)
    hl = open_db(HL_DB)
    if not cur:
        # Абсолютный путь наружу не уходит: /health от него уже избавили.
        return {"ok": False, "live": False, "error": "db_missing"}
    errors: list[str] = []
    t0 = time.monotonic()

    def piece(name: str, fn, fallback, must: bool = False):
        if not must and time.monotonic() - t0 > 18.0:
            errors.append(f"{name}:skip")
            return fallback
        try:
            return fn()
        except Exception as e:
            errors.append(f"{name}:{type(e).__name__}:{e}")
            sys.stderr.write(f"[api] bootstrap {name}: {e}\n")
            return fallback

    try:
        empty_me = {
            "plan": "free", "limit": 1, "threshold": 10000, "lang": "ru",
            "alertsToday": 0, "alerts30d": 0, "premUntil": 0, "updatedKey": "justNow",
            "alertTg": True, "unread": 0,
        }
        empty_rank = {"spot": {"pnl": [], "roi": [], "win": [], "act": []}, "perp": {"pnl": [], "roi": [], "win": [], "act": []}}
        empty_sonar = {
            "need": 1200, "confirms": 2, "ready": {"spot": 0, "perp": 0},
            "trained": False, "trainedSpot": False, "trainedPerp": False,
            "acc": None, "accSpot": None, "accPerp": None,
            "model": {"spot": None, "perp": None},
            "try": {"spot": None, "perp": None}, "at": None,
            "hz": {"spot": [], "perp": []},
            "list": [], "hist": {v: {"hit": 0, "of": 0, "won": 0, "tp": 0, "sl": 0, "missed": 0, "broken": 0, "avg": 0, "items": [], "rel": []} for v in ("spot", "perp")},
        }
        pub = piece("pub", lambda: get_public(cur, hl), {}, True) or {}
        me = piece("me", lambda: load_me(cur, chat) if chat else empty_me, empty_me)
        if isinstance(me, dict):
            me = dict(me)
            me.pop("lang", None)
        wallets = piece("wallets", lambda: load_wallets(cur, chat, hl) if chat else [], [])
        alerts, feed = piece(
            "alerts",
            lambda: load_alerts(cur, chat, wallets) if chat else ([], []),
            ([], []),
        )
        flow = pub.get("flow") or {}
        ls = pub.get("ls") or {}
        rank_raw = pub.get("rank") or empty_rank
        rank = {
            "spot": (rank_raw.get("spot") if isinstance(rank_raw, dict) else None) or empty_rank["spot"],
            "perp": (rank_raw.get("perp") if isinstance(rank_raw, dict) else None) or empty_rank["perp"],
        }
        trades = pub.get("trades") or {"spot": [], "perp": []}
        market_feed = pub.get("marketFeed") or []
        funding = pub.get("fund") or {}
        fund_n = pub.get("fundN") or {}
        rot_sum = pub.get("rotSum") or {}
        sonar = pub.get("sonar") or empty_sonar
        if fast:
            coins = coins_known(wallets) or pub.get("coins") or {}
            # Приложение по этой метке переспросит через пару секунд, а не
            # через три минуты: полная выгрузка к тому времени будет готова.
            errors.append("coins:later")
        else:
            coins = piece("coins", lambda: coins_cached(cur, hl, flow, wallets), pub.get("coins") or {})
        out = {
            "ok": True,
            "live": True,
            "me": me,
            "wallets": wallets,
            "feed": feed,
            "alerts": alerts,
            "flow": flow,
            "ls": ls,
            "rank": rank,
            # Оба имени, как выше.
            "cortex": sonar,
            "sonar": sonar,
            "trades": trades,
            "fund": funding,
            "fundN": fund_n,
            "rotSum": rot_sum,
            "coins": coins,
            "marketFeed": market_feed,
            # Чем и почём торгуем подписку. Цены живут на сервере: менять их
            # пересборкой приложения — значит держать два источника правды, а
            # кнопку «оплатить в USDT» без кошелька показывать нечестно.
            "pay": {
                "stars": PREMIUM_STARS,
                "usdt": PREMIUM_USDT,
                "ton": usdt_ready(cur),
                "days": PREMIUM_DAYS,
            },
        }
        if errors:
            out["partial"] = errors[:8]
        if pub.get("cachedAt"):
            out["cachedAt"] = pub["cachedAt"]
        return out
    except Exception as e:
        sys.stderr.write(f"[api] bootstrap fatal: {e}\n")
        return {"ok": False, "live": False, "error": str(e)}
    finally:
        try:
            cur.close()
        except Exception:
            pass
        if hl:
            try:
                hl.close()
            except Exception:
                pass


def mutate(chat: str, kind: str, body: dict) -> dict:
    if not chat:
        return {"ok": False, "error": "no_user"}
    con = open_db(DB, write=True)
    if not con:
        return {"ok": False, "error": "db_missing"}
    try:
        # Удаление — единственная операция, которой пользователь не нужен:
        # заводить строку, чтобы через три команды её стереть, незачем, а при
        # обрыве между вставкой и удалением остался бы пустой профиль.
        if kind != "forget":
            con.execute("INSERT OR IGNORE INTO users(chat_id, language, threshold_nanos, created_at) VALUES(?,?,?,?)",
                        (chat, "ru", 100000000000, now()))
        if kind == "add":
            addr = (body.get("addr") or "").strip().lower()
            name = (body.get("name") or "").strip()[:64] or short_addr(addr)
            if not ADDR_RE.match(addr):
                return {"ok": False, "error": "bad_addr"}
            # Бан кошелька в боте действует для всех, значит и здесь.
            # Раньше через мини-апп забаненного кита можно было вернуть.
            if wallet_banned(con, addr):
                return {"ok": False, "error": "banned"}
            n = con.execute("SELECT COUNT(*) FROM user_whales WHERE user_id=?", (chat,)).fetchone()[0]
            # Лимит подписки. Раньше он только СООБЩАЛСЯ фронту в load_me,
            # а на запись не проверялся — бесплатный аккаунт добавлял сколько
            # угодно кошельков в обход премиума.
            lim = wallet_limit(con, chat)
            if n >= lim:
                return {"ok": False, "error": "limit", "limit": lim}
            con.execute("INSERT OR IGNORE INTO whale_addresses(address) VALUES(?)", (addr,))
            wid = con.execute("SELECT id FROM whale_addresses WHERE address=?", (addr,)).fetchone()[0]
            exists = con.execute(
                "SELECT 1 FROM user_whales WHERE user_id=? AND whale_id=?", (chat, wid)
            ).fetchone()
            if exists:
                return {"ok": False, "error": "dup"}
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
            name = (body.get("name") or "").strip()[:64]
            row = con.execute("SELECT id FROM whale_addresses WHERE address=?", (addr,)).fetchone()
            if not row or not name:
                return {"ok": False, "error": "missing"}
            con.execute(
                "UPDATE user_whales SET label=? WHERE user_id=? AND whale_id=?",
                (name, chat, row[0]),
            )
        elif kind == "forget":
            # Право на забвение: то же удаление, что по /forgetme в боте.
            # Списки таблиц обязаны совпадать — иначе удалить «всё» можно
            # будет только из одного из двух интерфейсов.
            # trial_granted в списке нет намеренно, ровно как в forgetUser()
            # бота: строка «неделя уже выдавалась» — единственное, что
            # переживает удаление. Иначе данные стирались бы ради нового
            # бесплатного премиума, и так по кругу.
            for sql in (
                "DELETE FROM user_whales WHERE user_id=?",
                "DELETE FROM deliveries WHERE chat_id=?",
                "DELETE FROM premium_payments WHERE chat_id=?",
                "DELETE FROM ton_invoices WHERE chat_id=?",
                "DELETE FROM ai_access WHERE chat_id=?",
                "DELETE FROM users WHERE chat_id=?",
            ):
                try:
                    con.execute(sql, (chat,))
                except sqlite3.Error:
                    # Таблицы может не быть на старой базе — это не повод
                    # оборвать удаление остального.
                    pass
            # Адреса, за которыми больше никто не следит, держать незачем.
            con.execute(
                "DELETE FROM whale_addresses WHERE NOT EXISTS "
                "(SELECT 1 FROM user_whales uw WHERE uw.whale_id = whale_addresses.id)"
            )
        elif kind == "alerts_seen":
            # Открыл историю — счётчик обнуляется. Время — последнего алерта,
            # который человек мог увидеть, а не «сейчас»: иначе алерт, пришедший
            # между выгрузкой и нажатием, считался бы прочитанным, не показавшись.
            ensure_alert_cols(con)
            try:
                upto = int(body.get("upto") or 0) // 1000
            except (TypeError, ValueError):
                upto = 0
            upto = min(upto, now()) if upto > 0 else now()
            con.execute("UPDATE users SET alerts_seen_at=MAX(alerts_seen_at, ?) WHERE chat_id=?", (upto, chat))
        elif kind == "alerts_mode":
            tg = body.get("tg")
            if not isinstance(tg, bool):
                return {"ok": False, "error": "bad_value"}
            ensure_alert_cols(con)
            con.execute("UPDATE users SET alert_tg=? WHERE chat_id=?", (1 if tg else 0, chat))
        elif kind == "lang":
            code = str(body.get("lang") or "").strip().lower()
            if code not in LANG_CODES:
                return {"ok": False, "error": "bad_lang"}
            con.execute("UPDATE users SET language=? WHERE chat_id=?", (code, chat))
        elif kind == "threshold":
            try:
                usd_v = float(body.get("usd") or 0)
            except (TypeError, ValueError):
                return {"ok": False, "error": "bad_value"}
            # NaN и бесконечность проходили сравнение `< 50` и падали уже
            # на int(); заодно ставим верхнюю границу бота ($1B).
            if not math.isfinite(usd_v):
                return {"ok": False, "error": "bad_value"}
            if usd_v < MIN_THRESHOLD_USD:
                return {"ok": False, "error": "min"}
            if usd_v > MAX_THRESHOLD_USD:
                return {"ok": False, "error": "max"}
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
        # Только известные адреса. Раньше стояла звёздочка, и любая страница
        # в интернете могла читать и менять данные из браузера жертвы.
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

    def _json(self, code: int, obj: dict):
        def clean(o):
            if isinstance(o, float):
                if o != o or o in (float("inf"), float("-inf")):
                    return 0.0
                return o
            if isinstance(o, dict):
                return {str(k): clean(v) for k, v in o.items()}
            if isinstance(o, (list, tuple)):
                return [clean(v) for v in o]
            if isinstance(o, (str, int, bool)) or o is None:
                return o
            return str(o)

        try:
            raw = json.dumps(clean(obj), ensure_ascii=False, allow_nan=False).encode()
        except Exception as e:
            raw = json.dumps({"ok": False, "error": f"json:{e}"}).encode()
            code = 500
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _user(self, qs: dict) -> str:
        """Возвращает chat_id только по сошедшейся подписи, иначе пустую
        строку. Прежний хвост `return qs["tg"]` пускал в чужой аккаунт по
        одному номеру в адресе запроса."""
        init = self.headers.get("X-Telegram-Init-Data") or qs.get("init", [""])[0]
        parsed = verify_init_data(init)
        return parsed["id"] if parsed else ""

    def _keyed(self) -> bool:
        if not API_KEY:
            return True
        return hmac.compare_digest(self.headers.get("X-Api-Key") or "", API_KEY)

    def _peer(self) -> str:
        """Адрес для счётчика запросов.

        nginx собирает X-Forwarded-For как `$proxy_add_x_forwarded_for`, то
        есть ДОПИСЫВАЕТ реальный адрес в конец. Первый элемент прислал сам
        клиент — раньше брали именно его, и лимит снимался подстановкой
        заголовка. Верить можно только последнему.
        """
        parts = [p.strip() for p in (self.headers.get("X-Forwarded-For") or "").split(",") if p.strip()]
        return parts[-1] if parts else self.client_address[0]

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
        try:
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            path = u.path.rstrip("/") or "/"
            if path not in ("/health", "/api/health"):
                if not self._keyed():
                    self._json(403, {"ok": False, "error": "forbidden"})
                    return
                if not _limiter.allow(self._peer()):
                    self._json(429, {"ok": False, "error": "rate_limit"})
                    return
            if path in ("/health", "/api/health"):
                # Абсолютные пути к базам отсюда убраны: проверка живости не
                # обязана рассказывать наружу устройство файловой системы.
                self._json(200, {
                    "ok": True,
                    "db": os.path.isfile(DB),
                    "hl": os.path.isfile(HL_DB),
                })
                return
            if path in ("/bootstrap", "/api/bootstrap", "/api/me"):
                init = self.headers.get("X-Telegram-Init-Data") or qs.get("init", [""])[0]
                who = verify_init_data(init)
                chat = who["id"] if who else ""
                # Первое открытие приложения — неделя премиума в подарок.
                # Выгрузка в памяти собрана ещё без неё, поэтому её сбрасываем.
                gift = grant_trial(chat, who.get("lang", "")) if who else False
                if gift:
                    boot_drop(chat)
                boot = bootstrap_cached(chat)
                boot = for_plan(boot, plan_of(boot))
                if gift:
                    boot = {**boot, "gift": {"days": TRIAL_DAYS}}
                self._json(200, boot)
                return
            if path in ("/market", "/api/market"):
                cur = open_db(DB)
                hl = open_db(HL_DB)
                if not cur:
                    self._json(200, {"ok": False, "live": False})
                    return
                try:
                    pub = get_public(cur, hl) or {}
                    rank_raw = pub.get("rank") or {}
                    # Без подписи человек неизвестен — значит, бесплатный.
                    self._json(200, for_plan({
                        "ok": True,
                        "live": True,
                        "flow": pub.get("flow") or {},
                        "ls": pub.get("ls") or {},
                        "rank": {
                            "spot": rank_raw.get("spot") or {"pnl": [], "roi": [], "win": [], "act": []},
                            "perp": rank_raw.get("perp") or {"pnl": [], "roi": [], "win": [], "act": []},
                        },
                        "trades": pub.get("trades") or {"spot": [], "perp": []},
                        "marketFeed": pub.get("marketFeed") or [],
                        "fund": pub.get("fund") or {},
                        "fundN": pub.get("fundN") or {},
                        "rotSum": pub.get("rotSum") or {},
                        "cortex": pub.get("sonar") or {},
                        "sonar": pub.get("sonar") or {},
                        "coins": pub.get("coins") or {},
                    }, False))
                finally:
                    try:
                        cur.close()
                    except Exception:
                        pass
                    if hl:
                        try:
                            hl.close()
                        except Exception:
                            pass
                return
            if path in ("/flow", "/api/flow"):
                win = (qs.get("win", ["24"])[0] or "24").strip()
                if win not in FLOW_WINDOWS:
                    self._json(400, {"ok": False, "error": "bad_win"})
                    return
                q = (qs.get("q", [""])[0] or "")[:32]
                side = (qs.get("side", ["all"])[0] or "all").strip()
                if side not in ("all", "in", "out"):
                    side = "all"
                try:
                    offset = int(qs.get("offset", ["0"])[0])
                except (TypeError, ValueError):
                    offset = 0
                cur = open_db(DB)
                if not cur:
                    self._json(200, {"ok": False, "error": "db"})
                    return
                try:
                    res = flow_search(cur, win, q, offset=offset, side=side)
                    self._json(200, {"ok": True, **res})
                finally:
                    try:
                        cur.close()
                    except Exception:
                        pass
                return
            if path in ("/fund", "/api/fund"):
                ex = (qs.get("ex", [""])[0] or "").strip()
                if ex not in FUND_VENUES:
                    self._json(400, {"ok": False, "error": "bad_venue"})
                    return
                try:
                    offset = int(qs.get("offset", ["0"])[0])
                except (TypeError, ValueError):
                    offset = 0
                try:
                    limit = int(qs.get("limit", [str(FUND_PAGE)])[0])
                except (TypeError, ValueError):
                    limit = FUND_PAGE
                limit = max(1, min(50, limit))
                if not chat_premium(self._user(qs)):
                    self._json(403, {"ok": False, "error": "premium"})
                    return
                # Из готовых досок, а не с биржи: они обновляются своим
                # потоком, и листание страниц не должно ходить наружу.
                rows = _FUND_ALL.get(ex) or []
                off = max(0, offset)
                self._json(200, {"ok": True, "ex": ex, "total": len(rows),
                                 "rows": rows[off:off + limit]})
                return
            if path in ("/rot", "/api/rot"):
                win = (qs.get("win", ["24"])[0] or "24").strip()
                if win not in ROT_WINDOWS:
                    self._json(400, {"ok": False, "error": "bad_win"})
                    return
                try:
                    offset = int(qs.get("offset", ["0"])[0])
                except (TypeError, ValueError):
                    offset = 0
                try:
                    limit = int(qs.get("limit", [str(ROT_COINS)])[0])
                except (TypeError, ValueError):
                    limit = ROT_COINS
                limit = max(1, min(60, limit))
                # Из готовых столбцов, а не из базы: они пересобираются вместе
                # с общим кэшем, и листание страниц не должно его дублировать.
                cols = _ROT_ALL.get(win) or {}
                src = cols.get("src") or []
                dst = cols.get("dst") or []
                self._json(200, {
                    "ok": True,
                    "win": win,
                    "src": rot_page(src, offset, limit),
                    "dst": rot_page(dst, offset, limit),
                    "msrc": len(src),
                    "mdst": len(dst),
                })
                return
            if path in ("/ls", "/api/ls"):
                win = (qs.get("win", ["24"])[0] or "24").strip()
                if win not in FLOW_WINDOWS:
                    self._json(400, {"ok": False, "error": "bad_win"})
                    return
                q = (qs.get("q", [""])[0] or "")[:32]
                side = (qs.get("side", ["all"])[0] or "all").strip()
                if side not in ("all", "in", "out"):
                    side = "all"
                cls = (qs.get("cls", ["crypto"])[0] or "crypto").strip()
                if cls not in ("crypto", "rwa", "all"):
                    cls = "crypto"
                if not chat_premium(self._user(qs)):
                    self._json(403, {"ok": False, "error": "premium"})
                    return
                try:
                    offset = int(qs.get("offset", ["0"])[0])
                except (TypeError, ValueError):
                    offset = 0
                hl = open_db(HL_DB)
                try:
                    self._json(200, {"ok": True,
                                     **ls_search(hl, win, q, offset=offset, side=side, cls=cls)})
                finally:
                    if hl:
                        try:
                            hl.close()
                        except Exception:
                            pass
                return
            if path in ("/deals", "/api/deals"):
                a = (qs.get("addr", [""])[0] or "").strip().lower()
                if not ADDR_RE.match(a):
                    self._json(400, {"ok": False, "error": "bad_addr"})
                    return
                venue = "perp" if qs.get("venue", ["spot"])[0] == "perp" else "spot"
                if venue == "perp" and not chat_premium(self._user(qs)):
                    self._json(403, {"ok": False, "error": "premium"})
                    return
                try:
                    n = int(qs.get("n", ["10"])[0])
                except (TypeError, ValueError):
                    n = 10
                cur = open_db(DB)
                if not cur:
                    self._json(200, {"ok": False, "error": "db"})
                    return
                hl = open_db(HL_DB) if venue == "perp" else None
                try:
                    deals = cached_small(
                        _DEALS, (a, venue, n), SMALL_TTL,
                        lambda: wallet_deals(cur, hl, a, venue, n),
                    )
                    self._json(200, {"ok": True, "addr": a, "venue": venue, "deals": deals})
                finally:
                    for c in (cur, hl):
                        if c:
                            try:
                                c.close()
                            except Exception:
                                pass
                return
            if path in ("/token", "/api/token"):
                cur = open_db(DB)
                if not cur:
                    self._json(200, {"ok": False, "error": "db"})
                    return
                try:
                    a = (qs.get("addr", [""])[0] or "").strip().lower()
                    if not re.fullmatch(r"0x[0-9a-f]{40}", a):
                        self._json(400, {"ok": False, "error": "bad_addr"})
                        return
                    hist = cached_small(_TOKEN_HIST, a, SMALL_TTL,
                                        lambda: token_series(cur, a))
                    self._json(200, {"ok": True, "addr": a, "hist": hist})
                finally:
                    try:
                        cur.close()
                    except Exception:
                        pass
                return
            if path in ("/wallet", "/api/wallet"):
                chat = self._user(qs)
                if not chat:
                    self._json(403, {"ok": False, "error": "forbidden"})
                    return
                cur = open_db(DB)
                if not cur:
                    self._json(200, {"ok": False, "error": "db"})
                    return
                try:
                    w_addr = (qs.get("addr", [""])[0] or "")
                    self._json(200, for_plan(cached_small(
                        _WALLET, (chat, w_addr.strip().lower()), WALLET_TTL,
                        lambda: wallet_live(cur, chat, w_addr),
                    ), is_premium(cur, chat)))
                finally:
                    try:
                        cur.close()
                    except Exception:
                        pass
                return
            if path in ("/unlocks", "/api/unlocks"):
                self._json(200, unlocks())
                return
            if path in ("/symbols", "/api/symbols"):
                rows = symbols()
                self._json(200, {"ok": bool(rows), "items": rows})
                return
            if path in ("/big", "/api/big"):
                win = (qs.get("win", ["24h"])[0] or "24h").lower()
                hours = BIG_WINDOWS.get(win)
                if hours is None:
                    self._json(400, {"ok": False, "error": "bad_window"})
                    return
                self._json(200, for_plan(big_trades(win, hours), chat_premium(self._user(qs))))
                return
            if path in ("/quotes", "/api/quotes"):
                cur = open_db(DB)
                hl = open_db(HL_DB)
                if not cur:
                    self._json(200, {})
                    return
                try:
                    pub = get_public(cur, hl) or {}
                    coins = pub.get("coins") or {}
                    out = {}
                    for sym, c in coins.items():
                        if not isinstance(c, dict):
                            continue
                        out[sym] = {
                            "price": c.get("price") or 0,
                            "chg": c.get("chg") or 0,
                            "c1": c.get("c1") or 0,
                            "c6": c.get("c6") or 0,
                            "c24": c.get("chg") or 0,
                            "hist": c.get("hist") or [],
                            "hists": c.get("hists") or {},
                            "ohlc": c.get("ohlc") or {},
                            "spark": c.get("spark") or c.get("hist") or [],
                            "icon": c.get("icon") or "",
                            "real": True,
                        }
                    self._json(200, out)
                finally:
                    try:
                        cur.close()
                    except Exception:
                        pass
                    if hl:
                        try:
                            hl.close()
                        except Exception:
                            pass
                return
            self._json(404, {"ok": False, "error": "not_found"})
        except Exception as e:
            sys.stderr.write(f"[api] GET fail: {e}\n")
            try:
                self._json(500, {"ok": False, "error": str(e)})
            except Exception:
                pass

    def do_POST(self):
        try:
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            path = u.path.rstrip("/") or "/"
            if not self._keyed():
                self._body()
                self._json(403, {"ok": False, "error": "forbidden"})
                return
            if not _limiter.allow(self._peer()):
                self._body()
                self._json(429, {"ok": False, "error": "rate_limit"})
                return
            chat = self._user(qs)
            # Тело читаем всегда: иначе непрочитанные байты остаются в сокете
            # и портят следующий запрос на том же keep-alive соединении.
            body = self._body()
            if not chat:
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            if path in ("/api/pay/stars", "/api/pay/usdt", "/api/pay/check", "/api/pay/jetton"):
                lang = (body.get("lang") or "en")[:5]
                if path == "/api/pay/stars":
                    res = pay_stars(chat, lang)
                elif path == "/api/pay/usdt":
                    res = pay_usdt(chat)
                elif path == "/api/pay/jetton":
                    res = pay_jetton(str(body.get("owner") or ""))
                else:
                    res = pay_check(chat)
                    if res.get("plan") == "premium":
                        # Подписка только что включилась — старая выгрузка
                        # человека показывала бы замок ещё полминуты.
                        boot_drop(chat)
                self._json(200 if res.get("ok") else 400, res)
                return
            kind = {
                "/api/wallets": "add",
                "/api/wallets/remove": "remove",
                "/api/wallets/primary": "primary",
                "/api/wallets/rename": "rename",
                "/api/threshold": "threshold",
                "/api/lang": "lang",
                "/api/alerts/seen": "alerts_seen",
                "/api/alerts/mode": "alerts_mode",
                "/api/forget": "forget",
            }.get(path)
            if not kind:
                self._json(404, {"ok": False, "error": "not_found"})
                return
            res = mutate(chat, kind, body)
            # Данные человека изменились — старая выгрузка больше не годится,
            # и следующий ответ должен собираться заново, а не из памяти.
            boot_drop(chat)
            # После удаления bootstrap не зовём: он завёл бы пользователя
            # заново той же строкой INSERT OR IGNORE, и «удалено» оказалось
            # бы неправдой.
            if res.get("ok") and kind != "forget":
                # Через кэш, а не мимо: сборка всё равно нужна, и пусть
                # следующее «обновить» заберёт её готовой, а не повторит.
                res = {**res, **bootstrap_cached(chat)}
            self._json(200 if res.get("ok") else 400, res)
        except Exception as e:
            sys.stderr.write(f"[api] POST fail: {e}\n")
            try:
                self._json(500, {"ok": False, "error": str(e)})
            except Exception:
                pass


def main():
    # Без токена подпись не проверяется, а значит любой запрос анонимен и
    # мини-апп бесполезен. Раньше служба в этом случае тихо поднималась и
    # пускала всех.
    if not BOT_TOKEN:
        sys.stderr.write("[api] WHALE_TG_TOKEN не задан — запуск отменён\n")
        raise SystemExit(1)
    if not API_KEY:
        sys.stderr.write("[api] WHALE_API_KEY не задан: порт принимает запросы в обход nginx\n")
    if not ALLOWED_ORIGINS:
        sys.stderr.write("[api] WHALE_API_ORIGIN пуст: обращения из браузера напрямую будут отклонены\n")
    print(
        f"[api] ws={WS_DIR} db={DB} db_ok={os.path.isfile(DB)} "
        f"hl={HL_DB} hl_ok={os.path.isfile(HL_DB)} listen={HOST}:{PORT} "
        f"origins={len(ALLOWED_ORIGINS)} rpm={RATE_LIMIT_RPM} key={'yes' if API_KEY else 'no'}",
        flush=True,
    )
    threading.Thread(target=warmup, daemon=True).start()
    threading.Thread(target=refresher, daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
