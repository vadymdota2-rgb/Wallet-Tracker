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
import json, os, re, sys

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
cortex = read(f"{APP}/src/screens/CortexTab.tsx")
histscr = read(f"{APP}/src/screens/HistoryScreen.tsx")


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

# --- приёмка опирается на скользящую проверку, а не на один кусок ----------
head = read(f"{BOT}/oracle.h")
say("порог примеров для приёмки объявлен в боте",
    "ORACLE_MIN_ACCEPT = 1200" in head and "ORACLE_WF_FOLDS = 4" in head)
rule = ai_rule = oracle[oracle.index("const bool enough ="):oracle.index("saveTry(perp, horizon")]
say("приёмка требует объёма, всех складок и каждой выше монетки",
    all(c in rule for c in ("ORACLE_MIN_ACCEPT", "wf.folds >= ORACLE_WF_FOLDS",
                            "wf.mean >= 0.52", "wf.worst >= 0.50")), rule)
say("скользящая проверка отдаёт худшую складку",
    "struct WalkResult" in oracle and "r.worst = worst;" in oracle)
say("худшая складка доходит до экрана",
    '"wfMin"' in api and "wfMin={attempt.wfMin}" in model)
say("экран заворачивает по худшей складке",
    "const WF_WORST_GATE = 0.5" in model and "wfMin >= WF_WORST_GATE" in model)

# --- пороги приёмки живут одним числом -----------------------------------
for name, src in (("API", api), ("хранилище приложения", live)):
    say(f"{name}: прежних порогов не осталось",
        not re.search(r'"?need"?:\s*(400|600)\b', src), "")
say("API: порог приёмки везде один и тот же, как в боте",
    set(re.findall(r'"need":\s*(\d+)', api)) == {"1200"},
    str(set(re.findall(r'"need":\s*(\d+)', api))))
say("экран состояния берёт пороги как в боте",
    "const AUC_GATE = 0.55" in model and "const WF_GATE = 0.52" in model)

# --- счётчик готовности повторяет разметку бота ---------------------------
cnt = code_only(pybody(api, "def _count_ready("))
say("счётчик не прячет порог числом в SQL", "*50>=" not in cnt and "*50 >=" not in cnt)
say("счётчик знает про оба горизонта", "price_6h" in cnt and "price_24h" in cnt)
say("счётчик не добавляет своих условий", "buy_nanos" not in cnt)
# Тихие исходы бот больше не выбрасывает — даёт им вес в четверть. Порог
# хода в счётчике означал бы, что экран считает меньше, чем ждёт обучение.
say("счётчик не режет выборку порогом хода",
    "_min_move" not in cnt and "price_then*?" not in cnt)
say("бот тихие исходы взвешивает, а не выбрасывает",
    "clampd(std::fabs(ret) / minMove, 0.25, 3.0)" in oracle and
    "if (std::fabs(ret) < minMove) continue;" not in oracle)
# Шаг прореживания — горизонт, а не сутки, и одинаковый в боте и в счётчике.
# Разойдись они, полоса на экране считала бы не то, чего ждёт обучение.
say("счётчик прореживает шагом в горизонт",
    "e2.ts/{int(horizon)}=e.ts/{int(horizon)}" in cnt, cnt)
say("бот прореживает тем же шагом",
    'e2.ts/" + std::to_string(horizon)' in oracle and '"=e.ts/" + std::to_string(horizon)' in oracle)
say("суток в шаге прореживания не осталось",
    "ts/86400=e.ts/86400" not in oracle and "ts/86400=e.ts/86400" not in api)
say("видно, где сужается воронка",
    "непересекающихся" in oracle and "тихих (вес четверть)" in oracle)

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
# --- история считается по площадкам врозь ----------------------------------
# Токены BSC и перпы Hyperliquid — разные рынки с разной ликвидностью и
# разными стопами. Общая доля попаданий по ним не значит ничего: одна
# площадка тянет вторую, а какая именно — не видно.
say("история берёт только свою площадку",
    hist.count("venue=?") == 4 and "def _signal_history(cur: sqlite3.Connection, perp: bool)" in api,
    str(hist.count("venue=?")))
say("API отдаёт историю обеих площадок врозь",
    '"hist"] = {"spot": _signal_history(cur, False),' in api)
say("запасные пути API отдают ту же пару",
    api.count('for v in ("spot", "perp")') >= 3, str(api.count('for v in ("spot", "perp")')))
say("хранилище знает историю по площадкам", "spot: { hit: 0" in live)
say("вкладка берёт историю выбранной площадки", "cortex.hist[venue]" in cortex)
say("экран истории берёт её же", "cortex.hist[venue]" in histscr)
say("на экране истории есть переключатель площадок", "setCortexVenue" in histscr)
# Сервер живёт на своей машине и перезапускается отдельно: приложение
# успевает обновиться раньше. Старый общий блок не должен ронять вкладку.
say("старый ответ сервера не роняет вкладку",
    "!h.spot || !h.perp" in live and "hist: EMPTY_CORTEX.hist" in live)

