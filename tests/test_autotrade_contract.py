"""Автоторговля — договор сервера и вкладки (как у карточки халвинга).

Сервер (wt_autotrade.status) собирает ответ из файлов службы whale-autotrade;
вкладка принимает его только через validAutotrade (src/lib/autotrade.ts).
Проверяется:
1. образцы (tests/fixtures/autotrade_summary.json и autotrade_live.json) —
   годный ответ, и вкладка его принимает;
2. фаззинг файлов службы (CASES случаев, зерно фиксировано): испорченные
   state.json и trades.jsonl не роняют сервер, а каждый его ответ вкладка
   принимает — сервер приводит всё к договору, вкладка не видит мусора;
3. мусор вместо ответа вкладка отвергает (не падает и не рисует).
"""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_autotrade as at  # noqa: E402

CASES = int(os.environ.get("AUTOTRADE_CONTRACT_CASES", "400"))
FIXTURE_NOW = 1_795_000_000  # «сейчас» образца (то же T, что в tests/e2e/autotrade.e2e.test.ts)
FIX = os.path.join(ROOT, "tests", "fixtures")
GARBAGE = [None, True, "x", "NaN", -1, 0, 1.5, 10**30, float("nan"), float("inf"), [], {}, [1, "a"], {"a": 1}, "", "1e999"]


def node_check(replies: list) -> list:
    """Прогнать validAutotrade через Node; вернуть номера отвергнутых."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(replies, f, allow_nan=True)
    try:
        script = (
            "import { readFileSync } from 'node:fs';"
            f"import {{ validAutotrade }} from {json.dumps(os.path.join(ROOT, 'src/lib/autotrade.ts'))};"
            "const all = JSON.parse(readFileSync(process.argv[1], 'utf8').replace(/\\bNaN\\b/g, 'null')"
            ".replace(/-?Infinity/g, 'null'));"
            "console.log(JSON.stringify(all.map((r, i) => validAutotrade(r) ? -1 : i).filter((i) => i >= 0)));"
        )
        out = subprocess.run(["node", "--input-type=module", "-e", script, f.name],
                             capture_output=True, text=True, timeout=120, check=True)
        return json.loads(out.stdout)
    finally:
        os.unlink(f.name)


def spoil(r: random.Random, v):
    """Испортить значение: подменить, удалить ключ, вложить мусор."""
    if isinstance(v, dict) and v:
        k = r.choice(list(v))
        if r.random() < 0.3:
            v = {kk: vv for kk, vv in v.items() if kk != k}
        else:
            v = {**v, k: spoil(r, v[k]) if r.random() < 0.5 else r.choice(GARBAGE)}
        return v
    if isinstance(v, list) and v:
        i = r.randrange(len(v))
        return [*v[:i], spoil(r, v[i]) if r.random() < 0.5 else r.choice(GARBAGE), *v[i + 1:]]
    return r.choice(GARBAGE)


@unittest.skipUnless(shutil.which("node"), "нужен Node 22.18+")
class ContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, "data")
        os.makedirs(os.path.join(self.data, "live"))
        os.makedirs(os.path.join(self.data, "latest"))
        with open(os.path.join(FIX, "autotrade_live_state.json"), encoding="utf-8") as f:
            self.state = json.load(f)
        with open(os.path.join(FIX, "autotrade_live_trades.jsonl"), encoding="utf-8") as f:
            self.trades = [json.loads(x) for x in f if x.strip()]
        shutil.copy(os.path.join(FIX, "autotrade_summary.json"), os.path.join(self.data, "latest", "summary.json"))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, state, trades) -> None:
        with open(os.path.join(self.data, "live", "state.json"), "w", encoding="utf-8") as f:
            json.dump(state, f, allow_nan=True)
        with open(os.path.join(self.data, "live", "trades.jsonl"), "w", encoding="utf-8") as f:
            for t in trades:
                f.write((json.dumps(t, allow_nan=True) if not isinstance(t, str) else t) + "\n")

    def test_fixtures_are_valid_and_match_the_server(self):
        self.write(self.state, self.trades)
        rep = at.status(self.data)
        self.assertIsNotNone(rep["live"])
        self.assertEqual(node_check([rep]), [])
        # Образец ответа для браузерного теста — то, что сервер отдаёт сейчас
        # из образцов файлов службы (без времени «жив/не жив» и сборки бэктеста).
        with open(os.path.join(FIX, "autotrade_live.json"), encoding="utf-8") as f:
            fixture = json.load(f)
        self.assertEqual(node_check([{**rep, "live": fixture}]), [])
        self.maxDiff = None
        self.assertEqual(at.live(self.data, now=FIXTURE_NOW), fixture,
                         "tests/fixtures/autotrade_live.json устарел — пересоберите из файлов службы")

    def test_spoiled_service_files_never_break_server_or_app(self):
        r = random.Random(20261121)  # noqa: S311 — генератор случаев
        replies = []
        for _ in range(CASES):
            state = self.state
            for _k in range(r.randint(1, 4)):
                state = spoil(r, state)
            trades = [spoil(r, t) if r.random() < 0.4 else t for t in self.trades]
            if r.random() < 0.2:
                trades.append(r.choice(["{bad", "[]", "null", '{"pnl": NaN}']))
            self.write(state, trades)
            replies.append(at.status(self.data))
        bad = node_check(replies)
        self.assertEqual(bad[:3], [], f"вкладка отвергла ответ сервера: {replies[bad[0]] if bad else ''}")
        # Генератор не пустой: часть ответов — с позицией, часть — без «live» вовсе.
        self.assertTrue(any(x["live"] and x["live"]["open"] for x in replies))

    def test_garbage_replies_are_rejected(self):
        self.write(self.state, self.trades)
        good = at.status(self.data)
        r = random.Random(7)  # noqa: S311 — генератор случаев
        spoiled = [spoil(r, good) for _ in range(300)]
        spoiled += [None, [], "ok", {"ok": True}, {**good, "ok": False}, {**good, "on": "yes"},
                    {**good, "live": {**good["live"], "stats": {**good["live"]["stats"], "net": "1"}}},
                    {**good, "live": {**good["live"], "open": {**good["live"]["open"], "px": None}}},
                    {**good, "backtest": {**good["backtest"], "equity": [[1, "x"]]}}]
        rejected = set(node_check(spoiled))
        for i in range(300, len(spoiled)):
            self.assertIn(i, rejected, f"мусор принят: {json.dumps(spoiled[i])[:200]}")
        # Случайная порча иногда безвредна (испорчено поле, которого нет в
        # договоре) — но большинство отвергается.
        self.assertGreater(len(rejected), 150)


if __name__ == "__main__":
    unittest.main()
