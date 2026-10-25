"""Bitcoin — потоки бирж, крупные ордера, рейтинг и карточка кошелька
(/api/btc/flow, /api/btc/big, /api/btc/rank, /api/btc/wallet).

Данные пишет сканер бота (WhaleScanner/btc_chain.cpp) в свою базу btc.db:
каждый блок биткоина, адреса бирж, выводы и заводы. «Покупка» здесь —
вывод монет с биржи на частный адрес, «продажа» — завод на биржу: у
биткоина нет свопов, и это единственное, что о сделке видно в цепочке.

Адрес, который сканер позже узнал как биржевой, из досок выпадает сам:
значит, тот «вывод» был перекладкой биржи между своими кошельками.

Модуль только читает btc.db. Единственная запись — настоящее написание
адреса (btc_remember_case), когда человек добавляет кошелёк: сканер ждёт её
(BEGIN IMMEDIATE), а не ломается, как 23 октября.

Общие механизмы сервера — открытие базы, кэш с копией на диске и фоновой
сборкой, время, запрос наружу — приходят из whale_api через setup(): они
одни на все тяжёлые ответы API, второй копии у модуля нет.
"""
from __future__ import annotations

import functools
import heapq
import math
import re
import sqlite3
import sys
from collections.abc import Callable
from typing import Any, cast

Json = dict[str, Any]


def _unset(*_a: Any, **_k: Any) -> Any:
    raise RuntimeError("wt_btc.setup() не вызван")


# Из whale_api (setup). Имена — те же, что там: код читается одинаково.
open_db: Callable[..., sqlite3.Connection | None] = _unset
table_exists: Callable[[sqlite3.Connection, str], bool] = _unset
cached_bg: Callable[..., Json] = _unset
cached_small: Callable[..., Any] = _unset
now: Callable[[], int] = _unset
get_json: Callable[..., Any] = _unset
# Окна крупных ордеров, ч (общие с BSC), и точек в линии потока.
BIG_WINDOWS: dict[str, int] = {}
TREND_BUCKETS = 24
BTC_DB = ""
_BTC: dict[Any, Any] = {}


def setup(*, open_db: Callable[..., sqlite3.Connection | None],
          table_exists: Callable[[sqlite3.Connection, str], bool],
          cached_bg: Callable[..., Json], cached_small: Callable[..., Any],
          disk_cache: Callable[[dict[Any, Any], str], dict[Any, Any]],
          now: Callable[[], int], get_json: Callable[..., Any],
          db_path: Callable[[str, str], str],
          big_windows: dict[str, int], trend_buckets: int) -> None:
    """Подключить общие механизмы сервера. Зовёт whale_api при запуске."""
    g = globals()
    g.update(open_db=open_db, table_exists=table_exists, cached_bg=cached_bg, cached_small=cached_small,
             now=now, get_json=get_json, BIG_WINDOWS=big_windows, TREND_BUCKETS=trend_buckets)
    g["BTC_DB"] = db_path("WHALE_BTC_DB", "btc.db")
    # Тот же словарь, что был: копия на диске — под именем «btc», как раньше.
    disk_cache(_BTC, "btc")


BTC_ADDR_RE = re.compile(r"^(bc1[02-9ac-hj-np-z]{6,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$")
BTC_FLOW_WINS = {"1": 3600, "6": 21600, "24": 86400, "168": 604800, "720": 2592000}
# Пороги доски крупных движений, в биткоинах. Сканер пишет движения от 0,2.
BTC_BIG_MIN = (0.2, 1, 10, 100)
BTC_RANK_DAYS = (30, 90, 180, 365)
BTC_TTL = 60.0
BTC_ROWS = 100
# Тысяча транзакций у частного кошелька не бывает: это биржа без разметки,
# платёжный шлюз или сервис. В доски такие не идут — кроме кошельков базы
# сервисного аккаунта: их владелец добавил сам.
BTC_SERVICE_TXS = 1000
# Карточка кошелька — не больше стольких последних движений. У частного
# кошелька столько не бывает; у неразмеченного адреса биржи — бывает.
WALLET_MOVES_MAX = 20_000


