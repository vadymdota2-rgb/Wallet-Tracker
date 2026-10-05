#!/usr/bin/env python3
"""Статический сторож проекта: бот WhaleScanner и мини-апп вместе.

    python3 tools/guard.py ../WhaleScanner

Ловит не опечатки, а возвращение уже исправленных ошибок. Каждая проверка
стоит на месте настоящей поломки. Половина правил живёт в боте, половина
здесь, и связаны они не типами, а договорённостями — проверить это можно
только по исходникам обоих, поэтому путь к боту — аргумент, как у
sync-i18n.py.
"""
import json, os, re, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(APP), "WhaleScanner")
if not os.path.isdir(BOT):
    sys.exit(f"нет каталога бота: {BOT}\nзовите так: python3 tools/guard.py ../WhaleScanner")
bad = 0


def say(name, cond, extra=""):
    global bad
    if cond:
        print("ok ", name)
    else:
        bad += 1
        print("BAD", name, extra)


def read(p):
    return open(p, encoding="utf-8").read()


api = read(f"{APP}/whale_api.py")
labels = read(f"{APP}/src/lib/labels.ts")
live = read(f"{APP}/src/store/live.ts")


def body(src, sign):
    """Тело функции C++: от подписи до закрывающей скобки в нулевой колонке."""
    at = src.index(sign)
    return src[at:src.index("\n}\n", at)]


def code_only(src):
    """Без пояснений: в них имена старых ошибок названы нарочно.

    Сторож ищет ошибку, а не рассказ о ней. Без этого проверка «в счётчике
    нет лишнего условия» спотыкалась о комментарий, который объясняет, какое
    условие оттуда убрали.
    """
    src = re.sub(r'"""(?:.|\n)*?"""', "", src)
    return "\n".join(re.sub(r"#.*$", "", l) for l in src.split("\n"))


def pybody(src, sign):
    """Тело функции на питоне: от def до следующего def в нулевой колонке."""
    at = src.index(sign)
    m = re.search(r"\n(?=def |[A-Z_]+ = )", src[at + len(sign):])
    return src[at:at + len(sign) + (m.start() if m else len(src))]


# --- лонг/шорт считает всё движение денег -----------------------------------
# Считались одни открытия, и карточка показывала «96% в лонге» в час, когда
# киты лонги как раз распродавали: закрытие позиции — такая же сделка на
# рынке, как открытие, и ликвидация тоже.
ls = code_only(pybody(api, "def ls_scan("))
say("вверх тянут открытый лонг, закрытый шорт и вынесенный шорт",
    "dir_code IN (1,4,7)" in ls)
say("вниз — открытый шорт, закрытый лонг и вынесенный лонг",
    "dir_code IN (2,3,6)" in ls)
say("одних открытий больше не осталось", "dir_code IN (1,2) " not in ls)
# Направление переворота в dir_code потеряно: и «Long > Short», и
# «Short > Long» записаны пятёркой. Исходный текст лежит в колонке dir.
say("направление переворота берётся из текста",
    "dir LIKE '%Short > Long%'" in ls and "dir LIKE '%Long > Short%'" in ls)
say("нет колонки dir — перевороты просто не считаются",
    'has_dir = "dir" in cset' in ls)
# Код 8 — ликвидация неизвестной стороны: приписывать её наугад хуже, чем
# пропустить.
say("ликвидация без стороны не приписывается никуда",
    "8" not in ls.split("WHERE ts >= ?")[1].split("GROUP BY")[0])
say("подпись обещает то, что считается",
    "Всё движение денег" in read(f"{APP}/src/i18n/ru.ts"))

# --- неизвестное изменение цены не выдаётся за ноль -------------------------
# У монеты может не быть истории вовсе: биржа не ответила, монета только
# появилась. Ноль на экране читается как «цена не двигалась» — утверждение, а
# не незнание, и рядом с графиком на восемь процентов это видно сразу.
coin_scr = read(f"{APP}/src/screens/CoinScreen.tsx")
say("запасная ветка отдаёт неизвестное, а не ноль",
    '"c1": None, "c6": None, "c24": None' in api and
    '"chg": 0.0, "hists": {}, "spark": [], "c1": 0' not in api)
say("`or 0` не превращает неизвестное в ноль",
    'pack.get("c1") or 0' not in api and 'sl.get("c1") or c.get("c1") or 0' not in api)
say("тип монеты допускает неизвестное",
    "c1: number | null;" in read(f"{APP}/src/lib/types.ts"))
say("экран монеты рисует прочерк",
    'v === null || v === undefined ? "—" : pct(v)' in coin_scr and
    "coin?.c1 ?? 0" not in coin_scr)
say("прочерк не красится ни в плюс, ни в минус",
    'v === null || v === undefined ? undefined : v >= 0 ? "up" : "dn"' in coin_scr)

# --- число не теряет хвост, сумма не слипается ------------------------------
# «+157 …» по обрезку не отличить от ста пятидесяти семи тысяч, а «-$5,76M» с
# «4 кошельков» вплотную читались как «5,76M4» — у класса суммы не было ни
# одной строки стилей.
css = read(f"{APP}/src/styles/app.css")
ui = read(f"{APP}/src/components/ui.tsx")
fmt = read(f"{APP}/src/lib/format.ts")
say("у суммы потока есть разметка", ".flow-sum {" in css and "justify-content: space-between" in css.split(".flow-sum {")[1][:200])
say("длинное значение плитки мельчает, а не режется",
    "function tileFit(" in ui and ".tile b.l3" in css)
say("на сотнях процентов десятые не нужны", "Math.abs(v) >= 100 ? 0 : digits" in fmt)

# --- замки подписки стоят на сервере, а не только на экране -----------------
# Раньше сервер отдавал бесплатному все сто мест доски, перпы Hyperliquid,
# фандинг и позиции кошельков, а приложение их просто не рисовало — и то не
# везде: рейтинг перпов и позиции были видны. Бот всё это закрывает.
say("срез по подписке есть", "def for_plan(data: dict, prem: bool) -> dict:" in api)
fp = pybody(api, "def for_plan(")
say("без Премиума выгрузка — только план, цены и подарок",
    'PLAN_OPEN_KEYS = ("ok", "live", "error", "me", "pay", "gift", "partial", "cachedAt")' in api
    and "return {k: v for k, v in data.items() if k in PLAN_OPEN_KEYS}" in fp)
say("старых срезов бесплатного тарифа на сервере нет",
    not any(x in api for x in ("FREE_DELAY_SEC", "RANK_FREE_DEPTH", "PERP_SHOWCASE", "FREE_BIG_WINDOWS",
                               "FREE_FLOW_WINDOWS", "FREE_DEALS", "FREE_ALERT_WALLETS", "DIGEST_PREMIUM", "reactN")))
say("числа: 3 кошелька и алерты с 1 у бота, проба 14 дней — одни у API, бота и приложения",
    "FREE_MAX_WALLETS = 3" in api and "TRIAL_DAYS = 14" in api
    and "constexpr size_t FREE_ALERT_WALLETS = 1;" in read(f"{BOT}/telegram.h")
    and "constexpr size_t FREE_MAX_WALLETS    = 3;" in read(f"{BOT}/premium.cpp")
    and "loadedForUser >= FREE_ALERT_WALLETS" in read(f"{BOT}/main.cpp")
    and "wallets: 3," in read(f"{APP}/src/lib/upsell.ts") and "trialDays: 14," in read(f"{APP}/src/lib/upsell.ts"))
say("срез не трогает Cortex", "cortex" not in code_only(fp).lower() and "sonar" not in fp)
say("выгрузка срезается по своему же плану", "for_plan(boot, plan_of(boot))" in api)
say("выгрузка без подписи — пустая: приложение покажет замок",
    'self._json(200, {"ok": True, "live": True})' in api)
say("данные — только с Премиумом, одним правилом на все запросы",
    "if path in PAID_PATHS and not chat_premium(self._user(qs)):" in api
    and api.count('self._json(403, {"ok": False, "error": "premium"})') == 1
    and all(f'"{x}"' in api.split("PAID_PATHS = frozenset(")[1][:900]
            for x in ("flow", "fund", "rot", "ls", "deals", "wallet", "big", "btc/big", "btc/rank", "liqmap",
                      "unlocks", "digest", "quotes"))
    and not any(f'"{x}"' in api.split("PAID_PATHS = frozenset(")[1][:900]
                for x in ("bonus", "token-launch", "ref", "bootstrap", "health")))
top = read(f"{APP}/src/screens/TopTab.tsx")
say("доски — до 100 мест, без витрин и замков",
    "FREE.premiumTop" in top and '"up_perp"' not in top and "perpN" not in top and "usePremium" not in top and "me.plan" not in top)
say("позиции без замка", not os.path.exists(f"{APP}/src/components/PremiumLock.tsx")
    and "PremiumLock" not in read(f"{APP}/src/screens/PositionScreen.tsx")
    and "PremiumLock" not in read(f"{APP}/src/screens/WalletScreen.tsx"))
