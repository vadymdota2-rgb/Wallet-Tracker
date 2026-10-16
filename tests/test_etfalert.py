"""Алерты по биткоин-ETF: подписки, итог дня, движения в цепочке (npm test).

Проверяется модуль wt_etfalert без сети и без Telegram: отправка — список
писем, часы — параметр.
"""
import os
import sqlite3
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_etfalert as ea  # noqa: E402 — модуль лежит в корне репозитория

SAT = 100_000_000
DAY = 20_740 * 86400  # вторник
NOW = DAY + 86400 + 20 * 3600

BTC_SCHEMA = """
CREATE TABLE btc_blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, ts INTEGER NOT NULL,
  price_nanos INTEGER NOT NULL DEFAULT 0);
CREATE TABLE btc_etf_addr (address TEXT PRIMARY KEY, fund TEXT NOT NULL, how TEXT NOT NULL);
CREATE TABLE btc_etf_moves (id INTEGER PRIMARY KEY AUTOINCREMENT, txid TEXT NOT NULL, height INTEGER NOT NULL,
  ts INTEGER NOT NULL, fund TEXT NOT NULL, kind INTEGER NOT NULL, sats INTEGER NOT NULL, peer TEXT NOT NULL DEFAULT '');
CREATE TABLE btc_cust_xfer (txid TEXT NOT NULL, n INTEGER NOT NULL, height INTEGER NOT NULL, ts INTEGER NOT NULL,
  src TEXT NOT NULL, dst TEXT NOT NULL, sats INTEGER NOT NULL, sv INTEGER NOT NULL, dv INTEGER NOT NULL,
  PRIMARY KEY (txid, n));
CREATE TABLE btc_etf_learned (address TEXT PRIMARY KEY, fund TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0);
"""


def reply(per: list, total: float = 150_000.0) -> dict:
    """Ответ экрана ETF: последний день, итог и потоки фондов — $ тыс."""
    return {"coins": {"btc": {"funds": [{"t": "IBIT"}, {"t": "FBTC"}, {"t": "GBTC"}],
                              "days": [[DAY, total, 1820.5, 82_000, per]]}}}


