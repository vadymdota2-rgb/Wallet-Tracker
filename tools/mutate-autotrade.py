"""Мутационная проверка автоторговли (сторона приложения): python3 tools/mutate-autotrade.py

Портим по одному месту проверку ответа во вкладке (src/lib/autotrade.ts) и
сборку ответа на сервере (wt_autotrade.py) и гоняем их тесты. Убитая
мутация — тесты заметили порчу; выжившая — дыра в тестах. Файл после
каждой мутации возвращается как был. Торговлю (службу на сервере) проверяет
WhaleScanner/tools/mutate-autotrade.py.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EQUIV: set[str] = set()

TS = [
    ("typeof v === \"number\" && Number.isFinite(v)", "typeof v === \"number\"", "число — конечное"),
    ("const side = (v: unknown): boolean => v === 1 || v === -1;", "const side = (v: unknown): boolean => typeof v === \"number\";",
     "сторона — 1 или −1"),
    ("const stats = (v: unknown): boolean => isObj(v) && nums(v, STATS) && (v[\"pf\"] === null || num(v[\"pf\"]));",
     "const stats = (v: unknown): boolean => isObj(v) && nums(v, STATS);", "PF — число или null"),
    ("    && arr(v[\"equity\"], pair)\n", "\n", "кривая капитала — пары чисел"),
    ("  return isObj(v) && v[\"ok\"] === true\n", "  return isObj(v)\n", "ok: true"),
    ("  if (validAutotrade(r)) return r;\n", "  if (isObj(o)) return r;\n", "ответ без проверки не проходит"),
    ("    if (validAutotrade(rest)) return rest as unknown as T;\n", "", "испорченный бэктест — без него, а не «нет связи»"),
    ("&& (v[\"open\"] === null || liveOpen(v[\"open\"]))", "", "открытая позиция — по договору"),
    ("&& arr(v[\"events\"], str)", "", "журнал — строки"),
    ("-USDT-SWAP$|", "", "короткое имя — USDT-SWAP"),
    ("|-USD[CT]?_UM_XPERP-\\d+$", "", "короткое имя — европейский бессрочный"),
    ("    && opt(v[\"key_problem\"], str) && opt(v[\"skips_24h\"], (k) => isObj(k) && Object.values(k).every(num))", "",
     "запрет ключу и пропуски — по договору"),
    ("Object.entries(k).sort((a, b) => b[1] - a[1])", "Object.entries(k)", "пропуски — по убыванию"),
    ("\n    && opt(v[\"progress\"], str)", "", "ход пересчёта — строка"),
    ("    && [\"full\", \"first\", \"last\"].every((x) => stats(v[x]))", "", "итог повтора: весь период и четверти"),
    ("    && isObj(k) && Object.values(k).every(num) && num(v[\"per_day\"])", "",
     "итог повтора: пропуски и сделок в день — числа"),
    ("  && str(v[\"why\"]);\n\n/**", "  ;\n\n/**", "сделка модели — причина выхода строкой"),
    ("    && arr(v[\"active\"], (a) => trade(a) && isObj(a) && (a[\"to_tp_pct\"] === null || num(a[\"to_tp_pct\"])));",
     ";", "открытая позиция модели — по договору"),
    ("\n  && opt(v[\"exit_why\"], str) && opt(v[\"usd\"], num) && opt(v[\"usd_against\"], num) && opt(v[\"stop\"], num);", ";",
     "причина выхода и объёмы китов — по договору"),
]
PY = [
    ("            \"progress\": bs[\"progress\"] if bs[\"running\"] else \"\",", "            \"progress\": bs[\"progress\"],",
     "сервер: ход — только пока идёт пересчёт"),
    ("    return x if math.isfinite(x) else None\n", "    return x\n", "сервер: NaN и бесконечность — не числа"),
    ("    return v if v in (1, -1) and not isinstance(v, bool) else None\n", "    return v if isinstance(v, int) else None\n",
     "сервер: сторона — 1 или −1"),
    ("        \"alive\": bool(beat) and now_ms - beat < 120_000,", "        \"alive\": bool(beat),", "сервер: служба молчит 2 минуты — не жива"),
    ("\"equity\": _f(st.get(\"equity\")),", "\"equity\": st.get(\"equity\"),", "сервер: капитал — число или null"),
    ("if isinstance(e, str)][-20:],", "if isinstance(e, str)],", "сервер: журнал — 20 строк"),
    ("for t in trades[-50:]],", "for t in trades],", "сервер: сделки — 50 последних"),
    ("if k not in (\"fee\", \"funding\")}", "}", "сервер: в сделках — только то, что рисует вкладка"),
    ("not now_ms - 24 * 3_600_000 < hour + 3_600_000", "False", "сервер: пропуски — только за сутки"),
    ("            if isinstance(code, str) and x is not None and x > 0:", "            if isinstance(code, str):",
     "сервер: пропуски — только числа"),
    ("key_problem = kp[\"why\"] if isinstance(kp, dict) and isinstance(kp.get(\"why\"), str) else \"\"",
     "key_problem = \"\"", "сервер: запрет ключу — во вкладку"),
    ("\"margin_pct\", \"usd\", \"usd_against\"):", "\"margin_pct\"):", "сервер: объёмы китов за и против — во вкладку"),
    ("    if isinstance(ex, dict) and isinstance(ex.get(\"why\"), str):", "    if isinstance(ex, dict):", "сервер: причина выхода — только строка"),
    ("    return got if isinstance(got, dict) else None\n", "    return got  # type: ignore[no-any-return]\n",
     "сервер: итог — только объект"),
    ("and v.get(\"permanent\") is True", "", "сервер: исключённые — только на неделю (не 15-минутные паузы)"),
    (" and now_ms - (_f(v.get(\"at\")) or 0) < BLOCK_MS)", ")", "сервер: неделя прошла — бумага не исключена"),
    ("    return int(x) if x is not None and abs(x) < 1e15 else 0\n", "    return int(x) if x is not None else 0\n", "сервер: время — разумное число"),
    ("\"running\": got.get(\"running\") is True,", "\"running\": bool(got.get(\"running\")),", "сервер: «считается» — только true"),
    ("if isinstance(p, dict) and isinstance(p.get(\"instId\"), str)]", "if isinstance(p, dict)]", "сервер: позиция — с именем бумаги"),
]


def run(path: str, cmd: list[str], muts: list[tuple[str, str, str]]) -> list[str]:
    with open(path, encoding="utf-8") as f:
        src = f.read()
    alive: list[str] = []
    try:
        for a, b, name in muts:
            if src.count(a) != 1:
                sys.exit(f"мутация «{name}»: текст найден {src.count(a)} раз — обновите список")
            with open(path, "w", encoding="utf-8") as f:
                f.write(src.replace(a, b))
            try:
                killed = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300, check=False).returncode != 0
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


def main() -> int:
    env_py = [sys.executable, "-m", "unittest", "tests.test_autotrade", "tests.test_autotrade_contract"]
    both = ["sh", "-c", "node --test tests/autotrade.test.ts && " + " ".join(env_py)]
    # Контроль: на чистом коде тесты обязаны проходить — иначе каждая мутация
    # «убита» падением, которое было и без неё.
    if subprocess.run(both, cwd=ROOT, capture_output=True, timeout=300, check=False).returncode:
        print("тесты падают и без мутаций — проверка недействительна")
        return 2
    a1 = run(os.path.join(ROOT, "src", "lib", "autotrade.ts"), both, TS)
    a2 = run(os.path.join(ROOT, "wt_autotrade.py"), env_py, PY)
    alive = a1 + a2
    total = len(TS) + len(PY) - len(EQUIV)
    print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
    return 1 if alive else 0


if __name__ == "__main__":
    sys.exit(main())
