# Проверка карты ликвидаций на сервере

Для Claude на сервере. Только смотри и докладывай: ничего не меняй, не
перезапускай, не правь файлы и настройки. Скрипты ниже собирают карту
отдельным процессом: с коммита «база снимков в карте — только на чтение»
такой процесс открывает боевую liq_oi.db только на чтение (mode=ro) — и
копилку дневных рядов, и снимки бирж, и список монет; пишет одна служба.
Подмены _liq_day_keep и _liq_oi_con не нужны; сторож на запись — можно
оставить. Если выкат старше — пункты 2, 6 и 8 не запускай. Ключи и /etc/whale-api.env не
выводи. Наружу — только запросы к биржам, как у самой сборки карты.

## 1. Выкат
```
cd ~/WalletTracker && git log --oneline -1 && systemctl is-active whale-api \
  && systemctl show whale-api -p ActiveEnterTimestamp
grep -c '"365d": ("1d", 365)' wt_liqmap.py
grep -c "(500, 0.005, 4)" wt_liqmap.py
grep -c "wt_liqmap.set_price(_liq_price)" whale_api.py
grep -c "def restore(data: object) -> int:" wt_liqmap.py
grep -c "    liq_disk_load()" whale_api.py
grep -c 'PRE = ("1d", 1000)' wt_liqmap.py
grep -c '("Kraken", _liq_stock(_liq_kraken)))' whale_api.py
grep -c 'if oi and len(inv) >= 0.95 \* len(oi):' whale_api.py
grep -c "x = d + min(gone, max(0.0, -d))" wt_liqmap.py
grep -c "def _glue_inverse(" whale_api.py
grep -c 'float(f"{v:.9g}")' wt_liqmap.py
grep -c '("BitMEX", _snap_bitmex), ("ApeX", _snap_apex)' whale_api.py
grep -c "def _stock_base(s: str) -> str:" whale_api.py
grep -c "since=ref\[0\]\[0\])" wt_liqmap.py
grep -c "def _bybit_oi(r: dict, value: bool = False) -> float:" whale_api.py
grep -c "LIQ_DAY_WRITE = True  # копилку" whale_api.py
grep -c "def _liq_oi_ro() -> sqlite3.Connection:" whale_api.py
```
Ожидаю: коммит «Карта ликвидаций: калибровка по настоящим ликвидациям…»
или новее, служба active и запущена ПОСЛЕ этого коммита, все семнадцать
счётчиков — 1 (коммит «…база снимков в карте — только на чтение» или новее). Если выкат не пришёл — так и напиши и остальное не делай.

## 2. BTC по всем шести окнам — та же сборка, что у службы (отдельным процессом)
```
cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 400 python3 - <<'PY'
import time
import whale_api  # noqa: F401 — подключает сбор с бирж и цену к wt_liqmap
import wt_liqmap as lm
for rng in lm.RANGES:
    t = time.time(); r = lm.build("BTC", rng); took = time.time() - t
    if not r.get("ok"):
        print(rng, "карты нет:", r, f"({took:.1f} с)"); continue
    px = r["px"]
    bad = [b["p"] for b in r["buckets"] if (sum(b["L"]) and b["p"] >= px) or (sum(b["S"]) and b["p"] <= px)]
    print(f"{rng:>4}: {took:4.1f} с, цена ${px:,.1f}, бирж {len(r['ex'])} ({', '.join(r['ex'])}), "
          f"видно ${r['seen'] / 1e9:.2f} млрд из ${r['oi'] / 1e9:.2f} млрд ({r['seen'] / r['oi'] * 100:.0f} %), не на своей стороне: {len(bad)}, "
          f"±5 %: лонги ${r['cum'][5]['L'] / 1e6:.0f}M, шорты ${r['cum'][5]['S'] / 1e6:.0f}M")
PY
```
Ожидаю: первое окно — до ~60 с (грузится предыстория за три года, одна на
все окна), остальные — меньше 15 с. Цена одна во всех окнах. Среди бирж —
Binance, Bybit и Kraken (в окнах от 90 дней Binance может не быть: его
история — 30 дней). «Не на своей стороне» — 0 везде. «Видно» растёт от суток к
году (окно — позиции, открытые за этот период; учёт закрытий и
ликвидаций — по всей истории), окна от 90 дней почти совпадают. Из
песочницы без Binance и Bybit у BTC: 2 % → 7 % → 13 % → 15 %. Длинное окно
не должно показывать меньше короткого — если показывает, напиши. Перепиши
вывод целиком.