# --- блок Cortex не отбрасывается пустым -----------------------------------
say("пустой блок берётся целиком",
    "cortexOf(d.cortex ?? d.sonar) ?? prev.cortex" in live and
    "c?.list?.length || c?.trained" not in live)

# --- тяжёлое не держит базу и не перебирает журнал ---------------------------
ls_body = oracle[oracle.index("std::vector<Sample> loadSamples("):oracle.index("\nstruct Scored")]
say("признаки считаются после того, как замок отпущен",
    ls_body.index("// замок базы отпущен") < ls_body.index("featuresOf(m, in, ts, sm.f);"))
say("отбор примеров опирается на индекс по монете",
    "idx_ai_events_coin ON ai_events(token, venue, ts)" in ai)

# --- чат и экран говорят одними словами --------------------------------------
say("на экране состояния нет аббревиатур",
    not re.search(r'label="AUC"|"AUC"', model) and "ai_st_quality" in model)
# Чат — такой же публичный экран: ни «AUC», ни числа деревьев там быть не
# должно. Ищем по всему исходнику сообщений, а не по одной функции.
say("в сообщении бота аббревиатур нет",
    '"AUC' not in ai and 'ai_st_trees' not in ai,
    "AUC" if '"AUC' in ai else "ai_st_trees")
say("имена признаков в чате переводятся",
    "featureLabel(os.top[k].first, lang)" in ai)

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
# Та же таблица есть в боте — для сообщения в чате. Разойдись они, одни и те
# же признаки назывались бы в чате и на экране по-разному.
bot_map = dict(re.findall(r'^\s*\{"([^"]+)",\s*"(ai_[a-z0-9_]+)"\},$',
                          re.search(r'const std::pair<const char\*, const char\*> FEATURE_KEY\[\] = \{(.*?)\n\};',
                                    ai, re.S).group(1), re.M))
app_map = dict(re.findall(r'^\s*"?([A-Za-z0-9 /]+?)"?:\s*"(ai_[a-z0-9_]+)"',
                          re.search(r'const WHY: Record<string, DictKey> = \{(.*?)\n\};',
                                    labels, re.S).group(1), re.M))
say("таблицы имён в боте и в приложении совпадают", bot_map == app_map,
    str(set(bot_map.items()) ^ set(app_map.items())))
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

# --- учится на всём, показывает лучшее ---------------------------------------
pub = body(ai, "void publishSignals(")
say("в список идут десять лучших на площадку",
    "SHOW_PER_VENUE = 10" in pub and "(k.r.perp ? perpK : spotK)" in pub and
    "a.conf > b.conf" in pub)
say("отсечка стоит до журнала выданного",
    pub.index("SHOW_PER_VENUE") < pub.index("logSignals(asOf, rows);"))
say("отсечка живёт только в публикации", ai.count("SHOW_PER_VENUE") == 3)
say("сбор обучающих исходов идёт мимо неё",
    "SHOW_PER_VENUE" not in body(ai, "void snapshotHour(") and
    "SHOW_PER_VENUE" not in body(ai, "void insertLabeled("))

# --- разметка задним числом --------------------------------------------------
say("есть поиск цены на момент в прошлом", "long long priceAtOf(" in ai)
say("просроченный исход берётся из рядов, а не обнуляется",
    "px6 = stale6 ? priceAtOf(perp, p.token, p.ts + AI_HORIZON_6H)" in ai and
    "px24 = stale24 ? priceAtOf(perp, p.token, p.ts + AI_HORIZON_24H)" in ai)
rep = body(ai, "void repairOutcomes(")
# Ремонт идёт по кругу, а не один раз: дыра может появиться и позади курсора,
# если бот простоял час. Дойдя до конца, курсор сбрасывается в ноль.
say("ремонт журнала с курсором и по кругу",
    "static bool done" not in rep and "CURSOR_KEY = 901" in rep and
    "WHERE id>? AND price_then>0 ORDER BY id LIMIT ?" in rep and
    "VALUES(?,0)" in rep)
say("ремонт зовётся из общего тика", "    repairOutcomes();" in ai)

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

# --- защита от подгонки многократными попытками -----------------------------
# Бот пробует обучиться каждый день. Порог, взятый один раз из шестнадцати
# попыток, не значит ничего: при 16 попытках в сутки случайное «AUC ≥ 0.55»
# выпадает с вероятностью под семь десятых. Отсюда три правила: выборка между
# попытками должна заметно подрасти, проверка — сойтись дважды подряд, а
# развалившаяся модель — сняться с боя, а не дожить до следующей удачи.
tv = body(oracle, "void trainVenue(")
say("между попытками обязаны набраться новые исходы",
    "ORACLE_GROWTH_NUM" in tv and "ORACLE_GROWTH_DEN" in tv)
