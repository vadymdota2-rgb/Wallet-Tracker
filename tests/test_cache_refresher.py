"""Кэш разделов обновляется сам (whale_api.cache_refresher), а не запросом человека.

Халвинг, страх и жадность, альтсезон, доминация, ETF и рынки в меню: раз в CACHE_TICK
сервер спрашивает каждый модуль, и ответ старше своего TTL модуль
пересобирает в фоне. Человек всегда берёт готовый кэш.
"""
import inspect
import io
import os
import sys
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модуль лежит в корне репозитория
import wt_halving  # noqa: E402


class _Stop(Exception):
    pass


def one_tick(asked: dict, raising: str = "") -> str:
    """Один круг cache_refresher с подменёнными модулями; вернёт журнал."""
    def make(name):
        def ask(wait=None):
            asked[name] = wait
            if name == raising:
                raise RuntimeError("boom")
            return {"ok": True}
        return ask
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        if len(sleeps) > 1:
            raise _Stop
    err = io.StringIO()
    with mock.patch.object(api, "halving_data", make("halving")), mock.patch.object(api, "fng_data", make("fng")), \
            mock.patch.object(api, "dom_data", make("dom")), mock.patch.object(api, "mcap_data", make("mcap")), \
            mock.patch.object(api, "etf_data", make("etf")), mock.patch.object(api, "markets_refresh", make("markets")), \
            mock.patch.object(api, "screener_refresh", make("screener")), mock.patch.object(api.time, "sleep", sleep), \
            mock.patch("sys.stderr", err), unittest.TestCase().assertRaises(_Stop):
        api.cache_refresher()
    if sleeps != [5, api.CACHE_TICK]:
        raise AssertionError(sleeps)
    return err.getvalue()


class CacheRefresherTest(unittest.TestCase):
    def test_every_section_is_asked_each_tick_without_waiting_for_the_build(self):
        asked: dict = {}
        self.assertEqual(one_tick(asked), "")
        self.assertEqual(set(asked), {"halving", "fng", "dom", "mcap", "etf", "markets", "screener"})
        # Модули с ожиданием холодной сборки — без ожидания: поток сам не
        # ждёт, сборка идёт в фоне.
        self.assertEqual((asked["fng"], asked["dom"], asked["mcap"]), (0, 0, 0))
        self.assertEqual(api.CACHE_TICK, 60.0)

    def test_one_failing_section_does_not_stop_the_others(self):
        asked: dict = {}
        log = one_tick(asked, raising="dom")
        self.assertEqual(set(asked), {"halving", "fng", "dom", "mcap", "etf", "markets", "screener"})
        self.assertIn("обновление кэша dom: RuntimeError: boom", log)

    def test_runs_in_its_own_thread_not_in_the_long_liquidation_round(self):
        warm = inspect.getsource(api.warmup)
        self.assertIn('threading.Thread(target=cache_refresher, daemon=True, name="cache").start()', warm)
        liq = inspect.getsource(api.liq_warm_refresher)
        for fn in ("fng_data", "dom_data", "mcap_data", "etf_data", "halving_data", "markets_refresh", "screener_refresh"):
            self.assertNotIn(fn, liq, fn)

    def test_stale_halving_is_rebuilt_by_the_refresher_not_by_a_person(self):
        # Ответ старше TTL, запросов нет: круг обновления сам запускает сборку.
        old = {"ok": True, "height": 1, "at": int(time.time())}
        st = wt_halving._State()
        st.hit = (time.monotonic() - wt_halving.TTL - 1, old)
        built = []
        with mock.patch.object(wt_halving, "_st", st), \
                mock.patch.object(wt_halving, "build", lambda: built.append(1) or old):
            wt_halving._busy.clear()
            self.assertIs(api._cache_modules()[0][1](), old)
            for _ in range(200):
                if built and not wt_halving._busy.is_set():
                    break
                time.sleep(0.01)
        self.assertEqual(built, [1])


if __name__ == "__main__":
    unittest.main()