## 3. Живая цена между сборками
```
cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 200 python3 - <<'PY'
import time
import whale_api as api
import wt_liqmap as lm
r1 = lm.liq_map("BTC", "1d", wait=120); time.sleep(45); r2 = lm.liq_map("BTC", "1d")
print("цена Hyperliquid сейчас:", api._liq_price("BTC"))
print(f"ответ 1: ${r1['px']:,.1f}, ответ 2 (через 45 с): ${r2['px']:,.1f}; сборка та же: {r1['at'] == r2['at']}")
lows = [b["p"] for b in r2["buckets"] if sum(b["L"])]; highs = [b["p"] for b in r2["buckets"] if sum(b["S"])]
print("ближайший лонг ниже цены:", max(lows) if lows else None, "| ближайший шорт выше:", min(highs) if highs else None)
PY
```
Ожидаю: цена во втором ответе свежая, сборка та же (at одинаковый),
ближайший лонг — ниже цены, ближайший шорт — выше.

## 4. Служба: журнал, запросы, нагрузка
```
S=$(systemctl show whale-api -p ActiveEnterTimestamp --value)
journalctl -u whale-api --since "$S" --no-pager | grep -ciE "Traceback"
journalctl -u whale-api --since "$S" --no-pager | grep -iE "liq|ликвид|копия карт" | tail -10
L=$(ls /var/log/nginx/access.log 2>/dev/null || ls /var/log/nginx/*access*.log | head -1)
D=$(LC_ALL=C date +%d/%b/%Y)
awk -v d="$D" 'index($4, "[" d ":") == 1 && $7 ~ /^\/api\/liqmap/ {split($7,q,"range="); split(q[2],w,"&"); n[w[1]" "$9]++} END {for (k in n) print n[k], k}' "$L" | sort -k2
curl -s -o /dev/null -w "/api/liqmap без ключа: %{http_code}\n" "http://127.0.0.1:8090/api/liqmap?sym=BTC&range=1d"
P=$(systemctl show whale-api -p MainPID --value); ps -o pid,rss,nlwp,pcpu,etime -p "$P"
top -b -n 3 -d 10 -p "$P" | grep -E "^ *$P " | awk '{print "процессор службы, %:", $9}'
```
Ожидаю: Traceback — 0; ответы /api/liqmap — 200/304, 5xx — 0; без ключа —
403; потоков — не сотни. Предыстория добавила счёт: процессор и память
(RSS) — напиши цифры; до ~100 МБ сверх прежнего — норма.

## 5. Копия карт на диске (api_cache/liqmap.json)
```
F=$(find ~ /var/lib /opt -path "*api_cache/liqmap.json" 2>/dev/null | head -1); echo "файл: ${F:-нет}"
[ -n "$F" ] && ls -la --time-style=+%H:%M:%S "$F" && date +%H:%M:%S && ls "$(dirname "$F")" | grep -c "\.tmp$"
[ -n "$F" ] && cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 60 python3 - "$F" <<'PY'
import json, sys, time
import wt_liqmap as lm
d = json.load(open(sys.argv[1], encoding="utf-8"))
ages = sorted(round(time.time() - d["at"] + m["age"]) for m in d["maps"])
print("карт в файле:", len(d["maps"]), "| записан, с назад:", round(time.time() - d["at"]), "| возраст карт, с: от", ages[0], "до", ages[-1])
print("принято бы при запуске (отдельный процесс, служба не трогается):", lm.restore(d))
PY
```
Ожидаю: файл есть, записан не дольше ~6 минут назад (пишется после каждого
круга прогрева), временных .tmp — 0, карт около 36, почти все «приняты
бы» (до исправления принималось 3 из 37). Размер файла — напиши. Если файл записан давно — прогрев встал:
напиши это первым пунктом отчёта.

## 6. Точность: модель против настоящих ликвидаций за неделю (и калибровка оборота)
Сервер хранит настоящие ликвидации бирж за 7 дней (liq_ev в liq_oi.db).
Скрипт открывает базу ТОЛЬКО на чтение и сравнивает, сколько и где модель
«сжигает» позиций за последние 6 дней, с тем, что биржи ликвидировали на
самом деле. L×/S× — во сколько раз модель больше настоящего (1,00 —
точно). Полосы — по 0,5 %.

