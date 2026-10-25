"""Правила кода модуля «Страха и жадности» — «что модулю можно» (npm test).

Как у халвинга: если кто-то — человек или ИИ-агент — впишет в модуль
опасное (eval, процессы, новый адрес в сети, вставку HTML) или источник, чьи
условия запрещают показывать данные (Binance, Coinbase), тест упадёт. Сервер
проверяется по дереву разбора Python (AST), а не поиском текста.
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
import wt_fng as fng  # noqa: E402 — модуль лежит в корне репозитория

SERVER = os.path.join(ROOT, "wt_fng.py")
IMPORTS = {"__future__", "bisect", "collections.abc", "contextlib", "http.client", "json", "math", "os", "re", "ssl", "sys", "threading",
           "time", "urllib.error", "urllib.parse", "urllib.request", "dataclasses", "typing"}
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "input", "breakpoint", "globals", "locals", "vars",
                "setattr", "delattr"}
# Файлы и os — только у копии ответа на диске и только эти вызовы.
FILE_FUNCS = {"_file", "_file_save", "_file_load", "_sweep"}
OS_CALLS = {"path.join", "path.dirname", "path.split", "path.getmtime", "makedirs", "replace", "remove", "getpid", "listdir"}
# Источники, чьи условия не разрешают показывать их рыночные данные, и
# источники, которые владелец проекта исключил.
BANNED_SOURCES = re.compile(r"(?i)binance|coinbase|coingecko|coinpaprika|coinlore|defillama|kraken|cryptocompare")
CLIENT = ["src/lib/fng.ts", "src/screens/FearGreedScreen.tsx", "src/screens/FearGreedInsights.tsx"]
CLIENT_BANNED = [r"innerHTML", r"outerHTML", r"dangerouslySetInnerHTML", r"insertAdjacentHTML", r"document\.write",
                 r"\beval\s*\(", r"new\s+Function\b", r"\bfetch\s*\(", r"XMLHttpRequest", r"WebSocket", r"\bimport\s*\(",
                 r"window\.open", r"\blocation\b", r"postMessage", r"sessionStorage",
                 r"setTimeout\(\s*['\"`]", r"setInterval\(\s*['\"`]"]


def server_tree() -> ast.Module:
    with open(SERVER, encoding="utf-8") as f:
        return ast.parse(f.read())


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", src)


def docstrings(tree: ast.Module) -> set[int]:
    """id узлов-строк, которые — описания модуля и функций, а не код."""
    out = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.FunctionDef, ast.ClassDef)) and n.body:
            first = n.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                out.add(id(first.value))
    return out


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
        opens, oss = [], []
        for fn in ast.walk(server_tree()):
            if not isinstance(fn, ast.FunctionDef):
                continue
            for n in ast.walk(fn):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "open":
                    opens.append(fn.name)
                if isinstance(n, ast.Attribute) and isinstance(n.value, (ast.Name, ast.Attribute)):
                    full = ast.unparse(n)
                    if full.startswith("os."):
                        oss.append((fn.name, full[3:]))
        self.assertLessEqual(set(opens), FILE_FUNCS)
        self.assertTrue(opens)
        for name, call in oss:
            self.assertIn(name, FILE_FUNCS, call)
            self.assertIn(call, OS_CALLS | {"path"}, call)

    def test_network_goes_through_one_door(self):
        calls = []
        for fn in ast.walk(server_tree()):
            if isinstance(fn, ast.FunctionDef):
                for n in ast.walk(fn):
                    if isinstance(n, ast.Attribute) and n.attr in ("open", "urlopen", "urlretrieve", "create_connection",
                                                                   "socket", "getaddrinfo"):
                        calls.append((fn.name, n.attr))
        self.assertEqual(calls, [("_fetch", "open")])
        body = inspect.getsource(fng._fetch)
        self.assertLess(body.index("if not _allowed(url):"), body.index("_opener.open("))

    def test_every_address_is_https_to_a_known_host(self):
        urls = [n.value for n in ast.walk(server_tree())
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and re.match(r"(?i)[a-z][a-z0-9+.-]*://", n.value)]
        self.assertFalse([n for n in ast.walk(server_tree()) if isinstance(n, ast.JoinedStr)
                          and any("://" in str(getattr(v, "value", "")) for v in n.values)], "адрес с подстановкой")
        self.assertEqual(sorted(urls), sorted([fng.FNG_URL, fng.HIST_URL, fng.LIVE_URL]))
        for u in urls:
            self.assertTrue(fng._allowed(u), u)
            self.assertRegex(u, r"^https://[a-z.]+/")
        self.assertEqual(set(fng.HOSTS), {"api.alternative.me", "mempool.space"})

    def test_no_exchange_sources_in_code(self):
        # Имена бирж — только в пояснениях (почему их нет), не в коде.
        tree = server_tree()
        skip = docstrings(tree)
        bad = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
               and id(n) not in skip and BANNED_SOURCES.search(n.value)]
        self.assertEqual(bad, [])
        for path in CLIENT:
            with open(os.path.join(ROOT, path), encoding="utf-8") as f:
                self.assertIsNone(BANNED_SOURCES.search(strip_comments(f.read())), path)

    def test_endpoint_takes_nothing_from_outside(self):
        self.assertEqual(inspect.signature(fng.fng_data).parameters, {})

    def test_opener_is_direct_and_strict(self):
        evil = {"HTTPS_PROXY": "http://evil.example:1", "https_proxy": "http://evil.example:1", "NO_PROXY": "", "no_proxy": ""}
        with unittest.mock.patch.dict(os.environ, evil):
            default = fng.urllib.request.build_opener()
            try:
                importlib.reload(fng)
                poisoned = list(fng._opener.handlers)
            finally:
                importlib.reload(fng)
        self.assertTrue(any(getattr(h, "proxies", None) for h in default.handlers))
        self.assertFalse(any(getattr(h, "proxies", None) for h in poisoned))
        https = [h for h in fng._opener.handlers if type(h).__name__ == "HTTPSHandler"]
        ctx = https[0]._context
        self.assertGreaterEqual(ctx.minimum_version, fng.ssl.TLSVersion.TLSv1_2)
        self.assertEqual(ctx.verify_mode, fng.ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(fng._HEADERS.get("Accept-Encoding"), "identity")
        self.assertEqual(set(fng.SCHEMES), {"https"})

    def test_reply_strings_are_ours(self):
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
            with open(os.path.join(ROOT, path), encoding="utf-8") as f:
                code = strip_comments(f.read())
            for pat in CLIENT_BANNED:
                self.assertIsNone(re.search(pat, code), f"{path}: {pat}")

    def test_calculation_is_pure(self):
        with open(os.path.join(ROOT, "src/lib/fng.ts"), encoding="utf-8") as f:
            self.assertIsNone(re.search(r"^\s*import\b|\brequire\s*\(", strip_comments(f.read()), re.M))

    def test_links_are_the_two_sources_next_to_the_data(self):
        # Условие alternative.me: ссылка на источник рядом с данными. Других
        # ссылок на экране нет.
        with open(os.path.join(ROOT, "src/screens/FearGreedScreen.tsx"), encoding="utf-8") as f:
            code = strip_comments(f.read())
        self.assertEqual(re.findall(r"https?://[^\"'`\s]+", code),
                         ["https://alternative.me/crypto/fear-and-greed-index/", "https://mempool.space/"])
        hero = code[code.index('<p className="fg-by">'):code.index("</p>", code.index('<p className="fg-by">'))]
        self.assertIn("href={FNG_URL} onClick={open(FNG_URL)}>alternative.me</a>", hero)
        self.assertIn("href={PX_URL} onClick={open(PX_URL)}>mempool.space</a>", hero)
        self.assertEqual(re.findall(r"href=\{(\w+)\}", code), ["FNG_URL", "PX_URL"])

    def test_reply_is_checked_before_use(self):
        with open(os.path.join(ROOT, "src/lib/api.ts"), encoding="utf-8") as f:
            api = f.read()
        part = api[api.index("const fngOnce"):api.index("export const peekFng")]
        self.assertIn('call<unknown>("/api/fng", { timeout: 30_000 }).then((r) => validFng(r))', part)
        self.assertLess(part.index("fngOnce().then((r) => r ?? fngOnce())"), part.index("writeSaved(FNG_SAVED"))
        self.assertIn("return v;", part)
        saved = api[api.index("function savedFng"):api.index("export const fetchFng")]
        self.assertIn("validFng(hit.v)", saved)
        self.assertIn('const FNG_SAVED = "wt-fng-v2";', api)


if __name__ == "__main__":
    unittest.main()