# Размером выборки мерить нельзя: журнал живёт окном и выходит на полку —
# сколько исходов приходит, столько и уходит. По росту обучение замерло бы
# навсегда, хотя данные за квартал сменились целиком.
say("считается новизна, а не размер выборки",
    "if (x.ts > last.lastTs) fresh++" in tv)
say("время свежайшего примера хранится между попытками",
    "last_ts INTEGER NOT NULL DEFAULT 0" in oracle and
    "ALTER TABLE ai_model_try ADD COLUMN last_ts" in oracle)
say("приёмка требует подтверждения на новых данных",
    "passes >= ORACLE_CONFIRMS" in tv and "passed ? last.passes + 1 : 0" in tv)
say("проваленная проверка снимает модель с боя",
    "revokeModel" in tv and "oracleReadyUnlocked" in tv)
say("снятие чистит и таблицу, и живую копию",
    'DELETE FROM ai_models' in body(oracle, "void revokeModel(") and
    "g_live" in body(oracle, "void revokeModel("))
say("число подтверждений хранится между попытками",
    "passes INTEGER NOT NULL DEFAULT 0" in oracle and
    "ALTER TABLE ai_model_try ADD COLUMN passes" in oracle)
say("API отдаёт счёт подтверждений", '"passes": int(row["passes"] or 0),' in api)
say("API называет, сколько их нужно", set(re.findall(r'"confirms":\s*(\d+)', api)) == {"2"},
    str(set(re.findall(r'"confirms":\s*(\d+)', api))))
say("экран показывает условие подтверждения",
    '"ai_gate_pass"' in model and '(passes ?? 0) >= confirms ? "ok" : "wait"' in model)
say("хранилище знает порог подтверждений без сервера", "confirms: 2," in live)

# --- карантин на границах отрезков ------------------------------------------
# Исход события длится горизонт. Событие из конца обучающего куска своим
# исходом заходит в проверочный: модель учится на том, что ей же потом
# показывают как незнакомое. Поэтому на каждой границе выбрасывается
# горизонт примеров — и на общем разрезе, и внутри скользящей проверки.
say("карантин считается от горизонта",
    "const long long edge = after.front().ts - horizon;" in body(oracle, "void embargo("))
say("карантин стоит на складках скользящей проверки",
    "embargo(tr, va, horizon)" in body(oracle, "WalkResult walkForward(") and
    "embargo(va, te, horizon)" in body(oracle, "WalkResult walkForward("))

# --- возраст монеты не зависит от окна хранения -----------------------------
# Возраст считался от начала ряда, а начало съезжает вместе с окном в 95
# суток: у одного и того же события значение сегодня выходило не то, каким
# было вчера, и обученное расходилось с применённым. Теперь час первой
# встречи записан в базу один раз и оттуда же и читается.
age = body(oracle, "double ageOf(")
say("возраст считается от записанного часа первой встречи",
    "s.seen <= 0) return 1.0;" in age and "- s.seen)" in age, age)
say("возраст больше не смотрит на начало ряда", "s.bars.front().ts" not in age, age)
say("час первой встречи хранится", "CREATE TABLE IF NOT EXISTS ai_coin_seen" in oracle)
seen = body(oracle, "void fillFirstSeen(")
say("записанное не переписывается",
    "INSERT OR IGNORE INTO ai_coin_seen" in seen and "UPDATE ai_coin_seen" not in oracle)
say("уже известное берётся из базы, а не из ряда",
    "if (it != known.end()) { kv.second.seen = it->second; continue; }" in seen)
say("обрезанный окном ряд даёт «не знаю»",
    "(edge > 0 && first <= edge + 2 * 3600) ? 0 : first" in seen)
say("ряды знают свой час первой встречи", "long long seen = 0;" in oracle)
say("край в рядах больше не хранится", "fresh.edge" not in oracle and "m.edge" not in oracle)

# --- колена, волны и уровни Фибоначчи ---------------------------------------
# Разметка считается только по барам не позже события: уровень, посчитанный
# по будущему максимуму, был бы не признаком, а ответом.
sw = body(oracle, "void swingsOf(")
say("разметка идёт по барам не позже события",
    "for (int k = from; k <= i; k++)" in sw and "i - hours + 1" in sw)
wv = body(oracle, "void wavesOf(")
say("волны считаются от разметки, а не от цены наугад", "swingsOf(s, i, 336, thr, sw)" in wv)
say("порог разворота берётся от волатильности монеты",
    "clampd(3.0 * atrOver(s, i, 24), 0.015, 0.12)" in wv)
say("уровни Фибоначчи названы числами, а не порогом",
    "{0.382, 0.5, 0.618}" in wv)
say("признаки волн не заглядывают вперёд",
    "s.bars[static_cast<size_t>(i)].c" in wv and "i + 1" not in wv)
