"""Правила кода «Альтсезона» — что модулю можно (npm test).

Как у халвинга и ETF: защита, которая не зависит от внимательности
ревьюера. Если кто-то — человек или ИИ-агент — впишет в модуль опасное
(eval, запуск процессов, новый адрес в сети, вернёт CoinMarketCap или
Binance, зависимость от бота или базы, вставку HTML, сетевой запрос мимо
api.ts), тест упадёт, и в main это не попадёт. Сервер проверяется по дереву
разбора Python (AST), а не поиском текста.
"""
import ast
import importlib
import inspect
import os
import re
import sys
import unittest
import unittest.mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_dom as dom  # noqa: E402 — модуль лежит в корне репозитория

SERVER = os.path.join(ROOT, "wt_dom.py")
# Только стандартная библиотека: ни базы, ни бота, ни whale_api.
IMPORTS = {"__future__", "contextlib", "http.client", "json", "math", "os", "re", "sys", "threading", "time",
           "urllib.parse", "urllib.request", "typing"}
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "input", "breakpoint", "globals", "locals", "vars",
                "setattr", "delattr"}
FILE_FUNCS = {"_file_load", "_file_save"}
CLIENT = ["src/lib/dom.ts", "src/screens/DominanceScreen.tsx"]
CLIENT_BANNED = [r"innerHTML", r"outerHTML", r"dangerouslySetInnerHTML", r"insertAdjacentHTML", r"document\.write",
                 r"\beval\s*\(", r"new\s+Function\b", r"\bfetch\s*\(", r"XMLHttpRequest", r"WebSocket", r"\bimport\s*\(",
                 r"window\.open", r"\blocation\b", r"postMessage", r"setTimeout\(\s*['\"`]", r"setInterval\(\s*['\"`]",
                 r"https?://"]


def server_tree() -> ast.Module:
    with open(SERVER, encoding="utf-8") as f:
        return ast.parse(f.read())


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", src)


def code_only(src: str) -> str:
    """Python без строк документации и комментариев."""
    return re.sub(r'"""[\s\S]*?"""|#[^\n]*', "", src)


def read(path: str) -> str:
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


class ServerPolicyTest(unittest.TestCase):
    def test_imports_are_on_the_list(self):
        found = set()
        for n in ast.walk(server_tree()):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, IMPORTS, f"новый импорт: {found - IMPORTS}")

    def test_no_dangerous_builtins(self):
        bad = [(n.lineno, n.func.id) for n in ast.walk(server_tree())
               if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in BANNED_CALLS]
        self.assertEqual(bad, [])

    def test_files_only_for_the_disk_copy(self):
        where = []
        for fn in ast.walk(server_tree()):
            if isinstance(fn, ast.FunctionDef):
                for n in ast.walk(fn):
                    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "open":
                        where.append(fn.name)
        self.assertTrue(where)
        self.assertLessEqual(set(where), FILE_FUNCS)

    def test_network_goes_through_one_door(self):
        calls = []
        for fn in ast.walk(server_tree()):
            if isinstance(fn, ast.FunctionDef):
                for n in ast.walk(fn):
                    if isinstance(n, ast.Attribute) and n.attr in ("open", "urlopen", "urlretrieve", "create_connection",
                                                                   "socket", "getaddrinfo"):
                        calls.append((fn.name, n.attr))
        self.assertEqual(calls, [("_fetch", "open")])
        body = inspect.getsource(dom._fetch)
        self.assertLess(body.index("if not _allowed(url):"), body.index("_opener.open("))

    def test_only_hyperliquid(self):
        urls = [n.value for n in ast.walk(server_tree())
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and re.match(r"(?i)[a-z][a-z0-9+.-]*://", n.value)]
        self.assertEqual(urls, ["https://api.hyperliquid.xyz/info"])
        self.assertTrue(dom._allowed(urls[0]))
        self.assertEqual(dom.HOSTS, frozenset({"api.hyperliquid.xyz"}))
        # Ни прежних источников, ни других агрегаторов — их условия запрещают
        # такое использование без согласия.
        code = code_only(read("wt_dom.py")).lower()
        for word in ("coinmarketcap", "coingecko", "binance", "llama", "coinbase", "cryptocompare", "messari"):
            self.assertNotIn(word, code, word)

    def test_endpoint_takes_nothing_from_outside(self):
        self.assertEqual(inspect.signature(dom.dom_data).parameters, {})
        self.assertEqual(list(inspect.signature(dom.build).parameters), ["sleep"])

    def test_opener_is_direct_and_strict(self):
        evil = {"HTTPS_PROXY": "http://evil.example:1", "https_proxy": "http://evil.example:1", "NO_PROXY": "", "no_proxy": ""}
        with unittest.mock.patch.dict(os.environ, evil):
            default = dom.urllib.request.build_opener()
            try:
                importlib.reload(dom)
                poisoned = list(dom._opener.handlers)
            finally:
                importlib.reload(dom)
        self.assertTrue(any(getattr(h, "proxies", None) for h in default.handlers))
        self.assertFalse(any(getattr(h, "proxies", None) for h in poisoned))
        self.assertTrue(any(type(h).__name__ == "_NoRedirect" for h in dom._opener.handlers))
        self.assertTrue(any(type(h).__name__ == "HTTPSHandler" for h in dom._opener.handlers))
        self.assertEqual(dom._HEADERS.get("Accept-Encoding"), "identity")

    def test_independent_of_bot_database_and_api(self):
        code = code_only(read("wt_dom.py"))
        for word in ("sqlite3", "whale_api", "wt_etf", "subprocess", "socket"):
            self.assertNotIn(word, code, word)

    def test_error_strings_are_ours(self):
        lits = set()
        for n in ast.walk(server_tree()):
            if isinstance(n, ast.Dict):
                for k, v in zip(n.keys, n.values, strict=True):
                    if isinstance(k, ast.Constant) and k.value == "error" and isinstance(v, ast.Constant):
                        lits.add(v.value)
        self.assertEqual(lits, {"no_data", "building"})

    def test_pace_and_limits_are_sane(self):
        # Hyperliquid даёт адресу 1200 «весов» в минуту на всех; запрос свечей —
        # 20 и ещё 1 за каждые 60 свечей. Даже если бы каждая монета отдавала
        # историю с 2020 г., модуль берёт меньше 1000: остальным модулям хватит.
        days = (dom._now() - dom.PX_FROM) / dom.DAY + 365
        self.assertLess(60 / dom.PACE * (20 + days / 60), 1000)
        self.assertEqual(dom.TTL, 3600.0)
        # Корзина: самые торгуемые за VOLW дней, не меньше MIN_BASKET монет,
        # ширина — от узкой корзины до широкой, основная — среди них.
        # 100 монет — как у CoinMarketCap.
        self.assertEqual(dom.TOP, 100)
        self.assertLessEqual(dom.MIN_BASKET, dom.TOP)
        self.assertGreaterEqual(dom.MIN_BASKET, 20)
        self.assertIn(dom.TOP, dom.TIERS)
        self.assertEqual(list(dom.TIERS), sorted(dom.TIERS))
        self.assertGreaterEqual(dom.VOLW, 7)


