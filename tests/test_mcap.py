"""Доминация (wt_mcap): расчёт, ключ, сборка, защита и правила кода — npm test.

Сеть подменена: CoinMarketCap отвечает из словарей теста.
"""
import ast
import inspect
import io
import json
import os
import re
import sys
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_mcap as mc  # noqa: E402 — модуль лежит в корне репозитория

KEY = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"
LOG = mc._log


def glob(**over) -> dict:
    data = {"btc_dominance": 57.49, "eth_dominance": 11.2, "btc_dominance_yesterday": 57.21,
            "eth_dominance_yesterday": 11.4,
            "quote": {"USD": {"total_market_cap": 2.85e12, "total_market_cap_yesterday": 2.9e12,
                              "stablecoin_market_cap": 2.6e11}}}
    data.update(over)
    return {"status": {"error_code": 0}, "data": data}


def usdt(cap: float = 1.8e11, symbol: str = "USDT") -> dict:
    """Как отвечает /v3/cryptocurrency/quotes/latest?id=825."""
    return {"data": [{"id": 825, "symbol": symbol, "quote": [{"id": 2781, "symbol": "USD", "market_cap": cap}]}]}


class Net:
    def __init__(self, g=None, u=None):
        self.g, self.u, self.calls = glob() if g is None else g, usdt() if u is None else u, []

    def __call__(self, url, timeout=20):
        self.calls.append(url)
        return json.dumps(self.g if "global-metrics" in url else self.u).encode()


class Base(unittest.TestCase):
    def setUp(self):
        mc._st = mc._State()
        mc._busy.clear()
        for p in (mock.patch.dict(os.environ, {"CMC_API_KEY": KEY}), mock.patch.object(mc, "_log", lambda m: None)):
            p.start()
            self.addCleanup(p.stop)


class ComputeTest(unittest.TestCase):
    def test_shares(self):
        got = mc.compute(glob(), usdt())
        self.assertEqual(got["btc"], [57.49, 57.21])
        self.assertEqual(got["eth"], [11.2, 11.4])
        self.assertEqual(got["alt"], [42.51, 42.79])
        # Альты без стейблкоинов: 100 − BTC − доля стейблкоинов (2,6e11 / 2,85e12 = 9,12%).
        self.assertEqual(got["alt_ns"], round(100 - 57.49 - 2.6e11 / 2.85e12 * 100, 2))
        self.assertEqual(got["usdt"], round(1.8e11 / 2.85e12 * 100, 2))
        self.assertEqual(got["cap"], [2_850_000_000_000, 2_900_000_000_000])

    def test_no_yesterday_and_no_usdt_are_fine(self):
        g = glob(btc_dominance_yesterday=None, eth_dominance_yesterday="x")
        del g["data"]["quote"]["USD"]["stablecoin_market_cap"]
        got = mc.compute(g, None)
        self.assertEqual(got["btc"], [57.49, None])
        self.assertEqual(got["alt"], [42.51, None])
        self.assertIsNone(got["alt_ns"])
        self.assertIsNone(got["usdt"])
        # Чужая монета под id 825 — не USDT.
        self.assertIsNone(mc.compute(glob(), usdt(symbol="XYZ"))["usdt"])
        # Ответ прежнего формата (v2, словарь по id) и мусор — доли USDT нет, остальное есть.
        for bad in ({"data": {"825": {"id": 825, "symbol": "USDT", "quote": {"USD": {"market_cap": 1.8e11}}}}},
                    {"data": [{"id": 825, "symbol": "USDT", "quote": [{"symbol": "EUR", "market_cap": 1.8e11}]}]},
                    {"data": [{"id": 825, "symbol": "USDT", "quote": "x"}]}, {"data": ["x", None]}, {"data": "x"}):
            got = mc.compute(glob(), bad)
            self.assertIsNone(got["usdt"], str(bad)[:60])
            self.assertEqual(got["btc"][0], 57.49)

    def test_implausible_numbers_are_rejected(self):
        for bad in (glob(btc_dominance=0), glob(btc_dominance=101), glob(btc_dominance="57"), glob(btc_dominance=True),
                    glob(btc_dominance=80, eth_dominance=30), glob(quote={"USD": {"total_market_cap": 5}}),
                    glob(quote={"USD": {"total_market_cap": 1e20}}), {}, [], None, {"data": "x"}):
            self.assertIsNone(mc.compute(bad, usdt()), str(bad)[:80])
        # USDT дороже всего рынка — сбой, доли USDT нет.
        self.assertIsNone(mc.compute(glob(), usdt(cap=1e13))["usdt"])
        # Стейблкоинов больше, чем всех альтов, — сбой, этой строки нет.
        g = glob()
        g["data"]["quote"]["USD"]["stablecoin_market_cap"] = 2.0e12
        self.assertIsNone(mc.compute(g, usdt())["alt_ns"])