def _btc_clean(con: sqlite3.Connection) -> str:
    """Условие «кошелёк частный»: не адрес биржи и не сервис."""
    parts = ["NOT EXISTS (SELECT 1 FROM btc_labels l WHERE l.address = m.wallet)"]
    if table_exists(con, "btc_addr"):
        svc = f"EXISTS (SELECT 1 FROM btc_addr s WHERE s.address = m.wallet AND s.txs >= {BTC_SERVICE_TXS})"
        if table_exists(con, "btc_watch"):
            svc = f"({svc} AND NOT EXISTS (SELECT 1 FROM btc_watch w WHERE w.address = m.wallet))"
        parts.append("NOT " + svc)
    return " AND ".join(parts)


def _btc_extra(con: sqlite3.Connection, wallets: list[str]) -> dict[str, Json]:
    """Остаток на адресе (по последней проверке сканера) и «в базе»."""
    out: dict[str, Json] = {w: {} for w in wallets}
    if not wallets:
        return out
    marks = ",".join("?" * len(wallets))
    if table_exists(con, "btc_addr"):
        for r in con.execute(f"SELECT address, bal_sats, txs FROM btc_addr WHERE address IN ({marks})", wallets):
            out[r["address"]].update(bal=round(int(r["bal_sats"] or 0) / 1e8, 4), txs=int(r["txs"] or 0))
    if table_exists(con, "btc_watch"):
        # base — в базе сервисного аккаунта. Как он туда попал (импорт или
        # поиск), не показываем: «Другое» в /import — кто угодно, без метки;
        # метки — только у кошельков ETF (ниже).
        for r in con.execute(f"SELECT address FROM btc_watch WHERE address IN ({marks})", wallets):
            out[r["address"]]["base"] = True
    if table_exists(con, "btc_etf_addr"):
        # Кошелёк биржевого фонда — по своей разметке сканера (btc_etf.cpp):
        # тикер фонда. Группы без имени («#…») не подписываем.
        for r in con.execute(f"SELECT address, fund FROM btc_etf_addr WHERE address IN ({marks}) "
                             f"AND fund NOT LIKE '#%'", wallets):
            out[r["address"]]["etf"] = str(r["fund"])[:12]
    return out


def btc_remember_case(addr: str) -> None:
    """Настоящее написание адреса — в btc.db, рядом с данными сканера."""
    con = open_db(BTC_DB, write=True)
    if not con:
        return
    try:
        con.execute("CREATE TABLE IF NOT EXISTS btc_case (lower TEXT PRIMARY KEY, addr TEXT NOT NULL)")
        con.execute("INSERT OR REPLACE INTO btc_case(lower, addr) VALUES(?,?)", (addr.lower(), addr))
        con.commit()
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] btc case: {e}\n")
    finally:
        con.close()


def btc_cases(keys: list[str]) -> dict[str, str]:
    """Строчный ключ → настоящее написание. Чего нет — остаётся ключом."""
    out = {k: k for k in keys}
    if not keys:
        return out
    con = open_db(BTC_DB)
    if not con:
        return out
    try:
        if table_exists(con, "btc_case"):
            marks = ",".join("?" * len(keys))
            for r in con.execute(f"SELECT lower, addr FROM btc_case WHERE lower IN ({marks})", keys):
                out[r["lower"]] = r["addr"]
    except sqlite3.Error:
        pass
    finally:
        con.close()
    return out


def _btc_open() -> sqlite3.Connection | None:
    con = open_db(BTC_DB)
    if con and not table_exists(con, "btc_moves"):
        con.close()
        return None
    return con


def _btc_price(con: sqlite3.Connection) -> float:
    """Цена из последнего блока: по ней сканер и считал доллары. Блок старше
    двух часов — открытая цена Coinbase.

    Возраст — по времени самого блока (ts), а не по времени записи (at):
    догоняя простой, сканер пишет блоки суточной давности с ценой их часа, и
    нынешняя стоимость запасов в рейтинге считалась по вчерашней цене."""
    try:
        r = con.execute("SELECT price_nanos, ts FROM btc_blocks WHERE price_nanos > 0 "
                        "ORDER BY height DESC LIMIT 1").fetchone()
        if r and now() - int(r["ts"] or 0) < 7200:
            return float(r["price_nanos"]) / 1e9
    except sqlite3.Error:
        pass
    return _spot()


