"""Мутационная проверка «Институциональных потоков», «Доминации и альтсезона» и биткоина (wt_btc): python3 tools/mutate-etf.py

Как у халвинга: портим код по одному месту (граница, знак, константа,
защита) и гоняем тесты. Убитая мутация — тесты заметили порчу; выжившая —
дыра в тестах. Файл после каждой мутации возвращается как был.
"""
import os
import signal
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Эквивалентные (не меняют ничего наблюдаемого) — в счёт не идут: «монеты
# дня без цены» — цена дня либо 0, либо от PX_MIN, отрицательной не бывает.
# «без покупок — не трейдер» (wt_btc): покупка без цены в итог не попадает
# (рейтинг и кошелёк берут только движения с ценой), так что «нет покупок»
# и «нет вложенного» — одно и то же; проверка покупок оставлена от деления.
EQUIV = {"монеты дня без цены", "без покупок — не трейдер"}
TS = [
    # Проверка ответа.
    ("7 * DAY, now + 2 * DAY) || ts % DAY !== 0 || ts <= prev)", "7 * DAY, now + 2 * DAY) || ts <= prev)", "день — с начала суток"),
    ("7 * DAY, now + 2 * DAY) || ts % DAY !== 0 || ts <= prev)", "7 * DAY, now + 2 * DAY) || ts % DAY !== 0 || ts < prev)", "дни строго по возрастанию"),
    ("per.length !== nf", "per.length > nf", "столбцы фондов совпадают"),
    ("if (!ok || seen.has(ok.t)) return null;", "if (!ok) return null;", "тикеры не повторяются"),
    ("!within(usd, -USD_K_MAX, USD_K_MAX)", "!isNum(usd)", "предел потока дня"),
    ("if (fee !== null && !within(fee, 0, 10)) return null;", "", "комиссия в пределах"),
    ("if (share !== null && !within(share, 0, 100)) return null;", "", "доля в пределах"),
    ('(through !== "" && !DATE.test(through))', "false", "«данные по» — дата"),
    ("!within(raw[\"at\"], ETF_LAUNCH, now + 7 * DAY)", "!isNum(raw[\"at\"])", "время ответа правдоподобно"),
    ("7 * DAY, now + 2 * DAY) || ts % DAY", "7 * DAY, now + 365 * DAY) || ts % DAY", "день не из будущего"),
    ("if (!btc || !btc.days.length) return null;", "if (!btc) return null;", "без дней — не ответ"),
    ("TICKER.test(t)", "t.length > 0", "тикер — заглавные и цифры"),
    ("raw.holders.filter(holderRow)".replace("raw.holders", 'raw["holders"]'), 'raw["holders"]', "держатели проверяются"),
    # Расчёты.
    ("Math.floor((ts / DAY + 3) / 7)", "Math.floor((ts / DAY + 4) / 7)", "неделя с понедельника"),
    ("if (d[3]) last.px = d[3];", "last.px = d[3];", "цена недели без пустых дней"),
    ("days.filter((d) => d[0] > end - n * DAY)", "days.filter((d) => d[0] >= end - n * DAY)", "окно n суток"),
    ("range === \"30\" || range === \"90\" ? daily", "range === \"30\" ? daily", "90 дней — по дням"),
    ("days.filter((d) => d[0] < first)", "days.filter((d) => d[0] <= first)", "накопленное до окна"),
    ("sign !== 0 && Math.sign(days[i]![1]) === sign", "Math.sign(days[i]![1]) === sign", "серия с нулём"),
    ("if (m >= open) continue;", "", "идущий месяц — не рекорд"),
    ("Math.max(now, end) * 1000", "end * 1000", "идущий месяц — по часам"),
    ("for (let i = 0; i < 30; i++)", "for (let i = 0; i < 31; i++)", "добыча за 30 суток"),
    ("if (ts < 1_713_571_200) return 900;", "if (ts <= 1_713_571_200) return 900;", "граница халвинга 2024"),
    ("held: c.funds.reduce((s, f) => s + (f.hold ?? 0), 0)", "held: 0", "запас фондов"),
    ('const n = period === "d" ? 1 : period === "w" ? 7 : 30;', 'const n = period === "d" ? 1 : period === "w" ? 6 : 30;', "неделя — 7 суток"),
    ("rows.filter((r) => Math.abs(r.v) >= 1)", "rows.filter((r) => Math.abs(r.v) > 1)", "фонд с движением"),
    ("Math.abs(y.v) - Math.abs(x.v)).slice(0, n)", "y.v - x.v).slice(0, n)", "крупнейшие фонды по модулю"),
    # Активы фондов по дням.
    ("ts % DAY !== 0 || ts <= prev || !within(v, TNA_MIN, TNA_MAX)", "ts % DAY !== 0 || !within(v, TNA_MIN, TNA_MAX)", "активы: дни по возрастанию"),
    ("|| !within(v, TNA_MIN, TNA_MAX)) return null;", "|| !isNum(v)) return null;", "активы: правдоподобная сумма"),
    ("t[0] >= lastDay - TNA_FRESH", "t[0] >= 0", "активы: только свежая сводка"),
    ("return p > 0 ? [[ts, usd / p]] : [];", "return [[ts, usd / (p || 1)]];", "запас по дням без цены дня"),
    # Карточка фонда и свежесть набора.
    ("if (v !== null && v !== undefined) all.push([d[0], v]);", "all.push([d[0], v ?? 0]);", "фонд: дни без торгов — не его"),
    ("const days = all.slice(-n);", "const days = all.slice(0, n);", "фонд: последние дни"),
    ("if (x[1] > 0 && (!best || x[1] > best[1])) best = x;", "if (!best || x[1] > best[1]) best = x;", "фонд: рекорд притока — приток"),
    ("if (x[1] < 0 && (!worst || x[1] < worst[1])) worst = x;", "if (!worst || x[1] < worst[1]) worst = x;", "фонд: рекорд оттока — отток"),
    ("return Math.max(0, Math.floor((now - last) / DAY));", "return Math.floor((now - last) / DAY);", "свежесть: часы отстают"),
    ("Math.floor((now - last) / DAY))", "Math.ceil((now - last) / DAY))", "свежесть: полные сутки"),
    ("export const STALE_DAYS = 5;", "export const STALE_DAYS = 2;", "свежесть: праздники — не сбой"),
]
PY = [
    # Разбор набора TFTC.
    ("if not ETF_LAUNCH <= ts <= last", "if not ts <= last", "день до запуска фондов"),
    ("<= ts <= last or", "<= ts or", "день из будущего"),
    ("(not by and total == 0)", "False", "праздник биржи — не торговый день"),
    ("abs(total) > DAY_MAX", "abs(total) > 1e300", "предел потока дня"),
    ("any(abs(v) > FUND_MAX for v in by.values())", "False", "предел потока фонда"),
    ("total = sum(by.values()) if by else", "total = _num(r.get(\"netFlowUsd\")) if by else", "итог дня — сумма фондов"),
    ("and TICKER.fullmatch(k)}", "}", "тикер — заглавные и цифры"),
    ('DATE.fullmatch(r["date"])', 'r["date"]', "дата строки — ГГГГ-ММ-ДД"),
    ('DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")', 'DATE = re.compile(r"\\d{4}-\\d{2}-\\d{2}")', "цифры даты — ASCII"),
    ("if PX_MIN <= _num(r.get(\"btcCloseUsd\")) <= PX_MAX:", "if _num(r.get(\"btcCloseUsd\")):", "цена из набора правдоподобна"),
    # Запас и фонды.
    ("if 0 < btc <= HOLD_MAX:", "if btc > 0:", "запас из отчёта правдоподобен"),
    ("                out[t] = (btc, e)\n                break", "                out[t] = (btc, e)\n            break", "негодный отчёт — прошлый квартал"),
    ("[0.0])[0]), k)", "[0.0])[0]), 0)", "фонды при равенстве — по тикеру"),
    ("fee = fee if 0 < fee < wt_treasury.FEE_MAX else 0.0", "", "комиссия фонда в пределах"),
    ("isinstance(t, str) and TICKER.fullmatch(t)", "isinstance(t, str)", "тикер фонда из SEC"),
    ("TICKER.fullmatch(r[3]) is not None", "True", "держатели: тикер компании"),
    ("1 <= _num(r[4]) <= HOLD_MAX", "_num(r[4]) >= 1", "держатели: запас компании правдоподобен"),
    ("(-_num(r[4]), r[3])", "(-_num(r[4]), 0)", "держатели при равенстве — по тикеру"),
    ("_part(\"sec\", sec_f, SEC_WAIT)", "_part(\"sec\", sec_f, 60)", "SEC ждём не дольше SEC_WAIT"),
    ("or wt_treasury.funds_cached()", "or {}", "SEC не ответил — прошлые отчёты"),
    ("pool.shutdown(wait=False, cancel_futures=True)", "pool.shutdown(wait=True)", "зависшую часть не ждём"),
    ("if t not in known and t not in _st.told)", "if t not in known)", "о новом фонде — один раз"),
    ("if t not in known and t not in _st.told)", "if t not in _st.told)", "о знакомом фонде — молчим"),
    ("if hit and not _busy.is_set() and not _resting():", "if hit and not _busy.is_set():", "после сбоя фон ждёт паузу"),
    ("else _no_data() if resting else build()", "else build()", "очередь холодного старта не пересобирает"),
    ("        _st.fail = None\n", "", "удачная сборка снимает паузу"),
    ("_st.fail is not None and time.monotonic() - _st.fail < FAIL_WAIT", "_st.fail is not None", "пауза кончается"),
    ('    return {"ok": False, "error": "no_data"}\n', '    return _NO\n_NO = {"ok": False, "error": "no_data"}\n', "«нет данных» каждый раз новый"),
    ("if ts > asof and t in by", "if ts >= asof and t in by", "потоки после отчёта"),
    ("(1 - fee * max(0, _now() - asof) / (365 * 86400))", "1", "комиссия монетами"),
    ('"n": str(info.get("n") or "")[:60]', '"n": str(info.get("n") or "")', "длина имени фонда"),
    ("round(tot / p, 2) if p > 0 else 0.0", "round(tot / p, 2) if p else 0.0", "монеты дня без цены"),
    ("aum / price / supply_at(_now()) * 100", "aum / price / 21e6 * 100", "доля — от добытого"),
    # Защита.
    ('u.scheme == "https" and u.hostname in HOSTS and', "True or", "только https и известные адреса"),
    (" and not u.username and not u.password", "", "адрес с логином"),
    ("ProxyHandler({}), _NoRedirect, ", "ProxyHandler({}), ", "без перенаправлений"),
    ("parse_float=_finite, ", "", "числа без бесконечностей"),
    ("return body if len(body) <= BODY_MAX else None", "return body", "предел размера ответа"),
    ('c if c.isprintable() else "?"', "c", "журнал без управляющих символов"),
    ("_now() - _num(got.get(\"at\")) > FILE_MAX_AGE", "False", "старая копия с диска"),
    (" or not DATE.fullmatch(stamp[:10]):", ":", "дата CFTC — ASCII"),
    # CME, активы фондов.
    ("if not CME_FROM <= ts <= _now() or", "if not ts <= _now() or", "CME: дата не до фьючерсов"),
    ("CME_FROM <= ts <= _now() or", "CME_FROM <= ts or", "CME: дата не из будущего"),
    ("any(not 0 <= v <= CME_MAX for v in vals)", "False", "CME: позиции правдоподобны"),
    ('if TNA_MIN <= _num(r.get("totalNetAssetsUsd")) <= TNA_MAX:', 'if _num(r.get("totalNetAssetsUsd")):', "активы: правдоподобная сумма"),
    ("if tna and max(tna) >= max(days) - 7 * 86400 and", "if tna and", "активы: только свежая сводка"),
    ("if own > 0 and abs(own / held - 1) > SPLIT_MAX:", "if False:", "сверка своей оценки со сводкой"),
    # Атаки: огромные числа, тысячи тикеров, лавина «новых фондов».
    ('    if len(text.lstrip("-")) > INT_DIGITS:', "    if False:", "целое не длиннее INT_DIGITS цифр"),
    ("except (TypeError, ValueError, OverflowError):", "except (TypeError, ValueError):", "огромное целое — не число"),
    ("if len({t for by, _ in days.values() for t in by}) > FUNDS_MAX:", "if False:", "тысячи тикеров по дням — набор не берём"),
    ("not in _st.told)[:NEW_MAX]", "not in _st.told)", "сообщений о новых фондах — не больше NEW_MAX"),
]
TR = [
    ("return QUARTER.fullmatch(s) is not None", 'return len(s) == 10 and s[5:] in ("03-31", "06-30", "09-30", "12-31")', "SEC: дата квартала — ASCII"),
    ("if STAMP.fullmatch(str(k)) and _point(v)}", "if STAMP.fullmatch(str(k)) and isinstance(v, list)}", "SEC: копия на диске проверяется"),
    ("if STAMP.fullmatch(str(k)) and", "if str(k).isdigit() and", "SEC: ключ квартала — ASCII-число"),
    ("if t in _ETF and isinstance(f, dict)", "if isinstance(f, dict)", "SEC: фонды копии — только из ETFS"),
    ("if not isinstance(s, str) or not DATE.fullmatch(s):", "if not isinstance(s, str) or len(s) != 10:", "SEC: дата отчёта — ASCII"),
    ("isinstance(r[3], str) and r[3] in _CO", "isinstance(r[3], str)", "SEC: компании копии — только из COMPANIES"),
    ("1 <= r[4] < COUNT_MAX", "r[4] >= 0", "SEC: запас компании из копии правдоподобен"),
    ("type(r[5]) is int and r[5] > 0", "True", "SEC: дата отчёта компании в копии"),
    ("            if ticker in old:\n                out.append(old[ticker])\n", "", "SEC: компания без ответа — прошлый отчёт"),
    ("    if not answered:\n        # SEC не ответил", "    if not rows:\n        # SEC не ответил", "SEC: молчание по компаниям — не свежее"),
    ("    if not answered:\n        # Ни один фонд", "    if not out:\n        # Ни один фонд", "SEC: молчание по фондам — не свежее"),
    ("if not _ua() or not _fund_busy.acquire(blocking=False):", "if not _ua():", "SEC: фонды не спрашиваем вдвоём"),
    ("if not _ua() or not _co_busy.acquire(blocking=False):", "if not _ua():", "SEC: компании не спрашиваем вдвоём"),
    ('"fee": float(fee) if _num_ok(fee) and 0 < fee < FEE_MAX else None}', '"fee": fee}', "SEC: комиссия из копии"),
    ('if u.scheme != "https" or u.hostname != HOST or u.username or u.password or not ua:', "if not ua:", "SEC: только https к data.sec.gov"),
    ('return ua if ua.isprintable() and "@" in ua and len(ua) <= 200 else ""', "return ua", "SEC: подпись с почтой и без переводов строк"),
    ('    if len(text.lstrip("-")) > INT_DIGITS:', "    if False:", "SEC: целое не длиннее INT_DIGITS цифр"),
    ("    except OverflowError:\n        return False", "    except ZeroDivisionError:\n        return False", "SEC: огромное целое — не число"),
    ("            if not _num_ok(val) or val < 0:", "            if not math.isfinite(val) or val < 0:", "SEC: огромное целое в отчёте не роняет разбор"),
]


