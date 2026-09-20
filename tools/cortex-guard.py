#!/usr/bin/env python3
"""Статический сторож раздела Cortex.

    python3 tools/cortex-guard.py ../WhaleScanner

Ловит не опечатки, а возвращение уже исправленных ошибок. Каждая проверка
здесь стоит на месте настоящей поломки: доля депозита под риском считалась
по-разному в чате и в приложении, отказ модели ничего не отменял и сигнал
всё равно выходил, порог приёмки жил в трёх местах разными числами, правило
разметки было переписано в SQL вторым и уже разошедшимся экземпляром, а
список моделей схлопывался в одну — принятая закрывала собой проваленную.

Половина раздела живёт в боте, половина здесь, и связаны они не типами, а
договорённостями: одни и те же пороги, одни и те же имена признаков, один и
тот же расчёт. Проверить это можно только по исходникам обоих, и потому путь
к боту — обязательный аргумент, как у sync-i18n.py.
"""
import os, re, sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(APP), "WhaleScanner")
if not os.path.isdir(BOT):
    sys.exit(f"нет каталога бота: {BOT}\nзовите так: python3 tools/cortex-guard.py ../WhaleScanner")
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


ai = read(f"{BOT}/ai.cpp")
oracle = read(f"{BOT}/oracle.cpp")
api = read(f"{APP}/whale_api.py")
labels = read(f"{APP}/src/lib/labels.ts")
live = read(f"{APP}/src/store/live.ts")
sig = read(f"{APP}/src/screens/SignalScreen.tsx")
model = read(f"{APP}/src/screens/ModelScreen.tsx")


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


# --- доля депозита под риском -------------------------------------------
plan_of = body(ai, "TradePlan planOf(")
lvl = body(ai, "TradePlan planFromLevels(")
say("формульный план считает долю депозита", "t.riskShare" in plan_of, "")
say("план по уровням считает долю по плечу, а не по ставке Келли",
    "t.riskShare" in lvl and "a * t.leverage" in lvl and "stake * a) * 100" not in lvl)
say("у формульного плана на споте плеча нет",
    "!isPerp && lev > 1" in plan_of)
say("в чате запасного расчёта доли больше нет",
    "tp.riskPct * tp.leverage" not in ai)
say("на карточке запасом не стоит расстояние до стопа",
    "s.share || s.stopPct" not in sig and 's.share > 0 ? pct(s.share' in sig)

# --- отказ модели значит отсутствие сигнала ------------------------------
choose = body(ai, "Choice choosePlan(")
say("отказ модели помечается", "k.blocked = true" in choose)
say("формула — только когда модели нет вовсе",
    re.search(r"if \(sawModel\) \{\s*\n\s*k\.blocked = true;\s*\n\s*return k;\s*\n\s*\}",
              choose) is not None)
say("сторона проверяется до плана", "if (p < 0.5) continue;" in choose)
say("чат пропускает отвергнутое моделью",
    "if (ch.blocked) return false;" in ai and
    "if (!writeTrade(one, shown, r, lang, trainedHere, wantLong, live)) continue;" in ai)
say("список пропускает план, которого нет", "if (!k.plan.valid) continue;" in ai)

# --- пороги приёмки живут одним числом -----------------------------------
say("бот принимает по 0.55 / база / 0.52",
    "sc.auc < 0.55 || sc.logloss >= sc.baseLogloss" not in oracle and
    "sc.auc < 0.55 || sc.logloss >= sc.baseLoss || wf < 0.52" in oracle)
for name, src in (("API", api), ("хранилище приложения", live)):
    say(f"{name}: порога 400 не осталось",
        not re.search(r'"?need"?:\s*400', src), "")
say("API: порог 600 везде", len(re.findall(r'"need":\s*600', api)) >= 3,
    str(len(re.findall(r'"need":\s*600', api))))
say("экран состояния берёт пороги как в боте",
    "const AUC_GATE = 0.55" in model and "const WF_GATE = 0.52" in model)

# --- счётчик готовности повторяет разметку бота ---------------------------
cnt = code_only(pybody(api, "def _count_ready("))
say("счётчик не прячет порог числом в SQL", "*50>=" not in cnt and "*50 >=" not in cnt)
say("счётчик знает про оба горизонта", "price_6h" in cnt and "price_24h" in cnt)
say("счётчик не добавляет своих условий", "buy_nanos" not in cnt)
say("порог хода берётся из общей функции", "_min_move(horizon)" in cnt)
say("порог хода повторяет oracleMinMove",
    "ORACLE_MIN_MOVE = 0.02" in api and "math.sqrt(horizon / ORACLE_H24)" in api and
    "ORACLE_MIN_MOVE = 0.02" in oracle.replace("constexpr double ", ""))

# --- горизонты не сливаются в один ---------------------------------------
say("модель читается по горизонту", "def _oracle_model(cur: sqlite3.Connection, perp: bool, horizon" in api)
say("попытка читается по горизонту", "def _oracle_try(cur: sqlite3.Connection, perp: bool, horizon" in api)
say("выдача разбита по горизонтам", "def _oracle_rows(" in api and '"hz"' in api)
say("экран состояния рисует карточку на горизонт",
    "cortex.hz?.[v]" in model and "hzWords(lang, r.h)" in model)

