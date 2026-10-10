"""Щит API: защиты, которые стоят перед любым обработчиком whale_api.

Модуля «от всех атак» не бывает — защита строится под то, что у приложения
есть снаружи. У whale_api снаружи один HTTP-порт, за ним nginx в Cloud Run,
пользователь узнаётся по подписи Telegram. Отсюда и набор:

  * размер тела и адреса — потолок, иначе один запрос с Content-Length в
    гигабайт съедает память процесса (DoS);
  * тайм-аут соединения — медленный клиент (Slowloris) не держит поток вечно;
  * потолок одновременных соединений — поток на соединение, и тысяча
    открытых сокетов означала бы тысячу потоков;
  * бан за подбор ключа — кто стучится на порт мимо nginx с неверным
    X-Api-Key, после серии промахов получает час тишины. Банится только
    неверный ключ: запросы от nginx ключ несут всегда, а их адрес у Cloud Run
    общий на всех людей — забанить его значило бы закрыть приложение всем;
  * вычистка секретов из логов — подпись Telegram, ключи, токены;
  * заголовки безопасности на каждом ответе API;
  * ошибка наружу — только номер, без текста исключения: он рассказывал
    бы про пути, таблицы и устройство сервера;
  * подозрительный путь (выход из папки «..», нулевой байт, управляющие
    символы) — отказ сразу, до разбора;
  * TLS по желанию — если API_UPSTREAM у Cloud Run смотрит сюда через
    интернет, подпись и ключ не должны ехать открытым текстом.

Только стандартная библиотека — ставить на сервер ничего не нужно.
"""
from __future__ import annotations

import os
import re
import secrets
import ssl
import sys
import threading
import time
from http.server import ThreadingHTTPServer

# Тело POST: у приложения это JSON в пару сотен байт; nginx режет на 16 КБ.
MAX_BODY = int(os.environ.get("WHALE_API_MAX_BODY", str(16 * 1024)))
# Адрес запроса целиком: самый длинный у приложения — меньше пятисот байт.
MAX_URL = 4096
# Подпись Telegram — около полукилобайта; в разы больше — не подпись.
MAX_INIT_DATA = 4096
# Секунд на то, чтобы прислать запрос и тело; молчит дольше — соединение
# закрывается. Ответы считаются отдельно и тут не ограничены.
CONN_TIMEOUT = float(os.environ.get("WHALE_API_CONN_TIMEOUT", "20"))
# Одновременных соединений. nginx держит к API единицы-десятки — сотни
# бывают только при атаке.
MAX_CONN = int(os.environ.get("WHALE_API_MAX_CONN", "256"))
# Промахов ключом с одного адреса за окно — и бан.
BAN_FAILS = 20
BAN_WINDOW = 600.0
BAN_FOR = 3600.0

# Что вычищается из строк журнала: подпись Telegram и всё, что похоже на ключ.
_SECRET_QS = re.compile(r"(?i)\b(init|initdata|hash|signature|api_key|apikey|key|token|secret|password)=([^&\s\"']*)")
# Путь, который у приложения не встречается никогда: выход из папки,
# нулевой байт, управляющие символы, обратный слеш.
_BAD_PATH = re.compile(r"(\.\./|/\.\.|%2e%2e|%00|\x00|\\|[\x01-\x1f\x7f])", re.I)

SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    # Ответ API — данные, не страница: встраивать, исполнять и подгружать
    # из него нечего.
    ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"),
    ("X-Frame-Options", "DENY"),
    ("Cross-Origin-Resource-Policy", "same-site"),
)


def redact(text: str) -> str:
    """Строка журнала без секретов: init=…, key=…, token=… → ***."""
    return _SECRET_QS.sub(lambda m: f"{m.group(1)}=***", str(text))


def bad_path(raw_path: str) -> bool:
    return len(raw_path) > MAX_URL or bool(_BAD_PATH.search(raw_path))


class BodyError(Exception):
    def __init__(self, code: int, error: str):
        super().__init__(error)
        self.code = code
        self.error = error


def read_body(rfile, headers) -> bytes:
    """Тело запроса с потолком. Неверная длина — 400, слишком большое — 413.

    Длину проверяем до чтения: прочитать гигабайт, чтобы потом отказать, —
    та же атака, только медленнее."""
    raw = headers.get("Content-Length")
    if raw is None or raw == "":
        return b""
    try:
        n = int(raw)
    except ValueError:
        raise BodyError(400, "bad_length") from None
    if n < 0:
        raise BodyError(400, "bad_length")
    if n > MAX_BODY:
        raise BodyError(413, "too_large")
    return rfile.read(n) if n else b""


class Bans:
    """Промахи ключом по адресу и временные баны. Всё в памяти: процесс один."""

    def __init__(self):
        self.fails: dict[str, list[float]] = {}
        self.until: dict[str, float] = {}
        self.lock = threading.Lock()

    def banned(self, ip: str) -> bool:
        with self.lock:
            t = self.until.get(ip)
            if t and t > time.monotonic():
                return True
            if t:
                self.until.pop(ip, None)
            return False

    def fail(self, ip: str) -> None:
        now = time.monotonic()
        with self.lock:
            if len(self.fails) > 10000:  # подметаем, чтобы словарь не рос бесконечно
                for k in [k for k, v in self.fails.items() if not v or now - v[-1] > BAN_WINDOW]:
                    self.fails.pop(k, None)
            seq = [x for x in self.fails.get(ip, ()) if now - x < BAN_WINDOW]
            seq.append(now)
            self.fails[ip] = seq
            if len(seq) >= BAN_FAILS:
                self.until[ip] = now + BAN_FOR
                self.fails.pop(ip, None)
                sys.stderr.write(f"[shield] бан на час: {ip} — {BAN_FAILS} промахов ключом за {int(BAN_WINDOW)} с\n")


bans = Bans()


def error_id() -> str:
    """Номер ошибки: наружу уходит он, в журнал — он же с подробностями."""
    return secrets.token_hex(4)


class ShieldServer(ThreadingHTTPServer):
    """ThreadingHTTPServer с потолком одновременных соединений.

    Сверх потолка соединение получает короткий 503 и закрывается сразу, без
    отдельного потока: поток на каждого и есть то, что кончается при атаке."""

    daemon_threads = True
    request_queue_size = 128

    def __init__(self, addr, handler, max_conn: int = MAX_CONN):
        self._slots = threading.BoundedSemaphore(max(8, max_conn))
        super().__init__(addr, handler)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def tls_wrap(httpd) -> bool:
    """Включает TLS, если заданы WHALE_API_TLS_CERT и WHALE_API_TLS_KEY.

    Нужно, когда nginx в Cloud Run ходит сюда через интернет: иначе подпись
    Telegram и X-Api-Key едут открытым текстом. Подойдёт и самоподписанный
    сертификат — шифрует он так же; проверку имени у nginx тогда выключают."""
    cert = os.environ.get("WHALE_API_TLS_CERT", "")
    key = os.environ.get("WHALE_API_TLS_KEY", "")
    if not cert or not key:
        return False
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    # Рукопожатие — не в accept(), а при первом чтении, в потоке соединения
    # и под его тайм-аутом: иначе один молчащий клиент останавливал бы приём
    # всех остальных.
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
    return True