# Итоги дня ETF в Telegram (whale_api: etfd_*).
AL = [
    ("    if now() - ts > ETFD_FRESH:\n        return None\n", "", "алерт: только свежий день"),
    ("    if not v and not buy and not sell:", "    if False:", "алерт: день без движения — без сообщения"),
    ("if p[1] > 0), key=lambda p: -p[1])[:3]", "if p[1] > 0), key=lambda p: p[1])[:3]", "алерт: купившие — от самого большого"),
    ("if p[1] > 0), key=lambda p: -p[1])[:3]", "if p[1] > 0), key=lambda p: -p[1])", "алерт: купивших не больше трёх"),
    ("if p[1] < 0), key=lambda p: p[1])[:3]", "if p[1] < 0), key=lambda p: -p[1])[:3]", "алерт: продавшие — от самого большого"),
    ("if p[1] < 0), key=lambda p: p[1])[:3]", "if p[1] < 0), key=lambda p: p[1])", "алерт: продавших не больше трёх"),
    ('"ef_al_in" if v >= 0 else', '"ef_al_in" if v > 0 else', "алерт: ноль в итоге — не «отток»"),
    ("if not seen or seen[0] != k:", "if not seen:", "алерт: дописанный день — ждать заново"),
    ("        if now() - seen[1] < ETFD_STABLE:\n            return 0\n", "", "алерт: только устоявшийся день"),
    ('FROM etf_day_subs WHERE last_day<? ORDER BY at", (ts,)', 'FROM etf_day_subs ORDER BY at", ()', "алерт: один день — одно сообщение"),
    ('last = con.execute("SELECT COALESCE(MAX(day), 0) FROM etf_day_sent").fetchone()[0]', "last = 0", "алерт: включившему после рассылки день не шлём"),
    ('con.execute("UPDATE etf_day_subs SET last_day=(SELECT COALESCE(MAX(day), 0) FROM etf_day_sent)")', "pass", "алерт: старая таблица — без повтора"),
    ("            if not chat_premium(chat):\n                continue\n", "", "алерт: только с Премиумом"),
    ("lines.append(f\"{dgi.tr(lang, 'dg_etf_by')} {dgi.TFTC_BY_POST}\")", "pass", "алерт: источник и лицензия TFTC"),
    ("            if ok is None:\n", "            if ok is None and False:\n", "алерт: сбой сети — не отписка"),
    ("                if down >= 3:\n                    break\n", "", "алерт: Telegram лежит — проход прерван"),
    ("            down = 0\n", "", "алерт: сбои считаются подряд"),
    ('SET last_day=?, fails=0 WHERE chat_id=?"', 'SET last_day=? WHERE chat_id=?"', "алерт: доставка обнуляет отказы"),
    ('con.execute("DELETE FROM etf_day_subs WHERE chat_id=? AND fails>=?", (chat, ETFD_FAILS))', "pass", "алерт: бот заблокирован — отписка"),
    ("if e.code == 403 or (e.code == 400", "if (e.code == 400", "алерт: 403 — человека нет"),
    (' or (e.code == 400 and "chat not found" in desc.lower())', "", "алерт: chat not found — человека нет"),
    ("if e.code == 429 and attempt == 0 and", "if attempt == 0 and", "алерт: ждём только при лимите"),
    ("and 0 < wait <= 30:", "and 0 < wait:", "алерт: долгий лимит не ждём"),
    ('return True if isinstance(out, dict) and out.get("ok") else None', "return True", "алерт: ok:false — не доставка"),
    ("        if not fresh:\n            return\n", "", "новый фонд: один раз и после перезапуска"),
]