class BuildTest(Base):
    def test_build_and_cache(self):
        net = Net()
        with mock.patch.object(mc, "_fetch", net):
            res = mc.build()
        self.assertTrue(res["ok"])
        self.assertEqual(res["by"], "CoinMarketCap")
        self.assertEqual(len(net.calls), 2)
        self.assertIs(mc.mcap_data(), res)

    def test_no_key_is_said_and_nothing_is_asked(self):
        with mock.patch.dict(os.environ, {"CMC_API_KEY": ""}), mock.patch.object(mc._opener, "open") as op:
            self.assertEqual(mc.mcap_data(), {"ok": False, "error": "no_key"})
            self.assertEqual(mc.build(), {"ok": False, "error": "no_key"})
        op.assert_not_called()
        for junk in ("short", "a b c d e f g h", "k" * 200, "ключ-ключ-ключ"):
            with mock.patch.dict(os.environ, {"CMC_API_KEY": junk}):
                self.assertEqual(mc._key(), "", junk)

    def test_cold_start_builds_once_in_background(self):
        started = []
        with mock.patch.object(mc.threading, "Thread") as th:
            th.return_value.start.side_effect = lambda: started.append(1)
            self.assertEqual(mc.mcap_data(), {"ok": False, "error": "no_data"})
            mc.mcap_data()
        self.assertEqual(len(started), 1)

    def test_failure_rests_and_keeps_old_answer(self):
        with mock.patch.object(mc, "_fetch", Net()):
            old = mc.build()
        mc._st.hit = (time.monotonic() - mc.TTL - 1, old)
        with mock.patch.object(mc, "_fetch", lambda url, timeout=20: None):
            self.assertEqual(mc.build(), {"ok": False, "error": "no_data"})
        with mock.patch.object(mc.threading, "Thread") as th:
            self.assertIs(mc.mcap_data(), old)
        th.assert_not_called()


