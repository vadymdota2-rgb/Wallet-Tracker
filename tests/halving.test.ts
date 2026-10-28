/* Отсчёт до халвинга: npm test (node --test, типы Node снимает сам). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STALE_AFTER, STALE_MAX, clockSkew, clockSpeech, halvingAge, halvingView, pickHalving, subsidySats, unitLabel, validHalving,
  type HalvingReply, type HalvingSource,
} from "../src/lib/halving.ts";

/** Копия ответа без перечисленных полей — «поля нет», а не «поле = undefined». */
function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const c = { ...o };
  for (const k of keys) delete c[k];
  return c;
}

// Настоящий ответ сервера от 13.10.2026.
const REAL = {
  ok: true, height: 971219, next: 1050000, every: 210000, avg: 596.8, src: "epoch" as const,
  tip: 1791881177, eta: 1838896423, at: 1791881255,
} satisfies HalvingReply;

test("validHalving: настоящий ответ годится", () => {
  assert.equal(validHalving(REAL), true);
});

test("validHalving: мусор не годится", () => {
  const bad: unknown[] = [
    null, undefined, "x", 42, {}, { ...REAL, ok: false }, { ...REAL, height: 0 }, { ...REAL, height: 971219.5 },
    { ...REAL, next: 1049999 }, { ...omit(REAL, "eta"), height: 1050000 }, { ...REAL, height: 839999 }, { ...REAL, every: 0 },
    { ...REAL, avg: 0 }, { ...REAL, avg: Number.NaN }, { ...REAL, avg: 5000 }, { ...REAL, at: 0 },
    // Высота, которой не может быть: больше, чем при блоке раз в 5 минут с 2009 года.
    { ...REAL, height: 99_000_000, next: 99_120_000 },
  ];
  for (const b of bad) assert.equal(validHalving(b), false, JSON.stringify(b));
});

test("clockSkew: мелочь не трогаем, большие расхождения учитываем", () => {
  assert.equal(clockSkew(1000, 990), 0);
  assert.equal(clockSkew(1000, 1060), 0);
  assert.equal(clockSkew(10_000, 6_400), 3600);
  assert.equal(clockSkew(1000, 1200), -200);
  assert.equal(clockSkew(undefined, 1000), 0);
  assert.equal(clockSkew(Number.NaN, 1000), 0);
});

test("subsidySats: как в консенсусе биткоина", () => {
  assert.equal(subsidySats(0), 5_000_000_000);
  assert.equal(subsidySats(3), 625_000_000);
  assert.equal(subsidySats(4), 312_500_000);
  assert.equal(subsidySats(5), 156_250_000);
  assert.equal(subsidySats(32), 1);
  assert.equal(subsidySats(33), 0);
  assert.equal(subsidySats(64), 0);
});

test("halvingView: через минуту после ответа", () => {
  const now = REAL.tip + 60;
  const v = halvingView(REAL, now);
  assert.equal(v.left, REAL.eta - now);
  const [d, h, m, s] = v.parts;
  assert.equal(d * 86400 + h * 3600 + m * 60 + s, v.left);
  assert.ok(h < 24 && m < 60 && s < 60);
  assert.equal(v.height, REAL.height);
  assert.ok(Math.abs(v.done - 62.485) < 0.001);
  assert.equal(v.reward, 312_500_000);
  assert.equal(v.rewardNext, 156_250_000);
  assert.equal(v.eta, REAL.eta);
});

test("halvingView: высота растёт по среднему, но не доходит до халвинга раньше времени", () => {
  assert.equal(halvingView(REAL, REAL.tip + Math.ceil(10 * REAL.avg)).height, REAL.height + 10);
  // Оценка скорости ошиблась: по среднему блоков «вышло» больше, чем осталось.
  const off = { ...REAL, eta: REAL.tip + 10 * 365 * 86400 };
  assert.equal(halvingView(off, REAL.tip + 9 * 365 * 86400).height, REAL.next - 1);
});