# Альтсезон: сервер (wt_dom) и приложение (lib/dom.ts).
DM = [
    ("        if len(el) >= MIN_BASKET:", "        if el:", "альтсезон: сила альтов — не меньше MIN_BASKET монет"),
    ("    if all(r[2] is None for r in rows):", "    if not rows:", "альтсезон: без единого дня с корзиной ответа нет"),
    ("        el = basket(t, 1, TOP) if i and t - p == DAY else []", "        el = basket(t, 1, TOP) if i else []", "альтсезон: сила — только за день подряд"),
    ("        if len(el) < min(MIN_BASKET, n):", "        if not el:", "альтсезон: индекс — не меньше MIN_BASKET монет"),
    ("        trail[a] = [(sums[i] - sums[max(0, i - VOLW)]) / VOLW for i in range(len(days))]",
     "        trail[a] = [(sums[i + 1] - sums[max(0, i - VOLW)]) / VOLW for i in range(len(days))]", "альтсезон: оборот самого дня не в счёт"),
    ("        trail[a] = [(sums[i] - sums[max(0, i - VOLW)]) / VOLW for i in range(len(days))]",
     "        trail[a] = [sums[i] / VOLW for i in range(len(days))]", "альтсезон: оборот — только за VOLW дней"),
    ("        live.sort(key=lambda a: (-trail[a][i], a))\n", "", "альтсезон: корзина — самые торгуемые"),
    ("live = [a for a in alts if trail[a][i] > 0 and", "live = [a for a in alts if", "альтсезон: без торгов — не в корзине"),
    ("        return live[:n]", "        return live", "альтсезон: не больше n монет в корзине"),
    ("        if gone and have:\n            out[coin] = have\n            continue\n", "", "альтсезон: снятые с торгов не спрашиваем снова"),
    ("            out[name] = bool(u.get(\"isDelisted\"))", "            out[name] = False", "альтсезон: снятые с торгов видны"),
    ("    if last >= _today() - DAY:", "    if False:", "альтсезон: новый день не закрылся — сеть не трогаем"),
    ('        if hit and hit[1].get("n") == TOP:', "        if hit:", "альтсезон: ответ по старому размеру корзины пересчитывается"),
    ("                    and isinstance(saved.get(\"tiers\"), list):", "                    :", "альтсезон: копия прежнего расчёта не годится"),
    ("max(-CLIP, min(CLIP, math.log", "max(-9e9, min(9e9, math.log", "альтсезон: сбой цены урезан"),
    ("acc + sum(rel) / len(rel)))", "acc + sum(rel)))", "альтсезон: корзина поровну"),
    ("        acc = max(-STR_LOG, min(STR_LOG, acc + sum(rel) / len(rel)))", "        acc = acc + sum(rel) / len(rel)", "альтсезон: сила в пределах приложения"),
    ("if t in eth and EB_MIN < eth[t] / btc[t] < EB_MAX else None", "if t in eth else None", "альтсезон: ETH/BTC правдоподобен"),
    ('    btc = {t: c for t, (c, _) in (px.get("BTC") or {}).items() if c >= BTC_MIN}', '    btc = {t: c for t, (c, _) in (px.get("BTC") or {}).items()}', "альтсезон: биткоин не дешевле BTC_MIN"),
    ("             if (g := round((close[a][end] / close[a][b] - 1) * 100, 2)) <= GROW_MAX]", "             if (g := round((close[a][end] / close[a][b] - 1) * 100, 2)) or True]", "альтсезон: рост монеты правдоподобен"),
    ('a != "BTC" and a not in EXCLUDE and', 'a != "BTC" and', "альтсезон: без золота"),
    (" and not _pegged(px[a])]", "]", "альтсезон: без привязанных к доллару"),
    ("max(have) - TAIL_DAYS * DAY if have else 0)", "0)", "альтсезон: известные — только последние дни"),
    ("            out[coin] = {**have, **got}", "            out[coin] = got", "альтсезон: новые дни дописываются к старым"),
    ("        if t % (DAY * 1000) or not 0 < px < PX_MAX or not 0 <= vol * px < VOL_MAX:", "        if not 0 < px:", "альтсезон: свеча правдоподобна"),
    ("        if PX_FROM <= ts < _today():\n            out[ts]", "        if True:\n            out[ts]", "альтсезон: только закрытые дни с 2020 г."),
    ('    if len(text.lstrip("-")) > INT_DIGITS:', "    if False:", "альтсезон: целое не длиннее INT_DIGITS"),
    ('return u.scheme == "https" and u.hostname in HOSTS and not u.username and not u.password', "return True", "альтсезон: только https к Hyperliquid"),
    ("                buf += chunk\n            return None\n    except urllib.error.HTTPError as e:\n        if e.code == 429", "                buf += chunk\n            return bytes(buf)\n    except urllib.error.HTTPError as e:\n        if e.code == 429", "альтсезон: предел размера ответа"),
    ("        if asked:\n            sleep(PACE)\n", "", "альтсезон: пауза между запросами"),
    ("        if asked % SAVE_EVERY == 0:\n            _px_save({**old, **out})\n", "", "альтсезон: свечи пишутся по ходу первой сборки"),
    ("        if asked % SAVE_EVERY == 0:\n            _px_save({**old, **out})", "        if asked % SAVE_EVERY == 0:\n            _px_save(out)", "альтсезон: промежуточная запись не теряет ещё не спрошенные монеты"),
    ("            if ts % DAY == 0 and PX_FROM <= ts < _today() and 0 < px < PX_MAX and 0 <= dv < VOL_MAX:", "            if True:", "альтсезон: копия цен на диске проверяется"),
    ("            if ts % DAY == 0 and PX_FROM <= ts < _today() and 0 < px < PX_MAX and 0 <= dv < VOL_MAX:", "            if ts % DAY == 0 and 0 < px < PX_MAX and 0 <= dv < VOL_MAX:", "альтсезон: даты копии цен — с 2020 г. и не идущий день"),
    ('    return {"ok": False, "error": "building"} if building else _no_data()', "    return _no_data()", "альтсезон: «собираем» на холодном старте"),
    ("        if not _busy.is_set() and not _resting():", "        if not _busy.is_set():", "альтсезон: пауза после сбоя"),
    ("    return len(xs) >= 10 and max(xs) / min(xs) < PEG", "    return False", "альтсезон: привязанная монета видна по ценам"),
    ("eb = float(f\"{eth[t] / btc[t]:.6g}\")", "eb = float(f\"{eth[t]:.6g}\")", "альтсезон: ETH/BTC — отношение цен"),
    ("                if time.monotonic() > end:\n                    return None\n", "", "альтсезон: весь ответ — не дольше срока"),
    ("        _st.loaded = True\n        saved = _file_load(\"dom.json\")", "        saved = _file_load(\"dom.json\")", "альтсезон: копия с диска — один раз, а не на каждый запрос"),
    ("        if e.code == 429:\n            raise _Limited from None\n", "", "альтсезон: 429 — пауза, а не следующий запрос"),
    ("                sleep(LIMIT_WAIT)\n", "", "альтсезон: на 429 — ждём перед повтором"),
    ("                if tries == LIMIT_TRIES:", "                if tries == 0:", "альтсезон: на 429 — несколько повторов"),
    ("                    _px_save({**old, **out})\n                    with _lock:", "                    with _lock:", "альтсезон: прерванный обход сохраняет полученное"),
    ("    return (_st.fail is not None and now - _st.fail < FAIL_WAIT) or now < _st.rest", "    return _st.fail is not None and now - _st.fail < FAIL_WAIT", "альтсезон: после 429 — долгий отдых"),
]
# Доминация (wt_mcap): официальный API CoinMarketCap, бюджет кредитов, история.
MC = [
    ('return u.scheme == "https" and u.hostname in HOSTS and not u.username and not u.password', "return True", "доминация: ключ — только по https к pro-api"),
    ("    if not key or not _allowed(url):\n        return None\n", "", "доминация: без ключа и мимо HOSTS — без сети"),
    ('        _log(f"HTTP {e.code}")\n', "", "доминация: код ошибки CMC — в журнал"),
    ("                buf += chunk\n            return None\n    except urllib.error.HTTPError", "                buf += chunk\n            return bytes(buf)\n    except urllib.error.HTTPError", "доминация: предел размера ответа"),
    ("    return k if 8 <= len(k) <= 100 and k.isascii() and k.replace(\"-\", \"\").isalnum() else \"\"", "    return k", "доминация: ключ похож на ключ"),
    ("_pct(btc) + _pct(eth) > 100:", "btc + eth > 1000:", "доминация: доли BTC + ETH не больше 100 после округления"),
    ('btc = _num(_get(data, "btc_dominance"), 0.5, 100)', 'btc = _num(_get(data, "btc_dominance"), 0, 100)', "доминация: доля BTC не ноль"),
    ("cap = _num(_get(usd, \"total_market_cap\"), CAP_MIN, CAP_MAX)", "cap = _num(_get(usd, \"total_market_cap\"), 0, 1e30)", "доминация: капитализация правдоподобна"),
    ("None if stable is None or stable / cap * 100 > 100 - btc else", "None if stable is None else", "доминация: стейблкоинов не больше, чем альтов"),
    ('if not isinstance(c, dict) or c.get("id") != int(USDT_ID) or c.get("symbol") != "USDT":', "if not isinstance(c, dict):", "доминация: USDT — именно USDT"),
    ('if isinstance(q, dict) and q.get("symbol") == "USD":', "if isinstance(q, dict):", "доминация: капитализация USDT — в долларах"),
    ("ucap = _num(q.get(\"market_cap\"), 1e8, cap)", "ucap = _num(q.get(\"market_cap\"), 0, 1e30)", "доминация: USDT не дороже рынка"),
    ("        if t is None or not HIST_FROM <= t <= now or cap is None or btc is None:", "        if t is None or cap is None or btc is None:", "доминация: дни истории — с 2013 г. и не из будущего"),
    ("        eth = None if eth is None or _pct(eth) > 100 - _pct(btc) else eth\n", "", "доминация: ETH + BTC в истории не больше 100"),
    ("    return [r for t, r in sorted(days.items()) if t > last - HIST_DAILY * DAY or (t // DAY) % 7 == 0]", "    return [r for t, r in sorted(days.items())]", "доминация: старая история — раз в неделю"),
    ("    if not isinstance(quotes, list) or len(quotes) > HIST_MAX:", "    if not isinstance(quotes, list):", "доминация: предел длины истории"),
    ("        return _spent().get(day, 0) + cost <= DAY_BUDGET", "        return True", "доминация: дневной бюджет кредитов"),
    ("    if raw is not None:\n        _charge(got, guess)\n", "", "доминация: кредиты списываются"),
    ("    cost = n if isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 1000 else guess", "    cost = guess", "доминация: кредиты — по ответу CMC"),
    ('    _file_save("mcap_spent.json", snap)\n', "", "доминация: счётчик кредитов — на диске"),
    ("    if (old and now - old[0] < HIST_TTL) or now - tried < HIST_RETRY:", "    if old and now - old[0] < HIST_TTL:", "доминация: пауза после неудачной истории"),
    ("            _st.hist_try = now\n", "", "доминация: неудача истории запоминается"),
    ('    _file_save("mcap_hist.json", {"at": now, "v": rows})\n', "", "доминация: история — на диске"),
    ('    _file_save("mcap.json", {"ok": True, **got, "at": at})\n', "", "доминация: ответ — на диске"),
    ("                _st.hit = (time.monotonic() - age, {**last[1], \"hist\": hist[1] if hist else []})", "                pass", "доминация: после перезапуска — копия с диска"),
    ("                and HIST_FROM <= r[0] <= time.time() and (not rows or r[0] > rows[-1][0])):", "                ):", "доминация: копия истории проверяется"),
    ("        resting = _st.fail is not None and time.monotonic() - _st.fail < FAIL_WAIT", "        resting = False", "доминация: пауза после сбоя"),
    ('        return {"ok": False, "error": "no_key"}\n    if not _st.loaded and _st.dir:', '        pass\n    if not _st.loaded and _st.dir:', "доминация: без ключа — «нет ключа»"),
    ("    return f\"{HIST}&time_end={time.strftime('%Y-%m-%d', time.gmtime(now))}\"", "    return HIST", "доминация: история до сегодня, а не 10 дней"),
    ("\n                    and (cap[1] is None or _num(cap[1], CAP_MIN, CAP_MAX) is not None))", ")", "доминация: вчерашняя капитализация в копии — годная"),
    ("                if time.monotonic() > end:\n                    return None\n", "", "доминация: весь ответ — не дольше срока"),
    ("        _st.loaded = True\n        # Перезапуск", "        # Перезапуск", "доминация: копии с диска — один раз, а не на каждый запрос"),
    ("    out[\"usdt\"] = u if u is None or u <= 100 - _pct(btc) else None", "    out[\"usdt\"] = u", "доминация: USDT — не больше 100 − BTC"),
    ("        return _spent().get(day, 0) + cost <= DAY_BUDGET", "        return _spent()[_today()] + cost <= DAY_BUDGET", "доминация: полночь между проверками не роняет сборку"),
]