class EtfAlertTest(unittest.TestCase):
    def setUp(self) -> None:
        self.con = sqlite3.connect(":memory:")
        ea.open_schema(self.con)
        self.btc = sqlite3.connect(":memory:")
        self.btc.executescript(BTC_SCHEMA)
        self.out: list[tuple[str, str]] = []
        self.ok = True

    def send(self, chat: str, text: str) -> bool:
        self.out.append((chat, text))
        return self.ok

    def sub(self, chat: str, fund: str, day: bool, chain: bool, **kw: float) -> dict:
        """Подписка; min — порог в BTC, at — когда подписался (по умолчанию три дня назад)."""
        body = {"fund": fund, "day": day, "chain": chain, "min": kw.get("mn", 0), "lang": "ru"}
        return ea.subs_set(self.con, chat, body, int(kw.get("at", NOW - 86400 * 3)))

    def run_at(self, t: int, rep: dict | None = None) -> int:
        return ea.check(self.con, self.btc, rep, self.send, t)

    # --- подписки ---------------------------------------------------------

    def test_subs_validation_and_off(self) -> None:
        self.assertEqual(self.sub("1", "ibit; drop", True, False)["error"], "bad_args")
        self.assertEqual(self.sub("1", "IBIT", True, False, mn=7)["error"], "bad_args")
        r = self.sub("1", "ibit", True, True)
        self.assertEqual(r["items"], [{"fund": "IBIT", "day": True, "chain": True, "min": 0.0}])
        r = self.sub("1", "IBIT", False, False)
        self.assertEqual(r["items"], [])

    def test_subs_limit(self) -> None:
        for i in range(ea.MAX_FUNDS):
            self.assertTrue(self.sub("1", f"F{i}", True, False)["ok"])
        self.assertEqual(self.sub("1", "ONEMORE", True, False)["error"], "limit")
        # Правка уже включённого — не новая строка.
        self.assertTrue(self.sub("1", "F0", False, True)["ok"])

    # --- итог дня ---------------------------------------------------------

    def test_day_waits_until_stable_then_once(self) -> None:
        self.sub("1", "*", True, False)
        rep = reply([120_000, 30_000, None])
        self.assertEqual(self.run_at(NOW, rep), 0)
        # Дошёл отчёт ещё одного фонда — день снова «свежий».
        rep = reply([120_000, 30_000, -12_000], total=138_000.0)
        self.assertEqual(self.run_at(NOW + 1800, rep), 0)
        self.assertEqual(self.run_at(NOW + 1800 + ea.STABLE, rep), 1)
        chat, text = self.out[0]
        self.assertEqual(chat, "1")
        self.assertIn("Итог дня: +$138M", text)
        self.assertIn("🟢 Приток: IBIT +$120M, FBTC +$30M", text)
        self.assertIn("🔴 Отток: GBTC -$12M", text)
        self.assertEqual(self.run_at(NOW + 7200 + ea.STABLE, rep), 0)

    def test_day_by_fund_and_no_double_with_all(self) -> None:
        self.sub("1", "GBTC", True, False)
        self.sub("2", "*", True, False)
        self.sub("2", "FBTC", True, False)
        rep = reply([120_000, 30_000, -400], total=149_600.0)
        self.run_at(NOW, rep)
        self.run_at(NOW + ea.STABLE, rep)
        texts = {c: [x for cc, x in self.out if cc == c] for c in ("1", "2")}
        self.assertEqual(len(texts["1"]), 1)
        self.assertIn("GBTC", texts["1"][0])
        self.assertIn("Отток: -$400K", texts["1"][0])
        # У второго итог всех фондов уже называет FBTC — отдельного письма нет.
        self.assertEqual(len(texts["2"]), 1)
        self.assertIn("FBTC +$30M", texts["2"][0])

    def test_day_settled_before_subscription_is_skipped(self) -> None:
        rep = reply([120_000, 30_000, None])
        self.run_at(NOW, rep)
        self.sub("1", "*", True, False, at=NOW + ea.STABLE + 60)
        self.assertEqual(self.run_at(NOW + ea.STABLE + 120, rep), 0)

    # --- цепочка ----------------------------------------------------------

    def chain_data(self) -> None:
        b = self.btc
        b.executemany("INSERT INTO btc_blocks VALUES(?, 'x', ?, ?)",
                      [(h, NOW - (972_010 - h) * 600, 82_000 * 10**9) for h in range(971_990, 972_011)])
        b.execute("INSERT INTO btc_etf_addr VALUES('bc1qbitb', 'BITB', 'seed')")
        b.executemany("INSERT INTO btc_etf_moves(txid, height, ts, fund, kind, sats) VALUES(?,?,?,?,?,?)", [
            ("a", 972_000, NOW - 6000, "BITB", 1, 200 * SAT),
            ("b", 972_000, NOW - 6000, "BITB", 1, 100 * SAT),   # тот же блок — одно письмо, 300 BTC
            ("c", 972_009, NOW - 600, "BITB", 2, 50 * SAT),     # отток в блоке под самым верхом — ждём
            ("d", 972_001, NOW - 5400, "BITB", 3, 5 * SAT),     # плата фонду — не движение
            ("e", 971_000, NOW - 86400, "BITB", 1, 999 * SAT),  # старое (догонка) — не новость
            ("f", 972_002, NOW - 4800, "#7", 1, 999 * SAT),     # группа без имени
        ])
        b.executemany("INSERT INTO btc_etf_learned VALUES(?, 'IBIT', 0)", [("bc1qv1",), ("bc1qv2",)])
        b.executemany("INSERT INTO btc_cust_xfer VALUES(?,0,?,?,?,?,?,1,1)", [
            ("x1", 972_003, NOW - 4200, "bc1qhub", "bc1qv1", 7 * 542_593_761),  # приток IBIT
            ("x2", 972_004, NOW - 3600, "bc1qv1", "bc1qv2", 3 * SAT),           # внутри фонда
            ("x3", 972_005, NOW - 3000, "bc1qv2", "bc1qhub", int(0.5 * SAT)),   # отток IBIT, мелкий
        ])

    def test_chain_events(self) -> None:
        self.chain_data()
        ev = ea.chain_events(self.btc, NOW)
        got = [(e["h"], e["fund"], e["dir"], round(e["btc"], 4)) for e in ev]
        self.assertEqual(got, [(972_000, "BITB", 1, 300.0), (972_003, "IBIT", 1, 37.9816),
                               (972_005, "IBIT", -1, 0.5)])

    def test_chain_alerts_threshold_fund_and_once(self) -> None:
        self.chain_data()
        self.sub("1", "*", False, True, mn=10)
        self.sub("2", "IBIT", False, True)
        self.sub("3", "BITB", True, False)  # только итог дня — движения не шлём
        self.assertEqual(self.run_at(NOW), 4)
        by = {}
        for c, x in self.out:
            by.setdefault(c, []).append(x)
        self.assertEqual(len(by["1"]), 2)  # BITB 300 и IBIT 38; отток 0,5 — ниже порога
        self.assertIn("⛓ BITB · блок 972\xa0000", by["1"][0])
        self.assertIn("Приток по цепочке: +300 BTC ≈ +$24,6M", by["1"][0])
        self.assertIn("https://mempool.space/block/972000", by["1"][0])
        self.assertEqual(len(by["2"]), 2)
        self.assertIn("Отток по цепочке: -0,5 BTC", by["2"][1])
        self.assertNotIn("3", by)
        self.assertEqual(self.run_at(NOW + 60), 0)

    def test_chain_before_subscription_and_retry(self) -> None:
        self.chain_data()
        self.sub("1", "*", False, True, at=NOW - 5000)  # подписался после блока 972 000
        self.ok = False
        self.assertEqual(self.run_at(NOW), 0)
        self.assertEqual(len(self.out), 2)
        self.ok = True
        self.assertEqual(self.run_at(NOW + 60), 2)
        self.assertEqual(self.run_at(NOW + 120), 0)

    def test_route(self) -> None:
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('if path == "/api/etfalert/list":', src)
        self.assertIn('if path == "/api/etfalert/set":', src)
        self.assertIn("threading.Thread(target=etfa_loop, daemon=True).start()", src)


if __name__ == "__main__":
    unittest.main()