Варианты — оборот позиций. Модель открывает позиции только на чистый
прирост интереса, а у цены ликвидируются свежие позиции с большим
плечом, которые трейдеры весь день открывают и закрывают при том же
интересе. Бэктест в песочнице (OKX, сутки, 10 монет) — «сейчас»: L×0,73
S×0,79, совпадение 42 %; «доля 0,1»: ×0,80/×0,98, 46 %; «доля 0,2»:
×0,86/×1,15, 47 %; «две группы»: ×1,17/×1,43, 45 %. Суток мало — решаем
по этой неделе:
- «сейчас» — без оборота;
- «доля 0,1» / «доля 0,2» — каждая позиция закрывается с интенсивностью
  0,1 (0,2) в сутки, закрытое открывается по текущей свече;
- «две группы» — 40 % новых позиций краткосрочные (живут ~полсуток,
  переоткрываются у цены), остальные держатся.
DOT — отдельно, по просьбе: у него порог настоящих ликвидаций за неделю
$50 тыс. вместо $0,2 млн (рынок меньше). Займёт ~10–25 минут.
```
cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 3000 python3 - <<'PY'
import math, sqlite3, time
import whale_api as api
import wt_liqmap as lm
con = sqlite3.connect(f"file:{api.LIQ_OI_DB}?mode=ro", uri=True)
def scale(book, k):
    for c in book.cohorts:
        c[1] *= k
    for sd in book.agg:
        for arr in sd:
            for b in range(len(arr)):
                arr[b] *= k
def close(book, amount):
    # Сколько закрылось: _Book.close ничего не возвращает — меряем по total().
    before = book.total()
    book.close(amount)
    return before - book.total()
def burns(rows, lo, step, levs, t0, share, rate):
    # share — доля новых позиций в обороте (1 — все), rate — интенсивность в сутки.
    books, log = (lm._Book(lo, step), lm._Book(lo, step)), {}
    for i in range(2, len(rows) + 1):
        _, hi, low, p_now, _oi, bs = rows[i - 1]
        gone = 0.0
        for book in books:
            before = [[a[:] for a in s] for s in book.agg] if rows[i - 1][0] >= t0 else None
            gone += book.burn(i, hi, low)
            if before:
                for s in (0, 1):
                    for g in range(book.g_n):
                        for b in range(lm.BUCKETS):
                            q = before[s][g][b] - book.agg[s][g][b]
                            if q > 0:
                                log[(s, b)] = log.get((s, b), 0) + q * book.mids[b]
        if i == len(rows):
            break
        d = rows[i][4] / p_now - rows[i - 1][4] / rows[i - 2][3]
        x = d + min(gone, max(0.0, -d))
        if x < 0:
            rest = -x - close(books[1], -x) if share > 0 else -x
            if rest > 0:
                books[0].close(rest)
        elif x > 0:
            if share < 1:
                books[0].add(i, *lm._opened(x * (1 - share), hi, low, bs, lo, step, levs))
            if share > 0:
                books[1].add(i, *lm._opened(x * share, hi, low, bs, lo, step, levs))
        if share > 0 and rate > 0:
            f = 1 - math.exp(-rate * max(0, rows[i][0] - rows[i - 1][0]) / 86400)
            ch = books[1].total() * f
            if ch > 0:
                scale(books[1], 1 - f)
                books[1].add(i, *lm._opened(ch, hi, low, bs, lo, step, levs))
    return log
VARIANTS = (("сейчас", 0, 0), ("доля 0,1", 1, 0.1), ("доля 0,2", 1, 0.2), ("две группы", 0.4, 2.0))
t0 = time.time() - 6 * 86400
tot = {}
for sym in ("BTC", "ETH", "SOL", "XRP", "DOGE", "DOT"):
    got, ref = api._liq_gather(sym, "1h", 168)
    pre = api._liq_gather(sym, *lm.PRE)[0]
    px = ref[-1][3]; lo, step = px * (1 - lm.SPAN), px * lm.SPAN * 2 / lm.BUCKETS
    band = lambda p: math.floor((p / px - 1) * 200)
    for ex, raw in sorted(got.items()):
        real = con.execute("SELECT side, px, usd FROM liq_ev WHERE ex=? AND sym=? AND t>=?", (ex, sym, int(t0 * 1000))).fetchall()
        R = [sum(u for s, _, u in real if s == 1), sum(u for s, _, u in real if s == 0)]  # side 1 — ликвидирован лонг
        if sum(R) < (5e4 if sym == "DOT" else 2e5):
            continue  # меньше $0,2 млн за неделю — не мерило
        hr = {}
        for s, p, u in real:
            k = (0 if s == 1 else 1, band(p)); hr[k] = hr.get(k, 0) + u
        rows = lm.prepend(lm.clean_rows(pre.get(ex)), lm.clean_rows(raw))
        levs = lm.levs_upto(lm.max_lev(ex, sym))
        line = []
        for name, share, rate in VARIANTS:
            hp = {}
            for (s, b), u in burns(rows, lo, step, levs, t0, share, rate).items():
                k = (s, band(lo + step * (b + 0.5))); hp[k] = hp.get(k, 0) + u
            P = [sum(u for (s, _), u in hp.items() if s == k) for k in (0, 1)]
            caught = sum(u for k, u in hr.items() if hp.get(k, 0) > 0)
            vol = sum(min(u, hp.get(k, 0)) for k, u in hr.items())
            both = sum(max(hr.get(k, 0), hp.get(k, 0)) for k in set(hr) | set(hp))
            if ex != "Binance":
                t = tot.setdefault(name, [0] * 7); t[0] += P[0]; t[1] += P[1]; t[2] += R[0]; t[3] += R[1]; t[4] += caught; t[5] += vol; t[6] += both
            line.append(f"{name}: L×{P[0] / max(R[0], 1):.2f} S×{P[1] / max(R[1], 1):.2f} поймано {caught / max(sum(R), 1) * 100:.0f}% "
                        f"по объёму {vol / max(sum(R), 1) * 100:.0f}% совпадение {vol / max(both, 1) * 100:.0f}%")
        print(f"{sym:5}{ex:8} настоящие L ${R[0] / 1e6:6.1f}M S ${R[1] / 1e6:6.1f}M | " + " | ".join(line), flush=True)
for k, v in tot.items():
    print(f"ИТОГО без Binance, {k:10}: L×{v[0] / max(v[2], 1):.2f} S×{v[1] / max(v[3], 1):.2f} поймано {v[4] / max(v[2] + v[3], 1) * 100:.0f}% "
          f"по объёму {v[5] / max(v[2] + v[3], 1) * 100:.0f}% совпадение {v[5] / max(v[6], 1) * 100:.0f}%")
PY
```
«Поймано» — доля настоящих ликвидаций (в долларах), случившихся в полосе,
где карта ждала ликвидации той же стороны (цель — не меньше 95 %). «По
объёму» — в каждой полосе засчитано не больше, чем модель ждала, и не
больше, чем случилось. «Совпадение» — Σmin / Σmax по полосам: завышение
наказывается так же, как занижение, — по нему и выбираем вариант (при
L×/S× в пределах 0,8–1,25). Перепиши вывод целиком. Лента Binance —
снимок (не больше одной ликвидации в секунду на монету), его «настоящие»
занижены: в итог он не входит.

