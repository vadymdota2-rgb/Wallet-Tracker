"""Правила кода модуля халвинга — «что модулю можно» (npm test).

Защита, которая не зависит от внимательности ревьюера: если кто-то — человек
или ИИ-агент — впишет в модуль опасное (eval, запуск процессов, файлы, новый
адрес в сети, вставку HTML, сетевой запрос из карточки), тест упадёт, и в
main это не попадёт. Сервер проверяется по дереву разбора Python (AST), а не
поиском текста: обойти переименованием или пробелами не выйдет.
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
import wt_halving as hv  # noqa: E402 — модуль лежит в корне репозитория

SERVER = os.path.join(ROOT, "wt_halving.py")
# Только стандартная библиотека и только то, что нужно: ни os, ни subprocess,
# ни socket напрямую, ни pickle. Сторонних пакетов нет — нечего подменить.
IMPORTS = {"__future__", "contextlib", "http.client", "json", "math", "re", "socket", "ssl", "sys", "threading", "time",
           "urllib.error", "urllib.parse", "urllib.request", "dataclasses", "typing",
           "collections.abc"}  # collections.abc — только для проверки типов (TYPE_CHECKING)
# Встроенные функции, которых в модуле быть не должно.
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "open", "input", "breakpoint", "globals", "locals", "vars",
                "setattr", "delattr"}
# Файлы приложения: никакого HTML из строк, eval, сети в обход api.ts, ссылок.
CLIENT = ["src/lib/halving.ts", "src/lib/tick.ts", "src/components/HalvingCard.tsx", "src/components/Boundary.tsx"]
CLIENT_BANNED = [r"innerHTML", r"outerHTML", r"dangerouslySetInnerHTML", r"insertAdjacentHTML", r"document\.write",
                 r"\beval\s*\(", r"new\s+Function\b", r"\bfetch\s*\(", r"XMLHttpRequest", r"WebSocket", r"\bimport\s*\(",
                 r"window\.open", r"\blocation\b", r"postMessage", r"\bhref\b", r"\bsrc=", r"localStorage", r"sessionStorage",
                 r"setTimeout\(\s*['\"`]", r"setInterval\(\s*['\"`]"]


def server_tree() -> ast.Module:
    with open(SERVER, encoding="utf-8") as f:
        return ast.parse(f.read())


def strip_comments(src: str) -> str:
    """Код без комментариев — правила про код, а не про пояснения к нему."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", src)


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

    def test_network_goes_through_one_door(self):
        # В сеть — ровно одно место: _opener.open внутри _fetch, после _allowed;
        # соединение — только в _connect (адреса источника по очереди).
        calls = []
        for fn in ast.walk(server_tree()):
            if isinstance(fn, ast.FunctionDef):
                for n in ast.walk(fn):
                    if isinstance(n, ast.Attribute) and n.attr in ("open", "urlopen", "urlretrieve", "create_connection",
                                                                   "socket", "getaddrinfo"):
                        calls.append((fn.name, n.attr))
        self.assertEqual(set(calls), {("_connect", "getaddrinfo"), ("_connect", "socket"), ("_fetch", "open")})
        body = inspect.getsource(hv._fetch)
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
        self.assertGreaterEqual(len(urls), 6)
        for u in urls:
            self.assertTrue(hv._allowed(u), u)
            # Адрес с подстановкой — подставляется только после пути, не в имя сервера.
            self.assertRegex(u, r"^https://[a-z.]+/")

    def test_endpoint_takes_nothing_from_outside(self):
        self.assertEqual(inspect.signature(hv.reply).parameters, {})
        self.assertEqual(inspect.signature(hv.halving_data).parameters, {})

    def test_opener_is_direct_and_strict(self):
        # Прокси из окружения не берётся: модуль собирается заново с
        # подложенным HTTPS_PROXY — его «открывалка» всё равно идёт напрямую.
        evil = {"HTTPS_PROXY": "http://evil.example:1", "https_proxy": "http://evil.example:1", "NO_PROXY": "", "no_proxy": ""}
        with unittest.mock.patch.dict(os.environ, evil):
            default = hv.urllib.request.build_opener()
            try:
                importlib.reload(hv)
                poisoned = list(hv._opener.handlers)
            finally:
                importlib.reload(hv)
        self.assertTrue(any(getattr(h, "proxies", None) for h in default.handlers))  # без защиты прокси был бы
        self.assertFalse(any(getattr(h, "proxies", None) for h in poisoned))
        https = [h for h in hv._opener.handlers if isinstance(h, hv.urllib.request.HTTPSHandler)]
        self.assertEqual(len(https), 1)
        ctx = https[0]._context
        self.assertGreaterEqual(ctx.minimum_version, hv.ssl.TLSVersion.TLSv1_2)  # TLS не старше 1.2
        self.assertEqual(ctx.verify_mode, hv.ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(hv._HEADERS.get("Accept-Encoding"), "identity")
        self.assertEqual(set(hv.SCHEMES), {"https"})

    def test_reply_strings_are_ours(self):
        # Строки в ответе — только из модуля, ни одной от источника.
        lits = set()
        for n in ast.walk(server_tree()):
            if isinstance(n, ast.Dict):
                for k, v in zip(n.keys, n.values, strict=True):
                    if isinstance(k, ast.Constant) and k.value in ("src", "error") and isinstance(v, ast.Constant):
                        lits.add(v.value)
        self.assertEqual(lits, {"no_data"})
        self.assertIn('src: Literal["epoch", "period", "nominal"] = "nominal"', inspect.getsource(hv._build))


class ClientPolicyTest(unittest.TestCase):
    def test_no_html_injection_eval_or_side_network(self):
        for path in CLIENT:
            with open(os.path.join(ROOT, path), encoding="utf-8") as f:
                code = strip_comments(f.read())
            for pat in CLIENT_BANNED:
                self.assertIsNone(re.search(pat, code), f"{path}: {pat}")

    def test_calculation_is_pure(self):
        # Расчёт — без импортов вообще: ни сети, ни хранилища, ни React.
        with open(os.path.join(ROOT, "src/lib/halving.ts"), encoding="utf-8") as f:
            self.assertIsNone(re.search(r"^\s*import\b|\brequire\s*\(", strip_comments(f.read()), re.M))

    def test_reply_is_checked_before_use(self):
        # В память и на устройство — только проверенное и только известные поля.
        with open(os.path.join(ROOT, "src/lib/api.ts"), encoding="utf-8") as f:
            api = f.read()
        part = api[api.index("export const fetchHalving"):api.index("export const peekHalving")]
        self.assertLess(part.index("if (!validHalving(r)) return null;"), part.index("pickHalving(r)"))
        saved = api[api.index("function savedHalving"):api.index("export const fetchHalving")]
        self.assertIn("!validHalving(hit.v)", saved)
        self.assertIn("return pickHalving(hit.v);", saved)


if __name__ == "__main__":
    unittest.main()