DMT = [
    ("(v >= 75 ? 2 : v <= 25 ? 0 : 1)", "(v > 75 ? 2 : v <= 25 ? 0 : 1)", "альтсезон: 75 — уже альтсезон"),
    ("(v >= 75 ? 2 : v <= 25 ? 0 : 1)", "(v >= 75 ? 2 : v < 25 ? 0 : 1)", "альтсезон: 25 — уже сезон биткоина"),
    ("at + 2 * DAY) || ts % DAY !== 0 || ts <= prev)", "at + 2 * DAY) || ts <= prev)", "альтсезон: день — с начала суток"),
    ("at + 2 * DAY) || ts % DAY !== 0 || ts <= prev)", "at + 2 * DAY) || ts % DAY !== 0 || ts < prev)", "альтсезон: дни без повторов"),
    ("|| !Number.isInteger(idx)", "", "альтсезон: индекс — целое"),
    ("if ((idx === null) !== (n === null) || ", "if (", "альтсезон: индекс и корзина — вместе"),
    ("!within(n, MIN_BASKET, COINS_MAX)", "!within(n, 0, COINS_MAX)", "альтсезон: корзина — не меньше MIN_BASKET"),
    ("r.length !== 6", "r.length < 5", "альтсезон: день — ровно 6 колонок"),
    ("btc[0] + eth[0] > 100 || ", "", "доминация: BTC + ETH не больше 100"),
    ("Math.abs(btc[0] + alt[0] - 100) > 0.02", "false", "доминация: альты = 100 − BTC"),
    ("!within(cap[0], 1e10, 1e15)) return null;", "!within(cap[0], 0, 1e30)) return null;", "доминация: капитализация правдоподобна"),
    ("const usdt = within(raw[\"usdt\"], 0, 100 - btc[0])", "const usdt = within(raw[\"usdt\"], 0, 1e9)", "доминация: USDT не больше альтов"),
    ("const altNs = within(raw[\"alt_ns\"], 0, alt[0])", "const altNs = within(raw[\"alt_ns\"], 0, 1e9)", "доминация: альты без стейблов не больше альтов"),
    ("ts % DAY !== 0 || ts <= prev) return [];", "ts <= prev) return [];", "доминация: день истории — с начала суток"),
    ("(eth !== null && !within(eth, 0, 100 - btc))) return [];", "false) return [];", "доминация: в истории ETH + BTC не больше 100"),
    ("  return out.length >= 2 ? out : [];", "  return out;", "доминация: история — от двух дней"),
    ("for (let i = h.length - 1; i >= 0; i--) if (h[i]![0] <= t) return h[i]!;", "for (let i = h.length - 1; i >= 0; i--) if (h[i]![0] < t) return h[i]!;", "доминация: точка ровно n суток назад"),
    ("return h.filter((d) => d[0] > last[0] - Number(range) * DAY);", "return h;", "доминация: окно истории"),
    ("&& within(t[2], 0, t[0]) && Number.isInteger(t[2]))", "&& within(t[2], 0, 1e9))", "альтсезон: ширина — монет не больше корзины"),
    ("typeof c[0] === \"string\" && COIN.test(c[0])", "typeof c[0] === \"string\"", "альтсезон: имя монеты — только буквы и цифры"),
    ("if (s[i]![0] <= t) return s[i]!;", "if (s[i]![0] < t) return s[i]!;", "альтсезон: точка ровно n суток назад"),
    ("  while (i > 0 && seasonOf(s[i - 1]![1]) === zone) i--;\n", "", "альтсезон: сколько подряд в зоне"),
    ("(p) => p[0] > last[0] - 365 * DAY", "(p) => p[0] > 0", "альтсезон: максимум и минимум — за год"),
    ("  if (tail !== undefined && out[out.length - 1] !== tail) out.push(tail);\n", "", "альтсезон: последняя точка графика"),
    ("coins.filter((c) => c[1] > btc90)", "coins.filter((c) => c[1] >= btc90)", "альтсезон: вровень с биткоином — не обогнал"),
    ("p[1] > 0 ? (last[1] / p[1] - 1) * 100 : null", "p[1] > 0 ? (last[1] / p[1]) * 100 : null", "альтсезон: рост в процентах"),
    ("  return Math.max(0, Math.floor((now - last) / DAY));", "  return Math.floor((now - last) / DAY);", "альтсезон: возраст данных не отрицательный"),
    ("for (let i = s.length - 1; i >= 0; i -= n) out.push(s[i]!);", "for (let i = s.length - 1; i >= 0; i -= 1) out.push(s[i]!);", "альтсезон: таблица — раз в неделю"),
    ("if (!prev || prev[0] - d[0] >= 7 * DAY) out.push(d);", "if (!prev || prev[0] - d[0] > 7 * DAY) out.push(d);", "доминация: таблица — ровно раз в неделю"),
    ("if (!prev || prev[0] - d[0] >= 7 * DAY) out.push(d);", "out.push(d);", "доминация: таблица — не каждый день"),
    ("  return lo > 0 && t - times[lo - 1]! <= times[lo]! - t ? lo - 1 : lo;", "  return lo;", "графики: ближайшая по времени точка, а не следующая"),
    ("!within(ts, PX_FROM, at + 2 * DAY)", "!within(ts, PX_FROM, Infinity)", "альтсезон: день не позже времени ответа"),
    ("!within(ts, MCAP_FROM, at + DAY)", "!within(ts, MCAP_FROM, Infinity)", "доминация: день истории не позже времени ответа"),
    ('raw["ok"] !== true || !within(raw["at"], PX_FROM, now + CLOCK_LAG)) return null;\n  const rows', 'raw["ok"] !== true) return null;\n  const rows', "альтсезон: время ответа правдоподобно"),
]