class SecurityTest(Base):
    def test_key_goes_only_to_coinmarketcap_over_https(self):
        with mock.patch.object(mc._opener, "open") as op:
            for url in ("https://pro-api.coinmarketcap.com.evil.com/v1", "http://pro-api.coinmarketcap.com/v1",
                        "https://user:pw@pro-api.coinmarketcap.com/v1", "https://coinmarketcap.com/", "file:///etc/passwd"):
                self.assertIsNone(mc._fetch(url), url)
            op.assert_not_called()
        seen = []

        def opener(req, timeout):
            seen.append(req)
            raise OSError("down")
        with mock.patch.object(mc._opener, "open", opener):
            mc._fetch(mc.GLOBAL)
        self.assertEqual(seen[0].get_header("X-cmc_pro_api_key"), KEY)
        self.assertEqual(seen[0].full_url, "https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest")
        self.assertEqual(mc.USDT, "https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest?id=825")

    def test_key_never_reaches_the_log_or_the_answer(self):
        err = mc.urllib.error.HTTPError(mc.GLOBAL, 401, f"bad key {KEY}", {}, None)  # type: ignore[arg-type]
        logs = []
        with mock.patch.object(mc, "_log", logs.append), mock.patch.object(mc._opener, "open", side_effect=err):
            self.assertIsNone(mc._fetch(mc.GLOBAL))
        self.assertEqual(logs, ["HTTP 401"])
        with mock.patch.object(mc, "_fetch", Net()):
            res = mc.build()
        self.assertNotIn(KEY, json.dumps(res))
        # Сам журнал: печатное, короткое, с приставкой модуля.
        buf = io.StringIO()
        with mock.patch("sys.stderr", buf):
            LOG("a\x1bb" + "x" * 1000)
        self.assertTrue(buf.getvalue().startswith("mcap: a?b"))
        self.assertLess(len(buf.getvalue()), 320)

    def test_body_limit_and_hostile_json(self):
        big = mock.MagicMock()
        big.__enter__.return_value.read.return_value = b"x" * (mc.BODY_MAX + 1)
        with mock.patch.object(mc._opener, "open", return_value=big):
            self.assertIsNone(mc._fetch(mc.GLOBAL))
        for raw in (b"[" * 100_000, b'{"v": NaN}', b"[1e999]", b"[1" + b"0" * 400 + b"]", b"\xff\xfe", b""):
            self.assertIsNone(mc._parse(raw), raw[:20])

    def test_hostile_answers_are_no_data_not_a_crash(self):
        for g in ([], {}, "x", {"data": []}, {"data": {"quote": "x"}}, glob(btc_dominance=-5)):
            with mock.patch.object(mc, "_fetch", Net(g=g)):
                self.assertEqual(mc.build(), {"ok": False, "error": "no_data"}, str(g)[:60])


class PolicyTest(unittest.TestCase):
    """Что модулю можно: как у wt_dom — по дереву разбора, а не поиском текста."""

    def tree(self) -> ast.Module:
        with open(os.path.join(ROOT, "wt_mcap.py"), encoding="utf-8") as f:
            return ast.parse(f.read())

    def test_imports_and_builtins(self):
        found = set()
        for n in ast.walk(self.tree()):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, {"__future__", "contextlib", "http.client", "json", "math", "os", "sys", "threading",
                                     "time", "urllib.error", "urllib.parse", "urllib.request", "typing"})
        bad = [n.func.id for n in ast.walk(self.tree()) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in {"eval", "exec", "compile", "__import__", "open", "setattr"}]
        self.assertEqual(bad, [])

    def test_only_the_official_api(self):
        urls = [n.value for n in ast.walk(self.tree())
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and re.match(r"(?i)[a-z][a-z0-9+.-]*://", n.value)]
        self.assertEqual(urls, ["https://pro-api.coinmarketcap.com"])
        self.assertEqual(mc.HOSTS, frozenset({"pro-api.coinmarketcap.com"}))
        # Ключ — только из окружения: в коде нет строки, похожей на ключ.
        consts = [n.value for n in ast.walk(self.tree()) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        self.assertFalse([c for c in consts if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", c)])
        self.assertTrue(any(isinstance(h, mc._NoRedirect) for h in mc._opener.handlers))

    def test_endpoint_takes_nothing_and_credits_are_few(self):
        self.assertEqual(inspect.signature(mc.mcap_data).parameters, {})
        # Два запроса по кредиту раз в час — меньше 1500 в месяц из 15 000 бесплатных.
        self.assertLess(2 * 24 * 31 * 3600 / mc.TTL, 1500)

    def test_app_side(self):
        with open(os.path.join(ROOT, "src/lib/api.ts"), encoding="utf-8") as f:
            api = f.read()
        part = api[api.index("export const fetchMcap"):api.index("export const peekMcap")]
        self.assertLess(part.index("const v = validMcap(r);"), part.index("writeSaved(MCAP_SAVED"))
        with open(os.path.join(ROOT, "src/lib/dom.ts"), encoding="utf-8") as f:
            self.assertIn("export const MCAP_TTL_MS = 60 * 60_000;", f.read())
        self.assertEqual(mc.TTL, 3600.0)


if __name__ == "__main__":
    unittest.main()
