"""Фаззинг сервера халвинга (wt_halving.py): npm test.

Тысячи случайных «ответов сети» — мусорные байты, неверные типы, абсурдные
числа, кривые хеши. Правила: сборка никогда не падает; ответ «ok» всегда
соблюдает инварианты; и каждый такой ответ принимает приложение — его
validHalving из src/lib/halving.ts запускается через Node на тех же данных
(договор между двумя языками). Генератор детерминированный — нарушение
воспроизводится по номеру случая.
"""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_halving as hv  # noqa: E402 — модуль лежит в корне репозитория

SEED = 0x5EED2028
CASES = 3000
NOW = 1_791_881_300
JUNK = [None, True, False, "", "x", "1e9", -1, 0, 0.5, 10**40, -(10**12), [], {}, [1, 2], {"a": 1}, "∞"]
KEYS = set(hv.Reply.__annotations__)
# Строки в ответе — только свои: ни одна не приходит из источника как есть.
OWN = {"epoch", "period", "nominal", "no_data", "mempool.space", "blockstream.info", "blockchain.info"}
TIP_HASH = "b" * 64  # хеш последнего блока
# Враждебные тела: числа вне float, NaN/Infinity, глубокая вложенность, нули.
EVIL = [b'[{"height":1e400,"timestamp":1e400}]', b'{"timeAvg":1e400,"timestamp":-1e400}', b"1e400",
        b'[{"height":NaN,"timestamp":Infinity}]', b'{"timeAvg":-Infinity,"timestamp":NaN}', b"Infinity",
        b"[" * 100_000 + b"]" * 100_000, b'{"a":' * 50_000 + b"1" + b"}" * 50_000, b"\x00" * 64,
        b'[{"height":' + b"9" * 5000 + b"}]", b'"\\ud800"', b"\xef\xbb\xbf[]"]


def junk(r: random.Random) -> object:
    return r.choice(JUNK) if r.random() < 0.5 else r.randint(-(10**10), 10**10)


def body(r: random.Random, value: object) -> bytes | None:
    """Ответ сети: нормальный JSON, обрезанный, двоичный мусор или ничего."""
    roll = r.random()
    if roll < 0.06:
        return None
    if roll < 0.09:
        return r.choice(EVIL)
    if roll < 0.12:
        return bytes(r.getrandbits(8) for _ in range(r.randint(0, 40)))
    raw = json.dumps(value).encode()
    return raw[: r.randint(0, len(raw))] if roll < 0.18 else raw


def network(r: random.Random):
    """Случайная сеть: правдоподобные ответы вперемешку с мусором."""
    height = r.choice([971_219, 972_000, 973_235, 973_236, 971_218, 1_050_000, 1_100_000, 2_000_000, 799_999, 99_000_000])
    tip = NOW - r.randint(-10_000, 200_000)
    blk = {"height": height if r.random() < 0.8 else junk(r), "timestamp": tip if r.random() < 0.8 else junk(r)}
    blocks = [blk] if r.random() < 0.85 else junk(r)
    adj = {"timeAvg": r.choice([570_866, 600_000, 60_000, 2_000_000]) if r.random() < 0.8 else junk(r)}
    start_ts = r.choice([1_713_571_767, NOW - 10**6, NOW + 10**6, 0]) if r.random() < 0.8 else junk(r)
    hsh = r.choice(["0" * 63 + "a", "../evil", "", "f" * 64, "Z" * 64])
    tip_h = r.choice([971_219, 973_235, 973_236, 1_050_100, 99_000_000, 0]) if r.random() < 0.8 else junk(r)

    tip_blk = blocks[0] if isinstance(blocks, list) and blocks else blocks
    asked = {"h": 0}  # высота, по которой спросили хеш блока начала эпохи

    def by_height(url: str) -> bytes | None:
        asked["h"] = int(url.rsplit("/", 1)[1])
        return hsh.encode() if r.random() < 0.9 else body(r, junk(r))

    # Адрес → ответ; первый подходящий. Остальное — «высота строкой».
    routes = (
        (lambda u: u.endswith("/api/blocks/tip/hash"), lambda: TIP_HASH.encode() if r.random() < 0.9 else body(r, junk(r))),
        (lambda u: u.endswith(f"/api/block/{TIP_HASH}"), lambda: body(r, tip_blk)),
        (lambda u: "difficulty-adjustment" in u, lambda: body(r, adj)),
        (lambda u: "block-height" in u, None),
        (lambda u: "/api/block/" in u,
         lambda: body(r, {"height": asked["h"] if r.random() < 0.9 else junk(r), "timestamp": start_ts})),
    )

    def height_text(limit: int) -> bytes | None:
        roll = r.random()
        if roll < 0.8:
            return str(tip_h).encode()[:limit]
        return r.choice([b"1e400", b"9" * 5000, b"Infinity", b"NaN", b"-0"]) if roll < 0.86 else body(r, junk(r))

    def fetch(url: str, limit: int = 1 << 20) -> bytes | None:
        for match, answer in routes:
            if match(url):
                return answer() if answer else by_height(url)
        return height_text(limit)

    return fetch


