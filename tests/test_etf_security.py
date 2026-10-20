"""Безопасность «Институциональных потоков»: отравленные источники (npm test).

Источники — чужие сайты. Если один из них взломают или подменят ответ по
дороге, худшее, что может случиться, — экран покажет «нет данных». Ни
чужой строки в ответе, ни зависшей сборки, ни падения, ни выхода в сеть
мимо списка адресов.
"""
import io
import json
import os
import sys
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import wt_etf as etf  # noqa: E402 — модуль лежит в корне репозитория

NOW = 1_792_000_000


def build(tftc: object, raw: bytes | None = None, sec: dict | None = None) -> dict:
    urls: list[str] = []

    def fetch(url, timeout):
        urls.append(url)
        if "tftc.io" in url:
            return raw if raw is not None else json.dumps(tftc).encode()
        return None

    hook = etf._st.on_new  # кому говорить о новых фондах — переживает сброс
    etf._st = etf._State()
    etf._st.on_new = hook
    with mock.patch.object(etf, "_fetch", fetch), mock.patch.object(etf, "_now", lambda: NOW), \
            mock.patch.object(etf.wt_treasury, "etf_funds", lambda: sec or {}), \
            mock.patch.object(etf.wt_treasury, "companies", list), mock.patch("sys.stderr", io.StringIO()):
        res = etf.build()
    res["_urls"] = urls
    return res


def strings(v: object) -> list[str]:
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        return [s for k, x in v.items() for s in strings(k) + strings(x)]
    if isinstance(v, list):
        return [s for x in v for s in strings(x)]
    return []