ana = read(f"{APP}/src/screens/AnalyticsTab.tsx")
_fscr = read(f"{APP}/src/screens/FundingScreen.tsx")
say("аналитика и фандинг без внутренних замков, фандинг — в боковом меню",
    "prem: true" not in ana and "premium" not in ana and 'id: "fund"' not in ana
    and "<FundBody />" in _fscr and "premium" not in _fscr)
prem_scr = read(f"{APP}/src/screens/PremiumScreen.tsx")
say("цена на экране премиума — один раз, на кнопке",
    'title={t(lang, "pay_stars_btn")} value=' not in prem_scr and 'title={t(lang, "pay_usdt_btn")} value=' not in prem_scr)
say("оплата выше описания", prem_scr.index('className="stack-actions"') < prem_scr.index('"pr_includes"'))
say("экран Премиума без сравнения с бесплатным тарифом",
    '"pr_free_digest_d"' not in prem_scr and 'className="cmp"' not in prem_scr and "HARD_PAYWALL" not in prem_scr
    and '"pr_perk_all_t"' in prem_scr)

# --- при запуске подгружается всё ------------------------------------------
pre = read(f"{APP}/src/lib/prefetch.ts")
sync = read(f"{APP}/src/lib/sync.ts")
say("подгрузка запускается после выгрузки", "setTimeout(() => void prefetchAll(), 400);" in sync)
say("подгрузка берёт кошельки, окна, фильтры, сделки, монеты",
    all(x in pre for x in ("fetchWallet(w.addr)", "BIG_WINS", 'fetchFlow(app.flowWin, "", 0, side)',
                           "fetchDeals(r.a, venue, FREE.premiumDeals)", "holdJobs()")))
say("без Премиума подгрузки нет", 'if (live.me.plan !== "premium") return jobs;' in pre)
say("запросы в очереди, не лавиной", "const PARALLEL = 4;" in pre)
apits = read(f"{APP}/src/lib/api.ts")
say("чтения идут через память", apits.count("cachedGet<") >= 7 and "remember<T | null>(path, ttl" in apits)
say("смена плана стирает память", "forgetAll()" in live)

# --- «Ещё» без второй дороги к позициям -------------------------------------
more = read(f"{APP}/src/screens/MoreTab.tsx")
say("открытые позиции — только в кошельке",
    'open("positions")' not in more and '"menu_positions"' not in read(f"{APP}/src/App.tsx")
    and not os.path.exists(f"{APP}/src/screens/PositionsScreen.tsx"))
say("порога алертов во «Ещё» нет — он в «Моих кошельках»",
    'open("threshold")' not in more and "menu_alert_threshold" not in more
    and 'open("threshold")' in read(f"{APP}/src/screens/WalletsTab.tsx"))

# --- кнопка обновления не выпадает из шапки ---------------------------------
# Голое состояние «boot» совпадало с классом заставки .boot (position: fixed),
# и до первой выгрузки кнопка уезжала в левый верхний угол поверх меню.
appx = read(f"{APP}/src/App.tsx")
# Кнопки «обновить» больше нет (на её месте значок Премиума) — и класса
# с голым состоянием, совпадавшего с классом заставки, тоже.
say("в шапке нет класса с голым состоянием (совпадал с классом заставки)", "refresh ${status}" not in appx and "refresh st-" not in appx)

# --- сервисный аккаунт бота — без Премиума, но база кошельков без лимита ----
# Бот считает его премиумом без срока и без лимита кошельков (isPremium в
# premium.cpp). API этого не знал, и приложение ставило его кошельки на паузу.
main_cpp = read(f"{BOT}/main.cpp")
svc = re.search(r'SERVICE_CHAT_ID = "(\d+)"', main_cpp)
say("номер сервисного аккаунта в API совпадает с ботом",
    bool(svc) and f'"WHALE_SERVICE_CHAT", "{svc.group(1)}"' in api)
_prem_cpp = read(f"{BOT}/premium.cpp")
say("сервисный — без Премиума нигде и никогда, но без лимита кошельков",
    'if not chat or is_service(chat) or not table_exists(con, "users"):' in api
    and 'plan, prem_until = "free", 0' in api and "if is_service(chat):\n        return False" in api
    and 'if is_service(chat) and (path.startswith("/api/pay/") or path.startswith("/api/bonus/")):' in api
    and "return SERVICE_MAX_WALLETS" in api and '"service": service,' in api
    and "chatId == g_serviceChatId) return false;" in _prem_cpp and "out.erase(g_serviceChatId);" in _prem_cpp
    and "UPDATE users SET is_premium=0, premium_expire=0 WHERE chat_id=?" in _prem_cpp
    and "uid != SERVICE_CHAT_ID && loadedForUser >= FREE_ALERT_WALLETS" in read(f"{BOT}/main.cpp")
    and "(chatId != SERVICE_CHAT_ID)\n                            ? premiumMaxWallets(chatId) : 0;" in read(f"{BOT}/wallets.cpp"))
say("сервисный в приложении — как обычный аккаунт без Премиума (замок, оплата, бонусы)",
    not any("service" in read(f"{APP}/src/{f}") for f in ("components/LockScreen.tsx", "screens/PremiumScreen.tsx",
                                                           "screens/MoreTab.tsx", "screens/BonusScreen.tsx")))
say("приложение не ставит сервисному паузу и лимит",
    "walletLimit(me.service)" in read(f"{APP}/src/screens/WalletsTab.tsx")
    and "return service ? Infinity : FREE.premiumWallets;" in read(f"{APP}/src/store/app.ts"))

# --- данные приходят сами, без «обновить» ------------------------------------
tg = read(f"{APP}/src/lib/telegram.ts")
say("подпись берётся из адреса запуска, не ждёт скрипт Telegram",
    'get("tgWebAppData")' in tg and "webApp()?.initData || LAUNCH" in tg and "if (webApp() || LAUNCH)" in tg)
say("первый заход на сервере — быстрая выгрузка, полная в фоне",
    "data = _boot_build(key, fast=True)" in api and 'errors.append("coins:later")' in api)
say("приложение переспрашивает за быстрой выгрузкой через секунды",
    'data.partial.includes("coins:later")' in sync and "SOON_DELAY" in sync)
say("повтор после сбоя — через секунды, серия считается отдельно",
    "const MIN_DELAY = 3_000;" in sync and "MIN_DELAY * 2 ** fails" in sync)

# --- история алертов и «только в приложении» ---------------------------------
mq = read(f"{BOT}/message_queue.cpp")
say("бот: «только в приложении» пишет в историю, но не в очередь Telegram",
    "appOnly.count(c) ? DELIVERY_APP_ONLY : 0" in mq and "constexpr int DELIVERY_APP_ONLY = 6;" in mq
    and "if (!appOnly.count(c)) batchSize++;" in mq)
say("бот: очередь Telegram берёт только ждущие отправки",
    "WHERE d.status IN (0,3) AND d.next_retry_at<=?" in mq)
say("бот: такие доставки чистятся со всеми", main_cpp.count("status IN (1,2,4,6)") == 2)
say("бот и API заводят одни и те же колонки",
    all(f"{n} {d}" in main_cpp and f'("{n}", "{d}")' in api
        for n, d in (("alert_tg", "INTEGER NOT NULL DEFAULT 1"), ("alerts_seen_at", "INTEGER NOT NULL DEFAULT 0"))))
say("API: прочитано — по последнему показанному, не назад",
    "MAX(alerts_seen_at, ?)" in api and "upto = min(upto, now())" in api)
say("«Ещё» начинается с истории алертов",
    more.index('open("alerts")') < more.index('open("premium"'))

# --- помощь называет вкладки так же, как приложение ------------------------
# Тексты помощи собраны с подстановкой названий из словаря каждого языка. Если
# вкладку переименуют, а помощь нет — инструкция начнёт говорить о разделах,
# которых человек не найдёт.
def ts_dict(lang):
    src = read(f"{APP}/src/i18n/{lang}.ts")
    return {m.group(1): json.loads(m.group(2)) for m in re.finditer(r'^\s+(\w+): (".*"),?$', src, re.M)}
def bare_label(v):
    return re.sub(r"^[\U0001F000-\U0001FFFF\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\s]+", "", v).strip() or v
help_ok = []
for lg in ("en","ru","es","pt","fr","tr","ar","pl","de","uk","hi","id","vi","ko","zh","ja"):
    d = ts_dict(lg)
    ok = (d.get("hp_g_wallets_t") == bare_label(d["menu_my_wallets"]) and d.get("hp_g_top_t") == bare_label(d["menu_top_traders"])
          and d.get("hp_g_an_t") == bare_label(d["menu_big_trades"]) and d.get("hp_g_more_t") == bare_label(d["ui_more"])
          and bare_label(d["menu_add_wallet"]) in d.get("hp_s1_d", "") and bare_label(d["alerts_title"]) in d.get("hp_s3_d", ""))
    if not ok:
        help_ok.append(lg)
say("помощь называет вкладки и кнопки как приложение, на всех языках", not help_ok, str(help_ok))
say("помощь — руководство, а не обрезанные строки меню",
    "help_menu_add" not in read(f"{APP}/src/screens/HelpScreen.tsx") and '"hp_faq_title"' in read(f"{APP}/src/screens/HelpScreen.tsx"))

