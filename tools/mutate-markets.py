"""Мутационная проверка рынков в меню: python3 tools/mutate-markets.py

Как у халвинга: портим код по одному месту (граница, знак, константа,
защита) и гоняем тесты. Убитая мутация — тесты заметили порчу; выжившая —
дыра в тестах. Файл после каждой мутации возвращается как был — и после
прерывания тоже. Эквивалентные мутации (не меняют ничего наблюдаемого)
помечены и в счёт не идут.
"""
import os
import signal
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные:
#  - «только известные пункты» — неизвестный пункт и так не попадает в ответ
#    (ответ собирается по MARKET_KEYS), проверка лишь не держит его в памяти;
#  - «последняя из свечей» — свечей с одним временем Hyperliquid не отдаёт, а
#    при дубле любая из двух одинаково правдоподобна;
#  - «опоздавший источник не меняет ответ» — сборка читает ответы только по
#    имени (get), а не перебором: копия — для порядка, не для поведения.
EQUIV = {"только известные пункты", "последняя из свечей",
         "опоздавший источник не меняет ответ"}
PY = [
    # Разбор чисел и пар.
    ("    if isinstance(v, bool) or not", "    if not", "логическое — не число"),
    ("except (ValueError, OverflowError):", "except ValueError:", "целое больше float"),
    ("return f if math.isfinite(f) else 0.0", "return f", "бесконечность — не число"),
    ("return (a, b) if 0 < a < PX_MAX and 0 < b < PX_MAX else None", "return (a, b) if 0 < a and 0 < b else None", "предел цены"),
    ("return (a, b) if 0 < a < PX_MAX and 0 < b < PX_MAX else None", "return (a, b) if 0 <= a < PX_MAX and 0 < b < PX_MAX else None", "ноль — не цена"),
    # Hyperliquid.
    (' or u.get("isDelisted"):', ":", "снятые с торгов — мимо"),
    ('.split(":")[-1]', '.split(":")[0]', "имя без приставки площадки"),
    ("zip(uni[:UNI_MAX] if", "zip(uni if", "предел рынков площадки"),
    # ЕЦБ.
    ("if not (isinstance(day, str) and DATE.fullmatch(day)):", "if not isinstance(day, str):", "день ЕЦБ — дата"),
    ("if all(0 < v < PX_MAX for v in got.values()):", "if any(0 < v < PX_MAX for v in got.values()):", "день ЕЦБ — полный"),
    ("list(rates.items())[-DAYS_MAX:]", "list(rates.items())", "предел дней ЕЦБ"),
    ("days = [d for d in ecb if d <= day]", "days = list(ecb)", "фиксация не позже дня"),
    ("return ecb[max(days)] if days else None", "return ecb[min(days)] if days else None", "последняя фиксация"),
    # Валютный день.
    ("return 1 + (6 - calendar.weekday(y, month, 1)) % 7 + 7 * (n - 1)", "return (6 - calendar.weekday(y, month, 1)) % 7 + 7 * (n - 1)", "n-е воскресенье"),
    ("start = calendar.timegm((y, 3, _sunday(y, 3, 2), 7, 0, 0))", "start = calendar.timegm((y, 3, _sunday(y, 3, 1), 7, 0, 0))", "летнее время — со второго воскресенья марта"),
    ("end = calendar.timegm((y, 11, _sunday(y, 11, 1), 6, 0, 0))", "end = calendar.timegm((y, 11, _sunday(y, 11, 2), 6, 0, 0))", "зимнее время — с первого воскресенья ноября"),
    ("return -4 * HOUR if start <= t < end else -5 * HOUR", "return -5 * HOUR", "летнее время Нью-Йорка"),
    ("close = day + 17 * HOUR if loc >= day + 17 * HOUR else day - 7 * HOUR", "close = day + 17 * HOUR if loc > day + 17 * HOUR else day - 7 * HOUR", "закрытие ровно в 17:00"),
    ("close = day + 17 * HOUR if loc >= day + 17 * HOUR else day - 7 * HOUR", "close = day + 16 * HOUR if loc >= day + 16 * HOUR else day - 8 * HOUR", "закрытие в 17:00 по Нью-Йорку"),
    ("    while time.gmtime(close).tm_wday > 4:\n        close -= 86400\n", "", "в выходные закрытий нет"),
    ("    while time.gmtime(prev).tm_wday > 4:\n        prev -= 86400\n", "", "прошлое закрытие — будний день"),
    ("(wd == 4 and loc >= day + 17 * HOUR)", "(wd == 4 and loc > day + 17 * HOUR)", "пятница — закрыт с 17:00 включительно"),
    ("(wd == 4 and loc >= day + 17 * HOUR) or ", "", "пятница вечером — закрыт"),
    (" or (wd == 6 and loc < day + 17 * HOUR)", "", "воскресенье до 17:00 — закрыт"),
    (" or wd == 5 or ", " or ", "суббота — закрыт"),
    # Свечи закрытия.
    ("end = int(_num(c.get(\"t\")) / 1000) + HOUR", "end = int(_num(c.get(\"t\")) / 1000)", "свеча закрывается через час"),
    ("if t - CANDLE_AGE <= end <= t and", "if end <= t and", "свеча закрытия не старше CANDLE_AGE"),
    ("if t - CANDLE_AGE <= end <= t and", "if t - CANDLE_AGE <= end and", "свеча из будущего — не закрытие"),
    ("and end > best and", "and end >= best and", "последняя из свечей"),
    ("for c in raw[-CANDLES_MAX:] if", "for c in raw if", "предел свечей"),
    # DXY.
    ("v = live[c][0] if now and c in live else candle_close(cs.get(c), when)", "v = live[c][1] if now and c in live else candle_close(cs.get(c), when)", "открыт — живая цена"),
    ("v = live[c][0] if now and c in live else candle_close(cs.get(c), when)", "v = live[c][0] if c in live else candle_close(cs.get(c), when)", "закрытия — по свечам"),
    ('r[c] = 1 / v if c in ("EUR", "GBP") else v', 'r[c] = 1 / v if c == "EUR" else v', "фунт — долларов за фунт"),
    ("if abs(r[c] / base[c] - 1) > FX_GAP:", "if abs(r[c] / base[c] - 1) > 1:", "сверка с ЕЦБ"),
    ("return pair(at(t, True) if is_open else at(close, False), at(close if is_open else prev, False))",
     "return pair(at(t, True), at(close if is_open else prev, False))", "закрыт — цена закрытия пятницы"),
    ("return pair(at(t, True) if is_open else at(close, False), at(close if is_open else prev, False))",
     "return pair(at(t, True) if is_open else at(close, False), at(prev, False))", "открыт — против последнего закрытия"),
    ("v *= (1 / r[c] if w < 0 else r[c]) ** w", "v *= r[c] ** w", "формула DXY"),
    ('DXY_W = (("EUR", -0.576)', 'DXY_W = (("EUR", -0.567)', "вес евро"),
    ("DXY_K = 50.14348112", "DXY_K = 50.0", "множитель DXY"),
    # Доминация.
    ('or mcap.get("ok") is not True:', ":", "доминация — только годный ответ"),
    ("(p := pair(usdt, usdt * now_c / prev_c))", "(p := pair(usdt, usdt))", "USDT.D вчера — по капитализации рынка"),
    ("(p := pair(usdt, usdt * now_c / prev_c))", "(p := pair(usdt, usdt * prev_c / now_c))", "USDT.D вчера — направление"),
    # Правдоподобие и ответ.
    ("max(a, b) <= MOVE_MAX * min(a, b)", "max(a, b) <= 10 * MOVE_MAX * min(a, b)", "скачок за сутки"),
    ("return lo <= a <= hi and lo <= b <= hi and", "return lo <= a <= hi and", "рамки — и вчера"),
    ('"US10Y": (0.01, 30.0)', '"US10Y": (0.01, 300.0)', "рамки доходности"),
    ('"BTCD": (0.01, 100.0)', '"BTCD": (0.01, 1000.0)', "доля не больше 100 %"),
    ('"BVIV": (1.0, 500.0)', '"BVIV": (0.0, 500.0)', "BVIV — в процентах"),
    ("for k in KEYS if k in got and sane(k, got[k])]", "for k in KEYS if k in got]", "неправдоподобное — мимо"),
    ("got.update(dominance(parts.get(\"mcap\")))\n", "", "доминация в ответе"),
    ('"OIL": ("xyz", "CL")', '"OIL": ("xyz", "BRENTOIL")', "нефть — WTI"),
    # Кэш и сборка.
    ("return t0 - hit[0] < SLOW[name][0] or (name", "return True or (name", "из памяти — свежий не вечно"),
    ("return t0 - hit[0] < SLOW[name][0] or (name", "return False or (name", "из памяти — пока свеж"),
    ('or (name == "fx" and fx_covers(hit[1], _now()))', "", "свечи — пока есть нужные закрытия"),
    ("    if not hit:\n        return False\n", "", "в памяти пусто — спрашиваем"),
    ('SLOW = {"xyz": (600.0, STALE_MAX)', 'SLOW = {"xyz": (300.0, STALE_MAX)', "цены площадок — раз в 10 минут"),
    # Запас Aster.
    ("        got.setdefault(key, p)  # Aster — только если Hyperliquid не дал", "        got[key] = p", "Aster — только запас"),
    ("    for key, p in aster_markets(parts.get(\"aster\"), at).items():\n        got.setdefault(key, p)  # Aster — только если Hyperliquid не дал\n", "", "запас Aster в ответе"),
    ("if not (at - ASTER_AGE <= got_at <= at + 60) or", "if not (got_at <= at + 60) or", "Aster — не старше ASTER_AGE"),
    ("if not (at - ASTER_AGE <= got_at <= at + 60) or", "if not (at - ASTER_AGE <= got_at) or", "Aster из будущего — мимо"),
    ("and key not in out \\", "\\", "Aster: повтор рынка — первый"),
    ('ASTER = {"GOLD": "XAUUSDT", "OIL": "CLUSDT"}', 'ASTER = {"GOLD": "XAUUSDT", "OIL": "CLOUSDT"}', "нефть Aster — CL (WTI)"),
    ('(p := pair(r.get("lastPrice"), r.get("openPrice")))', '(p := pair(r.get("lastPrice"), r.get("lastPrice")))', "Aster: вчера — открытие суток"),
    ("for w in ((close,) if is_open else (close, prev)))", "for w in (close,))", "закрыт — нужно и прошлое закрытие"),
    ("for w in ((close,) if is_open else (close, prev)))", "for w in (close, prev))", "открыт — нужно только последнее закрытие"),
    ("    if not isinstance(raw, dict):\n        return False\n    return all(", "    return isinstance(raw, dict) and any(", "закрытия — все валюты"),
    ("    return bool(hl_markets(raw))", "    return raw is not None", "мусор площадки не запоминается"),
    ("elif (old := slow.get(name)) and time.monotonic() - old[0] < SLOW[name][1]:", "elif (old := slow.get(name)):", "запас — не старше SLOW[1]"),
    ("elif (old := slow.get(name)) and time.monotonic() - old[0] < SLOW[name][1]:", "elif False:", "источник молчит — прошлый годный"),
    ("            if _good(name, v):", "            if v is not None:", "мусор не запоминается"),
    ("    with got:  # опоздавший источник — уже без него\n        now_parts = dict(parts)\n", "    now_parts = parts\n", "опоздавший источник не меняет ответ"),
    ("if hit and time.monotonic() - hit[0] < TTL:", "if hit:", "свежий ответ — TTL"),
    ("return hit if hit and time.monotonic() - hit[0] < STALE_MAX else None", "return hit", "старый ответ не отдаётся"),
    ("if _st.job is not None or time.monotonic() - _st.fail < FAIL_WAIT:", "if _st.job is not None:", "после сбоя — пауза"),
]
TS = [
    ('if (!isObj(raw) || raw["ok"] !== true ||', 'if (!isObj(raw) ||', "ok — только true"),
    ("!Number.isInteger(at) ||", "", "время — целое"),
    ("at < now - AGE_MAX ||", "", "старая сборка — не ответ"),
    ("at > now + AHEAD_MAX", "at > now + AHEAD_MAX * 30", "сборка из будущего — не ответ"),
    ("const AGE_MAX = 6 * 3_600;", "const AGE_MAX = 60 * 3_600;", "предел возраста — шесть часов"),
    ("|| seen.has(k as MarketKey)) continue;", ") continue;", "повтор — первый"),
    ("!(MARKET_KEYS as readonly string[]).includes(k) ||", "", "только известные пункты"),
    ("Number.isFinite(v) && v > 0 && v < MARKET_PX_MAX", "Number.isFinite(v) && v > 0", "предел цены"),
    ("Number.isFinite(v) && v > 0 && v < MARKET_PX_MAX", "Number.isFinite(v) && v >= 0 && v < MARKET_PX_MAX", "ноль — не цена"),
    ("seen.set(k as MarketKey, { k: k as MarketKey, px: it[\"px\"], prev: it[\"prev\"] });", "seen.set(k as MarketKey, it as unknown as MarketItem);", "только поля k, px, prev"),
    ("return items.length ? { at, items } : null;", "return { at, items };", "пустой ответ — не ответ"),
    ('return it.k === "US10Y" ? { v: (it.px - it.prev) * 100, unit: "bp" }', 'return it.k === "DXY" ? { v: (it.px - it.prev) * 100, unit: "bp" }', "базисные пункты — у доходности"),
    ("{ v: (it.px - it.prev) * 100, unit: \"bp\" }", "{ v: (it.px - it.prev) * 10, unit: \"bp\" }", "базисный пункт — сотая процента"),
    ("{ v: (it.px / it.prev - 1) * 100, unit: \"pct\" }", "{ v: (it.prev / it.px - 1) * 100, unit: \"pct\" }", "направление изменения"),
    ("if (isPercent(it.k)) return 2;", "", "доли и доходность — две цифры"),
    ("return it.px >= 1000 ? 0 :", "return it.px > 1000 ? 0 :", "тысяча — без копеек"),
    ("it.px >= 10 ? 2 : it.px >= 1 ? 3 : 5;", "it.px >= 10 ? 2 : 5;", "единицы — три знака"),
    ('k === "US10Y" || k === "BTCD" || k === "USDTD"', 'k === "US10Y" || k === "BTCD"', "USDT.D — со знаком «%»"),
    ('const a = Math.abs(c.v) / (c.unit === "bp" ? BAR_BP : BAR_PCT);', 'const a = Math.abs(c.v) / BAR_PCT;', "полоска доходности — по базисным пунктам"),
    ("export const BAR_PCT = 2;", "export const BAR_PCT = 3;", "полная полоска — 2 %"),
    ("if (!Number.isFinite(a) || a === 0) return 0;", "if (!Number.isFinite(a)) return 0;", "ноль — без полоски"),
    ("return Math.min(1, Math.max(BAR_MIN, a));", "return Math.min(1, a);", "мелочь — видна"),
    ("return Math.min(1, Math.max(BAR_MIN, a));", "return Math.max(BAR_MIN, a);", "полоска — не длиннее ячейки"),
    ("return Math.max(0, Math.floor((now - at) / 60));", "return Math.floor((now - at) / 60);", "возраст — не минус"),
    ("return Math.max(0, Math.floor((now - at) / 60));", "return Math.max(0, Math.round((now - at) / 60));", "возраст — целые минуты"),
    ("export const MARKETS_STALE_MIN = 15;", "export const MARKETS_STALE_MIN = 30;", "старые — с 15 минут"),
]


