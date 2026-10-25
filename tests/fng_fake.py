"""Выдуманные источники для тестов «Страха и жадности» (не тест — помощник).

Чужих данных в репозитории нет (tests/fixtures/NOTICE.md): индекс и цена —
формулы, а не копия alternative.me и mempool.space. Формат ответов — их:
  - индекс — {"data": [{"value": "54", "timestamp": "…"}, …]}, новые дни
    первыми, значения и время — строки, два дня пропущены (как в апреле 2018);
  - история цен — {"prices": [{"time": …, "USD": …}, …]}, новые первыми; как
    у mempool: сначала недельные свечи (точка четверга в 00:00 — цена через 7
    дней), потом дневные (точка в 00:00 — цена через сутки) и снимки в 13:00,
    потом — по часам, и первые дни среди них в 00:00 ещё стоят свечи;
  - текущая цена — {"time": …, "USD": …}.
Цена — гладкая формула price(t): закрытие любого дня известно точно, и тест
сверяет с ним то, что собрал модуль.
"""
import json
import math

DAY = 86_400
HOUR = 3600
START = 1_517_443_200  # 2018-02-01, четверг
DAYS = 1400
# «Сейчас» — середина последнего дня индекса.
NOW = START + (DAYS - 1) * DAY + 16 * HOUR + 1234
TODAY = NOW // DAY * DAY
# Где кончаются недельные свечи и начинаются дневные; где начинаются часы;
# сколько первых суток среди часов в 00:00 ещё свеча.
WEEKLY_TO = START + 600 * DAY
HOURLY_FROM = START + 900 * DAY + 2 * HOUR
CANDLES_AMONG_HOURS = 5
# Дни без индекса (как у alternative.me: 4 дня в 2018, 2 — в 2024).
GAPS = (START + 70 * DAY, START + 71 * DAY, START + 1000 * DAY)


def price(t: float) -> float:
    """Цена в момент t: рост и волны на неделях — сутки двигают её на проценты, час — на доли."""
    d = (t - START) / DAY
    return 8000 * math.exp(0.0012 * d + 0.25 * math.sin(d / 9) + 0.04 * math.sin(d * 1.3))


def index_value(t: int) -> int:
    d = (t - START) // DAY
    return max(0, min(100, round(50 + 35 * math.sin(d / 23) + 12 * math.sin(d / 3.1))))


def index_rows() -> list[dict]:
    rows = [{"value": str(index_value(t)), "value_classification": "x", "timestamp": str(t)}
            for t in range(START, TODAY + DAY, DAY) if t not in GAPS]
    rows[-1]["time_until_update"] = "26000"
    return rows[::-1]


def index_body() -> bytes:
    return json.dumps({"name": "Fear and Greed Index", "data": index_rows(), "metadata": {"error": None}}).encode()


def is_thursday(t: int) -> bool:
    return t // DAY % 7 == 0


def history_points() -> list[dict]:
    pts: dict[int, float] = {}
    # Недельные свечи — с запасом до START (как у mempool, с 2010 года).
    t = START - 8 * 7 * DAY
    while t < WEEKLY_TO:
        pts[t] = round(price(t + 7 * DAY), 1)
        t += 7 * DAY
    # Дневные свечи и снимки в 13:00; по четвергам в 00:00 — недельная свеча.
    for t in range(WEEKLY_TO, HOURLY_FROM - 2 * HOUR, DAY):
        pts[t] = round(price(t + 7 * DAY) if is_thursday(t) else price(t + DAY), 1)
        pts[t + 13 * HOUR] = round(price(t + 13 * HOUR))
    # По часам; первые сутки в 00:00 — ещё свечи.
    t = HOURLY_FROM
    while t <= NOW - HOUR:
        day0 = t % DAY == 0
        if day0 and t < HOURLY_FROM + CANDLES_AMONG_HOURS * DAY:
            pts[t] = round(price(t + (7 * DAY if is_thursday(t) else DAY)), 1)
        else:
            pts[t] = round(price(t))
        t += HOUR
    return [{"time": k, "USD": v} for k, v in sorted(pts.items(), reverse=True)]


def history_body() -> bytes:
    return json.dumps({"prices": history_points(), "exchangeRates": {"USDEUR": 0.9}}).encode()


def live_body() -> bytes:
    return json.dumps({"time": NOW - 60, "USD": round(price(NOW - 60)), "EUR": 1}).encode()


def network(over: dict | None = None):
    """Подмена wt_fng._fetch: ответ по адресу; over — свои ответы (None — молчит)."""
    bodies = {"alternative.me": index_body(), "historical-price": history_body(), "/v1/prices": live_body()}
    calls: list[str] = []

    def fetch(url: str, limit: int) -> bytes | None:
        calls.append(url)
        for k, body in bodies.items():
            if k in url:
                if over is not None and k in over:
                    return over[k]
                return body if len(body) <= limit else None
        return None

    fetch.calls = calls  # type: ignore[attr-defined]
    return fetch