# Общие ответы /api/dom и /api/mcap по HTTP и раздел «Рынок» дайджеста (whale_api.py).
AP = [
    ("        if hit is None or hit[0] is not obj:\n", "        if True:\n", "доминация: ответ кодируется раз, а не на каждый запрос"),
    ('        same = tag in [x.strip() for x in (self.headers.get("If-None-Match") or "").split(",")]', "        same = False", "доминация: та же копия — 304"),
    ('        same = tag in [x.strip() for x in (self.headers.get("If-None-Match") or "").split(",")]', "        same = True", "доминация: чужая копия — полный ответ"),
    ('        self.send_header("ETag", tag)\n', "", "доминация: ETag в ответе"),
    ('        self.send_header("Cache-Control", "no-cache")\n', '        self.send_header("Cache-Control", "no-store")\n', "доминация: копию можно держать и сверять"),
    ("        if cap_y:\n", "        if True:\n", "дайджест: без вчерашней капитализации — без изменения"),
    ('"d1": round(btc - btc_y, 2)', '"d1": round(btc_y - btc, 2)', "дайджест: изменение доминации за сутки со знаком"),
]


# Биткоин-часть сервера (wt_btc.py): потоки бирж, крупные ордера, рейтинг, кошелёк.
BT = [
    # Чистка досок.
    ('parts = ["NOT EXISTS (SELECT 1 FROM btc_labels l WHERE l.address = m.wallet)"]', "parts = [\"1\"]", "адрес биржи — не трейдер"),
    ("s.txs >= {BTC_SERVICE_TXS})", "s.txs > {BTC_SERVICE_TXS})", "сервис — от тысячи транзакций"),
    ('            svc = f"({svc} AND NOT EXISTS (SELECT 1 FROM btc_watch w WHERE w.address = m.wallet))"\n', "", "кошелёк базы — не сервис"),
    ("AND fund NOT LIKE '#%'", "AND 1", "группа без имени — без метки фонда"),
    ('out[r["address"]]["base"] = True', 'out[r["address"]]["base"] = False', "кошелёк базы помечен"),
    ('bal=round(int(r["bal_sats"] or 0) / 1e8, 4)', 'bal=round(int(r["bal_sats"] or 0) / 1e9, 4)', "остаток в биткоинах"),
    # Цена.
    ("if r and now() - int(r[\"ts\"] or 0) < 7200:", "if r:", "старая цена блока — не цена"),
    ("if r and now() - int(r[\"ts\"] or 0) < 7200:", "if r and now() - int(r[\"ts\"] or 0) < 7000:", "блок моложе двух часов — свежий"),
    ("return p if math.isfinite(p) and 1000 < p < 10_000_000 else 0.0", "return p", "цена Coinbase проверяется"),
    ('cached_small(_BTC, "spot", 60.0, _spot_fetch)', "_spot_fetch()", "Coinbase — раз в минуту"),
    # Потоки бирж.
    ("            since = t - sec\n", "            since = t - sec - 3600\n", "окно потока — ровно его длина"),
    ('"net": round(tout - tin, 4)', '"net": round(tin - tout, 4)', "чистый вывод — вывод минус завод"),
    ("key=lambda e: -(e[\"in\"] + e[\"out\"]))", "key=lambda e: e[\"in\"] + e[\"out\"])", "крупные биржи первыми"),
    ("            start = max(since, int(first or since))\n", "            start = since\n", "линия — от первого блока"),
    ('"full": bool(first and first <= since + 600),\n            }', '"full": True,\n            }', "неполное окно помечено"),
    ('"labels": int(labels or 0)', '"labels": 0', "число адресов бирж"),
    # Крупные ордера.
    ('keep = {1: "w.s < 0.9 * w.b", 2: "w.b < 0.9 * w.s"}', 'keep = {1: "1", 2: "w.b < 0.9 * w.s"}', "транзит — не покупатель"),
    ('keep = {1: "w.s < 0.9 * w.b", 2: "w.b < 0.9 * w.s"}', 'keep = {1: "w.s < 0.9 * w.b", 2: "1"}', "транзит — не продавец"),
    ("FROM btc_moves WHERE ts >= ? AND ex != '' GROUP BY wallet) \")", "FROM btc_moves WHERE ts >= ? GROUP BY wallet) \")", "перевод без биржи — не транзит"),
    ("m.ts >= ? AND m.kind = ? AND m.ex != '' AND m.sats >= ?", "m.ts >= ? AND m.kind = ? AND m.ex != '' AND m.sats > ?", "порог включительно"),
    ('                 + (" AND m.ex = ?" if ex else ""))', "                 + \"\")", "фильтр биржи: список"),
    ("mine = [r for r in agg if r[\"kind\"] == k and (not ex or r[\"ex\"] == ex)]", "mine = [r for r in agg if r[\"kind\"] == k]", "фильтр биржи: итог"),
    ("for r in agg if r[\"kind\"] == kind),", "for r in agg),", "список бирж — своей стороны"),
    ("key=lambda e: -e[\"btc\"])", "key=lambda e: e[\"btc\"])", "список бирж — крупные первыми"),
    ("(m.kind = 1 AND {keep[1]}) OR (m.kind = 2 AND {keep[2]})", "(m.kind = 1) OR (m.kind = 2 AND {keep[2]})", "итог покупок — без транзита"),
    ("    return 300.0 if win in (\"7d\", \"30d\") else BTC_TTL", "    return BTC_TTL", "неделя и месяц — раз в пять минут"),
    ("             for w in BIG_WINDOWS for side in (\"buy\", \"sell\")]", "             for w in BIG_WINDOWS for side in (\"buy\",)]", "прогрев — обе стороны"),
    ("ORDER BY m2.sats DESC LIMIT 1) txid", "ORDER BY m2.sats LIMIT 1) txid", "ссылка — на самую крупную транзакцию"),
    ("GROUP BY m.wallet, m.ex ORDER BY sats DESC, ts DESC LIMIT ?", "GROUP BY m.wallet, m.ex ORDER BY ts DESC LIMIT ?", "крупнейшие строки первыми"),
    ("COUNT(DISTINCT m.wallet) w", "COUNT(m.wallet) w", "разные кошельки биржи"),
    ("    if ex and ex not in _btc_ex_names():\n        ex = \"\"\n", "", "фильтр — только биржи разметки"),
    ('    win = win if win in BIG_WINDOWS else "24h"', "    win = win if win in BIG_WINDOWS else \"7d\"", "окно по умолчанию — сутки"),
    ("    min_btc = min_btc if min_btc in BTC_BIG_MIN else BTC_BIG_MIN[0]", "    min_btc = min_btc if min_btc else BTC_BIG_MIN[0]", "порог — из списка"),
    # Итог кошелька.
    ("            if p and p < px:", "            if p and p <= px:", "в плюсе — строго дешевле"),
    ("                s = min(q, held)", "                s = q", "продано не больше запаса"),
    ("                realized += s * (p - avg)", "                realized += s * (p - avg) * 2", "зафиксированный результат"),
    ("    pnl = realized + (held * px - cost if px else 0.0)", "    pnl = realized + (held * px - cost)", "без цены — без открытого результата"),
    ("    if not buys or not invested:\n        return None", "    if not invested:\n        return None", "без покупок — не трейдер"),
    ('"pnl": round(pnl, 2) + 0.0,', '"pnl": round(pnl, 2),', "минус у нуля"),
    ('"ex": max(exs, key=lambda k: exs[k]) if exs else ""', '"ex": min(exs, key=lambda k: exs[k]) if exs else ""', "главная биржа — по объёму"),
    # Рейтинг.
    ("WHERE ts >= ? AND price_nanos > 0 AND m.ex != '' AND {_btc_clean(con)} ", "WHERE ts >= ? AND m.ex != '' AND {_btc_clean(con)} ", "рейтинг: без цены — не сделка"),
    ("WHERE ts >= ? AND price_nanos > 0 AND m.ex != '' AND {_btc_clean(con)} ", "WHERE ts >= ? AND price_nanos > 0 AND {_btc_clean(con)} ", "рейтинг: перевод — не сделка"),
    ('"roi": sorted(books, key=lambda b: (-b["roi"], -b["btc"]))', '"roi": sorted(books, key=lambda b: (-b["pnl"], -b["btc"]))', "доска ROI — по ROI"),
    ('"act": sorted(books, key=lambda b: (-b["btc"], -b["pnl"]))', '"act": sorted(books, key=lambda b: (-b["pnl"], -b["btc"]))', "доска накопления — по запасу"),
    ("    return 120.0 if days <= 30 else 600.0", "    return 120.0", "длинные окна — раз в десять минут"),
    ("    days = days if days in BTC_RANK_DAYS else 30", "    days = days if days > 0 else 30", "окно рейтинга — из списка"),
    # Кошелёк.
    ('for r in rows if int(r["price_nanos"] or 0) > 0 and r["ex"]], px)', 'for r in rows], px)', "кошелёк: итог — по сделкам с биржей"),
    ("for r in reversed(rows[-50:])]", "for r in rows[:50]]", "кошелёк: последние движения первыми"),
    ('cached_small(_BTC, ("wallet", addr), BTC_TTL', 'cached_small(_BTC, ("wallet", ""), BTC_TTL', "кошелёк: кэш по адресу"),
    ('        con.execute("INSERT OR REPLACE INTO btc_case(lower, addr) VALUES(?,?)", (addr.lower(), addr))',
     '        con.execute("INSERT OR REPLACE INTO btc_case(lower, addr) VALUES(?,?)", (addr, addr))', "написание — по строчному ключу"),
]


