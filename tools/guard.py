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
# Биткоин-часть сервера — отдельным модулем (wt_btc.py).
btcpy = read(f"{APP}/wt_btc.py")
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
                      "unlocks", "digest"))
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
    'p === "coins:later"' in sync and "SOON_DELAY" in sync)
say("личное (профиль, кошельки, алерты) собирается раньше общего и не стирается пустым на холодном сервере",
    "missing.add(name)" in api and api.index('own("me",') < api.index('piece("pub",')
    and "/^(me|wallets|alerts):/" in sync and 'const meLate = ' in read(f"{APP}/src/store/live.ts")
    and os.path.exists(f"{APP}/tests/test_bootstrap_personal.py"))
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

# --- подсказки «?» у заголовков и словарь терминов ------------------------
# Новичок не обязан знать, что такое NetFlow или фандинг: у заголовка раздела
# со сложным термином есть «?», а в помощи — словарь. Тексты одни и те же, и
# каждый абзац подсказки должен существовать во всех шестнадцати языках —
# иначе на экране вместо объяснения встанет голый ключ.
_ui = read(f"{APP}/src/components/ui.tsx")
_hs = read(f"{APP}/src/screens/HelpScreen.tsx")
_qk = json.load(open(f"{APP}/tools/i18n.json", encoding="utf-8"))
_qsrc = "".join(read(os.path.join(f"{APP}/src/screens", f)) for f in os.listdir(f"{APP}/src/screens") if f.endswith(".tsx"))
_qused = set(re.findall(r'"(\w+)"', " ".join(re.findall(r"help=\{\[([^\]]*)\]\}", _qsrc))))
_qterms = set(re.findall(r'"(\w+)"', " ".join(re.findall(r"body: \[([^\]]*)\]", _hs))))
say("подсказки «?»: у NetFlow, ротации, лонг/шорт, потоков бирж, топа, фандинга, интереса — и словарь в помощи",
    "help?: DictKey[]" in _ui and 'aria-expanded={open}' in _ui and 'aria-label={t(lang, "q_what")}' in _ui
    and all(k in _qused for k in ("q_netflow_1", "q_rot_1", "q_ls_1", "q_exflow_1", "q_top_1", "q_fund_1", "q_perp_1", "oih_how_1"))
    and '"hp_terms_title"' in _hs and {"q_netflow_1", "q_rot_1", "q_fund_1", "q_top_2"} <= _qterms
    and all(k in _qk and len(_qk[k]) == 16 and all(v.strip() and "{" not in v for v in _qk[k].values())
            for k in _qused | _qterms),
    ", ".join(sorted(k for k in _qused | _qterms if k not in _qk)))

# --- неделя премиума — только при первом открытии приложения --------------
say("бот по /start неделю не выдаёт", "TRIAL_DAYS" not in main_cpp and "grantPremiumDays(cid" not in main_cpp)
say("API выдаёт неделю при первом открытии, одной транзакцией",
    "gift = grant_trial(chat" in api and 'INSERT OR IGNORE INTO trial_granted(chat_id, granted_at)' in api
    and 'con.execute("BEGIN IMMEDIATE")' in pybody(api, "def grant_trial("))
say("помощь не обещает неделю за /start", all("/start" not in ts_dict(lg).get("hp_a4", "")
    for lg in ("en","ru","es","pt","fr","tr","ar","pl","de","uk","hi","id","vi","ko","zh","ja")))

# --- боковое меню: свой график и разлоки -----------------------------------
_m0 = appx.index("= [", appx.index("const MENU:"))
menu = appx[_m0:appx.index("];", _m0)]
say("в боковом меню одиннадцать пунктов: график, календарь, разлоки, карта ликвидаций, ликвидации, опционы, интерес и фандинг, фандинг, страх и жадность, доминация, ETF",
    menu.count("name:") == 11
    and menu.index('name: "chart"') < menu.index('name: "calendar"') < menu.index('name: "unlocks"') < menu.index('name: "liqmap"')
    < menu.index('name: "liqs"') < menu.index('name: "options"') < menu.index('name: "oihist"') < menu.index('name: "funding"') < menu.index('name: "fng"') < menu.index('name: "dom"') < menu.index('name: "etf"'))
chart_scr = read(f"{APP}/src/screens/ChartScreen.tsx")
_cd = read(f"{APP}/src/chart/data.ts")
_ce = read(f"{APP}/src/chart/engine.ts")
_ci = read(f"{APP}/src/chart/indicators.ts")
_cw = read(f"{APP}/src/chart/draw.ts")
_cngx = read(f"{APP}/nginx.conf")
_ckeys = json.load(open(f"{APP}/tools/i18n.json", encoding="utf-8"))
say("график свой, без TradingView: ни виджета, ни их скриптов",
    not os.path.exists(f"{APP}/src/lib/tradingview.ts") and "tradingview.com" not in (chart_scr + _ce) and "TV_EMBED" not in chart_scr
    and "new Engine(c, {" in chart_scr and '<canvas ref={cv} className="ch-cv" />' in chart_scr)
say("свечи: Binance (зеркало vision), Hyperliquid с HIP-3, Bybit, KuCoin; подгрузка истории назад; живая свеча вебсокетом",
    all(u in _cd for u in ('"/klines-vision"', '"/klines-hl"', "/klines-bybit?", "/klines-kucoin?"))
    and "export async function loadOlder(" in _cd and "wss://data-stream.binance.vision/ws/" in _cd
    and "wss://api.hyperliquid.xyz/ws" in _cd and "startPoll()" in _cd
    and "location = /klines-hl {" in _cngx and "proxy_pass https://api.hyperliquid.xyz/info;" in _cngx
    and _cngx.count("proxy_cache klines;") == 5 and "zone=kl:10m" in _cngx)
say("график: 14 таймфреймов, 6 видов, 53 индикатора + 5 своих, 21 инструмент рисования",
    "export const TFS: Tf[] = [\"1m\", \"3m\", \"5m\", \"15m\", \"30m\", \"1h\", \"2h\", \"4h\", \"6h\", \"12h\", \"1d\", \"3d\", \"1w\", \"1M\"];" in _cd
    and 'export type ChartType = "candles" | "hollow" | "heikin" | "bars" | "line" | "area";' in _ce
    and len(re.findall(r"^  (\w+): \{ kind: \"", _ci, re.M)) == 58
    and all(f'"chart_i_{k}"' in json.dumps(list(_ckeys)) for k in ("wt_oi", "wt_fund", "wt_liq", "rsi", "macd", "ichi"))
    and _cw.count(": 2,") + _cw.count(": 1,") + _cw.count(": 3,") + _cw.count(": 0,") >= 14
    and all(f'"{k}"' in chart_scr for k in ("trend", "ray", "ext", "hline", "hray", "vline", "channel", "rect", "fib", "fibext", "fibfan",
                                             "fibtime", "ew5", "abc", "tri", "wxy", "long", "short", "measure", "text", "brush"))
    and all(f"chart_i_{k}" in _ckeys for k in re.findall(r"^  (\w+): \{ kind: \"", _ci, re.M)))
say("Фибоначчи и Эллиотт: уровни на выбор, золотой карман, три правила импульса, пропорции волн",
    "export const FIB_ALL = [" in _cw and "const gold = l0 === 0.618 && l1 === 0.65;" in _cw
    and "export function elliottBroken(pts: Pt[]): string[]" in _cw and all(k in _ckeys for k in ("chart_ew_r2", "chart_ew_r3", "chart_ew_r4"))
    and "function waveRatio(" in _cw and "setFibEdit(true)" in chart_scr)
say("график будущего: лупа под пальцем, отмена и возврат, тех. рейтинг словами, далёкие уровни не сплющивают свечи",
    "private paintLoupe()" in _ce and "undo() {" in _ce and "redo() {" in _ce and "this.snap();" in _ce
    and "export function techRating(" in _ci and "setRateOpen(true)" in chart_scr
    and "noScale: true" in _ci and "d.noScale" in _ce and 'arrow = "↑ ";' in _ce)
say("график: жесты и шкалы как у TradingView — щипок, долгое нажатие, шкала цены, авто и лог, отсчёт до закрытия",
    'this.mode = "pinch"' in _ce and 'this.mode = "cross"' in _ce and 'this.mode = "price"' in _ce
    and "setLog(on: boolean)" in _ce and "private countdown(): string" in _ce and "this.ev.needOlder()" in _ce)
say("график: алерты по цене с горизонтали — сервер сверяет раз в 10 с и пишет ботом; ликвидации и киты на свечах",
    "def pxa_check() -> int:" in api and "threading.Thread(target=pxa_loop, daemon=True).start()" in api
    and "PXA_MAX = 30" in api and "CREATE TABLE IF NOT EXISTS px_alerts (" in api
    and '"/api/pxalert/add": pxa_add' in api and "WHERE id=? AND chat_id=?" in pybody(api, "def pxa_del(")
    and all(k in _ckeys for k in ("pxa_up", "pxa_dn", "chart_alert_on", "chart_alert_off", "chart_alerts"))
    and "def chart_liqs(sym: str, step: int) -> dict:" in api and "def chart_whales(coin: str) -> dict:" in api
    and '"chart/liqs", "chart/whales"' in api and "private paintLiqx(" in _ce and "private paintWhales(" in _ce
    and "seedAlerts(list);" in chart_scr)
say("график: алерты на наклонных линиях (и на лог-шкале) и тейк/стоп позиции; рисунки и настройки — на сервере, новее побеждает; сравнение монет в %",
    "def _pxa_level(" in api and "math.exp(math.log(p1) + (math.log(p2) - math.log(p1)) * k)" in api
    and 'con.execute(f"ALTER TABLE px_alerts ADD COLUMN {name} {decl}")' in api and all(k in _ckeys for k in ("pxa_lup", "pxa_ldn", "chart_alert_tpsl"))
    and "WHERE excluded.at >= chart_draw.at" in api and "WHERE excluded.at >= chart_prefs.at" in api and "CHART_BODY_MAX = 15 * 1024" in api
    and "pushDrawings(drawKey, list, localAt || Date.now())" in chart_scr and "alert2" in _cw
    and "setCompare(list: Compare[])" in _ce and "get pctMode()" in _ce and "const CMP_MAX = 3;" in chart_scr)
say("график: снимок 1280×800 в чат через бота, во весь экран, горячие клавиши как у TradingView",
    "def chart_snap(chat: str, body: dict) -> dict:" in api and "CHART_SNAP_HOUR = 20" in api
    and "location = /api/chart/snap {" in _cngx and "client_max_body_size 5m;" in _cngx
    and "snapshot(title: string, sub: string, W = 1280, H = 800)" in _ce
    and "wa?.requestFullscreen?.()" in chart_scr and 'html.ch-full .dock' in read(f"{APP}/src/styles/app.css")
    and 'KeyH: "hline"' in chart_scr and "nudge(n: number)" in _ce)
say("индикаторы в панелях не сжимают цену: идут ниже и листаются пальцем по вертикали",
    "const PEEK = 34;" in _ce and 'case "vscroll": {' in _ce and "private glideY()" in _ce and "this.fit = true;" in _ce
    and "ev.scroll?.(this.sy)" in _ce and "private paneTitle(p: Pane)" in _ce and 'ref={legendEl}' in chart_scr
    and "wa?.disableVerticalSwipes?.()" in chart_scr)
say("график помнит всё: монету, таймфрейм, вид, индикаторы, сравнение, %, лог — на устройстве и на сервере; строка индикатора не вылезает за экран",
    "setP({ sym: v });" in chart_scr and "log: (on) => setP({ log: on })," in chart_scr and "if (!arg && next.sym && next.sym !== sym) {" in chart_scr
    and "this.ev.log?.(this.log);" in _ce and "grid-template-columns: minmax(0, 1fr);" in read(f"{APP}/src/styles/app.css")
    and "width: fit-content; max-width: 100%; min-width: 0;" in read(f"{APP}/src/styles/app.css"))
say("текущая свеча и её цена — посередине окна (по ширине и высоте), пока не листали историю",
    "private centerRight()" in _ce and "if (this.centered && !this.fit) this.right = this.centerRight();" in _ce
    and "if (this.centered && n - 1 >= i0 && n - 1 <= i1" in _ce and "RIGHT_PAD_BARS" not in _ce)
_ccss = read(f"{APP}/src/styles/app.css")
say("свой стиль графика, не как у TradingView: круглые кнопки, капсула таймфреймов, плитки, свои иконки без эмодзи, бирка цены с носиком",
    'className="ch-tfs"' in chart_scr and 'className="ch-tiles row"' in chart_scr and "ch-tile-ic" in chart_scr
    and 'ToolIcon k="bell"' in chart_scr and 'ToolIcon k="camera"' in chart_scr and "🔔" not in chart_scr and "📷" not in chart_scr and "⛶" not in chart_scr
    and ".ch-tools button.grp::after" in _ccss and "border-right-color: currentColor" not in _ccss
    and "ctx.arcTo(xr, top, xr, top + r, r);" in _ce)
say("полный экран: график ниже кнопок Telegram (safe area), выход ✕ на самом графике и через Telegram",
    '"--ch-top"' in chart_scr and '"contentSafeAreaChanged"' in chart_scr and '"fullscreenChanged"' in chart_scr
    and 'className="ch-exitfull"' in chart_scr and "var(--ch-top, 0px)" in read(f"{APP}/src/styles/app.css"))
say("рисунки — во времени и цене, по монете на устройстве; настройки графика запоминаются",
    "export interface Pt {\n  t: number;\n  p: number;\n}" in _cw and 'const DRAW_KEY = "wt-chart-draw-v1";' in chart_scr
    and 'const PREFS_KEY = "wt-chart-v1";' in chart_scr)
say("монета графика запоминается", "tvSym: s.tvSym" in read(f"{APP}/src/store/app.ts"))

# --- поиск монеты на графике — по всем биржам, не только по своим ----------
say("справочник монет: Binance, Bybit, Hyperliquid и HIP-3",
    "def _symbols_build(" in api and "api.bybit.com/v5/market/instruments-info" in api
    and 'hl_post({"type": "meta"}' in pybody(api, "def _symbols_build(") and '"c": "rwa"' in api)
say("рынки HIP-3 (xyz:NVDA) — свечами Hyperliquid под своим именем",
    'if (m.hip3) return ["hl"];' in _cd and "hip3: `${dex}:${name}`" in _cd)
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
    and "function Candles(" in _lq and "function CoinPicker(" in _lq and "useLiqCoins()" in _lq
    and "fetchLiqCoins" in read(f"{APP}/src/components/CoinFind.tsx"))

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
    and _ngx.count('if ($http_x_api_key != "__API_KEY__") { return 403; }') == 7
    and _ngx.count('if ($http_x_api_key = "") { return 403; }') == 7
    # Четвёртый — Bullish, со своей широкой нормой: проход — полторы тысячи
    # запросов; пятый и шестой — вебсокеты ликвидаций Binance и Bybit;
    # седьмой — www.binance.com, объявления о листингах для календаря.
    and 'location /xr/binance-www/' in _ngx and '"https://www.binance.com/": "/xr/binance-www/"' in api
    and 'location /xr/bullish/' in _ngx and "zone=relay_bulk" in _ngx
    # Третий адрес — опционы Binance (eapi), закрыты по стране так же.
    and 'location /xr/binance-o/' in _ngx and '"https://eapi.binance.com/": "/xr/binance-o/"' in api
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
_fgl = read(f"{APP}/src/lib/fng.ts")
_fgpy = read(f"{APP}/wt_fng.py")
say("страх и жадность: вся история alternative.me с ценой BTC (mempool.space), две панели на одной оси времени",
    "fng_data = wt_fng.fng_data" in api and 'self._json_public("fng", wt_fng.fng_data())' in api
    and 'FNG_URL = "https://api.alternative.me/fng/?limit=0&format=json"' in _fgpy
    and "function Gauge(" in _fg and "P2 = {" in _fg and '"fg_st_left"' in _fg and '"fg_since_then"' in _fg)

say("страх и жадность: сколько подряд держится каждая зона, рекорд, куда уходит дальше, текущая полоса",
    "export function streakStats(" in _fgl and "streakStats(days, range !== \"all\")" in _fg and '"fg_st_now"' in _fg and '"fg_st_next"' in _fg)

_fi = read(f"{APP}/src/screens/FearGreedInsights.tsx")
say("страх и жадность: «что скрыто в данных» — край не разворот, цена после зон, покупки каждый день, похожие дни, оговорка",
    all(f"export function {f}(" in _fgl and f"{f}(days" in _fi for f in ("afterEntry", "forward", "dca", "analogs", "divergence"))
    and "export const FRESH = 7;" in _fgl and "for t in range(min(idx), max(idx) + DAY, DAY):" in _fgpy
    and '"fi_caveat"' in _fi and "<FearGreedInsights" in _fg)

