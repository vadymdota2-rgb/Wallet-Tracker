"""Правила кода и права модуля рынков (wt_markets.py, src/lib/markets.ts).

Как у халвинга: проверяем не поведение, а то, чего в модуле быть не должно
и что обязано быть. Сервер: без сети, файлов и eval, только свои импорты,
источники — константами в whale_api, маршрут — для подписчиков и без
кэширования по дороге. Приложение: те же пункты и пределы, что у сервера,
проверка ответа без импортов, подписи и пояснения на всех 16 языках.
Права: ни Deribit, ни VIX Cboe, ни TradingView, ни имени Nasdaq-100;
оговорки о товарных знаках и источники — на месте.
"""
import ast
import inspect
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_markets as mk  # noqa: E402

SOURCES = ("xyz", "para", "mkts", "fx", "ecb", "d1", "mcap", "aster")


def read(*path: str) -> str:
    with open(os.path.join(ROOT, *path), encoding="utf-8") as f:
        return f.read()


class PolicyTest(unittest.TestCase):
    def tree(self) -> ast.Module:
        return ast.parse(read("wt_markets.py"))

    def test_module_has_no_network_files_or_eval(self):
        found = set()
        for n in ast.walk(self.tree()):
            if isinstance(n, ast.Import):
                found |= {a.name for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                found.add(n.module or "")
        self.assertLessEqual(found, {"__future__", "calendar", "contextlib", "math", "re", "sys", "threading", "time", "collections.abc", "typing"})
        bad = [n.func.id for n in ast.walk(self.tree()) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in {"eval", "exec", "compile", "__import__", "open", "getattr", "setattr"}]
        self.assertEqual(bad, [])
        self.assertEqual([n.value for n in ast.walk(self.tree()) if isinstance(n, ast.Constant)
                          and isinstance(n.value, str) and "://" in n.value], [])

    def test_server_wiring_and_paid_route(self):
        self.assertIn("/api/markets", api.PAID_PATHS)
        self.assertIn("/markets", api.PAID_PATHS)
        self.assertIs(api.markets_data, mk.markets_data)
        src = read("whale_api.py")
        self.assertIn('                rep = markets_data()\n                if rep.get("ok") is True:\n                    self._json_public("markets", rep)\n', src)
        for name in SOURCES:
            self.assertIn(f'    "{name}": ', src.split("wt_markets.set_sources({")[1].split("})")[0])
        self.assertEqual(src.split("wt_markets.set_sources({")[1].split("})")[0].count('\n    "'), len(SOURCES))
        self.assertIn('"mcap": lambda: wt_mcap.mcap_data(0),', src)  # доминация — из кэша, без ожидания

    def test_rights(self):
        # Deribit (DVOL) — только для личного пользования; VIX — индекс Cboe по
        # лицензии; XYZ100 — не Nasdaq-100; котировки TradingView брать нельзя
        # (только их окна): ни в источниках, ни в ключах.
        block = read("whale_api.py").split("# --- Рынки в меню (wt_markets.py)")[1].split("markets_data = wt_markets")[0]
        self.assertNotIn("deribit.com", block)
        self.assertNotIn("cboe", block.lower())
        self.assertNotIn("tradingview", block.lower())
        self.assertEqual(set(mk.KEYS) & {"DVOL", "VIX", "NDX"}, set())
        self.assertNotIn("dvol", "".join(mk.KEYS).lower())
        tr = json.loads(read("tools", "i18n.json"))
        for lang, v in tr["mk_src"].items():
            self.assertNotIn("Deribit", v, lang)
            self.assertIn("CoinMarketCap", v, lang)  # ссылку ставит экран — по этому слову
        for lang in tr["mk_sp_hint"]:
            self.assertIn("S&P Dow Jones Indices", tr["mk_sp_hint"][lang], lang)
            self.assertIn("Standard & Poor’s Financial Services LLC", tr["mk_sp_hint"][lang], lang)
            self.assertIn("Nasdaq-100", tr["mk_xyz_hint"][lang], lang)
            self.assertIn("ICE", tr["mk_dxy_hint"][lang], lang)
            self.assertIn("WTI", tr["mk_oil_hint"][lang], lang)
            self.assertIn("Volmex", tr["mk_bviv_hint"][lang], lang)
            self.assertIn("Kinetiq", tr["mk_bviv_hint"][lang], lang)

    def test_sources_are_constants(self):
        # Адреса источников — константы; в запрос не попадает ничего, кроме
        # своего времени и своих валют (ни пути, ни параметров запроса).
        block = read("whale_api.py").split("# --- Рынки в меню (wt_markets.py)")[1].split("markets_data = wt_markets")[0]
        hosts = set(re.findall(r"https://([a-z0-9.-]+)/", block))
        self.assertEqual(hosts, {"api.frankfurter.dev"})
        self.assertEqual(block.count("hl_post("), 5)  # три площадки, свечи валют и дневные свечи рынков
        self.assertEqual(set(re.findall(r'"dex": "([a-z]+)"', block)), {"xyz", "para", "mkts"})
        self.assertEqual(block.count('"candleSnapshot"'), 2)
        self.assertEqual(re.findall(r'"interval": "([0-9a-z]+)"', block), ["1h", "1d"])
        self.assertIn("for k, coin in wt_markets.D1.items()}", block)
        # Дневные свечи — только рынки пунктов (площадка:имя из HL), не чужие.
        self.assertEqual(mk.D1, {k: f"{d}:{n}" for k, (d, n) in mk.HL.items()})
        for bad in ("self.", "path", "query", "headers", "environ"):
            self.assertNotIn(bad, block, bad)
        self.assertIn("for c in wt_markets.FX_HL}", block)
        # Каждый запрос — с пределом размера ответа (гигабайт не съест память).
        self.assertEqual(block.count("max_bytes=wt_markets.RESP_MAX"), block.count("hl_post(") + block.count("get_json("))
        # Все видят кэш: обновляет его только сервер — при запуске и раз в
        # минуту (cache_refresher); запрос человека только читает.
        src = read("whale_api.py")
        self.assertIn("    markets_refresh()\n", src.split("def warmup() -> None:")[1].split("\ndef ")[0])
        self.assertIn('        ("markets", lambda: markets_refresh()),\n', src.split("def _cache_modules() -> tuple:")[1].split("\ndef ")[0])
        self.assertIs(api.markets_refresh, mk.refresh)
        route = src.split('if path in ("/markets", "/api/markets"):')[1].split("return\n")[0]
        self.assertNotIn("refresh", route)
        self.assertNotIn("build", route)
        reader = inspect.getsource(mk.markets_data)
        for bad in ("_start(", "build(", "refresh("):
            self.assertNotIn(bad, reader.split('"""')[2], bad)
        # Aster — без своих запросов: только память модуля фандинга.
        self.assertNotIn("asterdex", block)
        self.assertIn('    "aster": _mkt_aster,\n', block)
        aster = block.split("def _mkt_aster():")[1].split("wt_markets.set_sources")[0]
        for bad in ("hl_post(", "get_json(", "http"):
            self.assertNotIn(bad, aster, bad)
        self.assertIn("    tick = _ASTER_TICK  #", aster)
        src = read("whale_api.py")
        self.assertIn("        _ASTER_TICK = (now(), tick)", src.split("def fund_aster() -> list:")[1].split("\ndef ")[0])

    def test_paid_route_is_not_cached_on_the_way(self):
        src = read("whale_api.py")
        handler = src.split("    def _json(self, code: int, obj: dict):")[1][:1600]
        self.assertIn('self.send_header("Cache-Control", "no-store")', handler)

    def test_app_and_server_agree(self):
        ts = read("src", "lib", "markets.ts")
        keys = re.search(r"export const MARKET_KEYS = \[([^\]]*)\] as const;", ts)
        self.assertIsNotNone(keys)
        self.assertEqual(tuple(re.findall(r'"([A-Z0-9]+)"', keys.group(1))), mk.KEYS)
        self.assertIn(f"export const MARKET_PX_MAX = {mk.PX_MAX:.0e}".replace("e+0", "e").replace("e+", "e"), ts)
        self.assertIsNone(re.search(r"^\s*import\b", ts, re.M))  # проверка ответа — без импортов
        # Свечи мини-графика: столько же, сколько отдаёт сервер, и не старше,
        # чем он держит.
        self.assertIn(f"export const CANDLES_SHOW = {mk.DAYS_SHOW};", ts)
        self.assertIn(f"const CANDLES_AGE_DAYS = {mk.DAYS_KEEP};", ts)
        self.assertIn(f"const DAY = {mk.DAY:_};", ts)
        # Приложение спрашивает раз в столько, сколько живут цены площадок на сервере.
        self.assertIn(f"export const MARKETS_REFRESH = {int(mk.SLOW['xyz'][0])};", ts)
        self.assertEqual({mk.SLOW[d][0] for d in mk.DEXES}, {mk.SLOW["xyz"][0]})
        self.assertIn('if (it.k === "US10Y" || it.k === "BTCD" || it.k === "USDTD") return 2;'
                      if "isPercent(it.k)" not in ts else "if (isPercent(it.k)) return 2;", ts)

    def test_labels_and_hints_in_every_language(self):
        tr = json.loads(read("tools", "i18n.json"))
        tsx = read("src", "components", "Markets.tsx")
        keys = set(re.findall(r'"(mk_[a-z0-9_]+)"', tsx))
        self.assertTrue({"mk_gold", "mk_oil", "mk_bp", "mk_src", "mk_about", "mk_title"} <= keys, keys)
        for k in keys:
            self.assertIn(k, tr, k)
            self.assertEqual(len(tr[k]), 16, k)
            for lang, v in tr[k].items():
                self.assertTrue(v.strip(), (k, lang))
                if lang == "fr":
                    self.assertIsNone(re.search(r" [:;?!»]|« ", v), (k, v))  # французские знаки — с неразрывным
                if lang in ("zh", "ja"):
                    self.assertNotIn(" ：", v, (k, lang))
        # Пояснение — у каждого из девяти пунктов: любую ячейку можно коснуться
        # и прочитать, что это (и оговорки о правах — у тех, где они нужны).
        hints = {"SP500": "mk_sp_hint", "XYZ100": "mk_xyz_hint", "DXY": "mk_dxy_hint", "GOLD": "mk_gold_hint",
                 "OIL": "mk_oil_hint", "US10Y": "mk_10y_hint", "BVIV": "mk_bviv_hint", "BTCD": "mk_btcd_hint",
                 "USDTD": "mk_usdtd_hint"}
        self.assertEqual(set(hints), set(mk.KEYS))
        for key, hint in hints.items():
            self.assertIn(f"{key}: \"{hint}\"", tsx, key)
        self.assertIn("const HINT: Record<MarketKey, DictKey> = {", tsx)  # тип требует все девять
        self.assertIn("CoinMarketCap", tr["mk_btcd_hint"]["ru"])

    def test_no_dead_texts_or_exports(self):
        # Каждый текст модуля (mk_…) показывается экраном, каждый экспорт
        # lib/markets.ts кому-то нужен (приложению или тестам).
        tr = json.loads(read("tools", "i18n.json"))
        tsx = read("src", "components", "Markets.tsx")
        self.assertEqual([k for k in tr if k.startswith("mk_") and f'"{k}"' not in tsx], [])
        lib = read("src", "lib", "markets.ts")
        others = ""
        for folder in ("src", "tests"):
            for base, _, files in os.walk(os.path.join(ROOT, folder)):
                for f in files:
                    path = os.path.join(base, f)
                    if f.endswith((".ts", ".tsx")) and not path.endswith(os.path.join("lib", "markets.ts")):
                        with open(path, encoding="utf-8") as fh:
                            others += fh.read()
        dead = [e for e in re.findall(r"export (?:const|function|type|interface) (\w+)", lib)
                if not re.search(rf"\b{e}\b", others)]
        self.assertEqual(dead, [])

    def test_styles_in_own_file(self):
        self.assertIn('import "./Markets.css";', read("src", "components", "Markets.tsx"))
        self.assertNotIn(".mk-", read("src", "styles", "app.css"))
        self.assertIn(".mk-grid", read("src", "components", "Markets.css"))


if __name__ == "__main__":
    unittest.main()
