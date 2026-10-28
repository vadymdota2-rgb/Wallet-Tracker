"""Атаки на модуль халвинга (wt_halving.py): npm test.

Модель угрозы: источник (mempool и запасные) взломан или ответ подменён.
Он не должен: увести сервер на чужой или внутренний адрес (SSRF), уронить
сборку или сжечь процессор хитрым JSON, держать поток часами, подделать
журнал, заставить сервер долбить сеть на каждый запрос. Сетевые проверки —
на настоящем HTTP-сервере на 127.0.0.1, через ту же «открывалку», что в бою.
"""
import contextlib
import io
import os
import socket
import ssl
import sys
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_halving as hv  # noqa: E402 — модуль лежит в корне репозитория

NOW = 1_791_881_300
# Сто блоков новой эпохи (2028): высота 1 050 100 правдоподобна только тогда.
NOW2 = 1_838_896_000 + 100 * 600 + 60


class Evil(BaseHTTPRequestHandler):
    """Злой источник: перенаправляет, цедит по байту, шлёт мегабайты."""

    hits: ClassVar[list[str]] = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        Evil.hits.append(self.path)
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/secret")
            self.end_headers()
        elif self.path == "/drip":
            self.send_response(200)
            self.send_header("Content-Length", "1000")
            self.end_headers()
            with contextlib.suppress(OSError):
                for _ in range(1000):
                    self.wfile.write(b"1")
                    self.wfile.flush()
                    time.sleep(0.05)
        elif self.path == "/slowhead":
            # Заголовки по байту: тайм-аут сокета — на каждый кусок, и без
            # срока на всё соединение поток ждал бы сколько угодно.
            with contextlib.suppress(OSError):
                for b in b"HTTP/1.1 200 OK\r\nX-Slow: " + b"a" * 1000:
                    self.wfile.write(bytes([b]))
                    self.wfile.flush()
                    time.sleep(0.05)
        elif self.path == "/huge":
            self.send_response(200)
            self.end_headers()
            with contextlib.suppress(OSError):
                self.wfile.write(b"9" * (5 << 20))
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"secret")


class SecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Evil)
        cls.srv.daemon_threads = True
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        Evil.hits = []
        hv._st = hv._State()
        hv._busy.clear()
        hv._dl.at = 0.0

    def local(self):
        """Пустить модуль на локальный злой сервер (в бою — только https и три адреса)."""
        return mock.patch.multiple(hv, HOSTS=frozenset({"127.0.0.1"}), SCHEMES=frozenset({"http"}))

    # ── Куда модуль ходит ────────────────────────────────────────────────

    def test_only_https_to_known_hosts(self):
        for url in ("https://mempool.space/api/v1/blocks", "https://blockstream.info/api/blocks/tip/height",
                    "https://blockchain.info/q/getblockcount"):
            self.assertTrue(hv._allowed(url), url)
        for url in ("http://mempool.space/api/v1/blocks",  # без шифрования
                    "https://169.254.169.254/latest/meta-data/",  # метаданные облака
                    "https://127.0.0.1/", "https://localhost/", "https://[::1]/",
                    "https://mempool.space.evil.com/", "https://evil.com/mempool.space",
                    "https://evil.com#@mempool.space", "https://user@mempool.space/",
                    "https://user:pw@mempool.space/", "file:///etc/passwd", "ftp://mempool.space/",
                    "https://[", "", "mempool.space/api"):
            self.assertFalse(hv._allowed(url), url)

    def test_forbidden_url_never_reaches_the_network(self):
        with mock.patch.object(hv._opener, "open", side_effect=AssertionError("ушло в сеть")) as op:
            for url in ("https://169.254.169.254/", "http://mempool.space/", "https://evil.com/"):
                self.assertIsNone(hv._fetch(url))
            op.assert_not_called()

    def test_redirect_is_not_followed(self):
        with self.local():
            self.assertIsNone(hv._fetch(f"{self.base}/redirect"))
        self.assertEqual(Evil.hits, ["/redirect"])  # на /secret не пошли

    def test_opener_checks_certificates_and_has_no_redirects(self):
        https = [h for h in hv._opener.handlers if isinstance(h, urllib.request.HTTPSHandler)]
        self.assertEqual(len(https), 1)
        ctx = https[0]._context
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        redirects = [h for h in hv._opener.handlers if isinstance(h, urllib.request.HTTPRedirectHandler)]
        self.assertTrue(redirects)
        self.assertTrue(all(isinstance(h, hv._NoRedirect) for h in redirects))

    # ── Сколько и как долго читаем ───────────────────────────────────────

    def test_slow_drip_is_cut_by_the_deadline(self):
        with self.local(), mock.patch.object(hv, "HOP", 0.4):
            t0 = time.monotonic()
            self.assertIsNone(hv._fetch(f"{self.base}/drip"))
            # 1000 байт по 0,05 с — это 50 секунд; срок — 0,4 с (+ один кусок).
            self.assertLess(time.monotonic() - t0, 1.5)

    def test_slow_headers_are_cut_by_the_deadline(self):
        with self.local(), mock.patch.object(hv, "HOP", 0.4):
            hv._dl.why = []
            # Список причин — только на этот тест: оставленный, он собирал бы
            # причины и там, где сборка должна завести его сама.
            self.addCleanup(setattr, hv._dl, "why", None)
            t0 = time.monotonic()
            self.assertIsNone(hv._fetch(f"{self.base}/slowhead"))
            # Заголовки шли бы 50 секунд; срок — 0,4 с на весь запрос.
            self.assertLess(time.monotonic() - t0, 1.5)
            self.assertTrue(hv._dl.why)
        # Сторож снят, копия сокета закрыта — ничего не висит до следующего запроса.
        self.assertIsNone(hv._dl.cuts)

    def test_address_without_socket_support_moves_to_the_next(self):
        # Нет IPv6 на машине — socket() бросает сразу. Это сбой адреса, а не
        # всего запроса: следующий адрес пробуем.
        real = hv.socket.socket
        made = []

        def flaky(*a, **k):
            made.append(a)
            if len(made) == 1:
                raise OSError(97, "Address family not supported by protocol")
            return real(*a, **k)

        addr = (hv.socket.AF_INET, hv.socket.SOCK_STREAM, 6, "", ("127.0.0.1", self.srv.server_address[1]))
        with self.local(), mock.patch.object(hv.socket, "getaddrinfo", lambda *a, **k: [addr, addr]), \
                mock.patch.object(hv.socket, "socket", flaky):
            self.assertEqual(hv._fetch(f"{self.base}/ok"), b"secret")
        self.assertGreaterEqual(len(made), 2)

    def test_silent_dns_is_cut_by_the_deadline(self):
        def hang(*_a, **_k):
            time.sleep(5)
            raise OSError("поздно")
        with self.local(), mock.patch.object(hv, "HOP", 0.3), mock.patch.object(hv.socket, "getaddrinfo", hang):
            hv._dl.why = []
            # Список причин — только на этот тест: оставленный, он собирал бы
            # причины и там, где сборка должна завести его сама.
            self.addCleanup(setattr, hv._dl, "why", None)
            t0 = time.monotonic()
            self.assertIsNone(hv._fetch(f"{self.base}/ok"))
            self.assertLess(time.monotonic() - t0, 1.0)
            self.assertIn("DNS", " ".join(hv._dl.why))

    def test_watch_is_released_after_a_good_answer(self):
        # Проверяем сами сокеты модуля, а не число дескрипторов процесса:
        # злой сервер теста живёт в том же процессе, закрывает свою сторону
        # чуть позже, чем клиент дочитал, а поток /drip из другого теста
        # держит свой сокет до 50 с — счёт «до и после» гулял (9 != 8 в CI).
        socks, watches = [], []
        real = hv._watch

        def spy(sock, end):
            real(sock, end)
            socks.append(sock)
            watches.append(hv._dl.cuts[-1][1])
        with self.local(), mock.patch.object(hv, "_watch", spy):
            self.assertEqual(hv._fetch(f"{self.base}/ok"), b"secret")
        self.assertIsNone(hv._dl.cuts)
        # Копия сокета для сторожа закрыта явно — не сборщиком мусора, когда
        # повезёт: иначе каждый запрос оставлял бы по дескриптору, раз в пять
        # минут, пока их не кончится. И само соединение закрыто.
        self.assertEqual((len(socks), len(watches)), (1, 1))
        self.assertEqual(watches[0].fileno(), -1)
        self.assertEqual(socks[0].fileno(), -1)

    def test_huge_body_is_rejected_not_cut(self):
        # Обрезанный ответ — не ответ: начало длинного числа или списка
        # могло бы разобраться как что-то правдоподобное.
        with self.local():
            self.assertIsNone(hv._fetch(f"{self.base}/huge", 100_000))

    def test_chunks_stop_one_byte_past_the_limit(self):
        sizes = []

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read1(self, n=-1):
                sizes.append(n)
                return super().read1(n)

        with mock.patch.object(hv._opener, "open", lambda req, timeout=0: Resp(b"x" * 100_000)):
            self.assertIsNone(hv._fetch("https://mempool.space/x", 40_000))
        self.assertTrue(all(0 < n <= hv.CHUNK for n in sizes))
        self.assertEqual(sum(sizes), 40_001)  # ровно на байт больше limit — и стоп
        sizes.clear()
        with mock.patch.object(hv._opener, "open", lambda req, timeout=0: Resp(b"x" * 40_000)):
            self.assertEqual(len(hv._fetch("https://mempool.space/x", 40_000)), 40_000)

    def test_numbers_from_json_must_have_the_right_type(self):
        # Высота и время — только целые; строка, дробь, True — сбой источника.
        for v, want in ((1_050_100, 1_050_100), ("1050100", 0), (1050100.0, 0), (True, 0), (None, 0), ([1], 0)):
            self.assertEqual(hv._whole(v), want, v)
        for v, want in ((570_866, 570_866.0), (570_866.5, 570_866.5), ("570866", 0.0), (True, 0.0), ({}, 0.0)):
            self.assertEqual(hv._real(v), want, v)
        logs = []
        tip = "/api/block/" + "b" * 64
        net = {"tip/hash": b"b" * 64, tip: b'{"height":"1050100","timestamp":1838955000}',
               "difficulty-adjustment": b'{"timeAvg":"570866"}'}

        def fetch(url, limit=1 << 20):
            return next((v for k, v in net.items() if k in url), None)

        with mock.patch.object(hv, "_fetch", fetch), mock.patch.object(hv, "_now", lambda: NOW2), \
                mock.patch.object(hv, "_log", logs.append):
            self.assertEqual(hv.build(), {"ok": False, "error": "no_data"})  # высота-строка не годится
            hv._st = hv._State()
            net[tip] = b'{"height":1050100,"timestamp":1838955000}'
            hv.START_TS.pop(1_050_000, None)
            r = hv.build()
        self.assertEqual((r["height"], r["src"], r["avg"]), (1_050_100, "nominal", 600.0))  # среднее-строка — нет

    def test_log_never_breaks_the_module(self):
        dead = io.StringIO()
        dead.close()
        with mock.patch("sys.stderr", dead):
            hv._log("журнал закрыт")  # не падает

    # ── Что разбираем ────────────────────────────────────────────────────

    def test_hostile_json_is_rejected_fast_without_raising(self):
        evil = [b"1e400", b"-1e400", b'[{"height":1e400}]', b"NaN", b"Infinity", b"-Infinity",
                b'{"timeAvg":NaN}', b"[" * 200_000 + b"]" * 200_000, b'{"a":' * 100_000 + b"1" + b"}" * 100_000,
                b"9" * 1_000_000, b'[{"height":' + b"9" * 500_000 + b"}]", b'[{"height":123456789012345678901}]', b"\xff\xfe", b'"\\ud800"']
        for raw in evil:
            with mock.patch.object(hv, "_fetch", lambda url, limit=1 << 20, raw=raw: raw):
                t0 = time.monotonic()
                got = hv._json("https://mempool.space/x")
                self.assertLess(time.monotonic() - t0, 1.0, raw[:30])
            self.assertTrue(got is None or got == "\ud800", raw[:30])
        with mock.patch.object(hv, "_fetch", lambda url, limit=1 << 20: b'[{"height":1050100,"ts":1.5}]'):
            self.assertEqual(hv._json("https://mempool.space/x"), [{"height": 1050100, "ts": 1.5}])

    def test_short_numbers_only(self):
        self.assertEqual(hv._short_int("9" * hv.INT_MAX), int("9" * hv.INT_MAX))
        with self.assertRaises(ValueError):
            hv._short_int("9" * (hv.INT_MAX + 1))
        with self.assertRaises(ValueError):
            hv._finite("1e400")
        self.assertEqual(hv._finite("1.5"), 1.5)

    def test_poisoned_sources_never_crash_the_build(self):
        # Каждый источник шлёт отраву: сборка не падает и не уходит в «общий
        # перехват» (тот — последняя страховка, а не способ разбора).
        poison = {
            "tip/hash": b"b" * 64,
            "/api/block/" + "b" * 64: b'{"height":1e400,"timestamp":Infinity}',
            "difficulty-adjustment": b'{"timeAvg":1e400}',
            "block-height": b"../../../etc/passwd",
            "/api/block/": b'{"timestamp":NaN}',
        }

        def fetch(url, limit=1 << 20):
            for k, v in poison.items():
                if k in url:
                    return v
            return b"1050100"

        logs = []
        with mock.patch.object(hv, "_fetch", fetch), mock.patch.object(hv, "_now", lambda: NOW2), \
                mock.patch.object(hv, "_log", logs.append):
            hv.START_TS.pop(1_050_000, None)
            r = hv.build()
        self.assertTrue(r["ok"])
        self.assertEqual((r["height"], r["src"], r["tip"]), (1_050_100, "nominal", NOW2))
        self.assertFalse([m for m in logs if m.startswith("сборка")])

    def test_height_text_is_ascii_digits_only(self):
        for raw, want in ((b"1050100", 1_050_100), (b" 1050100\n", 1_050_100), (b"1_050_100", 0), (b"+1050100", 0),
                          ("١٠٥٠١٠٠".encode(), 0), (b"-5", 0), (b"1e6", 0), (b"9" * 21, 0), (b"", 0), (None, 0)):
            with mock.patch.object(hv, "_fetch", lambda url, limit=1 << 20, raw=raw: raw):
                self.assertEqual(hv._int("https://mempool.space/x"), want, raw)

    # ── Падение и журнал ─────────────────────────────────────────────────

    def test_crash_in_build_pauses_the_sources(self):
        calls = []

        def boom():
            calls.append(1)
            raise RecursionError("deep\n\x1b[31mhalving: подделка")

        err = io.StringIO()
        with mock.patch.object(hv, "_build", boom), mock.patch("sys.stderr", err):
            for _ in range(5):
                self.assertEqual(hv.halving_data(), {"ok": False, "error": "no_data"})
        self.assertEqual(len(calls), 1)  # не по разу на каждый запрос
        self.assertTrue(hv._failed())
        # Срок и причины сборки сброшены и после падения (сборка шла в фоне —
        # проверяем на прямом вызове).
        with mock.patch.object(hv, "_build", boom), mock.patch("sys.stderr", io.StringIO()):
            hv.build()
        self.assertEqual((hv._dl.at, hv._dl.why), (0.0, None))
        out = err.getvalue()
        self.assertEqual(out.count("\n"), 1)
        self.assertNotIn("\x1b", out)
        self.assertIn("RecursionError", out)

    def test_crash_keeps_the_last_good_answer(self):
        good = {"ok": True, "height": 1}
        hv._st.hit = (time.monotonic() - 1000, good)
        with mock.patch.object(hv, "_build", side_effect=OverflowError("x")), mock.patch("sys.stderr", io.StringIO()):
            self.assertIs(hv.build(), good)

    def test_log_is_one_short_line(self):
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            hv._log("a\r\nhalving: fake\x1b[2J\x00" + "x" * 10_000)
        out = err.getvalue()
        self.assertEqual(out.count("\n"), 1)
        self.assertTrue(out.endswith("\n"))
        self.assertFalse(any(not c.isprintable() for c in out[:-1]))
        self.assertLessEqual(len(out), len("halving: ") + hv.LOG_MAX + 1)

    def test_closed_port_is_just_no_data(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        with self.local():
            self.assertIsNone(hv._fetch(f"http://127.0.0.1:{port}/"))


class WhyTest(unittest.TestCase):
    """Высоту не дал никто — в журнал одна строка с причиной от каждого источника."""

    def setUp(self):
        hv._st = hv._State()

    def test_all_sources_fail_one_line_with_reasons(self):
        logs = []
        with mock.patch.object(hv._opener, "open", side_effect=TimeoutError("timed out")), \
                mock.patch.object(hv, "_now", lambda: NOW), mock.patch.object(hv, "_log", logs.append):
            self.assertEqual(hv.build(), {"ok": False, "error": "no_data"})
        self.assertEqual(len(logs), 1, logs)
        for host in ("mempool.space", "blockstream.info", "blockchain.info"):
            self.assertIn(f"{host}: TimeoutError: timed out", logs[0])
        self.assertIsNone(hv._dl.why)  # после сборки список убран

    def test_plausibility_failure_is_named_too(self):
        # Источники ответили, но высота неправдоподобна — причина не пустая.
        logs = []
        with mock.patch.object(hv, "_fetch", lambda url, limit=0: b"5"), \
                mock.patch.object(hv, "_now", lambda: NOW), mock.patch.object(hv, "_log", logs.append):
            hv.build()
        self.assertEqual(logs, ["нет высоты блока ни от одного источника: ответы неправдоподобны"])

    def test_reasons_are_bounded_and_ignored_outside_a_build(self):
        hv._why("вне сборки")  # не падает и никуда не пишет
        hv._dl.why = []
        try:
            for i in range(50):
                hv._why(f"сбой {i}")
            self.assertEqual(len(hv._dl.why), hv.WHY_MAX)
        finally:
            hv._dl.why = None


class ConnectTest(unittest.TestCase):
    """_connect: адреса источника по очереди, молчащий не съедает запрос (как в wt_fng)."""

    @staticmethod
    def fake(dead: set[str]):
        """Подмена socket.socket: соединение с адресом из dead висит (тайм-аут)."""
        made = []

        class Sock:
            def __init__(self, family, kind, proto):
                self.family, self.timeouts, self.closed, self.addr = family, [], False, None
                made.append(self)

            def settimeout(self, t):
                self.timeouts.append(t)

            def connect(self, addr):
                self.addr = addr[0]
                if addr[0] in dead:
                    raise TimeoutError("timed out")

            def close(self):
                self.closed = True
        return Sock, made

    @staticmethod
    def infos(*ips):
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]

    def test_silent_address_is_skipped_quickly_and_ipv4_goes_first(self):
        Sock, made = self.fake({"10.0.0.1"})
        with mock.patch.object(hv.socket, "getaddrinfo", return_value=self.infos("2001:db8::1", "10.0.0.1", "10.0.0.2")), \
                mock.patch.object(hv.socket, "socket", Sock):
            s = hv._connect(("mempool.space", 443), 6.0)
        self.assertEqual([m.addr for m in made], ["10.0.0.1", "10.0.0.2"])  # IPv4 первыми, IPv6 не понадобился
        self.assertIs(s, made[1])
        self.assertTrue(made[0].closed)
        self.assertFalse(made[1].closed)
        # Соединение — не дольше CONNECT; дальше сокет живёт с тайм-аутом запроса.
        self.assertLessEqual(made[0].timeouts[0], hv.CONNECT)
        self.assertEqual(made[1].timeouts[-1], 6.0)

    def test_all_silent_raises_and_closes_everything(self):
        Sock, made = self.fake({"10.0.0.1", "10.0.0.2"})
        with mock.patch.object(hv.socket, "getaddrinfo", return_value=self.infos("10.0.0.1", "10.0.0.2")), \
                mock.patch.object(hv.socket, "socket", Sock), self.assertRaises(OSError):
            hv._connect(("mempool.space", 443), 6.0)
        self.assertEqual(len(made), 2)
        self.assertTrue(all(m.closed for m in made))

    def test_no_time_left_no_more_tries(self):
        Sock, made = self.fake({"10.0.0.1", "10.0.0.2", "10.0.0.3"})
        clock = iter([0.0, 0.0, 0.0, 10.0, 10.0])  # конец бюджета, ожидание DNS, первая попытка, после неё — времени нет
        with mock.patch.object(hv.socket, "getaddrinfo", return_value=self.infos("10.0.0.1", "10.0.0.2", "10.0.0.3")), \
                mock.patch.object(hv.socket, "socket", Sock), \
                mock.patch.object(hv.time, "monotonic", lambda: next(clock, 10.0)), self.assertRaises(OSError):
            hv._connect(("mempool.space", 443), 5.0)
        self.assertEqual(len(made), 1)

    def test_only_known_hosts(self):
        with mock.patch.object(hv.socket, "getaddrinfo", side_effect=AssertionError("в DNS не ходим")), \
                self.assertRaises(OSError):
            hv._connect(("evil.example", 443), 5.0)

    def test_requests_connect_through_it(self):
        with mock.patch.object(hv, "_connect", side_effect=OSError("нет сети")) as c:
            self.assertIsNone(hv._fetch("https://mempool.space/api/blocks/tip/hash"))
        self.assertEqual(c.call_args[0][0], ("mempool.space", 443))


if __name__ == "__main__":
    unittest.main()
