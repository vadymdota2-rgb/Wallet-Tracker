"""Правила кода карты ликвидаций — «что модулю можно» (npm test).

Как у халвинга и «Страха и жадности»: если кто-то — человек или ИИ-агент —
впишет в модуль опасное (eval, процессы, файлы, новый адрес в сети, вставку
HTML) или разведёт сервер и приложение (окна, ответы-ошибки, пределы ответа),
тест упадёт. Сервер проверяется по дереву разбора Python (AST), а не поиском
текста.

Модуль — два места: модель и кэш (wt_liqmap.py, без сети вовсе) и источники
бирж в whale_api.py (функции _liq_* и _snap_*).
"""
import ast
import inspect
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_liqmap as lm  # noqa: E402

MODEL = os.path.join(ROOT, "wt_liqmap.py")
SERVER = os.path.join(ROOT, "whale_api.py")
IMPORTS = {"__future__", "bisect", "re", "threading", "time", "collections.abc", "typing"}
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "input", "breakpoint", "globals", "locals", "vars",
                "open", "setattr", "delattr", "getattr"}
# Источники ходят в сеть только через общие двери сервера.
DOORS = {"get_json", "hl_post"}
SIDE_DOORS = {"urlopen", "urlretrieve", "Request", "build_opener", "create_connection", "socket", "getaddrinfo",
              "system", "popen", "Popen", "run", "call", "check_output", "check_call", "spawn", "fork", "remove",
              "unlink", "rmtree", "rename", "replace", "connect"}
# Функции источников, которым можно в свою базу (копилка дней и снимки интереса).
DB_FUNCS = {"_liq_oi_ro", "_liq_oi_con"}
HOSTS = {
    "api-futures.kucoin.com", "api-pub.bitfinex.com", "api.backpack.exchange", "api.bitget.com", "api.bybit.com",
    "api.coinex.com", "api.crypto.com", "api.exchange.bullish.com", "api.gateio.ws", "api.hbdm.com",
    "api.international.coinbase.com", "api.orderly.org", "api.phemex.com", "api.prod.paradex.trade", "api.woox.io",
    "arbitrum-api.gmxinfra.io", "contract.mexc.com", "dapi.binance.com", "fapi.asterdex.com", "fapi.binance.com",
    "fapi.xt.com", "futures.kraken.com", "indexer.dydx.trade", "mainnet.zklighter.elliot.ai", "open-api.bingx.com",
    "openapi.blofin.com", "pro.apex.exchange", "whitebit.com", "www.bitmex.com", "www.bitstamp.net",
    "www.deribit.com", "www.okx.com",
    # Delta Exchange — адрес собирается из имени хоста (_snap_delta).
    "api.delta.exchange", "api.india.delta.exchange",
}
CLIENT = ["src/lib/liqmap.ts", "src/screens/LiqMapScreen.tsx"]
CLIENT_BANNED = [r"innerHTML", r"outerHTML", r"dangerouslySetInnerHTML", r"insertAdjacentHTML", r"document\.write",
                 r"\beval\s*\(", r"new\s+Function\b", r"\bfetch\s*\(", r"XMLHttpRequest", r"WebSocket", r"\bimport\s*\(",
                 r"window\.open", r"\blocation\b", r"postMessage", r"sessionStorage",
                 r"setTimeout\(\s*['\"`]", r"setInterval\(\s*['\"`]"]


def tree(path: str) -> ast.Module:
    with open(path, encoding="utf-8") as f:
        return ast.parse(f.read())


def source_funcs() -> list[ast.FunctionDef]:
    """Функции источников карты в сервере: _liq_* и _snap_* верхнего уровня."""
    return [n for n in tree(SERVER).body if isinstance(n, ast.FunctionDef) and re.match(r"_(liq|snap)_", n.name)]


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", src)


def read(path: str) -> str:
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


