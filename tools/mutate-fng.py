"""Мутационная проверка «Страха и жадности»: python3 tools/mutate-fng.py

Как у халвинга: портим код по одному месту (граница, знак, константа,
защита) и гоняем тесты. Убитая мутация — тесты заметили порчу; выжившая —
дыра в тестах. Файл после каждой мутации возвращается как был.
Эквивалентные мутации (не меняют ничего наблюдаемого) помечены и в счёт не
идут.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные: «дубль дня индекса» — alternative.me отдаёт дни без дублей,
# а при дубле любой из двух одинаково правдоподобен.
EQUIV = {"дубль дня индекса"}
TS = [
    ("v < 0 || v > 100", "v < 0 || v > 101", "индекс не больше 100"),
    ("(px !== 0 && (px <= PX_MIN || px >= PX_MAX))", "(px < 0)", "правдоподобие цены"),
    ("f > (F_EST | F_FILL | F_HL)", "f > 8", "известные флаги"),
    ("(!first && ts !== prev + DAY)", "(!first && ts <= prev)", "дни подряд"),
    ("ts >= FNG_START && ts % DAY === 0", "ts >= FNG_START", "первый день — в полночь"),
    ("days.length < DAYS_MIN", "days.length < 1", "мало дней — обрезанный ответ"),
    ("  if (prev > at + AHEAD) return null;\n", "", "последний день не впереди ответа"),
    ("at > now + CLOCK_LAG", "at > now + CLOCK_LAG * 100", "время ответа из будущего"),
    ("return { ok: true, days: out, at };", "return { ...raw, ok: true, days: out, at } as FngReply;", "только известные поля"),
    ("if (cutStart && i === 0) continue;", "", "обрезанная первая полоса окна"),
    ("if (len > s.max) {", "if (len >= s.max) {", "рекорд — первый из равных"),
    ("while (k > 0 && zoneOf(days[k - 1]![1]) === zi)", "while (k > 1 && zoneOf(days[k - 1]![1]) === zi)", "полоса с первого дня"),
    ("if (rest.length < 5) return null;", "if (rest.length < 2) return null;", "мало полос — нет вывода"),
    ("z === cur.zi && len >= cur.len", "z === cur.zi && len > cur.len", "полосы, дожившие до нынешней"),
    ("rest.filter((r) => r >= 7)", "rest.filter((r) => r > 7)", "ещё неделя"),
    ("zoneOf(a[1]) === z && a[2] > 0 && b[2] > 0", "zoneOf(a[1]) === z && a[2] > 0", "день без цены после"),
    ("if (d[0] < from || !(d[2] > 0)", "if (!(d[2] > 0)", "покупки с выбранного года"),
    ("if (zoneOf(days[k]![1]) === z) fresh = false;", "", "только свежие входы"),
    ("return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;", "return s[m]!;", "медиана чётного числа"),
    ("days.slice(-Number(range))", "days.slice(-Number(range) - 1)", "окно — ровно n дней"),
    ("if (d[1] > hi[1]) hi = d;", "if (d[1] >= hi[1]) hi = d;", "максимум за год — первый"),
    ("if (days[i]![3] & F_EST) return days[i]![0];", "if (days[i]![3] & F_FILL) return days[i]![0];", "до какого дня цена досчитана"),
    ("const prices = (i: number) => days.slice(i - 60, i).map((d) => d[2]).filter((p) => p > 0);",
     "const prices = (i: number) => days.slice(i - 60, i).map((d) => d[2]);",
     "дни без цены в окне расхождения"),
    ("for (const d of days) {\n    cnt[zoneOf(d[1])]! += 1;", "for (const d of days.slice(1)) {\n    cnt[zoneOf(d[1])]! += 1;", "все дни окна по зонам"),
    ("  while (i >= 0 && !(days[i]![2] > 0)) i -= 1;\n", "", "«сейчас» — последний день с ценой"),
    ("return days[i]![2] > 0 && w.length > 0 && days[i]![2] <= Math.min(...w);", "return days[i]![2] > 0 && days[i]![2] <= Math.min(...w);", "окно без цен — не дно"),
    ("  if (!(days[i0 - 30]![2] > 0)) return null;\n", "", "похожие: цена месяц назад есть"),
    ("if (!(d[2] > 0) || !(pb > 0) || (d[2] >= pb) !== up) continue;", "if (!(d[2] > 0) || (d[2] >= pb) !== up) continue;", "похожие: у дня есть ход цены"),
    ("  return days.slice(i);\n}", "  return days;\n}", "график — с первого дня с ценой"),
    ("  return days.slice(i);\n}", "  return days.slice(i + 1);\n}", "график — включая первый день с ценой"),
    ("days.length - i < Math.min(SHOWN_MIN, Math.ceil(days.length / 2))", "days.length - i < 1", "мало цен — график не обрезается"),
    ("days.length - i < Math.min(SHOWN_MIN, Math.ceil(days.length / 2))", "days.length - i < SHOWN_MIN", "короткое окно — по половине"),
    ("days.length - i < Math.min(SHOWN_MIN, Math.ceil(days.length / 2))", "days.length - i <= Math.min(SHOWN_MIN, Math.ceil(days.length / 2))", "граница — ровно SHOWN_MIN"),
    ("  return { inv, val: btc * lastPrice(days) };", "  return { inv, val: btc * (days[days.length - 1]?.[2] ?? 0) };", "покупки — по последней известной цене"),
]
PY = [
    ("if hit and not failed and not _busy.is_set():", "if hit and not _busy.is_set():", "пауза после сбоя"),
    ("    if left <= MIN_LEFT:\n        return None", "    if left <= -1:\n        return None", "бюджет исчерпан"),
    ("hop = min(HOP, left)", "hop = HOP", "таймаут по остатку бюджета"),
    ("        _dl.at = 0.0\n", "        pass\n", "срок сборки сбрасывается"),
    ("    with _cold:\n", "    if True:\n", "один сборщик на холодном старте"),
    ("if t % DAY == 0 and START <= t <= top and 0 <= v <= 100:", "if START <= t <= top and 0 <= v <= 100:", "индекс — только полночь"),
    ("if t % DAY == 0 and START <= t <= top and 0 <= v <= 100:", "if t % DAY == 0 and START <= t <= top and 0 <= v <= 101:", "индекс не больше 100"),
    ("if t % DAY == 0 and START <= t <= top and 0 <= v <= 100:", "if t % DAY == 0 and START <= t and 0 <= v <= 100:", "индекс не из будущего"),
    ("out.setdefault(t, v)", "out[t] = v", "дубль дня индекса"),
    ("    if len(out) < MIN_DAYS:\n        return None\n    span", "    if len(out) < 1:\n        return None\n    span", "мало дней индекса"),
    ("if len(out) < span * MIN_COVER:", "if False:", "дырявый индекс"),
    ("if t >= START - GAP_MAX - WEEK and PX_MIN < p < PX_MAX:", "if t >= START - GAP_MAX - WEEK and 0 < p:", "правдоподобие цены"),
    ("if w - t == span and w <= top:", "if w - t == span:", "цена не из будущего"),
    ("    if t % DAY:\n        return t\n", "    if t % HOUR:\n        return t\n", "свечи — только в полночь"),
    ("span = WEEK if t // DAY % 7 == 0 else DAY", "span = WEEK if t // DAY % 7 == 1 else DAY", "недельные свечи — по четвергам"),
    ("span = WEEK if t // DAY % 7 == 0 else DAY", "span = DAY", "недельная свеча — на неделю вперёд"),
    ("    if near:\n", "    if False:\n", "свеча среди часов"),
    ("<= abs(raw[t] - later):", "> abs(raw[t] - later):", "свеча или цена момента"),
    ("for span in (0, DAY, WEEK):", "for span in (WEEK, DAY, 0):", "подробная точка важнее недельной"),
    ("if n - DAY <= t <= n + MAX_FUTURE and PX_MIN < p < PX_MAX:", "if t <= n + MAX_FUTURE and PX_MIN < p < PX_MAX:", "текущая цена не старше суток"),
    ("if n - DAY <= t <= n + MAX_FUTURE and PX_MIN < p < PX_MAX:", "if n - DAY <= t and PX_MIN < p < PX_MAX:", "текущая цена не из будущего"),
    ("if abs(ts[near] - end) <= EXACT:", "if abs(ts[near] - end) <= EXACT * 10:", "точная цена — у полуночи"),
    ("if 0 < i < len(ts) and ts[i] - ts[i - 1] <= GAP_MAX:", "if 0 < i < len(ts):", "дальние точки не досчитываем"),
    ("math.exp(math.log(px[i - 1]) + k * (math.log(px[i]) - math.log(px[i - 1])))", "px[i - 1] + k * (px[i] - px[i - 1])", "досчёт по логарифму"),
    ("v, f = int(out[-1][1]), F_FILL", "v, f = 50, F_FILL", "пропуск — прошлым днём"),
    ("v, f = int(out[-1][1]), F_FILL", "v, f = int(out[-1][1]), 0", "пропуск помечен"),
    ("if type(t) is int and t % DAY == 0 and START <= t < today", "if type(t) is int and t % DAY == 0 and START <= t <= today", "запасная — только закрытые дни"),
    ("and isinstance(p, (int, float)) and not isinstance(p, bool) and PX_MIN < p < PX_MAX}", "and isinstance(p, (int, float))}", "запасная — правдоподобная цена"),
    ("p, e = backup[t], F_HL", "p, e = backup[t], 0", "запасная помечена"),
    ("days = _days(idx, ts, px, old, _backup())", "days = _days(idx, ts, px, old, {})", "запасная — и в дырах mempool"),
    ("        if not p and o and not o[1] & F_HL:\n", "        if False:\n", "цена mempool из прошлого ответа"),
    ("        if not p and o and not o[1] & F_HL:\n", "        if not p and o:\n", "прошлая цена Hyperliquid — ниже запасной"),
    ("        elif not p and t in backup:\n", "        elif t in backup:\n", "запасная — только где цены нет"),
    ("        elif not p and o:\n            p, e = o", "        elif False:\n            p, e = o", "прошлая цена Hyperliquid — последняя"),
    ("if d[2] > 0 and (d[0] + DAY <= old_at + EXACT or d[0] + DAY > n)}", "if d[2] > 0}", "середина дня — не закрытие"),
    ("if d[2] > 0 and (d[0] + DAY <= old_at + EXACT or d[0] + DAY > n)}", "if d[2] > 0 and d[0] + DAY <= old_at + EXACT}", "идущий день — и из прошлого ответа"),
    ("if d[2] > 0 and (d[0] + DAY <= old_at + EXACT or d[0] + DAY > n)}", "if d[2] > 0 and (d[0] + DAY <= old_at or d[0] + DAY > n)}", "ответ у полуночи — закрытие"),
    ("_running(ts, px, t, n, _live_backup) if t + DAY > n else", "_running(ts, px, t, n, _live_backup) if t + DAY > n + DAY else", "идущий день"),
    ("mp = (ts[-1], px[-1]) if ts and ts[-1] >= t else None", "mp = (ts[-1], px[-1]) if ts else None", "цена идущего дня — из него"),
    ("    if mp and n - mp[0] <= TTL:\n", "    if mp:\n", "старая цена mempool уступает"),
    ("    if mp and n - mp[0] <= TTL:\n", "    if False:\n", "свежая цена mempool — без Hyperliquid"),
    ("if hl and hl[0] >= t and (not mp or hl[0] > mp[0]):", "if hl and (not mp or hl[0] > mp[0]):", "текущая запасная — из этого дня"),
    ("if hl and hl[0] >= t and (not mp or hl[0] > mp[0]):", "if hl and hl[0] >= t:", "текущая запасная — новее mempool"),
    ("        return hl[1], F_HL\n", "        return hl[1], 0\n", "текущая запасная помечена"),
    ("    return (mp[1], 0) if mp else (0.0, 0)", "    return (0.0, 0)", "старая цена mempool — лучше, чем ничего"),
    ("0 < t <= _now() + MAX_FUTURE and PX_MIN < p < PX_MAX else", "0 < t <= _now() + MAX_FUTURE else", "текущая запасная — правдоподобная цена"),
    ("0 < t <= _now() + MAX_FUTURE and PX_MIN < p < PX_MAX else", "0 < t and PX_MIN < p < PX_MAX else", "текущая запасная — не из будущего"),
    ("if not (isinstance(got, tuple) and len(got) == 2):", "if not got:", "текущая запасная — пара"),
    ("    except Exception as e:  # noqa: BLE001 — запасной источник не роняет сборку\n        _log(f\"запасная текущая", "    except ZeroDivisionError as e:  # noqa: BLE001 — запасной источник не роняет сборку\n        _log(f\"запасная текущая", "сбой текущей запасной не роняет сборку"),
    ("priced = hist or any(d[2] > 0 for d in days[-RECENT:])", "priced = hist", "с запасной ценой — обычный срок"),
    ("if old_days and max(idx) < old_days[-1][0]:", "if False:", "индекс не откатывается назад"),
    ("if not ts or time.monotonic() - px_at >= PX_TTL:", "if True:", "история цен — раз в PX_TTL"),
    ("if live and (not ts or live[0] > ts[-1]):", "if live:", "текущая цена новее истории"),
    ("    _file_save(res)\n    return res", "    return res", "копия на диске"),
    ("if not isinstance(days, list) or not MIN_DAYS <= len(days) <= ROWS_MAX:", "if not isinstance(days, list) or not days:", "копия: мало дней"),
    ("(out and t != out[-1][0] + DAY)", "(out and t <= out[-1][0])", "копия: дни подряд"),
    ("not 0 <= f <= F_ALL", "not 0 <= f", "копия: флаги"),
    ("return out if out[-1][0] <= _now() + MAX_FUTURE else None", "return out", "копия: не из будущего"),
    ("got.get(\"ok\") is not True", "False", "копия: только годный ответ"),
    ("_st.hit = (time.monotonic() - TTL - 1.0, saved)", "_st.hit = (time.monotonic(), saved)", "копия — как устаревшая"),
    ("    finally:\n        _busy.clear()", "    finally:\n        pass", "флаг фона снимается"),
    ("                _busy.clear()\n                _log(", "                pass\n                _log(", "флаг при сбое запуска потока"),
    ("            _st.err_at = time.monotonic()\n            hit = _st.hit", "            hit = _st.hit", "пауза после падения сборки"),
    ("born = time.monotonic() if priced else time.monotonic() - TTL + ERR_TTL", "born = time.monotonic()", "без цен — ответ ненадолго"),
    # Защита от атак через источник.
    ("return u.scheme in SCHEMES and u.hostname in HOSTS and", "return True or", "только https и известные адреса"),
    (" and not u.username and not u.password", "", "адрес с логином"),
    ("ProxyHandler({}), _NoRedirect,", "ProxyHandler({}),", "без перенаправлений"),
    ("if time.monotonic() > end:", "if False:", "срок чтения целиком"),
    ("r.read1(min(CHUNK, limit + 1 - len(buf)))", "r.read1(CHUNK)", "кусок не больше остатка"),
    ("parse_float=_finite, ", "", "числа без бесконечностей"),
    ("parse_int=_short_int,\n", "\n", "числа не длиннее INT_MAX цифр"),
    (",\n                            parse_constant=_no_constant)", ")", "NaN и Infinity"),
    ("except (ValueError, RecursionError):", "except ValueError:", "сверхглубокая вложенность"),
    ('c if c.isprintable() else "?"', "c", "журнал без управляющих символов"),
    ("clean[:LOG_MAX]", "clean", "длина строки журнала"),
    ('_DIGITS = re.compile(r"[0-9]{1,12}")', '_DIGITS = re.compile(r"\\S{1,12}")', "индекс — только ASCII-цифры"),
    ("return v if type(v) is int else -1", "return int(v) if isinstance(v, (int, float)) else -1", "время — только целое"),
    ("isinstance(v, (int, float)) and not isinstance(v, bool)", "isinstance(v, (int, float))", "цена — не True"),
    ("while len(buf) <= limit:", "while len(buf) < limit:", "ответ больше limit — не ответ"),
    ("            return None\n    except (OSError", "            return bytes(buf)\n    except (OSError", "обрезанный ответ — не ответ"),
    ("    with contextlib.suppress(OSError, ValueError):\n        print(", "    if True:\n        print(", "журнал не роняет модуль"),
    ("build_opener(urllib.request.ProxyHandler({}), ", "build_opener(", "прокси из окружения не берётся"),
    (', "Accept-Encoding": "identity"}', "}", "ответ без сжатия"),
    ("    infos.sort(key=lambda a: a[0] != socket.AF_INET)\n", "", "соединение: IPv4 первыми"),
    ("sock.settimeout(min(CONNECT, left))", "sock.settimeout(left)", "соединение: адрес — не дольше CONNECT"),
    ("            err = e\n            continue", "            raise", "соединение: молчащий адрес — к следующему"),
    ("    if host not in HOSTS:\n        raise OSError", "    if False:\n        raise OSError", "соединение: только HOSTS"),
    ("        if left <= MIN_LEFT:\n            break\n", "", "соединение: без времени — не пробуем"),
    ("        sock.settimeout(limit)\n", "", "соединение: дальше — тайм-аут запроса"),
    ("        self._create_connection = _connect\n", "", "запросы — через _connect"),
    ("            sock.close()\n", "", "соединение: молчащий сокет закрыт"),
    ('        _log(f"{host}: {type(e).__name__}: {e}")\n', "", "причина сбоя — в журнал"),
    ('            _log(f"{host}: ответ больше {limit} байт")\n', "", "слишком большой ответ — в журнал"),
    ('                    _log(f"{host}: не уложился в {hop:.0f} с")\n', "", "медленный источник — в журнал"),
    ("got = _parse(f.read(HIST_MAX + 1))", "got = _parse(f.read())", "копия на диске — не больше предела"),
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
            # Тесты зависли (мутант пустил запрос в сеть, и тот ждёт) — порча
            # замечена: убита, а не сбой проверки.
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


a1 = run(f"{ROOT}/src/lib/fng.ts", ["node", "--test", "tests/fng.test.ts", "tests/fng.props.test.ts"], TS)
# Сервер — только тесты «Страха и жадности» (test_fng_*), без фаззинга: он
# на каждую мутацию не уложился бы в срок проверки CI; фаззинг идёт в
# обычных тестах.
a2 = run(f"{ROOT}/wt_fng.py", [sys.executable, "-m", "unittest", "tests.test_fng_api", "tests.test_fng_security",
                               "tests.test_fng_policy"], PY)
alive = a1 + a2
total = len(TS) + len(PY) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