# --- итоги истории считаются по всему журналу ------------------------------
hist = code_only(pybody(api, "def _signal_history("))
say("итоги истории — отдельным запросом без LIMIT",
    "COUNT(*) n, " in hist and "SUM(CASE WHEN outcome>0" in hist)
say("сорок — это длина списка, а не выборка для итогов",
    hist.count("LIMIT 40") == 1 and "len(items)" not in hist)

# --- блок Cortex не отбрасывается пустым -----------------------------------
say("пустой блок берётся целиком",
    "cortexOf(d.cortex ?? d.sonar) ?? prev.cortex" in live and
    "c?.list?.length || c?.trained" not in live)

# --- имена признаков ---------------------------------------------------------
KEEP = {"RSI", "ATR", "MACD", "MACD sig", "MACD hist"}
names = re.findall(r'"([^"]*)"',
                   re.search(r'const char\* const FEAT_NAME\[ORACLE_NF\] = \{(.*?)\};',
                             oracle, re.S).group(1))
mapped = set(re.findall(r'^\s*"?([A-Za-z0-9 /]+?)"?:\s*"ai_',
                        re.search(r'const WHY: Record<string, DictKey> = \{(.*?)\n\};',
                                  labels, re.S).group(1), re.M))
miss = [n for n in names if n not in mapped and n not in KEEP]
say("каждое имя признака переведено или оставлено намеренно", not miss, ", ".join(miss))
say("экран состояния переводит имена признаков",
    "name: featName(f.k)" in model and "name: f.k," not in model)

api_names = re.findall(r'"([^"]*)"',
                       re.search(r'ORACLE_FEATURES = \((.*?)\n\)', api, re.S).group(1))
app_names = re.findall(r'"([^"]*)"',
                       re.search(r'export const ORACLE_FEATURES = \[(.*?)\] as const;',
                                 read(f"{APP}/src/components/Brain.tsx"), re.S).group(1))
say("списки признаков совпадают в трёх слоях",
    names == api_names == app_names,
    f"{len(names)}/{len(api_names)}/{len(app_names)}")

# --- сигнал показывается таким, каким вышел --------------------------------
log_fn = body(ai, "void logSignals(")
say("журнал хранит весь план",
    all(k in log_fn for k in ("risk_share,lev,why", "p.riskShare", "p.leverage", "k.why")))
say("миграции журнала дописаны",
    all(f"ALTER TABLE ai_signal_log ADD COLUMN {c}" in ai
        for c in ("risk_share", "lev", "why")))
sig_fn = code_only(pybody(api, "def _signals("))
say("план приходит из журнала, а не из публикации",
    "LEFT JOIN ai_signal_log g" in sig_fn and "g.closed_at=0" in sig_fn)
say("возраст — от появления сигнала",
    "COALESCE(g.made_at, s.made_at)" in sig_fn and '"at": int(r["at"]' in sig_fn)
say("доход считается в сторону сигнала",
    "if not long_:" in sig_fn and "roi = -roi" in sig_fn)
say("доход считается от показанного входа",
    "(live_px - entry) / entry" in sig_fn)
say("расстояние до стопа — от показанной пары",
    "abs(stop - entry) / entry" in sig_fn and 'r["risk_pct"]' not in sig_fn)
say("список показывает возраст и доход",
    'className="sig-foot"' in read(f"{APP}/src/screens/CortexTab.tsx"))
say("карточка показывает возраст и доход",
    "ai_since_signal" in sig and "since(Math.max(0, Date.now() / 1000 - s.at))" in sig)

# --- порядок списка и открытие карточки -------------------------------------
say("список идёт по свежести", '"ORDER BY at DESC, conf DESC"' in api)
say("карточка открывается по монете, а не по номеру",
    'open("signal", s.venue, `${s.side}|${s.sym}`)' in read(f"{APP}/src/screens/CortexTab.tsx") and
    "list.find((x) => x.sym === want" in sig)

# --- свечи и закрытие сигнала ----------------------------------------------
say("биржевые свечи — только для перпов",
    'const wantExch = venue === "perp";' in sig and
    "if (!sym || !wantExch)" in sig)
say("у спота источник — история своего контракта",
    "fetchTokenHist(addr" in sig)
say("контракт показан на карточке спота", 'className="row tap sig-addr"' in sig)
close_fn = body(ai, "void closeSignalLog(")
say("на разбор идут все открытые сигналы",
    "WHERE closed_at=0 LIMIT 200" in close_fn and "made_at+horizon<=" not in close_fn)
say("стоп и цель закрывают сигнал сразу",
    "const bool expired = o.made + o.horizon <= now;" in close_fn and
    "std::min(now, o.made + o.horizon)" in close_fn)
say("пустой ход закрывается только по горизонту",
    "w.done = expired;" in body(ai, "Walked walkOutcome("))

# --- часы переобучения ------------------------------------------------------
tick = body(oracle, "void oracleTick(")
say("часы переобучения переводятся только после проверки рядов",
    tick.index("if (!m || m->builtAt == 0) return;") < tick.index("lastTrain = now;"))

print("ПРОВАЛОВ:", bad)
sys.exit(1 if bad else 0)
