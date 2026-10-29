"""Картинка выпуска дайджеста на сервере — для автопостинга в Telegram-канал.

Канал получает выпуск без человека, поэтому сервер рисует картинки сам —
Pillow и шрифт IBM Plex Sans (fonts/, лицензия OFL), макет 1080×1350, слова
из tools/i18n.json и тот же формат чисел, что в приложении. Логика выводов —
копия digestLines/verdictOf/sigValue из src/screens/DigestMore.tsx: поменял
там — поменяй и здесь (tools/guard.py следит за ключами).

Pillow не обязателен для всего остального API: нет его — render() отдаёт
None, и канал получает выпуск текстом (caption()).
"""
from __future__ import annotations

import io
import json
from decimal import ROUND_HALF_UP, Decimal
import os
import re
import time

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # канал получит текст вместо картинки
    Image = ImageDraw = ImageFont = None  # type: ignore[assignment]

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, PAD = 1080, 1350, 72
C = {
    "bg0": (4, 9, 18), "bg1": (10, 24, 48), "ink": (234, 245, 255), "dim": (124, 151, 188), "glow": (127, 216, 255),
    "up": (61, 220, 151), "dn": (255, 92, 119), "mix": (240, 185, 11), "line": (26, 52, 88), "panel": (12, 26, 46),
}
BOT_AT = "@WalletTrackerAppBot"
# Потоки ETF — открытый набор TFTC (CC BY 4.0): условие — подпись источника со
# ссылкой и лицензией рядом с цифрами — на картинке и в подписи к посту.
TFTC_BY = "TFTC — tftc.io/bitcoin-etf-flows (CC BY 4.0)"
# Чьи данные о блоках в строке халвинга (wt_halving.HOSTS): только эти имена.
HALVING_BY = ("mempool.space", "blockstream.info", "blockchain.info")
# В подписи к посту — со ссылкой на текст лицензии: CC BY 4.0 (п. 3(a)(1)(C))
# требует не только название, но и адрес лицензии. На картинке ссылки не
# нажимаются — там короткая строка, полная идёт в подписи к тому же посту.
TFTC_BY_POST = "TFTC — https://www.tftc.io/bitcoin-etf-flows (CC BY 4.0: https://creativecommons.org/licenses/by/4.0/)"

_I18N: dict = {}


def tr(lang: str, key: str, **kw) -> str:
    """Строка словаря приложения с подстановкой {x}."""
    if not _I18N:
        try:
            with open(os.path.join(HERE, "tools", "i18n.json"), encoding="utf-8") as f:
                _I18N.update(json.load(f))
        except (OSError, ValueError):
            pass
    box = _I18N.get(key) or {}
    s = box.get(lang) or box.get("en") or key
    for k, v in kw.items():
        s = s.replace("{" + k + "}", str(v))
    return s


# --- Числа: как Intl.NumberFormat у приложения ------------------------------

def _dot_lang(lang: str) -> bool:
    return lang in ("en", "ja", "ko", "zh", "hi")


def nf(v: float, max_d: int, lang: str, min_d: int = 0) -> str:
    # Половинки — вверх, как у Intl в приложении: 1346,5 → 1347, а не 1346
    # «к чётному», как округляет сам Python.
    q = Decimal(str(abs(v))).quantize(Decimal(1).scaleb(-max_d), rounding=ROUND_HALF_UP)
    s = f"{q:,.{max_d}f}"
    whole, _, frac = s.partition(".")
    frac = frac.rstrip("0")
    if len(frac) < min_d:
        frac = frac + "0" * (min_d - len(frac))
    if _dot_lang(lang):
        out = whole + ("." + frac if frac else "")
    else:
        out = whole.replace(",", " ") + ("," + frac if frac else "")
    return ("-" if v < 0 and float(s.replace(",", "")) != 0 else "") + out


def usd(v: float, lang: str, sign: bool = False) -> str:
    a = abs(v)
    s = "-" if v < 0 else "+" if sign and v > 0 else ""
    if a >= 1e9:
        return f"{s}${nf(a / 1e9, 2, lang)}B"
    if a >= 1e6:
        return f"{s}${nf(a / 1e6, 2, lang)}M"
    if a >= 1e3:
        return f"{s}${nf(a / 1e3, 1, lang)}K"
    return f"{s}${nf(a, 4 if a < 1 else 2, lang)}"


def pct(v: float, lang: str, digits: int = 1, sign: bool = True) -> str:
    d = 0 if abs(v) >= 100 else digits
    return ("+" if sign and v > 0 else "") + nf(v, d, lang, d) + "%"


def px(v: float, lang: str) -> str:
    a = abs(v)
    d = 0 if a >= 10000 else 2 if a >= 1000 else 3 if a >= 1 else 5 if a >= 0.01 else 8
    return "$" + nf(v, d, lang)


def num(v: float, lang: str, digits: int = 0) -> str:
    return nf(v, digits, lang)


def btc_amt(v: float, lang: str, sign: bool = False) -> str:
    return ("+" if sign and v > 0 else "") + num(v, lang, 0 if abs(v) >= 100 else 2) + " BTC"