# Байткод испорченного файла — стереть до проверки и после: мутант и исходник
# часто одной длины и пишутся в одну секунду, и Python брал бы из __pycache__
# байткод прошлой версии — мутант «выживал» бы ложно, а после проверки там
# оставался бы испорченный код. Остальной байткод не трогаем: без него каждый
# запуск заново компилировал бы весь сервер.
def drop_pyc(path):
    stem = os.path.splitext(os.path.basename(path))[0]
    cache = os.path.join(os.path.dirname(path), "__pycache__")
    for f in os.listdir(cache) if os.path.isdir(cache) else []:
        if f.startswith(stem + ".") and f.endswith(".pyc"):
            os.remove(os.path.join(cache, f))


# Исходники, которые сейчас испорчены: прерывание (Ctrl+C, timeout, отмена в
# CI) возвращает их на место, а не оставляет мутанта в рабочей копии.
ORIG = {}


def restore_and_exit(signum, frame):
    for path, src in list(ORIG.items()):
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
        drop_pyc(path)
    os._exit(128 + signum)


signal.signal(signal.SIGTERM, restore_and_exit)
signal.signal(signal.SIGINT, restore_and_exit)


def run(path, cmd, muts):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    ORIG[path] = src
    drop_pyc(path)
    # Без порчи тесты обязаны проходить: иначе любая мутация «убита» ложно.
    if subprocess.run(cmd, cwd=ROOT, capture_output=True, timeout=300, check=False).returncode != 0:
        sys.exit(f"тесты красные и без мутаций: {' '.join(cmd)}")
    alive = []
    try:
        for a, b, name in muts:
            if src.count(a) != 1:
                sys.exit(f"мутация «{name}»: текст для замены найден {src.count(a)} раз — обновите список")
            with open(path, "w", encoding="utf-8") as f:
                f.write(src.replace(a, b))
            drop_pyc(path)
            # Тесты зависли (мутант пустил запрос в сеть, и тот ждёт) — порча
            # замечена: убита, а не сбой проверки.
            try:
                killed = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300, check=False).returncode != 0
            except subprocess.TimeoutExpired:
                killed = True
            print(("убита   " if killed else "экв.    " if name in EQUIV else "ВЫЖИЛА  ") + name, flush=True)
            if not killed and name not in EQUIV:
                alive.append(name)
    finally:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
        drop_pyc(path)
        ORIG.pop(path, None)
    return alive


