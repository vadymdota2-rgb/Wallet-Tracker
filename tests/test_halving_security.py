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
        with mock.patch.object(hv._opener, "open") as op:
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

    def test_huge_body_is_read_only_up_to_the_limit(self):
        with self.local():
            got = hv._fetch(f"{self.base}/huge", 100_000)
        self.assertIsNotNone(got)
        self.assertEqual(len(got), 100_000)

    def test_chunks_respect_the_limit(self):
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
            self.assertEqual(len(hv._fetch("https://mempool.space/x", 40_000)), 40_000)
        self.assertTrue(all(0 < n <= hv.CHUNK for n in sizes))
        self.assertEqual(sum(sizes), 40_000)

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
            "/api/v1/blocks": b'[{"height":1e400,"timestamp":Infinity}]',
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
        with mock.patch.object(hv, "_fetch", fetch), mock.patch.object(hv, "_now", lambda: NOW), \
                mock.patch.object(hv, "_log", logs.append):
            hv.START_TS.pop(1_050_000, None)
            r = hv.build()
        self.assertTrue(r["ok"])
        self.assertEqual((r["height"], r["src"], r["tip"]), (1_050_100, "nominal", NOW))
        self.assertFalse([m for m in logs if m.startswith("сборка")])

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
        self.assertEqual(hv._dl.at, 0.0)
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


if __name__ == "__main__":
    unittest.main()