_dm = read(f"{APP}/src/screens/DominanceScreen.tsx")
_dms = read(f"{APP}/wt_dom.py")
_dml = read(f"{APP}/src/lib/dom.ts")
say("альтсезон — свой расчёт по ценам Hyperliquid (wt_dom): индекс 100 монет за 90 дней (как у CoinMarketCap), сила альтов против биткоина, ETH/BTC; ни CoinMarketCap, ни Binance, ни DefiLlama; ответ проверяется (validDom); доли рынка нет — и это сказано",
    "dom_data = wt_dom.dom_data" in api and '"/api/dom"' in api and "wt_dom.set_cache_dir(CACHE_DIR)" in api
    and 'HOSTS = frozenset({"api.hyperliquid.xyz"})' in _dms and "TOP = 100" in _dms and "WINDOW = 90" in _dms
    and "parse_int=_int" in _dms and "_NoRedirect" in _dms and "BODY_MAX" in _dms
    and all(x not in (_dms + api[api.index("# --- Альтсезон и сила биткоина"):api.index("# --- ETF и крупные держатели")]).lower()
            for x in ("coinmarketcap.com", "binance.", "llama.fi", "coingecko.com"))
    and '_file_save("dom_px.json"' in _dms and "SAVE_EVERY = 25" in _dms and "FILE_MAX_AGE" not in _dms and '_file_save("dom.json", res)' in _dms
    and "global-metrics/quotes" not in api and "altcoin-season/chart" not in api and "symbol=ETHBTC" not in api
    and "export function validDom(" in _dml and "validDom(r)" in read(f"{APP}/src/lib/api.ts")
    and '"wt-dom-v2"' in read(f"{APP}/src/lib/storage.ts") and '"wt-dom-v1"' not in read(f"{APP}/src/lib/storage.ts")
    and '"dm_how_4"' in _dm and '"dm_building"' in _dm and "glyph: <DomGlyph />" in appx
    and "wt_dom.py" in read(f"{APP}/.github/workflows/tests.yml"))
_mcs = read(f"{APP}/wt_mcap.py")
say("доминация (BTC, альты, ETH, USDT) — только официальный API CoinMarketCap по ключу из окружения (CMC_API_KEY), без неофициальных адресов сайта; нет ключа — блока нет; ключ не в коде и не в журнале; источник подписан",
    'HOSTS = frozenset({"pro-api.coinmarketcap.com"})' in _mcs and 'os.environ.get("CMC_API_KEY"' in _mcs
    and '"X-CMC_PRO_API_KEY": key' in _mcs and '_log(f"HTTP {e.code}")' in _mcs
    and "api.coinmarketcap.com/data-api" not in (_mcs + api) and "coinmarketcap.com/data-api" not in (_mcs + api)
    and "mcap_data = wt_mcap.mcap_data" in api and '"/api/mcap"' in api
    and "export function validMcap(" in _dml and "validMcap(r)" in read(f"{APP}/src/lib/api.ts")
    and '"wt-mcap-v1"' in read(f"{APP}/src/lib/storage.ts") and '"dm_d_src"' in read(f"{APP}/src/components/CmcBy.tsx")
    and os.path.isfile(f"{APP}/tests/test_mcap.py") and "wt_mcap.py" in read(f"{APP}/.github/workflows/tests.yml")
    and os.path.isfile(f"{APP}/tests/test_mcap_fuzz.py") and 'f"{ROOT}/wt_mcap.py"' in read(f"{APP}/tools/mutate-etf.py"))
say("доминация укладывается в бесплатный план CoinMarketCap: дневной бюджет кредитов (счётчик на диске), пауза после неудачной истории, ответ и история на диске — перезапуск сервера кредитов не тратит",
    "DAY_BUDGET = 400" in _mcs and "HIST_RETRY" in _mcs and '_file_save("mcap_spent.json"' in _mcs
    and '_file_save("mcap.json"' in _mcs and '_file_save("mcap_hist.json"' in _mcs and "_last_load()" in _mcs
    and "TTL = 3600.0" in _mcs and "HIST_TTL = 12 * 3600.0" in _mcs)
_cmc = read(f"{APP}/src/components/CmcBy.tsx") if os.path.isfile(f"{APP}/src/components/CmcBy.tsx") else ""
say("доминация и альтсезон — кеш и права: ответы /api/dom и /api/mcap кодируются раз на ответ, с ETag и «304 не изменилось»; копия доминации на телефоне — исходный ответ сервера (не теряет долю стейблкоинов); источник — ссылкой на CoinMarketCap и на экране, и в дайджесте; в канал цифры CoinMarketCap не уходят; форматтеры Intl — из кэша",
    "def _json_public(self, name: str, obj: dict):" in api and 'self._json_public("dom" if dom else "mcap"' in api
    and '"If-None-Match"' in api and os.path.isfile(f"{APP}/tests/test_dom_http.py")
    and "writeSaved(MCAP_SAVED, { all: { at: Date.now(), v: r } })" in read(f"{APP}/src/lib/api.ts")
    and 'CMC_URL = "https://coinmarketcap.com/"' in _cmc and "<CmcBy lang={lang} />" in _dm
    and "<CmcBy lang={lang} />" in read(f"{APP}/src/screens/DigestMore.tsx")
    and "test_channel_does_not_carry_coinmarketcap_numbers" in read(f"{APP}/tests/test_digest_sources.py")
    and "const NF = new Map<string, Intl.NumberFormat>();" in read(f"{APP}/src/lib/format.ts")
    and "dtf(lang, { timeZone: \"UTC\", ...opts })" in read(f"{APP}/src/screens/timeAxis.ts"))
say("доминация и альтсезон — повторная ревизия: ответ источника читается по кускам с общим сроком (не держит сборку часами), копии с диска читаются один раз, полночь не роняет бюджет кредитов, USDT не больше 100 − BTC; графики ставят точки по датам (неделя и день вперемешку не расходятся с подписями лет)",
    _dms.count("r.read1(") == 1 and _mcs.count("r.read1(") == 1 and "if time.monotonic() > end:" in _dms and "if time.monotonic() > end:" in _mcs
    and "_st.loaded = True" in _dms and "_st.loaded = True" in _mcs and "_spent().get(day, 0)" in _mcs
    and "u <= 100 - _pct(btc)" in _mcs and "export function nearestIdx(" in _dml
    and _dm.count("const xOf = (i: number) => xOfT(") == 2 and _dm.count("nearestIdx(times, ") == 2
    and "test_slow_drip_is_cut_by_the_deadline" in read(f"{APP}/tests/test_mcap.py")
    and "test_slow_drip_is_cut_by_the_deadline" in read(f"{APP}/tests/test_dom.py")
    and read(f"{APP}/tools/mutate-etf.py").count("drop_pyc(path)") >= 4 and "signal.signal(signal.SIGTERM, restore_and_exit)" in read(f"{APP}/tools/mutate-etf.py"))
say("доминация и альтсезон — ревизия №3: цветной текст с контрастом не ниже 4,5:1 (INK светлее линий), часы телефона могут отставать до года — дни ответа сверяются с его собственным временем",
    'const INK = { btc: C.btc, alt: "#a78bfa", mid: "#9ca3af" } as const;' in _dm and "SEASON[seasonOf(now[1])].c }}" not in _dm
    and "export const CLOCK_LAG = 366 * DAY;" in _dml and "within(ts, PX_FROM, at + 2 * DAY)" in _dml and "within(ts, MCAP_FROM, at + DAY)" in _dml
    and "цветной текст читается" in read(f"{APP}/tests/e2e/dom.e2e.test.ts") and "часы телефона отстают на 10 дней" in read(f"{APP}/tests/e2e/dom.e2e.test.ts"))
say("альтсезон бережёт общий лимит Hyperliquid (1200 весов в минуту на адрес — вместе с ботом): пауза 5 с между запросами; на 429 — пауза и повтор, не отпускает — обход прерывается с сохранением полученного и отдых 30 минут",
    "PACE = 5.0" in _dms and "class _Limited(Exception):" in _dms and "if e.code == 429:" in _dms
    and "LIMIT_WAIT = 60.0" in _dms and "LIMIT_REST = 1800.0" in _dms and "or now < _st.rest" in _dms
    and "test_429_that_never_ends_stops_the_pass_keeps_progress_and_rests" in read(f"{APP}/tests/test_dom.py"))
say("альтсезон честный: корзина на каждый день — самые торгуемые за 30 дней до него (без заглядывания вперёд), со снятыми потом монетами, только закрытые дни, не меньше 30 монет; ширина 25/50/100; это сказано на экране",
    "VOLW = 30" in _dms and "MIN_BASKET = 30" in _dms and 'EXCLUDE = frozenset({"PAXG", "USTC", "NFTI"})' in _dms and "TIERS = (25, 50, 100)" in _dms
    and '{"type": "meta"}' in _dms and 'u.get("isDelisted")' in _dms and "metaAndAssetCtxs" not in _dms
    and "PX_FROM <= ts < _today()" in _dms and "sums[i] - sums[max(0, i - VOLW)]" in _dms
    and "export const MIN_BASKET = 30;" in _dml and "r.length !== 6" in _dml
    and '"dm_tiers"' in _dm and '"dm_day"' in _dm and '"dm_how_6"' in _dm)
say("альтсезон на уровне халвинга и ETF: правила кода и fuzz сервера (годный ответ принимает приложение), свойства расчётов, строгий TypeScript; свои стили, колонка до 760 px, графики в настоящих пикселях и с клавиатуры, таблица, сохранённая копия без плашки «не удалось» (повтор сам через минуту), пометка о старых данных, свежий ответ при возврате через час, подгрузка при запуске",
    all(os.path.isfile(f"{APP}/tests/{f}") for f in ("test_dom_policy.py", "test_dom_fuzz.py", "dom.props.test.ts", "dom.test.ts", "test_dom.py"))
    and os.path.isfile(f"{APP}/tests/e2e/dom.e2e.test.ts") and '"typecheck:dom"' in read(f"{APP}/package.json")
    and "npm run typecheck:dom" in read(f"{APP}/.github/workflows/tests.yml")
    and 'import "./DominanceScreen.css";' in _dm and ".dm { max-width: 760px;" in read(f"{APP}/src/screens/DominanceScreen.css")
    and "const W = useWidth(ref);" in _dm and "onKeyDown={onKey}" in _dm and "function AltTable(" in _dm
    and '"op_stale"' not in _dm and "FAIL_RETRY_MS" in _dm and '"dm_old"' in _dm and '"visibilitychange"' in _dm
    and "jobs.push(() => fetchDom());" in read(f"{APP}/src/lib/prefetch.ts")
    and "EB_MIN, EB_MAX = 1e-6, 10.0" in _dms and "STR_LOG = math.log(1e3)" in _dms)

_fs = read(f"{APP}/src/screens/FundingScreen.tsx")
say("фандинг не пропадает: собирается первым, при сбое — прошлый; пока ставок нет — загрузка с переспросом, а не «нет аномалий»",
    'funding = take("funding", lambda: load_funding(hl), was.get("fund") or funding)' in api
    and api.index('funding = take("funding"') < api.index('rank = take("rank"')
    and "function FundWaiting(" in _fs and "if (!have.length) return <FundWaiting />;" in _fs
    and "syncNow()" in _fs and '"fund_fail"' in _fs)

_sy = read(f"{APP}/src/lib/sync.ts")
say("фандинг после перезапуска: биржи опрашиваются разом, кэш пересобирается сразу, приложение переспрашивает по «fund:later»",
    "pool.submit(fund_pull, ex)" in api and "wait(futs, timeout=25)" in api and "_fund_ready.set()" in api
    and 'errors.append("fund:later")' in api and 'p === "fund:later"' in _sy)

_un = read(f"{APP}/src/screens/UnlocksScreen.tsx")
say("токеномика: видно, что монету можно открыть — стрелка в строке и подсказка до первого нажатия",
    '<span className="unl-chev" aria-hidden="true" />' in _un and '"unl_tap_hint"' in _un and "localStorage.setItem(TIP_KEY" in _un)

_ef = read(f"{APP}/src/screens/EtfScreen.tsx")
_etfs = read(f"{APP}/wt_etf.py")
say("институциональные потоки — только биткоин: потоки фондов по дням (открытый набор TFTC), спрос против добычи; без «кто докупал за неделю» и подписи источников; других монет нет",
    'SYMBOL = "BTCUSDT"' not in _etfs and "type Coin" not in _ef and "Segmented<Coin>" not in _ef
    and "ETHUSDT" not in _etfs and "SOLUSDT" not in _etfs and "HYPE" not in _etfs
    and "etf_data = etf.etf_data" in api and "import wt_etf as etf" in api and '"/api/etf"' in api
    and "def etf_data(" in _etfs and "coinmarketcap" not in _etfs.lower() and "def _base(" not in _etfs
    and "coingecko.com/api/v3/governments" not in api
    and "etf_data()  # и потоки ETF" in api
    and "from whale_api" not in _etfs and "import whale_api" not in _etfs
    and "function FlowChart(" in _ef and "function Funds(" in _ef and "movers" not in _ef + _etfs
    and '"ef_src"' not in _ef and '"ef_m_title"' not in _ef
    and "export function minedPerDay(" in read(f"{APP}/src/lib/etf.ts") and "stats.mined" in _ef and "glyph: <EtfGlyph />" in appx)

_hv = read(f"{APP}/src/components/HalvingCard.tsx")
_hvl = read(f"{APP}/src/lib/halving.ts")
_hvs = read(f"{APP}/wt_halving.py")
_hvc = read(f"{APP}/src/components/HalvingCard.css")
# Автотесты халвинга (приложение и сервер) — гоняем прямо здесь: красные
# тесты не должны уехать в main.
import subprocess as _sp
_t_js = _sp.run(["node", "--test", "tests/halving.test.ts", "tests/halving.props.test.ts", "tests/tick.test.ts"], cwd=APP, capture_output=True, text=True)
_t_py = _sp.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], cwd=APP, capture_output=True, text=True)
say("халвинг: автотесты расчёта в приложении (node --test) и сервера (unittest, без сети) зелёные",
    _t_js.returncode == 0 and "# fail 0" in _t_js.stdout and _t_py.returncode == 0 and "OK" in _t_py.stderr)
if _t_js.returncode or _t_py.returncode:
    print(_t_js.stdout[-1500:], _t_py.stderr[-1500:])
# Браузерный тест карточки — на собранном html/. Где нет Chromium для
# Playwright (сервер бота), он пропускается, и об этом сказано.
_t_e2e = _sp.run(["node", "--test", "tests/e2e/halving.e2e.test.ts"], cwd=APP, capture_output=True, text=True)
_no_browser = "Executable doesn't exist" in _t_e2e.stdout + _t_e2e.stderr or "Cannot find package 'playwright'" in _t_e2e.stdout + _t_e2e.stderr
if _no_browser:
    print("--  халвинг: браузерный тест пропущен — нет Playwright/Chromium (npm i; npx playwright install chromium)")
else:
    say("халвинг: браузерный тест карточки (29 проверок: шрифт со своего сервера и ничего наружу, отсчёт до секунды, свои классы, часы, заглушка, сбои, старый ответ с пометкой «Обновлено» и без карточки через сутки, подделка, оценка прошла без блока халвинга, свёрнутое приложение, 16 языков, 320–1280 px и ×1–×3, крупный шрифт до 200 %, вырез и полоска iPhone, высокая контрастность, арабский, доступность) зелёный",
        _t_e2e.returncode == 0 and "# fail 0" in _t_e2e.stdout and "# pass 29" in _t_e2e.stdout)
    if _t_e2e.returncode:
        print(_t_e2e.stdout[-2500:])
# Модуль халвинга: сервер — wt_halving.py, расчёт и тип — lib/halving.ts,
# вид — HalvingCard.tsx + .css. В общих файлах — только подключение.
say("халвинг — отдельный модуль: сервер, расчёт, тип, вид и стили в своих файлах, в общих — только подключение",
    "import wt_halving as halving" in api and "halving_data = halving.halving_data" in api
    and 'self._json(200, halving.reply())' in api and "mempool" not in api.split("# --- Халвинг")[1].split("# --- Bitcoin")[0]
    and "export interface HalvingReply" in _hvl and "HalvingReply" not in read(f"{APP}/src/lib/types.ts")
    and 'import "./HalvingCard.css";' in _hv and ".hv" not in read(f"{APP}/src/styles/app.css").replace("HalvingCard.css", "")
    and "from whale_api" not in _hvs and "import whale_api" not in _hvs
    and '<Boundary name="halving"><HalvingCard /></Boundary>' in appx and "static getDerivedStateFromError()" in read(f"{APP}/src/components/Boundary.tsx"))