say("шесть признаков встали на свои места",
    "for (int k = 0; k < 6; k++) f[41 + k] = w[static_cast<size_t>(k)];" in oracle)
say("признаков стало сорок семь", "ORACLE_NF = 47" in read(f"{BOT}/oracle.h"))
# Старая модель училась на сорока одном признаке и считает не то. Строку
# надо удалить, а не просто забыть: API читает ai_models напрямую.
say("нечитаемая модель снимается с боя, а не забывается",
    "revokeModel(v != 0, horizon);" in body(oracle, "void loadModels("))
say("число признаков записано в самой модели",
    "nf != static_cast<uint32_t>(ORACLE_NF)) return false;" in oracle)

# --- описание оракула не отстаёт от признаков -------------------------------
# «Смотрит на 41 признак» под сорока семью — обещание, которое разошлось с
# делом. Текст один на шестнадцать языков и лежит в боте.
ru_cpp = read(f"{BOT}/ru.cpp")
tr_cpp = read(f"{BOT}/translations.cpp")
hints = re.findall(r'\{"ai_hint", \{"((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\}\}', ru_cpp)
hints = list(hints[0]) if hints else []
hints += re.findall(r'\{"ai_hint", "((?:[^"\\]|\\.)*)"\}', tr_cpp)
say("описание оракула есть на шестнадцати языках", len(hints) == 16, str(len(hints)))
say("в описании столько же признаков, сколько в боте",
    all("47" in h and "41" not in h for h in hints),
    str([i for i, h in enumerate(hints) if "47" not in h or "41" in h]))
say("описание рассказывает про колена и Фибоначчи",
    all(h.count("\\n\\n") == 5 for h in hints),
    str([i for i, h in enumerate(hints) if h.count("\\n\\n") != 5]))

# --- сообщение бота помещается в телеграм -----------------------------------
# Телеграм отказывает целиком, а не обрезает: переросшее сообщение оставит
# человека без сигналов. Описание длинное, и уступать место обязано оно.
say("предел длины сообщения объявлен", "constexpr size_t TG_LIMIT = 3900;" in ai)
say("карточки перестают добавляться у предела",
    "t.str().size() + one.str().size() + 1 > TG_LIMIT) break;" in ai)
say("описание вставляется последним и только если влезает",
    "out.size() + hint.size() <= TG_LIMIT" in ai and "out.insert(hintAt, hint);" in ai)

# --- все признаки доезжают до анимации --------------------------------------
say("анимация крутит весь список, а не только верхушку модели",
    "...ORACLE_FEATURES.filter((f) => !(top ?? []).some((x) => x.k === f))" in
    read(f"{APP}/src/components/Brain.tsx"))

# --- площадки не портят друг друга ------------------------------------------
# Спот и перпы — разные рынки. Если модель одной разваливается, вторая не
# должна этого заметить: ни выборкой, ни моделью, ни местом на экране.
say("выборка для обучения фильтрует площадку", "AND e.venue=? " in oracle)
say("прореживание не смешивает площадки", "e2.venue=e.venue" in oracle)
say("обучение зовётся на каждую площадку отдельно",
    "trainVenue(false, *m, h);" in oracle and "trainVenue(true, *m, h);" in oracle)
say("живая модель лежит в своём слоте", "g_live[perp ? 1 : 0][hIndex(horizon)]" in oracle)
say("снятие модели бьёт по одной площадке",
    "DELETE FROM ai_models WHERE venue=? AND horizon=?" in oracle)
say("в бою спрашивается модель своей площадки",
    "const int slot = in.perp ? 1 : 0;" in oracle and "g_live[slot][hi].have" in oracle)
say("признак обученности и точность — свои у каждой",
    "trained = r.perp ? g_trainedPerp : g_trainedSpot;" in ai)
say("десятка сигналов берётся на площадку, а не общая",
    "SHOW_PER_VENUE" in ai and "(k.r.perp ? perpK : spotK)" in ai)

# --- разбор сигнала не оставляет мертвецов ----------------------------------
# Токен перестали опрашивать — цен за нужные часы нет, и сигнал не закрывался
# никогда. Накопившись, такие строки съедали всё окно разбора (двести за
# проход), и живые сигналы переставали закрываться вовсе.
walk = body(ai, "Walked walkOutcome(")
say("пустой разбор закрывается по горизонту",
    "w.done = expired;" in walk and "w.outcome = 0;" in walk)
close_fn2 = body(ai, "void closeSignalLog(")
say("нулевой вход не пропускается молча",
    "if (o.entry <= 0) {" in close_fn2 and "if (!expired) continue;" in close_fn2)
say("выходом без цен считается вход",
    "const double exitPx = v.exitPx > 0 ? v.exitPx : o.entry;" in close_fn2)
say("прежнего отсева по нулевой цене не осталось",
    "if (!w.done || w.exitPx <= 0) continue;" not in ai)

