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
    ("    (75, 0.04, 3), (100, 0.04, 3),", "    (75, 0.04, 3), (100, 0.14, 3),", "доли плеч — в сумме 1"),
    ("    (125, 0.01, 4), (200, 0.005, 4), (500, 0.005, 4),", "    (125, 0.01, 3), (200, 0.005, 4), (500, 0.005, 4),", "125× — в группе 125–500×"),
    ("    return min(MMR, 0.5 / lev)", "    return MMR", "маржа меньше начальной"),
    ("    return min(MMR, 0.5 / lev)", "    return min(MMR, 1 / lev)", "маржа — половина начальной"),
    ("    (20, 0.15, 1), (25, 0.10, 1),", "    (20, 0.15, 0), (25, 0.10, 1),", "плечо — в своей группе"),
    ("MMR = 0.005", "MMR = 0.05", "поддерживающая маржа"),
    ("ENTRY = 5", "ENTRY = 1", "вход — по диапазону свечи"),
    ("p = low + (hi - low) * (e + 0.5) / ENTRY", "p = low + (hi - low) * e / ENTRY", "точки входа — по середине долей"),
    ("part = x * w / ENTRY", "part = x * w", "прирост делится между точками входа"),
    ("            keep = 1 / lev - mmr(lev)", "            keep = 1 / lev + mmr(lev)", "до ликвидации — начальная минус поддерживающая"),
    ("bl = bucket(p * (1 - keep), lo, step)", "bl = bucket(p * (1 + keep), lo, step)", "цена ликвидации лонга"),
    ("bsh = bucket(p * (1 + keep), lo, step)", "bsh = bucket(p * (1 - keep), lo, step)", "цена ликвидации шорта"),
    # Сетка до +500 %: мелкие корзины до удвоения, дальше — грубые.
    ("    return int(f) if f < FINE else FINE + int((f - FINE) // COARSE)", "    return int(f)", "выше удвоения — грубые корзины"),
    ("    return fine + [lo + step * (FINE + COARSE * (j + 0.5)) for j in range(WIDE)]", "    return fine + [lo + step * (FINE + COARSE * j) for j in range(WIDE)]", "середины грубых корзин"),
    ("UP = 5.0", "UP = 1.0", "сетка до +500 %"),
    ("    n = min(len(a), FINE)", "    n = len(a)", "грубые корзины не сглаживаются"),
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
    ("        x = d + min(gone, max(0.0, -d))", "        x = d + gone", "сгоревшее новыми не замещается"),
    ("        x = d + min(gone, max(0.0, -d))", "        x = d", "ликвидации объясняют падение интереса"),
    ("        x = d + min(gone, max(0.0, -d))", "        x = d + max(0.0, -d)", "объясняют не больше сгоревшего"),
    ("            book.close(-x)\n", "            pass\n", "падение интереса закрывает позиции"),
    ("            c = self.cohorts[-1]\n", "            c = self.cohorts[0]\n", "закрываются самые свежие"),
    ("            keep = 1 - amount / mass\n", "            keep = 0.0\n", "пачка закрывается на долю"),
    ("            c[1] *= keep\n", "", "доля пачки запоминается"),
    ("    for i in range(2, len(rows)):", "    for i in range(3, len(rows)):", "первый шаг — со второго снимка"),
    ("        book.burn(len(rows), rows[-1][1], rows[-1][2])", "        pass", "идущая свеча сжигает уровни"),
    ("SMOOTH = (0.25, 0.5, 0.25)", "SMOOTH = (0.0, 1.0, 0.0)", "сглаживание соседей"),
    ("a[max(0, i - 1)]", "a[i - 1]", "сглаживание: левый край без потерь"),
    ("    if tail[0][0] > main[-1][0]:\n        return main\n", "", "хвост дотягивается до идущей свечи"),
    ("    return [r for r in main if span > 0 and r[0] + span <= tail[0][0]] + tail", "    return [r for r in main if span > 0 and r[0] <= tail[0][0]] + tail", "крупная свеча — только закончившаяся до хвоста"),
    ("    return [r for r in main if span > 0 and r[0] + span <= tail[0][0]] + tail", "    return [r for r in main if r[0] + span <= tail[0][0]] + tail", "одна крупная свеча — идущая"),
    ('TAIL = {"7d": ("15m", 12), "30d": ("15m", 24), "90d": ("4h", 180),', 'TAIL = {"7d": ("15m", 12), "30d": ("15m", 24), "90d": ("1h", 30),', "длинные окна — последние 30 дней 4-часовыми"),
    ("            self.top_l[g] = min(self.top_l[g], cut_l - 1)\n", "", "сгоревшая полоса лонгов не горит дважды"),
    ("            self.bot_s[g] = max(self.bot_s[g], cut_s)\n", "", "сгоревшая полоса шортов не горит дважды"),
    ("                self.top_l[g] = max(self.top_l[g], b)\n", "                pass\n", "полоса лонгов растёт с новыми"),
    ("                self.bot_s[g] = min(self.bot_s[g], b)\n", "                pass\n", "полоса шортов растёт с новыми"),
    ("SPAN = 1.0\nFINE = 800", "SPAN = 0.15\nFINE = 120", "сетка до ±100 %"),
    # Плечи по биржам.
    ('"dYdX": 20,', '"dYdX": 200,', "предел плеча биржи"),
    ("    return cap if sym in MAJORS else min(cap, ALT_CAP)", "    return cap", "у альтов плечо меньше"),
    ("    cap = CAPS.get(ex, CAP_OTHER)", "    cap = CAPS.get(ex, 500)", "незнакомая биржа — осторожный предел"),
    ("    kept = [x for x in LEVS if x[0] <= cap] or [LEVS[0]]", "    kept = list(LEVS)", "плечи выше предела не открыть"),
    ("    kept = [x for x in LEVS if x[0] <= cap] or [LEVS[0]]", "    kept = [x for x in LEVS if x[0] <= cap]", "предел ниже 3× — хотя бы 3×"),
    ("    return tuple((lev, w + (extra if lev == top else 0.0), g) for lev, w, g in kept)", "    return tuple(kept)", "доли — снова в сумме 1"),
    ("        lg, sg, mass = model(rows, lo, step, levs_upto(max_lev(ex, sym, caps)), since=ref[0][0],", "        lg, sg, mass = model(rows, lo, step, since=ref[0][0],", "у каждой биржи — свои плечи"),
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
    ("lo, step = px * (1 - SPAN), px * SPAN * 2 / FINE", "lo, step = px * (1 - SPAN), px * SPAN / FINE", "окно — ±SPAN"),
    ("    if path[-1] != px:\n        path.append(px)\n", "", "путь цены кончается ценой"),
    ("ohlc[-1] = [o, round(max(h, px), 10), round(min(lw, px), 10), round(px, 10)]", "ohlc[-1] = [o, h, lw, _c]", "последняя свеча — до текущей цены"),
    ("\"oi\": round(sum(r[-1][4] for r in got.values()))", "\"oi\": round(sum(r[0][4] for r in got.values()))", "интерес — последний"),
    ("\"seen\": min(st[\"seen\"], st[\"oi\"])", "\"seen\": st[\"oi\"]", "сколько видно — по модели"),
    ("\"seen\": round(seen * px)", "\"seen\": round(seen)", "видно — в долларах"),
    ("prev = rows[0][3]", "prev = rows[0][1]", "свеча: открытие — закрытие прошлой"),
    ("    return max(1, -(-count // n))", "    return max(1, count // n)", "свечей не больше n"),
    ('"low": min(px, (last or ref[-1])[2]), "high": max(px, (last or ref[-1])[1])}', '"low": px, "high": px}', "ход идущей свечи — сгорел"),
    # Живая цена.
    ("abs(p / base - 1) <= gap:", "abs(p / base - 1) <= 1:", "чужая цена не берётся"),
    ("        gap = PX_MOVE if hit[1].get(\"live\") is True else PX_GAP\n", "        gap = PX_MOVE\n", "чужой источник — и между сборками в PX_GAP"),
    ("        gap = PX_MOVE if hit[1].get(\"live\") is True else PX_GAP\n", "        gap = PX_GAP\n", "та же монета — до PX_MOVE"),
    ("        if abs(px / base - 1) > PX_GAP:\n            _start(key)\n", "", "большой ход — пересборка сразу"),
    ("    st[\"live\"] = quote is not None", "    st[\"live\"] = True", "«та же монета» — только если цена совпала"),
    ("    st[\"live\"] = d.get(\"live\") is True", "    st[\"live\"] = bool(d.get(\"live\"))", "копия: «та же монета» — только True"),
    ("and not isinstance(p, bool) and abs(", "and abs(", "True — не цена"),
    ("    except Exception:  # noqa: BLE001 — сбой источника цены не ломает карту: цена сборки\n        p = None", "    except ZeroDivisionError:  # noqa: BLE001 — сбой источника цены не ломает карту: цена сборки\n        p = None", "сбой цены не ломает карту"),
    ("    if res[\"px\"] == px:\n        return res\n", "", "та же цена — тот же ответ"),
    ("    st[\"low\"], st[\"high\"] = min(st[\"low\"], px), max(st[\"high\"], px)\n", "", "сгоревшее не воскресает"),
    ("    px = ref[-1][3] if quote is None else quote\n", "    px = ref[-1][3]\n", "цена сборки — текущая"),
    ("    px = _live(key[0], base, gap)", "    px = base", "между сборками — текущая цена"),
    # Хвост.
    ("    if gather is not None and rng in TAIL:", "    if False:", "длинные окна — с хвостом"),
    ("                tail.update(t_got)\n", "", "хвост — в модель"),
    ("            except Exception:  # noqa: BLE001 — хвоста нет — окно без него, как раньше", "            except ZeroDivisionError:  # noqa: BLE001 — хвоста нет — окно без него, как раньше", "сбой хвоста не ломает карту"),
    # Кэш и сборка.
    ('SYM = re.compile(r"[A-Z0-9]{1,12}")', 'SYM = re.compile(r".{1,12}")', "монета — только буквы и цифры"),
    ("    if not s or rng not in RANGES:\n", "    if not s:\n", "окно — только известное"),
    ("if hit is None or early or time.monotonic() - hit[0] >= TTL[key[1]] else None", "if True else None", "свежая сборка — без пересборки"),
    ("if hit is None or early or time.monotonic() - hit[0] >= TTL[key[1]] else None", "if hit is None or early or time.monotonic() - hit[0] >= 120 else None", "срок — своего окна"),
    ("        if not hit or time.monotonic() - hit[0] >= STALE:\n", "        if not hit:\n", "слишком старая — не отдаётся"),
    ("    if job is not None:\n        job.join(wait)", "    if job is not None:\n        job.join(0)", "холодный старт ждёт сборку"),
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
    # Предыстория.
    ("    return [r for r in pre if r[0] + PRE_SEC <= cut] + rows", "    return [r for r in pre if r[0] < cut] + rows", "предыстория — только дни, кончившиеся до окна"),
    ("    got = {ex: prepend(pre.get(ex), rows) for ex, rows in got.items()}", "    got = dict(got)", "окно начинается с предыстории"),
    ("{ex: c for ex, r in got.items() if len(c := clean_rows(r)) >= 8}", "{ex: r for ex, r in got.items()}", "предыстория — чистые ряды"),
    ("        if rows:\n            _st.pre.pop(sym, None)", "        if True:\n            _st.pre.pop(sym, None)", "пустая предыстория — не замена"),
    ("(tried is None or t - tried >= PRE_RETRY)", "True", "предыстория: снова спросить через PRE_RETRY"),
    ("            _st.pre_retry[sym] = t\n", "            _st.pre_retry[sym] = t\n            _st.pre.pop(sym, None)\n", "сбой не стирает прежнюю предысторию"),
    ("            _st.pre_retry[sym] = t\n", "            _st.pre_retry[sym] = t\n            if sym in _st.pre:\n                _st.pre[sym] = (t, _st.pre[sym][1])\n", "сбой не молодит прежнюю предысторию"),
    ("            _st.pre_retry.pop(sym, None)\n", "", "пришла — пауза снята"),
    ("        while len(_st.pre) > PRE_MAX:\n", "        while False:\n", "кэш предыстории ограничен"),
    ("min(_st.pre, key=lambda k: _st.pre[k][0])", "max(_st.pre, key=lambda k: _st.pre[k][0])", "вытесняется самая старая предыстория"),
    ("        _st.pre_jobs.pop(sym, None)\n", "", "сборка предыстории снимается из списка"),
    ("        if hit and t - hit[0] < PRE_TTL:\n            return hit[1]\n", "", "свежая предыстория — из кэша"),
    ("        job = _st.pre_jobs.get(sym)\n        tried", "        job = None\n        tried", "одна сборка предыстории на монету"),
    ("    if hit and t - hit[0] < PRE_STALE:\n        return hit[1]\n", "    if hit:\n        return hit[1]\n", "протухшая предыстория не берётся"),
    ("    if hit and t - hit[0] < PRE_STALE:\n        return hit[1]\n", "", "постарше — сразу, без ожидания"),
    ("        return hit[1] if hit and time.monotonic() - hit[0] < PRE_STALE else {}", "        return hit[1] if hit else {}", "не дождались — пусто, а не протухшая"),
    ('PRE = ("1d", 1000)', 'PRE = ("1d", 365)', "предыстория — три года"),
    # Окно — только позиции, открытые за него.
    ("    if since is None:\n        return book.agg[0], book.agg[1], book.total()", "    if True:\n        return book.agg[0], book.agg[1], book.total()", "окно — только открытые за него"),
    ("        if rows[i - 1][0] < since:", "        if rows[i - 1][0] <= since:", "первая свеча окна — в окне"),
    ("                (out_s if side else out_l)[g][nb] += q * c[1]", "                (out_l if side else out_s)[g][nb] += q * c[1]", "окно: лонги и шорты — по своим сторонам"),
    ("levs_upto(max_lev(ex, sym, caps)), since=ref[0][0],", "levs_upto(max_lev(ex, sym, caps)), since=None,", "карта окна — с отсечкой по его началу"),
    # Копия на диске.
    ("        out[side] = [[[b, float(v)] for b, v in enumerate(g) if v > 0] for g in st[side]]", "        out[side] = [[[b, float(v)] for b, v in enumerate(g)] for g in st[side]]", "в копии — только непустые корзины"),
    ("        out[side] = [[[b, float(v)] for b, v in enumerate(g) if v > 0] for g in st[side]]", "        out[side] = [[[b, round(v, 9)] for b, v in enumerate(g) if v > 0] for g in st[side]]", "в копии — значащие цифры, а не знаки после запятой"),
    ("        out[side] = [[[b, float(v)] for b, v in enumerate(g) if v > 0] for g in st[side]]", "        out[side] = [[[b, float(f\"{v:.9g}\")] for b, v in enumerate(g) if v > 0] for g in st[side]]", "в копии — число без округления"),
    ("    extra = sum(w for lev, w, _ in LEVS if lev > top)", "    extra = 0.0", "плечи выше предела — на предел"),
    ("    if caps and ex in caps:\n        return min(cap, caps[ex])", "    if caps and ex in caps:\n        return caps[ex]", "плечо справочника — не выше предела биржи"),
    ("        cap = min(cap, known[len(known) // 2])", "        cap = min(cap, known[-1])", "без справочника — медиана других бирж"),
    ("levs_upto(max_lev(ex, sym, caps)), since=ref[0][0],", "levs_upto(max_lev(ex, sym)), since=ref[0][0],", "карта берёт плечи бирж"),
    ("                    funds, _caps(sym))", "                    funds, {})", "сборка берёт справочник плеч"),
    ("    return {ex: v for ex, v in raw.items() if isinstance(ex, str) and type(v) is int and 1 <= v <= 1000}", "    return dict(raw)", "справочник плеч — проверен"),
    ("    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v < PX_MAX * OI_MAX", "    return isinstance(v, (int, float)) and 0 < v < PX_MAX * OI_MAX", "копия: bool — не число"),
    ("    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v < PX_MAX * OI_MAX", "    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v", "копия: пределы чисел"),
    ("lo >= 0 and type(at) is int and at > 0\n", "lo >= 0 and isinstance(at, int)\n", "копия: время сборки"),
    ("        and abs(lo - px * (1 - SPAN)) <= px * 1e-9 and abs(step - px * SPAN * 2 / FINE) <= px * 1e-12\n", "", "копия: та же сетка"),
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
    # Первое открытие монеты — без ожидания предыстории, с пометкой partial.
    ("        build(*key, pre_wait=0.0)  # запрос человека", "        build(*key)  # запрос человека", "запрос человека не ждёт предысторию"),
    ("        partial = not pre and (sym in _st.pre_jobs or bool(_st.pre.get(sym, (0.0, {}))[1]))", "        partial = False", "карта без предыстории — помечена"),
    ("        early = hit is not None and hit[1].get(\"partial\") is True and s not in _st.pre_jobs and s not in _st.fund_jobs\n", "        early = False\n", "предыстория пришла — пересборка"),
    ("        early = hit is not None and hit[1].get(\"partial\") is True and s not in _st.pre_jobs and s not in _st.fund_jobs\n", "        early = hit is not None and hit[1].get(\"partial\") is True and s not in _st.fund_jobs\n", "пересборка — когда предыстория готова"),
    ("_st.hits.values() if not st.get(\"partial\")]", "_st.hits.values()]", "временная карта — не в копию"),
    # Границы свечей — к ним сервер кладёт настоящие ликвидации бирж.
    ("    return [rows[i][0] for i in range(0, len(rows), k)] + [rows[-1][0] + step]", "    return [rows[i][0] for i in range(0, len(rows), k)]", "границы: конец последней свечи"),
    ("all(edges[i] < edges[i + 1] for i in range(n))", "True", "копия: границы по возрастанию"),
    ("    if d.get(\"ohlc_t\") is not None:\n        st[\"ohlc_t\"] = list(d[\"ohlc_t\"])\n", "", "копия: границы сохраняются"),
    ("not isinstance(age, bool) and age >= 0):", "not isinstance(age, bool)):", "копия: возраст не меньше нуля"),
    ("        if total >= STALE:\n", "        if age >= STALE:\n", "копия: возраст — с записи файла"),
    ("            if key in _st.hits:\n                continue\n", "", "копия не поверх свежей сборки"),
    ("            _st.hits[key] = (time.monotonic() - total, st, res)", "            _st.hits[key] = (time.monotonic(), st, res)", "копия: возраст сохраняется"),
    # Фандинг.
    ("                nb = bucket(m + sh_l, lo, step)", "                nb = b", "фандинг: уровни платящих лонгов — вверх"),
    ("                nb = bucket(m - sh_s, lo, step)", "                nb = b", "фандинг: уровни платящих шортов — вниз"),
    ("                if m >= low_m[i] + gl[i]:", "                if False:", "фандинг: съел маржу лонга — ликвидирован"),
    ("                if m <= high_m[i] - gs[i]:", "                if False:", "фандинг: съел маржу шорта — ликвидирован"),
    ("        high_m[t] = max(high_m[t + 1], rows[t][1] + gs[t])", "        high_m[t] = max(high_m[t + 1], rows[t][1] + gs[n])", "фандинг: сгорание — по уже заплаченному"),
    ("    a, b = max(a, end - FUND_HOLD), min(b, end)", "    a, b = a, min(b, end)", "фандинг: только за FUND_HOLD"),
    (", t + FUND_PERIOD)", ", end)", "фандинг: ставка — не дольше периода"),
    ("                short_p -= r * span / FUND_PERIOD", "                short_p += r * span / FUND_PERIOD", "фандинг: шорты платят при минусе"),
    ("        gl.append(gl[-1] + r[3] * pl)", "        gl.append(gl[-1] + pl)", "фандинг: платят с цены монеты"),
    ("        if r is not None and -FUND_MAX <= r <= FUND_MAX:", "        if r is not None:", "фандинг: ставка правдоподобна"),
    ("    funds = _fund(sym, FUND_WAIT)\n", "    funds: Funds = {}\n", "фандинг: сборка берёт ставки"),
    ("        if hit and t - hit[0] < FUND_TTL:", "        if False:", "фандинг: свежие — из кэша"),
    ("(tried is None or t - tried >= FUND_RETRY)", "True", "фандинг: сбой — пауза до повтора"),
    ("        while len(_st.fund) > FUND_KEEP:", "        while False:", "фандинг: кэш ограничен"),
    ('        pts = (fund or {}).get(ex) or (fund or {}).get("*")', '        pts = (fund or {}).get("*")', "фандинг: у биржи — своя ставка"),
    ('        pts = (fund or {}).get(ex) or (fund or {}).get("*")', '        pts = (fund or {}).get(ex)', "фандинг: нет своей — средняя"),
    ("        raw = {\"*\": raw}", "        raw = {}", "фандинг: просто ряд — средняя"),
    ("if isinstance(ex, str) and 0 < len(ex) <= 40 and (pts := clean_fund(v))}", "if (pts := clean_fund(v))}", "фандинг: имя биржи проверено"),
    ("        return funds, not funds and sym in _st.fund_jobs", "        return funds, False", "фандинг в пути — карта временная"),
    (" and s not in _st.pre_jobs and s not in _st.fund_jobs", " and s not in _st.pre_jobs", "пересборка — когда пришли и ставки"),
]

