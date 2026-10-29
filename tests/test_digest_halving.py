"""Халвинг в выпуске дайджеста (whale_api._dg_halving, wt_digest_img): npm test.

Две вещи, которых раньше не было: подпись источника рядом с числом (правило
проекта, как у alternative.me и TFTC) и сборка сразу после перезапуска API —
холодный запрос ждёт не дольше COLD_WAIT, и без своей сборки раздел пропал
бы из выпуска на весь день.
"""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import whale_api as api  # noqa: E402 — модули лежат в корне репозитория
import wt_digest_img as dgi  # noqa: E402

TO = 1_791_900_000
OK = {"ok": True, "height": 971_219, "next": 1_050_000, "every": 210_000, "avg": 596.8,
      "eta": 1_838_896_423, "by": "mempool.space"}


class DigestHalvingTest(unittest.TestCase):
    def test_section_names_the_source(self):
        with mock.patch.object(api, "halving_data", lambda: dict(OK)):
            self.assertEqual(api._dg_halving(TO),
                             {"left": 78_781, "eta": 1_838_896_423, "next": 1_050_000, "by": "mempool.space"})

    def test_source_only_from_the_known_list(self):
        for by in ("evil.com", "", None, 5):
            with mock.patch.object(api, "halving_data", lambda by=by: {**OK, "by": by}):
                self.assertNotIn("by", api._dg_halving(TO), by)

    def test_cold_server_builds_the_section_itself(self):
        built = []
        with mock.patch.object(api, "halving_data", lambda: {"ok": False, "error": "no_data"}), \
                mock.patch.object(api.halving, "build", lambda: (built.append(1), dict(OK))[1]):
            self.assertEqual(api._dg_halving(TO)["left"], 78_781)
        self.assertEqual(built, [1])

    def test_no_data_anywhere_gives_no_section(self):
        nothing = {"ok": False, "error": "no_data"}
        with mock.patch.object(api, "halving_data", lambda: nothing), \
                mock.patch.object(api.halving, "build", lambda: nothing):
            self.assertIsNone(api._dg_halving(TO))

    def test_warm_answer_does_not_rebuild(self):
        with mock.patch.object(api, "halving_data", lambda: dict(OK)), \
                mock.patch.object(api.halving, "build", side_effect=AssertionError("лишняя сборка")):
            self.assertIsNotNone(api._dg_halving(TO))

    def test_channel_picture_signs_the_halving_row(self):
        rows = []
        real = dgi._Page.row

        def spy(page, label, *rest, **kw):
            sub = kw.get("sub", rest[2] if len(rest) > 2 else "")
            rows.append((label, sub))
            return real(page, label, *rest, **kw)

        it = {"v": 2, "to": TO, "cal": [{"k": "fomc", "t": TO + 86_400}],
              "halv": {"left": 78_781, "eta": 1_838_896_423, "next": 1_050_000, "by": "mempool.space"}}
        with mock.patch.object(dgi._Page, "row", spy):
            dgi._page_week(it, "en", 5, 5)
            subs = [sub for label, sub in rows if label == dgi.tr("en", "hv_title")]
            self.assertEqual(subs, ["in 78,781 blocks · mempool.space"])
            # Чужое имя источника на картинку не попадает.
            rows.clear()
            dgi._page_week({**it, "halv": {**it["halv"], "by": "evil.com"}}, "en", 5, 5)
            subs = [sub for label, sub in rows if label == dgi.tr("en", "hv_title")]
            self.assertEqual(subs, ["in 78,781 blocks"])


if __name__ == "__main__":
    unittest.main()