def _spot_fetch() -> float:
    j = get_json("https://api.coinbase.com/v2/prices/BTC-USD/spot", 8)
    data = j.get("data") if isinstance(j, dict) else None
    try:
        p = float(data.get("amount") or 0) if isinstance(data, dict) else 0.0
    except (TypeError, ValueError):
        return 0.0
    # «NaN», «inf» и цена вне разумного — не цена: лучше без долларов.
    return p if math.isfinite(p) and 1000 < p < 10_000_000 else 0.0


def _spot() -> float:
    """Открытая цена Coinbase — раз в минуту на весь модуль. Раньше, пока
    сканер стоял, каждая сборка (поток, рейтинг, каждая карточка кошелька)
    шла к Coinbase сама; ответ не проверялся — список вместо объекта ронял
    сборку, «NaN» уходил в доллары."""
    return cast(float, cached_small(_BTC, "spot", 60.0, _spot_fetch))


def _btc_flow_build() -> Json:
    con = _btc_open()
    if not con:
        return {"ok": False, "error": "no_data"}
    try:
        t = now()
        px = _btc_price(con)
        first = con.execute("SELECT MIN(ts) FROM btc_flow").fetchone()[0]
        tip = con.execute("SELECT height, ts FROM btc_blocks ORDER BY height DESC LIMIT 1").fetchone()
        labels = con.execute("SELECT COUNT(*) FROM btc_labels").fetchone()[0]
        wins = {}
        for key, sec in BTC_FLOW_WINS.items():
            since = t - sec
            by_ex = con.execute(
                "SELECT ex, SUM(in_sats) i, SUM(out_sats) o, SUM(in_n) ni, SUM(out_n) no "
                "FROM btc_flow WHERE ts >= ? GROUP BY ex", (since,)).fetchall()
            tin = sum(int(r["i"] or 0) for r in by_ex) / 1e8
            tout = sum(int(r["o"] or 0) for r in by_ex) / 1e8
            # Линия накопленного чистого вывода: ноль в начале окна, дальше
            # «столько ушло с бирж к этому моменту». Как у NetFlow монет.
            # Окно длиннее, чем работает сканер, — линия строится от первого
            # блока, а не от начала окна. Иначе месяц из полудня данных был
            # плоской чертой с обрывом в самом конце.
            start = max(since, int(first or since))
            arr = [0.0] * TREND_BUCKETS
            step = max(1, (t - start) // TREND_BUCKETS)
            for r in con.execute(
                    "SELECT (ts - ?) / ? b, SUM(out_sats - in_sats) n FROM btc_flow "
                    "WHERE ts >= ? GROUP BY b", (start, step, since)):
                arr[min(TREND_BUCKETS - 1, max(0, int(r["b"] or 0)))] += int(r["n"] or 0) / 1e8
            tr, run = [0.0], 0.0
            for v in arr:
                run += v
                tr.append(round(run, 4))
            ex = sorted(
                ({"ex": r["ex"], "in": round(int(r["i"] or 0) / 1e8, 4), "out": round(int(r["o"] or 0) / 1e8, 4)}
                 for r in by_ex),
                key=lambda e: -(e["in"] + e["out"]))
            wins[key] = {
                "in": round(tin, 4), "out": round(tout, 4), "net": round(tout - tin, 4),
                "nin": sum(int(r["ni"] or 0) for r in by_ex), "nout": sum(int(r["no"] or 0) for r in by_ex),
                # Все биржи, какие сканер видел за окно: список в приложении
                # сворачивается, отрезать хвост здесь незачем.
                "ex": ex, "tr": tr,
                # Окно длиннее, чем сканер работает, — сумма неполная, и
                # экран должен это сказать, а не выдать её за месячную.
                "full": bool(first and first <= since + 600),
            }
        return {
            "ok": True, "price": round(px, 2), "since": int(first or 0),
            "height": int(tip["height"]) if tip else 0, "at": int(tip["ts"]) if tip else 0,
            "labels": int(labels or 0), "wins": wins,
        }
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] btc flow: {e}\n")
        return {"ok": False, "error": "db"}
    finally:
        con.close()


def btc_flow() -> Json:
    return cached_bg(_BTC, "flow", BTC_TTL, _btc_flow_build)