def drop_pyc(path):
    stem = os.path.splitext(os.path.basename(path))[0]
    cache = os.path.join(os.path.dirname(path), "__pycache__")
    for f in os.listdir(cache) if os.path.isdir(cache) else []:
        if f.startswith(stem + ".") and f.endswith(".pyc"):
            os.remove(os.path.join(cache, f))


ORIG: dict = {}


def restore(*_):
    for path, src in ORIG.items():
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
        drop_pyc(path)
    sys.exit("прервано — исходники возвращены")


signal.signal(signal.SIGTERM, restore)
signal.signal(signal.SIGINT, restore)


def run(path, cmd, muts):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    ORIG[path] = src
    drop_pyc(path)
    # Без порчи тесты обязаны проходить: иначе любая мутация «убита» ложно.
    base = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300, check=False)
    if base.returncode != 0:
        # Что именно упало — в журнал CI, а не только «красные».
        print("\n".join((base.stdout + base.stderr).splitlines()[-60:]), flush=True)
        sys.exit(f"тесты красные и без мутаций: {' '.join(cmd)}")
    alive = []
    try:
        for a, b, name in muts:
            if src.count(a) != 1:
                sys.exit(f"мутация «{name}»: текст для замены найден {src.count(a)} раз — обновите список")
            with open(path, "w", encoding="utf-8") as f:
                f.write(src.replace(a, b))
            drop_pyc(path)
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
        drop_pyc(path)
        ORIG.pop(path, None)
    return alive


a1 = run(f"{ROOT}/src/lib/markets.ts", ["node", "--test", "tests/markets.test.ts", "tests/markets.props.test.ts"], TS)
a2 = run(f"{ROOT}/wt_markets.py", [sys.executable, "-m", "unittest", "tests.test_markets", "tests.test_markets_fuzz",
                                   "tests.test_markets_security", "tests.test_markets_policy"], PY)
alive = a1 + a2
total = len(TS) + len(PY) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