class FuzzTest(unittest.TestCase):
    def setUp(self):
        hv._st = hv._State()
        hv._busy.clear()
        hv.START_TS.clear()
        hv.START_TS[840_000] = 1_713_571_767

    def check(self, i: int, res: dict) -> None:
        m = f"случай {i}: {res}"
        self.assertLessEqual(set(res), KEYS, m)
        # Ни одного символа текста от источника: строки в ответе — только наши.
        for k, v in res.items():
            self.assertTrue(type(v) in (int, float, bool) or v in OWN, f"{m}: {k}={v!r}")
        if not res["ok"]:
            self.assertEqual(res.get("error"), "no_data", m)
            return
        h, nxt, every = res["height"], res["next"], res["every"]
        self.assertEqual((every, nxt % every), (hv.EVERY, 0), m)
        self.assertTrue(nxt - every <= h < nxt, m)
        self.assertTrue(hv.ANCHOR_HEIGHT <= h <= hv.ANCHOR_HEIGHT + (NOW - hv.ANCHOR_TS) // hv.AVG_MIN + hv.RETARGET, m)
        src, avg = res["src"], res["avg"]
        self.assertIn(src, ("epoch", "period", "nominal"), m)
        self.assertTrue(avg == hv.TARGET if src == "nominal" else hv.AVG_MIN <= avg <= hv.AVG_MAX, m)
        self.assertTrue(NOW - hv.MAX_AGE < res["tip"] <= NOW + hv.MAX_FUTURE, m)
        self.assertGreaterEqual(res["eta"], res["tip"], m)
        self.assertEqual(res["at"], NOW, m)
        if "prev" in res:
            self.assertTrue(1_700_000_000 < res["prev"] <= NOW, m)
        for k in ("height", "next", "every", "tip", "eta", "at"):
            self.assertIs(type(res[k]), int, m)

    def test_build_never_raises_and_keeps_invariants(self):
        r = random.Random(SEED)  # noqa: S311 — нужна повторяемость, а не криптостойкость
        good, logs = [], []
        with mock.patch.object(hv, "_now", lambda: NOW), mock.patch.object(hv, "_log", logs.append):
            for i in range(CASES):
                hv._st = hv._State()
                hv.START_TS.clear()
                hv.START_TS[840_000] = 1_713_571_767
                with mock.patch.object(hv, "_fetch", network(r)):
                    res = hv.build()
                self.check(i, dict(res))
                if res["ok"]:
                    good.append({**res, "now": NOW})
        # Общий перехват в build — страховка: ни один ответ сети до него не доходит.
        self.assertEqual([m for m in logs if m.startswith("сборка")], [])
        # Генератор должен давать и годные ответы, и отказы — иначе он ничего не проверяет.
        self.assertGreater(len(good), CASES // 10)
        self.assertLess(len(good), CASES)
        self.__class__.good = good

    @unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
    def test_every_ok_reply_is_accepted_by_the_app(self):
        if not getattr(self.__class__, "good", None):
            self.test_build_never_raises_and_keeps_invariants()
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(self.__class__.good, f)
        try:
            script = (
                "import { readFileSync } from 'node:fs';"
                f"import {{ validHalving }} from {json.dumps(os.path.join(ROOT, 'src/lib/halving.ts'))};"
                "const all = JSON.parse(readFileSync(process.argv[1], 'utf8'));"
                "const bad = all.filter((h) => !validHalving(h));"
                "console.log(JSON.stringify({ n: all.length, bad: bad.slice(0, 3) }));"
            )
            out = subprocess.run(["node", "--input-type=module", "-e", script, f.name],
                                 capture_output=True, text=True, timeout=60, check=True)
            got = json.loads(out.stdout)
            self.assertEqual(got["n"], len(self.__class__.good))
            self.assertEqual(got["bad"], [], "приложение отвергло ответ сервера")
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main()