class ClientPolicyTest(unittest.TestCase):
    def test_no_html_injection_eval_or_side_network(self):
        for path in CLIENT:
            code = strip_comments(read(path))
            for pat in CLIENT_BANNED:
                self.assertIsNone(re.search(pat, code), f"{path}: {pat}")

    def test_calculation_is_pure(self):
        self.assertIsNone(re.search(r"^\s*import\b|\brequire\s*\(", strip_comments(read("src/lib/dom.ts")), re.M))
        self.assertNotIn("localStorage", strip_comments(read("src/lib/dom.ts")))

    def test_reply_is_checked_before_use(self):
        api = read("src/lib/api.ts")
        part = api[api.index("export const fetchDom"):api.index("export const peekDom")]
        self.assertLess(part.index("const v = validDom(r);"), part.index("writeSaved(DOM_SAVED"))
        self.assertIn("if (v) writeSaved(", part)
        saved = api[api.index("function savedDom"):api.index("export const fetchDom")]
        self.assertIn("validDom(hit.v)", saved)
        self.assertNotIn("DomReply", read("src/lib/types.ts"))

    def test_ttl_and_limits_are_the_same_on_both_sides(self):
        lib = read("src/lib/dom.ts")
        self.assertIn("export const DOM_TTL_MS = 60 * 60_000;", lib)
        self.assertIn('"/api/dom", DOM_TTL_MS', read("src/lib/api.ts"))
        self.assertIn(f"export const PX_FROM = {dom.PX_FROM:_};", lib)
        self.assertIn("const COIN = /^[A-Za-z0-9]{1,20}$/;", lib)
        self.assertIn(f"export const MIN_BASKET = {dom.MIN_BASKET};", lib)
        self.assertLessEqual(max(dom.TIERS), 200)
        self.assertEqual(dom.COIN.pattern, "[A-Za-z0-9]{1,20}")
        # Пределы сервера — внутри пределов приложения: годный ответ сервера приложение принимает.
        self.assertLess(dom.EB_MAX, 10.0001)
        self.assertGreaterEqual(dom.EB_MIN, 1e-6)
        self.assertLess(100 * 2.718281828 ** dom.STR_LOG, 1e6)
        self.assertGreater(100 / 2.718281828 ** dom.STR_LOG, 1e-6)
        self.assertLessEqual(dom.PX_MAX, 1e8)


if __name__ == "__main__":
    unittest.main()