say("халвинг: среднее за эпоху, отсчёт от последнего блока, фон и пауза после сбоя, проверка ответа, поправка часов, блок халвинга — только от сервера, доступность",
    'avg, src = t, "epoch"' in _hvs and "mempool.space/api/blocks/tip/hash" in _hvs and "JSON_MAX = 4096" in _hvs and "_DECODER = json.JSONDecoder(" in _hvs and "START_TS = {840_000: 1713571767}" in _hvs
    and "ERR_TTL = 60.0" in _hvs and "        if _failed():\n            return hit[1] if hit else _no_data()\n        job = _start()" in _hvs and 're.fullmatch(r"[0-9a-f]{64}", bh)' in _hvs
    and 'res["prev"] = start_ts' in _hvs and '"now": _now()' in _hvs and "STALE_MAX = 86_400.0" in _hvs
    and "export const STALE_MAX = 86_400;" in _hvl and 'age === "old" ? <p className="hv-old">' in _hv
    and '"at": t_now, "by": by}' in _hvs and 'h.by ? <p className="hv-src">' in _hv
    and "opt(r.eta, time)" in _hvl and "donePct: Math.min(99.9, Math.round(done * 10) / 10)," in _hvl
    and "const height = Math.min(h.next - 1," in _hvl and "export function subsidySats(" in _hvl
    and "const eta = h.eta ?? h.at + (h.next - h.height) * h.avg;" in _hvl
    and "halvingView(h, local + (h.skew ?? 0))" in _hv and 'role="progressbar"' in _hv and 'role="timer"' in _hv
    and "aria-labelledby={titleId}" in _hv and "<BtcGlyph />" in _hv and "₿" not in _hv
    and ".hv-avg { margin: 2px 0 0; color: var(--dim);" in _hvc
    and "BUDGET = 20.0" in _hvs and "hop = min(HOP, left)" in _hvs
    # Защита от атак через источник: только https и три адреса, без
    # перенаправлений, числа конечные и короткие, срок на весь ответ.
    and 'HOSTS = frozenset({"mempool.space", "blockstream.info", "blockchain.info"})' in _hvs
    and "build_opener(urllib.request.ProxyHandler({}), _NoRedirect," in _hvs and "if not _allowed(url):" in _hvs and "urlopen" not in _hvs
    and "parse_float=_finite, parse_int=_short_int," in _hvs and "except (ValueError, RecursionError):" in _hvs
    and "        _watch(sock, end)\n" in _hvs and "watch.shutdown(socket.SHUT_RDWR)" in _hvs and "dns.join(max(0.0, end - time.monotonic()))" in _hvs and _hvs.count("print(") == 1
    and os.path.exists(f"{APP}/tests/test_halving_security.py") and "pickHalving(r)" in read(f"{APP}/src/lib/api.ts")
    # Поля ответа сходятся между собой; свёрнутое приложение сеть не трогает.
    and "r.every === EVERY" in _hvl and "&& consistent(r as HalvingReply);" in _hvl
    and 'document.addEventListener("visibilitychange", visible);' in _hv and 're.fullmatch(rb"[0-9]{1,20}", raw)' in _hvs
    and "return v if type(v) is int else 0" in _hvs and "while len(buf) <= limit:" in _hvs and "except (TypeError, ValueError, OverflowError)" not in _hvs
    # Защита от «тихих» правок: правила кода модуля — в тестах; сборка на
    # GitHub закреплена по хешам; соединение напрямую, без сжатия.
    and os.path.exists(f"{APP}/tests/test_halving_policy.py") and "urllib.request.ProxyHandler({})" in _hvs
    and '"Accept-Encoding": "identity"' in _hvs and "TLSv1_2" in read(f"{APP}/tests/test_halving_policy.py")
    and "var(--hv-fit, 1)" in _hvc and "var(--hv-fit-l, 1)" in _hvc and "@media (forced-colors: active)" in _hvc
    and "frame = requestAnimationFrame(fit)" in _hv and "document.fonts?.ready.then(later)" in _hv and "--drawer-pb: calc(env(safe-area-inset-bottom) + 18px);" in read(f"{APP}/src/styles/app.css")
    and "persist-credentials: false" in read(f"{APP}/.github/workflows/tests.yml") and "actions/checkout@v" not in read(f"{APP}/.github/workflows/tests.yml")
    # Срок ответа на сервере и в памяти приложения — один (5 минут).
    and "TTL = 300.0" in _hvs and "export const HALVING_TTL_MS = 5 * 60_000;" in _hvl
    and "class _State:" in _hvs and "_cache" not in _hvs
    and "def _plausible(h: int) -> bool:" in _hvs and "class Reply(TypedDict):" in _hvs
    and "export function unitLabel(" in _hvl and "export function clockSpeech(" in _hvl
    and "unitLabel(lang, CLOCK_UNITS[i]!, n) ?? t(lang, FALLBACK[i]!)" in _hv
    and os.path.exists(f"{APP}/tests/halving.props.test.ts") and os.path.exists(f"{APP}/tests/test_halving_fuzz.py")
    and "typecheck:halving" in read(f"{APP}/package.json") and 'python: ["3.10", "3.11", "3.12", "3.13"]' in read(f"{APP}/.github/workflows/tests.yml") and "const untilNextSecond = " in read(f"{APP}/src/lib/tick.ts")
    and "if 1_700_000_000 < ts <= _now():" in _hvs and "except RuntimeError as e:" in _hvs and os.path.exists(f"{APP}/tools/mutate-halving.py")
    and "python tools/mutate-halving.py" in read(f"{APP}/.github/workflows/tests.yml") and "&& r.height >= ANCHOR_HEIGHT" in _hvl
    # Высота — от настоящего блока, одинаково на сервере и в приложении; первый запрос не ждёт дольше приложения.
    and "ANCHOR_HEIGHT, ANCHOR_TS = 971_219, 1_791_881_177" in _hvs and "const ANCHOR_HEIGHT = 971_219;" in _hvl
    and "const ANCHOR_TS = 1_791_881_177;" in _hvl and "GENESIS_TS" not in _hvs + _hvl
    and "    job.join(COLD_WAIT)\n" in _hvs and "COLD_WAIT = 8.0" in _hvs and "_cold" not in _hvs
    and '<p className="hv-rw" aria-hidden="true"><span className="hv-ph">' in _hv and ".hv-rw b { color: var(--ink); font-weight: 700; display: inline-block; }" in _hvc and ".hv-meta > .hv-blk { white-space: normal;" in _hvc and "HALVING_TTL_MS + 5_000" in _hv
    and 'remember<HalvingReply | null>("/api/halving", HALVING_TTL_MS' in read(f"{APP}/src/lib/api.ts")
    and 'className="hv hv-skel" aria-busy="true"' in _hv and "prefers-reduced-motion: reduce" in _hvc
    and "if (Math.abs(t - stamp) >= 1000) stamp = t;" in read(f"{APP}/src/lib/tick.ts")
    and "export function BtcGlyph(" in read(f"{APP}/src/components/ui.tsx")
    and "<HalvingCard />" in appx and "drawer-build" not in appx and 'int(hv.get("eta") or' in api)
# Самоочистка: каждый ключ «wt-…» из кода — в списке KEEP, иначе уборка
# сотрёт его при следующем запуске.
_st = read(f"{APP}/src/lib/storage.ts")
_keep = set(re.findall(r'"(wt-[a-z0-9-]+)"', _st.split("const KEEP")[1].split("]);")[0]))
_used = set()
for _root, _dirs, _files in os.walk(f"{APP}/src"):
    for _f in _files:
        if _f.endswith((".ts", ".tsx")) and _f != "storage.ts":
            _used |= set(re.findall(r'["`\'](wt-[a-z0-9-]+)["`\']', read(os.path.join(_root, _f))))
_used.discard("wt-go")  # sessionStorage, живёт до закрытия
say("самоочистка хранилища: все ключи приложения в списке, уборка после запуска, старые запасы и прошедший халвинг стираются",
    not (_used - _keep) and "setTimeout(sweepStorage, 4000);" in read(f"{APP}/src/main.tsx")
    and "SAVED_MAX_AGE = 30 * 24 * 3600_000" in _st and 'key === "wt-halving-v1"' in _st
    and "OPT_SAVED_KEEP = 4;" in read(f"{APP}/src/lib/api.ts"))
if _used - _keep:
    print("   нет в KEEP:", sorted(_used - _keep))
_dgt = read(f"{APP}/src/screens/DigestTab.tsx")
say("дайджест: просмотры — каждый человек один раз, счётчик у каждого выпуска",
    "CREATE TABLE IF NOT EXISTS digest_views" in api and "INSERT OR IGNORE INTO digest_views" in api
    and '"/api/digest/view": "view"' in api and "DELETE FROM digest_views WHERE chat_id=?" in api
    and "viewDigest(it.id)" in _dgt and 'className="dg-views"' in _dgt)

say("институциональные потоки: накопленный приток, доля фондов",
    "cum={mode === \"c\" ? cumView : null}" in _ef and '"ef_mshare"' in _ef and 'coinsShort(lang, stats.held, "", false)' in _ef)

_em = read(f"{APP}/src/screens/EtfMore.tsx")
say("институциональные потоки: позиции CME по CFTC; только открытые источники — цен Coinbase и Binance нет (их условия запрещают показывать данные в приложении), цена дня — из набора TFTC, в подписи — «данные по»",
    "def _cme(" in _etfs and "publicreporting.cftc.gov" in _etfs and "def _cbp(" not in _etfs
    and 'HOSTS = frozenset({"publicreporting.cftc.gov", "www.tftc.io"})' in _etfs and "def _klines(" not in _etfs
    and "days, px, tna, through = _tftc()" in _etfs
    and "export function CmeSection(" in _em and "CbpSection" not in _em + _ef and "cbp" not in read(f"{APP}/src/lib/etf.ts")
    and '"ef_through"' in _ef and '"cbp"' not in read(f"{APP}/src/screens/DigestMore.tsx") and '"cbp"' not in read(f"{APP}/wt_digest_img.py")
    and 'sig.append({"k": "cbp"' not in api
    and "HoldersAll" not in _em + _ef and "AltHolders" not in _em + _ef and "<CmeSection" in _ef)
_fgs = read(f"{APP}/src/screens/FearGreedScreen.tsx")
_dgm2 = read(f"{APP}/src/screens/DigestMore.tsx")
_dgi = read(f"{APP}/wt_digest_img.py")
say("страх и жадность: источник alternative.me рядом с индексом везде, где он показан (условие их API)",
    'export const FNG_URL = "https://alternative.me/crypto/fear-and-greed-index/";' in _fgs
    and '<p className="fg-by">' in _fgs and 'onClick={open(FNG_URL)}>alternative.me</a>' in _fgs
    and 'onClick={open(PX_URL)}>mempool.space</a>' in _fgs
    and 's.k === "fng" ? <small> · alternative.me</small>' in _dgm2 and "(alternative.me)` : \"—\"" in _dgm2
    and 't(lang, "fg_by")} alternative.me.' in _dgm2
    and "(alternative.me)\" if zone else" in _dgi and '{"fng": " · alternative.me", "etf": " · TFTC"}.get(s["k"], "")' in _dgi)
_fgt = read(f"{APP}/.github/workflows/tests.yml")
say("страх и жадность — отдельный модуль, как халвинг: wt_fng (alternative.me + mempool.space, без бирж), lib/fng.ts с проверкой ответа, строгий TS, тесты api/fuzz/security/policy, unit/props/e2e, мутации в CI, «?» у каждого раздела",
    "import wt_fng" in api and "_fng_btc_binance" not in api and "_fng_btc_coinbase" not in api and "def _fng_build" not in api
    and 'HOSTS = frozenset({"api.alternative.me", "mempool.space"})' in _fgpy
    and all(x not in _fgpy.split('"""', 2)[2].lower() for x in ("binance.", "coinbase.com", "kraken.com", "coingecko"))
    and "export function validFng(" in _fgl and 'const FNG_SAVED = "wt-fng-v2";' in read(f"{APP}/src/lib/api.ts")
    and '"wt-fng-v2"' in read(f"{APP}/src/lib/storage.ts") and '"wt-fng-v1"' not in read(f"{APP}/src/lib/storage.ts")
    and all(os.path.isfile(f"{APP}/{f}") for f in (
        "tests/test_fng_api.py", "tests/test_fng_fuzz.py", "tests/test_fng_security.py", "tests/test_fng_policy.py",
        "tests/fng.test.ts", "tests/fng.props.test.ts", "tests/e2e/fng.e2e.test.ts", "tests/fixtures/fng.json",
        "tools/mutate-fng.py", "tools/typecheck-fng.mjs"))
    and "npm run typecheck:fng" in _fgt and "python tools/mutate-fng.py" in _fgt and "wt_fng.py" in _fgt
    and "mempool.space" in read(f"{APP}/src/i18n/ru.ts").split("fg_src:")[1].split("\n")[0]
    and _fg.count("<SectionTitle help=") == 4 and read(f"{APP}/src/screens/FearGreedInsights.tsx").count("<SectionTitle help=") == 5)
say("защита API: бан за промахи ключом — кроме своей машины (127.0.0.1 — это nginx; проверка curl'ом не закроет приложение)",
    "if _loopback(ip):\n            return" in read(f"{APP}/wt_shield.py")
    and os.path.isfile(f"{APP}/tests/test_shield_bans.py"))
say("кеш: тяжёлые ответы API — и на диске (после перезапуска сразу, свежий — в фоне); ETF, отчёты SEC и альтсезон (ответ и цены) — тоже; в приложении — дайджест и кошелёк BTC на устройстве",
    "def disk_cache(store: dict, name: str) -> dict:" in api and "def _disk_load(name: str, key):" in api
    and 'disk_cache(_BTC, "btc")' in btcpy and "disk_cache=disk_cache" in api and 'disk_cache({}, "bscx")' in api and 'disk_cache({}, "opt")' in api
    and "wt_fng.set_cache_dir(CACHE_DIR)" in api and "_file_save(res)" in read(f"{APP}/wt_fng.py") and "wt_dom.set_cache_dir(CACHE_DIR)" in api
    and 'etf.set_cache_file(os.path.join(CACHE_DIR, "etf.json"))' in api and "treasury.set_cache_dir(CACHE_DIR)" in api
    and "def _file_load() -> dict[str, Json] | None:" in _etfs and "_file_save(\"sec_funds.json\", out)" in read(f"{APP}/wt_treasury.py")
    and 'const DIGEST_SAVED = "wt-digest-v1";' in read(f"{APP}/src/lib/api.ts")
    and "exGet<BtcWalletReply>(btcWalletPath(addr), BTC_TTL, WALLET_STORE)" in read(f"{APP}/src/lib/api.ts")
    and "api_cache/" in read(f"{APP}/.gitignore") and os.path.isfile(f"{APP}/tests/test_disk_cache.py"))
_tre = read(f"{APP}/wt_treasury.py")
say("крупнейшие держатели: ETF и компании (по их отчётам в SEC, CryptoAssetNumberOfUnits), без государств; выбор группы",
    "export function Holders(" in _em and '<Boundary name="etf-holders"><Holders rows={reply.holders ?? []}' in _ef
    and 'out.holders = raw["holders"].filter(holderRow)' in read(f"{APP}/src/lib/etf.ts")
    and '{ id: "COMPANY", key: "ef_g_co" }' in _em and "GOVERNMENT" not in _em + _etfs
    and '"holders": _holders(coins.get("btc"), companies)' in _etfs and "co_f = pool.submit(wt_treasury.companies)" in _etfs
    and 'HOST = "data.sec.gov"' in _tre and "/us-gaap/CryptoAssetNumberOfUnits.json" in _tre
    and 'os.environ.get("WT_SEC_UA"' in _tre and "if prev is not None and prev >= JUMP_FLOOR" in _tre
    and "coingecko" not in _tre.lower() and "coinmarketcap" not in _tre.lower()
    and "wt_treasury.py tests/test_treasury.py" in read(f"{APP}/.github/workflows/tests.yml"))
_wsm = read(os.path.join(BOT, "main.cpp"))
_wse = read(os.path.join(BOT, "btc_etf.cpp"))
_wsc = read(os.path.join(BOT, "btc_chain.cpp"))
say("бот: /import — кнопки фондов (IBIT, FBTC…) и «Другое»; файл CSV; тикер в строке — разметка сама; уже добавленный без метки ETF — получает её; «Другое» — без меток; только владелец; метку ставит сканер с ближайшим блоком",
    "std::string importKeyboard(long long id)" in _wsm and 'callback_data", "imp:" + std::to_string(id) + ":other"' in _wsm
    and "if (handleImportCallback(cq)) continue;" in _wsm and "if (from != OWNER_CHAT_ID) {" in _wsm.split("bool handleImportCallback(")[1][:900]
    and "importCommand(cid, txt);" in _wsm and "tgFileText(m[\"document\"])" in _wsm and "IMPORT_FILE_MAX" in _wsm
    and "int etfDrainLabels(sqlite3* db, EtfLabels& applied)" in _wse and "++r.inBase;" in _wse and "named" not in _wse
    and "UPDATE btc_watch SET src = 'import' WHERE address = ? AND src = 'auto'" in _wsc and "WHERE btc_etf_addr.how != 'seed'\");" in _wse
    and "if (etfDrainLabels(g_btcDb, etfNew) < 0) ++g_txErrs;" in _wsc and "backfillImported" not in _wsc)
say("старых алертов по ETF (по фондам, wt_etfalert) нет: ни модуля, ни экрана, ни адресов API; их таблицы стираются при запуске",
    not os.path.exists(f"{APP}/wt_etfalert.py") and not os.path.exists(f"{APP}/src/screens/EtfAlerts.tsx")
    and "etfalert" not in api and "EtfAlert" not in _ef and "FundBell" not in _ef
    and "etfAlert" not in read(f"{APP}/src/lib/api.ts") and "wt-etfa" not in read(f"{APP}/src/lib/storage.ts")
    and '(lambda: DB, ("etf_alert_subs", "etf_alert_sent", "etf_alert_state"))' in api and "    old_tables_drop()\n" in api
    and ".ef-bell" not in read(f"{APP}/src/styles/app.css") and "wt_etfalert" not in read(f"{APP}/.github/workflows/tests.yml"))
