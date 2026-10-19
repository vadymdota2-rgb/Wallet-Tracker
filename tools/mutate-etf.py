"""Мутационная проверка «Институциональных потоков»: python3 tools/mutate-etf.py

Как у халвинга: портим код по одному месту (граница, знак, константа,
защита) и гоняем тесты. Убитая мутация — тесты заметили порчу; выжившая —
дыра в тестах. Файл после каждой мутации возвращается как был.
"""
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные (не меняют ничего наблюдаемого) — в счёт не идут: «монеты
# дня без цены» — цена дня либо 0, либо от PX_MIN, отрицательной не бывает.
EQUIV = {"монеты дня без цены"}
TS = [
    # Проверка ответа.
    ("7 * DAY, now + 2 * DAY) || ts % DAY !== 0 || ts <= prev)", "7 * DAY, now + 2 * DAY) || ts <= prev)", "день — с начала суток"),
    ("7 * DAY, now + 2 * DAY) || ts % DAY !== 0 || ts <= prev)", "7 * DAY, now + 2 * DAY) || ts % DAY !== 0 || ts < prev)", "дни строго по возрастанию"),
    ("per.length !== nf", "per.length > nf", "столбцы фондов совпадают"),
    ("if (!ok || seen.has(ok.t)) return null;", "if (!ok) return null;", "тикеры не повторяются"),
    ("!within(usd, -USD_K_MAX, USD_K_MAX)", "!isNum(usd)", "предел потока дня"),
    ("if (fee !== null && !within(fee, 0, 10)) return null;", "", "комиссия в пределах"),
    ("if (share !== null && !within(share, 0, 100)) return null;", "", "доля в пределах"),
    ('(through !== "" && !DATE.test(through))', "false", "«данные по» — дата"),
    ("!within(raw[\"at\"], ETF_LAUNCH, now + 7 * DAY)", "!isNum(raw[\"at\"])", "время ответа правдоподобно"),
    ("7 * DAY, now + 2 * DAY) || ts % DAY", "7 * DAY, now + 365 * DAY) || ts % DAY", "день не из будущего"),
    ("if (!btc || !btc.days.length) return null;", "if (!btc) return null;", "без дней — не ответ"),
    ("TICKER.test(t)", "t.length > 0", "тикер — заглавные и цифры"),
    ("raw.holders.filter(holderRow)".replace("raw.holders", 'raw["holders"]'), 'raw["holders"]', "держатели проверяются"),
    # Расчёты.
    ("Math.floor((ts / DAY + 3) / 7)", "Math.floor((ts / DAY + 4) / 7)", "неделя с понедельника"),
    ("if (d[3]) last.px = d[3];", "last.px = d[3];", "цена недели без пустых дней"),
    ("days.filter((d) => d[0] > end - n * DAY)", "days.filter((d) => d[0] >= end - n * DAY)", "окно n суток"),
    ("range === \"30\" || range === \"90\" ? daily", "range === \"30\" ? daily", "90 дней — по дням"),
    ("days.filter((d) => d[0] < first)", "days.filter((d) => d[0] <= first)", "накопленное до окна"),
    ("sign !== 0 && Math.sign(days[i]![1]) === sign", "Math.sign(days[i]![1]) === sign", "серия с нулём"),
    ("if (m >= open) continue;", "", "идущий месяц — не рекорд"),
    ("Math.max(now, end) * 1000", "end * 1000", "идущий месяц — по часам"),
    ("for (let i = 0; i < 30; i++)", "for (let i = 0; i < 31; i++)", "добыча за 30 суток"),
    ("if (ts < 1_713_571_200) return 900;", "if (ts <= 1_713_571_200) return 900;", "граница халвинга 2024"),
    ("held: c.funds.reduce((s, f) => s + (f.hold ?? 0), 0)", "held: 0", "запас фондов"),
    ('const n = period === "d" ? 1 : period === "w" ? 7 : 30;', 'const n = period === "d" ? 1 : period === "w" ? 6 : 30;', "неделя — 7 суток"),
    ("rows.filter((r) => Math.abs(r.v) >= 1)", "rows.filter((r) => Math.abs(r.v) > 1)", "фонд с движением"),
    ("Math.abs(y.v) - Math.abs(x.v)).slice(0, n)", "y.v - x.v).slice(0, n)", "крупнейшие фонды по модулю"),
    # Активы фондов по дням.
    ("ts % DAY !== 0 || ts <= prev || !within(v, TNA_MIN, TNA_MAX)", "ts % DAY !== 0 || !within(v, TNA_MIN, TNA_MAX)", "активы: дни по возрастанию"),
    ("|| !within(v, TNA_MIN, TNA_MAX)) return null;", "|| !isNum(v)) return null;", "активы: правдоподобная сумма"),
    ("t[0] >= lastDay - TNA_FRESH", "t[0] >= 0", "активы: только свежая сводка"),
    ("return p > 0 ? [[ts, usd / p]] : [];", "return [[ts, usd / (p || 1)]];", "запас по дням без цены дня"),
    # Карточка фонда и свежесть набора.
    ("if (v !== null && v !== undefined) all.push([d[0], v]);", "all.push([d[0], v ?? 0]);", "фонд: дни без торгов — не его"),
    ("const days = all.slice(-n);", "const days = all.slice(0, n);", "фонд: последние дни"),
    ("if (x[1] > 0 && (!best || x[1] > best[1])) best = x;", "if (!best || x[1] > best[1]) best = x;", "фонд: рекорд притока — приток"),
    ("if (x[1] < 0 && (!worst || x[1] < worst[1])) worst = x;", "if (!worst || x[1] < worst[1]) worst = x;", "фонд: рекорд оттока — отток"),
    ("return Math.max(0, Math.floor((now - last) / DAY));", "return Math.floor((now - last) / DAY);", "свежесть: часы отстают"),
    ("Math.floor((now - last) / DAY))", "Math.ceil((now - last) / DAY))", "свежесть: полные сутки"),
    ("export const STALE_DAYS = 5;", "export const STALE_DAYS = 2;", "свежесть: праздники — не сбой"),
]
PY = [
    # Разбор набора TFTC.
    ("if not ETF_LAUNCH <= ts <= last", "if not ts <= last", "день до запуска фондов"),
    ("<= ts <= last or", "<= ts or", "день из будущего"),
    ("(not by and total == 0)", "False", "праздник биржи — не торговый день"),
    ("abs(total) > DAY_MAX", "abs(total) > 1e300", "предел потока дня"),
    ("any(abs(v) > FUND_MAX for v in by.values())", "False", "предел потока фонда"),
    ("total = sum(by.values()) if by else", "total = _num(r.get(\"netFlowUsd\")) if by else", "итог дня — сумма фондов"),
    ("and TICKER.fullmatch(k)}", "}", "тикер — заглавные и цифры"),
    ('DATE.fullmatch(r["date"])', 'r["date"]', "дата строки — ГГГГ-ММ-ДД"),
    ('DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")', 'DATE = re.compile(r"\\d{4}-\\d{2}-\\d{2}")', "цифры даты — ASCII"),
    ("if PX_MIN <= _num(r.get(\"btcCloseUsd\")) <= PX_MAX:", "if _num(r.get(\"btcCloseUsd\")):", "цена из набора правдоподобна"),
    # Запас и фонды.
    ("if 0 < btc <= HOLD_MAX:", "if btc > 0:", "запас из отчёта правдоподобен"),
    ("                out[t] = (btc, e)\n                break", "                out[t] = (btc, e)\n            break", "негодный отчёт — прошлый квартал"),
    ("[0.0])[0]), k)", "[0.0])[0]), 0)", "фонды при равенстве — по тикеру"),
    ("fee = fee if 0 < fee < wt_treasury.FEE_MAX else 0.0", "", "комиссия фонда в пределах"),
    ("isinstance(t, str) and TICKER.fullmatch(t)", "isinstance(t, str)", "тикер фонда из SEC"),
    ("TICKER.fullmatch(r[3]) is not None", "True", "держатели: тикер компании"),
    ("1 <= _num(r[4]) <= HOLD_MAX", "_num(r[4]) >= 1", "держатели: запас компании правдоподобен"),
    ("(-_num(r[4]), r[3])", "(-_num(r[4]), 0)", "держатели при равенстве — по тикеру"),
    ("_part(\"sec\", sec_f, SEC_WAIT)", "_part(\"sec\", sec_f, 60)", "SEC ждём не дольше SEC_WAIT"),
    ("or wt_treasury.funds_cached()", "or {}", "SEC не ответил — прошлые отчёты"),
    ("pool.shutdown(wait=False, cancel_futures=True)", "pool.shutdown(wait=True)", "зависшую часть не ждём"),
    ("if t not in known and t not in _st.told)", "if t not in known)", "о новом фонде — один раз"),
    ("if t not in known and t not in _st.told)", "if t not in _st.told)", "о знакомом фонде — молчим"),
    ("if hit and not _busy.is_set() and not _resting():", "if hit and not _busy.is_set():", "после сбоя фон ждёт паузу"),
    ("else _no_data() if resting else build()", "else build()", "очередь холодного старта не пересобирает"),
    ("        _st.fail = None\n", "", "удачная сборка снимает паузу"),
    ("_st.fail is not None and time.monotonic() - _st.fail < FAIL_WAIT", "_st.fail is not None", "пауза кончается"),
    ('    return {"ok": False, "error": "no_data"}\n', '    return _NO\n_NO = {"ok": False, "error": "no_data"}\n', "«нет данных» каждый раз новый"),
    ("if ts > asof and t in by", "if ts >= asof and t in by", "потоки после отчёта"),
    ("(1 - fee * max(0, _now() - asof) / (365 * 86400))", "1", "комиссия монетами"),
    ('"n": str(info.get("n") or "")[:60]', '"n": str(info.get("n") or "")', "длина имени фонда"),
    ("round(tot / p, 2) if p > 0 else 0.0", "round(tot / p, 2) if p else 0.0", "монеты дня без цены"),
    ("aum / price / supply_at(_now()) * 100", "aum / price / 21e6 * 100", "доля — от добытого"),
    # Защита.
    ('u.scheme == "https" and u.hostname in HOSTS and', "True or", "только https и известные адреса"),
    (" and not u.username and not u.password", "", "адрес с логином"),
    ("ProxyHandler({}), _NoRedirect, ", "ProxyHandler({}), ", "без перенаправлений"),
    ("parse_float=_finite, ", "", "числа без бесконечностей"),
    ("return body if len(body) <= BODY_MAX else None", "return body", "предел размера ответа"),
    ('c if c.isprintable() else "?"', "c", "журнал без управляющих символов"),
    ("_now() - _num(got.get(\"at\")) > FILE_MAX_AGE", "False", "старая копия с диска"),
    (" or not DATE.fullmatch(stamp[:10]):", ":", "дата CFTC — ASCII"),
    # CME, активы фондов.
    ("if not CME_FROM <= ts <= _now() or", "if not ts <= _now() or", "CME: дата не до фьючерсов"),
    ("CME_FROM <= ts <= _now() or", "CME_FROM <= ts or", "CME: дата не из будущего"),
    ("any(not 0 <= v <= CME_MAX for v in vals)", "False", "CME: позиции правдоподобны"),
    ('if TNA_MIN <= _num(r.get("totalNetAssetsUsd")) <= TNA_MAX:', 'if _num(r.get("totalNetAssetsUsd")):', "активы: правдоподобная сумма"),
    ("if tna and max(tna) >= max(days) - 7 * 86400 and", "if tna and", "активы: только свежая сводка"),
    ("if own > 0 and abs(own / held - 1) > SPLIT_MAX:", "if False:", "сверка своей оценки со сводкой"),
]
TR = [
    ("return QUARTER.fullmatch(s) is not None", 'return len(s) == 10 and s[5:] in ("03-31", "06-30", "09-30", "12-31")', "SEC: дата квартала — ASCII"),
    ("if STAMP.fullmatch(str(k)) and _point(v)}", "if STAMP.fullmatch(str(k)) and isinstance(v, list)}", "SEC: копия на диске проверяется"),
    ("if STAMP.fullmatch(str(k)) and", "if str(k).isdigit() and", "SEC: ключ квартала — ASCII-число"),
    ("if t in _ETF and isinstance(f, dict)", "if isinstance(f, dict)", "SEC: фонды копии — только из ETFS"),
    ("if not isinstance(s, str) or not DATE.fullmatch(s):", "if not isinstance(s, str) or len(s) != 10:", "SEC: дата отчёта — ASCII"),
    ("isinstance(r[3], str) and r[3] in _CO", "isinstance(r[3], str)", "SEC: компании копии — только из COMPANIES"),
    ("1 <= r[4] < COUNT_MAX", "r[4] >= 0", "SEC: запас компании из копии правдоподобен"),
    ("type(r[5]) is int and r[5] > 0", "True", "SEC: дата отчёта компании в копии"),
    ("            if ticker in old:\n                out.append(old[ticker])\n", "", "SEC: компания без ответа — прошлый отчёт"),
    ("    if not answered:\n        # SEC не ответил", "    if not rows:\n        # SEC не ответил", "SEC: молчание по компаниям — не свежее"),
    ("    if not answered:\n        # Ни один фонд", "    if not out:\n        # Ни один фонд", "SEC: молчание по фондам — не свежее"),
    ("if not _ua() or not _fund_busy.acquire(blocking=False):", "if not _ua():", "SEC: фонды не спрашиваем вдвоём"),
    ("if not _ua() or not _co_busy.acquire(blocking=False):", "if not _ua():", "SEC: компании не спрашиваем вдвоём"),
    ('"fee": float(fee) if _num_ok(fee) and 0 < fee < FEE_MAX else None}', '"fee": fee}', "SEC: комиссия из копии"),
    ('if u.scheme != "https" or u.hostname != HOST or u.username or u.password or not ua:', "if not ua:", "SEC: только https к data.sec.gov"),
    ('return ua if ua.isprintable() and "@" in ua and len(ua) <= 200 else ""', "return ua", "SEC: подпись с почтой и без переводов строк"),
]