# --- неделя премиума — только при первом открытии приложения --------------
say("бот по /start неделю не выдаёт", "TRIAL_DAYS" not in main_cpp and "grantPremiumDays(cid" not in main_cpp)
say("API выдаёт неделю при первом открытии, одной транзакцией",
    "gift = grant_trial(chat" in api and 'INSERT OR IGNORE INTO trial_granted(chat_id, granted_at)' in api
    and 'con.execute("BEGIN IMMEDIATE")' in pybody(api, "def grant_trial("))
say("помощь не обещает неделю за /start", all("/start" not in ts_dict(lg).get("hp_a4", "")
    for lg in ("en","ru","es","pt","fr","tr","ar","pl","de","uk","hi","id","vi","ko","zh","ja")))

# --- боковое меню: график TradingView и разлоки -----------------------------
_m0 = appx.index("= [", appx.index("const MENU:"))
menu = appx[_m0:appx.index("];", _m0)]
say("в боковом меню пять пунктов: график, разлоки, карта ликвидаций, фандинг, страх и жадность",
    menu.count("name:") == 7
    and menu.index('name: "chart"') < menu.index('name: "unlocks"') < menu.index('name: "liqmap"')
    < menu.index('name: "funding"') < menu.index('name: "fng"') < menu.index('name: "dom"') < menu.index('name: "etf"'))
tv = read(f"{APP}/src/lib/tradingview.ts")
chart_scr = read(f"{APP}/src/screens/ChartScreen.tsx")
say("график — официальный код виджета TradingView со сменой монеты",
    "external-embedding/embed-widget-advanced-chart.js" in tv and "allow_symbol_change: true" in tv
    and "widgetembed" not in tv + chart_scr)
say("атрибуция TradingView — как в их коде, не убрана",
    'span.textContent = "Track all markets on TradingView"' in chart_scr and 'a.href = "https://www.tradingview.com/"' in chart_scr
    and 'copy.className = "tradingview-widget-copyright"' in chart_scr)
say("монета графика запоминается", "tvSym: s.tvSym" in read(f"{APP}/src/store/app.ts"))

# --- поиск монеты на графике — по всем биржам, не только по своим ----------
say("справочник монет: Binance, Bybit, Hyperliquid и HIP-3",
    "def _symbols_build(" in api and "api.bybit.com/v5/market/instruments-info" in api
    and 'hl_post({"type": "meta"}' in pybody(api, "def _symbols_build(") and '"c": "rwa"' in api)
say("металлы и индексы HIP-3 — на свои символы TradingView, а не на акции-двойники",
    'GOLD: "TVC:GOLD"' in tv and 'SP500: "SP:SPX"' in tv)
say("введённый тикер открывается, даже если его нет в справочнике",
    "results[0]?.s !== typed" in chart_scr and 'onClick={() => pick(typed)}' in chart_scr)

# --- разлоки: свои расписания, только будущее, ближайшие первыми -----------
unl_scr = read(f"{APP}/src/screens/UnlocksScreen.tsx")
say("разлоки считаются по своей книге расписаний, у каждой монеты — источник",
    "UNLOCK_BOOK: list[dict] = [" in api and api.count('"src": "https://') >= 180)
say("оценочные объёмы помечены в приложении", '"est": bool(coin.get("est"))' in api and "unl_est" in unl_scr)
_ub = pybody(api, "def unlock_events(")
say("прошедшие разлоки не отдаются, ближайшие первыми",
    "if ts >= day0:" in _ub and 'sorted(out, key=lambda e: (e["ts"], e["sym"]))' in _ub
    and "events = unlock_events(now, book)" in pybody(api, "def _unlocks_build(")
    and "if e[\"ts\"] >= day0" in pybody(api, "def unlocks("))
_uu = pybody(api, "def _unlocks_build(")
say("разлоки ни от кого не зависят: оборот — наш расчёт, цена — Hyperliquid",
    "coingecko" not in (_ub + _uu).lower() and "get_json" not in _uu and "mids = hl_mids()" in _uu
    and '"circ": ("' in api and 'ev["circ"] = round(circ)' in _ub)
say("цена монеты без Hyperliquid — со спота, с кэшем и неудач тоже",
    'mids.get(e["sym"], 0.0) or spot.get(e["sym"], 0.0)' in _uu and "pool.map(spot_px, need)" in _uu and "_spot_px_cache[s] = (time.monotonic(), px)" in api)
say("давление — доля от оборота на день разлока", 'e["tokens"] / circ * 100' in _uu)
say("экран разлоков: поиск по тикеру и названию, фильтр крупных",
    "e.sym.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)" in unl_scr and "if (bigOnly &&" in unl_scr)
say("разлок и эмиссия различимы: метки, отдельный вид, раздельная сводка",
    'className="unl-tag u"' in unl_scr and 'className="unl-tag e"' in unl_scr
    and "function part(e: UnlockEvent, kind: Kind)" in unl_scr and "(emitMonth * days) / 30.44" in unl_scr)
_logos = read(f"{APP}/src/components/coin-logos.ts") + read(f"{APP}/src/components/coin-fallback.ts")
_no_icon = [c for c in re.findall(r'\{"s": "([A-Z0-9]+)", "n": ', api)
            if not os.path.exists(f"{APP}/html/coins/hl/{c}.svg") and f'"{c}": "/' not in _logos and f"  {c}: \"/" not in _logos
            or c in ("M", "A") and f"  {c}: \"/cglogo" not in _logos]
say("у каждой монеты календаря разлоков есть иконка", not _no_icon, str(_no_icon))
# Опорный оборот со временем уходит: стейкинг, сжигание, выдачи вне книги.
# Старше четырёх месяцев — пора сверить и обновить строку «circ».
import datetime as _dt
_stale = [f"{c}:{d}" for c, d in re.findall(r'\{"s": "([A-Z0-9]+)", "n": [^\n]*\n(?:[^\n]*\n)*?\s+"circ": \("(\d{4}-\d{2}-\d{2})"', api)
          if (_dt.date.today() - _dt.date.fromisoformat(d)).days > 120]
say("опорный оборот монет разлоков не старше 120 дней", not _stale, str(_stale))
# Застейканное меняется так же — снимок старше четырёх месяцев пора сверить.
# У монет, чей стейкинг сервер перечитывает сам (_stake_fetchers), снимок в
# книге — лишь запасной: ему можно стареть.
_fx = api[api.find("def _stake_fetchers"):api.find("def _stake_live_load")]
_live_syms = set(re.findall(r'"([A-Z0-9]+)": ', _fx))
_st_old = [f"{c}:{d}" for c, d in re.findall(r'\{"s": "([A-Z0-9]+)", "n": [^\n]*\n(?:[^\n]*\n)*?\s+"staked": \("(\d{4}-\d{2}-\d{2})"', api)
           if c not in _live_syms and (_dt.date.today() - _dt.date.fromisoformat(d)).days > 120]
_sup_at = re.search(r'UNLOCK_SUPPLY_AT = "(\d{4}-\d{2}-\d{2})"', api)
say("справочник выпуска (полный круг, FDV) сверен не позже 120 дней назад — tools/sync-supply.py",
    bool(_sup_at) and (_dt.date.today() - _dt.date.fromisoformat(_sup_at.group(1))).days <= 120)
say("стейкинг перечитывается из сетей сам, раз в 12 часов, с защитой от сбоев",
    'target=stake_live_refresher' in api and "snap[1] / 3 <= n <= snap[1] * 3" in api and len(_live_syms) >= 30)
say("снимок застейканного у монет разлоков не старше 120 дней", not _st_old, str(_st_old))
_apy_old = [f"{c}:{d}" for c, d in re.findall(r'\{"s": "([A-Z0-9]+)", "n": [^\n]*\n(?:[^\n]*\n)*?\s+"apy": \("(\d{4}-\d{2}-\d{2})"', api)
            if (_dt.date.today() - _dt.date.fromisoformat(d)).days > 120]
say("снимок доходности стейкинга не старше 120 дней", not _apy_old, str(_apy_old))
say("эмиссия без срока меряется по сети: выпуск пишется раз в сутки, через 7 дней факт заменяет оценку",
    "def _book_measured(" in api and '"measured": measured' in api and "SUPPLY_MIN_DAYS = 7" in api
    and "_supply_record(" in pybody(api, "def stake_live_refresh(") and 't(lang, "unl_emit_fact"' in unl_scr)
say("выдача XRP из депо Ripple меряется по истории леджера за полгода, а не угадывается",
    "def _xrp_escrow(" in api and '"XRP": "treasury"' in api and "_rate_record(" in pybody(api, "def stake_live_refresh(")
    and 't(lang, "unl_flow_fact"' in unl_scr)
say("карточка монеты начинается с вывода о давлении и объясняет термины",
    'className={`unl-verdict v${lvl}`}' in unl_scr and '"unl_q_pressure"' in unl_scr and 'className="unl-q"' in unl_scr)