## 7. Binance и Bybit: интерес в карте против счётчиков бирж
К Binance добавлены COIN-M (BTCUSD_PERP) и USDC-M (BTCUSDC, ETHUSDC — по
CoinGecko у ETH это треть интереса Binance), к Bybit — inverse (BTCUSD). Единицы взяты из документации бирж; здесь — сверка с живыми
счётчиками: последний ряд карты против «USDT-контракт + контракт в монете»
прямо с биржи.
```
cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 120 python3 - <<'PY'
import whale_api as api
g = api.get_json
for sym in ("BTC", "ETH", "SOL", "DOGE"):
    rb = api._liq_binance(sym, "15m", 96); ry = api._liq_bybit(sym, "15m", 96)
    fu = g(f"https://fapi.binance.com/fapi/v1/openInterest?symbol={sym}USDT") or {}
    fm = g(f"https://fapi.binance.com/fapi/v1/premiumIndex?symbol={sym}USDT") or {}
    cm = g(f"https://dapi.binance.com/dapi/v1/openInterest?symbol={sym}USD_PERP") or {}
    size = 100 if sym == "BTC" else 10  # доллары в контракте COIN-M
    fc = g(f"https://fapi.binance.com/fapi/v1/openInterest?symbol={sym}USDC") or {}
    mc = g(f"https://fapi.binance.com/fapi/v1/premiumIndex?symbol={sym}USDC") or {}
    b_now = (float(fu.get("openInterest", 0)) * float(fm.get("markPrice", 0)) + float(cm.get("openInterest", 0) or 0) * size
             + float(fc.get("openInterest", 0) or 0) * float(mc.get("markPrice", 0) or 0))
    lin = (((g(f"https://api.bybit.com/v5/market/tickers?category=linear&symbol={sym}USDT") or {}).get("result") or {}).get("list") or [{}])[0]
    inv = (((g(f"https://api.bybit.com/v5/market/tickers?category=inverse&symbol={sym}USD") or {}).get("result") or {}).get("list") or [{}])[0]
    # Одна сторона, как у всех бирж (openInterest у Bybit — обе стороны, пункт 9).
    y_now = float(lin.get("singleOpenInterestValue") or 0) + float(inv.get("singleOpenInterest") or 0)
    for name, rows, ref in (("Binance", rb, b_now), ("Bybit", ry, y_now)):
        ours = rows[-1][4] if rows else 0
        print(f"{sym:5}{name:8} в карте ${ours / 1e6:9.1f}M | на бирже ${ref / 1e6:9.1f}M | отношение {ours / ref if ref else float('nan'):.3f}")
PY
```
Ожидаю: отношение 0,95–1,05 везде (интерес меняется за минуты — немного
расходится). Сильно больше или меньше — неверные единицы: напиши первым
пунктом отчёта, по какой бирже и монете.

