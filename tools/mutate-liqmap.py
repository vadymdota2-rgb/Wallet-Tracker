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
    ("    (75, 0.07, 3), (100, 0.08, 3),", "    (75, 0.07, 3), (100, 0.18, 3),", "доли плеч — в сумме 1"),
    ("    (125, 0.03, 4), (200, 0.02, 4), (500, 0.01, 4),", "    (125, 0.03, 3), (200, 0.02, 4), (500, 0.01, 4),", "125× — в группе 125–500×"),
    ("    return min(MMR, 0.5 / lev)", "    return MMR", "маржа меньше начальной"),
    ("    return min(MMR, 0.5 / lev)", "    return min(MMR, 1 / lev)", "маржа — половина начальной"),
    ("    (20, 0.14, 1), (25, 0.14, 1),", "    (20, 0.14, 0), (25, 0.14, 1),", "плечо — в своей группе"),
    ("MMR = 0.005", "MMR = 0.05", "поддерживающая маржа"),
    ("ENTRY = 5", "ENTRY = 1", "вход — по диапазону свечи"),
    ("p = low + (hi - low) * (e + 0.5) / ENTRY", "p = low + (hi - low) * e / ENTRY", "точки входа — по середине долей"),
    ("part = x * w / ENTRY", "part = x * w", "прирост делится между точками входа"),
    ("            keep = 1 / lev - mmr(lev)", "            keep = 1 / lev + mmr(lev)", "до ликвидации — начальная минус поддерживающая"),
    ("bl = int((p * (1 - keep) - lo) // step)", "bl = int((p * (1 + keep) - lo) // step)", "цена ликвидации лонга"),
    ("bsh = int((p * (1 + keep) - lo) // step)", "bsh = int((p * (1 - keep) - lo) // step)", "цена ликвидации шорта"),
    ("entries.append((0, g, bl, part * share))", "entries.append((0, g, bl, part * (1 - share)))", "лонги — доля покупок"),
    ("entries.append((1, g, bsh, part * (1 - share)))", "entries.append((1, g, bsh, part * share))", "шорты — доля продаж"),
    ("share = min(1.0, max(0.0, bs))", "share = bs", "доля покупок — в пределах 0–1"),
    ("            if 0 <= bl < BUCKETS:\n", "            if 0 < bl < BUCKETS:\n", "нижняя корзина окна"),
    ("                out += part * share\n", "                pass\n", "лонги за краем окна — в счёт"),
    ("                out += part * (1 - share)\n", "                pass\n", "шорты за краем окна — в счёт"),
    ("mass = c[1] * (sum(x[3] for x in live) + c[3])", "mass = c[1] * sum(x[3] for x in live)", "закрытия — и тех, что за краем"),
    ("cut_l, cut_s = bisect.bisect_left(mids, low), bisect.bisect_right(mids, hi)\n        gone", "cut_l, cut_s = BUCKETS, bisect.bisect_right(mids, hi)\n        gone", "свеча сжигает лонги"),
    ("cut_l, cut_s = bisect.bisect_left(mids, low), bisect.bisect_right(mids, hi)\n        gone", "cut_l, cut_s = bisect.bisect_left(mids, low), 0\n        gone", "свеча сжигает шорты"),
    ("                    mark[b] = at\n", "", "сгоревшие пачки не живы"),
    ("        return [x for x in c[2] if burnt[x[0]][x[1]][x[2]] <= c[0]]", "        return list(c[2])", "живые — только не сгоревшие позже"),
    ("        return [x for x in c[2] if burnt[x[0]][x[1]][x[2]] <= c[0]]", "        return [x for x in c[2] if burnt[x[0]][x[1]][x[2]] < c[0]]", "сгорело до открытия — пачка жива"),
    ("_, hi, low, p_now, _oi, bs = rows[i - 1]", "_, hi, low, p_now, _oi, bs = rows[i]", "прирост — в свече между снимками"),
    ("        p_prev = rows[i - 2][3]\n", "        p_prev = p_now\n", "интерес — в монетах по цене снимка"),
    ("q_prev, q_now = rows[i - 1][4] / p_prev, rows[i][4] / p_now", "q_prev, q_now = rows[i - 1][4], rows[i][4]", "интерес — в монетах, а не в долларах"),
    ("        x = q_now - q_prev + burn(i, hi, low)", "        burn(i, hi, low)\n        x = q_now - q_prev", "сгоревшее замещается новыми"),
    ("            close(-x)\n", "            pass\n", "падение интереса закрывает позиции"),
    ("            c = cohorts[-1]\n", "            c = cohorts[0]\n", "закрываются самые свежие"),
    ("            keep = 1 - amount / mass\n", "            keep = 0.0\n", "пачка закрывается на долю"),
    ("            c[1] *= keep\n", "", "доля пачки запоминается"),
    ("    for i in range(2, len(rows)):", "    for i in range(3, len(rows)):", "первый шаг — со второго снимка"),
    ("        burn(len(rows), rows[-1][1], rows[-1][2])", "        pass", "идущая свеча сжигает уровни"),
    ("SMOOTH = (0.25, 0.5, 0.25)", "SMOOTH = (0.0, 1.0, 0.0)", "сглаживание соседей"),
    ("a[max(0, i - 1)]", "a[i - 1]", "сглаживание: левый край без потерь"),
    ("    if tail[0][0] > cut:\n        return main\n", "", "хвост дотягивается до идущей свечи"),
    ("[r for r in main if r[0] < cut] + [r for r in tail if r[0] >= cut]", "main + [r for r in tail if r[0] > cut]", "хвост заменяет идущую свечу"),
    # Ответ.
    ("lv = [round(st[\"L\"][g][b] * m) if b < cut_l else 0 for g in range(g_n)]", "lv = [round(st[\"L\"][g][b] * m) for g in range(g_n)]", "лонги ниже цены"),
    ("sv = [round(st[\"S\"][g][b] * m) if b >= cut_s else 0 for g in range(g_n)]", "sv = [round(st[\"S\"][g][b] * m) for g in range(g_n)]", "шорты выше цены"),
    ("lv = [round(st[\"L\"][g][b] * m) if b < cut_l", "lv = [round(st[\"L\"][g][b]) if b < cut_l", "доллары — монеты × цена"),
    ("    low, high = min(st[\"low\"], px), max(st[\"high\"], px)\n", "    low, high = st[\"low\"], st[\"high\"]\n", "сгорает и по самой цене"),
    ("        if sum(lv) + sum(sv) >= 1:\n", "        if True:\n", "пустые корзины не отдаются"),
    ("return sum(sum(lv) for p, lv, _ in rows_out if far <= p < px)", "return sum(sum(lv) for p, lv, _ in rows_out if p < px)", "накопленное — до своего процента"),
    ("lo, step = px * (1 - SPAN), px * SPAN * 2 / BUCKETS", "lo, step = px * (1 - SPAN), px * SPAN / BUCKETS", "окно — ±SPAN"),
    ("    if path[-1] != px:\n        path.append(px)\n", "", "путь цены кончается ценой"),
    ("ohlc[-1] = [o, round(max(h, px), 10), round(min(lw, px), 10), round(px, 10)]", "ohlc[-1] = [o, h, lw, _c]", "последняя свеча — до текущей цены"),
    ("\"oi\": round(sum(r[-1][4] for r in got.values()))", "\"oi\": round(sum(r[0][4] for r in got.values()))", "интерес — последний"),
    ("\"seen\": min(st[\"seen\"], st[\"oi\"])", "\"seen\": st[\"oi\"]", "сколько видно — по модели"),
    ("\"seen\": round(seen * px)", "\"seen\": round(seen)", "видно — в долларах"),
    ("prev = rows[0][3]", "prev = rows[0][1]", "свеча: открытие — закрытие прошлой"),
    ("k = max(1, -(-len(rows) // n))", "k = max(1, len(rows) // n)", "свечей не больше n"),
    ("\"low\": min(px, ref[-1][2]), \"high\": max(px, ref[-1][1])", "\"low\": px, \"high\": px", "ход идущей свечи — сгорел"),
    # Живая цена.
    ("abs(p / base - 1) <= PX_GAP", "abs(p / base - 1) <= 1", "чужая цена не берётся"),
    ("and not isinstance(p, bool) and abs(", "and abs(", "True — не цена"),
    ("    except Exception:  # noqa: BLE001 — сбой источника цены не ломает карту: цена сборки\n        p = None", "    except ZeroDivisionError:  # noqa: BLE001 — сбой источника цены не ломает карту: цена сборки\n        p = None", "сбой цены не ломает карту"),
    ("    if res[\"px\"] == px:\n        return res\n", "", "та же цена — тот же ответ"),
    ("    st[\"low\"], st[\"high\"] = min(st[\"low\"], px), max(st[\"high\"], px)\n", "", "сгоревшее не воскресает"),
    ("    px = _live(sym, ref[-1][3])\n", "    px = ref[-1][3]\n", "цена сборки — текущая"),
    ("    px = _live(key[0], base)", "    px = base", "между сборками — текущая цена"),
    # Хвост.
    ("    if gather is not None and rng in TAIL:", "    if False:", "длинные окна — с хвостом"),
    ("                tail.update(fn(sym, *TAIL[rng])[0])", "                tail.update(fn(sym, *TAIL[rng])[0]) if False else None", "хвост — в модель"),
    ("            except Exception:  # noqa: BLE001 — хвоста нет — окно без него, как раньше", "            except ZeroDivisionError:  # noqa: BLE001 — хвоста нет — окно без него, как раньше", "сбой хвоста не ломает карту"),
    # Кэш и сборка.
    ('SYM = re.compile(r"[A-Z0-9]{1,12}")', 'SYM = re.compile(r".{1,12}")', "монета — только буквы и цифры"),
    ("    if not s or rng not in RANGES:\n", "    if not s:\n", "окно — только известное"),
    ("if hit is None or time.monotonic() - hit[0] >= TTL[key[1]] else None", "if True else None", "свежая сборка — без пересборки"),
    ("if hit is None or time.monotonic() - hit[0] >= TTL[key[1]] else None", "if hit is None or time.monotonic() - hit[0] >= 120 else None", "срок — своего окна"),
    ("        if not hit or time.monotonic() - hit[0] >= STALE:\n", "        if not hit:\n", "слишком старая — не отдаётся"),
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
    ("        if (hit and time.monotonic() - hit[0] < TTL[rng] - 60) or key in _st.jobs:", "        if key in _st.jobs:", "прогрев не трогает свежую"),
    ("        if (hit and time.monotonic() - hit[0] < TTL[rng] - 60) or key in _st.jobs:", "        if hit and time.monotonic() - hit[0] < TTL[rng] - 60:", "прогрев не дублирует сборку"),
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