say("ETF: итоги каждого дня в Telegram — по желанию, только с Премиумом, любое движение (кто купил и кто продал), один день — одно сообщение, свежий и устоявшийся день (3 ч без изменений), сбой сети — не отписка, дата словами, в каждом сообщении источник TFTC и лицензия",
    "if not v and not buy and not sell:" in api and "ETFD_MIN" not in api and "def etfd_check() -> int:" in api and "INSERT OR IGNORE INTO etf_day_sent" in api
    and "if not chat_premium(chat):\n                continue" in api and "now() - ts > ETFD_FRESH" in api
    and 'if body.get("on") is True and not chat_premium(chat):' in api and "dgi.TFTC_BY_POST}\")" in api
    and "ETFD_STABLE = 3 * 3600" in api and "if now() - seen[1] < ETFD_STABLE:" in api
    and "def etfd_send(chat: str, text: str) -> bool | None:" in api and "if e.code == 403 or (" in api
    and "                if down >= 3:\n                    break" in api and "d=dgi.date_word(lang, day)" in api
    and "INSERT OR IGNORE INTO etf_new_funds" in api
    and "threading.Thread(target=etfd_loop, daemon=True).start()" in api and "<DayAlert lang={lang} />" in _ef
    and 'role="switch"' in _ef and "test_etf_day_alert.py" in read(f"{APP}/.github/workflows/tests.yml"))
_tre1 = read(f"{APP}/wt_treasury.py")
say("ETF: защита от подменённого источника — целые не длиннее 18 цифр (огромное целое не роняет разбор), не больше 60 фондов в наборе, не больше трёх сообщений о новых фондах за сборку",
    "parse_int=_int" in _etfs and "parse_int=_int" in _tre1 and "INT_DIGITS = 18" in _etfs and "INT_DIGITS = 18" in _tre1
    and "except (TypeError, ValueError, OverflowError):" in _etfs and "    except OverflowError:\n        return False" in _tre1
    and "FUNDS_MAX = 60" in _etfs and "not in _st.told)[:NEW_MAX]" in _etfs
    and "test_huge_integers_do_not_crash_the_build" in read(f"{APP}/tests/test_etf_security.py"))
_wsb = read(os.path.join(BOT, "btc_chain.cpp"))
_tre0 = read(f"{APP}/wt_treasury.py")
say("ETF: потоки по дням — открытый набор TFTC (CC BY 4.0), на экране источник и лицензия со ссылками; запас — отчёты SEC плюс потоки после них; снимка и сводок CoinMarketCap нет; флаги фондов",
    "flagOf(f.c)" in _ef and not os.path.exists(f"{APP}/data/etf_base.json") and "BASE_FILE" not in _etfs
    and 'TFTC = "https://www.tftc.io/bitcoin-etf-flows/data.json"' in _etfs and '"www.tftc.io"' in _etfs
    and "coinmarketcap" not in _etfs.lower() and "def _tftc() -> " in _etfs and "TICKER.fullmatch(k)" in _etfs
    and "def _last_report(" in _etfs and "sec = _sec(sec_of() if sec_of else wt_treasury.etf_funds())" in _etfs
    and 'export const TFTC_URL = "https://www.tftc.io/bitcoin-etf-flows";' in read(f"{APP}/src/screens/etfView.ts")
    and 'export const CCBY_URL = "https://creativecommons.org/licenses/by/4.0/";' in read(f"{APP}/src/screens/etfView.ts")
    and "openExternal(TFTC_URL)" in _ef and "openExternal(CCBY_URL)" in _ef and '"ef_by_ch"' in _ef
    and "def fund_points(" in _tre0 and "def etf_funds(" in _tre0
    and '("IBIT", "iShares Bitcoin Trust", 1980994)' in _tre0 and "/api/xbrl/companyfacts/CIK" in _tre0
    and "set_holders" not in api and "gov_base" not in api and "govBlock" not in _wsb)

_btv = read(f"{APP}/src/screens/BtcViews.tsx")
_ws_btc = read(os.path.join(BOT, "btc_chain.cpp"))
say("bitcoin: сканер блоков бота, база сервисного аккаунта с порогом $50, /statsbtc",
    ("WATCH_MIN_USD_NANOS = 50LL" in _ws_btc and "CREATE TABLE IF NOT EXISTS btc_watch" in _ws_btc
                    and "std::string btcStatsLine()" in _ws_btc
                    and 'txt=="/statsbtc"' in read(os.path.join(BOT, "main.cpp"))))
say("bitcoin: блоки с узлов по JSON-RPC (свой WHALE_BTC_RPC + публичные), без blockchain.info и walletexplorer",
    'btcRpc("getblock", json::array({b.hash, 3})' in _ws_btc and 'std::getenv("WHALE_BTC_RPC")' in _ws_btc
    and 'if (!i.contains("prevout") || !i["prevout"].is_object()) return false;' in _ws_btc
    and "std::string safeUrl(const std::string& url)" in _ws_btc and "body->size() + s * n > BODY_MAX" in _ws_btc
    and "DELETE FROM btc_labels WHERE how = 'we';" in _ws_btc
    and "blockchain.info" not in _ws_btc and "walletexplorer.com/api" not in _ws_btc
    and "/api/block/" not in _ws_btc and "/api/block-height/" not in _ws_btc)
say("bitcoin: самоочистка как у BSC (откаты разобранных блоков, снимки адресов, пустые потоки, WAL) и /statsbtc с Lag, TX, узлами и разбором",
    "constexpr long long FINAL_DEPTH = 12;" in _ws_btc and "UPDATE btc_blocks SET flow = NULL WHERE flow IS NOT NULL" in _ws_btc
    and "NOT EXISTS (SELECT 1 FROM btc_moves m WHERE m.wallet = btc_addr.address)" in _ws_btc
    and "SQLITE_CHECKPOINT_TRUNCATE" in _ws_btc
    and '"\\n⏳ Lag: "' in _ws_btc and '"\\n🔍 TX: "' in _ws_btc and "🌐 <b>Узлы Bitcoin</b>" in _ws_btc
    and "📈 <b>Разбор транзакций</b>" in _ws_btc and "🧹 <b>Самоочистка</b>" in _ws_btc
    and "bump(sweep ? g_bs.sweep : toEx.empty() ? g_bs.plain : g_bs.toEx);" in _ws_btc)
_ws_etf = read(os.path.join(BOT, "btc_etf.cpp"))
_ws_etfbook = read(os.path.join(BOT, "btc_etf_book.h"))
say("bitcoin: метки ETF — кошельки, опубликованные фондом (BITB), и /import; кошелёк фонда не становится биржей и не идёт в базу китов поиском; мёртвого /api/etf/chain нет",
    _ws_etfbook.count('"BITB"},') >= 60 and "BTC_ETF_BOOK" in _ws_etf
    and "if (!etfFund(a).empty()) return;" in _ws_btc and "autoCand_.size() < AUTO_PEND_MAX && etfFund(a).empty()" in _ws_btc
    and "urlopen" not in read(os.path.join(BOT, "tools", "btc_etf_seeds.py")).split("def on_chain")[0]
    and "/api/etf/chain" not in api and "_btc_etf_build" not in api
    and "EtfChain" not in read(f"{APP}/src/screens/EtfScreen.tsx"))
_btv2 = read(f"{APP}/src/screens/BtcViews.tsx")
say("BTC: кошельки ETF подписаны тикером фонда — в рейтинге, крупных ордерах (потоки бирж) и на экране кошелька",
    "AND fund NOT LIKE '#%'" in btcpy and 'out[r["address"]]["etf"]' in btcpy
    and '{r.etf ? <span className="bt-etf">ETF · {r.etf}</span> : null}' in _btv2
    and '${r.etf ? `ETF ${r.etf} · ` : ""}' in _btv2 and 't(lang, "btc_is_etf", { f: data.etf })' in _btv2)
_ws_etf2 = read(os.path.join(BOT, "btc_etf.cpp"))
_etfs2 = read(f"{APP}/wt_etf.py")
# BTC — как до слежки за фондами по цепочке (15–18 октября): она шла в цикле
# блоков (догонка двух месяцев, остатки, хранилища хранителя, резервы бирж и
# государства по адресам) и останавливала его — крупные сделки и рейтинг
# вставали. Осталась разметка: список фонда (BITB) и /import — подпись тикером.
_btc_loop = _ws_btc[_ws_btc.index("void btcLoop() {"):_ws_btc.index("void startBtcLoop() {")]
say("BTC как до слежки за фондами: метки — только список фонда (BITB) и /import; цикл блоков за фондами, резервами и государствами в сеть не ходит; сверки нет",
    "if (etfDrainLabels(g_btcDb, etfNew) < 0) ++g_txErrs;" in _ws_btc and _ws_btc.count("etfFund(a).empty()") == 2
    and all(w not in _ws_btc for w in ("etfBackfill", "readNewVaults", "refreshEtfBalances", "govBlock", "exBalances",
                                         "refreshGovBalances", "etfLoop", "addrFresh", "etfBlock"))
    and "etfOpen(g_btcDb);" in _ws_btc and "DROP TABLE IF EXISTS btc_ex_bal" in _ws_btc
    and "DROP TABLE IF EXISTS btc_etf_moves" in _ws_etf2 and "UPDATE btc_etf_addr SET how='import' WHERE how='list'" in _ws_etf2
    and "VALUES(?,?,'import',?)" in _ws_etf2 and "etfBlock" not in _ws_etf2 and "checkLine" not in _ws_etf2
    and not os.path.exists(os.path.join(BOT, "btc_gov.cpp")) and not os.path.exists(os.path.join(BOT, "btc_block.h"))
    and not os.path.exists(f"{APP}/wt_etfchain.py") and "etfchain" not in api and "_btc_check" not in api
    and "_btc_custody_build" not in api and "def peek(" not in _etfs2 and "btc_etf" not in _etfs2
    and os.path.isfile(f"{APP}/tests/test_btc_etf_labels.py"))
_etfs2 = read(f"{APP}/wt_etf.py")
# Работа по фондам (догонка двух месяцев, сверка остатков, история /import,
# хранилища) — в своём потоке: в цикле блоков она шла часами и при отказе
# mempool.space повторялась каждый час — новые блоки стояли, отставание
# переваливало за сутки, блоки пропускались, и крупные сделки с рейтингом
# BTC вставали.
say("bitcoin: вкладка «Крупные ордера BTC» с потоком бирж (в NetFlow его нет), третья доска рейтинга, экран кошелька",
    'path in ("/btc/flow", "/api/btc/flow")' in api and "def _btc_clean(" in btcpy and "w.s < 0.9 * w.b" in btcpy
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
    "def _btc_big_build(win: str, side: str, min_btc: float, ex: str = \"\")" in btcpy
    and '"byEx": by_ex' in btcpy and 'qs.get("ex", [""])[0]' in api
    # Без деления «база / все»; биржи — фильтром списка. Метки — только у
    # кошельков ETF: импорт «Другое» (кто угодно) без звёздочки и пометок.
    and 'className="btc-exf"' in _btv and '"btc_scope_base"' not in _btv and "btcBase" not in _btv
    and "r.imp" not in _btv and "AS imp" not in api and '`ETF ${r.etf} · `' in _btv
    and '"Bybit"' in _ws_btc and '"OKX"' in _ws_btc)

say("bitcoin: перестройка цепочки откатывает блок, цена на час блока, выплаты биржи не путаются с CoinJoin, PnL только по биржевым движениям",
    "Back rolledBack(const Block& b)" in _ws_btc and "long long priceAt(long long ts)" in _ws_btc
    and "basic && (!exIn.empty() || !coinjoin(tx))" in _ws_btc and "AND price_nanos > 0 AND ex != ''" in _ws_btc
    and "UPDATE btc_labels SET at=? WHERE address=? AND how != 'seed'" in _ws_btc and "void reloadWatch()" in _ws_btc
    and "AND price_nanos > 0 AND m.ex != ''" in btcpy and 'r["price_nanos"] or 0) > 0 and r["ex"]' in btcpy)
say("bitcoin: запись блока — транзакцией, которая обязана закрыться (BEGIN IMMEDIATE, сброс незавершённых запросов, проверка COMMIT, откат при сбое и исключении); не записался — не засчитан и читается снова; простой догоняется до недели",
    "bool inTx(F&& f)" in _ws_btc and "BEGIN IMMEDIATE" in _ws_btc and "sqlite3_next_stmt(g_btcDb" in _ws_btc
    and "Result::FAILED" in _ws_btc and "constexpr long long MAX_BEHIND = 1008;" in _ws_btc
    and 'execSql("BEGIN")' not in _ws_btc and 'execSql("COMMIT")' not in _ws_btc
    and '"at": int(tip["ts"]) if tip else 0' in btcpy and os.path.isfile(f"{APP}/tests/test_btc_stale.py"))
say("bitcoin: адресный сервис не ответил — 10 минут без него; адресам блока — не больше минуты (догоняя сеть — 10 с), блоки не ждут mempool.space",
    "constexpr long long ADDR_HOST_REST_SEC = 600;" in _ws_btc and "bool addrUp()" in _ws_btc
    and "constexpr int ADDR_BUDGET_SEC = 60;" in _ws_btc and "constexpr int ADDR_BUDGET_BEHIND_SEC = 10;" in _ws_btc
    and _ws_btc.count("!addrUp() || std::chrono::steady_clock::now() >= until") == 2
    and "g_addrRest[i] = nowSec() + ADDR_HOST_REST_SEC;" in _ws_btc)
_ws_etf = read(os.path.join(BOT, "btc_etf.cpp"))
_btcv = read(f"{APP}/src/screens/BtcViews.tsx")
say("bitcoin, жёсткая ревизия: каждая запись блока проверяется (stepW, сбой — откат), разметка ETF не теряется, откат цепочки не падает на кривом JSON, цена старого блока — свеча Kraken, а не сегодняшняя",
    "int stepW(sqlite3_stmt* s)" in _ws_btc and "if (g_txErrs) {" in _ws_btc
    and "if (etfDrainLabels(g_btcDb, etfNew) < 0) ++g_txErrs;" in _ws_btc and "if (!q.s || !del.s || !unlab.s) return -1;" in _ws_etf
    and "x.is_number_integer(); }))" in _ws_btc and "api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60" in _ws_btc
    and "if (!(btc > 0 && btc <= 21e6)) btc = defBtc;" in _ws_btc
    and '} else if (!refreshLabels(db) || !exec(db, "COMMIT")) {' in _ws_etf
    and "CHECK(otherRc == SQLITE_BUSY);" in read(os.path.join(BOT, "tests/btc_tx_test.cpp")))
say("bitcoin, жёсткая ревизия: цена сервера по времени блока; фильтр биржи — только из разметки; экраны обновляются раз в минуту и не стирают показанное при сбое",
    'SELECT price_nanos, ts FROM btc_blocks WHERE price_nanos > 0' in btcpy and "if ex and ex not in _btc_ex_names():" in btcpy
    and _btcv.count("const stop = everyMinute(load);") == 4 and _btcv.count("cur?.ok ? cur : hit") == 3
    and "test_exchange_filter_takes_only_names_from_the_scanner_labels" in read(f"{APP}/tests/test_btc_stale.py"))
_ci = read(f"{APP}/.github/workflows/tests.yml")
say("bitcoin: сервер — отдельный модуль wt_btc.py (общие база, кэш и время — через setup); whale_api только подключает его; модуль в строгих проверках CI (mypy, ruff)",
    "import wt_btc  # noqa: E402" in api and "wt_btc.setup(open_db=open_db" in api and "def _btc_flow_build(" not in api
    and "def _btc_rank_build(" not in api and "def setup(*, open_db:" in btcpy and "def warm_jobs()" in btcpy
    and "jobs = [*wt_btc.warm_jobs(), (_BSCX" in api
    and "wt_btc.py" in _ci.split("mypy==")[1].split("\n")[0] and "py_compile whale_api.py" in _ci and " wt_btc.py" in _ci.split("py_compile")[1].split("\n")[0])
say("wt_btc, ревизия: цена Coinbase проверяется (не объект, NaN, вне разумного — 0) и спрашивается раз в минуту на весь модуль; средняя цена крупного ордера — только по движениям с ценой",
    "return cast(float, cached_small(_BTC, \"spot\", 60.0, _spot_fetch))" in btcpy
    and "math.isfinite(p) and 1000 < p < 10_000_000" in btcpy and "isinstance(j, dict)" in btcpy
    and "SUM(CASE WHEN m.price_nanos > 0 THEN m.sats ELSE 0 END) psats" in btcpy
    and '/ (int(r["psats"]) / 1e8), 2) if r["psats"] else 0' in btcpy
    and "test_big_order_price_counts_only_moves_that_have_a_price" in read(f"{APP}/tests/test_btc_stale.py")
    and "test_spot_price_answer_is_checked_and_asked_once_a_minute" in read(f"{APP}/tests/test_btc_stale.py"))