say("разлок меряется днями всех торгов: объём с семи бирж, тезки отсеяны по цене",
    '"vol": spot_volumes(' in api and "abs(px / ref - 1) <= 0.15" in api and 't(lang, "unl_v_liq"' in unl_scr)
say("реакция цены на прошлые разлоки: медиана за неделю, против BTC, пересчёт раз в сутки",
    "def unlock_reactions(" in api and "statistics.median(moves)" in api and 'target=reactions_refresher' in api
    and 't(lang, "unl_v_react"' in unl_scr)
say("карточка коротко по умолчанию, подробно — по кнопке, выбор помнится",
    'className="unl-more-tg"' in unl_scr and 'localStorage.setItem(DETAIL_KEY' in unl_scr and 'className="unl-brief"' in unl_scr)
say("кривая оборота на три года и полная оценка (FDV) в карточке",
    "function SupplyCurve(" in unl_scr and "const LAYERS:" in unl_scr and 'className="unl-curve-legend"' in unl_scr and 't(lang, "unl_fdv")' in unl_scr and '"supply": {k: {"t": v[0], "m": v[1]}' in api)
say("карточка монеты рисует круг выпуска: на рынке, в стейкинге, кому ещё выйдет",
    "function SupplyRing(" in unl_scr and "<SupplyRing " in unl_scr and 't(lang, "unl_pie_note")' in unl_scr)
say("доходность стейкинга сравнивается с ростом выпуска", 'row["y"] = c["apy"][1]' in api and "stake.y - (emitYr / now) * 100" in unl_scr)
say("экран разлоков показывает застейканное, «нет стейкинга» и «нет данных» раздельно",
    '"stake": unlock_stakes()' in api and 'stake === undefined' in unl_scr and 't(lang, "unl_stake_none")' in unl_scr)
# Эмиссия давит на цену так же, как разлок: у каждой монеты книги она либо
# записана строкой «emission», либо монета названа в NO_EMISSION с причиной.
import importlib.util as _iu
_sp = _iu.spec_from_file_location("_wapi_emit", f"{APP}/whale_api.py")
_wm = _iu.module_from_spec(_sp); _sp.loader.exec_module(_wm)
_emit_bad = []
for _c in _wm.UNLOCK_BOOK:
    _has = any("emission" in st for st in _c["plan"])
    _no = _c["s"] in _wm.NO_EMISSION
    if _has == _no:
        _emit_bad.append(_c["s"])
say("у каждой монеты разлоков решено про эмиссию (строка или причина)", not _emit_bad, str(_emit_bad))
say("эмиссия бессрочна — тянется вперёд сама", "if last is None:" in pybody(api, "def _plan_steps("))
say("календарь отдаётся из памяти, собирается в фоне и при старте",
    "_UNL_READY" in pybody(api, "def unlocks(") and "threading.Thread(target=_unlocks_refresh" in pybody(api, "def unlocks(")
    and "        unlocks()\n" in api and "ThreadPoolExecutor" in pybody(api, "def _unlocks_build("))
say("экран разлоков открывается сразу: запас на устройстве и отрисовка порциями",
    "savedUnlocks()" in unl_scr and "new IntersectionObserver" in unl_scr
    and "jobs.push(() => fetchUnlocks());" in read(f"{APP}/src/lib/prefetch.ts").split("// 1. Кошельки")[0])
_book_syms = {c["s"] for c in _wm.UNLOCK_BOOK}
say("монета не бывает и в календаре, и в списке отсеянных",
    not (_book_syms & set(_wm.UNLOCK_SKIPPED)), str(_book_syms & set(_wm.UNLOCK_SKIPPED)))
say("у каждой отсеянной монеты — код причины из известных",
    all(v[0] in ("done", "burn", "undated", "nodata", "pegged") for v in _wm.UNLOCK_SKIPPED.values())
    and all(v[0] in ("fixed", "notyet") for v in _wm.NO_EMISSION.values()))
# Рейтинг по капитализации: ни одна монета из него не пропущена — каждая
# либо в календаре, либо среди отсеянных с причиной.
_rank = [ln.split("\t")[1] for ln in read(f"{APP}/tools/unlock-rank.tsv").splitlines() if ln[:1].isdigit()]
_lost = [s for s in _rank if s not in _book_syms and s not in _wm.UNLOCK_SKIPPED]
say(f"каждая монета рейтинга ({len(_rank)}) в календаре или с причиной", len(_rank) >= 300 and not _lost, str(_lost[:20]))
_rank_at = re.search(r"CoinGecko, (\d{2})\.(\d{2})\.(\d{4})", read(f"{APP}/tools/unlock-rank.tsv"))
say("рейтинг первых 500 не старше 60 дней — tools/sync-rank.py --write на сервере",
    bool(_rank_at) and (_dt.date.today() - _dt.date(int(_rank_at.group(3)), int(_rank_at.group(2)),
                                                               int(_rank_at.group(1)))).days <= 60
    and os.path.exists(f"{APP}/tools/sync-rank.py"))
say("маршрут /api/unlocks есть", 'if path in ("/unlocks", "/api/unlocks"):' in api)

# --- ротация: своим потоком, не в бюджете сборки кэша ----------------------
_bp = pybody(api, "def build_public(")
say("ротация не считается внутри сборки кэша — берётся готовой",
    "load_rot(" not in _bp and "rot = rot_latest()" in _bp)
say("поток ротации запускается при старте и не затирает свод пустым",
    'threading.Thread(target=rot_refresher, daemon=True, name="rotation").start()' in api
    and "if any(data.values()):" in pybody(api, "def rot_refresh_once("))
say("ротация идёт по индексу времени, без сортировки выборки",
    '"ORDER BY t.timestamp, t.id"' in pybody(api, "def load_rot("))


# --- Cortex убран, на его месте дайджест ---------------------------------
# Сигналы и обучаемая модель удалены из обоих проектов; вернуть их кусками
# (экран, поле хранилища, таблицу бота) нельзя незаметно.
_gone = [f for f in ("src/screens/CortexTab.tsx", "src/screens/SignalScreen.tsx",
                     "src/screens/HistoryScreen.tsx", "src/screens/ModelScreen.tsx",
                     "src/components/Brain.tsx") if os.path.exists(f"{APP}/{f}")]
_gone += [f for f in ("ai.cpp", "oracle.cpp") if os.path.exists(f"{BOT}/{f}")]
say("Cortex удалён из приложения и бота", not _gone, str(_gone))
_dg_main = read(f"{BOT}/main.cpp")
say("бот стирает таблицы Cortex при запуске",
    all(f"DROP TABLE IF EXISTS {t};" in _dg_main for t in ("ai_signals", "ai_signal_log", "ai_models", "hl_candles")))
_dg_tab = read(f"{APP}/src/screens/DigestTab.tsx")
_dg_app = read(f"{APP}/src/App.tsx")
say("вкладка «Дайджест» стоит на месте Cortex",
    '{ id: "digest", key: "dg_title", glyph: <DigestGlyph /> }' in _dg_app and "<DigestTab />" in _dg_app)
say("дайджест: выпуск раз в сутки, тридцать последних, поток запущен",
    "DIGEST_KEEP = 30" in api and 'target=digest_refresher' in api
    and "SELECT 1 FROM digests WHERE day=?" in api
    and "DIGEST_HOUR_LONDON = 12" in api and "ln.tm_hour < DIGEST_HOUR_LONDON" in api)
say("дайджест целиком — подписчику, без закрытых разделов",
    "def digest_list(chat: str) -> dict:" in api and "isLocked" not in read(f"{APP}/src/screens/DigestTab.tsx"))
say("дайджест: ссылки, частота и суточный лимит комментариев проверяются на сервере",
    '"error": "links"' in api and '"error": "too_fast"' in api and '"error": "day_limit"' in api)
say("дайджест: удалить чужой комментарий может только владелец",
    'row["chat_id"] != chat and not mod' in api)
_dg_tables = ("digest_likes", "digest_comments", "digest_mute")
_dg_all = ("digests", "digest_likes", "digest_comments", "digest_mute", "digest_tr")
say("удаление данных (только в приложении) стирает лайки и комментарии",
    all(f"DELETE FROM {t} WHERE chat_id=?" in api for t in _dg_tables) and "/forgetme" not in _dg_main)
say("таблицы дайджеста одинаковые у бота и API",
    all(f"CREATE TABLE IF NOT EXISTS {t}" in _dg_main and f"CREATE TABLE IF NOT EXISTS {t}" in api
        for t in _dg_all))
say("удаление данных стирает и переводы комментариев",
    "DELETE FROM digest_tr WHERE comment_id IN (SELECT id FROM digest_comments WHERE chat_id=?)" in api)
say("дайджест: акции и металлы отдельно от крипты в лонг/шорте и позициях",
    'for c in ("crypto", "rwa")' in api and '"crypto", "rwa")}' in api and "lsGroups(" in _dg_tab and "perpGroups(" in _dg_tab)
say("анонимный комментарий уходит без имени, перевод — кнопкой, тикеры не переводятся",
    'name = "" if anon else _dg_name(user)' in api and '"name": "" if r["anon"] else r["name"]' in api
    and "translateComment(c.id, lang)" in _dg_tab and "_TICKER_RE.sub(" in api)