_MONTHS = {
    "ru": ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
    "uk": ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"],
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    "de": ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    "pt": ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
    "pl": ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"],
    "tr": ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"],
    "id": ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"],
    "hi": ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"],
    "ar": ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
}


def date_word(lang: str, ts: int, year: bool = True) -> str:
    """Дата словами на языке человека: «16 октября 2026 г.», «16. Oktober 2026»,
    «2026年10月16日»; без года (year=False) — для строк календаря."""
    g = time.gmtime(ts)
    d, m, y = g.tm_mday, g.tm_mon, g.tm_year
    if lang in ("ja", "zh"):
        return f"{y}年{m}月{d}日" if year else f"{m}月{d}日"
    if lang == "ko":
        return f"{y}년 {m}월 {d}일" if year else f"{m}월 {d}일"
    if lang == "vi":
        return f"{d} tháng {m} năm {y}" if year else f"{d} tháng {m}"
    if lang not in _MONTHS:
        return date_word("en", ts, year)
    name = _MONTHS[lang][m - 1]
    if lang == "en":
        return f"{name} {d}, {y}" if year else f"{name} {d}"
    day = f"{d}. {name}" if lang == "de" else f"{d} de {name}" if lang in ("es", "pt") else f"{d} {name}"
    if not year:
        return day
    if lang in ("ru", "uk"):
        return f"{day} {y} {'г.' if lang == 'ru' else 'р.'}"
    return f"{day} de {y}" if lang in ("es", "pt") else f"{day} {y}"


# --- Выводы: копия DigestMore.tsx --------------------------------------------

SIG_KEY = {"fng": "dg_sig_fng", "etf": "dg_sig_etf", "btcx": "dg_sig_btcx", "whales": "dg_sig_whales",
           "liq": "dg_sig_liq", "oi": "dg_sig_oi", "fund": "dg_sig_fund", "pcr": "dg_sig_pcr"}
FNG_ZONES = ((25, "fg_z0"), (46, "fg_z1"), (54, "fg_z2"), (75, "fg_z3"), (100, "fg_z4"))


def sig_value(s: dict, lang: str) -> str:
    k, v = s["k"], s["v"]
    if k == "fng":
        return num(v, lang)
    if k in ("etf", "whales"):
        return usd(v, lang, True)
    if k == "btcx":
        return btc_amt(v, lang, True)
    if k == "liq":
        return num(v, lang) + "%"
    if k == "oi":
        return pct(v, lang, 1)
    if k == "fund":
        return pct(v, lang, 4)
    return num(v, lang, 2)


def sigs(it: dict) -> list:
    """Сигналы выпуска, которые мы ещё показываем: у старых выпусков были и
    снятые (премия Coinbase — её условия запрещают показывать их данные)."""
    return [s for s in it.get("sig") or [] if isinstance(s, dict) and s.get("k") in SIG_KEY]


def verdict(it: dict, lang: str) -> tuple[str, str] | None:
    sig = sigs(it)
    if not sig:
        return None
    up = sum(1 for s in sig if s["d"] > 0)
    dn = sum(1 for s in sig if s["d"] < 0)
    n = len(sig)
    if up > n / 2:
        return "up", tr(lang, "dg_v_bull", b=up, n=n)
    if dn > n / 2:
        return "dn", tr(lang, "dg_v_bear", s=dn, n=n)
    return "mix", tr(lang, "dg_v_mix", b=up, s=dn)


def _tone(v: float) -> str | None:
    return "up" if v > 0 else "dn" if v < 0 else None


def lines(it: dict, lang: str) -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    m = it.get("mkt") or {}
    if m.get("btc"):
        zone = next((z for mx, z in FNG_ZONES if m.get("fng") and m["fng"]["v"] <= mx), None)
        # Условие alternative.me: источник индекса — рядом с ним.
        z = f"{tr(lang, zone)}: {m['fng']['v']} (alternative.me)" if zone else "—"
        out.append((tr(lang, "dg_l_mkt", p=px(m["btc"]["px"], lang), c=pct(m["btc"]["ch"], lang, 2), z=z), _tone(m["btc"]["ch"])))
    q = it.get("liq") or {}
    if q.get("n"):
        L, S = q["L"], q["S"]
        ratio = max(L / S, S / L) if L > 0 and S > 0 else 0
        x = num(ratio, lang, 1)
        w = tr(lang, "lqs_v_eq") if ratio < 1.25 and L > 0 and S > 0 else tr(lang, "lqs_v_long" if L > S else "lqs_v_short", x=x)
        out.append((tr(lang, "dg_l_liq", v=usd(L + S, lang), w=w), "up" if S > L else "dn"))
    b = (it.get("oi") or {}).get("btc") or {}
    if b.get("ch") is not None and b.get("pch") is not None:
        ch, pch = b["ch"], b["pch"]
        key = "oih_q_flat" if abs(ch) < 1 else ("oih_q_up_up" if pch >= 0 else "oih_q_up_dn") if ch > 0 else (
            "oih_q_dn_up" if pch >= 0 else "oih_q_dn_dn")
        out.append((tr(lang, "dg_l_oi", w=tr(lang, key, oi=pct(ch, lang, 1), p=pct(pch, lang, 1))), None))
    o = (it.get("opt") or {}).get("btc") or {}
    if o:
        r = o.get("pcr")
        mood = "op_mood_eq" if r is None else "op_mood_up" if r < 0.7 else "op_mood_dn" if r > 1 else "op_mood_eq"
        out.append((tr(lang, "dg_l_opt", n=usd(o["n"], lang), w=tr(lang, mood)),
                    "up" if r is not None and r < 0.7 else "dn" if r is not None and r > 1 else None))
    e = next((x for x in (it.get("inst") or {}).get("etf") or [] if x["c"] == "btc"), None)
    if e:
        if abs(e["v"]) < 1e6:
            out.append((tr(lang, "dg_l_etf_flat"), None))
        elif e["v"] > 0:
            out.append((tr(lang, "dg_l_etf_in", v=usd(e["v"], lang)), "up"))
        else:
            out.append((tr(lang, "dg_l_etf_out", v=usd(-e["v"], lang)), "dn"))
    n = (it.get("btc") or {}).get("net")
    if n is not None:
        out.append((tr(lang, "dg_l_btcx_out", v=btc_amt(n, lang)), "up") if n >= 0
                   else (tr(lang, "dg_l_btcx_in", v=btc_amt(-n, lang)), "dn"))
    return out