# Источники карты в сервере (whale_api.py): ворота перед моделью и базой,
# безопасный разбор ответов бирж, лента настоящих ликвидаций.
API = [
    ("            rows = _liq_valid(fn(sym, period, n))", "            rows = fn(sym, period, n)", "ворота: ряды источника"),
    ("and all(_liq_fin(x) for x in r[1:]) and min(r[1:4]) > 0 and r[4] >= 0 and 0 <= r[5] <= 1]",
     "and min(r[1:4]) > 0 and r[4] >= 0 and 0 <= r[5] <= 1]", "ворота: числа конечные"),
    ("and isinstance(r[0], int) and not isinstance(r[0], bool) and r[0] >= 0", "and True", "ворота: время целое"),
    ("_liq_valid(_liq_hl_candles(sym, period, n)) or None", "_liq_hl_candles(sym, period, n)", "ворота: свечи Hyperliquid"),
    ("if LIQ_OI_MIN <= oi < 1e13 and 0 < px < 1e9:", "if oi >= LIQ_OI_MIN and px > 0:", "снимок: только правдоподобные числа"),
    ("isinstance(k, str) and wt_liqmap.SYM.fullmatch(k)", "isinstance(k, str)", "снимок: только наши тикеры"),
    ("and isinstance(v, tuple) and 2 <= len(v) <= 3", "", "снимок: значение — (интерес, цена)"),
    ("        if got and got[2] > 0 and _snap_mkt(got[1]):", "        if got and got[2] > 0:", "имя рынка в адресе — проверено"),
    ('if m.get("marketType") == "PERPETUAL" and _snap_mkt(m.get("symbol"))]', 'if m.get("marketType") == "PERPETUAL"]', "Bullish: имя рынка в адресе"),
    ("0 < px < 1e12 and 0 < t_ms < 1e14)", "0 < px < 1e12)", "лента: время ликвидации"),
    ("if not sym or not (0 < usd < 1e13", "if not sym or not (0 <= usd", "лента: сумма правдоподобна"),
    ("[(int(b), float(v) / 100) for b, v in", "[(int(b), float(v)) for b, v in", "фандинг сервера: проценты — в доли"),
    ("        out[LIQ_FUND_NAMES.get(name, name)] = rows", "        out[name] = rows", "фандинг сервера: имя биржи — как на карте"),
    ("    got = _fund_hist(sym, wt_liqmap.FUND_HOLD // 86400 + 1, series=True)", "    got = _fund_hist(sym, wt_liqmap.FUND_HOLD // 86400 + 1)", "фандинг сервера: ряды бирж"),
    ("        own[name] = [(int(t // 1000), r * k) for t, r in rows]", "        own[name] = [(int(t // 1000), r) for t, r in rows]", "фандинг сервера: ставка — за 8 часов"),
    ("    if series:\n        out[\"series\"] = own", "    out[\"series\"] = own", "ряды бирж — не в ответ экрана"),
    ("    return int(f) if 1 <= f <= 1000 else 0", "    return int(f)", "плечо справочника — 1–1000×"),
    ("            book[sym] = max(book.get(sym, 0), v)", "            book[sym] = v", "плечо монеты — наибольшее из рынков"),
    ("    if out:\n        with _liq_lock:\n            _liq_levs_cache[\"all\"] = (time.monotonic(), out)", "    with _liq_lock:\n        _liq_levs_cache[\"all\"] = (time.monotonic(), out)", "пустой справочник не кэшируется"),
    ("        if (not hit or time.monotonic() - hit[0] >= LIQ_LEVS_TTL) and \"levs\" not in _liq_busy:", "        if not hit and \"levs\" not in _liq_busy:", "справочник плеч обновляется"),
    ('d.get("quoteCoin") == "USDT" and d.get("contractType") == "LinearPerpetual":', 'd.get("quoteCoin") == "USDT":', "Bybit: только бессрочные"),
    ('_snap_add(out, sym, _fnum(r.get("open_interest")) * px, px)', '_snap_add(out, sym, _fnum(r.get("open_interest")), px)', "OrangeX: интерес в долларах"),
    ('px = _fnum(r.get("mark_price")) or _fnum(r.get("last_price"))', 'px = _fnum(r.get("mark_price"))', "OrangeX: цена без mark — последняя сделка"),
    ('_quote_cut(str(r.get("instrument_name") or ""), ("-USDT-PERPETUAL",))', 'str(r.get("instrument_name") or "").split("-")[0]', "OrangeX: только USDT"),
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
a2 = run(f"{ROOT}/wt_liqmap.py", [sys.executable, "-m", "unittest", "tests.test_liqmap", "tests.test_liqmap_fuzz", "tests.test_liqmap_disk", "tests.test_liqmap_pre", "tests.test_liqmap_fund", "tests.test_liqmap_levs"], PY)
a3 = run(f"{ROOT}/whale_api.py", [sys.executable, "-m", "unittest", "tests.test_liqmap_security", "tests.test_liqmap_policy", "tests.test_liqmap_pre", "tests.test_liqmap_fund", "tests.test_liqmap_levs"], API)
alive = a1 + a2 + a3
total = len(TS) + len(PY) + len(API) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