# --- стоп и цель закрывают сигнал сразу -------------------------------------
# Разбор идёт раз в минуту, но судил по часовым барам: пока час не записан,
# касание стопа не видно, и закрытие опаздывало на час.
say("живая цена берётся по монете, а не по строке списка",
    "long long livePriceById(bool perp, const std::string& id)" in ai and
    "livePriceById(o.venue == 1, o.token)" in ai)
say("кэш живой цены общий с публикацией",
    "long long livePriceOf(const Row& r) { return livePriceById(r.perp, r.id); }" in ai)
say("стоп проверяется раньше цели и в живой проверке",
    ai.index("(live <= o.stop) : (live >= o.stop)") < ai.index("(live >= o.take) : (live <= o.take)"))
# У истёкшего сигнала сегодняшняя цена — уже после его срока: засчитывать по
# ней значило бы приписать ему чужое движение.
say("живая проверка не трогает истёкшие сигналы", "!v.done && !expired" in ai)
say("число живых запросов за проход ограничено", "AI_LIVE_CHECK_N" in ai)
say("окно живых проверок едет по кругу, чтобы хвост не голодал",
    "static size_t liveFrom = 0;" in ai and "liveFrom += AI_LIVE_CHECK_N;" in ai)

# --- у спота свои верх и низ часа -------------------------------------------
# Цена писалась раз в час одной точкой, хотя опрашивалась по многу раз. По
# одной точке не видно, что цена задевала стоп и вернулась: сигнал считался
# «никуда не пошёл», и история выходила лучше правды.
say("час спота хранит верх и низ",
    "hi_nanos INTEGER NOT NULL DEFAULT 0" in read(f"{BOT}/main.cpp") and
    "ADD COLUMN hi_nanos" in read(f"{BOT}/main.cpp"))
tp_cpp = read(f"{BOT}/token_prices.cpp")
say("верх и низ копятся за час, а не переписываются",
    "ON CONFLICT(address,ts) DO UPDATE SET" in tp_cpp and
    "hi_nanos=MAX(" in tp_cpp and "lo_nanos=MIN(" in tp_cpp)
say("первая цена часа остаётся нетронутой",
    "price_nanos=" not in tp_cpp.split("DO UPDATE SET")[1].split(")) return;")[0])
say("разбор спота берёт верх и низ из базы",
    "SELECT ts, price_nanos, hi_nanos, lo_nanos FROM token_price_history " in ai)
# Ряды оракула при этом трогать нельзя: признаки считаются по price_nanos и
# при обучении, и в бою. Подмени его — обученное перестанет отвечать
# применённому, причём только на свежей половине журнала.
say("ряды оракула по-прежнему по одной цене часа",
    "SELECT h.address,h.ts,h.price_nanos FROM token_price_history h " in oracle)
say("итоги истории по площадке опираются на индекс",
    "idx_signal_log_done ON ai_signal_log(venue, closed_at)" in ai)

# --- честность оценки: то, что отличает оракул от самообмана ----------------
# Эти пять вещей нельзя «починить» в сторону послабления, не разрушив смысл
# всех остальных чисел на экране.
say("калибровка сидит на проверочной части, а не на тестовой",
    "fitPlatt(zv, yv, out.forest.calA, out.forest.calB);" in oracle and
    "for (size_t i = 0; i < va.size(); i++) zv[i] = out.forest.raw(va[i].f.data());" in oracle)
say("срединные значения признаков берутся с обучающей части",
    "for (const Sample& s : tr) col.push_back(s.f[static_cast<size_t>(f)]);" in oracle)
# Постоянный прогноз считается по доле роста самого теста — это наименьшие
# возможные потери для константы, то есть планка строже обычной. Замена её на
# долю обучения сделала бы приёмку легче.
say("базовый прогноз считается по доле роста теста",
    "std::vector<double> flat(xs.size(), clampd(r.rate, 1e-6, 1 - 1e-6));" in oracle and
    "r.baseLoss = loglossOf(flat, y);" in oracle)
# Без усреднения рангов на связках константный прогноз давал бы AUC 1 или 0.
say("AUC считает средние ранги на связках",
    "const double r = (static_cast<double>(i) + static_cast<double>(j)) / 2.0 + 1.0;" in oracle)
say("уровни оценены на отложенном тесте, а база — среднее обучения",
    "for (const Sample& x : tr) { mUp += x.up; mDn += x.dn; }" in oracle and
    "for (const Sample& x : te) {" in oracle)
say("в бой попадает только принятая модель",
    oracle.index("if (!accepted) {") < oracle.index("saveModel(perp, model, st, fit.gain);"))
say("уверенность и горизонт берутся из одного взгляда модели",
    "cand.horizon = view.horizon;" in ai and
    "k.conf = std::min(99, std::max(1, static_cast<int>(p * 100.0 + 0.5)));" in ai)
