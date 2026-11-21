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
    ("&& (v[\"pf\"] === null || num(v[\"pf\"])) && STATS_OPT", "&& STATS_OPT", "PF — число или null"),
    ("    && arr(v[\"equity\"], pair)\n", "\n", "кривая капитала — пары чисел"),
    ("isObj(v) && v[\"ok\"] === true && [\"backtest\"", "isObj(v) && [\"backtest\"", "ok: true"),
    ("  if (validAutotrade(r)) return r;\n", "  if (isObj(o)) return r;\n", "ответ без проверки не проходит"),
    ("    if (validAutotrade(rest)) return rest as unknown as T;\n", "", "испорченный бэктест — без него, а не «нет связи»"),
    ("&& (v[\"open\"] === null || liveOpen(v[\"open\"]))", "", "открытая позиция — по договору"),
    ("&& arr(v[\"events\"], str)", "", "журнал — строки"),
    ("-USDT-SWAP$|", "", "короткое имя — USDT-SWAP"),
    ("|-USD[CT]?_UM_XPERP-\\d+$", "", "короткое имя — европейский бессрочный"),
]
PY = [
    ("    return x if math.isfinite(x) else None\n", "    return x\n", "сервер: NaN и бесконечность — не числа"),
    ("    return v if v in (1, -1) and not isinstance(v, bool) else None\n", "    return v if isinstance(v, int) else None\n",
     "сервер: сторона — 1 или −1"),
    ("        \"alive\": bool(beat) and now_ms - beat < 120_000,", "        \"alive\": bool(beat),", "сервер: служба молчит 2 минуты — не жива"),
    ("\"equity\": _f(st.get(\"equity\")),", "\"equity\": st.get(\"equity\"),", "сервер: капитал — число или null"),
    ("if isinstance(e, str)][-20:],", "if isinstance(e, str)],", "сервер: журнал — 20 строк"),
    ("        \"trades\": trades[-50:],", "        \"trades\": trades,", "сервер: сделки — 50 последних"),
    ("and v.get(\"permanent\") is True", "", "сервер: исключённые — только на неделю (не 15-минутные паузы)"),
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
