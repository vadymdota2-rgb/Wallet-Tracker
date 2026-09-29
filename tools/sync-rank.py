#!/usr/bin/env python3
"""Обновляет tools/unlock-rank.tsv — первые 500 монет по капитализации.

    python3 tools/sync-rank.py          # отчёт, файлы не трогает
    python3 tools/sync-rank.py --write  # переписать список (на машине разработки)

Запускать раз в месяц там, где CoinGecko открыт (на сервере). Берутся три
страницы рейтинга CoinGecko по 250 монет, из них — места 1–500: обёрнутые
и застейканные токены CoinGecko мест не ставит, их здесь нет и не нужно.
Тикер монеты, которая уже есть в списке, сохраняется (у Toncoin в книге —
GRAM), у новой берётся тикер CoinGecko.

Итог — короткий отчёт: какие монеты вошли в первые 500 без статуса (их надо
добавить в календарь разлоков или в список отсеянных с причиной) и какие
выпали, и готовые строки новых монет для списка. На сервере запускать без
--write (иначе git pull споткнётся об изменённый файл): отчёт переносится в
репозиторий вручную — строки дописываются в конец списка, выпавшие остаются
(проверке важно лишь, что у каждой строки есть статус), дата в шапке
обновляется. Если у всех монет статус есть, код возврата 0, иначе 1.
Ключ CoinGecko не обязателен; если есть демо-ключ, его можно передать через
переменную окружения COINGECKO_API_KEY.
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TSV = os.path.join(HERE, "unlock-rank.tsv")
LIMIT = 500
sys.path.insert(0, ROOT)


def fetch(page: int) -> list:
    url = ("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd"
           f"&order=market_cap_desc&per_page=250&page={page}")
    headers = {"User-Agent": "wallet-tracker-tools/1.0", "Accept": "application/json"}
    key = os.environ.get("COINGECKO_API_KEY")
    if key:
        headers["x-cg-demo-api-key"] = key
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001 — лимит бесплатного API: ждём и повторяем
            if attempt == 3:
                raise SystemExit(f"CoinGecko, страница {page}: {e}")
            time.sleep(20 * (attempt + 1))
    return []


def main() -> int:
    write = "--write" in sys.argv
    old = [ln.rstrip("\n").split("\t") for ln in open(TSV, encoding="utf-8") if ln[:1].isdigit()]
    sym_by_id = {r[2]: r[1] for r in old if len(r) > 2}

    rows, seen = [], set()
    for page in (1, 2, 3):
        for c in fetch(page):
            rank = c.get("market_cap_rank")
            if not rank or rank > LIMIT or c["id"] in seen:
                continue
            seen.add(c["id"])
            rows.append((rank, sym_by_id.get(c["id"], c["symbol"].upper()), c["id"],
                         c.get("market_cap") or 0, c.get("name") or ""))
        time.sleep(3)
    rows.sort()
    if len(rows) < LIMIT - 20:
        print(f"CoinGecko отдал только {len(rows)} мест — список не тронут")
        return 1

    import whale_api as w  # noqa: E402 — после сети: импорт долгий
    book = {c["s"] for c in w.UNLOCK_BOOK}
    known = book | set(w.UNLOCK_SKIPPED)
    new_ids = {r[2] for r in rows} - {r[2] for r in old}
    # Строки «500+» — полоса у границы, взятая без CoinGecko: не «выпавшие».
    left = [r for r in old if r[0] != "500+" and r[2] not in {x[2] for x in rows}]
    lost = [r for r in rows if r[1] not in known]

    print(f"Мест в рейтинге: {len(rows)} (было {len(old)}). Новых монет: {len(new_ids)}, выпало: {len(left)}.")
    if lost:
        print("\nБЕЗ СТАТУСА — добавить в календарь или в отсеянные с причиной:")
        for rank, sym, cid, mcap, name in lost:
            print(f"  {rank:>3}  {sym:<12} {cid:<40} {mcap / 1e6:>9.1f} млн  {name}")
    else:
        print("\nУ всех монет первых 500 есть статус.")
    if left:
        print("\nВыпали из первых 500 (их статус остаётся, трогать не нужно):")
        print("  " + ", ".join(r[1] for r in left))

    if new_ids:
        print("\nСтроки новых монет для tools/unlock-rank.tsv:")
        for rank, sym, cid, _mcap, _name in rows:
            if cid in new_ids:
                print(f"{rank}\t{sym}\t{cid}")

    if write:
        today = time.strftime("%d.%m.%Y", time.gmtime())
        head = [
            f"# Рейтинг по капитализации (CoinGecko, {today}): место, тикер, id — первые {LIMIT}.",
            "# Каждая монета отсюда обязана быть в календаре разлоков или в списке",
            "# отсеянных с причиной — это проверяет tools/cortex-guard.py.",
            "# Обновлять: python3 tools/sync-rank.py --write (раз в месяц, там, где открыт CoinGecko).",
        ]
        with open(TSV + ".tmp", "w", encoding="utf-8") as f:
            f.write("\n".join(head) + "\n")
            for rank, sym, cid, _mcap, _name in rows:
                f.write(f"{rank}\t{sym}\t{cid}\n")
        os.replace(TSV + ".tmp", TSV)
        print(f"\nСписок записан: {TSV}")
    return 1 if lost else 0


if __name__ == "__main__":
    sys.exit(main())
