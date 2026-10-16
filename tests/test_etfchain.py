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



class NamesTest(unittest.TestCase):
    """Имя группе — по сверке её потоков в цепочке с ежедневными потоками
    фондов: в цепочке деньги приходят на следующий рабочий день (T+1)."""

    # 2026-09-14 — понедельник; 20_710 — сутки этой даты.
    MON = 20_710

    def test_settle_next_business_day(self) -> None:
        self.assertEqual(w.settle_day(self.MON), self.MON + 1)  # пн → вт
        self.assertEqual(w.settle_day(self.MON + 4), self.MON + 7)  # пт → пн
        self.assertEqual(w.settle_day(self.MON + 3), self.MON + 4)  # чт → пт

    def fund(self, flows: dict[int, float]) -> dict[int, float | None]:
        return {self.MON + d: v for d, v in flows.items()}

    def chain_of(self, fund: dict[int, float | None], noise: float = 0.0) -> dict[int, float]:
        out: dict[int, float] = {}
        for d, v in fund.items():
            if v:
                out[w.settle_day(d)] = v * (1 + noise)
        return out

    def setUp(self) -> None:
        self.funds = {
            "BITB": self.fund({0: 183.0, 2: -161.0, 4: 127.0, 7: 266.0, 10: -140.0, 11: 0.0}),
            "IBIT": self.fund({0: 1445.0, 1: -248.0, 3: 1749.0, 4: -2069.0, 8: 4700.0, 9: 1930.0}),
            "GBTC": self.fund({1: -300.0, 2: -150.0, 8: -90.0, 9: -210.0}),
            "ARKB": self.fund({0: None, 3: 80.0, 4: 0.0, 11: -45.0}),  # type: ignore[dict-item]
        }
        self.fees: dict[str, float | None] = {"BITB": 0.2, "IBIT": 0.25, "GBTC": 1.5, "ARKB": 0.21}
        self.window = (self.MON, self.MON + 14)

    def group(self, name: str, chain: dict[int, float], fee: float | None) -> dict[str, object]:
        return {"t": name, "fee": fee, "days": [[d * w.DAY, max(v, 0.0), max(-v, 0.0)] for d, v in chain.items()]}

    def test_flow_err(self) -> None:
        chain = self.chain_of(self.funds["IBIT"], noise=0.02)
        err, days = w.flow_err(chain, self.funds["IBIT"], self.window)
        self.assertLess(err, 0.02)
        self.assertEqual(days, 6)
        err, _ = w.flow_err(chain, self.funds["GBTC"], self.window)
        self.assertGreater(err, 0.8)

    def test_names_by_flows(self) -> None:
        groups = [
            self.group("#aaaa", self.chain_of(self.funds["IBIT"], 0.03), 0.249),
            self.group("#bbbb", self.chain_of(self.funds["GBTC"], -0.02), 1.49),
            self.group("#cccc", {self.MON + 5: 77.0, self.MON + 6: -12.0}, None),  # чужой клиент хранителя
            self.group("BITB", self.chain_of(self.funds["BITB"]), 0.18),
        ]
        got = w.match_names(groups, self.funds, self.fees, {"BITB"}, self.window)
        self.assertEqual(got, {"#aaaa": "IBIT", "#bbbb": "GBTC"})

    def test_fee_must_agree(self) -> None:
        groups = [self.group("#aaaa", self.chain_of(self.funds["IBIT"]), 1.5)]
        self.assertEqual(w.match_names(groups, self.funds, self.fees, set(), self.window), {})

    def test_too_few_days(self) -> None:
        short = (self.MON, self.MON + 2)
        groups = [self.group("#aaaa", self.chain_of(self.funds["IBIT"]), None)]
        self.assertEqual(w.match_names(groups, self.funds, self.fees, set(), short), {})

    def test_taken_fund_not_reused(self) -> None:
        groups = [self.group("#aaaa", self.chain_of(self.funds["BITB"]), 0.2)]
        self.assertEqual(w.match_names(groups, self.funds, self.fees, {"BITB"}, self.window), {})

    def test_fund_series(self) -> None:
        reply = {"coins": {"btc": {
            "funds": [{"t": "IBIT", "fee": 0.25}, {"t": "GBTC", "fee": 1.5}],
            "days": [[self.MON * w.DAY, 0, 0, 100_000.0, [1_000, None]], [(self.MON + 1) * w.DAY, 0, 0, 0, [5, 7]]],
        }}}
        days, fees = w.fund_series(reply)
        self.assertEqual(days["IBIT"][self.MON], 10.0)  # 1 000 тыс. $ по 100 000 $ = 10 BTC
        self.assertIsNone(days["GBTC"][self.MON])
        self.assertIsNone(days["IBIT"][self.MON + 1])  # без цены — не знаем
        self.assertEqual(fees, {"IBIT": 0.25, "GBTC": 1.5})
        self.assertEqual(w.fund_series({}), ({}, {}))


if __name__ == "__main__":
    unittest.main()