class ModelPolicyTest(unittest.TestCase):
    """wt_liqmap.py — только расчёт и кэш: ни сети, ни файлов, ни процессов."""

    def test_imports_are_on_the_list(self):
        found = set()
        for n in ast.walk(tree(MODEL)):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, IMPORTS, f"новый импорт: {found - IMPORTS}")

    def test_no_dangerous_builtins(self):
        bad = [(n.lineno, n.func.id) for n in ast.walk(tree(MODEL))
               if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in BANNED_CALLS]
        self.assertEqual(bad, [])

    def test_no_addresses_at_all(self):
        # Ряды и цену модулю дают set_gather и set_price — своих адресов нет.
        urls = [n.value for n in ast.walk(tree(MODEL))
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and "://" in n.value]
        self.assertEqual(urls, [])

    def test_reply_errors_are_ours(self):
        lits = {n.args[0].value for n in ast.walk(tree(MODEL))
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_no"
                and n.args and isinstance(n.args[0], ast.Constant)}
        # «building if … else no_data if … else busy» — одна строка с тремя ответами.
        for n in ast.walk(tree(MODEL)):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_no" and n.args \
                    and isinstance(n.args[0], ast.IfExp):
                lits |= {c.value for c in ast.walk(n.args[0]) if isinstance(c, ast.Constant) and isinstance(c.value, str)}
        self.assertEqual(lits, {"no_data", "bad_args", "building", "busy"})

    def test_endpoint_takes_only_symbol_window_and_wait(self):
        params = inspect.signature(lm.liq_map).parameters
        self.assertEqual(list(params), ["sym", "rng", "wait"])
        self.assertEqual(params["wait"].default, lm.COLD_WAIT)
        self.assertEqual(lm.SYM.pattern, "[A-Z0-9]{1,12}")


class SourcesPolicyTest(unittest.TestCase):
    """Источники карты в whale_api.py: сеть — только через get_json/hl_post,
    адреса — https к известным биржам, файлы — только своя база."""

    def test_sources_exist(self):
        names = {f.name for f in source_funcs()}
        for _, fn in api.LIQ_SNAPS:
            if fn.__name__ != "<lambda>":
                self.assertIn(fn.__name__, names)
        self.assertGreaterEqual(len(api.LIQ_SNAPS), 28)
        self.assertGreaterEqual(len(api.LIQ_SOURCES), 7)

    def test_every_address_is_https_to_a_known_exchange(self):
        found: set[str] = set()
        for fn in source_funcs():
            for n in ast.walk(fn):
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and "://" in n.value:
                    m = re.match(r"([a-z]+)://([^/?{]*)", n.value)
                    if m is None:
                        self.fail(n.value)
                    self.assertEqual(m.group(1), "https", f"{fn.name}: {n.value}")
                    if m.group(2):
                        found.add(m.group(2))
                    else:  # адрес из подстановки — только у Delta, хост из списка
                        self.assertEqual(fn.name, "_snap_delta")
        self.assertLessEqual(found, HOSTS, f"новый адрес: {found - HOSTS}")
        delta = [c for c in ast.walk(tree(SERVER)) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                 and c.func.id == "_snap_delta"]
        self.assertEqual({c.args[0].value for c in delta if isinstance(c.args[0], ast.Constant)},
                         {"api.delta.exchange", "api.india.delta.exchange"})
        self.assertEqual(len(delta), 2)

    def test_network_goes_through_the_doors(self):
        side = []
        doors = set()
        for fn in source_funcs():
            for n in ast.walk(fn):
                if not isinstance(n, ast.Call):
                    continue
                name = n.func.id if isinstance(n.func, ast.Name) else n.func.attr if isinstance(n.func, ast.Attribute) else ""
                if name in DOORS:
                    doors.add(name)
                if name in SIDE_DOORS and not (name == "connect" and fn.name in DB_FUNCS):
                    side.append((fn.name, ast.unparse(n.func)))
                if isinstance(n.func, ast.Name) and n.func.id in BANNED_CALLS:
                    side.append((fn.name, n.func.id))
        self.assertEqual(side, [])
        self.assertEqual(doors, DOORS)

    def test_database_opens_read_only_for_readers(self):
        # Писать в копилку и снимки — только служба сбора; запросы карты — читатели.
        body = inspect.getsource(api._liq_oi_ro)
        self.assertIn("mode=ro", body)
        self.assertIn("uri=True", body)

    def test_market_names_are_checked_before_the_address(self):
        # Имя рынка из ответа биржи ложится в адрес следующего запроса.
        for bad in ("../x", "BTC?x=1", "BTC#", "BTC USDT", "", "A" * 41, None, 5, "BTC/USDT", "BTC%2F"):
            self.assertFalse(api._snap_mkt(bad), bad)
        for ok in ("BTCUSDT", "BTC-USDC-PERP", "btc_usdt", "PF_XBTUSD"):
            self.assertTrue(api._snap_mkt(ok), ok)
        self.assertIn("_snap_mkt(got[1])", inspect.getsource(api._snap_top))
        self.assertIn('_snap_mkt(m.get("symbol"))', inspect.getsource(api._snap_bullish))

    def test_sql_takes_values_only_as_parameters(self):
        # SQL источников — строки-константы; всё пришедшее снаружи — через «?».
        for fn in source_funcs():
            for n in ast.walk(fn):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("execute", "executemany") \
                        and n.args:
                    self.assertIsInstance(n.args[0], ast.Constant, f"{fn.name}: {ast.unparse(n.args[0])[:80]}")