# Алерт о крупном дне (whale_api: etfd_*).
AL = [
    ("if abs(v) < ETFD_MIN or now() - ts > ETFD_FRESH:", "if abs(v) < ETFD_MIN:", "алерт: только свежий день"),
    ("if abs(v) < ETFD_MIN or now() - ts > ETFD_FRESH:", "if v < ETFD_MIN or now() - ts > ETFD_FRESH:", "алерт: отток тоже крупный день"),
    (" and (x > 0) == (v > 0)]", "]", "алерт: фонды в ту же сторону"),
    ("    per.sort(key=lambda p: -abs(p[1]))\n", "", "алерт: самые крупные фонды первыми"),
    ("return ts, v, per[:3]", "return ts, v, per", "алерт: не больше трёх фондов"),
    ("if not seen or seen[0] != k:", "if not seen:", "алерт: дописанный день — ждать заново"),
    ("        if now() - seen[1] < ETFD_STABLE:\n            return 0\n", "", "алерт: только устоявшийся день"),
    ("        if cur.rowcount == 0:\n            return 0\n", "", "алерт: один день — одна рассылка"),
    ("            if not chat_premium(chat):\n                continue\n", "", "алерт: только с Премиумом"),
    ('lines.append(f"{dgi.tr(lang, \'dg_etf_by\')} {dgi.TFTC_BY_POST}")', "pass", "алерт: источник и лицензия TFTC"),
    ('con.execute("UPDATE etf_day_subs SET fails=0 WHERE chat_id=?", (chat,))', "pass", "алерт: доставка обнуляет сбои"),
    ('con.execute("DELETE FROM etf_day_subs WHERE chat_id=? AND fails>=?", (chat, ETFD_FAILS))', "pass", "алерт: недоставка отписывает"),
]


