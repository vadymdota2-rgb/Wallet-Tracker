#!/usr/bin/env python3
"""Обновляет UNLOCK_SUPPLY в whale_api.py: всего создано и потолок монет книги.

    python3 tools/sync-supply.py          # показать расхождения
    python3 tools/sync-supply.py --write  # переписать справочник и дату

Зачем: полный круг выпуска и полная оценка (FDV) в карточке считаются от
этих цифр, а у монет с долями без графика они меняются — сжигание,
переносы казны. Берётся CoinPaprika (один запрос за все монеты), монета
ищется по тикеру и совпадению слов в названии. Правила те же, что при
первом заполнении: у сетей с эмиссией «всего» не пишется (остаток до
потолка — будущий выпуск, а не запертое), «всего» не меньше оборота и
выдач по графику.
"""
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import whale_api as w  # noqa: E402

STOP = {"network", "protocol", "token", "finance", "the", "coin", "chain", "prev"}


def words(s: str) -> set:
    return set(re.findall(r"[a-z0-9]+", s.lower())) - STOP


def main() -> int:
    req = urllib.request.Request("https://api.coinpaprika.com/v1/tickers", headers={"User-Agent": "wallet-tracker-tools/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        pap = json.loads(r.read().decode())
    by = {}
    for c in pap:
        by.setdefault(c["symbol"].upper(), []).append(c)
    now = time.time()
    new, changed = {}, []
    for coin in w.UNLOCK_BOOK:
        s, circ = coin["s"], coin["circ"][1]
        has_emit = any((st[-2] if st[-1] == "est" else st[-1]) == "emission" for st in coin["plan"])
        sched = sum(v for e in w.unlock_events(now, [coin]) for k, v in e["who"].items() if k != "emission")
        best = max(((len(words(c["name"]) & words(coin["n"])), c) for c in by.get(s, [])), default=(0, None), key=lambda x: x[0])
        old = w.UNLOCK_SUPPLY.get(s)
        if not best[1] or best[0] == 0:
            if old:
                new[s] = old
            continue
        tot, mx = round(best[1].get("total_supply") or 0), round(best[1].get("max_supply") or 0)
        if has_emit or (tot and tot < circ * 0.98) or (tot and tot <= circ + sched * 1.02):
            tot = 0
        if mx and mx < max(circ, tot) * 0.98:
            mx = 0
        # Ручные поправки (потолок DOT, подсети Bittensor…) не затираются нулём.
        if old:
            tot = tot or old[0]
            mx = mx or old[1]
        if tot or mx:
            new[s] = (tot, mx)
            if old and (abs(tot - old[0]) > max(old[0], 1) * 0.01 or abs(mx - old[1]) > max(old[1], 1) * 0.01):
                changed.append(f"{s}: {old} -> {(tot, mx)}")
    print(f"монет в справочнике: {len(new)}; изменилось: {len(changed)}")
    for c in changed:
        print("  " + c)
    if "--write" not in sys.argv:
        return 0
    path = os.path.join(ROOT, "whale_api.py")
    src = open(path, encoding="utf-8").read()
    a = src.index("UNLOCK_SUPPLY: dict[str, tuple[int, int]] = {")
    b = src.index("\n}\n", a) + 3
    body = "UNLOCK_SUPPLY: dict[str, tuple[int, int]] = {\n" + "".join(
        f'    "{k}": ({t:_}, {m:_}),\n' for k, (t, m) in new.items()) + "}\n"
    src = src[:a] + body + src[b:]
    src = re.sub(r'UNLOCK_SUPPLY_AT = "\d{4}-\d{2}-\d{2}"', f'UNLOCK_SUPPLY_AT = "{time.strftime("%Y-%m-%d")}"', src)
    open(path, "w", encoding="utf-8").write(src)
    print("записано")
    return 0


if __name__ == "__main__":
    sys.exit(main())