say("модель обязана согласиться со стороной потока", "if (p < 0.5) continue;" in ai)

# --- обещанное обязано совпадать со сбывшимся -------------------------------
# AUC говорит только про порядок: модель может безошибочно ранжировать и при
# этом называть 90% там, где сбывается 55%. Человеку показывают именно число.
say("мера калибровки объявлена", "void calibrationOf(" in oracle)
say("рядом с ней считается шумовой пол",
    "floor += w * std::sqrt(std::max(mp * (1.0 - mp), 0.01)" in oracle)
# Сравнивать ECE с наперёд заданным числом бессмысленно: на полутора сотнях
# строк идеальная модель даст заметную ошибку сама по себе.
say("ворота сравнивают ошибку с шумовым полом, а не с числом",
    "sc.ece <= ORACLE_ECE_K * sc.eceFloor" in oracle and
    "constexpr double ORACLE_ECE_K" in read(f"{BOT}/oracle.h"))
say("калибровка входит в условие приёмки", "&& calibrated;" in oracle)
say("ошибка и пол хранятся между попытками",
    "ALTER TABLE ai_model_try ADD COLUMN ece " in oracle and
    "ALTER TABLE ai_models ADD COLUMN ece " in oracle)
say("API отдаёт и ошибку, и пол",
    '"ece": round(float(row["ece"] or 0), 3)' in api and
    '"eceFloor": round(float(row["ece_floor"] or 0), 3)' in api)
say("экран показывает отношение, а не сырую ошибку",
    "const ratio = known ? ece! / eceFloor! : 0;" in model and
    '"ai_gate_cal"' in model)

# --- сверка обещанного со сбывшимся на экране -------------------------------
# Общая доля попаданий складывает шестидесятипроцентные сигналы с
# восьмидесятипроцентными и говорит одно среднее, за которым не видно, врёт
# число или нет.
say("сверка считается по корзинам уверенности", "def _reliability(" in api)
say("в знаменатель идут только решённые сигналы", 'AND outcome!=0{only_model}"' in api)
say("корзина отдаёт и обещанное, и число сигналов",
    '"said": round(' in api and '"n": len(got),' in api)
say("экран истории показывает сверку",
    '"ai_rel_title"' in histscr and "hist.rel?.length" in histscr)
say("и предупреждает, когда сигналов мало",
    '"ai_rel_few"' in histscr and "b.n < 10" in histscr)
# Тикер монеты обрезать нечем: по огрызку её не узнать.
say("тикер в истории переносится, а не теряет букву",
    ".row-name.wrap" in read(f"{APP}/src/styles/app.css") and
    'wrap ? "row-name wrap" : "row-name"' in read(f"{APP}/src/components/ui.tsx"))

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

# --- поток китов по перпам виден целиком ------------------------------------
# Признаки потока строились из одних открытий позиций: кит, сливающий лонг на
# миллион, был для модели невидим. А `flow` — признак номер ноль, тот самый,
# что обычно стоит первым по важности.
hdr = read(f"{BOT}/hyperliquid_internal.h")
say("правило направления одно и лежит рядом с кодами", "inline int dirPush(" in hdr)
say("закрытия считаются наравне с открытиями",
    "case DIR_CLOSE_SHORT: return 1;" in hdr and "case DIR_CLOSE_LONG:  return -1;" in hdr)
say("направление переворота берётся из текста",
    'dir.find("short > long")' in hdr.split("inline int dirPush(")[1] and
    'dir.find("long > short")' in hdr.split("inline int dirPush(")[1])
# Ликвидации — принуждение, а не решение кита; у них свои признаки.
say("ликвидации в поток не подмешиваются",
    "default: return 0;" in hdr.split("inline int dirPush(")[1])
say("живой счёт спрашивает все коды",
    "WHERE ts>=? AND ts<=? AND dir_code IN (1,2,3,4,5,6,7,8)" in ai)
say("заливка журнала спрашивает те же",
    "WHERE ts>=? AND dir_code IN (1,2,3,4,5,6,7,8)" in ai)
say("оба места зовут общее правило", ai.count("dirPush(dir, safeColumnText(s,") == 2)
say("прежнего «не открыл лонг — значит продажа» не осталось",
    "dir == DIR_OPEN_LONG" not in ai)
say("лента крупных сделок видит и закрытия",
    "dir_code IN (1,2,3,4,5)" in read(f"{BOT}/big_trades.cpp"))
# Строки журнала по старому правилу оставить нельзя: признак означал бы на
# разных концах выборки разное — та же беда, что была с возрастом монеты.
say("журнал перпов перестраивается один раз",
    "void migrateFlowRule()" in ai and "FLOW_RULE_KEY" in ai and
    "DELETE FROM ai_events WHERE venue=1" in ai)
say("спот при этом не трогается",
    "venue=0" not in body(ai, "void migrateFlowRule("))