def _btc_big_build(win: str, side: str, min_btc: float, ex: str = "") -> Json:
    con = _btc_open()
    if not con:
        return {"ok": False, "error": "no_data"}
    try:
        since = now() - BIG_WINDOWS[win] * 3600
        kind = 1 if side == "buy" else 2
        floor = round(min_btc * 1e8)
        # Все кошельки сети, без деления на «базу»: база — те же выводы от
        # 0,2 BTC, только меньше, и переключатель лишь повторял список. Свои
        # кошельки помечены в строках (base, звёздочка в приложении).
        #
        # Только движения с биржей: перевод между частными кошельками
        # покупкой не является. И без транзита: кто за то же окно вернул на
        # биржи почти всё выведенное (или наоборот), тот гоняет монеты, а не
        # копит и не продаёт.
        flows = ("WITH w AS (SELECT wallet, "
                 "SUM(CASE WHEN kind = 1 THEN sats ELSE 0 END) b, "
                 "SUM(CASE WHEN kind = 2 THEN sats ELSE 0 END) s "
                 "FROM btc_moves WHERE ts >= ? AND ex != '' GROUP BY wallet) ")
        cond = _btc_clean(con)
        join, lead = "JOIN w ON w.wallet = m.wallet ", (since,)
        keep = {1: "w.s < 0.9 * w.b", 2: "w.b < 0.9 * w.s"}
        where = (f"m.ts >= ? AND m.kind = ? AND m.ex != '' AND m.sats >= ? AND {keep[kind]} AND {cond}"
                 + (" AND m.ex = ?" if ex else ""))
        exa = (ex,) if ex else ()
        # Строка — кошелёк и биржа за окно, а не каждая транзакция: кошелёк,
        # который шесть раз завёл по 62 BTC, раньше занимал шесть одинаковых
        # строк и читался дублями. Теперь одна строка «×6» с суммой, ценой
        # по средней и ссылкой на самую крупную транзакцию.
        # Доллары — TOTAL (дробное), а не SUM: в нано-долларах месяц покупок
        # (десятки миллиардов долларов) больше предела целого SQLite, и SUM
        # падал «integer overflow» — окно «30 дней» не открывалось совсем.
        rows = con.execute(
            flows + f"SELECT m.wallet, m.ex, SUM(m.sats) sats, TOTAL(m.usd_nanos) usd_nanos, "
            f"SUM(CASE WHEN m.price_nanos > 0 THEN m.sats ELSE 0 END) psats, "
            f"COUNT(*) n, MAX(m.ts) ts, MAX(m.sats) top, "
            f"(SELECT m2.txid FROM btc_moves m2 WHERE m2.wallet = m.wallet AND m2.kind = m.kind "
            f" AND m2.ex = m.ex AND m2.ts >= ? ORDER BY m2.sats DESC LIMIT 1) txid "
            f"FROM btc_moves m {join}WHERE {where} "
            f"GROUP BY m.wallet, m.ex ORDER BY sats DESC, ts DESC LIMIT ?",
            (*lead, since, since, kind, floor, *exa, BTC_ROWS)).fetchall()
        # Итоги обеих сторон и суммы по биржам — одним проходом, а не тремя:
        # за 30 дней каждый проход — секунды, и первый запрос окна не
        # укладывался в 15 секунд, которые ждёт приложение.
        agg = con.execute(
            flows + f"SELECT m.kind, m.ex, COUNT(*) n, COUNT(DISTINCT m.wallet) w, SUM(m.sats) s, "
            f"TOTAL(m.usd_nanos) u FROM btc_moves m {join}"
            f"WHERE m.ts >= ? AND m.ex != '' AND m.sats >= ? AND {cond} "
            f"AND ((m.kind = 1 AND {keep[1]}) OR (m.kind = 2 AND {keep[2]})) "
            f"GROUP BY m.kind, m.ex", (*lead, since, floor)).fetchall()
        tot = {}
        for k, name in ((1, "buy"), (2, "sell")):
            # Фильтр по бирже — у итога, как у списка.
            mine = [r for r in agg if r["kind"] == k and (not ex or r["ex"] == ex)]
            tot[name] = {"n": sum(int(r["n"] or 0) for r in mine),
                         "btc": round(sum(int(r["s"] or 0) for r in mine) / 1e8, 4),
                         "v": round(sum(int(r["u"] or 0) for r in mine) / 1e9, 2)}
        # Через какие биржи: сумма по бирже на выбранной стороне — сколько
        # движений, монет, долларов и сколько разных кошельков. Всегда полный
        # список: из него приложение рисует кнопки фильтра.
        by_ex = sorted(
            ({"ex": r["ex"], "n": int(r["n"] or 0), "w": int(r["w"] or 0),
              "btc": round(int(r["s"] or 0) / 1e8, 4), "v": round(int(r["u"] or 0) / 1e9, 2)}
             for r in agg if r["kind"] == kind),
            key=lambda e: -e["btc"])
        extra = _btc_extra(con, sorted({r["wallet"] for r in rows}))
        first = con.execute("SELECT MIN(ts) FROM btc_flow").fetchone()[0]
        # Время последнего записанного блока: по нему видно, что сканер
        # стоит (дайджест тогда не публикует раздел биткоина).
        tip = con.execute("SELECT ts FROM btc_blocks ORDER BY height DESC LIMIT 1").fetchone()
        return {
            "ok": True, "win": win, "side": side, "min": min_btc, "ex": ex,
            "tot": tot, "byEx": by_ex, "at": int(tip["ts"]) if tip else 0,
            "full": bool(first and first <= since + 600), "since": int(first or 0),
            "rows": [{"tx": r["txid"], "t": int(r["ts"]), "a": r["wallet"], "ex": r["ex"], "n": int(r["n"]),
                      "btc": round(int(r["sats"]) / 1e8, 4), "v": round(int(r["usd_nanos"]) / 1e9, 2),
                      # Цена — средняя по строке: доллары на монеты с ценой.
                      # Движение без цены (Coinbase и Kraken не ответили)
                      # долларов не дало — в делителе его монет нет, иначе
                      # средняя занижалась бы вдвое.
                      "px": round(int(r["usd_nanos"]) / 1e9 / (int(r["psats"]) / 1e8), 2) if r["psats"] else 0,
                      **extra.get(r["wallet"], {})}
                     for r in rows],
        }
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] btc big: {e}\n")
        return {"ok": False, "error": "db"}
    finally:
        con.close()


