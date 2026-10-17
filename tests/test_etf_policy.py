"""Правила кода «Институциональных потоков» — что модулю можно (npm test).

Как у модуля халвинга: защита, которая не зависит от внимательности
ревьюера. Если кто-то — человек или ИИ-агент — впишет в модуль опасное
(eval, запуск процессов, новый адрес в сети, зависимость от бота или базы,
вставку HTML, сетевой запрос мимо api.ts), тест упадёт, и в main это не
попадёт. Сервер проверяется по дереву разбора Python (AST), а не поиском
текста: обойти переименованием или пробелами не выйдет.
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
import wt_etf as etf  # noqa: E402 — модуль лежит в корне репозитория

SERVER = os.path.join(ROOT, "wt_etf.py")
# Только стандартная библиотека и свой модуль отчётов SEC. Ни базы (sqlite3),
# ни бота, ни своей разметки (wt_etfchain), ни whale_api: модуль независим.
IMPORTS = {"__future__", "calendar", "contextlib", "http.client", "json", "math", "os", "re", "sys", "threading",
           "time", "urllib.error", "urllib.parse", "urllib.request", "concurrent.futures", "typing", "wt_treasury"}
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "input", "breakpoint", "globals", "locals", "vars",
                "setattr", "delattr"}
# Файлы — только копия ответа на диске, и только в этих функциях.
FILE_FUNCS = {"_file_load", "_file_save"}
CLIENT = ["src/lib/etf.ts", "src/screens/EtfScreen.tsx", "src/screens/EtfMore.tsx"]
CLIENT_BANNED = [r"innerHTML", r"outerHTML", r"dangerouslySetInnerHTML", r"insertAdjacentHTML", r"document\.write",
                 r"\beval\s*\(", r"new\s+Function\b", r"\bfetch\s*\(", r"XMLHttpRequest", r"WebSocket", r"\bimport\s*\(",
                 r"window\.open", r"\blocation\b", r"postMessage", r"setTimeout\(\s*['\"`]", r"setInterval\(\s*['\"`]"]


def server_tree() -> ast.Module:
    with open(SERVER, encoding="utf-8") as f:
        return ast.parse(f.read())


def strip_comments(src: str) -> str:
    """Код без комментариев — правила про код, а не про пояснения к нему."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", src)


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
        # В сеть — ровно одно место: _opener.open внутри _fetch, после _allowed.
        calls = []
        for fn in ast.walk(server_tree()):
            if isinstance(fn, ast.FunctionDef):
                for n in ast.walk(fn):
                    if isinstance(n, ast.Attribute) and n.attr in ("open", "urlopen", "urlretrieve", "create_connection",
                                                                   "socket", "getaddrinfo"):
                        calls.append((fn.name, n.attr))
        self.assertEqual(calls, [("_fetch", "open")])
        body = inspect.getsource(etf._fetch)
        self.assertLess(body.index("if not _allowed(url):"), body.index("_opener.open("))

    def test_every_address_is_https_to_a_known_host(self):
        urls = []
        for n in ast.walk(server_tree()):
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and re.match(r"(?i)[a-z][a-z0-9+.-]*://", n.value):
                urls.append(n.value)
            elif isinstance(n, ast.JoinedStr) and n.values and isinstance(n.values[0], ast.Constant):
                head = str(n.values[0].value)
                if "://" in head:
                    urls.append(head)
        self.assertGreaterEqual(len(urls), 4)
        for u in urls:
            self.assertTrue(etf._allowed(u), u)
            self.assertRegex(u, r"^https://[a-z.-]+/")
        self.assertEqual(etf.HOSTS, frozenset({"data-api.binance.vision", "publicreporting.cftc.gov",
                                               "api.exchange.coinbase.com", "www.tftc.io"}))

    def test_endpoint_takes_nothing_from_outside(self):
        self.assertEqual(inspect.signature(etf.etf_data).parameters, {})
        self.assertEqual(inspect.signature(etf.peek).parameters, {})
        self.assertEqual(inspect.signature(etf.build).parameters, {})

    def test_opener_is_direct_and_strict(self):
        # Прокси из окружения не берётся: модуль собирается заново с
        # подложенным HTTPS_PROXY — его «открывалка» всё равно идёт напрямую.
        evil = {"HTTPS_PROXY": "http://evil.example:1", "https_proxy": "http://evil.example:1", "NO_PROXY": "", "no_proxy": ""}
        with unittest.mock.patch.dict(os.environ, evil):
            default = etf.urllib.request.build_opener()
            try:
                importlib.reload(etf)
                poisoned = list(etf._opener.handlers)
            finally:
                importlib.reload(etf)
        self.assertTrue(any(getattr(h, "proxies", None) for h in default.handlers))
        self.assertFalse(any(getattr(h, "proxies", None) for h in poisoned))
        self.assertTrue(any(type(h).__name__ == "_NoRedirect" for h in etf._opener.handlers))
        self.assertTrue(any(type(h).__name__ == "HTTPSHandler" for h in etf._opener.handlers))
        self.assertEqual(etf._HEADERS.get("Accept-Encoding"), "identity")

    def test_independent_of_labels_bot_and_api(self):
        # Модуль ни от чего не зависит: ни разметки кошельков, ни базы бота,
        # ни whale_api. Наоборот — разметку сверяют с ним (whale_api._btc_check).
        src = read("wt_etf.py")
        for word in ("wt_etfchain", "sqlite3", "whale_api", "btc_etf", "set_chain"):
            self.assertNotIn(word, re.sub(r'""".*?"""|#[^\n]*', "", src, flags=re.S), word)

    def test_error_strings_are_ours(self):
        lits = set()
        for n in ast.walk(server_tree()):
            if isinstance(n, ast.Dict):
                for k, v in zip(n.keys, n.values, strict=True):
                    if isinstance(k, ast.Constant) and k.value == "error" and isinstance(v, ast.Constant):
                        lits.add(v.value)
        self.assertEqual(lits, {"no_data"})


