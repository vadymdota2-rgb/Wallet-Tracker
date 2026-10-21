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
import tempfile
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


DAY = 86_400
T0 = 1_700_006_400  # 15 ноября 2023 г.


def hist(n: int = 400, start: int = T0, eth_from: int = 0) -> dict:
    """Как отвечает global-metrics/quotes/historical с aux=btc_dominance,eth_dominance."""
    return {"data": {"quotes": [
        {"timestamp": time.strftime("%Y-%m-%dT00:00:00.000Z", time.gmtime(start + i * DAY)),
         "quote": {"USD": {"total_market_cap": 1e12 + i * 1e9}},
         "btc_dominance": 50 + i / 100, "eth_dominance": 15.0 if i >= eth_from else 0}
        for i in range(n)]}}


class Net:
    def __init__(self, g=None, u=None, h=None):
        self.g, self.u, self.h = glob() if g is None else g, usdt() if u is None else u, hist() if h is None else h
        self.calls = []

    def __call__(self, url, timeout=20, limit=0):
        self.calls.append(url)
        return json.dumps(self.h if "historical" in url else self.g if "global-metrics" in url else self.u).encode()


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
        self.assertEqual(len(net.calls), 3)
        self.assertIs(mc.mcap_data(), res)
        self.assertEqual(len(res["hist"]), 400)

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
        with mock.patch.object(mc, "_fetch", lambda url, timeout=20, limit=0: None):
            self.assertEqual(mc.build(), {"ok": False, "error": "no_data"})
        with mock.patch.object(mc.threading, "Thread") as th:
            self.assertIs(mc.mcap_data(), old)
        th.assert_not_called()