class ContractTest(unittest.TestCase):
    """Сервер и приложение говорят на одном языке: окна, ошибки, пределы."""

    def setUp(self):
        self.ts = strip_comments(read("src/lib/liqmap.ts"))

    def const(self, name: str) -> str:
        m = re.search(rf"export const {name} = ([^;]+);", self.ts)
        if m is None:
            self.fail(name)
        return m.group(1)

    def test_windows_match(self):
        got = re.findall(r'"(\w+)"', self.const("LIQ_RANGES"))
        self.assertEqual(got, list(lm.RANGES))

    def test_errors_match(self):
        got = set(re.findall(r'"(\w+)"', self.const("LIQ_ERRORS")))
        self.assertEqual(got, {"no_data", "building", "busy", "bad_args"})

    def test_limits_hold_the_server_reply(self):
        num = lambda k: int(self.const(k).replace("_", ""))  # noqa: E731 — короткий разбор числа
        self.assertGreaterEqual(num("BUCKETS_MAX"), lm.BUCKETS)
        self.assertGreaterEqual(num("LEVS_MAX"), len(lm.GROUPS))
        self.assertGreaterEqual(num("OHLC_MAX"), 48)
        self.assertGreaterEqual(num("PATH_MAX"), 121)
        self.assertIn('/^[A-Z0-9]{1,12}$/', self.ts)

    def test_server_reply_fits_the_limits(self):
        rows = [(1_700_000_000 + i * 3600, 101.0, 99.0, 100.0 + (i % 7), 1e9 + i * 1e6, 0.5) for i in range(lm.RANGES["7d"][1])]
        res = lm.build_map("BTC", "7d", {"Binance": rows}, rows, 1_700_700_000)
        self.assertTrue(res["ok"])
        self.assertLessEqual(len(res["buckets"]), lm.BUCKETS)
        self.assertLessEqual(len(res["path"]), 121)
        self.assertLessEqual(len(res["ohlc"]), 48)
        self.assertEqual(res["levs"], list(lm.GROUPS))


class ClientPolicyTest(unittest.TestCase):
    def test_no_html_injection_eval_or_side_network(self):
        for path in CLIENT:
            code = strip_comments(read(path))
            for pat in CLIENT_BANNED:
                self.assertIsNone(re.search(pat, code), f"{path}: {pat}")

    def test_calculation_is_pure(self):
        code = strip_comments(read("src/lib/liqmap.ts"))
        imports = re.findall(r"^\s*import\b[^\n]*", code, re.M)
        self.assertEqual([i.strip() for i in imports], ['import type { LiqBucket, LiqMapReply } from "./types";'])
        self.assertIsNone(re.search(r"\brequire\s*\(", code))

    def test_reply_is_checked_before_use(self):
        # Ответ сервера и сохранённая копия — только через validLiqMap.
        api_ts = strip_comments(read("src/lib/api.ts"))
        fetch = api_ts[api_ts.index("export const fetchLiqMap"):]
        self.assertIn("validLiqMap", fetch[:fetch.index(";\n")])
        saved = api_ts[api_ts.index("export function savedLiqMap"):]
        self.assertIn("validLiqMap(raw.v)", saved[:saved.index("\n}\n")])
        screen = strip_comments(read("src/screens/LiqMapScreen.tsx"))
        self.assertNotIn("JSON.parse", screen)
