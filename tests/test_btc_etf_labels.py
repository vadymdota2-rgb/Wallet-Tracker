"""Метки кошельков фондов в BTC (npm test): только подпись, без слежки.

Метки пишет бот (WhaleScanner/btc_etf.cpp): список, опубликованный фондом
(BITB), и разметка владельца через /import. API лишь подписывает такие
кошельки тикером в крупных сделках и рейтинге. Потоков фондов по цепочке,
«корзин» хранителя и сверки с «Институциональными потоками» больше нет:
потоки фондов приложение берёт из набора TFTC.
"""
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модуль лежит в корне репозитория
import wt_btc as btc  # noqa: E402


class BtcEtfLabelsTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE btc_etf_addr (address TEXT PRIMARY KEY, fund TEXT NOT NULL, how TEXT NOT NULL,"
                    " at INTEGER NOT NULL DEFAULT 0)")
        con.executemany("INSERT INTO btc_etf_addr(address, fund, how) VALUES(?,?,?)",
                        [("bc1qa", "BITB", "seed"), ("bc1qb", "IBIT", "import"), ("bc1qgroup", "#7", "import")])
        con.commit()
        con.close()

    def tearDown(self):
        os.unlink(self.db)

    def test_labeled_wallets_are_tagged_with_the_fund(self):
        ro = api.open_db(self.db)
        try:
            ex = btc._btc_extra(ro, ["bc1qa", "bc1qb", "bc1qgroup", "bc1qnone"])
        finally:
            ro.close()
        # Список фонда и /import — тикер; группа без имени и чужой адрес — без метки.
        self.assertEqual((ex["bc1qa"].get("etf"), ex["bc1qb"].get("etf")), ("BITB", "IBIT"))
        self.assertNotIn("etf", ex["bc1qgroup"])
        self.assertNotIn("etf", ex["bc1qnone"])

    def test_no_chain_tracking_of_funds(self):
        # Ни разбора корзин хранителя, ни сверки с потоками, ни записи в
        # базу бота: API базу биткоина только читает.
        with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as f:
            src = f.read()
        for word in ("etfchain", "_btc_custody_build", "_btc_check", "_btc_spread", "btc_etf_check", "btc_etf_import",
                     "btc_cust_", "btc_etf_flow", "/api/etf/chain", "BTC_CUST_TTL"):
            self.assertNotIn(word, src, word)
        self.assertFalse(os.path.exists(os.path.join(ROOT, "wt_etfchain.py")))


if __name__ == "__main__":
    unittest.main()
