"""Разбор переводов хранилищ по корзинам фондов (wt_etfchain, npm test).

Синтетика с известным ответом: два фонда с разными корзинами, которые тают
каждый на свою комиссию; новые деньги идут через общий расчётный узел
хранителя; вокруг — случайные переводы, которые не должны прилипнуть ни к
одному фонду.
"""
import os
import random
import sqlite3
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_etfchain as w  # noqa: E402 — модуль лежит в корне репозитория

SAT = w.SAT
D0 = 20_700  # сутки от 1970-01-01


def basket(q0: int, fee: float, day: int) -> int:
    return round(q0 * (1 - fee / 365 * (day - D0)))


class Market:
    def __init__(self, seed: int = 7) -> None:
        self.rnd = random.Random(seed)  # noqa: S311 — синтетика, не криптография
        self.xs: list[w.Xfer] = []

    def fund(self, q0: int, fee: float, vaults: list[str], days: range, via: tuple[str, str]) -> None:
        """Фонд: корзина q0, комиссия fee; via — (узел хранителя, участник)."""
        hub, ap = via
        for d in days:
            q = basket(q0, fee, d)
            for _ in range(self.rnd.randint(1, 3)):
                k = self.rnd.randint(2, 60)
                v = self.rnd.choice(vaults)
                if self.rnd.random() < 0.7:
                    # Создание: участник → узел → хранилище фонда, та же сумма.
                    self.xs.append(w.Xfer(d, k * q, ap, hub, False, True))
                    self.xs.append(w.Xfer(d, k * q, hub, v, True, True))
                else:
                    # Погашение: хранилище фонда → наружу.
                    self.xs.append(w.Xfer(d, k * q, v, "3Out" + ap, True, False))

    def noise(self, n: int, days: range, vaults: list[str]) -> None:
        for _ in range(n):
            v = self.rnd.randint(SAT // 2, 500 * SAT)
            self.xs.append(w.Xfer(self.rnd.choice(days), v, "1Rnd", self.rnd.choice(vaults), False, True))


class EtfChainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.m = Market()
        self.days = range(D0, D0 + 40)
        self.a = [f"bc1qa{i}" for i in range(4)]
        self.b = [f"bc1qb{i}" for i in range(3)]
        self.m.fund(542_593_761, 0.0020, self.a, self.days, ("bc1qhub", "3APa"))
        self.m.fund(2_263_118_413, 0.0150, self.b, self.days, ("bc1qhub", "3APb"))
        self.m.noise(150, self.days, [f"bc1qn{i}" for i in range(30)])
        self.res = w.analyse(self.m.xs)

    def fund_of(self, vault: str) -> int:
        return self.res.owner[vault]

    def test_vaults_split_by_fund(self) -> None:
        fa = {self.fund_of(v) for v in self.a}
        fb = {self.fund_of(v) for v in self.b}
        self.assertEqual(len(fa), 1)
        self.assertEqual(len(fb), 1)
        self.assertNotEqual(fa, fb)

    def test_hub_and_noise_owned_by_nobody(self) -> None:
        self.assertIn("bc1qhub", self.res.hubs)
        self.assertNotIn("bc1qhub", self.res.owner)
        noise = [a for a in self.res.owner if a.startswith("bc1qn")]
        self.assertEqual(noise, [])

    def test_fee_from_basket_decay(self) -> None:
        fee_a = self.res.funds[self.fund_of(self.a[0])].fee_year()
        fee_b = self.res.funds[self.fund_of(self.b[0])].fee_year()
        self.assertAlmostEqual(fee_a or 0.0, 0.20, delta=0.02)
        self.assertAlmostEqual(fee_b or 0.0, 1.50, delta=0.05)

    def test_flows_match_truth(self) -> None:
        k = self.fund_of(self.a[0])
        got = self.res.days[k]
        want: dict[int, list[float]] = {}
        for x in self.m.xs:
            if x.dst in self.a and x.src == "bc1qhub":
                want.setdefault(x.day, [0.0, 0.0])[0] += x.sats / SAT
            if x.src in self.a:
                want.setdefault(x.day, [0.0, 0.0])[1] += x.sats / SAT
        for d, (i, o) in want.items():
            self.assertAlmostEqual(got[d][0], i, places=6)
            self.assertAlmostEqual(got[d][1], o, places=6)

    def test_roundish(self) -> None:
        self.assertTrue(w.roundish(700 * SAT - 62_200))  # 700 BTC без комиссии сети
        self.assertTrue(w.roundish(300 * SAT))
        self.assertFalse(w.roundish(542_593_761))

    def test_build_names_published_fund(self) -> None:
        con = sqlite3.connect(":memory:")
        con.executescript(
            "CREATE TABLE btc_cust_xfer (txid TEXT, n INTEGER, height INTEGER, ts INTEGER, src TEXT, dst TEXT,"
            " sats INTEGER, sv INTEGER, dv INTEGER);"
            "CREATE TABLE btc_etf_addr (address TEXT PRIMARY KEY, fund TEXT, how TEXT);")
        con.executemany(
            "INSERT INTO btc_cust_xfer VALUES('t', 0, 0, ?, ?, ?, ?, ?, ?)",
            [(x.day * w.DAY, x.src, x.dst, x.sats, int(x.sv), int(x.dv)) for x in self.m.xs])
        con.execute("INSERT INTO btc_etf_addr VALUES(?, 'BITB', 'seed')", (self.a[0],))
        out = w.build(con, (D0 + 40) * w.DAY, 60)
        names = [r["t"] for r in out]
        self.assertIn("BITB", names)
        self.assertEqual(sum(1 for n in names if str(n).startswith("#")), len(names) - 1)
        bitb = next(r for r in out if r["t"] == "BITB")
        self.assertEqual(bitb["vaults"], 4)
        self.assertAlmostEqual(float(bitb["fee"]), 0.20, delta=0.02)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