say("wt_btc: полные тесты (потоки, крупные ордера, транзит, чистка, рейтинг, итог кошелька, карточка, написание, параметры) и мутанты — все убиты",
    os.path.isfile(f"{APP}/tests/test_btc.py") and "BT = [" in read(f"{APP}/tools/mutate-etf.py")
    and '+ run(f"{ROOT}/wt_btc.py", [sys.executable, "-m", "unittest", "tests.test_btc"' in read(f"{APP}/tools/mutate-etf.py")
    and "len(DMT) + len(BT) - len(EQUIV)" in read(f"{APP}/tools/mutate-etf.py")
    and "wt_btc.py tests/test_btc.py tests/test_btc_stale.py tests/test_sum_overflow.py" in _ci)
_ws_etfh = read(os.path.join(BOT, "btc_etf.h"))
_ws_tx = read(os.path.join(BOT, "tests/btc_tx_test.cpp"))
say("метки ETF (btc_etf.cpp), жёсткая ревизия: обновление при запуске — BEGIN IMMEDIATE, каждый шаг проверен, сбой — откат; снятый фондом адрес — не метка; кошелёк фонда — не биржа; /import — тикер проверен, повтор адреса — один, сбой записи — откат и «не записалось»; очередь снимается по строкам; имя фонда в /statsbtc экранировано",
    'if (!exec(db, "BEGIN IMMEDIATE")) {' in _ws_etf and 'exec(db, "BEGIN");' not in _ws_etf
    and "bool refreshLabels(sqlite3* db)" in _ws_etf and "if (!BTC_ETF_BOOK.empty()) {" in _ws_etf
    and "DELETE FROM btc_labels WHERE how != 'seed' \"" in _ws_etf
    and 'Stmt unlab(db, "DELETE FROM btc_labels WHERE address=? AND how != \'seed\'");' in _ws_etf
    and 'Stmt del(db, "DELETE FROM btc_etf_import WHERE address=? AND fund=?");' in _ws_etf
    and 'exec(db, "DELETE FROM btc_etf_import")' not in _ws_etf
    and "if (!validFund(fund)) {" in _ws_etf and "if (a.empty() || !seen.insert(a).second) continue;" in _ws_etf
    and '"\\n· <b>" + esc(fund) + "</b>: "' in _ws_etf
    and "bool failed = false;" in _ws_etfh and "if (r.failed) ++g_txErrs;" in _ws_btc
    and "if (r.failed)\n        return " in read(os.path.join(BOT, "main.cpp"))
    and "CHECK(etfFund(\"bc1qstale\").empty());" in _ws_tx and "CHECK(st.find(\"&lt;i&gt;\")" in _ws_tx)
say("метки ETF, повторная ревизия: карта меток в памяти — только после COMMIT блока (откат блока не оставляет в памяти фонд, которого нет в базе); адрес, ждущий в очереди с тем же фондом, — «уже этого фонда»",
    "int etfDrainLabels(sqlite3* db, EtfLabels& applied);" in _ws_etfh and "void etfRemember(const EtfLabels& applied);" in _ws_etfh
    and "g_fund[a] = fund;" in _ws_etf.split("void etfRemember(")[1] and _ws_etf.count("g_fund[a] = fund;") == 1
    and "etfRemember(etfNew);" in _ws_btc and _ws_btc.index("etfRemember(etfNew);") > _ws_btc.index("return Result::FAILED;\n            }\n            // Метки фондов")
    and "if (pend.row() && pend.str(0) == fund) { ++r.dup; continue; }" in _ws_etf
    and "CHECK(etfFund(\"bc1qrb\").empty());" in _ws_tx and "CHECK(again.dup == 1 && again.queued == 0);" in _ws_tx)
say("крупные ордера BTC: все окна и стороны готовы заранее (прогрев), итоги и биржи — одним проходом, неделя и месяц — раз в 5 минут; второй запрос ждёт идущую сборку; приложение ждёт тяжёлый ответ 30 с и при сбое пишет «что-то пошло не так», а не «пока пусто»",
    "for w in BIG_WINDOWS for side in (\"buy\", \"sell\")]" in btcpy and "def btc_big_ttl(win: str) -> float:" in btcpy
    and "AND ((m.kind = 1 AND {keep[1]}) OR (m.kind = 2 AND {keep[2]})) " in btcpy and "where_all" not in btcpy
    and "_bg_done[bk] = threading.Event()" in api and "if done is not None and done.wait(BG_WAIT):" in api
    and "const EX_TIMEOUT = 30_000;" in read(f"{APP}/src/lib/api.ts")
    and "return cachedGet<T>(path, ttl, EX_TIMEOUT).then((r) => {" in read(f"{APP}/src/lib/api.ts")
    and _btcv.count("failed(data) ? (") == 3
    and "test_concurrent_cold_requests_share_one_build" in read(f"{APP}/tests/test_btc.py"))
say("доллары в нано — TOTAL, не SUM: месяц крупных ордеров BTC и потоков бирж BSC больше предела целого SQLite («integer overflow», 25 октября окно «30 дней» не открывалось)",
    "SUM(m.usd_nanos)" not in btcpy and "TOTAL(m.usd_nanos) usd_nanos" in btcpy and "TOTAL(m.usd_nanos) u FROM" in btcpy
    and "SUM(in_usd)" not in api and "SUM(out_usd" not in api and "SUM(CASE WHEN is_buy=1 THEN usd_nanos" not in api
    and "SUM(CASE WHEN t.is_buy" not in api and "TOTAL(in_usd) i, TOTAL(out_usd) o" in api
    and os.path.isfile(f"{APP}/tests/test_sum_overflow.py"))
say("wt_btc, повторная ревизия: рейтинг держит в памяти только лучшие BTC_ROWS каждой доски (не итоги всех кошельков за год); неудачная первая сборка живёт 30 с, а не весь срок кэша; пустой список бирж не кэшируется",
    "heapq.heapreplace(top, item)" in btcpy and "books: list[Json]" not in btcpy and '"n": n,' in btcpy
    and "store[key] = (time.monotonic() - max(0.0, ttl - 30.0), val)" in api
    and '_BTC.pop("ex_names", None)' in btcpy
    and "test_boards_keep_only_the_best_and_ties_keep_wallet_order" in read(f"{APP}/tests/test_btc.py")
    and "test_failed_first_build_is_retried_in_half_a_minute" in read(f"{APP}/tests/test_btc.py"))
say("wt_btc: карточка кошелька читает не больше WALLET_MOVES_MAX последних движений (адрес сервиса — десятки тысяч)",
    "WALLET_MOVES_MAX = 20_000" in btcpy and "ORDER BY ts DESC, id DESC LIMIT ?\", (addr, WALLET_MOVES_MAX))" in btcpy
    and "test_card_reads_only_the_latest_moves" in read(f"{APP}/tests/test_btc.py"))
say("альтсезон, ревизия: монета, пропавшая из списка Hyperliquid, остаётся со своими свечами (прошлое не пересчитывается по выжившим); доминация в приложении повторяет запрос сама, а не ждёт альтсезона или часа",
    "out: dict[str, dict[int, Candle]] = {c: d for c, d in old.items() if c not in coins}" in read(f"{APP}/wt_dom.py")
    and "test_coin_gone_from_the_list_keeps_its_past" in read(f"{APP}/tests/test_dom.py")
    and "else timer = window.setTimeout(() => setMcapRetry((n) => n + 1), FAIL_RETRY_MS);" in read(f"{APP}/src/screens/DominanceScreen.tsx")
    and "}, [retry, mcapRetry]);" in read(f"{APP}/src/screens/DominanceScreen.tsx"))
_dms = read(f"{APP}/src/screens/DominanceScreen.tsx")
say("альтсезон, повторная ревизия: монета −100 % не ломает полосы «монеты против биткоина» (vsBtc); открытый экран сам берёт ответ свежее часа",
    "export function vsBtc(p: number, btc: number): number {" in read(f"{APP}/src/lib/dom.ts")
    and "const rel = (p: number) => vsBtc(p, btc);" in _dms and "const id = window.setInterval(back, 5 * 60_000);" in _dms
    and "vsBtc: монета, упавшая почти до нуля" in read(f"{APP}/tests/dom.test.ts"))
say("bitcoin, повторная ревизия: алерты только о свежих блоках (догонка простоя не шлёт вчерашние сделки), время блока не из будущего, дробные числа узла без UB; дайджест без раздела биткоина, пока сканер стоит",
    "constexpr long long ALERT_MAX_AGE_SEC = 3600;" in _ws_btc and "nowSec() - alerts_.front().ts > ALERT_MAX_AGE_SEC" in _ws_btc
    and "b.ts > nowSec() + 7200" in _ws_btc and "return d > -9e18 && d < 9e18 ? static_cast<long long>(d) : 0;" in _ws_btc
    and "if not fl.get(\"at\") or now() - int(fl[\"at\"]) > DG_BTC_STALE:" in api
    and "test_digest_has_no_bitcoin_section_while_the_scanner_stands" in read(f"{APP}/tests/test_btc_stale.py"))

_dgm = read(f"{APP}/src/screens/DigestMore.tsx")
say("дайджест v2: сводка сигналов, рынок, институционалы, bitcoin, лидеры, халвинг; старые выпуски как были",
    "def _dg_signals(body: dict)" in api and 'body: dict = {"v": 3' in api and 'body["halv"] = {' in api
    and "export function Summary(" in _dgm and "export function Institutions(" in _dgm
    and "export function BitcoinSec(" in _dgm and "export function HalvingLine(" in _dgm
    and "const v2 = (it.v ?? 1) >= 2;" in read(f"{APP}/src/screens/DigestTab.tsx"))

_ui_left = [f for f in ("wallet_menu.cpp", "big_trades.cpp", "hyperliquid_ui.cpp", "alert_settings.cpp")
            if os.path.exists(os.path.join(BOT, f))]
# Кнопки под заявками с бирж (ExchClaim … exchPending) и под /import
# («чьи адреса») — только владельцу.
_bot_src = "".join(read(os.path.join(BOT, f)) for f in os.listdir(BOT)
                   if f.endswith(".cpp") and f not in ("ru.cpp", "translations.cpp"))
_owner_kb = (_bot_src[_bot_src.find("struct ExchClaim {"):_bot_src.find("void exchPending(")],
             _bot_src[_bot_src.find("// ── /import: разметка адресов владельцем"):_bot_src.find("bool handleOwnerCommand(")])
_bot_rest = _bot_src
for _part in _owner_kb:
    _bot_rest = _bot_rest.replace(_part, "") if _part else _bot_rest
say("бот: меню в чате нет — на любое сообщение кнопка приложения; алерты, оплата и команды владельца на месте",
    not _ui_left and all(_owner_kb) and "callback_data" not in _bot_rest and "void sendOpenApp(const std::string& chatId)" in _mc
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
say("бонусы: приглашение и дни за соцсети (канал и сообщество Telegram по +3 — getChatMember, остальные +1 — нажал, через 5 мин начислено и сообщение), один раз",
    "export function BonusScreen(" in _bns and "<InviteCard />" in _bns and "socials.map" in _bns
    and '"bn_left"' in _bns
    and "<InviteCard" not in read(f"{APP}/src/screens/MoreTab.tsx") and 'open("bonus")' in read(f"{APP}/src/screens/MoreTab.tsx")
    and 'SOCIAL_BONUS = {"tg": 3, "tgc": 3, "x": 1, "tiktok": 1, "instagram": 1, "youtube": 1}' in api
    and '"@wallettrackercommunity"' in api and "tg_member(TG_CHATS[kind], chat)" in api
    and "b.kind NOT IN ('tg', 'tgc')" in api and "isTgChat(s.id)" in _bns
    and "def bonus_act(" in api and '"getChatMember"' in api and "BONUS_WAIT_SEC = 10" in api
    and "BONUS_DELAY_SEC = 5 * 60" in api and "threading.Thread(target=_bonus_loop, daemon=True).start()" in api
    and '"bn_checking"' in _bns
    and "const BONUS_WAIT = 10;" in _bns and "DELETE FROM bonus_claims WHERE chat_id=?" in api
    and "SOCIALS.filter((so) => !so.bonusOnly).map" in read(f"{APP}/src/App.tsx") and 'n["bonus"]' in _mcpp)

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
    and '"bn_ex_new_only"' in read(f"{APP}/src/screens/BonusScreen.tsx") and "bn_ex_rebind" not in read(f"{APP}/tools/i18n.json") and '"bn_ex_okx"' in read(f"{APP}/src/screens/BonusScreen.tsx")
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
    and '"visibilitychange"' in read(f"{APP}/src/lib/sync.ts") and 'open("premium", "hdr")' in read(f"{APP}/src/components/PremBadge.tsx")
    and 'open("lock")' in read(f"{APP}/src/components/PremBadge.tsx") and "lock: LockPage," in read(f"{APP}/src/screens/registry.ts"))

say("накрутки по IP: проба — не больше 3 новых аккаунтов с IP за сутки, награда за друга — нет при общем IP, адрес хранится только отпечатком 90 дней",
    "TRIAL_PER_IP_DAY = 3" in api and "IP_KEEP_SEC = 90 * 86400" in api and "hmac.new(_IP_KEY" in api
    and "grant_trial(chat, who.get(\"lang\", \"\"), peer)" in api and "ip_note(chat, peer)" in api
    and "if ref_suspicious(con, inviter, invitee):" in pybody(api, "def ref_settle(")
    and "SUM(CASE WHEN rewarded>0 THEN rewarded ELSE 0 END)" in api and "DELETE FROM ip_seen WHERE chat_id=?" in api
    and "src='trial_ip'" in _mcpp
    and all("IP" in v for v in json.load(open(f"{APP}/tools/i18n.json"))["legal_privacy_body"].values()))