say("отказ в комментарии приходит с причиной, а не кодом ошибки",
    "res = digest_act(self._user_full(qs), dg, body)\n                self._json(200, res)" in api
    and "actError(lang, r)" in _dg_tab)

# --- Старт на дайджесте и карта ликвидаций --------------------------------
_store = read(f"{APP}/src/store/app.ts")
_appx = read(f"{APP}/src/App.tsx")
say("приложение всегда открывается на «Дайджесте»",
    'tab: "digest",' in _store and "delete s.tab;" in _store
    and "tab: s.tab" not in _store)
say("«Карта ликвидаций» в меню сразу под «Токеномикой»",
    '{ name: "unlocks", key: "unl_title", glyph: <UnlockGlyph /> },\n  { name: "liqmap", key: "lq_title", glyph: <LiqGlyph /> },' in _appx
    and "liqmap: LiqMapScreen" in read(f"{APP}/src/screens/registry.ts"))
say("карта ликвидаций считается на сервере из открытых данных бирж, без ключей",
    "def liq_map(" in api and '"/api/liqmap"' in api and "LIQ_SOURCES" in api
    and "apikey" not in pybody(api, "def liq_map(").lower())

_lq = read(f"{APP}/src/screens/LiqMapScreen.tsx")
say("карта ликвидаций: плечо — своим оттенком, крупные скопления — ярче и с подсветкой, накопленное — своей колонкой",
    "LEV_C" in _lq and "LEV_HOT" in _lq and 'filter={hot ? "url(#lq-glow)"' in _lq and "function cumOf(" in _lq and "CX0 + ((cum[i]" in _lq
    and "function nearest(" in _lq and '"path": [round(x, 10) for x in path]' in api)

say("карта ликвидаций: свечи цены на той же оси и список всех монет с фьючерсами",
    "def liq_coins(" in api and '"/api/liqcoins"' in api and '"ohlc": _liq_candles(main)' in api
    and "function Candles(" in _lq and "function CoinPicker(" in _lq and "fetchLiqCoins" in _lq)

say("карта ликвидаций: уровень виден, пока палец на карте, и гаснет, когда его убрали",
    'el.addEventListener("touchend", end)' in _lq and 'el.addEventListener("touchcancel", end)' in _lq
    and '{ passive: false }' in _lq and 'aria-label="×"' not in _lq
    and 'window.addEventListener("touchend", anyEnd)' in _lq and '"mousemove"' not in _lq
    and 'e.pointerType === "mouse"' in _lq)

say("карта ликвидаций: шесть бирж с историей и двадцать одна со своей записью интереса, чужие цены отсеяны",
    all(f'("{n}", _liq_' in api for n in ("Binance", "OKX", "Bybit", "Gate", "HTX", "dYdX"))
    and all(f'("{n}", _snap_' in api for n in ("Hyperliquid", "Bitget", "MEXC", "KuCoin", "Kraken",
                                               "Phemex", "WOO X", "WhiteBIT", "Bitfinex", "Deribit",
                                               "CoinEx", "Coinbase Intl", "Crypto.com", "Paradex", "Lighter",
                                               "Backpack", "Orderly", "GMX", "Aster", "BingX", "Bitstamp"))
    and "def liq_oi_refresher(" in api and "target=liq_oi_refresher" in api
    and "abs(r[-1][3] / mid - 1) > 0.03" in api and "abs(sn[-1][2] / px - 1) > 0.03" in api
    and "DROP TABLE hl_oi" in api)

say("карта ликвидаций: отдаётся из памяти сразу, старая — с пересчётом в фоне, тёплые монеты заранее",
    "def _liq_build_bg(" in api and "def liq_warm_refresher(" in api and "target=liq_warm_refresher" in api
    and "wait(futures, timeout=LIQ_BUDGET)" in api and 'sorted(ex.get(k, ()))' in api
    and "savedLiqMap(sym, range)" in _lq and "callTwice<LiqMapReply>" in read(f"{APP}/src/lib/api.ts"))

_ngx = read(f"{APP}/nginx.conf")
say("Binance и Bybit — через nginx в Европе, если отсюда закрыты; ретранслятор только с ключом",
    'location /xr/binance-f/' in _ngx and 'location /xr/bybit/' in _ngx
    and _ngx.count('if ($http_x_api_key != "__API_KEY__") { return 403; }') == 2
    and _ngx.count('if ($http_x_api_key = "") { return 403; }') == 2
    and "def _geo_refused(" in api and '"https://fapi.binance.com/": "/xr/binance-f/"' in api)

say("карта ликвидаций в гамме Coinglass: плечи фиолетовый/голубой/жёлтый/оранжевый, чёрное поле, красная линия цены",
    'const LEV_C = ["#7b61ff", "#38bdf8", "#facc15", "#f97316"];' in _lq and 'className="lq-bg"' in _lq
    and ".lq-now { stroke: #f6465d;" in read(f"{APP}/src/styles/app.css"))

say("карта ликвидаций живая: сервер раз в две минуты, открытый экран спрашивает раз в минуту",
    "LIQ_TTL = 120.0" in api and "LIQ_WARM_EVERY = 300" in api and "LIQ_WARM_COINS = 6" in api
    and "refreshLiqMap(sym, range)" in _lq and "const LIVE_EVERY = 60_000;" in _lq)

say("на колонке «Накоплено» — перевес в процентах и деньги сверху и снизу",
    'className="lq-share up"' in _lq and 'className="lq-share dn"' in _lq and '"lq_share_s"' in _lq)

say("модель ликвидаций: падение интереса закрывает позиции долей от всего интереса биржи",
    "k = max(0.0, oi / prev)" in api and "k = max(0.0, 1 + d / total)" not in api)

_store2 = read(f"{APP}/src/store/app.ts")
say("экраны бокового меню: «Назад» возвращает в меню, значок фандинга одноцветный",
    "openFromMenu(m.name)" in appx and "menuOpen: Boolean(top?.menu)" in _store2
    and "menuOpen: s." not in _store2 and "glyph: <FundLineGlyph />" in appx)

_fg = read(f"{APP}/src/screens/FearGreedScreen.tsx")
say("страх и жадность: вся история alternative.me с ценой BTC, две панели на одной оси времени",
    "def fng_data(" in api and '"/api/fng"' in api and "api.alternative.me/fng/?limit=0" in api
    and "function Gauge(" in _fg and "P2 = {" in _fg and '"fg_st_left"' in _fg and '"fg_since_then"' in _fg)

say("страх и жадность: сколько подряд держится каждая зона, рекорд, куда уходит дальше, текущая полоса",
    "function streakStats(" in _fg and '"fg_st_now"' in _fg and '"fg_st_next"' in _fg)

_fi = read(f"{APP}/src/screens/FearGreedInsights.tsx")
say("страх и жадность: «что скрыто в данных» — край не разворот, цена после зон, покупки каждый день, похожие дни, оговорка",
    all(f"function {f}(" in _fi for f in ("afterEntry", "forward", "dca", "analogs", "divergence"))
    and "const FRESH = 7;" in _fi and "for t in range(start, max(idx) + 1, 86400):" in api
    and '"fi_caveat"' in _fi and "<FearGreedInsights" in _fg)

_dm = read(f"{APP}/src/screens/DominanceScreen.tsx")
say("доминация и альтсезон: история рынка с 2013, стейблкоины отдельно, индекс альтсезона, волны, ETH/BTC",
    "def dom_data(" in api and '"/api/dom"' in api and "global-metrics/quotes/historical" in api
    and "altcoin-season/chart" in api and "stablecoins.llama.fi" in api and "symbol=ETHBTC" in api
    and "dom_data()  # и доминация" in api and "function waves(" in _dm and "function MainChart(" in _dm
    and '"dm_say_flip_alt"' in _dm and '"dm_top_note"' in _dm and "glyph: <DomGlyph />" in appx)

_fs = read(f"{APP}/src/screens/FundingScreen.tsx")
say("фандинг не пропадает: собирается первым, при сбое — прошлый; пока ставок нет — загрузка с переспросом, а не «нет аномалий»",
    'funding = take("funding", lambda: load_funding(hl), was.get("fund") or funding)' in api
    and api.index('funding = take("funding"') < api.index('rank = take("rank"')
    and "function FundWaiting(" in _fs and "if (!have.length) return <FundWaiting />;" in _fs
    and "syncNow()" in _fs and '"fund_fail"' in _fs)

_sy = read(f"{APP}/src/lib/sync.ts")
say("фандинг после перезапуска: биржи опрашиваются разом, кэш пересобирается сразу, приложение переспрашивает по «fund:later»",
    "pool.submit(fund_pull, ex)" in api and "wait(futs, timeout=25)" in api and "_fund_ready.set()" in api
    and 'errors.append("fund:later")' in api and 'data.partial.includes("fund:later")' in _sy)

_un = read(f"{APP}/src/screens/UnlocksScreen.tsx")
say("токеномика: видно, что монету можно открыть — стрелка в строке и подсказка до первого нажатия",
    '<span className="unl-chev" aria-hidden="true" />' in _un and '"unl_tap_hint"' in _un and "localStorage.setItem(TIP_KEY" in _un)