class PoisonTest(unittest.TestCase):
    def test_no_foreign_string_reaches_the_reply(self):
        evil = "<img src=x onerror=alert(1)>"
        poison = {"updatedThrough": evil, "license": evil, "days": [
            {"date": "2026-10-10", "netFlowUsd": 5e6, "btcCloseUsd": 60_000,
             "perEtfUsd": {"IBIT": 5e6, evil: 1e6, "javascript:alert(1)": 1e6, "IBIT\u202e": 1e6, "IB\u0130T": 1e6}},
            {"date": evil, "netFlowUsd": 5e6, "perEtfUsd": {"IBIT": 5e6}},
        ]}
        res = build(poison)
        self.assertTrue(res["ok"])
        got = set(strings({k: v for k, v in res.items() if k != "_urls"}))
        # Строки ответа — свои ключи, тикер IBIT, страна и пустые поля; ничего от источника.
        self.assertFalse([s for s in got if "<" in s or "alert" in s or "\u202e" in s or "\u0130" in s])
        self.assertEqual([f["t"] for f in res["coins"]["btc"]["funds"]], ["IBIT"])
        self.assertEqual(res["coins"]["btc"]["through"], "")

    def test_hostile_bodies_are_no_data_and_fast(self):
        for raw in (b"[" * 200_000 + b"]" * 200_000, b'{"days": [' + b'{"date": 1},' * 50_000 + b'1]}',
                    b'{"days": NaN}', b'{"days": [{"date": "2026-10-10", "netFlowUsd": 1e999}]}', b"\xff\xfe",
                    b'{"days": "' + b"x" * 1_000_000 + b'"}'):
            t0 = time.monotonic()
            res = build(None, raw=raw)
            self.assertLess(time.monotonic() - t0, 3.0, raw[:30])
            self.assertEqual({k: v for k, v in res.items() if k != "_urls"}, {"ok": False, "error": "no_data"}, raw[:30])

    def test_huge_integers_do_not_crash_the_build(self):
        # Целое в сотни цифр — валидный JSON, но float() от него бросает
        # OverflowError (не ValueError). Раньше это роняло разбор.
        huge = "1" + "0" * 400
        for field in ('"netFlowUsd": %s', '"btcCloseUsd": %s', '"totalNetAssetsUsd": %s', '"perEtfUsd": {"IBIT": %s}'):
            raw = ('{"days": [{"date": "2026-10-10", "netFlowUsd": 5e6, "perEtfUsd": {"FBTC": 5e6}}, {"date": "2026-10-09", '
                   + field % huge + "}]}").encode()
            res = build(None, raw=raw)
            self.assertFalse(res["ok"], field)
        # Даже если такое число дошло до разбора (копия на диске, другой путь) — это «не число».
        self.assertEqual(etf._num(10 ** 400), 0.0)
        self.assertEqual(etf._num(-(10 ** 400)), 0.0)
        # 18 цифр — ещё число, 19 — уже нет.
        self.assertEqual(etf._parse(b"[123456789012345678]"), [123456789012345678])
        self.assertIsNone(etf._parse(b"[1234567890123456789]"))
        self.assertIsNone(etf._parse(b"[-1234567890123456789]"))

    def test_thousands_of_tickers_are_refused(self):
        # Подменённый набор с тысячами тикеров раздул бы ответ API (дни × фонды)
        # и засыпал бы владельца сообщениями о «новых фондах».
        many = {f"F{i}": 1e6 for i in range(etf.FUNDS_MAX + 1)}
        told: list = []
        etf.set_new_fund_hook(told.append)
        self.addCleanup(etf.set_new_fund_hook, None)
        res = build({"days": [{"date": "2026-10-10", "netFlowUsd": 5e6, "perEtfUsd": many}]})
        self.assertFalse(res["ok"])
        # Тикеры поровну по дням — тоже не берём.
        days = [{"date": f"2026-10-{d:02d}", "perEtfUsd": {f"F{d}{i}": 1e6 for i in range(10)}} for d in range(1, 9)]
        self.assertFalse(build({"days": days})["ok"])
        self.assertEqual(told, [])
        # Ровно FUNDS_MAX — ещё набор.
        ok = {f"F{i}": 1e6 for i in range(etf.FUNDS_MAX)}
        self.assertTrue(build({"days": [{"date": "2026-10-10", "perEtfUsd": ok}]})["ok"])

    def test_new_fund_messages_are_capped_per_build(self):
        told: list = []
        etf.set_new_fund_hook(told.append)
        self.addCleanup(etf.set_new_fund_hook, None)
        per = {f"NEW{i}": 1e6 for i in range(10)}
        with mock.patch.object(etf, "_log") as log:
            build({"days": [{"date": "2026-10-10", "perEtfUsd": per}]})
        self.assertEqual(told, ["NEW0", "NEW1", "NEW2"])
        self.assertEqual(sum("новый фонд в наборе TFTC" in c.args[0] for c in log.call_args_list), 3)
        # Остальные не теряются: по три за следующие сборки, без повторов.
        for want in (["NEW3", "NEW4", "NEW5"], ["NEW6", "NEW7", "NEW8"], ["NEW9"], []):
            told.clear()
            etf._new_funds(set(per))
            self.assertEqual(told, want)

    def test_wrong_types_everywhere(self):
        for days in ([None, 1, "x", [], {"date": ["2026-10-10"]}, {"date": "2026-10-10", "perEtfUsd": "IBIT"}],
                     [{"date": "2026-10-10", "netFlowUsd": True, "perEtfUsd": {"IBIT": "5e6"}}]):
            res = build({"days": days})
            if res["ok"]:
                for d in res["coins"]["btc"]["days"]:
                    self.assertTrue(all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in d[1:4]))

    def test_only_listed_hosts_are_asked(self):
        res = build({"days": [{"date": "2026-10-10", "netFlowUsd": 5e6, "perEtfUsd": {"IBIT": 5e6}}]})
        for u in res["_urls"]:
            self.assertTrue(etf._allowed(u), u)
        with mock.patch.object(etf._opener, "open") as op:
            for url in ("https://www.tftc.io.evil.com/data.json", "http://www.tftc.io/bitcoin-etf-flows/data.json",
                        "https://user:pw@www.tftc.io/", "https://tftc.io/", "file:///etc/passwd", "https://169.254.169.254/"):
                self.assertIsNone(etf._fetch(url, 5), url)
            op.assert_not_called()

    def test_sec_names_are_cut_and_plain_text(self):
        # Имя фонда приходит из отчёта SEC: на экране оно — просто текст
        # (React не вставляет HTML), а в ответе — не длиннее 60 знаков.
        sec = {"IBIT": {"n": "<b>" + "x" * 500, "fee": None, "q": {1_782_777_600: [700_000.0, None]}}}
        res = build({"days": [{"date": "2026-10-10", "netFlowUsd": 5e6, "perEtfUsd": {"IBIT": 5e6}}]}, sec=sec)
        self.assertEqual(len(res["coins"]["btc"]["funds"][0]["n"]), 60)

    def test_poisoned_disk_copy_is_ignored(self):
        path = os.path.join(ROOT, "tests", "fixtures", "__etf_copy.json")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        etf.set_cache_file(path)
        self.addCleanup(etf.set_cache_file, None)
        for body in ('{"at": 1e999, "v": {"ok": true}}', '{"at": "x", "v": {"ok": true}}', '[1, 2]', '{"v": 5}'):
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            self.assertIsNone(etf._file_load(), body)


if __name__ == "__main__":
    unittest.main()