class HistoryTest(Base):
    NOW = T0 + 1200 * DAY

    def test_rows_eth_before_2020_and_weekly_thinning(self):
        rows = mc.history(hist(1200, eth_from=100), self.NOW)
        last = T0 + 1199 * DAY
        # Последние HIST_DAILY дней — каждый день, раньше — раз в неделю.
        daily = [r for r in rows if r[0] > last - mc.HIST_DAILY * DAY]
        self.assertEqual(len(daily), mc.HIST_DAILY)
        old = [r for r in rows if r[0] <= last - mc.HIST_DAILY * DAY]
        self.assertTrue(old and all((r[0] // DAY) % 7 == 0 for r in old))
        self.assertEqual(rows[-1], [last, 1e12 + 1199e9, 61.99, 15.0])
        # Доля эфира 0 (до октября 2020 г. её нет) — это «нет данных», а не ноль.
        first = mc.history(hist(5, eth_from=3), self.NOW)
        self.assertEqual([r[3] for r in first], [None, None, None, 15.0, 15.0])

    def test_bad_days_are_skipped_and_garbage_is_none(self):
        h = hist(10)
        q = h["data"]["quotes"]
        q[1]["btc_dominance"] = 101
        q[2]["quote"]["USD"]["total_market_cap"] = "1e12"
        q[3]["timestamp"] = "вчера"
        q[4]["timestamp"] = "2099-01-01T00:00:00.000Z"
        q[5]["eth_dominance"] = 60  # BTC 50 + ETH 60 > 100 — ETH-доли нет, день есть
        q.append("x")
        rows = mc.history(h, self.NOW)
        self.assertEqual([r[0] for r in rows], [T0 + i * DAY for i in (0, 5, 6, 7, 8, 9)])
        self.assertIsNone(rows[1][3])
        for bad in (None, [], {}, {"data": {"quotes": "x"}}, {"data": {"quotes": [q[0]]}},
                    {"data": {"quotes": [q[0]] * (mc.HIST_MAX + 1)}}):
            self.assertIsNone(mc.history(bad, self.NOW), str(bad)[:60])

    def test_history_is_asked_twice_a_day_and_kept_on_disk(self):
        tmp = tempfile.mkdtemp()
        mc.set_cache_dir(tmp)
        net = Net()
        with mock.patch.object(mc, "_fetch", net):
            first = mc.build()
            mc.build()
        self.assertEqual(sum("historical" in u for u in net.calls), 1)
        # Конец истории — сегодня: без него CoinMarketCap отдаёт лишь 10 дней.
        url = next(u for u in net.calls if "historical" in u)
        self.assertIn("time_start=2013-04-28", url)
        self.assertIn("time_end=" + time.strftime("%Y-%m-%d", time.gmtime()), url)
        # Перезапуск: история — с диска, без запроса.
        mc._st = mc._State()
        mc.set_cache_dir(tmp)
        net.calls.clear()
        with mock.patch.object(mc, "_fetch", net):
            again = mc.build()
        self.assertFalse([u for u in net.calls if "historical" in u])
        self.assertEqual(again["hist"], first["hist"])
        # Прошло больше HIST_TTL — спрашиваем снова; сеть молчит — прошлая история.
        mc._st.hist = (time.time() - mc.HIST_TTL - 1, first["hist"])

        def silent(url, timeout=20, limit=0):
            return None if "historical" in url else net(url, timeout, limit)
        with mock.patch.object(mc, "_fetch", silent):
            self.assertEqual(mc.build()["hist"], first["hist"])

    def test_poisoned_disk_copy_is_ignored(self):
        tmp = tempfile.mkdtemp()
        mc.set_cache_dir(tmp)
        path = os.path.join(tmp, "mcap_hist.json")
        good = [[T0, 1e12, 50.0, None], [T0 + DAY, 1e12, 50.0, 15.0]]
        for body in ("garbage", "[1]", json.dumps({"at": time.time(), "v": [[T0 + DAY, 1e12, 50, None], [T0, 1e12, 50, None]]}),
                     json.dumps({"at": time.time(), "v": [[T0, 1e12, 500, None], [T0 + DAY, 1e12, 50, None]]}),
                     json.dumps({"at": time.time(), "v": [[T0 + 5, 1e12, 50, None], [T0 + DAY, 1e12, 50, None]]}),
                     json.dumps({"at": "x", "v": good})):
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            self.assertIsNone(mc._hist_load(), body[:60])
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"at": time.time(), "v": good}, f)
        self.assertEqual(mc._hist_load()[1], good)


class BudgetTest(Base):
    """Бесплатный план — 15 000 кредитов в месяц: ни при каком сбое модуль не
    тратит больше DAY_BUDGET в сутки, а перезапуск не тратит ничего лишнего."""

    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp()
        mc.set_cache_dir(self.tmp)

    def test_normal_month_fits_with_room(self):
        month = 31 * 24 * 3600
        normal = 2 * month / mc.TTL + mc.COST_HIST * month / mc.HIST_TTL
        self.assertLess(normal, 6000)
        self.assertLessEqual(mc.DAY_BUDGET * 31, 15_000 * 0.85)

    def test_credits_are_counted_from_the_answer_and_stop_at_the_budget(self):
        calls = []

        def broken(url, timeout=20, limit=0):
            # CoinMarketCap ответил, но формат сменился: кредиты списаны, ответа нет.
            calls.append(url)
            return json.dumps({"status": {"credit_count": 7}, "data": {"x": 1}}).encode()
        with mock.patch.object(mc, "_fetch", broken):
            for _ in range(500):
                mc._st.fail = None
                mc.build()
        # Запрос дороже ожидаемого может перешагнуть порог — но только один.
        self.assertLessEqual(len(calls) * 7, mc.DAY_BUDGET + 7)
        self.assertGreaterEqual(len(calls) * 7, mc.DAY_BUDGET - 7)
        # Счётчик — на диске: перезапуск не начинает день заново.
        mc._st = mc._State()
        mc.set_cache_dir(self.tmp)
        calls.clear()
        with mock.patch.object(mc, "_fetch", broken):
            mc.build()
        self.assertEqual(calls, [])

    def test_no_answer_costs_nothing(self):
        with mock.patch.object(mc, "_fetch", lambda url, timeout=20, limit=0: None):
            for _ in range(50):
                mc._st.fail = None
                mc.build()
        self.assertEqual(mc._st.spent, {mc._today(): 0})

    def test_failed_history_waits_before_asking_again(self):
        net = Net(h={"data": {"quotes": "сломано"}, "status": {"credit_count": 50}})
        with mock.patch.object(mc, "_fetch", net):
            for _ in range(5):
                mc._st.hit = None
                mc.build()
        self.assertEqual(sum("historical" in u for u in net.calls), 1)
        mc._st.hist_try -= mc.HIST_RETRY + 1
        with mock.patch.object(mc, "_fetch", net):
            mc.build()
        self.assertEqual(sum("historical" in u for u in net.calls), 2)

    def test_restart_serves_the_disk_copy_without_network(self):
        net = Net()
        with mock.patch.object(mc, "_fetch", net):
            first = mc.build()
        mc._st = mc._State()
        mc.set_cache_dir(self.tmp)
        with mock.patch.object(mc, "_fetch", net), mock.patch.object(mc.threading, "Thread") as th:
            net.calls.clear()
            got = mc.mcap_data()
        th.assert_not_called()
        self.assertEqual(net.calls, [])
        self.assertEqual(got["btc"], first["btc"])
        self.assertEqual(got["hist"], first["hist"])
        # Копия старше TTL — отдаётся сразу, свежая собирается в фоне.
        with open(os.path.join(self.tmp, "mcap.json"), encoding="utf-8") as f:
            saved = json.load(f)
        saved["at"] -= int(mc.TTL) + 60
        with open(os.path.join(self.tmp, "mcap.json"), "w", encoding="utf-8") as f:
            json.dump(saved, f)
        mc._st = mc._State()
        mc.set_cache_dir(self.tmp)
        with mock.patch.object(mc.threading, "Thread") as th:
            self.assertEqual(mc.mcap_data()["cap"], first["cap"])
        th.return_value.start.assert_called_once()

    def test_poisoned_copies_are_ignored(self):
        for name, body in (("mcap.json", '{"ok": true, "btc": [500, null], "eth": [1, null], "alt": [1, null], "cap": [1e12, null], "at": 1}'),
                           ("mcap.json", "garbage"), ("mcap_spent.json", json.dumps({mc._today(): -5})),
                           ("mcap_spent.json", json.dumps({mc._today(): True}))):
            with open(os.path.join(self.tmp, name), "w", encoding="utf-8") as f:
                f.write(body)
            mc._st = mc._State()
            mc.set_cache_dir(self.tmp)
            self.assertIsNone(mc._last_load(), body)
            with mc._lock:
                self.assertEqual(mc._spent(), {mc._today(): 0}, body)


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
                                     "time", "urllib.error", "urllib.parse", "urllib.request", "typing", "datetime"})
        bad = [n.func.id for n in ast.walk(self.tree()) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in {"eval", "exec", "compile", "__import__", "setattr"}]
        self.assertEqual(bad, [])
        # Файлы — только копия истории на диске.
        where = {fn.name for fn in ast.walk(self.tree()) if isinstance(fn, ast.FunctionDef)
                 for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "open"}
        self.assertEqual(where, {"_file_load", "_file_save"})
        # Ключ CoinMarketCap на диск не пишется.
        saves = [n for n in ast.walk(self.tree()) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_file_save"]
        self.assertTrue(saves)
        self.assertNotIn("_key", "".join(ast.unparse(n) for n in saves))

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
        # Два запроса по кредиту раз в час и история (~50 кредитов) раз в
        # HIST_TTL — меньше трети из 15 000 бесплатных в месяц.
        month = 31 * 24 * 3600
        self.assertLess(2 * month / mc.TTL + 50 * month / mc.HIST_TTL, 5000)

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