def server():
    # wt_etf и wt_treasury — по очереди: тесты сервера читают оба файла.
    return (run(f"{ROOT}/wt_etf.py", [sys.executable, "-m", "unittest", "tests.test_etf_api", "tests.test_etf_fuzz",
                                      "tests.test_etf_security", "tests.test_etf_policy", "tests.test_disk_cache"], PY)
            + run(f"{ROOT}/wt_treasury.py", [sys.executable, "-m", "unittest", "tests.test_treasury",
                                             "tests.test_treasury_security", "tests.test_disk_cache"], TR)
            + run(f"{ROOT}/whale_api.py", [sys.executable, "-m", "unittest", "tests.test_etf_day_alert"], AL)
            + run(f"{ROOT}/whale_api.py", [sys.executable, "-m", "unittest", "tests.test_dom_http", "tests.test_digest_sources"], AP)
            + run(f"{ROOT}/wt_dom.py", [sys.executable, "-m", "unittest", "tests.test_dom", "tests.test_dom_fuzz",
                                        "tests.test_dom_policy"], DM)
            + run(f"{ROOT}/wt_mcap.py", [sys.executable, "-m", "unittest", "tests.test_mcap", "tests.test_mcap_fuzz"], MC)
            + run(f"{ROOT}/wt_btc.py", [sys.executable, "-m", "unittest", "tests.test_btc", "tests.test_btc_stale",
                                        "tests.test_btc_etf_labels"], BT))


# Приложение и сервер — одновременно: тесты приложения (node) читают только
# lib/etf.ts, тесты сервера — только Python, друг другу они не мешают.
with ThreadPoolExecutor(max_workers=2) as pool:
    app = pool.submit(run, f"{ROOT}/src/lib/etf.ts", ["node", "--test", "tests/etf.test.ts", "tests/etf.props.test.ts"], TS)
    srv = pool.submit(server)
    dmt = pool.submit(run, f"{ROOT}/src/lib/dom.ts", ["node", "--test", "tests/dom.test.ts", "tests/dom.props.test.ts"], DMT)
    alive = app.result() + srv.result() + dmt.result()
total = len(TS) + len(PY) + len(TR) + len(AL) + len(AP) + len(DM) + len(MC) + len(DMT) + len(BT) - len(EQUIV)
print(f"ИТОГ: убито {total - len(alive)} из {total}; выжили: {alive}")
sys.exit(1 if alive else 0)