## 8. Акции и новые биржи (BitMEX, ApeX)
```
cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 300 python3 - <<'PY'
import whale_api as api
import wt_liqmap as lm
b = api._snap_bitmex()
inst = api.get_json("https://www.bitmex.com/api/v1/instrument?symbol=XBTUSD&count=1&reverse=true") or [{}]
print("BitMEX: монет в снимке", len(b), "| BTC в карте $%.0fM" % (b.get("BTC", (0,))[0] / 1e6),
      "| сама биржа, XBTUSD openInterest (контракты по $1): $%.0fM" % (float((inst[0] if inst else {}).get("openInterest") or 0) / 1e6))
a = api._snap_apex()
print("ApeX: монет", len(a), "| BTC $%.0fM" % (a.get("BTC", (0,))[0] / 1e6))
coins = {c["s"]: c for c in api.liq_coins().get("coins") or []}
for s in ("TSLA", "NVDA", "MSTR", "QQQ", "TSLAX", "TSLASTOCK"):
    c = coins.get(s)
    print(f"{s:10} в списке монет:", (round(c["v"] / 1e6, 1), c["ex"]) if c else "нет")
for s in ("TSLA", "NVDA"):
    r = lm.build(s, "7d")
    print(s, "карта 7d:", r.get("ok"), r.get("ex"), "видно $%.1fM из $%.1fM" % (r.get("seen", 0) / 1e6, r.get("oi", 0) / 1e6) if r.get("ok") else r)
PY
```
Ожидаю: BitMEX в карте по BTC — не меньше XBTUSD (к нему прибавлен
XBTUSDT); если BitMEX отсюда закрыт — так и напиши. TSLAX и TSLASTOCK в
списке монет — «нет» (они склеены в TSLA); у TSLA и NVDA в карте больше
бирж, чем OKX и Gate.

## 9. Bybit: интерес считается с обеих сторон или с одной?
С 11 июня 2026 Bybit перешёл с «обе стороны» на «одна сторона» и добавил
в API поля singleOpenInterest / singleOpenInterestValue. Карта берёт
старое openInterest. Если оно всё ещё считает обе стороны — интерес Bybit в
карте вдвое больше настоящего (модель на неделе завышала Bybit ×1,2–3,2 на
всех монетах); если перешло на одну сторону 11 июня — в истории в этот
день ложное падение вдвое. Нужны сырые ответы, ничего не меняй.
```
cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 120 python3 - <<'PY'
import calendar, time
import whale_api as api
g = api.get_json
B = "https://api.bybit.com/v5/market"
t = (g(f"{B}/tickers?category=linear&symbol=BTCUSDT") or {}).get("result", {}).get("list") or [{}]
print("tickers BTCUSDT, поля про интерес:", {k: v for k, v in t[0].items() if "nterest" in k})
now = (g(f"{B}/open-interest?category=linear&symbol=BTCUSDT&intervalTime=1d&limit=2") or {}).get("result", {}).get("list") or []
print("open-interest сейчас (сырые строки):", now)
june = calendar.timegm((2026, 6, 11, 0, 0, 0)) * 1000
old = (g(f"{B}/open-interest?category=linear&symbol=BTCUSDT&intervalTime=1d&startTime={june - 6 * 86400000}&endTime={june + 6 * 86400000}&limit=20") or {}).get("result", {}).get("list") or []
for r in sorted(old, key=lambda r: int(r["timestamp"])):
    print(time.strftime("%Y-%m-%d", time.gmtime(int(r["timestamp"]) // 1000)), {k: v for k, v in r.items() if k != "timestamp"})
rb = api._liq_binance("BTC", "1d", 3); ro = api._liq_okx("BTC", "1d", 3); ry = api._liq_bybit("BTC", "1d", 3)
print("BTC в карте: Binance $%.2f млрд, OKX $%.2f млрд, Bybit $%.2f млрд" % (rb[-1][4] / 1e9, ro[-1][4] / 1e9, ry[-1][4] / 1e9))
PY
```
Перепиши вывод целиком. Ожидаю одно из двух: (а) в строках есть поле
single… и оно вдвое меньше openInterest — значит, openInterest по-прежнему
«обе стороны»; (б) около 11 июня openInterest скачком падает вдвое — значит,
поле перешло на «одну сторону».

