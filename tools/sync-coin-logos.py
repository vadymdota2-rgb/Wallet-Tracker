#!/usr/bin/env python3
"""Собирает src/components/coin-logos.ts — тикер → логотип с CoinGecko.

    python3 tools/sync-coin-logos.py

Зачем: в фандинге и в ротации попадаются монеты, которых нет ни в образе, ни
у Hyperliquid, — на BingX и Gate торгуется впятеро больше тикеров. Без
логотипа строка выглядит как заготовка, а не как монета.

Берутся первые страницы CoinGecko по капитализации: тикеры не уникальны, и
при совпадении выигрывает та монета, что крупнее, — ровно так выбрал бы
человек. Выверенные вручную адреса в coin-fallback.ts главнее: этот список
их не трогает.
"""
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "src", "components", "coin-logos.ts")
FALLBACK = os.path.join(os.path.dirname(HERE), "src", "components", "coin-fallback.ts")
PAGES = 4
PER = 250
API = ("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd"
       "&order=market_cap_desc&per_page={per}&page={page}&sparkline=false")
CDN = "https://coin-images.coingecko.com/"


def get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "wallet-tracker-tools/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main() -> int:
    known = set(re.findall(r"^\s*([A-Z0-9]+):", open(FALLBACK, encoding="utf-8").read(), re.M))
    out: dict[str, str] = {}
    for page in range(1, PAGES + 1):
        rows = get(API.format(per=PER, page=page))
        if not isinstance(rows, list) or not rows:
            break
        for c in rows:
            sym = str(c.get("symbol") or "").upper().strip()
            img = str(c.get("image") or "")
            if not sym or not img.startswith(CDN) or sym in known or sym in out:
                continue
            if not re.fullmatch(r"[A-Z0-9]{2,12}", sym):
                continue
            # Хвост ?1696501400 — метка обновления, файлу она не нужна.
            path = img[len(CDN):].split("?")[0]
            # Мелкий вариант того же файла: в кружке тридцати пикселей большой
            # не виден, а весит он в шесть раз больше.
            out[sym] = "/cglogo/" + path.replace("/large/", "/small/", 1)
        time.sleep(3)  # бесплатный ключ: десяток запросов в минуту

    if len(out) < 200:
        sys.stderr.write(f"слишком мало монет ({len(out)}) — файл не трогаем\n")
        return 1

    # Ключи в кавычках: тикеры вроде 1INCH и 0G голым именем в TypeScript не
    # записать — файл перестанет разбираться целиком.
    body = "".join(f'  "{k}": "{v}",\n' for k, v in sorted(out.items()))
    open(OUT, "w", encoding="utf-8").write(
        "/**\n"
        " * Логотипы монет с CoinGecko: тикер → путь через наш же `/cglogo/`.\n"
        " *\n"
        " * Файл собран tools/sync-coin-logos.py, руками его не правят. Ручные\n"
        " * адреса лежат в coin-fallback.ts и главнее этих: там выверено, какой\n"
        " * именно выпуск монеты имеется в виду.\n"
        " *\n"
        " * Тикеры не уникальны, поэтому при совпадении здесь лежит самая крупная\n"
        " * монета с таким тикером. Для мелких одноимённых это будет чужой значок —\n"
        " * цена ошибки та же, что у любого поиска по тикеру, и она ниже, чем буква\n"
        f" * в кружке у каждой второй строки.\n"
        " */\n"
        f"export const CG_LOGOS: Record<string, string> = {{\n{body}}};\n"
    )
    print(f"{len(out)} монет → {os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