def _btc_ex_names() -> frozenset[str]:
    """Имена бирж из разметки сканера — раз в 10 минут."""
    def build() -> frozenset[str]:
        con = _btc_open()
        if not con:
            return frozenset()
        try:
            return frozenset(r[0] for r in con.execute("SELECT DISTINCT ex FROM btc_labels"))
        except sqlite3.Error:
            return frozenset()
        finally:
            con.close()
    names = cast("frozenset[str]", cached_small(_BTC, "ex_names", 600.0, build))
    # Пустой список — база не прочиталась (разметка бирж пустой не бывает):
    # его не держим десять минут, иначе фильтр по бирже всё это время молча
    # не работал бы. Следующий запрос прочитает заново.
    if not names:
        _BTC.pop("ex_names", None)
    return names


def btc_big_ttl(win: str) -> float:
    # Неделя и месяц — раз в пять минут: сборка — секунды, а за пять минут
    # такой список заметно не меняется. Короткие окна — раз в минуту.
    return 300.0 if win in ("7d", "30d") else BTC_TTL


def btc_big(win: str, side: str, min_btc: float, ex: str = "") -> Json:
    win = win if win in BIG_WINDOWS else "24h"
    side = "sell" if side == "sell" else "buy"
    min_btc = min_btc if min_btc in BTC_BIG_MIN else BTC_BIG_MIN[0]
    # Имя биржи — только из разметки сканера: любая строка до 40 знаков
    # была своим ключом кэша и своей сборкой по всей базе — тысяча разных
    # «бирж» тысячу раз гоняла тяжёлый запрос. Чужое имя — без фильтра.
    ex = (ex or "").strip()[:40]
    if ex and ex not in _btc_ex_names():
        ex = ""
    return cached_bg(_BTC, ("big", win, side, min_btc, ex), btc_big_ttl(win),
                     lambda: _btc_big_build(win, side, min_btc, ex))