_hlc = read(f"{BOT}/hyperliquid_core.cpp")
_hl_auto = _hlc[_hlc.find("Автопополнение базы сервисного аккаунта"):_hlc.find("void handleTrades(")]
say("автопополнение базы китов: BSC и Hyperliquid от $10k, Bitcoin от 1 BTC, по 500 в сутки на сеть, /autobase включает и выключает каждую сеть; Hyperliquid ищет без бюджета запросов; BSC и Hyperliquid: 30 дней без сделок — сон в этой сети, не удаление (и импорт); Bitcoin: найденные без движений и меньше 1 BTC — убираем без бана, боты и BTC-сервисы — бан навсегда",
    "bscAutoConsider(tx, to, watchers.get(), bscActive.get());" in _mcpp and "BSC_HOT_NONCE = 300000" in _mcpp
    and "autoMinUsd(AutoNet::BSC)" in _mcpp and '"eth_getCode"' in _mcpp and "BSC_AUTO_MAX_NONCE = 1000" in _mcpp
    and 'addUserWhale(SERVICE_CHAT_ID, a, "auto-bsc")' in _mcpp and "std::thread(bscAutoLoop).detach();" in _mcpp
    and "pruneAutoWallets();" in _mcpp and "Автобаза за сутки" in _mcpp
    and "if (big) autoCandidate(addr);" in _hlc and "if (!g_lbGood.count(addr)) return;" in _hlc
    and "stats-data.hyperliquid.xyz/Mainnet/leaderboard" in _hlc and "HL_LB_MAX_TURNOVER = 30.0" in _hlc
    and "g_autoThread = std::thread(autoLoop);" in _hlc and "autoCounted(AutoNet::HL);" in _hlc
    and "infoPost" not in _hl_auto and "userRateLimit" not in _hl_auto
    and "autoRoom(AutoNet::BSC)" in _mcpp and "autoRoom(AutoNet::HL)" in _hlc
    and "autoRoom(AutoNet::BTC)" in read(f"{BOT}/btc_chain.cpp") and 'envSats("WHALE_BTC_AUTO_MIN", 0.2)' in read(f"{BOT}/btc_chain.cpp")
    and 'envUsd("WHALE_BSC_AUTO_MIN", 10000.0), envUsd("WHALE_HL_AUTO_MIN", 10000.0)' in read(f"{BOT}/autobase.cpp")
    and 'envInt("WHALE_BSC_AUTO_DAILY", 500), envInt("WHALE_HL_AUTO_DAILY", 500)' in read(f"{BOT}/autobase.cpp")
    and "static const double v[NETS]" in read(f"{BOT}/autobase.cpp") and "autoLimit(AutoNet::HL) / 2" in _hlc
    and "SELECT 1 FROM hl_fills WHERE wallet=? AND ts>=?" in _mcpp and "retryLater(a)" in _mcpp
    and "HL_LB_RETRY_SEC = 600" in _hlc and "std::string hlAutoStatus()" in _hlc and "hlAutoStatus()" in read(f"{BOT}/autobase.cpp")
    and 'txt.rfind("/autobase ", 0) == 0' in _mcpp
    and "t.timestamp >= ?2" in _mcpp and "uid != SERVICE_CHAT_ID" in _mcpp and "CREATE TABLE IF NOT EXISTS auto_woke" in _mcpp
    and "label='auto-bsc' AND uw.created_at>0" not in _mcpp and "if (stored > 0 && !awake) autoWoke(AutoNet::HL, wallet);" in _hlc
    and "else if (!wokeBy.empty()) mA=wokeBy;" in _mcpp and "autoWoke(AutoNet::BSC, rcpt);" in _mcpp
    and "крупный вывод" in read(f"{BOT}/autobase.cpp")
    and "btcPruneAuto(cut)" in _mcpp and "int btcPruneAuto(long long cut)" in read(f"{BOT}/btc_chain.cpp")
    and "void autoPruned(AutoNet n, int count)" in read(f"{BOT}/autobase.cpp") and "<b>Найдено поиском</b>" in read(f"{BOT}/autobase.cpp") and 'row(" в базе", base[0], base[1], base[2])' in read(f"{BOT}/autobase.cpp")
    and "ServiceBaseStats serviceBaseStats()" in _mcpp and "serviceBaseStats();" in read(f"{BOT}/autobase.cpp")
    and "else if (watchers->count(from)) { mA=from; cold=true; }" in _mcpp and "hasHlFill" not in _mcpp
    and "                hlActive->insert(addr);" in _mcpp and "lastFull >= std::chrono::hours(1)" in _mcpp
    and 'row("Спят", num(sb.bscSleep), num(sb.hlSleep), "—")' in read(f"{BOT}/autobase.cpp") and "Спят на обеих сетях" in read(f"{BOT}/autobase.cpp") and 'row("Проснулись", "", "", "")' in read(f"{BOT}/autobase.cpp")
    and "if (matched[i].cold && res.isSwap) autoWoke(AutoNet::BSC, mA);" in _mcpp
    and "autoWoke(AutoNet::HL, wallet);" in _hlc and "void autoWoke(AutoNet n, const std::string& addr)" in read(f"{BOT}/autobase.cpp")
    and "CREATE TABLE IF NOT EXISTS auto_woke" in read(f"{BOT}/autobase.cpp")
    and "Итого кошельков" in read(f"{BOT}/autobase.cpp") and "num(sb.evm + sb.btc)" in read(f"{BOT}/autobase.cpp")
    and "size_t chars(const std::string& s)" in read(f"{BOT}/autobase.cpp")
    and "Вся база сервисного аккаунта" in read(f"{BOT}/autobase.cpp") and "long long btcWatchCount(bool autoOnly)" in read(f"{BOT}/btc_chain.cpp")
    and "void autoBanned(AutoNet n, int count)" in read(f"{BOT}/autobase.cpp") and "long long btcAutoCount()" in read(f"{BOT}/btc_chain.cpp")
    and 'if (label == "auto-bsc") autoBanned(AutoNet::BSC);' in read(f"{BOT}/wallets.cpp")
    and 'else if (label == "auto-hl") autoBanned(AutoNet::HL);' in read(f"{BOT}/wallets.cpp")
    and "AND a.bal_sats < ? " in read(f"{BOT}/btc_chain.cpp") and "int btcBanServices()" in read(f"{BOT}/btc_chain.cpp")
    and "void refreshIdleBalances()" in read(f"{BOT}/btc_chain.cpp") and "refreshIdleBalances();" in read(f"{BOT}/btc_chain.cpp")
    and _mcpp.find("autoBanned(AutoNet::BTC, btcBanServices());") != -1
    and _mcpp.find("autoBanned(AutoNet::BTC, btcBanServices());") < _mcpp.find("const int btc = btcPruneAuto(cut);")
    and "autoPruned(AutoNet::BTC, btc)" in _mcpp and "autoPruned(AutoNet::BSC" not in _mcpp and "autoPruned(AutoNet::HL" not in _mcpp
    and "ignored_wallets" not in _mcpp[_mcpp.find("void pruneAutoWallets()"):_mcpp.find("bool processBlock(")])

_bex = read(f"{BOT}/bsc_exchanges.cpp")
say("биржи BSC: отдельный модуль (своя база bsc_ex.db, свой поток), проверенные адреса бирж, обучение адресов пополнения — без алертов и без связи с DEX",
    "const Seed SEEDS[] = {" in _bex and "lt && lt->seed && !lf && !watched(from)" in _bex
    and "resolvePendingLocked(from, exTo, late);" in _bex and "bsc_ex_moves" in _bex and "bsc_ex_flow" in _bex
    and "bscExEnqueue(bn, blockTs, std::move(exTxs)," in _mcpp and "bscExObserve" not in _mcpp
    # Живёт отдельно от DEX: своя база, свой поток, своя очередь; при выходе гасится.
    and 'return (p && *p) ? std::string(p) : std::string("bsc_ex.db");' in _bex and "extern sqlite3* db;" not in _bex
    and "g_worker = std::thread(workerLoop);" in _bex and "if (b.block <= g_lastBlock) return;" in _bex
    # Ревизия: спам-токены не заводы, вывод — только с проверенного кошелька,
    # обучение — не с живых кошельков, память и диск под крышкой, шаг 10 минут.
    and "if (listedLocked(token)) addFlow(t, exTo, token, true, usd, qty);" in _bex
    and "if (lf && lf->seed) addFlow(t, exFrom, token, false, usd, qty);" in _bex
    and "hexLD(tx.nonce, 2, 64) < LEARN_MAX_NONCE" in _bex and "constexpr size_t LEARNED_MAX = 300000;" in _bex
    and "constexpr long long BUCKET = 600;" in _bex and "sqlite3_bind_int64(s, 1, t - FLOW_KEEP);" in _bex
    and "for (const auto& b : rest) handleBlock(b);" in _bex and "idx_bsc_ex_labels_at" in _bex
    and "since = (t - sec) // 600 * 600" in pybody(api, "def _bscx_flow_build(")
    and "bscExStop();" in _mcpp and 'BSCX_DB = _db_path("WHALE_BSCEX_DB", "bsc_ex.db")' in api
    and "cur = open_db(BSCX_DB)" in pybody(api, "def _bscx_flow_build(")
    and "s.bscxWin" in read(f"{APP}/src/screens/BscExViews.tsx") and "flowWin" not in read(f"{APP}/src/screens/BscExViews.tsx")
    and "initBscExchanges();" in _mcpp and "bscExCleanup();" in _mcpp
    and 'txt.rfind("/exlabel ", 0) == 0' in _mcpp and 'txt == "/exunknown"' in _mcpp
    and "CEX Deposit" not in _mcpp and "alert_cex" not in read(f"{APP}/src/components/AlertCard.tsx")
    and "if (isBaseAsset(res.tokenAddr) && !res.isSwap) { markTxProcessed(hash,bn); continue; }" in _mcpp
    and "bsc_ex" not in pybody(api, "def flow_scan(")
    and "if (chainCtx().stablecoins.count(a)) {" in read(f"{BOT}/token_prices.cpp")
    # Заводы и выводы конкретных кошельков на BSC не показываем.
    and "bsc_cex_moves" not in api and "cex" not in read(f"{APP}/src/screens/WalletScreen.tsx"))

say("аналитика: NetFlow DEX, ордера DEX, ротация DEX, Long/Short, позиции, BTC · потоки бирж, BSC · потоки бирж (NetFlow по монетам, без алертов); рейтинг «BSC DEX»",
    'label: () => "NetFlow DEX"' in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and 'label: (tr) => `${tr("ui_tab_orders")} DEX`' in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and 'label: (tr) => `${tr("ui_rotation")} DEX`' in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and 'label: (tr) => `BTC · ${tr("ex_flows")}`' in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and 'label: (tr) => `BSC · ${tr("ex_flows")}`' in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and "<BscExBody />" in read(f"{APP}/src/screens/AnalyticsTab.tsx") and "flowSrc" not in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and "<FlowSpark values={c.sp} />" in read(f"{APP}/src/screens/BscExViews.tsx")
    and '"icon"] = coin_icon(c["sym"], c["token"])' in pybody(api, "def _bscx_flow_build(")
    and "<CoinIcon sym={c.sym} icon={c.icon} size={32} />" in read(f"{APP}/src/screens/BscExViews.tsx")
    and '"sp": []' in pybody(api, "def _bscx_flow_build(")
    and 'path in ("/bsc/exflow", "/api/bsc/exflow")' in api and '"bsc/exflow"' in api.split("PAID_PATHS = frozenset(")[1][:900]
    and "FROM bsc_ex_flow WHERE ts >= ?" in pybody(api, "def _bscx_flow_build(")
    and "bsc_ex" not in pybody(api, "def flow_scan(")
    and '`${venueName("spot")} DEX`' in read(f"{APP}/src/screens/TopTab.tsx")
    and 'label: `BTC · ${t(lang, "ex_flows")}`' in read(f"{APP}/src/screens/TopTab.tsx")
    and json.load(open(f"{APP}/tools/i18n.json"))["btc_flow_title"]["ru"] == "Потоки бирж Bitcoin"
    and json.load(open(f"{APP}/tools/i18n.json"))["bscx_title"]["ru"] == "NetFlow · Потоки бирж BSC"
    and "g_pricer = std::thread(pricerLoop);" in _bex and "void bscExStop()" in _bex)

# Логотипы токенов BSC: по одному тикеру их не найти, нужен адрес контракта.
# Последний шаг — сервер (/bsclogo/ → bsc_logo): он считает контрольную сумму
# адреса и добирает картинку из GeckoTerminal.
_ng = read(f"{APP}/nginx.conf")
say("логотипы BSC: поиск по адресу на сервере, ротация, дайджест, алерты и экран монеты передают адрес",
    'out.append(f"/bsclogo/{a}")' in pybody(api, "def coin_icon(")
    and 'path.startswith("/api/logo/bsc/")' in api and "def bsc_logo(" in api
    and 're.fullmatch(r"0x[0-9a-f]{40}", a)' in pybody(api, "def bsc_logo(")
    and "location /bsclogo/ {" in _ng and "proxy_pass http://whale_api/api/logo/bsc/;" in _ng
    and '"/api/logo/bsc/"' not in api.split("PAID_PATHS = frozenset(")[1][:900]
    and '"token": a, "icon": coin_icon(s, a)' in pybody(api, "def rot_page(")
    and "addr={x.token}" in read(f"{APP}/src/screens/AnalyticsTab.tsx")
    and read(f"{APP}/src/screens/DigestTab.tsx").count("addr={r.token}") == 2
    and 'addr={d.k === "bsc" ? d.ca : undefined}' in read(f"{APP}/src/components/AlertCard.tsx")
    and "addr={arg2 && hasAddr ? addr : undefined}" in read(f"{APP}/src/screens/CoinScreen.tsx")
    and "urls.push(`/bsclogo/${addr.toLowerCase()}`)" in read(f"{APP}/src/components/CoinIcon.tsx"))

# Потоки бирж BTC и BSC и рейтинг BTC: сервер собирает их сам по кругу и
# отдаёт готовое (устаревшее — сразу, новое — в фоне), приложение показывает
# последний ответ из памяти или с устройства и тихо подменяет свежим.
_apits = read(f"{APP}/src/lib/api.ts")
say("потоки бирж и рейтинг BTC кэшируются: сервер в фоне, приложение — память и устройство",
    'cached_bg(_BTC, "flow", BTC_TTL, _btc_flow_build)' in btcpy
    and 'cached_bg(_BSCX, "flow", BTC_TTL, _bscx_flow_build)' in api
    and 'cached_bg(_BTC, ("rank", days), btc_rank_ttl(days)' in btcpy
    and 'cached_bg(_BTC, ("big", win, side, min_btc, ex)' in btcpy
    and 'threading.Thread(target=exflow_warmer, daemon=True, name="exflow").start()' in api
    and 'bad = isinstance(val, dict) and val.get("ok") is False' in pybody(api, "def cached_bg(")
    and 'export const fetchBtcRank = (win: string) => exGet<BtcRankReply>' in _apits
    and 'export const peekBtcRank = (win: string) => exPeek<BtcRankReply>' in _apits
    and 'export const fetchBscExFlow = () => exGet<BscExFlowReply>' in _apits
    and 'export const peekBscExFlow = () => exPeek<BscExFlowReply>' in _apits
    and 'export const fetchBtcFlow = () => exGet<BtcFlowReply>' in _apits
    and 'export const fetchBtcBig = (win: string, side: string, min: number, ex = "") =>\n  exGet<BtcBigReply>' in _apits
    and "export function peekAny<T>(key: string)" in read(f"{APP}/src/lib/memo.ts")
    and "setData((prev) => (r?.ok ? r : prev ?? null))" in read(f"{APP}/src/screens/BscExViews.tsx")
    and read(f"{APP}/src/screens/BtcViews.tsx").count("r?.ok ? r : cur?.ok ? cur : hit ?? r ??") == 3
    and "jobs.push(() => fetchBscExFlow());" in read(f"{APP}/src/lib/prefetch.ts"))

# Bitcoin — от 0,2 BTC: сканер пишет движения и находит кошельки от 0,2,
# держит в базе молчащих с остатком от 0,2; доска крупных движений — от 0,2.
_ws_btc2 = read(f"{BOT}/btc_chain.cpp")
say("bitcoin от 0,2 BTC: движения, автопоиск, держатели, доска крупных движений",
    'envSats("WHALE_BTC_MOVE_MIN", 0.2)' in _ws_btc2 and 'envSats("WHALE_BTC_AUTO_MIN", 0.2)' in _ws_btc2
    and "BTC_BIG_MIN = (0.2, 1, 10, 100)" in btcpy
    and "except (TypeError, ValueError, OverflowError):\n                    mn = 0.2" in api
    and "const MINS: BtcMin[] = [0.2, 1, 10, 100];" in read(f"{APP}/src/screens/BtcViews.tsx")
    and "<Segmented<string>\n        tight" in read(f"{APP}/src/screens/BtcViews.tsx")
    and "btcMin: 0.2," in read(f"{APP}/src/store/app.ts")
    and "if (from < 8 && s.btcMin === 1) s.btcMin = 0.2;" in read(f"{APP}/src/store/app.ts")
    and "меньше 1 BTC" not in read(f"{BOT}/autobase.cpp") + read(f"{BOT}/main.cpp")
    # Кандидаты автопоиска не теряются между блоками и проверяются первыми.
    and "std::unordered_map<std::string, long long> autoCand_;" in _ws_btc2
    and "autoCand_.clear();" not in _ws_btc2
    and "ask.insert(ask.begin(), askAuto.begin(), askAuto.end());" in _ws_btc2
    and "if (sqlite3_step(q) != SQLITE_ROW) { ++it; continue; }" in _ws_btc2)

# Многоточием ничего не режем: строки с цифрами переносятся (Strategy:
# «+1,7 тыс. BTC», «$75 442 +11%» пропадали за «…»).
_css = read(f"{APP}/src/styles/app.css")
_unclip = _css.split("/* Ничего не прячем за многоточием.")[-1] if "/* Ничего не прячем за многоточием." in _css else ""
say("многоточие нигде не прячет данные: подписи строк переносятся",
    all(sel in _unclip for sel in (".row-sub", ".row-name", ".tile b", ".dg-cell b", ".alc-sym", ".unl-id small", ".hdr-txt"))
    and "text-overflow: clip;" in _unclip and "white-space: normal;" in _unclip
    and ".ef-f-id small, .ef-hr-id b, .ef-hr-id small {\n  white-space: normal;" in read(f"{APP}/src/screens/EtfScreen.css"))

# «Институциональные потоки» — на уровне карточки халвинга: свой модуль,
# проверка ответа до клетки, тесты всех видов, строгие типы, мутации.
_etl = read(f"{APP}/src/lib/etf.ts")
_etcss = read(f"{APP}/src/screens/EtfScreen.css")
_wf = read(f"{APP}/.github/workflows/tests.yml")
say("«Институциональные потоки» — отдельный модуль: тип, проверка ответа и расчёты в lib/etf.ts (без импортов), стили — в своём файле, в общих — только подключение",
    "export function validEtf(raw: unknown, now: number = Date.now() / 1000): EtfReply | null" in _etl
    and not re.search(r"^\s*import\b", _etl, re.M) and "EtfReply" not in read(f"{APP}/src/lib/types.ts")
    and 'import "./EtfScreen.css";' in _ef and ".ef-" not in read(f"{APP}/src/styles/app.css")
    and "const v = validEtf(r);" in read(f"{APP}/src/lib/api.ts") and "validEtf(hit.v)" in read(f"{APP}/src/lib/api.ts")
    and "export const ETF_TTL_MS = 60 * 60_000;" in _etl and "TTL = 3600.0" in _etfs
    and "from whale_api" not in _etfs and "wt_etfchain" not in _etfs)