## 10. Снимки 26 бирж и копилка дневной истории
Из песочницы закрыты CoinEx, Coinbase International и BitMEX — здесь их
видно. MEXC: сверка с CoinGecko из песочницы — 0,93 от его интереса, не
удвоен. Копилка: сервер
сохраняет дневные ряды бирж при каждой загрузке предыстории — история
Binance (у биржи 30 дней) должна расти на день в день.
```
cd ~/WalletTracker && PYTHONDONTWRITEBYTECODE=1 timeout 300 python3 - <<'PY'
import sqlite3, time
import whale_api as api
mids = api.hl_mids()
for name, fn in api.LIQ_SNAPS:
    try:
        out = fn() or {}
    except Exception as e:
        out = {}; print(name, "сбой:", type(e).__name__, str(e)[:80])
    b = out.get("BTC")
    dev = (b[1] / mids["BTC"] - 1) * 100 if b and b[1] > 0 else float("nan")
    print(f"{name:14} монет {len(out):4} | BTC ${(b[0] if b else 0) / 1e6:8.1f}M, цена {dev:+.2f}% от Hyperliquid")
m = (api.get_json("https://contract.mexc.com/api/v1/contract/ticker?symbol=BTC_USDT") or {}).get("data") or {}
d = [x for x in (api.get_json("https://contract.mexc.com/api/v1/contract/detail?symbol=BTC_USDT") or {}).get("data") or [] if isinstance(x, dict)] or [(api.get_json("https://contract.mexc.com/api/v1/contract/detail?symbol=BTC_USDT") or {}).get("data") or {}]
print("MEXC BTC_USDT: holdVol", m.get("holdVol"), "contractSize", (d[0] or {}).get("contractSize"), "fairPrice", m.get("fairPrice"))
con = sqlite3.connect(f"file:{api.LIQ_OI_DB}?mode=ro", uri=True)
try:
    for ex, coin, n, a, z in con.execute("SELECT ex, coin, COUNT(*), MIN(t), MAX(t) FROM liq_day WHERE coin IN ('BTC','ETH') GROUP BY ex, coin ORDER BY coin, ex"):
        print(f"копилка {coin:4} {ex:8} дней {n:5}: {time.strftime('%Y-%m-%d', time.gmtime(a))} — {time.strftime('%Y-%m-%d', time.gmtime(z))}")
except sqlite3.Error as e:
    print("копилки ещё нет:", e)
PY
```
Ожидаю: у всех бирж цена в пределах ±1 %; CoinEx, Coinbase Intl, BitMEX —
монеты есть (если 0 — напиши, что отвечает биржа). Phemex по BTC — около
$1,2 млрд (с инверсным BTCUSD и USDC; раньше был только USDT, ~$0,18 млрд),
XT.com — 60 монет (раньше ~40: места занимали закрытые рынки). Bitget,
MEXC, KuCoin — с USDC и инверсными (MEXC по BTC ~$5 млрд, KuCoin ~$0,9 млрд).
После выката: `SELECT * FROM oi_ver` — у Phemex, MEXC, KuCoin, Bitget, Aster,
BingX версия 2 (старая история пересчитана по первому новому снимку, без
скачка). MEXC: holdVol ×
contractSize × fairPrice — сравни с OKX и Binance по BTC (если MEXC вдвое
больше, чем ждёшь от его доли рынка, — напиши). Копилка: через сутки после
выката у Binance по BTC дней — около 31 и растёт на день в день.

## Отчёт
По каждому пункту — «ок» или что не так, с цифрами. Отдельно: одна ли цена
во всех окнах, какие биржи дали данные, сколько интереса «видно»; итог
пункта 6 по вариантам оборота (сейчас, доля 0,1, доля 0,2, две группы). Всё, что вне модуля, — одной строкой в конце.