def _btc_book(moves: list[tuple[int, int, int, int, str]], px: float) -> Json | None:
    """Итог кошелька по его выводам и заводам, по средней цене.

    Вывод с биржи — покупка по цене блока: запас растёт, растёт и вложенное.
    Завод — продажа: из запаса уходит по средней цене, разница с ценой блока
    — зафиксированный результат. Заводов больше, чем выводов, — монеты
    куплены раньше, чем начал смотреть сканер, их цены не знает никто;
    такой излишек в результат не идёт.

    «В плюсе» — доля выводов, купленных дешевле нынешней цены: у кита,
    который копит, продаж может не быть вовсе, а вопрос «удачно ли он
    заходил» остаётся.
    """
    held = cost = realized = invested = bought = sold = 0.0
    buys = sells = good = 0
    exs: dict[str, float] = {}
    days = set()
    first = last = 0
    for kind, sats, price, ts, ex in moves:
        q = sats / 1e8
        p = price / 1e9
        days.add(ts // 86400)
        first = first or ts
        last = ts
        exs[ex] = exs.get(ex, 0.0) + q
        if kind == 1:
            buys += 1
            bought += q
            held += q
            cost += q * p
            invested += q * p
            if p and p < px:
                good += 1
        else:
            sells += 1
            sold += q
            if held > 0:
                s = min(q, held)
                avg = cost / held
                realized += s * (p - avg)
                cost -= s * avg
                held -= s
    if not buys or not invested:
        return None
    pnl = realized + (held * px - cost if px else 0.0)
    return {
        # «+ 0.0» убирает минус у нуля: «-0,0%» выглядело убытком.
        "pnl": round(pnl, 2) + 0.0, "roi": round(pnl / invested * 100, 2) + 0.0,
        "win": round(good / buys * 100), "tr": buys + sells, "buys": buys, "sells": sells,
        "btc": round(held, 4), "bought": round(bought, 4), "sold": round(sold, 4),
        "avg": round(invested / bought, 2) if bought else 0, "inv": round(invested, 2),
        "ex": max(exs, key=lambda k: exs[k]) if exs else "", "days": len(days), "first": first, "last": last,
    }


def _btc_rank_build(days: int) -> Json:
    con = _btc_open()
    if not con:
        return {"ok": False, "error": "no_data"}
    try:
        px = _btc_price(con)
        since = now() - days * 86400
        # Доски — первые BTC_ROWS по своему ключу. В памяти — только они, а
        # не итоги всех кошельков: за год это сотни тысяч записей, и сервер
        # с малой памятью мог её исчерпать. Порядок — как у sorted по
        # убыванию ключа, при равенстве раньше встреченный выше (-номер).
        n = 0
        tops: dict[str, list[tuple[tuple[float, float, int], Json]]] = {"pnl": [], "roi": [], "act": []}
        order = {"pnl": ("pnl", "btc"), "roi": ("roi", "btc"), "act": ("btc", "pnl")}

        def keep(book: Json) -> None:
            nonlocal n
            n += 1
            for name, (k1, k2) in order.items():
                item = ((book[k1], book[k2], -n), book)
                top = tops[name]
                if len(top) < BTC_ROWS:
                    heapq.heappush(top, item)
                elif item[0] > top[0][0]:
                    heapq.heapreplace(top, item)

        cur_w: str | None = None
        moves: list[tuple[int, int, int, int, str]] = []
        # Только движения с биржей. Перевод на свой холодный кошелёк — не
        # продажа, пополнение со своего — не покупка: у кошельков базы такие
        # строки есть (там пишется всё), и раньше они превращались в сделки
        # по рыночной цене, а PnL — в выдумку.
        rows = con.execute(
            f"SELECT wallet, kind, sats, price_nanos, ts, ex FROM btc_moves m "
            f"WHERE ts >= ? AND price_nanos > 0 AND m.ex != '' AND {_btc_clean(con)} "
            f"ORDER BY wallet, ts, id", (since,))
        for r in rows:
            if r["wallet"] != cur_w:
                if cur_w and moves:
                    b = _btc_book(moves, px)
                    if b:
                        keep({"a": cur_w, **b})
                cur_w, moves = r["wallet"], []
            moves.append((int(r["kind"]), int(r["sats"]), int(r["price_nanos"]), int(r["ts"]), r["ex"] or ""))
        if cur_w and moves:
            b = _btc_book(moves, px)
            if b:
                keep({"a": cur_w, **b})
        first = con.execute("SELECT MIN(ts) FROM btc_flow").fetchone()[0]
        boards = {name: [b for _, b in sorted(top, key=lambda x: x[0], reverse=True)] for name, top in tops.items()}
        extra = _btc_extra(con, sorted({b["a"] for board in boards.values() for b in board}))
        for board in boards.values():
            for b in board:
                b.update(extra.get(b["a"], {}))
        return {
            "ok": True, "days": days, "price": round(px, 2), "n": n,
            "full": bool(first and first <= since + 600), "since": int(first or 0),
            **boards,
        }
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] btc rank: {e}\n")
        return {"ok": False, "error": "db"}
    finally:
        con.close()