def run(path, cmd, muts):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    # Без порчи тесты обязаны проходить: иначе любая мутация «убита» ложно.
    if subprocess.run(cmd, cwd=ROOT, capture_output=True, timeout=300, check=False).returncode != 0:
        sys.exit(f"тесты красные и без мутаций: {' '.join(cmd)}")
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
                killed = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300, check=False).returncode != 0
            except subprocess.TimeoutExpired:
                killed = True
            print(("убита   " if killed else "экв.    " if name in EQUIV else "ВЫЖИЛА  ") + name, flush=True)
            if not killed and name not in EQUIV:
                alive.append(name)
    finally:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
    return alive


def server():
    # wt_etf и wt_treasury — по очереди: тесты сервера читают оба файла.
    return (run(f"{ROOT}/wt_etf.py", [sys.executable, "-m", "unittest", "tests.test_etf_api", "tests.test_etf_fuzz",
                                      "tests.test_etf_security", "tests.test_etf_policy", "tests.test_disk_cache"], PY)
            + run(f"{ROOT}/wt_treasury.py", [sys.executable, "-m", "unittest", "tests.test_treasury",
                                             "tests.test_treasury_security", "tests.test_disk_cache"], TR)
            + run(f"{ROOT}/whale_api.py", [sys.executable, "-m", "unittest", "tests.test_etf_day_alert"], AL))


# Приложение и сервер — одновременно: тесты приложения (node) читают только
# lib/etf.ts, тесты сервера — только Python, друг другу они не мешают.
with ThreadPoolExecutor(max_workers=2) as pool:
    app = pool.submit(run, f"{ROOT}/src/lib/etf.ts", ["node", "--test", "tests/etf.test.ts", "tests/etf.props.test.ts"], TS)
    srv = pool.submit(server)
    alive = app.result() + srv.result()
total = len(TS) + len(PY) + len(TR) + len(AL) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