say("перестройка идёт до заливки",
    ai.index("migrateFlowRule();") < ai.index("std::map<std::string, std::map<long long, DayAgg>> spot;"))

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

# --- часы переобучения ------------------------------------------------------
tick = body(oracle, "void oracleTick(")
say("часы переобучения переводятся только после проверки рядов",
    tick.index("if (!m || m->builtAt == 0) return;") < tick.index("lastTrain = now;"))

# --- формула не выдаёт себя за прогноз ---------------------------------------
# Уверенность формулы — эвристика 35–80, а не вероятность: «57% шанс роста»
# при попадании 31% читалось как провал оракула. Процент рисуется только у
# сигналов модели, а оракул судится только по своим сигналам.
rel = pybody(api, "def _reliability(")
say("надёжность считается только по сигналам модели",
    'only_model = " AND modelled=1"' in rel and "{only_model}" in rel)
hist_api = pybody(api, "def _signal_history(")
say("история делится на модель и формулу",
    "GROUP BY modelled" in hist_api and '"model": by_src.get("model")' in hist_api
    and '"formula": by_src.get("formula")' in hist_api)
say("вкладка не рисует процент формулы",
    'sig-conf sig-formula' in cortex and cortex.index("{s.model ? (") < cortex.index("{s.conf}%"))
say("экран сигнала без шкалы у формулы",
    '"ai_formula_note"' in sig and '"ai_formula_hint"' in sig)
say("история показывает источник", '"ai_src_title"' in histscr and "hist.formula" in histscr)
say("бот пишет процент только у модели",
    'if (ch.modelled) t << tr(lang, "ai_conf")' in ai and 'tr(lang, "ai_formula_note")' in ai)
say("пометка формулы есть в словарях бота",
    '"ai_formula_note"' in read(f"{BOT}/ru.cpp") and '"ai_formula_note"' in read(f"{BOT}/translations.cpp"))

# --- замки подписки стоят на сервере, а не только на экране -----------------
# Раньше сервер отдавал бесплатному все сто мест доски, перпы Hyperliquid,
# фандинг и позиции кошельков, а приложение их просто не рисовало — и то не
# везде: рейтинг перпов и позиции были видны. Бот всё это закрывает.
say("срез по подписке есть", "def for_plan(data: dict, prem: bool) -> dict:" in api)
fp = pybody(api, "def for_plan(")
say("срез: 30 мест спота, пустые перпы, без фандинга и позиций",
    "v[:RANK_FREE_DEPTH]" in fp and '"perp": {k: []' in fp and '"pos": []' in fp
    and 'out[k] = {}' in fp and '"trades"' in fp)
say("срез не трогает Cortex", "cortex" not in code_only(fp).lower() and "sonar" not in fp)
say("выгрузка срезается по своему же плану", "for_plan(boot, plan_of(boot))" in api)
say("выгрузка без подписи — как бесплатная", "}, False))" in api)
say("крупные сделки срезаются", "for_plan(big_trades(win, hours), chat_premium(self._user(qs)))" in api)
say("фандинг и сделки перпов — отказ без подписки",
    api.count('self._json(403, {"ok": False, "error": "premium"})') >= 2)
say("живой кошелёк срезается", "), is_premium(cur, chat)))" in api)
top = read(f"{APP}/src/screens/TopTab.tsx")
say("рейтинг перпов за замком", 'venue === "perp" && plan !== "premium"' in top and "<PremiumLock fromTab />" in top)
say("позиции за замком, а не «позиций нет»",
    "<PremiumLock />" in read(f"{APP}/src/screens/PositionScreen.tsx")
    and "<PremiumLock />" in read(f"{APP}/src/screens/WalletScreen.tsx"))
ana = read(f"{APP}/src/screens/AnalyticsTab.tsx")
say("лонг/шорт, крупные позиции и фандинг — за подпиской",
    ana.count("prem: true") == 3 and "lock: Boolean(v.prem) && !premium" in ana)
say("лонг/шорт закрыт и на экране, и на сервере",
    ana.count("{!premium ? locked : (") >= 2 and '"fund", "fundN", "ls"' in fp
    and api.count('self._json(403, {"ok": False, "error": "premium"})') == 3)
prem_scr = read(f"{APP}/src/screens/PremiumScreen.tsx")
say("цена на экране премиума — один раз, на кнопке",
    'title={t(lang, "pay_stars_btn")} value=' not in prem_scr and 'title={t(lang, "pay_usdt_btn")} value=' not in prem_scr)
say("оплата выше описания", prem_scr.index('className="stack-actions"') < prem_scr.index('"pr_includes"'))
say("Cortex назван бесплатным", '"pr_free_cortex_d"' in prem_scr)