test("halvingView: оценка момента прошла — ноль, но блок халвинга не выдумывается", () => {
  // Сервер ещё не видел блок халвинга (блоки шли медленнее среднего):
  // отсчёт — ноль, а номер блока и процент — без «1 050 000» и «100 %».
  const v = halvingView(REAL, REAL.eta + 5);
  assert.equal(v.left, 0);
  assert.deepEqual(v.parts, [0, 0, 0, 0]);
  assert.ok(v.height < REAL.next && v.height >= REAL.next - 5, String(v.height));
  assert.equal(v.donePct, 99.9);
  assert.ok(v.done > 99.99 && v.done < 100);
  // Ждём сервер хоть год — выдуманного блока халвинга так и нет.
  assert.equal(halvingView(REAL, REAL.eta + 365 * 86400).height, REAL.next - 1);
});

test("halvingView: часы телефона раньше времени ответа — полоса не уходит назад", () => {
  const v = halvingView(REAL, REAL.tip - 3600);
  assert.equal(v.height, REAL.height);
  assert.ok(v.done >= 0 && v.done <= 100);
});

test("halvingView: старый ответ без eta и tip считается от at", () => {
  const old = { ok: true, height: 971219, next: 1050000, every: 210000, avg: 600, at: 1791881255 };
  const v = halvingView(old, old.at);
  assert.equal(v.left, (old.next - old.height) * 600);
});

test("halvingView: первая эпоха и следующие — награда по эпохе", () => {
  const e0 = { ...omit(REAL, "tip", "eta"), height: 100, next: 210000 };
  assert.equal(halvingView(e0, REAL.at).reward, 5_000_000_000);
  const e5 = { ...omit(REAL, "tip", "eta"), height: 1050001, next: 1260000 };
  const v = halvingView(e5, REAL.at);
  assert.equal(v.reward, 156_250_000);
  assert.equal(v.rewardNext, 78_125_000);
});

test("halvingView: подпись процента не показывает 100 % до халвинга", () => {
  // До халвинга 10 блоков из 210 000: 99,995 %.
  const near = { ...REAL, height: REAL.next - 10, tip: REAL.at, eta: REAL.at + 6000 };
  const v = halvingView(near, REAL.at);
  assert.ok(v.done > 99.99);
  assert.equal(v.donePct, 99.9);
  assert.equal(halvingView(REAL, REAL.eta + 1).donePct, 99.9);
  // Обычное округление в остальном: 62,485 → 62,5, а не 62,4.
  assert.equal(halvingView(REAL, REAL.tip + 60).donePct, 62.5);
});

test("validHalving: повреждённые необязательные поля — ответ отбрасывается", () => {
  // Каждый из них раньше проходил проверку и ронял отрисовку или отсчёт.
  const bad: Record<string, unknown>[] = [
    { eta: "abc" }, { eta: 1e30 }, { eta: Number.NaN }, { tip: "x" }, { now: -1 }, { prev: true },
    { skew: "5" }, { skew: Number.POSITIVE_INFINITY }, { skew: 400 * 86400 }, { src: "magic" },
  ];
  for (const b of bad) assert.equal(validHalving({ ...REAL, ...b }), false, JSON.stringify(b));
  // А пустые — нормально: старый формат ответа.
  assert.equal(validHalving({ ...REAL, eta: undefined, tip: null, skew: 0, prev: 1713571767 }), true);
});

test("halvingView: две недели после халвинга карточка говорит, что он состоялся", () => {
  const after = { ...omit(REAL, "eta"), height: 1050100, next: 1260000, prev: 1838900000, tip: 1838900000 + 100 * 600 };
  assert.equal(halvingView(after, after.prev + 3 * 86400).justHappened, after.prev);
  assert.equal(halvingView(after, after.prev + 15 * 86400).justHappened, null);
  assert.equal(halvingView(REAL, REAL.at).justHappened, null);
});

test("договор с сервером: образец ответа (tests/fixtures/halving.json) приложение принимает целиком", () => {
  // Тот же файл сверяет и тест сервера: поменяли формат с одной стороны —
  // упадёт тест с другой, а не карточка у людей.
  const fx = JSON.parse(readFileSync(new URL("./fixtures/halving.json", import.meta.url), "utf8"));
  assert.equal(validHalving(fx), true);
  const v = halvingView(fx, fx.now);
  assert.equal(v.left, fx.eta - fx.now);
  assert.equal(v.reward, 312_500_000);
});

