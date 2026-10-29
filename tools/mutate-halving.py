"""Мутационная проверка модуля халвинга: python3 tools/mutate-halving.py

Портим код по одному месту (граница, знак, константа, защита) и гоняем
тесты. Убитая мутация — тесты заметили порчу; выжившая — дыра в тестах.
Файл после каждой мутации возвращается как был. Эквивалентные мутации
(не меняют ничего наблюдаемого) помечены и в счёт не идут.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные: «граница награды» — 50 BTC >> 63 и >> 64 оба ноль;
# «озвучка неполного отсчёта» — массив частей плотный: после первой
# пропущенной пропущены и все следующие, break и continue дают одно и то же;
# «ноль как высота» — высота не ниже настоящего блока (ANCHOR_HEIGHT), а next
# больше высоты: ноль не проходит ни там, ни там и без v > 0.
EQUIV = {"граница награды", "озвучка неполного отсчёта", "int: ноль как высота"}
TS = [
    ("v > 0;", "v >= 0;", "int: ноль как высота"),
    ("r.height < r.next", "r.height <= r.next", "высота равна next"),
    ("Math.abs(d) > SKEW_MIN ? d : 0", "d", "поправка часов на любую мелочь"),
    ("epoch >= 64 ? 0", "epoch >= 63 ? 0", "граница награды"),
    ("Math.floor(eta - now)", "Math.ceil(eta - now)", "округление остатка"),
    ("Math.min(h.next - 1,", "Math.min(h.next,", "высота до халвинга"),
    ("Math.min(99.9,", "Math.min(100,", "100 % до халвинга"),
    ("since < JUST_HAPPENED", "since < JUST_HAPPENED * 3", "окно «состоялся»"),
    ("left % 60]", "left % 61]", "секунды"),
    ("&& r.height >= ANCHOR_HEIGHT\n", "\n", "высота не ниже настоящего блока"),
    ("Math.max(0, r.at - ANCHOR_TS) / AVG_MIN", "Math.max(0, r.at - ANCHOR_TS) / 300", "высота: скорость блоков с опоры"),
    ("/ AVG_MIN) + RETARGET", "/ AVG_MIN) + RETARGET + 1", "высота: запас — ровно период сложности"),
    ("Math.max(0, r.at - ANCHOR_TS)", "(r.at - ANCHOR_TS)", "высота: ответ из прошлого"),
    ("Math.max(0, Math.floor((now - tip) / h.avg))", "Math.floor((now - tip) / h.avg)", "высота назад"),
    ("rewardNext: subsidySats(epoch + 1)", "rewardNext: subsidySats(epoch)", "следующая награда"),
    ("since >= 0 &&", "since >= -1e12 &&", "«состоялся» из будущего"),
    ("Math.abs(v) < 366 * 86400", "Math.abs(v) < 1e12", "предел поправки часов"),
    ('v === "epoch" || v === "period" || v === "nominal"', "true", "src любой"),
    ('.filter((p) => p.type === "unit")', '.filter((p) => p.type !== "literal")', "подпись — только единица"),
    ('unitFormat(lang, unit, "short")?.formatToParts(n)', 'unitFormat(lang, unit, "long")?.formatToParts(n)', "подпись короткая"),
    ('formatToParts(n);', 'formatToParts(1);', "форма слова по числу"),
    ('{ type: "unit", style: "long" }', '{ type: "conjunction", style: "long" }', "озвучка без «и»"),
    ("if (n === undefined) break;", "if (n === undefined) continue;", "озвучка неполного отсчёта"),
    ('if (age > STALE_MAX) return "gone";', 'if (age > STALE_MAX * 2) return "gone";', "ответ старше суток — не показываем"),
    ("(HALVING_SOURCES as readonly unknown[]).includes(v)", "typeof v === \"string\"", "источник — только из списка"),
    ("if (!(HALVING_SOURCES as readonly unknown[]).includes(by)) return null;", "if (!by) return null;", "подпись — только из списка"),
    ('by !== "mempool.space" && src === "period"', 'src === "period"', "второй источник — только если высота не от mempool"),
    ('by !== "mempool.space" && src === "period"', 'by !== "mempool.space"', "второй источник — только при среднем периода"),
    ('return age > STALE_AFTER ? "old" : "fresh";', 'return age >= STALE_AFTER * 2 ? "old" : "fresh";', "пометка «Обновлено» после 3 часов"),
    ("r.every === EVERY", "int(r.every)", "интервал халвинга — правило сети"),
    ("tip > r.at - TIP_AGE", "tip >= r.at - TIP_AGE", "последний блок не старше суток"),
    ("tip <= r.at + TIP_AHEAD", "tip <= r.at + TIP_AHEAD + 1", "последний блок не из будущего"),
    ("<= ETA_SLACK", "<= ETA_SLACK + 2", "eta сходится с высотой и средним"),
    ('if (typeof tip !== "number") return true;', 'if (typeof tip !== "number") return false;', "старый ответ без tip"),
]
PY = [
    ("        if _failed():\n            return hit[1] if hit else _no_data()\n", "", "пауза после сбоя"),
    ("    job.join(COLD_WAIT)\n", "    job.join()\n", "холодный старт ждёт не дольше COLD_WAIT"),
    ("    if job is None:\n        return build()\n", "    if job is None:\n        return _no_data()\n", "нет потока — собираем сами"),
    ("    if _busy.is_set():\n        return _st.job\n", "", "один сборщик на холодном старте"),
    ("    return hit if hit and time.monotonic() - hit[0] < STALE_MAX else None", "    return hit", "старый ответ — не дольше суток"),
    ("            return h, 0, by\n", "            return h, 0, \"mempool.space\"\n", "подпись — настоящий источник, а не mempool всегда"),
    ("tip_ts <= t_now + MAX_FUTURE", "tip_ts <= t_now + 10**9", "время блока из будущего"),
    ("height - start >= RETARGET", "height - start >= 0", "среднее в начале эпохи"),
    ("return ANCHOR_HEIGHT <= h <=", "return ANCHOR_HEIGHT - 10**6 <= h <=", "высота не ниже настоящего блока"),
    ("max(0, _now() - ANCHOR_TS) // AVG_MIN", "max(0, _now() - ANCHOR_TS) // 300", "высота: скорость блоков с опоры"),
    ("// AVG_MIN) + RETARGET", "// AVG_MIN) + RETARGET + 1", "высота: запас — ровно период сложности"),
    ("int(max(0, _now() - ANCHOR_TS)", "int((_now() - ANCHOR_TS)", "высота: часы сервера раньше опоры"),
    ('"eta": int(tip_ts + (nxt - height) * avg)', '"eta": int(t_now + (nxt - height) * avg)', "eta от последнего блока"),
    ("    if left <= MIN_LEFT:\n        return None", "    if left <= -1:\n        return None", "бюджет исчерпан"),
    ("    infos.sort(key=lambda a: a[0] != socket.AF_INET)\n", "", "соединение: IPv4 первыми"),
    ('        _why(f"{host}: {type(e).__name__}: {e}")\n', "", "причина сбоя — в журнал"),
    ("    _dl.why = []\n", "", "причины собираются на сборку"),
    ("        _dl.why = None\n", "", "после сборки причины убраны"),
    ("len(why) < WHY_MAX", "len(why) < 10**6", "причин — не больше WHY_MAX"),
    ('or ["ответы неправдоподобны"]', 'or []', "без сбоев сети — названа причина"),
    ("sock.settimeout(min(CONNECT, left))", "sock.settimeout(left)", "соединение: адрес — не дольше CONNECT"),
    ("            sock.close()\n            err = e\n            continue", "            raise", "соединение: молчащий адрес — к следующему"),
    ("            sock = socket.socket(family, kind, proto)\n        except OSError as e:\n            err = e\n            continue",
     "            sock = socket.socket(family, kind, proto)\n        except OSError:\n            raise", "соединение: нет IPv6 — к следующему адресу"),
    ("    if host not in HOSTS:\n        raise OSError", "    if False:\n        raise OSError", "соединение: только HOSTS"),
    ("        if left <= MIN_LEFT:\n            break\n", "", "соединение: без времени — не пробуем"),
    ("        sock.settimeout(limit)\n", "", "соединение: дальше — тайм-аут запроса"),
    ("        self._create_connection = _connect\n\n\nclass _ConnPlain", "\n\n\nclass _ConnPlain", "запросы — через _connect"),
    ("            sock.close()\n            err", "            err", "соединение: молчащий сокет закрыт"),
    ("hop = min(HOP, left)", "hop = HOP", "таймаут по остатку бюджета"),
    ('if not re.fullmatch(r"[0-9a-f]{64}", bh):', "if False:", "проверка хеша"),
    ("        _dl.at = 0.0\n", "        pass\n", "срок сборки сбрасывается"),
    ('        res["prev"] = start_ts', "        pass", "prev в ответе"),
    ("            _st.err_at = time.monotonic()\n        return", "            pass\n        return", "запоминание сбоя"),
    ("            _st.err_at = time.monotonic()\n            hit", "            pass\n            hit", "пауза после падения сборки"),
    ("nxt = start + EVERY", "nxt = start + EVERY + 1", "номер блока халвинга"),
    ('"now": _now()', '"now": 0', "now в ответе"),
    ("    finally:\n        _busy.clear()", "    finally:\n        pass", "флаг фона снимается"),
    ("if 1_700_000_000 < ts <= _now():", "if 1_700_000_000 < ts:", "время начала эпохи из будущего"),
    ("        _busy.clear()\n        _log(", "        pass\n        _log(", "флаг при сбое запуска потока"),
    # Защита от атак через источник.
    ("return u.scheme in SCHEMES and u.hostname in HOSTS and", "return True or", "только https и известные адреса"),
    (" and not u.username and not u.password", "", "адрес с логином"),
    ("ProxyHandler({}), _NoRedirect,", "ProxyHandler({}),", "без перенаправлений"),
    ("    ctx.minimum_version = ssl.TLSVersion.TLSv1_2\n", "", "TLS не старше 1.2 — явно, а не из системы"),
    ("        _watch(sock, end)\n", "", "срок на всё соединение: TLS и заголовки"),
    ("    dns.join(max(0.0, end - time.monotonic()))\n", "    dns.join()\n", "DNS — не дольше срока"),
    ("                    if time.monotonic() < end:\n                        return bytes(buf)\n                    break",
     "                    return bytes(buf)", "оборванный сторожем ответ — не ответ"),
    ("            watch.close()\n", "", "копия сокета сторожа закрыта"),
    ("self.do_open(_ConnPlain, req)", "super().http_open(req)", "тесты ходят через _connect"),
    ("r.read1(min(CHUNK, limit + 1 - len(buf)))", "r.read1(CHUNK)", "кусок не больше остатка"),
    ("parse_float=_finite, ", "", "числа без бесконечностей"),
    ("parse_int=_short_int,\n", "\n", "числа не длиннее INT_MAX цифр"),
    (",\n                            parse_constant=_no_constant)", ")", "NaN и Infinity"),
    ("raw = _fetch(url, JSON_MAX)", "raw = _fetch(url)", "ответ-JSON не больше 4 КБ"),
    (' if blk and _whole(blk.get("height")) == h else 0', " if blk else 0", "блок начала эпохи — той высоты"),
    ("except (ValueError, RecursionError):", "except ValueError:", "сверхглубокая вложенность"),
    ('c if c.isprintable() else "?"', "c", "журнал без управляющих символов"),
    ("clean[:LOG_MAX]", "clean", "длина строки журнала"),
    ('re.fullmatch(rb"[0-9]{1,20}", raw)', "raw.strip(b\" \").isascii()", "высота — только ASCII-цифры"),
    ("return v if type(v) is int else 0", "return int(v) if isinstance(v, (int, float, str)) else 0", "высота и время — только целые"),
    ("isinstance(v, (int, float)) and not isinstance(v, bool)", "isinstance(v, (int, float, str))", "среднее — только число"),
    ("while len(buf) <= limit:", "while len(buf) < limit:", "ответ больше limit — не ответ"),
    ("            return None\n    except (OSError", "            return bytes(buf)\n    except (OSError", "обрезанный ответ — не ответ"),
    ("    with contextlib.suppress(OSError, ValueError):\n        print(", "    if True:\n        print(", "журнал не роняет модуль"),
    ("build_opener(urllib.request.ProxyHandler({}), ", "build_opener(", "прокси из окружения не берётся"),
    (', "Accept-Encoding": "identity"}', "}", "ответ без сжатия"),
]
TICK = [
    ("1000 - (t % 1000) + TICK_SLACK", "1000", "тик на границе секунды"),
    ("timer = subs.size ? setTimeout(tick, untilNextSecond(Date.now())) : undefined;",
     "timer = setTimeout(tick, untilNextSecond(Date.now()));", "остановка после отписки в тике"),
    ("if (Math.abs(t - stamp) >= 1000) stamp = t;", "if (t - stamp >= 1000) stamp = t;", "часы назад"),
    ("if (!timer) timer = setTimeout", "timer = setTimeout", "один таймер на всех"),
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
                killed = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=120, check=False).returncode != 0
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

a1 = run(f"{ROOT}/src/lib/halving.ts", ["node", "--test", "tests/halving.test.ts", "tests/halving.props.test.ts"], TS)
a3 = run(f"{ROOT}/src/lib/tick.ts", ["node", "--test", "tests/tick.test.ts"], TICK)
# Сервер — только тесты халвинга (test_halving_*: wt_halving больше никто не
# проверяет): весь набор тестов проекта на каждую мутацию не укладывался в
# срок проверки CI.
a2 = run(f"{ROOT}/wt_halving.py", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_halving*.py"], PY)
alive = a1 + a2 + a3
total = len(TS) + len(PY) + len(TICK) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
