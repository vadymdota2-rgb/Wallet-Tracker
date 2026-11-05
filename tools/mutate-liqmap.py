"""Мутационная проверка карты ликвидаций: python3 tools/mutate-liqmap.py

Как у остальных модулей: портим src/lib/liqmap.ts и wt_liqmap.py по одному
месту (граница, знак, константа, защита кэша) и гоняем их тесты. Убитая мутация —
тесты заметили порчу; выжившая — дыра в тестах. Файл после каждой мутации
возвращается как был.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные: сужение полосы после сгорания — только скорость: без него
# свеча снова проходит уже пустые корзины, результат тот же.
# «Цена больше нуля» перекрыта проверкой нижнего края (0 ≤ lo < px): цена
# не больше нуля и так не ответ.
EQUIV = {"сгоревшая полоса лонгов не горит дважды", "сгоревшая полоса шортов не горит дважды", "цена больше нуля"}
TS = [
    ('return typeof e === "string" && (LIQ_ERRORS as readonly string[]).includes(e)', 'return typeof e === "string"', "ошибки — только известные"),
    ('if (raw["ok"] !== true) return null;', "", "карта — только ok: true"),
    ("if (typeof sym !== \"string\" || !SYM.test(sym)) return null;", "if (typeof sym !== \"string\") return null;", "тикер — буквы и цифры"),
    ("!(LIQ_RANGES as readonly string[]).includes(range)) return null;", "false) return null;", "окно — только известное"),
    ("if (!pos(px) || !pos(step) || !nonNeg(lo) || lo >= px) return null;", "if (!pos(px) || !pos(step)) return null;", "нижний край сетки"),
    ("if (!pos(px) || !pos(step) || !nonNeg(lo) || lo >= px) return null;", "if (!fin(px) || !pos(step) || !nonNeg(lo) || lo >= px) return null;", "цена больше нуля"),
    ("ex.length > 64 ||", "", "бирж не больше 64"),
    ("if (!Array.isArray(levs) || levs.length < 1 || levs.length > LEVS_MAX) return null;", "if (!Array.isArray(levs)) return null;", "групп плеч 1–8"),
    ("(i === 0 || l > (levs[i - 1] as number))", "true", "плечи по возрастанию"),
    ("buckets.length > BUCKETS_MAX", "false", "корзин не больше предела"),
    ("if (!isObj(b) || !pos(b[\"p\"])) return null;", "if (!isObj(b)) return null;", "цена корзины"),
    ("if (!Array.isArray(v) || v.length !== n || !v.every(money)) return null;", "if (!Array.isArray(v) || !v.every(money)) return null;", "группы корзины — как плечи"),
    ("const money = (v: unknown): v is number => nonNeg(v) && Number.isInteger(v);", "const money = (v: unknown): v is number => fin(v);", "деньги — целые ≥ 0"),
    ("if (!isObj(c) || !money(c[\"L\"]) || !money(c[\"S\"])) return null;", "if (!isObj(c)) return null;", "накопленное — деньги"),
    ("path.length < 1 || path.length > PATH_MAX || !path.every(pos)", "!path.every(pos)", "путь цены — 1–200 точек"),
    ("if (!Array.isArray(ohlc) || ohlc.length > OHLC_MAX) return null;", "if (!Array.isArray(ohlc)) return null;", "свечей не больше предела"),
    ("if (h < l || o > h || o < l || c > h || c < l) return null;", "", "свеча — открытие и закрытие внутри"),
    ("if (!money(oi) || (seen !== undefined && !money(seen))) return null;", "if (!money(oi)) return null;", "«видно» — деньги"),
    ("(at as number) > now + AHEAD_MAX", "false", "сборка не из будущего"),
    ("{ seen: Math.min(seen as number, oi) }", "{ seen: seen as number }", "«видно» не больше интереса"),
    ("ex: ex.slice() as string[],", "ex: ex as string[], evil: 1,", "только известные поля"),
    ("const base = Math.max(1, Math.round((hi - lo) / r.step / 60));", "const base = Math.max(1, Math.floor((hi - lo) / r.step / 30));", "строк около шестидесяти"),
    ("const row = rows[Math.floor((b.p - lo) / size)];", "const row = rows[Math.round((b.p - lo) / size)];", "корзина — в свою строку"),
    ("  return { rows: rows.reverse(), rowH };", "  return { rows, rowH };", "строки сверху вниз"),
    ("    if (w && w.mid > p) {\n      acc += sumOn(w.S, on);", "    if (w) {\n      acc += sumOn(w.S, on);", "накопленное шортов — выше цены"),
    ("acc += sumOn(w.L, on);", "acc += sum(w.L);", "выключенная группа не считается"),
    ("if ((up ? d <= 0 : d >= 0) || Math.abs(d) > within) continue;", "if (Math.abs(d) > within) continue;", "скопление — на своей стороне"),
    ("if ((up ? d <= 0 : d >= 0) || Math.abs(d) > within) continue;", "if (up ? d <= 0 : d >= 0) continue;", "скопление — в окне"),
    ("const hit = list.filter((g) => g.v >= max * 0.5).sort((a, b) => a.k - b.k)[0];", "const hit = list.sort((a, b) => a.k - b.k)[0];", "ближайшее — крупное"),
    ("if (out.every((x) => Math.abs(x.k - g.k) >= 2)) out.push(g);", "out.push(g);", "крупнейшие — не соседние"),
    ("const list = bands(r, up, Math.max(0.005, span / 3000), span / 100).sort((a, b) => b.v - a.v);", "const list = bands(r, up, Math.max(0.005, span / 3000), span / 100);", "крупнейшие — по убыванию"),
    ("  return Math.max(0, Math.floor((now - at) / 60));", "  return Math.floor((now - at) / 60);", "возраст — не минус"),
    ("export const LIQ_OLD_MIN = 40;", "export const LIQ_OLD_MIN = 400;", "пометка старых данных"),
]
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
    ("cut_l, cut_s = bisect.bisect_left(self.mids, low), bisect.bisect_right(self.mids, hi)", "cut_l, cut_s = BUCKETS, bisect.bisect_right(self.mids, hi)", "свеча сжигает лонги"),
    ("cut_l, cut_s = bisect.bisect_left(self.mids, low), bisect.bisect_right(self.mids, hi)", "cut_l, cut_s = bisect.bisect_left(self.mids, low), 0", "свеча сжигает шорты"),
    ("                    mark[b] = at\n", "", "сгоревшие пачки не живы"),
    ("        return [x for x in c[2] if self.burnt[x[0]][x[1]][x[2]] <= c[0]]", "        return list(c[2])", "живые — только не сгоревшие позже"),
    ("        return [x for x in c[2] if self.burnt[x[0]][x[1]][x[2]] <= c[0]]", "        return [x for x in c[2] if self.burnt[x[0]][x[1]][x[2]] < c[0]]", "сгорело до открытия — пачка жива"),
    ("_, hi, low, p_now, _oi, bs = rows[i - 1]", "_, hi, low, p_now, _oi, bs = rows[i]", "прирост — в свече между снимками"),
    ("        p_prev = rows[i - 2][3]\n", "        p_prev = p_now\n", "интерес — в монетах по цене снимка"),
    ("q_prev, q_now = rows[i - 1][4] / p_prev, rows[i][4] / p_now", "q_prev, q_now = rows[i - 1][4], rows[i][4]", "интерес — в монетах, а не в долларах"),
    ("        x = q_now - q_prev + book.burn(i, hi, low)", "        book.burn(i, hi, low)\n        x = q_now - q_prev", "сгоревшее замещается новыми"),
    ("            book.close(-x)\n", "            pass\n", "падение интереса закрывает позиции"),
    ("            c = self.cohorts[-1]\n", "            c = self.cohorts[0]\n", "закрываются самые свежие"),
    ("            keep = 1 - amount / mass\n", "            keep = 0.0\n", "пачка закрывается на долю"),
    ("            c[1] *= keep\n", "", "доля пачки запоминается"),
    ("    for i in range(2, len(rows)):", "    for i in range(3, len(rows)):", "первый шаг — со второго снимка"),
    ("        book.burn(len(rows), rows[-1][1], rows[-1][2])", "        pass", "идущая свеча сжигает уровни"),
    ("SMOOTH = (0.25, 0.5, 0.25)", "SMOOTH = (0.0, 1.0, 0.0)", "сглаживание соседей"),
    ("a[max(0, i - 1)]", "a[i - 1]", "сглаживание: левый край без потерь"),
    ("    if tail[0][0] > cut:\n        return main\n", "", "хвост дотягивается до идущей свечи"),
    ("[r for r in main if r[0] < cut] + [r for r in tail if r[0] >= cut]", "main + [r for r in tail if r[0] > cut]", "хвост заменяет идущую свечу"),
    ("            self.top_l[g] = min(self.top_l[g], cut_l - 1)\n", "", "сгоревшая полоса лонгов не горит дважды"),
    ("            self.bot_s[g] = max(self.bot_s[g], cut_s)\n", "", "сгоревшая полоса шортов не горит дважды"),
    ("                self.top_l[g] = max(self.top_l[g], b)\n", "                pass\n", "полоса лонгов растёт с новыми"),
    ("                self.bot_s[g] = min(self.bot_s[g], b)\n", "                pass\n", "полоса шортов растёт с новыми"),
    ("SPAN = 1.0\nBUCKETS = 800", "SPAN = 0.15\nBUCKETS = 120", "сетка до ±100 %"),
    # Плечи по биржам.
    ('"dYdX": 20,', '"dYdX": 200,', "предел плеча биржи"),
    ("    return cap if sym in MAJORS else min(cap, ALT_CAP)", "    return cap", "у альтов плечо меньше"),
    ("    cap = CAPS.get(ex, CAP_OTHER)", "    cap = CAPS.get(ex, 500)", "незнакомая биржа — осторожный предел"),
    ("    kept = [x for x in LEVS if x[0] <= cap] or [LEVS[0]]", "    kept = list(LEVS)", "плечи выше предела не открыть"),
    ("    kept = [x for x in LEVS if x[0] <= cap] or [LEVS[0]]", "    kept = [x for x in LEVS if x[0] <= cap]", "предел ниже 3× — хотя бы 3×"),
    ("    return tuple((lev, w / total, g) for lev, w, g in kept)", "    return tuple(kept)", "доли — снова в сумме 1"),
    ("        lg, sg, mass = model(rows, lo, step, levs_upto(max_lev(ex, sym)))", "        lg, sg, mass = model(rows, lo, step)", "у каждой биржи — свои плечи"),
    # Самочистка.
    ("        _sweep()\n        while len(_st.hits) > CACHE_MAX:", "        while len(_st.hits) > CACHE_MAX:", "сборка чистит старое"),
    ("    with _lock:\n        _sweep()\n        hit = _st.hits.get(key)", "    with _lock:\n        hit = _st.hits.get(key)", "прогрев чистит старое"),
    ("    for k in [k for k, v in _st.hits.items() if t - v[0] >= STALE]:", "    for k in [k for k, v in _st.hits.items() if t - v[0] >= STALE * 100]:", "старые карты — вон"),
    ("    for k in [k for k, v in _st.fails.items() if t - v >= FAIL_WAIT]:", "    for k in [k for k, v in _st.fails.items() if t - v >= 0]:", "свежая пауза остаётся"),
    ("    for k in [k for k, v in _st.fails.items() if t - v >= FAIL_WAIT]:", "    for k in [k for k, v in _st.fails.items() if t - v >= FAIL_WAIT * 100]:", "старые паузы — вон"),
    # Чистка рядов бирж.
    ("    if isinstance(v, bool) or not isinstance(v, (int, float)):", "    if not isinstance(v, (int, float)):", "bool — не число"),
    ("if not (0 < low <= hi < PX_MAX and 0 < c < PX_MAX and hi <= low * RANGE_MAX and 0 <= oi <= OI_MAX):", "if not (0 < low <= hi and 0 < c and 0 <= oi):", "пределы правдоподобия"),
    ("if not (0 < low <= hi < PX_MAX and 0 < c < PX_MAX and hi <= low * RANGE_MAX and 0 <= oi <= OI_MAX):", "if not (0 < low and 0 < c < PX_MAX and hi <= low * RANGE_MAX and 0 <= oi <= OI_MAX):", "максимум не ниже минимума"),
    ("        share = bs if bs is not None and 0 <= bs <= 1 else 0.5", "        share = bs if bs is not None else 0.5", "доля покупок 0–1"),
    ("        out[t] = (t, max(hi, c), min(low, c), c, oi, share)", "        out[t] = (t, hi, low, c, oi, share)", "закрытие — внутри свечи"),
    ("    ok = [out[t] for t in sorted(out)][-ROWS_MAX:]", "    ok = list(out.values())[-ROWS_MAX:]", "свечи — по времени"),
    ("    ok = [out[t] for t in sorted(out)][-ROWS_MAX:]", "    ok = [out[t] for t in sorted(out)]", "свечей не больше ROWS_MAX"),
    ("isinstance(r[0], bool) or not isinstance(r[0], int)", "not isinstance(r[0], int)", "время — не bool"),
    ("abs(b / a - 1) <= SPIKE_PAIR and abs(m / a - 1) > SPIKE and abs(m / b - 1) > SPIKE", "abs(m / a - 1) > SPIKE", "выброс — соседи согласны"),
    ("abs(b / a - 1) <= SPIKE_PAIR and abs(m / a - 1) > SPIKE and abs(m / b - 1) > SPIKE", "False", "выброс заменяется"),
    ("            ok[i] = (*ok[i][:4], (a * b) ** 0.5 * px[i], ok[i][5])", "            ok[i] = (*ok[i][:4], 0.0, ok[i][5])", "выброс — средним соседей"),
    ("    px = [ok[max(0, j - 1)][3] for j in range(len(ok))]", "    px = [ok[j][3] for j in range(len(ok))]", "выброс — по цене снимка"),
    ('"low": min(px, (last or ref[-1])[2]), "high": max(px, (last or ref[-1])[1])}', '"low": min(px, ref[-1][2]), "high": max(px, ref[-1][1])}', "край сгорания — мелкая свеча"),
    ("                if t_ref:\n                    tail_ref.extend(t_ref)\n", "", "опора хвоста — в край сгорания"),
    ("ref[-1][0] - rows[-1][0] <= STALE_ROWS * span}", "True}", "отставшая биржа не берётся"),
    ("ref[-1][0] - rows[-1][0] <= STALE_ROWS * span}", "ref[-1][0] - rows[-1][0] <= span}", "отставание — до STALE_ROWS свечей"),
    ("    got = {ex: splice(c, clean_rows(tail.get(ex))) for ex, rows in got.items() if len(c := clean_rows(rows)) >= 8}", "    got = {ex: splice(rows, tail.get(ex)) for ex, rows in got.items()}", "ряды бирж — чистые"),
    ("        got = fresh(got, ref)\n", "        pass\n", "отставшие биржи — вон"),
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
    ('"low": min(px, (last or ref[-1])[2]), "high": max(px, (last or ref[-1])[1])}', '"low": px, "high": px}', "ход идущей свечи — сгорел"),
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
    ("                tail.update(t_got)\n", "", "хвост — в модель"),
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
    # Копия на диске.
    ("        out[side] = [[[b, round(v, 9)] for b, v in enumerate(g) if v > 0] for g in st[side]]", "        out[side] = [[[b, round(v, 9)] for b, v in enumerate(g)] for g in st[side]]", "в копии — только непустые корзины"),
    ("    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v < PX_MAX * OI_MAX", "    return isinstance(v, (int, float)) and 0 < v < PX_MAX * OI_MAX", "копия: bool — не число"),
    ("    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v < PX_MAX * OI_MAX", "    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v", "копия: пределы чисел"),
    ("lo >= 0 and type(at) is int and at > 0\n", "lo >= 0 and isinstance(at, int)\n", "копия: время сборки"),
    ("        and abs(lo - px * (1 - SPAN)) <= px * 1e-9 and abs(step - px * SPAN * 2 / BUCKETS) <= px * 1e-12\n", "", "копия: та же сетка"),
    ("and isinstance(ex, list) and len(ex) <= 64 and all(", "and isinstance(ex, list) and all(", "копия: бирж не больше 64"),
    ("isinstance(path, list) and 0 < len(path) <= 200 and", "isinstance(path, list) and", "копия: путь цены"),
    ("isinstance(ohlc, list) and 0 < len(ohlc) <= 100", "isinstance(ohlc, list)", "копия: свечи"),
    ("and len(c) == 4 and all(_pos(x) for x in c) for c in ohlc)", "and all(_pos(x) for x in c) for c in ohlc)", "копия: свеча из четырёх чисел"),
    ("and type(oi) is int and type(seen) is int and seen >= 0 and oi >= 0 and", "and isinstance(oi, int) and isinstance(seen, int) and", "копия: интерес"),
    ("    if not (isinstance(groups, list) and len(groups) == len(GROUPS)):", "    if not isinstance(groups, list):", "копия: те же группы плеч"),
    ("isinstance(cell, list) and len(cell) == 2 and type(cell[0]) is int", "isinstance(cell, list) and type(cell[0]) is int", "копия: клетка — пара"),
    ("data.get(\"v\") != DUMP_VERSION or ", "", "копия: версия"),
    ("    if since < 0:\n        return 0  #", "    if False:\n        return 0  #", "копия из будущего не берётся"),
    ("    for m in data[\"maps\"][:CACHE_MAX]:", "    for m in data[\"maps\"]:", "копия: не больше кэша"),
    ("not isinstance(age, bool) and age >= 0):", "not isinstance(age, bool)):", "копия: возраст не меньше нуля"),
    ("        if total >= STALE:\n", "        if age >= STALE:\n", "копия: возраст — с записи файла"),
    ("            if key in _st.hits:\n                continue\n", "", "копия не поверх свежей сборки"),
    ("            _st.hits[key] = (time.monotonic() - total, st, res)", "            _st.hits[key] = (time.monotonic(), st, res)", "копия: возраст сохраняется"),
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


a1 = run(f"{ROOT}/src/lib/liqmap.ts", ["node", "--test", "tests/liqmap.test.ts", "tests/liqmap.props.test.ts"], TS)
a2 = run(f"{ROOT}/wt_liqmap.py", [sys.executable, "-m", "unittest", "tests.test_liqmap", "tests.test_liqmap_fuzz", "tests.test_liqmap_disk"], PY)
alive = a1 + a2
total = len(TS) + len(PY) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