test("validHalving: пограничные высоты (найдены мутационной проверкой)", () => {
  // Нулевая высота — не ответ сети биткоина.
  assert.equal(validHalving({ ...omit(REAL, "eta", "tip"), height: 0, next: 210000 }), false);
  // 2 млн — больше, чем при блоке раз в 5 минут с 2009 года (~1,87 млн), но
  // меньше, чем при блоке раз в 30 секунд: граница проверяется точно.
  assert.equal(validHalving({ ...omit(REAL, "eta"), height: 2_000_000, next: 2_100_000 }), false);
  assert.equal(validHalving({ ...omit(REAL, "eta"), height: 1_800_000, next: 1_890_000 }), true);
});

test("halvingView: остаток — целые секунды вниз, даже при дробной оценке", () => {
  // Старый ответ без eta: eta = at + блоки × 596,8 — дробное.
  const old = { ok: true, height: 971219, next: 1050000, every: 210000, avg: 596.8, at: 1791881255 };
  const eta = old.at + (old.next - old.height) * old.avg;
  assert.notEqual(eta % 1, 0);
  assert.equal(halvingView(old, old.at).left, Math.floor(eta - old.at));
});

test("halvingView: «состоялся» не показывается для prev из будущего", () => {
  const h = { ...REAL, prev: REAL.at + 3600 };
  assert.equal(halvingView(h, REAL.at).justHappened, null);
});

test("подписи под числами — в правильной форме слова для языка", () => {
  // Раньше подпись была одна на все числа: «1 days», «1 dni», «03 ساعة».
  assert.equal(unitLabel("en", "day", 1), "day");
  assert.equal(unitLabel("en", "day", 2), "days");
  assert.equal(unitLabel("pl", "day", 1), "dzień");
  assert.equal(unitLabel("pl", "day", 544), "dni");
  assert.equal(unitLabel("ar", "day", 2), "يومان");
  assert.equal(unitLabel("ar", "day", 544), "يومًا");
  assert.equal(unitLabel("pt", "day", 1), "dia");
  assert.equal(unitLabel("ru", "minute", 45), "мин");
});

test("подпись есть в каждом из 16 языков для любого числа", () => {
  const langs = ["ru", "uk", "en", "de", "es", "fr", "pt", "pl", "tr", "id", "vi", "hi", "ar", "ja", "ko", "zh"];
  for (const lang of langs) {
    for (const unit of ["day", "hour", "minute", "second"] as const) {
      for (let n = 0; n <= 1500; n += unit === "day" ? 1 : 7) {
        const l = unitLabel(lang, unit, n);
        assert.ok(l && !/\d/.test(l), `${lang} ${unit} ${n}: «${l}»`);
      }
    }
  }
});

test("отсчёт для читалки — словами целиком и по-русски грамотно", () => {
  assert.equal(clockSpeech("ru", [544, 3, 45, 23]), "544 дня 3 часа 45 минут 23 секунды");
  assert.equal(clockSpeech("ru", [1, 1, 1, 1]), "1 день 1 час 1 минута 1 секунда");
  assert.equal(clockSpeech("en", [1, 2, 0, 1]), "1 day, 2 hours, 0 minutes, 1 second");
  assert.equal(clockSpeech("ru", [1, 2]), "1 день 2 часа");
});

test("неизвестный язык — запасной путь, а не падение", () => {
  assert.equal(unitLabel("xx-invalid-!!", "day", 1), null);
  assert.equal(clockSpeech("xx-invalid-!!", [1, 2, 3, 4]), null);
});

test("старый WebView без Intl.ListFormat и formatToParts — запасной путь", () => {
  // iOS до 14.5 не знает Intl.ListFormat; ещё более старые — formatToParts.
  const intl = Intl as unknown as Record<string, unknown>;
  const list = intl["ListFormat"];
  const proto = Intl.NumberFormat.prototype as unknown as Record<string, unknown>;
  const parts = proto["formatToParts"];
  try {
    delete intl["ListFormat"];
    // Язык, для которого формат списка ещё не создан (он кэшируется по языку).
    assert.equal(clockSpeech("uk", [544, 3, 45, 23]), null);
    delete proto["formatToParts"];
    assert.equal(unitLabel("ru", "day", 544), null);
  } finally {
    intl["ListFormat"] = list;
    proto["formatToParts"] = parts;
  }
  // Intl вернул число без единицы — тоже запасной путь, а не пустая подпись.
  try {
    proto["formatToParts"] = () => [{ type: "integer", value: "544" }];
    assert.equal(unitLabel("ru", "day", 544), null);
  } finally {
    proto["formatToParts"] = parts;
  }
  assert.equal(unitLabel("ru", "day", 544), "дн.");
});

