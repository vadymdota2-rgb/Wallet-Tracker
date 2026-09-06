#!/usr/bin/env python3
"""Скачивает логотипы один раз, чтобы мини-апп не ходил за ними наружу.

Запускать на ВМ:  python3 fetch_logos.py
Результат:
  ./coins/bsc/<checksum>.png   спотовые токены BSC
  ./coins/hl/<имя>.svg         перпы Hyperliquid (включая акции)
  ./coins_manifest.json        список того, что реально скачалось

Папку coins/ кладём в репозиторий Wallet-Tracker как html/coins/,
manifest — рядом с whale_api.py на ВМ. Манифест нужен, чтобы API не
предлагал фронту локальный адрес для того, чего на диске нет.
"""
import json, os, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request

DB = os.environ.get("WHALE_DB", os.path.expanduser("~/WhaleScanner/whale_bot.db"))
OUT = os.environ.get("LOGO_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "coins"))
MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coins_manifest.json")
UA = {"User-Agent": "Mozilla/5.0 (WhaleScanner logo fetcher)"}
# Глубина и потолок выборки: столько же, сколько видит интерфейс.
DAYS = int(os.environ.get("LOGO_DAYS", "30"))
LIMIT = int(os.environ.get("LOGO_LIMIT", "400"))
HL_INFO = "https://api.hyperliquid.xyz/info"

# --- keccak-256 и EIP-55: оба источника отдают только смешанный регистр ---
_KEC_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_KEC_R = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]]
_M = (1 << 64) - 1

def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M

def _keccak_f(A):
    for rnd in range(24):
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                A[x][y] ^= D[x]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _KEC_R[x][y])
        for x in range(5):
            for y in range(5):
                A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) & _M
        A[0][0] ^= _KEC_RC[rnd]
    return A

def keccak256(data: bytes) -> bytes:
    rate = 136
    A = [[0] * 5 for _ in range(5)]
    pad = bytearray(data + b"\x01" + b"\x00" * ((-len(data) - 1) % rate))
    pad[-1] ^= 0x80
    for off in range(0, len(pad), rate):
        blk = pad[off:off + rate]
        for i in range(rate // 8):
            A[i % 5][i // 5] ^= int.from_bytes(blk[i * 8:i * 8 + 8], "little")
        _keccak_f(A)
    out = b""
    for i in range(4):
        out += A[i % 5][i // 5].to_bytes(8, "little")
    return out[:32]

def to_checksum(addr: str) -> str:
    a = (addr or "").lower().replace("0x", "")
    if len(a) != 40:
        return addr or ""
    h = keccak256(a.encode()).hex()
    return "0x" + "".join(c.upper() if c.isalpha() and int(h[i], 16) >= 8 else c for i, c in enumerate(a))


def get(url: str, timeout: float = 15.0) -> bytes | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            if r.status != 200:
                return None
            data = r.read()
            # у мёртвых источников 404 иногда приходит как маленький JSON
            return data if len(data) > 200 else None
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return None


def save(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def bsc_tokens() -> list[tuple[str, str]]:
    """Только те токены, которые реально доходят до экрана.

    В token_cache лежит всё, что бот когда-либо видел в блокчейне — тысячи
    записей. Интерфейс же строится по таблице trades, и самое длинное окно
    там 30 дней, а список режется по обороту. Берём то же самое, иначе
    качали бы часами ради значков, которых никто не увидит.
    """
    if not os.path.isfile(DB):
        print(f"нет базы {DB}", file=sys.stderr)
        return []
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    since = int(time.time()) - DAYS * 86400
    try:
        rows = con.execute(
            "SELECT tc.symbol AS symbol, t.token AS address, "
            "       SUM(t.usd_nanos) AS vol "
            "FROM trades t JOIN token_cache tc "
            "  ON lower(tc.address) = lower(t.token) "
            "WHERE t.timestamp >= ? AND t.usd_nanos > 0 "
            "  AND tc.symbol NOT IN ('UNKNOWN','') AND t.token LIKE '0x%' "
            "GROUP BY lower(t.token) "
            "ORDER BY vol DESC "
            "LIMIT ?",
            (since, LIMIT),
        ).fetchall()
    except sqlite3.Error as e:
        print("не читается trades/token_cache:", e, file=sys.stderr)
        return []
    finally:
        con.close()
    out = []
    for r in rows:
        a = str(r["address"] or "").lower()
        if len(a) == 42:
            out.append((str(r["symbol"]), a))
    return out


def hl_coins() -> list[str]:
    try:
        req = urllib.request.Request(
            HL_INFO, data=json.dumps({"type": "allMids"}).encode(),
            headers={**UA, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = json.loads(r.read().decode())
        return sorted(str(k) for k in raw) if isinstance(raw, dict) else []
    except Exception as e:
        print("список монет Hyperliquid не получен:", e, file=sys.stderr)
        return []


def main() -> int:
    manifest = {"bsc": [], "hl": [], "built": int(time.time())}

    toks = bsc_tokens()
    print(f"спот BSC: {len(toks)} токенов (обороты за {DAYS} дн., потолок {LIMIT})")
    ok = skip = 0
    for i, (sym, low) in enumerate(toks, 1):
        s = to_checksum(low)
        dest = os.path.join(OUT, "bsc", f"{s}.png")
        if os.path.isfile(dest) and os.path.getsize(dest) > 200:
            manifest["bsc"].append(s)
            skip += 1
            continue
        data = get(f"https://tokens.pancakeswap.finance/images/{s}.png")
        if data is None:
            data = get("https://raw.githubusercontent.com/trustwallet/assets/master/"
                       f"blockchains/smartchain/assets/{s}/logo.png")
        if data is not None:
            save(dest, data)
            manifest["bsc"].append(s)
            ok += 1
        if i % 25 == 0:
            print(f"  {i}/{len(toks)} — скачано {ok}, уже было {skip}")
        time.sleep(0.05)
    print(f"спот: скачано {ok}, пропущено (уже есть) {skip}, без логотипа {len(toks)-ok-skip}")

    coins = hl_coins()
    print(f"перпы Hyperliquid: {len(coins)} монет")
    ok = skip = 0
    for i, c in enumerate(coins, 1):
        safe = c.replace(":", "_").replace("/", "_")
        dest = os.path.join(OUT, "hl", f"{safe}.svg")
        if os.path.isfile(dest) and os.path.getsize(dest) > 200:
            manifest["hl"].append(c)
            skip += 1
            continue
        # двоеточие в xyz:NVDA оставляем как есть: именно так адрес и работает
        data = get("https://app.hyperliquid.xyz/coins/"
                   + urllib.parse.quote(c, safe=":") + ".svg")
        if data is not None:
            save(dest, data)
            manifest["hl"].append(c)
            ok += 1
        if i % 25 == 0:
            print(f"  {i}/{len(coins)} — скачано {ok}, уже было {skip}")
        time.sleep(0.05)
    print(f"перпы: скачано {ok}, пропущено {skip}, без логотипа {len(coins)-ok-skip}")

    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    total = sum(os.path.getsize(os.path.join(d, x))
                for d, _, fs in os.walk(OUT) for x in fs)
    print(f"\nманифест: {MANIFEST} ({len(manifest['bsc'])} спот + {len(manifest['hl'])} перп)")
    print(f"папка {OUT}: {total/1048576:.1f} МБ")
    print("\nДальше: папку coins/ положить в репозиторий как html/coins/,")
    print("манифест оставить рядом с whale_api.py и перезапустить whale-api.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