# --- «Ещё» без второй дороги к позициям -------------------------------------
more = read(f"{APP}/src/screens/MoreTab.tsx")
say("открытые позиции — только в кошельке",
    'open("positions")' not in more and '"menu_positions"' not in read(f"{APP}/src/App.tsx")
    and not os.path.exists(f"{APP}/src/screens/PositionsScreen.tsx"))
say("состояние модели — из Cortex, а не из «Ещё»",
    'open("model")' not in more and 'open("model")' in cortex)
say("порог алертов — своим значком, без задвоенного эмодзи",
    "<ThresholdGlyph size={22} />" in more and 'bare(t(lang, "menu_alert_threshold"))' in more)
# --- при запуске подгружается всё ------------------------------------------
pre = read(f"{APP}/src/lib/prefetch.ts")
sync = read(f"{APP}/src/lib/sync.ts")
say("подгрузка запускается после выгрузки", "setTimeout(() => void prefetchAll(), 400);" in sync)
say("подгрузка берёт кошельки, окна, фильтры, сигналы, сделки, монеты",
    all(x in pre for x in ("fetchWallet(w.addr)", "BIG_WINS", 'fetchFlow(app.flowWin, "", 0, side)',
                           "fetchCandles(s.sym", "fetchTokenHist(s.addr", "fetchDeals(r.a, venue)", "holdJobs()")))
say("закрытое подпиской не запрашивается", "if (premium) {" in pre and "fetchLs(" in pre.split("if (premium) {")[1][:200])
say("запросы в очереди, не лавиной", "const PARALLEL = 4;" in pre)
apits = read(f"{APP}/src/lib/api.ts")
say("чтения идут через память", apits.count("cachedGet<") >= 7 and "remember<T | null>(path, ttl" in apits)
say("смена плана стирает память", "forgetAll()" in live)

# --- кнопка обновления не выпадает из шапки ---------------------------------
# Голое состояние «boot» совпадало с классом заставки .boot (position: fixed),
# и до первой выгрузки кнопка уезжала в левый верхний угол поверх меню.
appx = read(f"{APP}/src/App.tsx")
say("состояние кнопки обновления — с приставкой", "refresh st-${status}" in appx and "refresh ${status}" not in appx)

# --- сервисный аккаунт бота — подписка навсегда и в API ---------------------
# Бот считает его премиумом без срока и без лимита кошельков (isPremium в
# premium.cpp). API этого не знал, и приложение ставило его кошельки на паузу.
main_cpp = read(f"{BOT}/main.cpp")
svc = re.search(r'SERVICE_CHAT_ID = "(\d+)"', main_cpp)
say("номер сервисного аккаунта в API совпадает с ботом",
    bool(svc) and f'"WHALE_SERVICE_CHAT", "{svc.group(1)}"' in api)
say("сервисный — премиум и без лимита",
    "if is_service(chat):\n        return True" in api and "return SERVICE_MAX_WALLETS" in api
    and '"service": service,' in api)
say("приложение не ставит сервисному паузу и лимит",
    "walletLimit(me.plan, me.service)" in read(f"{APP}/src/screens/WalletsTab.tsx")
    and "if (service) return Infinity;" in read(f"{APP}/src/store/app.ts"))

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
    more.index('open("alerts")') < more.index('open("premium")'))

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
say("в боковом меню два пункта: график, затем разлоки",
    menu.count("name:") == 2 and menu.index('name: "chart"') < menu.index('name: "unlocks"'))
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
    "UNLOCK_BOOK: list[dict] = [" in api and api.count('"src": "https://') >= 39)
say("оценочные объёмы помечены в приложении", '"est": bool(coin.get("est"))' in api and "unl_est" in unl_scr)
_ub = pybody(api, "def unlock_events(")
say("прошедшие разлоки не отдаются, ближайшие первыми",
    "if ts >= day0:" in _ub and 'sorted(out, key=lambda e: (e["ts"], e["sym"]))' in _ub
    and "events = unlock_events(now)" in pybody(api, "def _unlocks_build(")
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
            if not os.path.exists(f"{APP}/html/coins/hl/{c}.svg") and f'"{c}": "/' not in _logos and f"  {c}: \"/" not in _logos]
say("у каждой монеты календаря разлоков есть иконка", not _no_icon, str(_no_icon))
# Опорный оборот со временем уходит: стейкинг, сжигание, выдачи вне книги.
# Старше четырёх месяцев — пора сверить и обновить строку «circ».
import datetime as _dt
_stale = [f"{c}:{d}" for c, d in re.findall(r'\{"s": "([A-Z0-9]+)", "n": [^\n]*\n(?:[^\n]*\n)*?\s+"circ": \("(\d{4}-\d{2}-\d{2})"', api)
          if (_dt.date.today() - _dt.date.fromisoformat(d)).days > 120]
say("опорный оборот монет разлоков не старше 120 дней", not _stale, str(_stale))
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

print("ПРОВАЛОВ:", bad)
sys.exit(1 if bad else 0)
