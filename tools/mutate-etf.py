"""Мутационная проверка «Институциональных потоков»: python3 tools/mutate-etf.py

Как у халвинга: портим код по одному месту (граница, знак, константа,
защита) и гоняем тесты. Убитая мутация — тесты заметили порчу; выжившая —
дыра в тестах. Файл после каждой мутации возвращается как был.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные (не меняют ничего наблюдаемого) — в счёт не идут: «монеты
# дня без цены» — цена дня либо 0, либо от PX_MIN, отрицательной не бывает.
EQUIV = {"монеты дня без цены"}
TS = [
    # Проверка ответа.
    ("ts % DAY !== 0 || ts <= prev", "ts <= prev", "день — с начала суток"),
    ("ts % DAY !== 0 || ts <= prev", "ts % DAY !== 0 || ts < prev", "дни строго по возрастанию"),
    ("per.length !== nf", "per.length > nf", "столбцы фондов совпадают"),
    ("if (!ok || seen.has(ok.t)) return null;", "if (!ok) return null;", "тикеры не повторяются"),
    ("!within(usd, -USD_K_MAX, USD_K_MAX)", "!isNum(usd)", "предел потока дня"),
    ("if (fee !== null && !within(fee, 0, 10)) return null;", "", "комиссия в пределах"),
    ("if (share !== null && !within(share, 0, 100)) return null;", "", "доля в пределах"),
    ('(through !== "" && !DATE.test(through))', "false", "«данные по» — дата"),
    ("!within(raw[\"at\"], ETF_LAUNCH, now + 7 * DAY)", "!isNum(raw[\"at\"])", "время ответа правдоподобно"),
    ("now + 2 * DAY) || ts % DAY", "now + 365 * DAY) || ts % DAY", "день не из будущего"),
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
    ("len(k) > 4 and PX_MIN <= _num(k[4]) <= PX_MAX", "len(k) > 4", "цена Binance правдоподобна"),
    # Запас и фонды.
    ("if 0 < float(cnt) <= HOLD_MAX:", "if True:", "запас из отчёта правдоподобен"),
    ("if ts > asof and t in by", "if ts >= asof and t in by", "потоки после отчёта"),
    ("(1 - _num(fee) * max(0, _now() - asof) / (365 * 86400))", "1", "комиссия монетами"),
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
    ("for _ in range(6):", "for _ in range(60):", "страницы свечей ограничены"),
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
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300, check=False)
            killed = r.returncode != 0
            print(("убита   " if killed else "экв.    " if name in EQUIV else "ВЫЖИЛА  ") + name, flush=True)
            if not killed and name not in EQUIV:
                alive.append(name)
    finally:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
    return alive


a1 = run(f"{ROOT}/src/lib/etf.ts", ["node", "--test", "tests/etf.test.ts", "tests/etf.props.test.ts"], TS)
a2 = run(f"{ROOT}/wt_etf.py", [sys.executable, "-m", "unittest", "tests.test_etf_api", "tests.test_etf_fuzz",
                               "tests.test_etf_security", "tests.test_etf_policy", "tests.test_disk_cache"], PY)
alive = a1 + a2
total = len(TS) + len(PY) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
