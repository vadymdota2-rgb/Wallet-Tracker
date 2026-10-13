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
EQUIV = {"граница награды"}  # 50 BTC >> 63 и >> 64 — оба ноль
TS = [
    ("v > 0;", "v >= 0;", "int: ноль как высота"),
    ("r.height < r.next", "r.height <= r.next", "высота равна next"),
    ("Math.abs(d) > 60 ? d : 0", "d", "поправка часов на любую мелочь"),
    ("epoch >= 64 ? 0", "epoch >= 63 ? 0", "граница награды"),
    ("Math.floor(eta - now)", "Math.ceil(eta - now)", "округление остатка"),
    ("Math.min(h.next - 1,", "Math.min(h.next,", "высота до халвинга"),
    ("Math.min(99.9,", "Math.min(100,", "100 % до халвинга"),
    ("since < JUST_HAPPENED", "since < JUST_HAPPENED * 3", "окно «состоялся»"),
    ("left % 60]", "left % 61]", "секунды"),
    ("(r.at - GENESIS_TS) / 300", "(r.at - GENESIS_TS) / 30", "правдоподобие высоты"),
    ("Math.max(0, Math.floor((now - tip) / h.avg))", "Math.floor((now - tip) / h.avg)", "высота назад"),
    ("rewardNext: subsidySats(epoch + 1)", "rewardNext: subsidySats(epoch)", "следующая награда"),
    ("since >= 0 &&", "since >= -1e12 &&", "«состоялся» из будущего"),
    ("Math.abs(v) < 366 * 86400", "Math.abs(v) < 1e12", "предел поправки часов"),
    ('v === "epoch" || v === "period" || v === "nominal"', "true", "src любой"),
]
PY = [
    ("if hit and not failed and not _busy.is_set():", "if hit and not _busy.is_set():", "пауза после сбоя"),
    ("tip_ts <= t_now + 7200", "tip_ts <= t_now + 10**9", "время блока из будущего"),
    ("height - start >= RETARGET", "height - start >= 0", "среднее в начале эпохи"),
    ("return MIN_HEIGHT < h <= (_now() - GENESIS_TS) // FASTEST", "return MIN_HEIGHT < h", "правдоподобие высоты"),
    ('"eta": int(tip_ts + (nxt - height) * avg)', '"eta": int(t_now + (nxt - height) * avg)', "eta от последнего блока"),
    ("if left <= 0.2:", "if left <= -1:", "бюджет исчерпан"),
    ("timeout=min(HOP, left)", "timeout=HOP", "таймаут по остатку бюджета"),
    ('if not re.fullmatch(r"[0-9a-f]{64}", bh):', "if False:", "проверка хеша"),
    ("        _dl.at = 0.0\n", "        pass\n", "срок сборки сбрасывается"),
    ('        res["prev"] = start_ts', "        pass", "prev в ответе"),
    ("    with _cold:\n", "    if True:\n", "один сборщик на холодном старте"),
    ("            _st.err_at = time.monotonic()", "            pass", "запоминание сбоя"),
    ("nxt = start + EVERY", "nxt = start + EVERY + 1", "номер блока халвинга"),
    ('"now": _now()', '"now": 0', "now в ответе"),
    ("        _busy.clear()", "        pass", "флаг фона снимается"),
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
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=120, check=False)
            killed = r.returncode != 0
            tag = "убита   " if killed else ("экв.    " if name in EQUIV else "ВЫЖИЛА  ")
            print(tag + name, flush=True)
            if not killed and name not in EQUIV:
                alive.append(name)
    finally:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
    return alive

a1 = run(f"{ROOT}/src/lib/halving.ts", ["node", "--test", "tests/halving.test.ts"], TS)
a2 = run(f"{ROOT}/wt_halving.py", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], PY)
total = len(TS) + len(PY) - len(EQUIV)
print(f"ИТОГ: убито {total - len(a1) - len(a2)} из {total}; выжили: {a1 + a2}")
sys.exit(1 if a1 + a2 else 0)