_ef = read(f"{APP}/src/screens/EtfScreen.tsx")
say("ETF и крупные игроки: потоки по фондам и дням (BTC, ETH, SOL, XRP, HYPE), спрос против добычи, держатели и кто докупал",
    "def etf_data(" in api and '"/api/etf"' in api and "etf/detail/netflow/list?category=" in api
    and "bitcointreasuries.net/__data.json" in api and "etf_data()  # и потоки ETF" in api
    and "function FlowChart(" in _ef and "function Funds(" in _ef and "function Holders(" in _ef
    and "minedPerDay(" in _ef and "glyph: <EtfGlyph />" in appx)

_hv = read(f"{APP}/src/components/HalvingCard.tsx")
say("внизу меню — отсчёт до халвинга, а не дата сборки",
    "def halving_data(" in api and '"/api/halving"' in api and "mempool.space/api/blocks/tip/height" in api
    and "<HalvingCard />" in appx and "drawer-build" not in appx and "(h.next - h.height) * h.avg - since" in _hv)

_dgt = read(f"{APP}/src/screens/DigestTab.tsx")
say("дайджест: просмотры — каждый человек один раз, счётчик у каждого выпуска",
    "CREATE TABLE IF NOT EXISTS digest_views" in api and "INSERT OR IGNORE INTO digest_views" in api
    and '"/api/digest/view": "view"' in api and "DELETE FROM digest_views WHERE chat_id=?" in api
    and "viewDigest(it.id)" in _dgt and 'className="dg-views"' in _dgt)

say("институциональные потоки: накопленный приток, доля и премия фондов, средняя цена покупки держателей, время данных",
    "cum={mode === \"c\" ? cumView : null}" in _ef and '"ef_mshare"' in _ef and '"ef_prem"' in _ef
    and '"ef_cost"' in read(f"{APP}/src/screens/EtfMore.tsx") and '"ef_held2"' in _ef and '"ef_upd"' in _ef and "coinsRound(" in _ef)

_em = read(f"{APP}/src/screens/EtfMore.tsx")
say("институциональные потоки: позиции CME по CFTC, премия Coinbase, все держатели с поиском и группами, казначейства ETH/SOL/BNB/XRP",
    "def _inst_cme(" in api and "publicreporting.cftc.gov" in api and "def _inst_cbp(" in api
    and '"top": top, "movers": movers, "alts": alts' in api
    and "export function CmeSection(" in _em and "export function CbpSection(" in _em
    and "export function HoldersAll(" in _em and "export function AltHolders(" in _em
    and "<CmeSection" in _ef and "<HoldersAll" in _ef)

_btv = read(f"{APP}/src/screens/BtcViews.tsx")
_ws_btc = read(os.path.join(BOT, "btc_chain.cpp"))
say("bitcoin: сканер блоков бота, база сервисного аккаунта с порогом $50, /statsbtc",
    ("WATCH_MIN_USD_NANOS = 50LL" in _ws_btc and "CREATE TABLE IF NOT EXISTS btc_watch" in _ws_btc
                    and "blockchain.info/rawblock/" in _ws_btc and "std::string btcStatsLine()" in _ws_btc
                    and 'txt=="/statsbtc"' in read(os.path.join(BOT, "main.cpp"))))
say("bitcoin: вкладка «Крупные ордера BTC» с потоком бирж (в NetFlow его нет), третья доска рейтинга, экран кошелька",
    'path in ("/btc/flow", "/api/btc/flow")' in api and "def _btc_clean(" in api and "w.s < 0.9 * w.b" in api
    and "export function BtcFlowCard(" in _btv and "export function BtcBigView(" in _btv
    and '{view === "btc" ? <BtcFlowCard bigWin={bigWin} /> : null}' in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and '{view === "flow" ? <BtcFlowCard' not in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and "export function BtcBoard(" in _btv and "export function BtcWalletScreen(" in _btv
    and '{ id: "btc", ic: <CoinIcon sym="BTC"' in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and "<BtcBoard win={win} />" in read(f"{APP}/src/screens/TopTab.tsx")
    and "btcWallet: BtcWalletScreen" in read(f"{APP}/src/screens/registry.ts"))

_mc = read(os.path.join(BOT, "main.cpp"))
say("bitcoin: подписка на кошелёк и алерты «покупка / продажа / перевод» по бирже на другой стороне",
    "void dispatchBtcAlert(const BtcAlert& a)" in _mc and "btcSetAlertSink(dispatchBtcAlert);" in _mc
    and 'tr(lang, a.kind == BtcAlert::BUY ? "alert_from_exchange" : "alert_to_exchange")' in _mc
    and 'if (addr.rfind("0x", 0) != 0) continue;' in _mc
    and "def wallet_key(raw: str)" in api and "_b58check_ok" in api
    and "function FollowBtn(" in _btv and 'valueSub={t(lang, side === "buy" ? "alert_buy" : "alert_sell")}' in _btv
    and 'open("btcWallet", w.btc ?? w.addr)' in read(f"{APP}/src/screens/WalletsTab.tsx"))

say("bitcoin: кошельки базы — каждая продажа и покупка и через какие биржи они прошли",
    "def _btc_big_build(win: str, side: str, min_btc: int, base: bool = False)" in api
    and '"byEx": by_ex' in api and 'qs.get("base", ["0"])[0] == "1"' in api
    and 'className="btc-via"' in _btv and '"btc_scope_base"' in _btv
    and '"Bybit"' in _ws_btc and '"OKX"' in _ws_btc)

say("bitcoin: перестройка цепочки откатывает блок, цена на час блока, выплаты биржи не путаются с CoinJoin, PnL только по биржевым движениям",
    "bool rolledBack(const Block& b)" in _ws_btc and "long long priceAt(long long ts)" in _ws_btc
    and "basic && (!exIn.empty() || !coinjoin(tx))" in _ws_btc and "AND price_nanos > 0 AND ex != ''" in _ws_btc
    and "UPDATE btc_labels SET at=? WHERE address=? AND how != 'seed'" in _ws_btc and "void reloadWatch()" in _ws_btc
    and "AND price_nanos > 0 AND m.ex != ''" in api and 'r["price_nanos"] or 0) > 0 and r["ex"]' in api)

_dgm = read(f"{APP}/src/screens/DigestMore.tsx")
say("дайджест v2: сводка сигналов, рынок, институционалы, bitcoin, лидеры, халвинг; старые выпуски как были",
    "def _dg_signals(body: dict)" in api and 'body: dict = {"v": 2' in api and 'body["halv"] = {' in api
    and "export function Summary(" in _dgm and "export function Institutions(" in _dgm
    and "export function BitcoinSec(" in _dgm and "export function HalvingLine(" in _dgm
    and "const v2 = (it.v ?? 1) >= 2;" in read(f"{APP}/src/screens/DigestTab.tsx"))

_ui_left = [f for f in ("wallet_menu.cpp", "big_trades.cpp", "hyperliquid_ui.cpp", "alert_settings.cpp")
            if os.path.exists(os.path.join(BOT, f))]
# Кнопки под заявками с бирж (ExchClaim … exchPending) — только владельцу.
_bot_src = "".join(read(os.path.join(BOT, f)) for f in os.listdir(BOT)
                   if f.endswith(".cpp") and f not in ("ru.cpp", "translations.cpp"))
say("бот: меню в чате нет — на любое сообщение кнопка приложения; алерты, оплата и команды владельца на месте",
    not _ui_left and "callback_data" not in _bot_src.replace(
        _bot_src[_bot_src.find("struct ExchClaim {"):_bot_src.find("void exchPending(")], "") and "void sendOpenApp(const std::string& chatId)" in _mc
    and "bool handleOwnerCommand(const std::string& cid, const std::string& txt)" in _mc
    and "handlePreCheckoutQuery(" in _mc and "handleSuccessfulPayment(" in _mc
    and '"start_open_app"' in read(os.path.join(BOT, "ru.cpp")), str(_ui_left))
_sync = read(f"{APP}/tools/sync-i18n.py")
say("словарь приложения свой (tools/i18n.json), из исходников бота не собирается",
    os.path.exists(f"{APP}/tools/i18n.json") and not os.path.exists(f"{APP}/tools/i18n-extra.json")
    and "ru.cpp" not in _sync and "translations.cpp" not in _sync)

_sch = _mc[_mc.index('const char* sql = R"('):_mc.index("ALTER TABLE user_whales ADD COLUMN is_primary")]
say("бот: на новой базе таблицы создаются раньше колонок, индекс по priority — после неё",
    _sch.index("if (sqlite3_exec(db, sql, nullptr, nullptr, &err)") < _sch.index("ALTER TABLE deliveries ADD COLUMN priority")
    and "priority DESC" not in _sch[:_sch.index('    )";')]
    and "idx_deliveries_prio" in _sch)
say("бот: все вызовы Bot API идут через tgApi()",
    _bot_src.count("api.telegram.org") == 2 and 'return tgApi(method);' in read(os.path.join(BOT, "premium.cpp")))
