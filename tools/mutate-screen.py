"""Мутационная проверка скринера графика: python3 tools/mutate-screen.py

Как у рынков в меню: портим код по одному месту (граница, знак, константа,
защита) и гоняем тесты скринера. Убитая мутация — тесты заметили порчу;
выжившая — дыра в тестах. Файл после каждой мутации возвращается как был — и
после прерывания тоже. Эквивалентные мутации (не меняют ничего наблюдаемого)
помечены и в счёт не идут.
"""
import os
import signal
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные:
#  - «лишние таймфреймы в ?tf=» — want() и так берёт только известные из TFS,
#    срез лишь бережёт время на мусорных списках;
#  - «равные — порядок сервера», «без фильтра — порядок сервера» — сортировка
#    JavaScript устойчива (ES2019): равные и без ключа и так остаются в
#    порядке сервера; индекс и ранний выход — для ясности и скорости.
EQUIV = {"лишние таймфреймы в ?tf=", "равные — порядок сервера", "без фильтра — порядок сервера"}
PY = [
    # Разбор свечей и монет.
    ("    if isinstance(v, bool) or not", "    if not", "логическое — не число"),
    ("return f if math.isfinite(f) else math.nan", "return f", "бесконечность — не число"),
    ("if _isnan(o) or _isnan(c) or not (", "if not (", "NaN в цене — не свеча"),
    ("t > 0 and 0 < lo <= min(o, c) and max(o, c) <= h < PX_MAX and v >= 0", "t > 0 and 0 < lo and max(o, c) <= h < PX_MAX and v >= 0",
     "минимум — не выше тела"),
    ("t > 0 and 0 < lo <= min(o, c) and max(o, c) <= h < PX_MAX and v >= 0", "t > 0 and 0 < lo <= min(o, c) and h < PX_MAX and v >= 0",
     "максимум — не ниже тела"),
    ("t > 0 and 0 < lo <= min(o, c) and max(o, c) <= h < PX_MAX and v >= 0", "t > 0 and 0 < lo <= min(o, c) and max(o, c) <= h and v >= 0",
     "предел цены"),
    ("        if out and t <= out[-1][0]:\n            continue\n", "", "время — по возрастанию"),
    ("for r in raw[-BARS:] if isinstance(raw, list) else ():", "for r in raw if isinstance(raw, list) else ():", "только хвост свечей"),
    ("    spot = _tickers(raw, VOL_MIN)[:COINS_MAX]", "    spot = _tickers(raw, VOL_MIN)", "не больше COINS_MAX монет"),
    ("if b not in have][:FUT_MAX]", "if b not in have]", "не больше FUT_MAX фьючерсов"),
    ("if b not in have][:FUT_MAX]", "][:FUT_MAX]", "фьючерсы — только монеты, которых нет на споте"),
    ("    return sorted(out, key=lambda x: -x[1])", "    return out", "по обороту"),
    ("not base.isupper() or base in SKIP:", "not base.isupper():", "стейблкоины — мимо"),
    ("if not base.isascii() or not base.isalnum() or", "if", "тикер — латиница и цифры"),
    ('        if base.endswith(("UP", "DOWN", "BULL", "BEAR")) and len(base) > 4:\n            continue\n', "", "плечевые токены — мимо"),
    ("        if vol >= vol_min and base not in got:", "        if vol >= vol_min:", "повтор монеты — первый"),
    ("        if vol >= vol_min and base not in got:", "        if base not in got:", "оборот — от порога"),
    ("VOL_MIN = 1e4", "VOL_MIN = 1e2", "порог оборота спота"),
    ("COINS_MAX = 700", "COINS_MAX = 2500", "бюджет: монет спота"),
    ("FUT_MAX = 250", "FUT_MAX = 1000", "бюджет: монет фьючерсов"),
    ("FUT_BARS = 499", "FUT_BARS = 500", "свечей фьючерсов — до 500 (вес 2)"),
    # Рейтинг (договор с графиком).
    ("        for v in [s_[j] for ln, s_ in mas if j + 1 > ln]", "        for v in [s_[j] for ln, s_ in mas]", "скользящая голосует, когда свечей больше ln"),
    ("                votes.append(1 if v < px else -1 if v > px else 0)", "                votes.append(1 if v <= px else -1)", "голос скользящей — ноль при равенстве"),
    ("        return (ma + os_) / 2, ma, os_", "        return (ma + os_) / 2, os_, ma", "скользящие и осцилляторы — по местам"),
    ("(lv(uo), _vote(lv(uo) > 70, lv(uo) < 30)),", "(lv(uo), _vote(lv(uo) > 60, lv(uo) < 30)),", "UO: порог 70"),
    ("            (lv(mom), _vote(lv(mom) > lv(mom, 1), lv(mom) < lv(mom, 1))),\n", "", "голос момента"),
    ("    return _rater(bars)(len(bars) - 1)", "    return _rater(bars)(len(bars) - 2)", "рейтинг — последней свечи"),
    ("MIN_BARS = 60", "MIN_BARS = 50", "меньше 60 свечей — без рейтинга"),
    # Начало сигнала.
    ("    return 1 if v > 0.1 else -1 if v < -0.1 else 0", "    return 1 if v >= 0.1 else -1 if v < -0.1 else 0", "сторона: ровно 0,1 — нейтрально"),
    ("    return 1 if v > 0.1 else -1 if v < -0.1 else 0", "    return 1 if v > 0 else -1 if v < 0 else 0", "сторона — по порогам слов"),
    ("        if j + 1 < MIN_BARS or side(at(j)[0]) != now:", "        if j + 1 < MIN_BARS:", "сигнал держится, пока та же сторона"),
    ("    if last - start > SINCE_MAX or start + 1 <= MIN_BARS:", "    if last - start > SINCE_MAX:", "с начала данных — «давно»"),
    ("    if last - start > SINCE_MAX or start + 1 <= MIN_BARS:", "    if start + 1 <= MIN_BARS:", "старше SINCE_MAX — «давно»"),
    ("    return ((bars[last][4] / p0 - 1) * 100 if p0 > 0 else None), last - start",
     "    return ((bars[last][4] / p0 - 1) * 100 if p0 > 0 else None), last - start + 1", "свечей с сигнала"),
    ("    p0 = bars[start][4]", "    p0 = bars[start][1]", "ход — от закрытия свечи сигнала"),
    ("    if not now:\n        return None, None\n", "", "нейтрально — без хода"),
    # Метрики.
    ("    vols = [b[5] for b in bars[-22:-2]]", "    vols = [b[5] for b in bars[-21:-1]]", "объём: среднее — до закрытой свечи"),
    ("    volx = bars[-2][5] / avg if avg > 0 else None", "    volx = bars[-1][5] / avg if avg > 0 else None", "объём — закрытой свечи"),
    ("    adx = fin(_at(_adx(bars, 14)[0], n - 1))", "    adx = fin(_at(_adx(bars, 14)[1], n - 1))", "ADX, а не +DI"),
    ("    tp = (above[0] / px - 1) * 100 if above else None", "    tp = (above[-1] / px - 1) * 100 if above else None", "тейк — ближний уровень"),
    ("    return tp, (lo[1] / px - 1) * 100", "    return tp, (lo[1] / px - 1) * 10", "стоп — в процентах"),
    ("    return min(20.0, max(1.0, d2))", "    return min(20.0, d2)", "порог разворота — не меньше 1 %"),
    # Ответ.
    ("    return now - at <= STALE_X * EVERY[tf]", "    return True", "старый рейтинг не отдаётся"),
    ("    return now - at <= STALE_X * EVERY[tf]", "    return now - at < STALE_X * EVERY[tf]", "ровно три интервала — ещё годен"),
    ('_r(rsi, 1), _r(adx, 1), _r(volx, 2), _r(atrp, 2), _r(tp, 2), _r(sl, 2),', '_r(rsi, 1), _r(adx, 1), _r(volx, 2), _r(atrp, 2), _r(sl, 2), _r(tp, 2),',
     "тейк и стоп — по местам"),
    ('            row["f"] = 1  # только фьючерсы\n', "", "фьючерсы помечены"),
    ('"px": p if p > 0 else None', '"px": p', "нет цены — null"),
    ("                last = max(last, got[1])", "                last = got[1]", "время ответа — самый свежий рейтинг"),
    ("    return round((b / a - 1) * 100, 2) if a > 0 else None", "    return round((b / a - 1) * 100, 2)", "сутки: цена больше нуля"),
    # Сборка, бюджет, журнал.
    ("            if isinstance(tf, str) and tf in EVERY and tf not in WARM:", "            if isinstance(tf, str) and tf not in WARM:", "в память — только известные таймфреймы"),
    ("        for tf in tfs[: len(TFS)]:", "        for tf in tfs:", "лишние таймфреймы в ?tf="),
    ("    return tf in WARM or t0 - _st.want.get(tf, -math.inf) < ACTIVE_FOR", "    return True", "без спроса — только WARM"),
    ("        if t0 < _st.pause:\n            return uni, None\n", "", "после прерванного прохода — пауза"),
    ("            if fails >= ABORT_FAILS:", "            if fails >= ABORT_FAILS * 100:", "сбои подряд — проход прерван"),
    ("                    _st.pause = time.monotonic() + PAUSE", "                    _st.pause = time.monotonic()", "пауза — PAUSE секунд"),
    ("            return uni, never[0]", "            return uni, None", "нужный впервые — сразу"),
    ("        return uni, max(due, key=lambda tf: (t0 - _st.done[tf]) / EVERY[tf])", "        return uni, due[0]", "сначала самый просроченный"),
    ("and t0 - _st.uni_fail >= FAIL_WAIT", "", "список не получен — пауза"),
    ("    if not got or not fut_failed:\n        return got\n", "    return got\n", "фьючерсы не пришли — прошлые остаются"),
    ("    keep = [c for c in old if c[2] == \"f\" and c[0] not in have][:FUT_MAX]", "    keep = [c for c in old if c[2] == \"f\"][:FUT_MAX]",
     "перешла на спот — без повтора"),
    ('fut_failed = "futures" in _src and not isinstance(fut, list)', 'fut_failed = "futures" in _src and not fut', "пустой список фьючерсов — ответ"),
    ("            for k in [k for k, v in d.items() if k not in keep or not fresh(t, v[1], now)]:", "            for k in [k for k, v in d.items() if k not in keep]:",
     "старые рейтинги — из памяти"),
    ("            for k in [k for k, v in d.items() if k not in keep or not fresh(t, v[1], now)]:",
     "            for k in [k for k, v in d.items() if not fresh(t, v[1], now)]:", "выпавшие монеты — из памяти"),
    ("        if _st.hit is not None and res == _st.hit:", "        if False:", "те же цифры — тот же объект"),
    ("        if _st.job is None and (uni or tf):", "        if uni or tf:", "одна сборка за раз"),
    ('        if hit is None or not hit.get("ok") or _now() - int(hit["at"]) > STALE_ALL:', '        if hit is None or not hit.get("ok"):',
     "давно не считалось — «нет данных»"),
    ("    if ok and was is not None:", "    if ok:", "журнал: «снова отвечает» — только после молчания"),
    ("    elif not ok and was is None:", "    elif not ok:", "журнал: «не отвечает» — один раз"),
    ("            _st.why[name] = type(e).__name__", "            _st.why[name] = str(e)", "в журнал — тип ошибки, не её текст"),
    ('    clean = "".join(ch if ch.isprintable() else "?" for ch in msg)', "    clean = msg", "журнал — одной чистой строкой"),
]
TS = [
    ('if (!isObj(raw) || raw["ok"] !== true ||', 'if (!isObj(raw) ||', "ok — только true"),
    ("if (!fin(at) || !Number.isInteger(at) ||", "if (!fin(at) ||", "время — целое"),
    ("at < now - AGE_MAX ||", "", "старый ответ — не ответ"),
    ("const SYM = /^[A-Z0-9]{1,16}$/;", "const SYM = /^[A-Z0-9<>]{1,16}$/;", "тикер — буквы и цифры"),
    ("|| seen.has(x[\"s\"]) ||", "||", "повтор — первый"),
    ("r[tf] = fin(t) && t >= -1 && t <= 1 ? t : null;", "r[tf] = fin(t) ? t : null;", "рейтинг — от −1 до +1"),
    ("    if (!any) continue;", "", "строка без рейтинга — мимо"),
    ('fut: x["f"] === 1', 'fut: !!x["f"]', "фьючерсы — только «f»: 1"),
    ("rsi: within(v[3], 0, 100)", "rsi: within(v[3], -100, 100)", "RSI — от 0 до 100"),
    ("sl: within(v[8], -100, 0)", "sl: within(v[8], -100, 100)", "стоп — ниже цены"),
    ("age: age !== null && Number.isInteger(age) ? age : null", "age", "свечей с сигнала — целое"),
    ("  return x.tp / -x.sl;", "  return x.tp / x.sl;", "риск/прибыль — положительный"),
    ("if (x.vol && !(k?.volx != null && k.volx >= x.vol)) return false;", "if (x.vol && !(k?.volx != null && k.volx > x.vol)) return false;", "объём: порог включительно"),
    ("if (x.rsi === \"os\" ? v >= 30 : x.rsi === \"ob\" ? v <= 70 : v < 30 || v > 70) return false;",
     "if (x.rsi === \"os\" ? v >= 30 : x.rsi === \"ob\" ? v <= 70 : v < 30) return false;", "RSI без крайностей — не выше 70"),
    ("    if (q === null || q < x.rr) return false;", "    if (q !== null && q < x.rr) return false;", "нет R:R — не проходит"),
    ("    if (q === null || q > x.late) return false;", "    if (q !== null && q > x.late) return false;", "нет хода — не проходит"),
    ("if (v === null || !k || k.mv === null || k.age === null || k.age > SINCE_MAX) return null;",
     "if (v === null || !k || k.mv === null || k.age === null) return null;", "«давно» — без хода"),
    ("  return s ? s * k.mv : null;", "  return s ? k.mv : null;", "ход — в сторону сигнала"),
    ("return q !== null && a !== null && a > 0 && q > 2 * a;", "return q !== null && a !== null && a > 0 && q > a;", "поздно — больше двух ATR"),
    ('if (x.sort === "fresh") return chase(r, tf) === null ? null : -(r.m[tf]?.age ?? 0);',
     'if (x.sort === "fresh") return -(r.m[tf]?.age ?? 0);', "свежесть: давно — в конце"),
    ("(a.k === null ? (b.k === null ? a.i - b.i : 1) : b.k === null ? -1 : b.k - a.k || a.i - b.i)",
     "(a.k === null ? (b.k === null ? a.i - b.i : 1) : b.k === null ? -1 : b.k - a.k)", "равные — порядок сервера"),
    ("  if (x.sort === \"sig\" && !used.length) return got;", "", "без фильтра — порядок сервера"),
    ("  return v < -0.5 ? -2 : v < -0.1 ? -1 : v <= 0.1 ? 0 : v <= 0.5 ? 1 : 2;", "  return v < -0.5 ? -2 : v < -0.1 ? -1 : v < 0.1 ? 0 : v <= 0.5 ? 1 : 2;",
     "0,1 — нейтрально"),
    ("export const mainTf = (f: ScreenFilter): ScreenTf => SCREEN_TFS.find((tf) => f[tf] !== \"any\") ?? \"15m\";",
     "export const mainTf = (f: ScreenFilter): ScreenTf => SCREEN_TFS.find((tf) => f[tf] !== \"any\") ?? \"1h\";", "без фильтра — 15m"),
    ("  SCREEN_TFS.filter((tf) => f[tf] !== \"any\" || cols.includes(tf));", "  SCREEN_TFS.filter((tf) => cols.includes(tf));", "значки — и таймфреймы фильтра"),
    ("  badgeTfs(f, cols).filter((tf) => !SCREEN_WARM.includes(tf));", "  badgeTfs(f, cols);", "серверу — только не основные"),
    ("  return Array.isArray(raw) ? SCREEN_TFS.filter((tf) => raw.includes(tf)) : [...SCREEN_WARM];", "  return Array.isArray(raw) ? (raw as ScreenTf[]) : [...SCREEN_WARM];",
     "столбцы — только известные"),
    ("  SCREEN_TFS.filter((x) => (x === tf ? !cols.includes(tf) : cols.includes(x)));", "  SCREEN_TFS.filter((x) => x === tf || cols.includes(x));", "касание столбца — убрать"),
    ("rr: pick(x[\"rr\"], RR_STEPS, 0), late: pick(x[\"late\"], LATE_STEPS, 0),", "rr: pick(x[\"rr\"], RR_STEPS, 0), late: Number(x[\"late\"]) || 0,",
     "ход с сигнала — только из списка"),
    ("  return k ? rows.filter((r) => r.s.startsWith(k)) : rows.slice();", "  return k ? rows.filter((r) => r.s.includes(k)) : rows.slice();", "поиск — по началу тикера"),
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
                killed = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=240, check=False).returncode != 0
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


a1 = run(f"{ROOT}/src/lib/screener.ts", ["node", "--import", "./tests/ts-resolve.mjs", "--test", "tests/screener.test.ts",
                                         "tests/screener.props.test.ts"], TS)
a2 = run(f"{ROOT}/wt_screen.py", [sys.executable, "-m", "unittest", "tests.test_screen", "tests.test_screen_fuzz",
                                  "tests.test_screen_security", "tests.test_screen_contract"], PY)
alive = a1 + a2
total = len(TS) + len(PY) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
