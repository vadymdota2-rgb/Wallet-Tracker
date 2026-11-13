"""Нагрузка на /api/markets — настоящий сервер на своём компьютере.

Поднимает ShieldServer с обработчиком whale_api на свободном порту
127.0.0.1 и гоняет по нему тысячи разных подписчиков с постоянными
соединениями: подпись Telegram проверяется по-настоящему (выдуманным
токеном), лимит запросов — настоящий. Подменены только ответ модуля
(готовый, как из кэша) и проверка подписки (как из памяти _premium_memo):
базы и сеть не трогаются.

    python3 tools/load-markets.py [соединений=3] [секунд=5] [304] [candles]

«304» — у каждого телефона та же копия (If-None-Match); «candles» — дневные
свечи для мини-графика (/api/markets/candles: 9 пунктов × 30 свечей).
Печатает запросы в секунду и задержку (медиана и худший 1 %). Клиенты работают на той же
машине и отнимают у сервера ядра — на сервере цифры выше.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import multiprocessing as mp
import os
import sys
import threading
import time
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TOKEN = "123456:load-test-not-a-real-token"  # noqa: S105 — выдуманный, не настоящий токен бота
os.environ["WHALE_TG_TOKEN"] = TOKEN
import whale_api as api  # noqa: E402 — после подстановки токена
import wt_markets as mk  # noqa: E402
import wt_shield as shield  # noqa: E402

USERS = 3000  # разных подписчиков — каждый в своём лимите запросов
REPLY = {"ok": True, "at": int(time.time()), "items": [{"k": k, "px": 1234.5678, "prev": 1230.1} for k in mk.KEYS]}
_T = int(time.time())
_D0 = _T - _T % 86_400
CANDLES = {"ok": True, "at": _T, "days": {k: [[_D0 - (29 - i) * 86_400, 1234.5, 1240.25, 1228.75, round(1234.5 + (i % 17) * 0.37, 2)]
                                              for i in range(30)] for k in mk.KEYS}}


def init_data(uid: int) -> str:
    """Подпись Telegram для подписчика uid — как её строит Telegram."""
    parts = {"auth_date": str(int(time.time())), "user": json.dumps({"id": uid, "language_code": "ru"})}
    check = "\n".join(f"{k}={parts[k]}" for k in sorted(parts))
    secret = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    sign = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return "&".join(f"{k}={quote(v)}" for k, v in parts.items()) + f"&hash={sign}"


def client(port: int, users: list[str], secs: float, q: mp.Queue, inm: str, path: str) -> None:  # noqa: PLR0913 — параметры процесса-клиента
    lat: list[float] = []
    codes: dict[str, int] = {}
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    end, i = time.time() + secs, 0
    while time.time() < end:
        head = {"X-Api-Key": "k", "X-Telegram-Init-Data": users[i % len(users)], "Accept-Encoding": "gzip"}
        i += 1
        if inm:
            head["If-None-Match"] = inm
        t = time.perf_counter()
        try:
            conn.request("GET", path, headers=head)
            r = conn.getresponse()
            r.read()
            codes[str(r.status)] = codes.get(str(r.status), 0) + 1
        except (OSError, http.client.HTTPException):
            codes["сбой"] = codes.get("сбой", 0) + 1
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            continue
        lat.append(time.perf_counter() - t)
    q.put((lat, codes))


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    api.BOT_TOKEN, api.API_KEY = TOKEN, "k"
    api.markets_data = lambda: REPLY
    api.markets_candles = lambda: CANDLES
    path = "/api/markets/candles" if "candles" in sys.argv[3:] else "/api/markets"
    api.chat_premium = lambda chat: True
    api.sys.stderr = open(os.devnull, "w")  # noqa: SIM115 — журнал сервера не нужен
    httpd = shield.ShieldServer(("127.0.0.1", 0), api.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    inm = ""
    if "304" in sys.argv[3:]:
        c = http.client.HTTPConnection("127.0.0.1", port)
        c.request("GET", path, headers={"X-Api-Key": "k", "X-Telegram-Init-Data": init_data(1)})
        r = c.getresponse()
        r.read()
        inm = r.getheader("ETag") or ""
    users = [init_data(10_000 + i) for i in range(USERS)]
    q: mp.Queue = mp.Queue()
    ps = [mp.Process(target=client, args=(port, users[i::n], secs, q, inm, path)) for i in range(n)]
    for p in ps:
        p.start()
    res = [q.get() for _ in ps]
    for p in ps:
        p.join()
    lat = sorted(x for r in res for x in r[0])
    codes: dict[str, int] = {}
    for r in res:
        for k, v in r[1].items():
            codes[k] = codes.get(k, 0) + v
    if not lat:
        print("ни одного ответа:", codes)
        return

    def pct(f: float) -> float:
        return lat[int(f * (len(lat) - 1))] * 1000
    rps = f"{len(lat) / secs:,.0f}".replace(",", " ")
    print(f"{path} · соединений {n}: {rps} запросов/с; задержка — медиана {pct(0.5):.1f} мс, "
          f"худший 1 % {pct(0.99):.1f} мс; ответы {codes}")


if __name__ == "__main__":
    main()
