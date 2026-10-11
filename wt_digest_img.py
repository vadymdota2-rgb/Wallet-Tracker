"""Картинка выпуска дайджеста на сервере — для автопостинга в Telegram-канал.

В приложении ту же картинку рисует canvas (src/lib/digestImage.ts). Канал
же получает её без человека, поэтому сервер рисует сам — Pillow и тот же
шрифт IBM Plex Sans (fonts/, лицензия OFL), тем же макетом 1080×1350, теми
же словами из tools/i18n.json и тем же форматом чисел. Логика выводов —
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
BOT_URL = "t.me/WalletTrackerAppBot"

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
}


def date_word(lang: str, ts: int) -> str:
    g = time.gmtime(ts)
    if lang in ("ru", "uk"):
        return f"{g.tm_mday} {_MONTHS[lang][g.tm_mon - 1]} {g.tm_year} {'г.' if lang == 'ru' else 'р.'}"
    if lang == "en":
        return f"{_MONTHS['en'][g.tm_mon - 1]} {g.tm_mday}, {g.tm_year}"
    return time.strftime("%Y-%m-%d", g)


# --- Выводы: копия DigestMore.tsx --------------------------------------------

SIG_KEY = {"fng": "dg_sig_fng", "etf": "dg_sig_etf", "btcx": "dg_sig_btcx", "whales": "dg_sig_whales",
           "cbp": "dg_sig_cbp", "liq": "dg_sig_liq", "oi": "dg_sig_oi", "fund": "dg_sig_fund", "pcr": "dg_sig_pcr"}
FNG_ZONES = ((25, "fg_z0"), (46, "fg_z1"), (54, "fg_z2"), (75, "fg_z3"), (100, "fg_z4"))


def sig_value(s: dict, lang: str) -> str:
    k, v = s["k"], s["v"]
    if k == "fng":
        return num(v, lang)
    if k in ("etf", "whales"):
        return usd(v, lang, True)
    if k == "btcx":
        return btc_amt(v, lang, True)
    if k == "cbp":
        return pct(v, lang, 3)
    if k == "liq":
        return num(v, lang) + "%"
    if k == "oi":
        return pct(v, lang, 1)
    if k == "fund":
        return pct(v, lang, 4)
    return num(v, lang, 2)


def verdict(it: dict, lang: str) -> tuple[str, str] | None:
    sig = it.get("sig") or []
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
        z = f"{tr(lang, zone)}: {m['fng']['v']}" if zone else "—"
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


def render(it: dict, lang: str = "ru") -> bytes | None:
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
    sig = (it.get("sig") or [])[:9]
    if sig:
        y += 14
        row_h = 54
        box_h = len(sig) * row_h + 28
        d.rounded_rectangle([PAD, y, W - PAD, y + box_h], radius=22, fill=(127, 216, 255, 13), outline=(58, 130, 214, 56), width=2)
        ry = y + 14 + row_h // 2 + 10
        for s in sig:
            col = C["up"] if s["d"] > 0 else C["dn"] if s["d"] < 0 else C["dim"]
            _arrow(d, PAD + 30, ry, "up" if s["d"] > 0 else "dn" if s["d"] < 0 else "dot", col)
            text(tr(lang, SIG_KEY.get(s["k"], s["k"])), PAD + 72, ry, "Regular", 30, C["ink"])
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
    text(BOT_URL, W - PAD, H - PAD - 14, "SemiBold", 28, C["ink"], "rs")
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
    parts.append(f"{BOT_AT}\nhttps://{BOT_URL}")
    out = "\n\n".join(parts)
    # Подпись к фото в Telegram — до 1024 знаков: лишние выводы отрезаем.
    while len(out) > 1024 and ls:
        ls = ls[:-1]
        parts[2 if v else 1] = "\n".join(("▲ " if t == "up" else "▼ " if t == "dn" else "• ") + s for s, t in ls)
        out = "\n\n".join(parts)
    return out[:1024]

