"""Мутационная проверка карты ликвидаций: python3 tools/mutate-liqmap.py

Как у остальных модулей: портим wt_liqmap.py по одному месту (граница,
знак, константа, защита кэша) и гоняем tests.test_liqmap. Убитая мутация —
тесты заметили порчу; выжившая — дыра в тестах. Файл после каждой мутации
возвращается как был.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EQUIV: set[str] = set()
PY = [
    # Модель.
    ("    (75, 0.08, 3), (100, 0.10, 3),", "    (75, 0.08, 3), (100, 0.20, 3),", "доли плеч — в сумме 1"),
    ("    (20, 0.14, 1), (25, 0.14, 1),", "    (20, 0.14, 0), (25, 0.14, 1),", "плечо — в своей группе"),
    ("MMR = 0.005", "MMR = 0.05", "поддерживающая маржа"),
    ("ENTRY = 5", "ENTRY = 1", "вход — по диапазону свечи"),
    ("p = low + (hi - low) * (e + 0.5) / ENTRY", "p = low + (hi - low) * e / ENTRY", "точки входа — по середине долей"),
    ("part = d * w / ENTRY", "part = d * w", "прирост делится между точками входа"),
    ("bl = int((p * (1 - 1 / lev + MMR) - lo) // step)", "bl = int((p * (1 - 1 / lev - MMR) - lo) // step)", "цена ликвидации лонга"),
    ("bsh = int((p * (1 + 1 / lev - MMR) - lo) // step)", "bsh = int((p * (1 + 1 / lev + MMR) - lo) // step)", "цена ликвидации шорта"),
    ("longs[g][bl] += part * share", "longs[g][bl] += part * (1 - share)", "лонги — доля покупок"),
    ("shorts[g][bsh] += part * (1 - share)", "shorts[g][bsh] += part * share", "шорты — доля продаж"),
    ("share = min(1.0, max(0.0, bs))", "share = bs", "доля покупок — в пределах 0–1"),
    ("    if 0 <= bl < BUCKETS:\n", "    if 0 < bl < BUCKETS:\n", "нижняя корзина окна"),
    ("cut_l = bisect.bisect_left(mids, low)\n", "cut_l = BUCKETS\n", "свеча сжигает лонги"),
    ("cut_s = bisect.bisect_right(mids, hi)\n", "cut_s = 0\n", "свеча сжигает шорты"),
    ("            k = max(0.0, oi / prev)", "            k = 0.0", "падение интереса — доля, а не всё"),
    ("            k = max(0.0, oi / prev)", "            k = 1.0", "падение интереса закрывает позиции"),
    ("    for i in range(1, len(rows)):", "    for i in range(2, len(rows)):", "первая свеча после опорной"),
    ("SMOOTH = (0.25, 0.5, 0.25)", "SMOOTH = (0.0, 1.0, 0.0)", "сглаживание соседей"),
    ("a[max(0, i - 1)]", "a[i - 1]", "сглаживание: левый край без потерь"),
    # Карта.
    ("cut_l, cut_s = bisect.bisect_left(mids, px), bisect.bisect_right(mids, px)", "cut_l, cut_s = BUCKETS, 0", "лонги ниже цены, шорты выше"),
    ("        if sum(lv) + sum(sv) >= 1:\n", "        if True:\n", "пустые корзины не отдаются"),
    ("return sum(sum(lv) for p, lv, _ in rows_out if far <= p < px)", "return sum(sum(lv) for p, lv, _ in rows_out if p < px)", "накопленное — до своего процента"),
    ("lo, step = px * (1 - SPAN), px * SPAN * 2 / BUCKETS", "lo, step = px * (1 - SPAN), px * SPAN / BUCKETS", "окно — ±SPAN"),
    ("    if path[-1] != px:\n        path.append(px)\n", "", "путь цены кончается ценой"),
    ('"oi": round(sum(r[-1][4] for r in got.values()))', '"oi": round(sum(r[0][4] for r in got.values()))', "интерес — последний"),
    ("prev = rows[0][3]", "prev = rows[0][1]", "свеча: открытие — закрытие прошлой"),
    ("k = max(1, -(-len(rows) // n))", "k = max(1, len(rows) // n)", "свечей не больше n"),
    # Кэш и сборка.
    ('SYM = re.compile(r"[A-Z0-9]{1,12}")', 'SYM = re.compile(r".{1,12}")', "монета — только буквы и цифры"),
    ("    if not s or rng not in RANGES:\n", "    if not s:\n", "окно — только известное"),
    ("        if hit and age is not None and age < TTL:\n            return hit[1]\n", "", "свежая карта — из памяти"),
    ("        if hit and age is not None and age < STALE:\n            return hit[1]\n", "", "устаревшая — сразу, пересчёт в фоне"),
    ("    if hit and time.monotonic() - hit[0] < STALE:\n        return hit[1]", "    if hit:\n        return hit[1]", "слишком старая — не отдаётся"),
    ("        job.join(wait)", "        job.join(0)", "холодный старт ждёт сборку"),
    ("    if fail is not None and time.monotonic() - fail < FAIL_WAIT:\n        return None\n", "", "пауза после сбоя"),
    ("    if len(_st.jobs) >= JOBS_MAX:\n        return None\n", "", "сборок одновременно — не больше JOBS_MAX"),
    ("    if job is not None:\n        return job\n    fail", "    fail", "одна сборка на карту"),
    ("            _st.fails[key] = time.monotonic()\n    finally:", "            pass\n    finally:", "падение сборки — пауза"),
    ("            _st.jobs.pop(key, None)\n", "            pass\n", "сборка снимается из списка"),
    ("        while len(_st.hits) > CACHE_MAX:\n", "        while False:\n", "кэш не растёт без конца"),
    ("min(_st.hits, key=lambda k: _st.hits[k][0])", "max(_st.hits, key=lambda k: _st.hits[k][0])", "вытесняется самая старая"),
    ("        _st.fails.pop(key, None)\n", "", "удачная сборка снимает паузу"),
    ('    return _no("building" if busy else "no_data" if failed else "busy")', '    return _no("building")', "ответ без карты — по причине"),
    ("        if (hit and time.monotonic() - hit[0] < TTL - 60) or key in _st.jobs:", "        if key in _st.jobs:", "прогрев не трогает свежую"),
    ("        if (hit and time.monotonic() - hit[0] < TTL - 60) or key in _st.jobs:", "        if hit and time.monotonic() - hit[0] < TTL - 60:", "прогрев не дублирует сборку"),
]


def run(path, cmd, muts):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    alive = []
    try:
        for a, b, name in muts:
            if src.count(a) != 1:
                sys.exit(f"мутация «{name}»: текст для замены найден {src.count(a)} раз — обновите список")
            with open(path, "w", encoding="utf-8") as f:
                f.write(src.replace(a, b))
            try:
                killed = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=180, check=False).returncode != 0
            except subprocess.TimeoutExpired:
                killed = True
            tag = "убита   " if killed else ("экв.    " if name in EQUIV else "ВЫЖИЛА  ")
            print(tag + name, flush=True)
            if not killed and name not in EQUIV:
                alive.append(name)
    finally:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
    return alive


alive = run(f"{ROOT}/wt_liqmap.py", [sys.executable, "-m", "unittest", "tests.test_liqmap"], PY)
total = len(PY) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