test("атака через ответ: строки, скрипты, __proto__ и лишние поля не проходят", () => {
  const evil: unknown[] = [
    { ...REAL, height: "971219" }, { ...REAL, eta: "<img src=x onerror=alert(1)>" },
    { ...REAL, src: "<script>alert(1)</script>" }, { ...REAL, avg: Infinity }, { ...REAL, skew: 1e308 },
    { ...REAL, at: [1791881255] }, { ...REAL, ok: "true" }, JSON.parse('{"__proto__":{"ok":true}}'),
  ];
  for (const e of evil) assert.equal(validHalving(e), false, JSON.stringify(e));
  // Годный ответ с мусором сверху: остаются только известные поля, прототип не тронут.
  const raw = JSON.parse(JSON.stringify(REAL).replace("{", '{"__proto__":{"polluted":1},"junk":"xxxxxxxxx",'));
  assert.equal(validHalving(raw), true);
  const kept = pickHalving(raw);
  assert.deepEqual(kept, REAL);
  assert.equal(Object.getPrototypeOf(kept), Object.prototype);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.deepEqual(pickHalving({ ...REAL, prev: null as unknown as number }), REAL);
});

test("validHalving: поля сходятся между собой, как их считает сервер", () => {
  // Интервал халвинга — правило сети, а не настройка.
  assert.equal(validHalving({ ...REAL, every: 105000 }), false);
  // Последний блок — не старше суток и не дальше 2 часов вперёд от at.
  const noEta = omit(REAL, "eta");
  assert.equal(validHalving({ ...noEta, tip: REAL.at - 86_400 }), false);
  assert.equal(validHalving({ ...noEta, tip: REAL.at - 86_399 }), true);
  assert.equal(validHalving({ ...noEta, tip: REAL.at + 7200 }), true);
  assert.equal(validHalving({ ...noEta, tip: REAL.at + 7201 }), false);
  // eta — от последнего блока по среднему, запас — сутки:
  // tip + 78 781 × 596,8 = 1 838 897 677,8.
  assert.equal(validHalving({ ...REAL, eta: 1_838_984_077 }), true);
  assert.equal(validHalving({ ...REAL, eta: 1_838_984_079 }), false);
  assert.equal(validHalving({ ...REAL, eta: 1_838_811_279 }), true);
  assert.equal(validHalving({ ...REAL, eta: 1_838_811_276 }), false);
  // Отсчёт на 70 лет при высоте 2026 года — подделка.
  assert.equal(validHalving({ ...REAL, eta: 3_999_999_999 }), false);
  // Без tip (старый ответ) сверять не с чем — eta принимается.
  assert.equal(validHalving({ ...omit(REAL, "tip"), eta: 3_999_999_999 }), true);
});

test("свежесть ответа: до 3 часов — как есть, до суток — с пометкой, старше — не показываем", () => {
  assert.equal(STALE_AFTER, 3 * 3600);
  assert.equal(STALE_MAX, 86_400);
  const at = REAL.at;
  assert.equal(halvingAge(REAL, at), "fresh");
  assert.equal(halvingAge(REAL, at + STALE_AFTER), "fresh");
  assert.equal(halvingAge(REAL, at + STALE_AFTER + 1), "old");
  assert.equal(halvingAge(REAL, at + STALE_MAX), "old");
  assert.equal(halvingAge(REAL, at + STALE_MAX + 1), "gone");
  // Часы сервера чуть позади ответа — свежий, а не «из будущего» с ошибкой.
  assert.equal(halvingAge(REAL, at - 120), "fresh");
});

test("источник данных: только известные адреса — из него в карточке строка «Данные: …»", () => {
  for (const by of ["mempool.space", "blockstream.info", "blockchain.info"]) {
    assert.equal(validHalving({ ...REAL, by }), true, by);
    assert.equal(pickHalving({ ...REAL, by: by as HalvingSource }).by, by);
  }
  for (const by of ["evil.com", "mempool.space.evil.com", "javascript:alert(1)", "", 42, ["mempool.space"]]) {
    assert.equal(validHalving({ ...REAL, by }), false, String(by));
  }
  // Старый ответ без поля — годится, просто без подписи.
  assert.equal(validHalving(REAL), true);
});