class ClientPolicyTest(unittest.TestCase):
    def test_no_html_injection_eval_or_side_network(self):
        for path in CLIENT:
            code = strip_comments(read(path))
            for pat in CLIENT_BANNED:
                self.assertIsNone(re.search(pat, code), f"{path}: {pat}")

    def test_links_go_only_to_the_source_and_its_license(self):
        # Ссылки наружу — только подпись источника (TFTC) и его лицензия, и
        # только через openExternal (Telegram спросит, открыть ли).
        code = strip_comments(read("src/screens/EtfScreen.tsx"))
        self.assertEqual(sorted(set(re.findall(r"href=\{(\w+)\}", code))), ["CCBY_URL", "TFTC_URL"])
        self.assertEqual(sorted(set(re.findall(r'https://[^"\s]+', code))),
                         ["https://creativecommons.org/licenses/by/4.0/", "https://www.tftc.io/bitcoin-etf-flows"])
        self.assertEqual(code.count("openExternal("), 2)
        self.assertNotIn("href", strip_comments(read("src/screens/EtfMore.tsx")))

    def test_calculation_is_pure(self):
        # Расчёты и проверка — без импортов вообще: ни сети, ни хранилища, ни React.
        self.assertIsNone(re.search(r"^\s*import\b|\brequire\s*\(", strip_comments(read("src/lib/etf.ts")), re.M))
        for path in ("src/lib/etf.ts", "src/screens/EtfMore.tsx"):
            self.assertNotIn("localStorage", strip_comments(read(path)), path)

    def test_reply_is_checked_before_use(self):
        # В память и на устройство — только проверенная копия (validEtf).
        api = read("src/lib/api.ts")
        part = api[api.index("export const fetchEtf"):api.index("export const peekEtf")]
        self.assertLess(part.index("const v = validEtf(r);"), part.index("writeSaved(ETF_SAVED"))
        self.assertIn("if (v) writeSaved(", part)
        saved = api[api.index("function savedEtf"):api.index("export const fetchEtf")]
        self.assertIn("validEtf(hit.v)", saved)
        self.assertNotIn("EtfReply", read("src/lib/types.ts"))

    def test_ttl_is_the_same_on_both_sides(self):
        self.assertEqual(etf.TTL, 3600.0)
        self.assertIn("export const ETF_TTL_MS = 60 * 60_000;", read("src/lib/etf.ts"))
        self.assertIn('"/api/etf", ETF_TTL_MS', read("src/lib/api.ts"))
        # Начало торгов — одно и то же в обоих местах.
        self.assertIn(f"export const ETF_LAUNCH = {etf.ETF_LAUNCH:_};", read("src/lib/etf.ts"))


if __name__ == "__main__":
    unittest.main()