def btc_rank_ttl(days: int) -> float:
    # Месяц — раз в две минуты, длинные окна — раз в десять: там год движений
    # базы, а за десять минут доска заметно не меняется.
    return 120.0 if days <= 30 else 600.0


def warm_jobs() -> list[tuple[dict[Any, Any], Any, float, Callable[[], Json]]]:
    """Что exflow_warmer в whale_api собирает заранее и по кругу: поток бирж
    и рейтинг за все окна — запрос из приложения не ждёт сборки."""
    jobs: list[tuple[dict[Any, Any], Any, float, Callable[[], Json]]] = [(_BTC, "flow", BTC_TTL, _btc_flow_build)]
    jobs += [(_BTC, ("rank", d), btc_rank_ttl(d), functools.partial(_btc_rank_build, d)) for d in BTC_RANK_DAYS]
    # Крупные ордера — каждое окно и сторона с порогом по умолчанию: первый
    # взгляд на вкладку не ждёт сборки (раньше окно «30 дней» не успевало, и
    # экран писал «пока пусто»). Пороги выше и фильтр биржи — по запросу.
    jobs += [(_BTC, ("big", w, side, BTC_BIG_MIN[0], ""), btc_big_ttl(w),
              functools.partial(_btc_big_build, w, side, BTC_BIG_MIN[0], ""))
             for w in BIG_WINDOWS for side in ("buy", "sell")]
    return jobs


def btc_rank(days: int) -> Json:
    days = days if days in BTC_RANK_DAYS else 30
    return cached_bg(_BTC, ("rank", days), btc_rank_ttl(days), lambda: _btc_rank_build(days))


def _btc_wallet_build(addr: str) -> Json:
    con = _btc_open()
    if not con:
        return {"ok": False, "error": "no_data"}
    try:
        px = _btc_price(con)
        lab = con.execute("SELECT ex FROM btc_labels WHERE address = ?", (addr,)).fetchone()
        # Последние WALLET_MOVES_MAX движений, а не вся история: у адреса
        # биржи или сервиса без разметки их десятки тысяч, и каждое открытие
        # такой карточки (любым, кто знает адрес) читало их все.
        rows = con.execute(
            "SELECT txid, kind, sats, usd_nanos, price_nanos, ts, ex FROM btc_moves "
            "WHERE wallet = ? ORDER BY ts DESC, id DESC LIMIT ?", (addr, WALLET_MOVES_MAX)).fetchall()
        rows.reverse()
        # Итог — по движениям с биржей, как в рейтинге; переводы видны в
        # списке ниже, но сделками не считаются.
        book = _btc_book([(int(r["kind"]), int(r["sats"]), int(r["price_nanos"]), int(r["ts"]), r["ex"] or "")
                          for r in rows if int(r["price_nanos"] or 0) > 0 and r["ex"]], px)
        return {
            "ok": True, "addr": addr, "price": round(px, 2), "ex": lab["ex"] if lab else "",
            "book": book, **_btc_extra(con, [addr])[addr],
            "moves": [{"tx": r["txid"], "buy": int(r["kind"]) == 1, "btc": round(int(r["sats"]) / 1e8, 4),
                       "v": round(int(r["usd_nanos"]) / 1e9, 2), "px": round(int(r["price_nanos"]) / 1e9, 2),
                       "t": int(r["ts"]), "ex": r["ex"]} for r in reversed(rows[-50:])],
        }
    except sqlite3.Error as e:
        sys.stderr.write(f"[api] btc wallet: {e}\n")
        return {"ok": False, "error": "db"}
    finally:
        con.close()


def btc_wallet(addr: str) -> Json:
    return cast(Json, cached_small(_BTC, ("wallet", addr), BTC_TTL, lambda: _btc_wallet_build(addr)))