# --- Рисунок -----------------------------------------------------------------

def _font(weight: str, size: int):
    return ImageFont.truetype(os.path.join(HERE, "fonts", f"IBMPlexSans-{weight}.ttf"), size)


def _wrap(d, text: str, font, width: int, max_lines: int) -> list[str]:
    words, out, cur = text.split(), [], ""
    for w in words:
        nxt = f"{cur} {w}" if cur else w
        if d.textlength(nxt, font=font) <= width or not cur:
            cur = nxt
        else:
            out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    if len(out) > max_lines:
        out = out[:max_lines]
        last = out[-1]
        while last and d.textlength(last + "…", font=font) > width:
            last = last[:-1]
        out[-1] = last.rstrip() + "…"
    return out


def _arrow(d, x: int, y: int, kind: str, color, size: int = 22) -> None:
    """▲ ▼ ● — фигурами, а не символами: не во всех шрифтах они есть.
    y — базовая линия строки, как у текста."""
    cy = y - size * 0.42
    h = size * 0.75
    if kind == "up":
        d.polygon([(x, cy + h / 2), (x + h, cy + h / 2), (x + h / 2, cy - h / 2)], fill=color)
    elif kind == "dn":
        d.polygon([(x, cy - h / 2), (x + h, cy - h / 2), (x + h / 2, cy + h / 2)], fill=color)
    else:
        r = h * 0.38
        d.ellipse([x + h / 2 - r, cy - r, x + h / 2 + r, cy + r], fill=color)