_efm = read(f"{APP}/src/screens/EtfMore.tsx")
say("«Институциональные потоки»: сбой сборки не повторяется каждым запросом (пауза FAIL_WAIT, «нет данных» — каждый раз новый ответ); карточка фонда по нажатию (потоки по дням, итог, запас, рекорды); предупреждение о старом наборе; свежий ответ при возврате через час; карточки не слипаются; даты не рвутся; ось CME без «BTC»",
    "FAIL_WAIT = 120.0" in _etfs and "def _resting() -> bool:" in _etfs and "and not _resting():" in _etfs
    and "else _no_data() if resting else build()" in _etfs and '"ok": False, "error": "no_data"}' in _etfs.split("def _no_data()")[1][:200]
    and "export function fundDetail(c: EtfCoin, i: number, n = 60): FundDetail" in _etl and "export function staleDays(" in _etl
    and 'aria-expanded={on} aria-controls={`ef-fd-${f.t}`}' in _ef and "<FundCard c={c} i={c.funds.indexOf(f)} lang={lang} />" in _ef
    and 'old > STALE_DAYS ?' in _ef and 'document.addEventListener("visibilitychange", back)' in _ef
    and "Date.now() - got.current > ETF_TTL_MS" in _ef
    and ".ef { max-width: 760px; margin-inline: auto; display: grid; gap: 12px;" in _etcss
    and "export function dateNb(" in read(f"{APP}/src/screens/etfView.ts") and "dateNb(lang, r[5]" in _efm
    and "axis={axis}" in _efm and "const lim = list.length - shown <= TAIL ? list.length : shown;" in _efm
    and all(k in _i18n for k in ("ef_fd_days", "ef_fd_chart", "ef_fd_hold", "ef_fd_tap", "ef_old")))
_cjk = r"[\u3040-\u30ff\u3400-\u9fff]"
_efk = [k for k in _i18n if k.startswith(("ef_", "dg_etf", "dg_l_etf"))]
_badcjk = [f"{k}/{lg}" for k in _efk for lg in ("zh", "ja")
           if re.search(_cjk + r"[:,;()]|[,;()]" + _cjk, _i18n[k][lg]) or re.search(r"ETF,", _i18n[k][lg])]
say("«Институциональные потоки» — тексты: «спрос против добычи» долей, а не «в N раза»; GBTC — только «с запуска»; источник — «потоки и активы»; в китайском и японском — полноширинная пунктуация",
    all("{x}" in _i18n["ef_mine_more"][lg] and "раза" not in _i18n["ef_mine_more"][lg] and "разів" not in _i18n["ef_mine_more"][lg]
        for lg in _i18n["ef_mine_more"])
    and 'ef_mine_more", { x: iso(pct((stats.c30 / stats.mined) * 100, 0, false)) })' in _ef
    and 'period === "all" ? ` ${t(lang, "ef_gbtc")}` : ""' in _ef and all("GBTC" not in v for v in _i18n["ef_funds_note"].values())
    and _i18n["ef_by"]["ru"] == "Потоки и активы фондов, цена дня:" and "2028" in _i18n["ef_how_3"]["ru"]
    and not _badcjk, ", ".join(_badcjk[:5]))
say("«Институциональные потоки» — понятно новичку: «?» у спроса против добычи (что такое добыча), у CME — лонг, шорт и открытый интерес; ETF — в словаре терминов помощи",
    '<SectionTitle help={["ef_how_3"]}>{t(lang, "ef_mine_title")}</SectionTitle>' in _ef
    and '<SectionTitle help={["ef_how_6", "q_ls_1", "oih_how_1"]}>{t(lang, "ef_cme_title")}</SectionTitle>' in _efm
    and '{ title: "ETF", body: ["ef_how_1", "ef_how_3"] },' in read(f"{APP}/src/screens/HelpScreen.tsx"))
say("«Институциональные потоки»: сервер проверяет каждую строку набора (даты ASCII и в торгах, пределы потоков и цен, праздники), итог дня — сумма фондов",
    'DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")' in _etfs and "(not by and total == 0)" in _etfs
    and "abs(total) > DAY_MAX" in _etfs and 'if PX_MIN <= _num(r.get("btcCloseUsd")) <= PX_MAX:' in _etfs and "HOLD_MAX = 5_000_000.0" in _etfs
    and "total = sum(by.values()) if by else" in _etfs)
say("«Институциональные потоки»: тесты как у халвинга — модуль, свойства, сервер, fuzz с договором «сервер ↔ приложение», безопасность, правила кода, браузер (16 языков, 320–1280 px, арабский, крупный шрифт, контраст), мутации, строгий TS — в CI",
    all(os.path.isfile(f"{APP}/tests/{f}") for f in ("etf.test.ts", "etf.props.test.ts", "e2e/etf.e2e.test.ts", "test_etf_api.py",
        "test_etf_fuzz.py", "test_etf_security.py", "test_etf_policy.py", "fixtures/etf.json"))
    and os.path.isfile(f"{APP}/tools/mutate-etf.py") and "python tools/mutate-etf.py" in _wf
    and "npm run typecheck:etf" in _wf and '"typecheck:etf": "node tools/typecheck-etf.mjs"' in read(f"{APP}/package.json")
    and "test_etf_fuzz.py tests/test_etf_security.py tests/test_etf_policy.py" in _wf
    and "тесты красные и без мутаций" in read(f"{APP}/tools/mutate-etf.py"))
say("«Институциональные потоки»: активы фондов по дням (TFTC) — запас в BTC по дням, заголовок по свежей сводке, сверка своей оценки; CME и премия Coinbase — с правдоподобием; SEC — дата ASCII, копия на диске проверяется",
    'if TNA_MIN <= _num(r.get("totalNetAssetsUsd")) <= TNA_MAX:' in _etfs and "if own > 0 and abs(own / held - 1) > SPLIT_MAX:" in _etfs
    and "export function heldSeries(" in _etl and "export function assets(" in _etl and "function validTna(" in _etl
    and "export function HeldSection(" in _em and "<HeldSection series={held}" in _ef and "const held = useMemo(() => (c ? heldSeries(c) : []), [c]);" in _ef
    and "any(not 0 <= v <= CME_MAX for v in vals)" in _etfs
    and "COINS" not in _etfs and 'QUARTER = re.compile(r"[0-9]{4}-(?:03-31|06-30|09-30|12-31)")' in read(f"{APP}/wt_treasury.py")
    and "_point(v)" in read(f"{APP}/wt_treasury.py") and os.path.isfile(f"{APP}/tests/test_treasury_security.py")
    and "tests/test_treasury_security.py" in _wf and 'from "./etfView"' in _ef and 'from "./etfView"' in _em
    and "function money(" not in _ef + _em and "def btc_custody()" not in api)
say("«Институциональные потоки»: медленный SEC не держит потоки (ждём SEC_WAIT, дальше — прошлые отчёты, зависшую часть не ждём, SEC не спрашивают вдвоём); мусор от SEC и из копий — мимо, а не сбой; порядок фондов и держателей не зависит от ответа",
    "SEC_WAIT = 45.0" in _etfs and "or wt_treasury.funds_cached()" in _etfs
    and "pool.shutdown(wait=False, cancel_futures=True)" in _etfs and "def _company(r: object) -> bool:" in _etfs
    and "[0.0])[0]), k)" in _etfs and "(-_num(r[4]), r[3])" in _etfs and "import urllib.error" not in _etfs
    and "def funds_cached()" in read(f"{APP}/wt_treasury.py") and "_fund_busy.acquire(blocking=False)" in read(f"{APP}/wt_treasury.py")
    and "def _company_row(r: object)" in read(f"{APP}/wt_treasury.py") and "if not answered:" in read(f"{APP}/wt_treasury.py")
    and "export const tone = " in read(f"{APP}/src/screens/etfView.ts"))
# CC BY 4.0: подпись TFTC со ссылкой и лицензией — везде, где видны его цифры
# (экран, дайджест в приложении, картинки альбома и подпись к посту в канале,
# открытый ответ /api/etf); условия сервиса не ограничивают права на эти данные;
# у образца в открытом репозитории — файл с источниками; цен бирж в образце нет.
_dgi = read(f"{APP}/wt_digest_img.py")
_dgm3 = read(f"{APP}/src/screens/DigestMore.tsx")
_fx = read(f"{APP}/tests/fixtures/etf.json")
say("«Институциональные потоки»: подпись TFTC (CC BY 4.0) везде, где видны его цифры — экран, дайджест, картинки и пост канала, ответ API; условия не ограничивают права на данные; у образца — источники",
    '"by": TFTC_BY' in _etfs and 'TFTC_BY = "TFTC — tftc.io/bitcoin-etf-flows (CC BY 4.0' in _etfs
    and 'TFTC_BY = "TFTC — tftc.io/bitcoin-etf-flows (CC BY 4.0)"' in _dgi
    and """p.note(f"{tr(lang, 'dg_etf_by')} {TFTC_BY}")""" in _dgi
    and """parts.append(f"{tr(lang, 'dg_etf_by')} {TFTC_BY_POST}")""" in _dgi
    and 'TFTC_BY_POST = "TFTC — https://www.tftc.io/bitcoin-etf-flows (CC BY 4.0: https://creativecommons.org/licenses/by/4.0/)"' in _dgi and '"etf": " · TFTC"' in _dgi
    and "openExternal(TFTC_URL)" in _dgm3 and "openExternal(CCBY_URL)" in _dgm3
    and 's.k === "etf" ? <small> · TFTC</small>' in _dgm3
    and '{t(lang, "legal_terms_data")}' in read(f"{APP}/src/screens/LegalScreen.tsx")
    and os.path.isfile(f"{APP}/tests/fixtures/NOTICE.md") and "CC BY 4.0" in read(f"{APP}/tests/fixtures/NOTICE.md")
    and '"cbp"' not in _fx and '"by":"TFTC' in _fx and os.path.isfile(f"{APP}/tests/test_digest_sources.py"))
_etv = read(f"{APP}/src/screens/etfView.ts")
say("«Институциональные потоки»: графики в настоящих пикселях ширины (подписи одного размера на любом экране, по высоте — в окно), колонка ≤ 760 px; подгрузка при запуске; сохранённая копия — с пометкой «не удалось обновить»",
    "export function useWidth(ref: RefObject<Element | null>, fallback = 330): number" in _etv and "new ResizeObserver(" in _etv
    and "export function heightK(w: number, base: number): number" in _etv
    and "const { W, PW, P1, P2, H } = geom(useWidth(ref));" in _ef and "const { W, PW, MH } = box(useWidth(ref), 130);" in _em
    and "const W = 360;" not in _ef + _em
    and ".ef { max-width: 760px; margin-inline: auto;" in _etcss and ".ef-svg .fg-tick { font-size: 10.5px; }" in _etcss
    and "jobs.push(() => fetchEtf());" in read(f"{APP}/src/lib/prefetch.ts")
    and '{t(lang, "op_stale", { t: since(Math.max(0, Date.now() / 1000 - reply.at)) })}' in _ef)
say("«Институциональные потоки»: доступность — график с клавиатуры и описанием, таблица цифрами, заглушка «занята», высокая контрастность",
    'tabIndex={0} role="group" aria-label={t(lang, "ef_chart_keys")}' in _ef and "onKeyDown={onKey}" in _ef
    and 'e.key === "ArrowRight"' in _ef and 'e.key === "Escape"' in _ef and "function FlowTable(" in _ef
    and '<th scope="col">' in _ef and '<div aria-busy="true"><Card><Skeleton rows={8} /></Card></div>' in _ef
    and "@media (forced-colors: active)" in _etcss and ".ef-plot:focus-visible" in _etcss)

# Адреса бирж Bitcoin из отчётов о резервах: собирает tools/btc_seeds.py,
# бот грузит их вместе с ручным списком (ручной главнее).
_book = read(f"{BOT}/btc_seeds_book.h")
say("bitcoin: адреса бирж из отчётов о резервах подключены (1000+ адресов, ручной список главнее)",
    _book.count('", "') >= 1000 and "BTC_SEEDS_BOOK" in _book
    and '#include "btc_seeds_book.h"' in read(f"{BOT}/btc_chain.cpp")
    and "all.insert(all.end(), SEEDS.begin(), SEEDS.end());" in read(f"{BOT}/btc_chain.cpp")
    and os.path.exists(f"{BOT}/tools/btc_seeds.py"))

# Круги «с биржи и обратно» (у Kraken — 9 «выводов» из 10) не считаются
# сделками: пара снимается, со второго круга адрес — адрес биржи, его прошлые
# строки и потоки вычищаются; разово — по уже записанному.
_ws_btc3 = read(f"{BOT}/btc_chain.cpp")
say("bitcoin: круги «с биржи и обратно» не считаются ни покупкой, ни продажей",
    "bool unBounce(const std::string& wallet" in _ws_btc3 and "int cancelBounces()" in _ws_btc3
    and "int purgeWallet(const std::string& a" in _ws_btc3
    and 'putLabel(i.addr, ex, "bounce");' in _ws_btc3 and 'sc.state("bounce") != "1"' in _ws_btc3
    and "const bool round = toEx.size() == 1 && unBounce(sender->addr, ex, total, b, flow);" in _ws_btc3
    # Карточка потоков не показывает биржи с нулями.
    and "e.in + e.out >= 0.05" in read(f"{APP}/src/screens/BtcViews.tsx"))

# BSC: адреса бирж из отчётов о резервах (проверены в BSC: кошелёк, от пяти
# отправок). Имена списков BTC и BSC разные: одинаковое inline-имя в двух
# файлах склеивалось компоновщиком, и бот падал ещё до main().
_bbook = read(f"{BOT}/bsc_seeds_book.h")
say("bsc: адреса бирж из отчётов о резервах подключены, имена списков BTC и BSC не совпадают",
    _bbook.count('{"0x') >= 60 and "inline const BscSeedBook BSC_SEEDS_BOOK[]" in _bbook
    and '#include "bsc_seeds_book.h"' in read(f"{BOT}/bsc_exchanges.cpp")
    and "for (const BscSeedBook& sd : BSC_SEEDS_BOOK) put(sd.addr, sd.ex);" in read(f"{BOT}/bsc_exchanges.cpp")
    and "BTC_SEEDS_BOOK" in read(f"{BOT}/btc_seeds_book.h") and "SEEDS_BOOK =" not in read(f"{BOT}/btc_seeds_book.h").replace("BTC_SEEDS_BOOK =", "")
    and os.path.exists(f"{BOT}/tools/bsc_seeds.py")
    # Метки кошельков бирж и отчёт Bybit — третий источник; казино и кастоди
    # (Stake.com, Cobo) не биржи и в «без подписи» не показываются.
    and _bbook.count('{"0x') >= 120 and os.path.exists(f"{BOT}/tools/data/bsc_labels_extra.tsv")
    and '"0xef3aeff9a5f61c6dda33069c58c1434006e13b20", "Bybit"' in _bbook
    and "NOT_EXCHANGE.count(a)" in read(f"{BOT}/bsc_exchanges.cpp")
    # /exunknown делит сборщиков по тому, сколько они сами отправили:
    # биржа (от 50 000) или ферма/копилка (меньше 5 000).
    and 'rpc("eth_getTransactionCount", json::array({a, "latest"}), 1)' in read(f"{BOT}/bsc_exchanges.cpp")
    and "Похожи на фермы и копилки" in read(f"{BOT}/bsc_exchanges.cpp"))

# Карта ликвидаций: у Gate open_interest_usd — обе стороны (вдвое больше
# интереса), ряды бирж обрезаны ровно по окну (OKX отдавал 33 дня вместо 30).
say("карта ликвидаций: интерес Gate без удвоения, у всех бирж одно и то же окно",
    '_fnum(r.get("open_interest_usd")) / 2' in pybody(api, "def _liq_gate(")
    and "found[name] = rows[-n:]" in pybody(api, "def _liq_gather(")
    # Ещё биржи в снимках интереса: BloFin и XT.com; Zoomex — нет (отдаёт Bybit).
    and '("BloFin", _snap_blofin), ("XT.com", _snap_xt),' in api and "_snap_zoomex" not in api)

# «Добавить кошелёк» больше не отвечает общей ошибкой: причина отказа доходит
# до экрана («уже добавлен» — обновить список), а норма запросов считается
# на человека — на Cloud Run адрес у всех один, и норма делилась на всех.
_add = read(f"{APP}/src/screens/AddWalletScreen.tsx")
say("кошельки: отказ с причиной, норма запросов на человека, а не на адрес",
    'call<MutationResult>("/api/wallets", { method: "POST", body: { addr, name }, reason: true })' in read(f"{APP}/src/lib/api.ts")
    and 'toast(t(lang, failKey()), "err")' in _add and 'res?.error === "dup") {' in _add
    and "_limiter.allow(self._rate_key(qs))" in api and "_limiter.allow(self._peer())" not in api
    and 'not path.startswith("/api/logo/")' in api
    and "limit_req_zone $api_who zone=api:10m" in read(f"{APP}/nginx.conf"))

