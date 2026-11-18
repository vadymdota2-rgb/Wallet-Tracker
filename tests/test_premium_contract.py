"""Договор оплаты Премиума с ботом (npm test).

Счёт выставляет API, проверяет оплату и выдаёт Премиум бот (репозиторий
WhaleScanner, premium_logic.h и premium.cpp). Если цена, срок, формат
вводной цены, памятки, кошелёк или столбцы счёта у них разойдутся, оплата
молча перестанет засчитываться. Обе стороны сверяют свои константы с одним
файлом — tests/fixtures/premium_contract.json (тот же в боте).
"""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402

with open(os.path.join(ROOT, "tests", "fixtures", "premium_contract.json"), encoding="utf-8") as _f:
    C = json.load(_f)
with open(os.path.join(ROOT, "whale_api.py"), encoding="utf-8") as _f:
    SRC = _f.read()


class ContractTest(unittest.TestCase):
    def test_star_plans(self):
        got = [{"plan": k, "payload": v["payload"], "stars": v["stars"], "days": v["days"]} for k, v in api.STAR_PLANS.items()]
        self.assertEqual(sorted(got, key=lambda p: p["plan"]), sorted(C["star_plans"], key=lambda p: p["plan"]))

    def test_intro_payload_and_window(self):
        self.assertEqual(api.INTRO_WINDOW_SEC, C["intro_window_sec"])
        self.assertIn('payload = f"{payload}:{chat}:{until}"', SRC)
        self.assertEqual(C["intro_payload"], "premium_30_intro:<chat_id>:<until_unix>")

    def test_usdt_plans_and_units(self):
        u = C["usdt"]
        self.assertEqual(sorted((k, v["days"]) for k, v in api.USDT_PLANS.items()), sorted((p["plan"], p["days"]) for p in u["plans"]))
        self.assertEqual(api.USDT_DECIMALS, u["decimals"])
        for p in api.USDT_PLANS.values():  # счёт не дешевле доллара — дешевле бот не примет
            self.assertGreaterEqual(round(p["usdt"] * 10 ** api.USDT_DECIMALS), u["min_units"])
        self.assertEqual(api.USDT_MASTER_UI, u["master_ui"])
        self.assertEqual(api.PAY_TTL, u["invoice_shown_sec"])

    def test_wallet_default_and_env(self):
        u = C["usdt"]
        self.assertIn(f'os.environ.get("{u["wallet_env"]}"', SRC)
        self.assertIn(f'or "{u["wallet_default"]}")', SRC)
        src_default = re.search(r'TON_WALLET = \(os\.environ\.get\("TON_WALLET_ADDRESS", ""\)\.strip\(\)\s+or "([^"]+)"\)', SRC)
        self.assertIsNotNone(src_default)
        self.assertEqual(src_default.group(1), u["wallet_default"])

    def test_memo_format(self):
        rx = re.compile(C["usdt"]["memo_regex"])
        for _ in range(2000):
            self.assertRegex(api.pay_memo(), rx)

    def test_invoice_columns(self):
        m = re.search(r"INSERT INTO ton_invoices\(([^)]*)\)", SRC)
        self.assertIsNotNone(m)
        self.assertEqual([c.strip() for c in m.group(1).split(",")], C["ton_invoices"]["api_writes"])
        self.assertIn("'usdt'", SRC[m.start():m.start() + 200])
        self.assertEqual(C["usdt"]["kind"], "usdt")

    def test_same_file_in_the_bot_when_both_are_here(self):
        """Рядом лежит репозиторий бота (так у разработчика) — файлы совпадают
        байт в байт. В CI репозитория бота нет — проверка пропускается."""
        bot = os.path.join(os.path.dirname(ROOT), "WhaleScanner", "tests", "fixtures", "premium_contract.json")
        if not os.path.exists(bot):
            self.skipTest("репозитория бота рядом нет")
        with open(bot, "rb") as a, open(os.path.join(ROOT, "tests", "fixtures", "premium_contract.json"), "rb") as b:
            self.assertEqual(a.read(), b.read())


if __name__ == "__main__":
    unittest.main()