def render(it: dict, lang: str = "ru", page: str = "") -> bytes | None:
    """PNG 1080×1350 или None, если Pillow не установлен."""
    if Image is None:
        return None
    # Фон: вертикальный градиент (столбик в пиксель, растянутый вширь), сетка
    # и свечение справа сверху.
    col = Image.new("RGB", (1, H))
    for yy in range(H):
        k = yy / H
        col.putpixel((0, yy), tuple(int(C["bg1"][i] * (1 - k) + C["bg0"][i] * k) for i in range(3)))
    img = col.resize((W, H))
    d = ImageDraw.Draw(img, "RGBA")
    for x in range(0, W + 1, 54):
        d.line([(x, 0), (x, H)], fill=(58, 130, 214, 18))
    for y in range(0, H + 1, 54):
        d.line([(0, y), (W, y)], fill=(58, 130, 214, 18))
    gx, gy = W - 140, 120
    for r in range(520, 0, -20):
        a = int(56 * (1 - r / 520) ** 2)
        d.ellipse([gx - r, gy - r, gx + r, gy + r], fill=(30, 155, 255, max(0, min(a, 255)) // 8))

    def text(s: str, x: int, y: int, weight: str, size: int, color, anchor: str = "ls") -> None:
        d.text((x, y), s, font=_font(weight, size), fill=color, anchor=anchor)

    # Шапка.
    y = PAD
    d.rounded_rectangle([PAD, y, PAD + 56, y + 56], radius=14, outline=C["glow"], width=3)
    text("W", PAD + 28, y + 40, "Bold", 30, C["glow"], "ms")
    text("WALLET TRACKER", PAD + 76, y + 25, "Bold", 26, C["ink"])
    text(tr(lang, "dg_img_kicker"), PAD + 76, y + 54, "Medium", 22, C["dim"])
    if page:
        text(date_word(lang, int(it.get("to") or time.time())), W - PAD, y + 25, "SemiBold", 24, C["dim"], "rs")
        text(page, W - PAD, y + 56, "Bold", 22, C["glow"], "rs")
    else:
        text(date_word(lang, int(it.get("to") or time.time())), W - PAD, y + 40, "SemiBold", 26, C["dim"], "rs")

    # Заголовок и итог.
    y += 140
    text(tr(lang, "dg_img_title"), PAD, y, "Bold", 60, C["ink"])
    v = verdict(it, lang)
    if v:
        y += 64
        f = _font("Bold", 36)
        for ln in _wrap(d, v[1], f, W - 2 * PAD, 2):
            text(ln, PAD, y, "Bold", 36, C["up"] if v[0] == "up" else C["dn"] if v[0] == "dn" else C["mix"])
            y += 46

    # Табло сигналов.
    sig = sigs(it)[:9]
    if sig:
        y += 14
        row_h = 54
        box_h = len(sig) * row_h + 28
        d.rounded_rectangle([PAD, y, W - PAD, y + box_h], radius=22, fill=(127, 216, 255, 13), outline=(58, 130, 214, 56), width=2)
        ry = y + 14 + row_h // 2 + 10
        for s in sig:
            col = C["up"] if s["d"] > 0 else C["dn"] if s["d"] < 0 else C["dim"]
            _arrow(d, PAD + 30, ry, "up" if s["d"] > 0 else "dn" if s["d"] < 0 else "dot", col)
            label = tr(lang, SIG_KEY.get(s["k"], s["k"])) + {"fng": " · alternative.me", "etf": " · TFTC"}.get(s["k"], "")
            text(label, PAD + 72, ry, "Regular", 30, C["ink"])
            text(sig_value(s, lang), W - PAD - 30, ry, "Bold", 30, C["ink"] if s["d"] == 0 else col, "rs")
            ry += row_h
        y += box_h + 50

    # Главное.
    foot = H - PAD - 120
    text(tr(lang, "dg_img_main").upper(), PAD, y, "Bold", 22, C["glow"])
    y += 44
    f = _font("SemiBold", 29)
    for s, tone in lines(it, lang):
        rows = _wrap(d, s, f, W - 2 * PAD - 44, 2)
        if y + len(rows) * 38 > foot:
            break
        _arrow(d, PAD, y, tone or "dot", C["up"] if tone == "up" else C["dn"] if tone == "dn" else C["glow"], 22)
        for r in rows:
            text(r, PAD + 44, y, "SemiBold", 29, C["ink"])
            y += 38
        y += 16

    # Подвал: где нас найти.
    d.line([(PAD, H - PAD - 100), (W - PAD, H - PAD - 100)], fill=(58, 130, 214, 56), width=2)
    text(tr(lang, "dg_img_find"), PAD, H - PAD - 58, "Medium", 24, C["dim"])
    text(BOT_AT, PAD, H - PAD - 14, "Bold", 34, C["glow"])
    text(tr(lang, "dg_img_disc"), PAD, H - PAD + 22, "Regular", 18, (124, 151, 188, 180))

    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def caption(it: dict, lang: str = "ru") -> str:
    """Подпись к посту (и пост целиком, если Pillow нет): итог, выводы, бот."""
    parts = []
    v = verdict(it, lang)
    head = f"📊 {tr(lang, 'dg_img_title')} · {date_word(lang, int(it.get('to') or time.time()))}"
    parts.append(head)
    if v:
        parts.append(("🟢 " if v[0] == "up" else "🔴 " if v[0] == "dn" else "🟡 ") + v[1])
    ls = lines(it, lang)
    if ls:
        parts.append("\n".join(("▲ " if t == "up" else "▼ " if t == "dn" else "• ") + s for s, t in ls))
    if (it.get("inst") or {}).get("etf"):
        parts.append(f"{tr(lang, 'dg_etf_by')} {TFTC_BY_POST}")
    parts.append(BOT_AT)
    out = "\n\n".join(parts)
    # Подпись к фото в Telegram — до 1024 знаков: лишние выводы отрезаем.
    while len(out) > 1024 and ls:
        ls = ls[:-1]
        parts[2 if v else 1] = "\n".join(("▲ " if t == "up" else "▼ " if t == "dn" else "• ") + s for s, t in ls)
        out = "\n\n".join(parts)
    return out[:1024]



# --- Альбом для канала: весь выпуск на четырёх страницах ---------------------
#
# Канал получает не одну картинку, а альбом (листается как карусель):
#   1 — обложка: итог, табло, главные выводы (render() выше);
#   2 — фьючерсы и опционы; 3 — киты и потоки; 4 — неделя вперёд.
# Разделы идут по важности; что не влезло в страницу — отрезается целиком
# по строкам, а не наезжает на подвал.

# Названия макро-событий — копия MACRO из src/screens/CalendarScreen.tsx.
MACRO = [
    (r"^Core CPI", "cal_m_core_cpi"), (r"^CPI", "cal_m_cpi"), (r"^Core PPI", "cal_m_core_ppi"), (r"^PPI", "cal_m_ppi"),
    (r"ADP Non-?Farm", "cal_m_adp"), (r"Non-?Farm (Employment|Payrolls)", "cal_m_nfp"),
    (r"Unemployment Rate", "cal_m_unemp"), (r"Unemployment Claims|Jobless Claims", "cal_m_claims"),
    (r"Core PCE", "cal_m_core_pce"), (r"GDP", "cal_m_gdp"), (r"Retail Sales", "cal_m_retail"),
    (r"ISM Manufacturing", "cal_m_ism_m"), (r"ISM Services", "cal_m_ism_s"), (r"JOLTS", "cal_m_jolts"),
    (r"Consumer Sentiment|Consumer Confidence", "cal_m_sent"), (r"FOMC Meeting Minutes", "cal_m_minutes"),
    (r"Powell|Fed Chair", "cal_m_powell"), (r"FOMC Member|Fed .*Speaks", "cal_m_fedspeak"),
    (r"Durable Goods", "cal_m_durable"),
    (r"Main Refinancing Rate|Official Bank Rate|BOJ Policy Rate|Cash Rate|Overnight Rate|SNB Policy Rate|"
     r"Monetary Policy Statement|Interest Rate Decision|Policy Rate", "cal_m_rate"),
    (r"OPEC", "cal_m_opec"), (r"Bank Holiday", "cal_m_holiday"), (r"Auction", "cal_m_auction"),
    (r"Crude Oil Inventories", "cal_m_oil"), (r"Trade Balance", "cal_m_trade"), (r"PMI", "cal_m_pmi"),
    (r"Home Sales|Housing Starts|Building Permits|HPI", "cal_m_housing"), (r"Speaks|Testifies", "cal_m_speech"),
]
COUNTRY = {"USD": "cal_cc_usd", "EUR": "cal_cc_eur", "GBP": "cal_cc_gbp", "JPY": "cal_cc_jpy", "CNY": "cal_cc_cny",
           "CAD": "cal_cc_cad", "AUD": "cal_cc_aud", "NZD": "cal_cc_nzd", "CHF": "cal_cc_chf", "All": "cal_cc_all"}
_WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def cal_title(e: dict, lang: str) -> str:
    k = e.get("k")
    if k == "fomc":
        return tr(lang, "cal_fomc")
    if k in ("opt", "unl", "earn"):
        return tr(lang, f"cal_{k}", s=e.get("sym") or "")
    if k == "cme":
        return tr(lang, "cal_cme")
    title = e.get("title") or ""
    hit = next((key for rx, key in MACRO if re.search(rx, title, re.I)), None)
    return tr(lang, hit) if hit else title


def when_utc(e: dict, lang: str) -> str:
    """«Wed, Oct 14 · 12:30 UTC» — канал читают в разных поясах, поэтому UTC."""
    g = time.gmtime(int(e["t"]))
    day = f"{_WD[g.tm_wday]}, {_MON3[g.tm_mon - 1]} {g.tm_mday}" if lang == "en" else date_word(lang, int(e["t"]), year=False)
    all_day = e.get("k") == "unl" or (e.get("k") == "earn" and e.get("when") == "day")
    return day if all_day else f"{day} · {g.tm_hour:02d}:{g.tm_min:02d} UTC"


def _short(a: str) -> str:
    a = str(a or "")
    return a if len(a) < 12 else f"{a[:6]}…{a[-4:]}"


class _Page:
    """Страница альбома: фон, шапка с номером, подвал и курсор строк."""

    def __init__(self, it: dict, lang: str, title: str, page: int, total: int):
        col = Image.new("RGB", (1, H))
        for yy in range(H):
            k = yy / H
            col.putpixel((0, yy), tuple(int(C["bg1"][i] * (1 - k) + C["bg0"][i] * k) for i in range(3)))
        self.img = col.resize((W, H))
        self.d = ImageDraw.Draw(self.img, "RGBA")
        d = self.d
        for x in range(0, W + 1, 54):
            d.line([(x, 0), (x, H)], fill=(58, 130, 214, 18))
        for y in range(0, H + 1, 54):
            d.line([(0, y), (W, y)], fill=(58, 130, 214, 18))
        self.lang = lang
        y = PAD
        d.rounded_rectangle([PAD, y, PAD + 56, y + 56], radius=14, outline=C["glow"], width=3)
        self.text("W", PAD + 28, y + 40, "Bold", 30, C["glow"], "ms")
        self.text("WALLET TRACKER", PAD + 76, y + 25, "Bold", 26, C["ink"])
        self.text(tr(lang, "dg_img_kicker"), PAD + 76, y + 54, "Medium", 22, C["dim"])
        self.text(date_word(lang, int(it.get("to") or time.time())), W - PAD, y + 25, "SemiBold", 24, C["dim"], "rs")
        self.text(f"{page}/{total}", W - PAD, y + 56, "Bold", 22, C["glow"], "rs")
        self.y = y + 140
        self.text(title, PAD, self.y, "Bold", 52, C["ink"])
        self.y += 40
        self.limit = H - PAD - 120

    def text(self, s, x, y, weight, size, color, anchor="ls"):
        self.d.text((x, y), s, font=_font(weight, size), fill=color, anchor=anchor)

    def room(self, h: int) -> bool:
        return self.y + h <= self.limit

    def section(self, title: str) -> bool:
        if not self.room(110):
            return False
        self.y += 44
        self.text(title.upper(), PAD, self.y, "Bold", 22, C["glow"])
        self.d.line([(PAD, self.y + 12), (W - PAD, self.y + 12)], fill=(58, 130, 214, 40), width=1)
        self.y += 14
        return True

    def note(self, s: str) -> bool:
        """Мелкая строка под строками раздела — источник и лицензия данных."""
        if not self.room(34):
            return False
        self.y += 34
        self.text(s, PAD, self.y, "Regular", 20, C["dim"])
        return True

    def row(self, label: str, value: str = "", color=None, sub: str = "", arrow: str | None = None) -> bool:
        h = 44 + (28 if sub else 0)
        if not self.room(h):
            return False
        self.y += 44
        x = PAD
        if arrow:
            _arrow(self.d, PAD, self.y, arrow, C["up"] if arrow == "up" else C["dn"] if arrow == "dn" else C["glow"], 20)
            x = PAD + 36
        f = _font("Medium", 28)
        vw = self.d.textlength(value, font=_font("Bold", 28)) if value else 0
        lab = label
        while lab and self.d.textlength(lab, font=f) > W - 2 * PAD - (x - PAD) - vw - 24:
            lab = lab[:-2] + "…"
        self.text(lab, x, self.y, "Medium", 28, C["ink"])
        if value:
            self.text(value, W - PAD, self.y, "Bold", 28, color or C["ink"], "rs")
        if sub:
            self.y += 28
            fs = _font("Regular", 22)
            sb = sub
            while sb and self.d.textlength(sb, font=fs) > W - 2 * PAD - (x - PAD):
                sb = sb[:-2] + "…"
            self.text(sb, x, self.y, "Regular", 22, C["dim"])
        return True

    def para(self, s: str, tone: str | None = None) -> bool:
        f = _font("SemiBold", 27)
        rows = _wrap(self.d, s, f, W - 2 * PAD - 36, 3)
        if not self.room(16 + len(rows) * 36):
            return False
        self.y += 40
        _arrow(self.d, PAD, self.y, tone or "dot", C["up"] if tone == "up" else C["dn"] if tone == "dn" else C["glow"], 20)
        for i, r in enumerate(rows):
            self.text(r, PAD + 36, self.y + i * 36, "SemiBold", 27, C["ink"])
        self.y += (len(rows) - 1) * 36
        return True

    def png(self) -> bytes:
        d, lang = self.d, self.lang
        d.line([(PAD, H - PAD - 100), (W - PAD, H - PAD - 100)], fill=(58, 130, 214, 56), width=2)
        self.text(tr(lang, "dg_img_find"), PAD, H - PAD - 58, "Medium", 24, C["dim"])
        self.text(BOT_AT, PAD, H - PAD - 14, "Bold", 34, C["glow"])
        self.text(tr(lang, "dg_img_disc"), PAD, H - PAD + 22, "Regular", 18, (124, 151, 188, 180))
        buf = io.BytesIO()
        self.img.save(buf, "PNG", optimize=True)
        return buf.getvalue()


def _col(v: float):
    return C["up"] if v > 0 else C["dn"] if v < 0 else C["ink"]


def _page_deriv(it: dict, lang: str, n: int, total: int) -> bytes | None:
    """Фьючерсы и опционы: ликвидации, открытый интерес с фандингом, опционы."""
    p = _Page(it, lang, tr(lang, "dg_p_deriv_all"), n, total)
    has = False
    q = it.get("liq") or {}
    if q.get("n") and p.section(tr(lang, "lqs_title")):
        has = True
        L, S = q["L"], q["S"]
        ratio = max(L / S, S / L) if L > 0 and S > 0 else 0
        w = tr(lang, "lqs_v_eq") if ratio < 1.25 and L > 0 and S > 0 else tr(lang, "lqs_v_long" if L > S else "lqs_v_short", x=num(ratio, lang, 1))
        p.para(tr(lang, "dg_l_liq", v=usd(L + S, lang), w=w), "up" if S > L else "dn")
        p.row(f"{tr(lang, 'lqs_longs')} {usd(L, lang)} · {tr(lang, 'lqs_shorts')} {usd(S, lang)}", "")
        for c in (q.get("coins") or [])[:2]:
            p.row(c["sym"], usd(c["L"] + c["S"], lang), C["dn"] if c["L"] > c["S"] else C["up"])
    oi = it.get("oi") or {}
    if oi and p.section(tr(lang, "oih_title")):
        has = True
        for k in ("btc", "eth"):
            o = oi.get(k)
            if not o:
                continue
            sub = ""
            if o.get("ch") is not None and o.get("pch") is not None:
                ch, pch = o["ch"], o["pch"]
                key = "oih_q_flat" if abs(ch) < 1 else ("oih_q_up_up" if pch >= 0 else "oih_q_up_dn") if ch > 0 else (
                    "oih_q_dn_up" if pch >= 0 else "oih_q_dn_dn")
                sub = tr(lang, key, oi=pct(ch, lang, 1), p=pct(pch, lang, 1))
            val = usd(o["oi"], lang) + (f"  {pct(o['ch'], lang, 1)}" if o.get("ch") is not None else "")
            p.row(f"{k.upper()} · {tr(lang, 'oih_oi')}", val, _col(o.get("ch") or 0), sub)
        fu = [f"{k.upper()} {pct(oi[k]['fund'], lang, 4)}" for k in ("btc", "eth") if oi.get(k) and oi[k].get("fund") is not None]
        if fu:
            fex = max((oi[k].get("fex") or 0) for k in ("btc", "eth") if oi.get(k))
            p.row(tr(lang, "dg_img_fund8", n=fex) + ": " + " · ".join(fu), "")
    opt = it.get("opt") or {}
    if opt and p.section(tr(lang, "op_title")):
        has = True
        for k in ("btc", "eth"):
            o = opt.get(k)
            if not o:
                continue
            mood = "op_mood_eq" if o.get("pcr") is None else "op_mood_up" if o["pcr"] < 0.7 else "op_mood_dn" if o["pcr"] > 1 else "op_mood_eq"
            p.row(f"{k.upper()} · Put/Call {num(o['pcr'], lang, 2) if o.get('pcr') is not None else '—'}"
                  + (f" · DVOL {num(o['dvol'], lang, 1)}" if o.get("dvol") else ""), usd(o["n"], lang), None, tr(lang, mood))
        for k in ("btc", "eth"):
            nx = (opt.get(k) or {}).get("next")
            if nx:
                p.row(f"{k.upper()} · {when_utc({'t': nx['ts'], 'k': 'unl'}, lang)}", usd(nx["n"], lang), None,
                      tr(lang, "dg_img_exp", mp=px(nx["mp"], lang)))
    return p.png() if has else None


def _fund_uniq(rows: list) -> list:
    """По монете одна строка: у выпусков до этого правила монета с перекосом
    стояла трижды — по строке на биржу. Новые выпуски сервер отдаёт уже так."""
    out, seen = [], {}
    for f in rows or []:
        k = str(f.get("sym") or "").upper()
        if k in seen:
            seen[k]["also"].append(f.get("ex"))
            continue
        seen[k] = {**f, "also": list(f.get("also") or [])}
        out.append(seen[k])
    return out


def _fund_ex(f: dict) -> str:
    """Биржа с самой крайней ставкой и сколько ещё бирж с тем же перекосом."""
    more = len(f.get("also") or [])
    return str(f.get("ex") or "").upper() + (f" +{more}" if more else "")


def _page_pos(it: dict, lang: str, n: int, total: int) -> bytes | None:
    """Фандинг и позиции: перекосы фандинга, лонг/шорт и крупные позиции
    Hyperliquid, ротация денег и лучший трейдер."""
    p = _Page(it, lang, tr(lang, "dg_img_pos"), n, total)
    has = False
    fund = it.get("fund") or {}
    if (fund.get("hi") or fund.get("lo")) and p.section(tr(lang, "ui_tab_funding") + " · " + tr(lang, "dg_per_day").rstrip(".")):
        has = True
        for f in _fund_uniq(fund.get("hi"))[:2]:
            p.row(f"{f['sym']} · {_fund_ex(f)} · {tr(lang, 'dg_fund_hi')}", pct(f["day"], lang, 3), C["up"])
        for f in _fund_uniq(fund.get("lo"))[:2]:
            p.row(f"{f['sym']} · {_fund_ex(f)} · {tr(lang, 'dg_fund_lo')}", pct(f["day"], lang, 3), C["dn"])
    ls = it.get("ls") or {}
    g = ls.get("crypto") if isinstance(ls, dict) and "crypto" in ls else ls
    if isinstance(g, dict) and (g.get("long") or g.get("short")) and p.section("Hyperliquid · " + tr(lang, "ui_tab_ls")):
        has = True
        for c in (g.get("long") or [])[:1]:
            p.row(f"{c['sym']} · {tr(lang, 'dg_ls_long')}", usd(c["net"], lang, True), C["up"])
        for c in (g.get("short") or [])[:1]:
            p.row(f"{c['sym']} · {tr(lang, 'dg_ls_short')}", usd(c["net"], lang, True), C["dn"])
    pr = it.get("perp") or {}
    pc = pr.get("crypto") if isinstance(pr, dict) else pr
    if pc and p.section("Hyperliquid · " + tr(lang, "ui_tab_positions")):
        has = True
        for c in pc[:2]:
            p.row(f"{c['sym']} · {tr(lang, 'dg_long' if c.get('long') else 'dg_short')}", usd(c.get("v") or 0, lang),
                  C["up"] if c.get("long") else C["dn"])
    rot = it.get("rot") or {}
    if (rot.get("src") or rot.get("dst")) and p.section("BSC · " + tr(lang, "ui_rotation")):
        has = True
        p.row(f"{tr(lang, 'dg_rot_src')}: " + ", ".join(r["sym"] for r in (rot.get("src") or [])[:3]), "", None)
        p.row(f"{tr(lang, 'dg_rot_dst')}: " + ", ".join(r["sym"] for r in (rot.get("dst") or [])[:3]), "", None)
    lead = it.get("lead") or {}
    if any(lead.get(k) for k in ("spot", "perp", "btc")) and p.section(tr(lang, "rk_top_traders_30d")):
        has = True
        for venue, name in (("spot", "BSC"), ("perp", "Hyperliquid")):
            r = lead.get(venue)
            if r:
                p.row(f"{_short(r['a'])} · {name}", usd(r["pnl"], lang, True), _col(r["pnl"]),
                      tr(lang, "dg_lead_stats", w=num(r.get("win") or 0, lang), n=num(r.get("tr") or 0, lang)))
        r = lead.get("btc")
        if r:
            p.row(f"{_short(r['a'])} · Bitcoin", usd(r["pnl"], lang, True), _col(r["pnl"]),
                  f"{tr(lang, 'btc_hold')} {btc_amt(r.get('btc') or 0, lang)}")
    return p.png() if has else None


def _page_flows(it: dict, lang: str, n: int, total: int) -> bytes | None:
    """Киты и потоки: потоки ETF (с датой отчётного дня), биткоин на биржах,
    NetFlow и крупные сделки на BSC."""
    p = _Page(it, lang, tr(lang, "dg_p_whales3"), n, total)
    has = False
    inst = it.get("inst") or {}
    if inst.get("etf") and p.section(tr(lang, "dg_p_inst")):
        has = True
        for e in [e for e in inst["etf"] if e.get("v")][:3]:
            # День — подписью: в выходные выпуски повторяют пятничный поток, и
            # без даты он выглядел бы как вчерашний.
            p.row(tr(lang, "dg_etf_coin", c=e["c"].upper()), usd(e["v"], lang, True), _col(e["v"]),
                  tr(lang, "dg_etf_day", d=date_word(lang, int(e["day"]))) if e.get("day") else "")
        p.note(f"{tr(lang, 'dg_etf_by')} {TFTC_BY}")
    b = it.get("btc") or {}
    if b.get("net") is not None and p.section(tr(lang, "btc_flow_title")):
        has = True
        p.row(tr(lang, "btc_net"), btc_amt(b["net"], lang, True), _col(b["net"]),
              f"{tr(lang, 'btc_wd')} {btc_amt(b.get('out') or 0, lang)} · {tr(lang, 'btc_dep')} {btc_amt(b.get('in') or 0, lang)}")
        for e in (b.get("ex") or [])[:2]:
            p.row(e["ex"], btc_amt(e["net"], lang, True), _col(e["net"]))
    fl = it.get("flow") or {}
    if (fl.get("in") or fl.get("out")) and p.section("BSC · NetFlow"):
        has = True
        if fl.get("net") is not None:
            p.row(tr(lang, "dg_net"), usd(fl["net"], lang, True), _col(fl["net"]))
        for c in (fl.get("in") or [])[:1]:
            p.row(f"{c['sym']} · {tr(lang, 'dg_in')}", usd(c["net"], lang, True), C["up"])
        for c in (fl.get("out") or [])[:1]:
            p.row(f"{c['sym']} · {tr(lang, 'dg_out')}", usd(c["net"], lang, True), C["dn"])
    sp = it.get("spot") or []
    if sp and p.section("BSC · " + tr(lang, "ui_tab_orders")):
        has = True
        for c in sp[:2]:
            p.row(f"{c['sym']} · {tr(lang, 'dg_buy' if c.get('buy') else 'dg_sell')}", usd(c.get("v") or 0, lang),
                  C["up"] if c.get("buy") else C["dn"])
    return p.png() if has else None


def _page_week(it: dict, lang: str, n: int, total: int) -> bytes | None:
    cal = it.get("cal") or []
    if not cal:
        return None
    p = _Page(it, lang, tr(lang, "dg_p_ahead"), n, total)
    p.y += 10
    for e in cal[:8]:
        sub = when_utc(e, lang)
        if e.get("k") == "macro" and e.get("cc"):
            sub = f"{tr(lang, COUNTRY.get(e['cc'], ''))} · {sub}" if COUNTRY.get(e["cc"]) else sub
        val = usd(e["n"], lang) if e.get("n") else usd(e["usd"], lang) if e.get("usd") else ""
        if not p.row(cal_title(e, lang), val, None, sub):
            break
    h = it.get("halv")
    if h:
        # Источник рядом с числом — правило проекта (как alternative.me и TFTC).
        by = h.get("by") if h.get("by") in HALVING_BY else ""
        p.row(tr(lang, "hv_title"), "", None, tr(lang, "dg_halv", n=num(h["left"], lang)) + (f" · {by}" if by else ""))
    return p.png()


def render_album(it: dict, lang: str = "en") -> list[bytes]:
    """Обложка и страницы по разделам; пустые страницы не попадают."""
    if Image is None:
        return []
    builders = [_page_deriv, _page_pos, _page_flows, _page_week]
    total = 1 + len(builders)
    drawn = [(fn, fn(it, lang, i + 2, total)) for i, fn in enumerate(builders)]
    live = [fn for fn, png in drawn if png]
    if len(live) < len(builders):
        # Пустая страница выпала — номера «N/всего» на остальных уже неверны
        # («1/5» при четырёх картинках): перерисовываем с верными.
        total = 1 + len(live)
        drawn = [(fn, fn(it, lang, i + 2, total)) for i, fn in enumerate(live)]
    pages = [png for _, png in drawn if png]
    cover = render(it, lang, f"1/{total}")
    return [cover] + pages if cover else pages