_legal = json.load(open(f"{APP}/tools/i18n.json", encoding="utf-8"))
say("тексты приложения не посылают в чат бота: нет /forgetme и /start, вопросы — в поддержку",
    all("/forgetme" not in v and "/start" not in v for k in ("legal_privacy_body", "legal_terms_body", "legal_forget_done")
        for v in _legal[k].values())
    and all("@WalletTrackerHelp" in _legal["legal_terms_body"][l] for l in _legal["legal_terms_body"]))

_prem_cpp = read(os.path.join(BOT, "premium.cpp"))
_bot_plans = set(re.findall(r'\{"(premium_[a-z0-9_]+)", (\d+), (\d+)\}', _prem_cpp))
_api_plans = {("premium_30_days", "250", "30"), ("premium_365_days", "1990", "365"), ("premium_30_intro", "150", "30")}
say("тарифы: месяц, год и вводная цена — одинаковые у бота и API, все разовые (автопродления нет, старые подписки бот отменяет)",
    _bot_plans == _api_plans and '"payload": "premium_365_days", "stars": 1990, "days": 365' in api
    and '"payload": "premium_30_intro", "stars": 150, "days": 30' in api
    and "subscription_period" not in api and "STAR_SUB_PERIOD" not in api and '"auto"' not in api
    and "editUserStarSubscription" in _prem_cpp and "cancelStarSubscriptions(OWNER_CHAT_ID, false)" in read(f"{BOT}/main.cpp")
    and 'txt == "/autorenew"' in read(f"{BOT}/main.cpp") and "p.sub_until >=" not in read(f"{BOT}/lifecycle.cpp")
    and "grantPremiumDays(chatId, days)" in _prem_cpp and "until = intro_until(con, chat)" in api, str(_bot_plans))
_pay_ts = read(f"{APP}/src/lib/pay.ts")
say("вводная цена привязана к покупателю и сроку: сервер вшивает их в счёт, бот сверяет перед оплатой",
    'payload = f"{payload}:{chat}:{until}"' in api and "bool introBinding(" in _prem_cpp
    and "introChat != buyerChatId" in _prem_cpp and "now > introUntil + INTRO_GRACE_SEC" in _prem_cpp)
say("оплата: успех — только по закрытому счёту или выросшему сроку, возврат из кошелька — в мини-приложение, ручного перевода нет",
    'r.status === "paid" || (r.premUntil ?? 0) > before' in _pay_ts and "WalletTrackerOfficial" not in _pay_ts
    and '"app": app_link(),' in api and '"pay_manual"' not in read(f"{APP}/src/screens/PremiumScreen.tsx"))
say("бот продлевает Премиум одной транзакцией (не теряет дни при одновременном бонусе)",
    "Чтение срока и запись нового — одной транзакцией" in _prem_cpp)

_lc = read(os.path.join(BOT, "lifecycle.cpp"))
say("бот: письма жизненного цикла — 2 дня до конца пробы, конец пробы со скидкой, возврат 14/30, напоминание о продлении каждому, кто платил",
    'claim(r.chat, "trial_d5")' in _lc and '"renew:" + std::to_string(r.expire)' in _lc
    and "for (const int after : {14, 30})" in _lc and 'tr(lang, "lc_intro")' in _lc
    and "p.sub_until" not in _lc and "if (n <= 0 ||" in _lc
    and "sendPremiumEnded(cid)" in _prem_cpp and "lifecycleTick();" in read(f"{BOT}/main.cpp"))
_mcpp = read(f"{BOT}/main.cpp")
say("бот: бесплатному алерт без цены входа и PnL, со строкой о премиуме",
    _mcpp.count("const std::set<std::string> prem = premiumSubsetOf(chatIds);") == 2
    and _mcpp.count('tr(lang, "alert_locked")') == 3)  # две строки в алертах + проверка для кнопки
_wt = read(f"{APP}/src/screens/WalletsTab.tsx")
say("приложение: плашка пробной недели и «Первые шаги»",
    "<TrialCard />" in _wt and '"fs_1"' in _wt and '"tr_left"' in read(f"{APP}/src/components/Upsell.tsx")
    and '"trial": trial,' in api)
say("скидка после пробы — от настоящего конца премиума (проба по приглашению длиннее недели), счётчик пробы и на дайджесте",
    'if exp and int(exp["premium_expire"] or 0) > end:' in api
    and "<TrialCard within={3} />" in read(f"{APP}/src/screens/DigestTab.tsx"))

_inv = read(f"{APP}/src/components/Invite.tsx")
_dgt = read(f"{APP}/src/screens/DigestTab.tsx")
say("рост: приглашение друга (+7 дней обоим), «Поделиться» в дайджесте, уведомление о новом выпуске",
    "def apply_referral(" in api and '"start": str(parts.get("start_param")' in api
    and "REF_DAYS = 7" in api and '"/api/digest/notify": "notify"' in api
    and "export function InviteCard(" in _inv and "<InviteCard" in read(f"{APP}/src/screens/BonusScreen.tsx")
    and 'open("bonus")' in read(f"{APP}/src/screens/PremiumScreen.tsx")
    and "setDigestNotify" in _dgt and "shareTg(" in _dgt
    and "void digestTick()" in _lc and "digestTick();" in _lc and '"dg_ready"' in _lc)

_tg = read(f"{APP}/src/lib/telegram.ts")
_mq = read(os.path.join(BOT, "message_queue.cpp"))
say("воронка: кнопки бота ведут прямо на экран Премиума (скидка, продление, возврат, бесплатный алерт)",
    'openAppKeyboard(lang, "premium-intro", "btn_intro")' in _lc and '"premium-trial", "btn_keep"' in _lc
    and '"premium-renew", "btn_extend"' in _lc and '"premium-back", "btn_plans"' in _lc
    and "freeAlertKeyboard(m, labelLang.second)" in _mcpp and "a.markup FROM deliveries" in _mq
    and "sendMsg(cid,msg,markup)" in _mq and "export function launchGo()" in _tg
    and "launchGo()" in read(f"{APP}/src/App.tsx"))
_i18n = json.load(open(f"{APP}/tools/i18n.json", encoding="utf-8"))
_bad_ru = [k for k, v in _i18n.items()
           if re.search(r"(?<![А-Яа-яЁё])[СсВв] Премиум(?![а-яё])|Premium", v.get("ru", ""))]
say("тексты: «с Премиумом», «в Премиуме» и без латинского Premium в русском",
    not _bad_ru, ", ".join(_bad_ru[:5]))
say("приложение: вводная цена — на замке, пробный срок — в кошельках и на дайджесте",
    "<IntroOffer />" in read(f"{APP}/src/components/LockScreen.tsx") and "<TrialCard />" in _wt
    and "<TrialCard within={3} />" in read(f"{APP}/src/screens/DigestTab.tsx"))

_lqs = read(f"{APP}/src/screens/LiqMapScreen.tsx")
_uns = read(f"{APP}/src/screens/UnlocksScreen.tsx")
say("карта ликвидаций и разлоки без отдельных замков: всё за Премиумом",
    "const locked" not in _lqs and "Upsell" not in _lqs and "reactN" not in _uns and "Upsell" not in _uns)

_hlc = read(os.path.join(BOT, "hyperliquid_core.cpp"))
_alc = read(f"{APP}/src/components/AlertCard.tsx")
say("алерты: BSC и BTC в виде Hyperliquid, все три — с полями для карточки в приложении",
    "json* card = nullptr" in _mcpp and _mcpp.count("card.dump()") == 4 and "dexscreener.com/bsc/" in _mcpp
    and "hlAlertCard(entry.first.first, wallet, a).dump()" in _hlc
    and "ALTER TABLE alerts ADD COLUMN data TEXT" in _mcpp and "INSERT INTO alerts(message,created_at,markup,data)" in _mq
    and "def alert_card(" in api and 'parsed["d"] = card' in api
    and "export function AlertCard(" in _alc and "<AlertCard d={a.d}" in read(f"{APP}/src/screens/AlertsScreen.tsx"))

_i18n2 = json.load(open(f"{APP}/tools/i18n.json", encoding="utf-8"))
_stale = [k for k, v in _i18n2.items() if re.search(
    r"проб\w* недел|бесплатн\w* недел|7 дней Прем|с 3 кошел|первых 3 кошел|3 кошелька с алерт", v.get("ru", ""), re.I)]
_bru = read(f"{BOT}/ru.cpp")
say("тексты: проба — 14 дней «пробного Премиума», бесплатно алерты только с основного кошелька",
    not _stale and "алерты с 3 кошельков" not in _bru and "Пробная неделя" not in _bru
    and "14" in _i18n2["hp_a4"]["ru"], ", ".join(_stale))