# Опционы BTC и ETH: интерес по страйкам с четырёх бирж, Max Pain, DVOL и
# крупные сделки Deribit; только с Премиумом, экран — в боковом меню.
_op = read(f"{APP}/src/screens/OptionsScreen.tsx")
say("опционы: Deribit, OKX, Bybit, Binance; Max Pain, DVOL, крупные сделки; Премиум",
    # Восемь бирж и четырнадцать монет; общие выгрузки — одна на все монеты.
    'OPT_SOURCES = (("Deribit", _opt_deribit), ("Bullish", _opt_bullish), ("OKX", _opt_okx), ("Bybit", _opt_bybit),\n               ("Binance", _opt_binance), ("Gate", _opt_gate), ("Delta", _opt_delta), ("Delta India", _opt_delta_in))' in api
    and 'OPT_SYMS = ("BTC", "ETH", "SOL", "XRP", "HYPE", "BNB", "DOGE", "AVAX", "TRX", "SUI", "ADA", "LTC", "XAUT", "MNT")' in api
    and "OPT_BULLISH_EVERY = 900.0" in api
    and "def options_coins(" in api and 'currency=USDC&kind=option' in api and "&uly={fam}" in api
    and "function CoinSwitch(" in _op and '"op_all_coins"' in _op
    and "def _opt_maxpain(" in api and "get_volatility_index_data" in api
    and "get_last_trades_by_currency_and_time" in api
    and '"options"' in api.split("PAID_PATHS = frozenset(")[1][:900]
    and 'if path in ("/options", "/api/options"):' in api
    and "options: OptionsScreen" in read(f"{APP}/src/screens/registry.ts")
    and "savedOptions(sym)" in _op and "refreshOptions(sym)" in _op
    and '<p className="lq-lead">{t(lang, "op_sub")}</p>' in _op
    # Профессиональный слой: волатильность по датам, перекос около 25 дельты,
    # блоки одной карточкой с названием стратегии, у каждого блока вывод словами.
    and "def _opt_smile(" in api and "0.674 * sig / 100" in api
    and "function TermChart(" in _op and "function strategyOf(" in _op and "function groupBig(" in _op
    and 'className="op-say"' in _op and 'className="op-verdict"' in _op)

# Ликвидации вживую: вебсокеты Binance/Bybit/OKX (свой клиент на стандартной
# библиотеке, с обходом страны через nginx), опрос Gate и HTX, семь дней в
# liq_oi.db. История интереса и фандинга — на тех же рядах, что карта
# ликвидаций. Календарь: данные США, решения ФРС, экспирации, разлоки.
_ngx2 = read(f"{APP}/nginx.conf")
say("ликвидации, история интереса и фандинга, календарь — сервер, экраны, Премиум",
    "class _WS:" in api and "def _liqs_binance(" in api and "def _liqs_bybit(" in api and "def _liqs_okx(" in api
    and "def _liqs_gate_loop(" in api and "def _liqs_htx_loop(" in api and "def liqs_data(" in api
    and "LIQS_KEEP = 7 * 86400" in api and "liqs_start()" in pybody(api, "def warmup(")
    and "def _liq_gather(" in api and "got, ref = _liq_gather(sym, period, n)" in pybody(api, "def _liq_build(")
    and "def oi_hist(" in api and "def _fund_hist(" in api and 'FUND_HIST_EX = ("Binance", "Bybit", "OKX", "Hyperliquid", "Gate", "Bitget", "Deribit",' in api
    and "def calendar_data(" in api and "ff_calendar_thisweek.json" in api and '("2026-10-28", 18)' in api
    and all(f'"{x}"' in api.split("PAID_PATHS = frozenset(")[1][:900] for x in ("liqs", "oihist", "calendar"))
    and "location /xr/binance-ws/" in _ngx2 and "location /xr/bybit-ws/" in _ngx2
    and 'proxy_set_header Upgrade $http_upgrade;' in _ngx2
    and all(x in read(f"{APP}/src/screens/registry.ts") for x in ("liqs: LiqsScreen", "oihist: OiHistScreen", "calendar: CalendarScreen")))

say("календарь: макро всех стран, отчёты компаний, листинги бирж, экспирации CME",
    "def _cal_earnings(" in api and "def _cal_listings(" in api and "def _cal_cme(" in api
    and "cal_ev2" in api and '"COIN"' in api and "api.nasdaq.com/api/calendar/earnings" in api
    and "announcements-new-listings" in api and "calendar_data()" in pybody(api, "def liq_warm_refresher(")
    and all(f'"{x}"' in read(f"{APP}/src/screens/CalendarScreen.tsx") for x in ("earn", "list", "cme")))
say("календарь обновляется сам: ФРС с её сайта, отчёты по дням, ленты бирж по отдельности, экран раз в пять минут",
    "CAL_FOMC_URL" in api and "for t, tent in _cal_fomc_dates():" in pybody(api, "def _cal_build(")
    and "_cal_earn_days[day0 + i * 86400] = (mono, rows)" in api and "_cal_list_last[key] = got" in api
    and 'con.execute("DELETE FROM cal_ev2 WHERE t BETWEEN ? AND ?", (min(week), max(week)))' in api
    and "_cal_ff_at = time.monotonic() - CAL_FF_EVERY + 300" in api
    and 'document.addEventListener("visibilitychange", pull);' in read(f"{APP}/src/screens/CalendarScreen.tsx"))
_shield = read(f"{APP}/wt_shield.py") if os.path.exists(f"{APP}/wt_shield.py") else ""
say("щит API: тело, соединения, тайм-аут, баны за ключ, логи без секретов, ошибки без текста",
    "import wt_shield as shield" in api and "class ShieldServer(ThreadingHTTPServer):" in _shield
    and "httpd = shield.ShieldServer((HOST, PORT), Handler)" in api and "ThreadingHTTPServer((HOST" not in api
    and "timeout = shield.CONN_TIMEOUT" in api and "shield.redact(fmt % args)" in api
    and "raise BodyError(413" in _shield and "raw = shield.read_body(self.rfile, self.headers, limit)" in api
    and "shield.bans.fail(self.client_address[0])" in pybody(api, "def _keyed(")
    and 'qs.get("init"' not in api and '"error": str(e)' not in api
    and "for k, v in shield.SECURITY_HEADERS:" in api and "if self._shield():" in pybody(api, "def do_POST(")
    and "if self._shield():" in pybody(api, "def do_GET(") and "_logo_slots.acquire(blocking=False)" in api
    and "len(raw) > shield.MAX_INIT_DATA" in api
    and "client_body_timeout 10s;" in _ngx and "limit_except GET POST OPTIONS { deny all; }" in _ngx
    and _ngx.count('add_header Strict-Transport-Security "max-age=31536000" always;') == 5
    and not os.path.exists(f"{APP}/whale_bot.db") and "*.db" in read(f"{APP}/.gitignore"))
_dgm = read(f"{APP}/src/screens/DigestMore.tsx")
say("дайджест v3: все вкладки — ликвидации, интерес с фандингом, опционы, неделя вперёд; разделы свёрнуты до вывода",
    'body: dict = {"v": 3,' in api and all(f"def _dg_{x}(" in api for x in ("liq", "oi", "opt", "cal"))
    and all(f'"k": "{x}"' in pybody(api, "def _dg_signals(") for x in ("liq", "oi", "fund", "pcr"))
    and all(f"export function {x}(" in _dgm for x in ("LiqSec", "OiSec", "OptSec", "AheadSec"))
    and "export const FoldCtx = createContext(false);" in _dgm and "if (fold && line) {" in _dgm
    and "<FoldCtx.Provider value>" in read(f"{APP}/src/screens/DigestTab.tsx")
    and ".dg-fold-l.up::before" in read(f"{APP}/src/styles/app.css"))
_cal = read(f"{APP}/src/screens/CalendarScreen.tsx")
say("календарь понятен: объяснение по нажатию, страна словами, экспирации без жаргона, важность — для крипты",
    "function explain(lang: Lang, e: CalEv): string {" in _cal and '<div className="cal-x">' in _cal
    and "const COUNTRY: Record<string, DictKey> = {" in _cal and 't(lang, "cal_opt_sub"' in _cal
    and 'cal_tap_hint' in _cal and "def _cal_imp_crypto(" in api
    and api.count("_cal_imp_crypto(cc, ") == 2 and "prev = (_cal_nq_days.get(key) or (0, []))[1]" in api)
say("картинки выпуска для скачивания из приложения нет — выпуск картинками только в канале",
    not os.path.exists(f"{APP}/src/lib/digestImage.ts") and "/api/digest/image" not in api
    and "/api/digest/image" not in _ngx and "MAX_UPLOAD" not in _shield
    and "toImage" not in read(f"{APP}/src/screens/DigestTab.tsx") and "def tg_send_document(" in api)
_fcss = read(f"{APP}/src/styles/fonts.css")
say("RODO: шрифт со своего сервера — ни Google Fonts, ни других адресов шрифтов наружу",
    all("googleapis" not in read(f"{APP}/{f}") and "gstatic" not in read(f"{APP}/{f}") for f in ("index.html", "html/index.html"))
    and '@import "./fonts.css";' in read(f"{APP}/src/styles/index.css") and "https:" not in _fcss
    and all(f'url("../assets/fonts/IBMPlexSans-{w}-{p}.woff2")' in _fcss and os.path.exists(f"{APP}/src/assets/fonts/IBMPlexSans-{w}-{p}.woff2")
            for w in ("Regular", "Medium", "SemiBold", "Bold") for p in ("latin", "cyrillic"))
    and "RODO: шрифт — со своего сервера" in read(f"{APP}/tests/e2e/halving.e2e.test.ts"))
_pace = read(f"{APP}/src/lib/pace.ts")
say("частота запросов: неполная выгрузка — всё реже, подгрузка — раз в минуту и стоп по 429, nginx отвечает 429",
    "export const SOON_MAX = 30_000;" in _pace and "export const PREFETCH_GAP = 60_000;" in _pace
    and "if (!due(Date.now())) return;" in read(f"{APP}/src/lib/prefetch.ts")
    and "queue(jobs, PARALLEL, () => lastStatus === 429)" in read(f"{APP}/src/lib/prefetch.ts")
    and "delay = okDelay();" in sync and "else if (lastStatus === 429) delay = MAX_DELAY;" in sync
    and "limit_req_status 429;" in _ngx and os.path.exists(f"{APP}/tests/pace.test.ts"))
_priv = json.load(open(f"{APP}/tools/i18n.json"))["legal_privacy_body"]
say("RODO ст. 13: в политике на 16 языках — администратор и почта, OVH в ЕС, журналы 14 дней, основания, права, жалоба в UODO",
    len(_priv) == 16 and all(all(x in v for x in ("wallettrackerbot@gmail.com", "@WalletTrackerHelp", "OVH", "14", "UODO", "uodo.gov.pl", "TON Connect"))
                             and re.search(r"(?<!\d)6(?!\d)", v) for v in _priv.values())
    and "MaxRetentionSec=14day" in read(f"{APP}/tools/autodeploy-install.sh"))
_dgi = read(f"{APP}/wt_digest_img.py") if os.path.exists(f"{APP}/wt_digest_img.py") else ""
say("автопостинг выпуска в канал: картинка на сервере (Pillow + IBM Plex), раз в день, повтор при сбое",
    "def render(it: dict, lang: str = \"ru\", page: str = \"\") -> bytes | None:" in _dgi and "def caption(" in _dgi
    and all(os.path.exists(f"{APP}/fonts/IBMPlexSans-{w}.ttf") for w in ("Regular", "Medium", "SemiBold", "Bold"))
    and "def digest_channel_post() -> bool:" in api and "digest_channel_post()" in pybody(api, "def digest_refresher(")
    and 'os.environ.get("WHALE_DIGEST_CHANNEL", "@WalletTrackerOfficial")' in api
    and "CREATE TABLE IF NOT EXISTS digest_channel (" in api
    # Канал — на английском, весь выпуск альбомом; сегодняшний короткий выпуск пересобирается в полный.
    and 'DIGEST_CHANNEL_LANG = "en"' in api and "WHALE_DIGEST_CHANNEL_LANG" not in api and "def tg_send_album(" in api
    and "def render_album(" in _dgi and all(f"def _page_{x}(" in _dgi for x in ("deriv", "pos", "flows", "week"))
    and "def digest_upgrade_today() -> bool:" in api and "digest_upgrade_today()" in pybody(api, "def digest_refresher(")
    # Ключи словаря, по которым сервер собирает выводы, есть в словаре приложения.
    and all(k in _i18n for k in ("dg_l_mkt", "dg_l_liq", "dg_l_oi", "dg_l_opt", "dg_l_etf_in", "dg_l_btcx_out",
                                 "dg_img_find", "dg_img_title", "dg_img_kicker", "dg_img_disc", "dg_v_bull")))
_dmore = read(f"{APP}/src/screens/DigestMore.tsx")
say("дайджест: в канале внизу только @WalletTrackerAppBot; монета в перекосах фандинга одна; лидер Hyperliquid",
    "BOT_URL" not in _dgi and "t.me/WalletTrackerAppBot" not in _dgi and "parts.append(BOT_AT)" in _dgi
    and "def _dg_fund_uniq(rows: list) -> list:" in api and '"hi": _dg_fund_uniq(' in api and '"lo": _dg_fund_uniq(' in api
    and "def _fund_uniq(rows: list) -> list:" in _dgi
    and "function fundUniq(" in read(f"{APP}/src/screens/DigestTab.tsx")
    and 'for venue in ("spot", "perp"):' in pybody(api, "def _dg_leaders(")
    and 'open("deals", l.perp!.a, "perp")' in _dmore and '("perp", "Hyperliquid")' in _dgi)
say("поиск любой монеты в ликвидациях и истории интереса; монеты с множителем (1000PEPE, kPEPE)",
    os.path.exists(f"{APP}/src/components/CoinFind.tsx")
    and all("<CoinFind " in read(f"{APP}/src/screens/{x}.tsx") for x in ("LiqsScreen", "OiHistScreen", "LiqMapScreen"))
    and "def _fund_aliases(" in api and "for alias in _fund_aliases(name, sym):" in pybody(api, "def _fund_hist(")
    and '("Binance", _liq_mult(_liq_binance))' in api and '("Bybit", _liq_mult(_liq_bybit))' in api)
say("масштаб: адрес человека — не узел Google, nginx→API постоянными соединениями, без Нейгла",
    "def client_ip(" in _shield and 'shield.client_ip(self.headers.get("X-Forwarded-For")' in pybody(api, "def _peer(")
    and "map $http_x_forwarded_for $client_ip {" in _ngx and "$binary_remote_addr" not in _ngx
    and "upstream whale_api {" in _ngx and "keepalive 16;" in _ngx and _ngx.count("proxy_pass http://whale_api") == 4
    and _ngx.count('proxy_set_header Connection "";') == 4 and "disable_nagle_algorithm = True" in api
    and 'sed -i "s|server 127.0.0.1:8090;|server ${UP_HOST};|"' in read(f"{APP}/start.sh"))
say("ликвидации с 11 бирж, фандинг-история с 22, интерес с 32, доска фандинга — 21 биржа",
    all(f"def _liqs_{x}(" in api for x in ("kraken", "bitfinex", "deribit", "dydx", "lighter", "paradex"))
    and 'LIQS_ALL = ("Binance", "Bybit", "OKX", "Kraken", "Gate", "HTX", "Bitfinex", "Deribit", "dYdX", "Lighter", "Paradex")' in api
    and '"srcs": list(LIQS_ALL)' in api and "_liqs_live[name] = time.time()" in pybody(api, "def _liqs_poll(")
    and "reply.srcs ??" in read(f"{APP}/src/screens/LiqsScreen.tsx")
    and len(api.split("FUND_HIST_EX = (")[1].split(")")[0].split(",")) == 22
    and all(f'"{x}"' in api.split("def _fund_rows_more(")[1].split("FUND_HIST_EX = (")[0] for x in
            ("Deribit", "Kraken", "dYdX", "MEXC", "KuCoin", "HTX", "BingX", "Aster", "WOO X", "Phemex", "Crypto.com",
             "Backpack", "Lighter", "BloFin", "XT", "Orderly"))
    and '("Bullish", _snap_bullish)' in api and '_snap_delta("api.india.delta.exchange")' in api
    and all(f'"{v}": fund_{v},' in api and f'{{ id: "{v}"' in read(f"{APP}/src/screens/FundingScreen.tsx")
            for v in ("htx", "deribit", "dydx", "lighter", "paradex", "woo", "backpack", "orderly", "delta"))
    and 'return "BTC" if s == "XBT" else s' in pybody(api, "def fund_sym("))
say("календарь: макро Nasdaq на недели вперёд, опционы и в первой сборке после запуска",
    "def _cal_nasdaq_macro(" in api and "api.nasdaq.com/api/calendar/economicevents" in api
    and "time.gmtime(day + 86400)" in pybody(api, "def _cal_nasdaq_macro(")
    and 'e["t"] > max(ff_end, lo)' in pybody(api, "def _cal_build(")
    and "cached_bg(_OPT, sym, OPT_TTL, lambda s=sym: _opt_build(s), wait=True)" in pybody(api, "def _cal_build(")
    and read(f"{APP}/src/screens/CalendarScreen.tsx").index('"cal_m_adp"') < read(f"{APP}/src/screens/CalendarScreen.tsx").index('"cal_m_nfp"'))
say("календарь: подписан часовой пояс, у каждого события — отсчёт до него",
    all(x in read(f"{APP}/src/screens/CalendarScreen.tsx") for x in
        ("function zoneLabel()", 't(lang, "cal_tz", { z: zoneLabel() })', "function rowCountdown(", 't(lang, "cal_in_ms"')))

print("ПРОВАЛОВ:", bad)
sys.exit(1 if bad else 0)
