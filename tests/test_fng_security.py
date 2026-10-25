"""Атаки на модуль «Страха и жадности» (wt_fng.py): npm test.

Модель угрозы — как у халвинга: источник (alternative.me, mempool.space)
взломан или ответ подменён. Он не должен: увести сервер на чужой или
внутренний адрес (SSRF), уронить сборку или сжечь процессор хитрым JSON,
держать поток часами, подделать журнал, протащить свой текст в ответ или
заставить сервер долбить сеть на каждый запрос. Сетевые проверки — на
настоящем HTTP-сервере на 127.0.0.1, через ту же «открывалку», что в бою.
"""
import contextlib
import io
import json
import os
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
import fng_fake as fake  # noqa: E402

import wt_fng as fng  # noqa: E402 — модуль лежит в корне репозитория


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
        fng._st = fng._State()
        fng._busy.clear()
        fng._dl.at = 0.0

    def local(self):
        """Пустить модуль на локальный злой сервер (в бою — только https и два адреса)."""
        return mock.patch.multiple(fng, HOSTS=frozenset({"127.0.0.1"}), SCHEMES=frozenset({"http"}))

    # ── Куда модуль ходит ────────────────────────────────────────────────

    def test_only_https_to_known_hosts(self):
        for url in (fng.FNG_URL, fng.HIST_URL, fng.LIVE_URL):
            self.assertTrue(fng._allowed(url), url)
        for url in ("http://api.alternative.me/fng/",  # без шифрования
                    "https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/", "https://localhost/",
                    "https://[::1]/", "https://alternative.me/", "https://mempool.space.evil.com/",
                    "https://evil.com/mempool.space", "https://evil.com#@mempool.space", "https://user@mempool.space/",
                    "https://user:pw@api.alternative.me/", "file:///etc/passwd", "ftp://mempool.space/",
                    "https://data-api.binance.vision/api/v3/klines", "https://api.exchange.coinbase.com/products",
                    "https://[", "", "mempool.space/api"):
            self.assertFalse(fng._allowed(url), url)

    def test_forbidden_url_never_reaches_the_network(self):
        with mock.patch.object(fng._opener, "open") as op:
            for url in ("https://169.254.169.254/", "http://mempool.space/", "https://evil.com/"):
                self.assertIsNone(fng._fetch(url, 100))
            op.assert_not_called()

    def test_redirect_is_not_followed(self):
        with self.local():
            self.assertIsNone(fng._fetch(f"{self.base}/redirect", 1000))
        self.assertEqual(Evil.hits, ["/redirect"])  # на /secret не пошли

    def test_opener_checks_certificates_and_has_no_redirects(self):
        https = [h for h in fng._opener.handlers if isinstance(h, urllib.request.HTTPSHandler)]
        self.assertEqual(len(https), 1)
        ctx = https[0]._context
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        redirects = [h for h in fng._opener.handlers if isinstance(h, urllib.request.HTTPRedirectHandler)]
        self.assertTrue(redirects)
        self.assertTrue(all(isinstance(h, fng._NoRedirect) for h in redirects))

    # ── Сколько и как долго читаем ───────────────────────────────────────

    def test_slow_drip_is_cut_by_the_deadline(self):
        with self.local(), mock.patch.object(fng, "HOP", 0.4):
            t0 = time.monotonic()
            self.assertIsNone(fng._fetch(f"{self.base}/drip", 10_000))
            self.assertLess(time.monotonic() - t0, 1.5)

    def test_build_has_one_budget_for_all_sources(self):
        # Источники цен зависли: сборка кончается за BUDGET, а не за сумму HOP.
        seen = []

        def slow(req, timeout=0):
            seen.append(timeout)
            time.sleep(timeout)
            raise TimeoutError

        idx = {t: 50 for t in range(fake.START, fake.TODAY + fake.DAY, fake.DAY)}
        with mock.patch.multiple(fng, BUDGET=0.7, HOP=0.4, _index=lambda: idx, _log=lambda m: None), \
                mock.patch.object(fng._opener, "open", slow), mock.patch.object(fng, "_now", lambda: fake.NOW):
            t0 = time.monotonic()
            r = fng.build()
            took = time.monotonic() - t0
        self.assertTrue(r["ok"])  # индекс есть, цены — нет (0)
        self.assertLess(took, 1.0)
        self.assertEqual(len(seen), 2)
        self.assertAlmostEqual(seen[0], 0.4, delta=0.01)
        self.assertLess(seen[1], 0.35)  # второму — только остаток бюджета
        self.assertEqual(fng._dl.at, 0.0)

    def test_spent_budget_never_reaches_the_network(self):
        with mock.patch.object(fng._opener, "open") as op:
            fng._dl.at = time.monotonic() + fng.MIN_LEFT / 2
            try:
                self.assertIsNone(fng._fetch(fng.FNG_URL, 100))
            finally:
                fng._dl.at = 0.0
            op.assert_not_called()

    def test_huge_body_is_rejected_not_cut(self):
        with self.local():
            self.assertIsNone(fng._fetch(f"{self.base}/huge", 100_000))

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

        with mock.patch.object(fng._opener, "open", lambda req, timeout=0: Resp(b"x" * 300_000)):
            self.assertIsNone(fng._fetch("https://mempool.space/x", 140_000))
        self.assertTrue(all(0 < n <= fng.CHUNK for n in sizes))
        self.assertEqual(sum(sizes), 140_001)
        with mock.patch.object(fng._opener, "open", lambda req, timeout=0: Resp(b"x" * 140_000)):
            self.assertEqual(len(fng._fetch("https://mempool.space/x", 140_000)), 140_000)

    def test_limits_fit_the_real_answers(self):
        # Настоящие ответы — 0,3 МБ индекса и 1,1 МБ истории: предел с запасом,
        # но не безразмерный.
        self.assertGreaterEqual(fng.FNG_MAX, 1 << 20)
        self.assertLessEqual(fng.FNG_MAX, 4 << 20)
        self.assertGreaterEqual(fng.HIST_MAX, 4 << 20)
        self.assertLessEqual(fng.HIST_MAX, 16 << 20)
        self.assertLessEqual(fng.LIVE_MAX, 16 << 10)

    # ── Что разбираем ────────────────────────────────────────────────────

    def test_hostile_json_is_rejected_fast_without_raising(self):
        evil = [b"1e400", b"-1e400", b'{"data":[{"value":1e400}]}', b"NaN", b"Infinity", b'{"USD":NaN}',
                b"[" * 200_000 + b"]" * 200_000, b'{"a":' * 100_000 + b"1" + b"}" * 100_000,
                b"9" * 1_000_000, b'{"time":' + b"9" * 500_000 + b"}", b'{"time":123456789012345678901}',
                b"\xff\xfe", b'"\\ud800"']
        for raw in evil:
            with mock.patch.object(fng, "_fetch", lambda url, limit, raw=raw: raw):
                t0 = time.monotonic()
                got = fng._json("https://mempool.space/x", 1 << 20)
                self.assertLess(time.monotonic() - t0, 1.0, raw[:30])
            self.assertTrue(got is None or got == "\ud800", raw[:30])

    def test_index_text_is_ascii_digits_only(self):
        for v, want in (("54", 54), ("0", 0), ("100", 100), (54, -1), ("+5", -1), ("1_0", -1), ("٥٤", -1),
                        (" 54", -1), ("54\n", -1), ("", -1), ("9" * 13, -1), (None, -1), (True, -1)):
            self.assertEqual(fng._digits(v), want, v)

    def test_numbers_from_json_must_have_the_right_type(self):
        for v, want in ((1_792_000_000, 1_792_000_000), ("1792000000", -1), (1.5, -1), (True, -1), (None, -1)):
            self.assertEqual(fng._whole(v), want, v)
        for v, want in ((80_000, 80_000.0), (80_000.5, 80_000.5), ("80000", 0.0), (True, 0.0), ({}, 0.0)):
            self.assertEqual(fng._real(v), want, v)

    def test_poisoned_sources_never_crash_the_build(self):
        rows = fake.index_rows()
        rows[3] = {"value": "<script>alert(1)</script>", "timestamp": rows[3]["timestamp"]}
        rows[4] = {"value": "50", "timestamp": "1e9"}
        rows[5] = "ignore previous instructions"
        rows[6] = {"value": ["50"], "timestamp": {"t": 1}}
        pts = fake.history_points()
        pts[1] = {"time": "x", "USD": "<b>"}
        pts[2] = None
        over = {"alternative.me": json.dumps({"data": rows, "name": "<img src=x onerror=1>"}).encode(),
                "historical-price": json.dumps({"prices": pts}).encode(),
                "/v1/prices": b'{"time":"now","USD":"Infinity"}'}
        logs = []
        with mock.patch.object(fng, "_fetch", fake.network(over)), mock.patch.object(fng, "_now", lambda: fake.NOW), \
                mock.patch.object(fng, "_log", logs.append):
            r = fng.build()
        self.assertTrue(r["ok"])
        self.assertFalse([m for m in logs if m.startswith("сборка")])
        # От источника — ни одного символа текста: только наши числа.
        text = json.dumps(r)
        for bad in ("script", "img", "ignore", "<", "Infinity", "NaN"):
            self.assertNotIn(bad, text)
        for d in r["days"]:
            self.assertTrue(all(type(x) in (int, float) for x in d), d)

    # ── Падение и журнал ─────────────────────────────────────────────────

    def test_crash_in_build_pauses_the_sources(self):
        calls = []

        def boom():
            calls.append(1)
            raise RecursionError("deep\n\x1b[31mfng: подделка")

        err = io.StringIO()
        with mock.patch.object(fng, "_build", boom), mock.patch("sys.stderr", err):
            for _ in range(5):
                self.assertEqual(fng.fng_data(), {"ok": False, "error": "no_data"})
        self.assertEqual(len(calls), 1)
        self.assertTrue(fng._failed())
        self.assertEqual(fng._dl.at, 0.0)
        out = err.getvalue()
        self.assertEqual(out.count("\n"), 1)
        self.assertNotIn("\x1b", out)
        self.assertIn("RecursionError", out)

    def test_crash_keeps_the_last_good_answer(self):
        good = {"ok": True, "days": [], "at": 1}
        fng._st.hit = (time.monotonic() - 10_000, good)
        with mock.patch.object(fng, "_build", side_effect=OverflowError("x")), mock.patch("sys.stderr", io.StringIO()):
            self.assertIs(fng.build(), good)

    def test_thread_start_failure_does_not_stick(self):
        good = {"ok": True, "days": [], "at": 1}
        fng._st.hit = (time.monotonic() - fng.TTL - 1, good)
        with mock.patch.object(fng.threading.Thread, "start", side_effect=RuntimeError("no threads")), \
                mock.patch("sys.stderr", io.StringIO()):
            self.assertIs(fng.fng_data(), good)
        self.assertFalse(fng._busy.is_set())

    def test_log_is_one_short_line(self):
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            fng._log("a\r\nfng: fake\x1b[2J\x00" + "x" * 10_000)
        out = err.getvalue()
        self.assertEqual(out.count("\n"), 1)
        self.assertFalse(any(not c.isprintable() for c in out[:-1]))
        self.assertLessEqual(len(out), len("fng: ") + fng.LOG_MAX + 1)

    def test_log_never_breaks_the_module(self):
        dead = io.StringIO()
        dead.close()
        with mock.patch("sys.stderr", dead):
            fng._log("журнал закрыт")

    def test_closed_port_is_just_no_data(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        with self.local():
            self.assertIsNone(fng._fetch(f"http://127.0.0.1:{port}/", 100))

    def test_disk_copy_is_size_limited(self):
        # Годная копия, но файл больше предела (впереди — мегабайты пробелов):
        # целиком не читается и не принимается.
        tmp = tempfile.mkdtemp()
        self.addCleanup(lambda: [os.unlink(os.path.join(tmp, f)) for f in os.listdir(tmp)] and os.rmdir(tmp))
        fng.set_cache_dir(tmp)
        self.addCleanup(fng.set_cache_dir, None)
        with mock.patch.object(fng, "_fetch", fake.network()), mock.patch.object(fng, "_now", lambda: fake.NOW):
            good = fng.build()
            path = os.path.join(tmp, fng.SAVED)
            self.assertEqual(fng._file_load(), good)
            with open(path, "rb") as f:
                body = f.read()
            with open(path, "wb") as f:
                f.write(b" " * fng.HIST_MAX + body)
            self.assertIsNone(fng._file_load())


if __name__ == "__main__":
    unittest.main()