_tks = read(f"{APP}/src/screens/TokenScreen.tsx")
say("токен проекта: экран в «Ещё», подписка на запуск (token_subs), безопасность и оговорка; бот — /tokencast и счётчик",
    "export function TokenScreen(" in _tks and '"tk_safe_3"' in _tks and '"tk_disclaimer"' in _tks
    and 'open("token")' in read(f"{APP}/src/screens/MoreTab.tsx") and "token: TokenScreen" in read(f"{APP}/src/screens/registry.ts")
    and "def token_state(" in api and '"/api/token-launch/notify"' in api
    and api.count('if path in ("/token", "/api/token"):') == 1 and "DELETE FROM token_subs WHERE chat_id=?" in api
    and "void tokenCast(" in _mcpp and 'txt.rfind("/tokencast", 0) == 0' in _mcpp and "CREATE TABLE IF NOT EXISTS token_subs" in _mcpp
    and '"tk_ready"' in read(f"{BOT}/ru.cpp"))

_bns = read(f"{APP}/src/screens/BonusScreen.tsx")
say("бонусы: приглашение и дни за соцсети (канал +3 — getChatMember, остальные +1 — нажал, через 5 мин начислено и сообщение), один раз",
    "export function BonusScreen(" in _bns and "<InviteCard />" in _bns and "socials.map" in _bns
    and '"bn_left"' in _bns
    and "<InviteCard" not in read(f"{APP}/src/screens/MoreTab.tsx") and 'open("bonus")' in read(f"{APP}/src/screens/MoreTab.tsx")
    and 'SOCIAL_BONUS = {"tg": 3, "x": 1, "tiktok": 1, "instagram": 1, "youtube": 1}' in api
    and "def bonus_act(" in api and '"getChatMember"' in api and "BONUS_WAIT_SEC = 10" in api
    and "BONUS_DELAY_SEC = 5 * 60" in api and "threading.Thread(target=_bonus_loop, daemon=True).start()" in api
    and '"bn_checking"' in _bns
    and "const BONUS_WAIT = 10;" in _bns and "DELETE FROM bonus_claims WHERE chat_id=?" in api
    and "SOCIALS.map" in read(f"{APP}/src/App.tsx") and 'n["bonus"]' in _mcpp)

_lock = read(f"{APP}/src/components/LockScreen.tsx")
say("жёсткий пейволл: без Премиума вкладки, меню и история алертов — замок «купить / бесплатно в Бонусах», не мигает до загрузки",
    'if (plan === "premium") return false;' in _lock
    and 'return status !== "boot";' in _lock and 'open("bonus")' in _lock and 'trackEvent("paywall", "lock")' in _lock
    and '{locked && tab !== "more" ? <LockScreen /> : <TabBody tab={tab} />}' in read(f"{APP}/src/App.tsx")
    and "LOCK_OPEN_SCREENS" in read(f"{APP}/src/App.tsx")
    and "Без Премиума приложение закрыто" in read(f"{BOT}/ru.cpp"))

_ref_fn = pybody(api, "def apply_referral(")
_ref_st = pybody(api, "def ref_settle(")
say("приглашения: другу +7 сразу, пригласившему — только когда друг добавил кошелёк и заходил 3 разных дня (≤30 дней, ≤10 за 30 дней)",
    "extend_premium(con, invitee, REF_DAYS)" in _ref_fn and "inviter, REF_DAYS" not in _ref_fn
    and "REF_ACTIVE_DAYS = 3" in api and "REF_WAIT_SEC = 30 * 86400" in api
    and "EXISTS (SELECT 1 FROM user_whales w WHERE w.user_id=r.invitee)" in _ref_st
    and "COUNT(DISTINCT f.day)" in _ref_st and "recent < REF_MAX_30D and extend_premium(con, inviter, REF_DAYS)" in _ref_st
    and "ref_settle()" in pybody(api, "def _bonus_loop(")
    and '"ref_wait"' in read(f"{APP}/src/components/Invite.tsx"))

_ana = read(f"{APP}/src/screens/AnalyticsTab.tsx")
say("лонг/шорт: из памяти, при пропуске сборки — из памяти, сбой чтения не обнуляет, экран спрашивает сервер сам",
    "return ls_pack({key: ls_rows_cached(hl, key) for key in FLOW_WINDOWS})" in api
    and 'take("ls", lambda: load_ls(hl), ls_from_memory() or was.get("ls") or {})' in api
    and "        return None\n" in pybody(api, "def ls_scan(") and '"sum": ls_totals(allrows)' in api
    and 'const local = !query && side === "all" && page === 1 && have;' in _ana
    and "const b = have ? local : asked;" in _ana)

_ex_sub = pybody(api, "def exch_submit(")
_ex_set = pybody(api, "def exch_settle(")
_ex_cb = _mcpp[_mcpp.find("bool handleExchCallback("):_mcpp.find("void exchPending(")]
say("OKX: UID на ручную проверку — кнопки только владельцу, решение один раз, дни одной транзакцией, UID один раз навсегда",
    'EXCH_BONUS = {"okx": 30}' in api and "WHERE status!='no'" in api and "exch_uid_ok(uid)" in _ex_sub
    and '"error": "uid_taken"' in _ex_sub and '"error": "pending"' in _ex_sub and "EXCH_MAX_TRIES" in _ex_sub
    and "WHERE id=? AND status='ok' AND granted_at=0" in _ex_set and "extend_premium(con, r[\"chat_id\"], days)" in _ex_set
    and '.lstrip("0")' in _ex_sub and "AND uid=? AND id!=? AND days>0" in _ex_set
    and "o.uid=exch_claims.uid AND o.status='ok'" in _ex_cb and "_exch_history(" in api
    and "exch_settle()" in pybody(api, "def _bonus_loop(") and 'path == "/api/bonus/exchange"' in api
    and "DELETE FROM exch_claims WHERE chat_id=? AND status!='ok'" in api
    and "if (from != OWNER_CHAT_ID)" in _ex_cb and "WHERE id=? AND status='wait'" in _ex_cb
    and "if (handleExchCallback(cq)) continue;" in _mcpp and 'txt == "/okx"' in _mcpp
    and "CREATE TABLE IF NOT EXISTS exch_claims" in _mcpp
    and "exchSubmit(ex.id, v)" in read(f"{APP}/src/screens/BonusScreen.tsx")
    and 'EXCH_CODES = {"okx"' in api and 'EXCH_MIN_DEP = {"okx": "200 €"}' in api and '"code": EXCH_CODES[k]' in api
    and '"bn_ex_rebind"' in read(f"{APP}/src/screens/BonusScreen.tsx") and '"bn_ex_okx"' in read(f"{APP}/src/screens/BonusScreen.tsx")
    and "депозит и покупка от 200 €" in _mcpp)

s_css = read(f"{APP}/src/styles/app.css")
_gift = read(f"{APP}/src/components/Gift.tsx")
_lc = read(f"{BOT}/lifecycle.cpp")
say("приветствие новичку: в приложении — на весь экран (сколько дней, до какого числа, что входит, что потом), в чате — сообщение бота только недавним, один раз",
    'className="gift-wrap"' in _gift and '"gift_until"' in _gift and '"gift_after"' in _gift and "dayForm(lang" in _gift
    and "inset: 0;" in s_css[s_css.find(".gift-wrap {"):s_css.find(".gift {")]
    and "void welcomeTick()" in _lc and "now - 3 * 3600, now" in _lc and 'claim(r.chat, "welcome")' in _lc
    and "r.chat == SERVICE_CHAT_ID" in _lc[_lc.find("void welcomeTick()"):] and "welcomeTick();" in _mcpp
    and '"lc_welcome"' in read(f"{BOT}/ru.cpp"))

_pt_set = pybody(api, "def partner_settle(")
say("каналы партнёров: подписка проверяется getChatMember, дни — через 3 дня если ещё подписан, ≤7 дней на всех; /partner в боте; ссылка блогера p_<канал>",
    "PARTNER_WAIT_SEC = 3 * 86400" in api and "PARTNER_MAX_DAYS = 7" in api
    and "tg_member(handle, chat)" in pybody(api, "def partner_join(") and 'tg_member(r["handle"], r["chat_id"])' in _pt_set
    and "PARTNER_MAX_DAYS - int(got or 0)" in _pt_set and "partner_settle()" in pybody(api, "def _bonus_loop(")
    and 'partner_ref(chat, who.get("start", ""))' in api and 'path == "/api/bonus/partner"' in api
    and "void partnerCommand(" in _mcpp and 'txt.rfind("/partner ", 0) == 0' in _mcpp
    and "CREATE TABLE IF NOT EXISTS partner_channels" in _mcpp and "PartnersCard" in read(f"{APP}/src/screens/BonusScreen.tsx"))

_app = read(f"{APP}/src/App.tsx")
say("шапка: вместо кнопки «обновить» — вертикальный значок Премиума с днями (данные обновляются сами), заголовок вкладки целиком",
    "<PremBadge />" in _app and "function HdrTitle(" in _app and "flex-direction: column;" in read(f"{APP}/src/styles/app.css")[read(f"{APP}/src/styles/app.css").find(".prem-badge {"):] and 'className={`refresh' not in _app and "OK_DELAY = 180_000" in read(f"{APP}/src/lib/sync.ts")
    and '"visibilitychange"' in read(f"{APP}/src/lib/sync.ts") and 'open("premium", "hdr")' in read(f"{APP}/src/components/PremBadge.tsx"))

print("ПРОВАЛОВ:", bad)
sys.exit(1 if bad else 0)
