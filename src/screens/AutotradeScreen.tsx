/**
 * «Автоторговля» — закрытая вкладка владельца: автокопирование китов
 * Hyperliquid на фьючерсах OKX (крипта, акции, металлы).
 *
 * Видит её только владелец: пункт меню показывается по `me.owner`, а данные
 * сервер отдаёт лишь по подписи Telegram владельца — остальным 404, как у
 * несуществующего адреса (wt_autotrade.py, whale_api.py). Тексты — по-русски
 * и в словарь не вынесены: это служебный экран одного человека.
 *
 * Сверху — реальная торговля (служба whale-autotrade), ниже — бэктест-повтор
 * последних 30 дней по тем же правилам (ночью и по кнопке).
 */
import { useEffect, useState } from "react";
import { Frame } from "./Screen";
import { Action, Card, Empty, Row, SectionTitle, Skeleton } from "../components/ui";
import { TrendChart } from "../components/Chart";
import { autotradeRun, autotradeStart, autotradeStop, fetchAutotrade } from "../lib/api";
import { shortInst, skipsLine } from "../lib/autotrade";
import { pct, usd } from "../lib/format";
import { toast } from "../components/Toast";
import type { AtGroup, AtLive, AtStats, AtSummary, AutotradeReply } from "../lib/types";

const when = (ms: number) =>
  ms > 0 ? new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

const pf = (v: number | null) => (v === null ? "∞" : v.toFixed(2));

function StatsRows({ s }: { s: AtStats }) {
  return (
    <>
      <Row title="Итог" value={usd(s.net, true)} tone={s.net >= 0 ? "up" : "dn"}
           valueSub={`${s.trades} сделок`} />
      <Row title="Прибыльных" value={pct(s.win_pct, 1, false)}
           valueSub={`ср. ${usd(s.avg_win, true)} / ${usd(s.avg_loss, true)}`} />
      <Row title="Profit factor" value={pf(s.pf)} />
      <Row title="Макс. просадка" value={usd(-s.max_dd)} tone="dn"
           valueSub={`худшая серия: ${s.worst_streak} (${usd(s.worst_streak_usd, true)})`} />
      <Row title="Открытые на конец" wrap
           sub={`дольше всех — ${Math.round(s.longest_h)} ч; провал внутри сделки — до ${usd(-s.max_mae)}`}
           value={s.open ? `открыто ${s.open}` : "все закрыты"} {...(s.open ? { tone: "dn" as const } : {})}
           valueSub={s.open ? usd(s.unrealized, true) : ""} />
    </>
  );
}

function Groups({ title, rows, label }: { title: string; rows: AtGroup[]; label?: (k: string) => string }) {
  if (!rows.length) return null;
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <Card pad={false}>
        {rows.map((g) => (
          <Row key={g.key} title={label ? label(g.key) : g.key} sub={`${g.trades} сделок · ${pct(g.win_pct, 0, false)} в плюс`}
               value={usd(g.net, true)} tone={g.net >= 0 ? "up" : "dn"} valueSub={`PF ${pf(g.pf)}`} />
        ))}
      </Card>
    </>
  );
}

const price = (v: number) => (v >= 1000 ? v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })
  : v.toPrecision(5).replace(/\.?0+$/, ""));

/** Общая статистика повтора — на что смотреть в первую очередь. */
function Overview({ s }: { s: AtSummary }) {
  const f = s.full;
  const dep = s.sizing.deposit || 1;
  const share = (v: number) => `${v >= 0 ? "+" : ""}${((v / dep) * 100).toFixed(1)}% капитала`;
  return (
    <>
      <SectionTitle>Бэктест: общая статистика</SectionTitle>
      <Card pad={false}>
        <Row title="Итог" value={usd(f.net, true)} tone={f.net >= 0 ? "up" : "dn"} valueSub={share(f.net)}
             sub={`${when(s.period.from)} — ${when(s.period.to)} · капитал ${usd(s.sizing.deposit)} → ${usd(s.sizing.deposit_end)}`} />
        <Row title="Винрейт" value={pct(f.win_pct, 1, false)} sub={`${f.trades} сделок · ${s.per_day} в день`}
             tone={f.win_pct >= 50 ? "up" : "dn"} />
        <Row title="Средняя сделка" value={usd(f.trades ? f.net / f.trades : 0, true)}
             sub={`прибыль ${usd(f.avg_win, true)} · убыток ${usd(f.avg_loss, true)}`} />
        <Row title="Profit factor" value={pf(f.pf)} tone={f.pf === null || f.pf >= 1.3 ? "up" : "dn"}
             sub="сумма прибылей / сумма убытков" />
        <Row title="Макс. просадка" value={usd(-f.max_dd)} tone="dn" valueSub={share(-f.max_dd)}
             sub="с провалами внутри сделок" />
        <Row title="Худшая серия" value={`${f.worst_streak} подряд`} {...(f.worst_streak ? { tone: "dn" as const } : {})}
             valueSub={usd(f.worst_streak_usd, true)} />
        <Row title="Самая долгая сделка" value={`${Math.round(f.longest_h)} ч`}
             sub={`провал внутри сделки — до ${usd(-f.max_mae)}`} />
      </Card>
    </>
  );
}

/** «1 сделка», «3 сделки», «5 сделок». */
const deals = (n: number) => {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? "сделка" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "сделки" : "сделок"}`;
};

const EXIT_ORDER = ["тейк", "стоп", "кит вышел в убыток", "открыта"];
const EXIT_LABEL: Record<string, string> = {
  "тейк": "Тейк", "стоп": "Стоп", "кит вышел в убыток": "Вслед за китом", "открыта": "Открыта на конец данных",
};

/** Варианты правил на тех же китах (ночной бэктест): что дало бы одно изменение. */
function Variants({ s }: { s: AtSummary }) {
  const v = s.variants ?? [];
  const base = v[0];
  if (!base || v.length < 2) return null;
  const best = v.reduce((a, x) => (x.net > a.net ? x : a), base);
  return (
    <>
      <SectionTitle>Бэктест: варианты правил</SectionTitle>
      <Card pad={false}>
        {v.map((x, i) => (
          <Row key={x.name} title={i === 0 ? `${x.name} (сейчас)` : x.name}
               sub={`${deals(x.trades)} · в плюс ${pct(x.win_pct, 1, false)} · PF ${x.pf ?? "—"} · просадка ${usd(x.max_dd)}`
                 + `${x.open ? ` · открыто ${x.open}` : ""}`}
               value={usd(x.net, true)} tone={x.net >= 0 ? "up" : "dn"}
               valueSub={i === 0 ? "" : `${usd(x.net - base.net, true)} к текущим`} />
        ))}
        <Row wrap title={best === base ? "Текущие правила — лучший вариант" : `Лучше текущих — «${best.name}»`}
             sub="Те же сделки китов за тот же период, в каждом варианте изменено одно правило. Правила бота меняются только вручную." />
      </Card>
    </>
  );
}

/** Откуда плюс и минус: итог по причине выхода и винрейт, нужный для нуля. */
function Exits({ s }: { s: AtSummary }) {
  const f = s.full;
  if (!f.trades) return null;
  const rank = (k: string) => (EXIT_ORDER.includes(k) ? EXIT_ORDER.indexOf(k) : EXIT_ORDER.length);
  const rows = [...s.by_exit].sort((a, b) => rank(a.key) - rank(b.key));
  const lost = rows.reduce((acc, g) => acc + Math.min(0, g.net), 0);
  // Винрейт безубытка: W × средняя прибыль = (1 − W) × средний убыток.
  const need = f.avg_win > 0 && f.avg_loss < 0 ? (-f.avg_loss / (f.avg_win - f.avg_loss)) * 100 : null;
  return (
    <>
      <SectionTitle>Бэктест: откуда плюс и минус</SectionTitle>
      <Card pad={false}>
        {rows.map((g) => (
          <Row key={g.key} title={EXIT_LABEL[g.key] ?? g.key}
               sub={`${deals(g.trades)} (${pct((g.trades / f.trades) * 100, 0, false)}) · в среднем ${usd(g.net / g.trades, true)}`}
               value={usd(g.net, true)} tone={g.net >= 0 ? "up" : "dn"}
               valueSub={g.net < 0 && lost < 0 ? `${pct((g.net / lost) * 100, 0, false)} всех минусов` : ""} />
        ))}
        {need !== null ? (
          <Row title="Винрейт для нуля" value={pct(need, 1, false)} tone={f.win_pct >= need ? "up" : "dn"}
               sub={`сейчас ${pct(f.win_pct, 1, false)}: прибыль ${usd(f.avg_win, true)} против убытка ${usd(f.avg_loss, true)}`} />
        ) : null}
      </Card>
    </>
  );
}

/** Открытая позиция модели: не дошла до выхода к концу данных. Это бэктест —
 *  реальных денег здесь нет; настоящая позиция — в «Реальной торговле на OKX». */
function Active({ s }: { s: AtSummary }) {
  return (
    <>
      <SectionTitle>Бэктест: открытая позиция модели</SectionTitle>
      <Card pad={false}>
        {s.active.length ? s.active.map((a, i) => (
          <Row key={i} wrap
               title={`${a.coin} · ${a.side > 0 ? "лонг" : "шорт"}`}
               sub={`вход ${when(a.entry)} по ${price(a.px_in)} · сейчас ${price(a.px_out)} · тейк ${price(a.tp)}`
                 + `${a.to_tp_pct !== null ? ` (ещё ${a.to_tp_pct.toFixed(2)}%)` : ""} · держим ${Math.round(a.held_h)} ч`
                 + ` · провал до ${usd(-a.mae)}`}
               value={usd(a.usd, true)} tone={a.usd >= 0 ? "up" : "dn"} valueSub={pct(a.pct, 2)} />
        )) : <Row title="Открытых позиций нет" sub="Ждём сигнала: от 2 китов в одну сторону за 2 часа" wrap />}
      </Card>
    </>
  );
}

/** Реальная торговля на OKX: счёт, открытая позиция, статистика, сделки. */
function Live({ l, on }: { l: AtLive; on: boolean }) {
  const s = l.stats;
  const op = l.open;
  const manual = l.positions.filter((p) => !op || p.instId !== op.inst);
  return (
    <>
      <SectionTitle>{l.simulated ? "Торговля на OKX — демо-счёт" : "Реальная торговля на OKX"}</SectionTitle>
      <Card pad={false}>
        <Row title="Бот" wrap
             value={!l.alive ? "не отвечает" : on ? "торгует" : "остановлен"}
             tone={l.alive && on ? "up" : "dn"}
             sub={l.alive ? `на связи ${when(l.heartbeat)}${on ? "" : " · «Старт» — чтобы входил в сделки"}`
               : `последний сигнал жизни ${when(l.heartbeat)} — служба whale-autotrade не работает`} />
        {l.error ? <Row title="Ошибка" sub={l.error} tone="dn" wrap /> : null}
        {l.key_problem ? (
          <Row title="OKX не принимает ордера бота" tone="dn" wrap
               sub={`${l.key_problem}. Сигналы есть — дело в правах ключа; бумаги не исключаются, бот проверяет снова раз в 30 минут.`} />
        ) : null}
        <Row title="Капитал счёта" value={l.equity != null ? usd(l.equity) : "—"}
             sub={`маржа на сделку всегда 5 % × 10× — позиция ${l.equity != null ? usd(l.equity / 2) : "—"}; `
               + "стоп — 0,5 % за уровнем входа (лонг — ниже поддержки, шорт — выше сопротивления), "
               + "но не дальше 1,5 % от входа; усреднения нет"} />
      </Card>

      <SectionTitle>Открытая позиция</SectionTitle>
      <Card pad={false}>
        {op ? (
          <Row wrap title={`${shortInst(op.inst)} · ${op.side > 0 ? "лонг" : "шорт"}`}
               sub={`вход ${when(op.opened)} по ${price(op.px)} · сейчас ${op.mark ? price(op.mark) : "—"} · тейк ${price(op.tp)}`
                 + `${op.mark ? ` (ещё ${(op.side * (op.tp / op.mark - 1) * 100).toFixed(2)}%)` : ""} · ${usd(op.notional)}`
                 + `${op.whales ? ` · китов ${op.whales}` : ""}`
                 + `${op.usd !== undefined ? ` (${usd(op.usd)}${op.usd_against ? `, против ${usd(op.usd_against)}` : ", против никого"})` : ""}`
                 + `${op.margin_pct ? ` · маржа ${op.margin_pct}%` : ""}`
                 + `${op.priority ? ` · приоритетный кит ${op.priority.slice(0, 10)}…` : ""}`}
               value={op.upl !== undefined ? usd(op.upl, true) : "—"} tone={(op.upl ?? 0) >= 0 ? "up" : "dn"} />
        ) : <Row title="Позиции бота нет" sub="Ждём: от 2 китов в одну сторону за 2 часа; лонг — ниже 40 % диапазона 4ч × 24 и выше MA30 15м, шорт — выше 60 % и ниже MA30; приоритетный кит (наш винрейт > 90 %) — и один" wrap />}
        {op ? (
          <Row title={op.exit_why ? "Закрываем по рынку" : "Выход"} wrap {...(op.exit_why ? { tone: "dn" as const } : {})}
               sub={op.exit_why ? `${op.exit_why} — бот снял тейк и закрывает позицию рыночным ордером`
                 : `тейк +1 % — или по рынку: стоп${op.stop ? ` ${price(op.stop)}` : " (в записи позиции его нет)"} или кто-то из китов сигнала закроет свою сделку в убытке`} />
        ) : null}
        {manual.map((p) => (
          <Row key={p.instId} wrap title={`${shortInst(p.instId)} · не бота`}
               sub="Открыта вами — бот на эту бумагу не входит; размер его входа это не меняет (5 %)"
               value={p.upl ? usd(Number(p.upl), true) : ""} />
        ))}
        {l.blocked?.length ? (
          <Row title="OKX не даёт торговать" wrap
               sub={`${l.blocked.map(shortInst).join(", ")} — исключены на 7 дней; бот берёт другие сигналы`} />
        ) : null}
        {l.skips_24h && Object.keys(l.skips_24h).length ? (
          <Row title="Пропуски сигналов за сутки" wrap sub={skipsLine(l.skips_24h)} />
        ) : null}
        {l.last_skip ? (
          <Row title="Последний пропуск" wrap
               sub={`${l.last_skip.coin} ${l.last_skip.side > 0 ? "лонг" : "шорт"} · ${when(l.last_skip.at)} — ${l.last_skip.why}`} />
        ) : null}
      </Card>

      <SectionTitle>Статистика реальной торговли</SectionTitle>
      <Card pad={false}>
        <Row title="Итог" value={usd(s.net, true)} tone={s.net >= 0 ? "up" : "dn"}
             sub={`${s.trades} сделок · ${s.per_day} в день`} valueSub={`комиссии ${usd(s.fees, true)} · фандинг ${usd(s.funding, true)}`} />
        <Row title="Винрейт" value={pct(s.win_pct, 1, false)} tone={s.win_pct >= 50 ? "up" : "dn"}
             sub={`прибыль ${usd(s.avg_win, true)} · убыток ${usd(s.avg_loss, true)}`} />
        <Row title="Profit factor" value={pf(s.pf)} />
        <Row title="Макс. просадка" value={usd(-s.max_dd)} tone="dn" sub="по закрытым сделкам" />
      </Card>
      {l.equity_curve.length > 1 ? (
        <Card><TrendChart values={l.equity_curve.map((p) => p[1])} /></Card>
      ) : null}

      {l.trades.length ? (
        <>
          <SectionTitle>Сделки бота</SectionTitle>
          <Card pad={false}>
            {[...l.trades].reverse().slice(0, 30).map((t, i) => (
              <Row key={i} wrap title={`${shortInst(t.inst)} · ${t.side > 0 ? "лонг" : "шорт"}`}
                   sub={`${when(t.opened)} по ${price(t.px_in)} → ${when(t.closed)}${t.px_out ? ` по ${price(t.px_out)}` : ""} · ${t.why}`}
                   value={usd(t.pnl, true)} tone={t.pnl >= 0 ? "up" : "dn"} />
            ))}
          </Card>
        </>
      ) : null}

      {l.events.length ? (
        <>
          <SectionTitle>Журнал бота</SectionTitle>
          <Card pad={false}>
            {[...l.events].reverse().slice(0, 10).map((e, i) => <Row key={i} title={e} wrap />)}
          </Card>
        </>
      ) : null}
    </>
  );
}

/** Вкладка: кнопки «Старт»/«Стоп» и пересчёт, реальная торговля, бэктест. */
export function AutotradeScreen() {
  const [st, setSt] = useState<AutotradeReply | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void fetchAutotrade().then((r) => {
      if (!alive) return;
      if (r?.ok) setSt(r);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [tick]);

  // Пока сервер считает — заглядывать раз в минуту.
  useEffect(() => {
    if (!st?.running) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [st?.running]);

  const [busy, setBusy] = useState(false);
  const flip = (on: boolean) => {
    setBusy(true);
    void (on ? autotradeStart() : autotradeStop()).then((r) => {
      setBusy(false);
      if (!r?.ok) {
        const why = (r as { error?: string } | null)?.error;
        toast(why === "no_write" ? "Сервер не может сохранить выбор: нет записи в каталог модуля" : "Нет связи с сервером", "err");
        return;
      }
      setSt(r);
      toast(on ? "Включено" : "Остановлено");
    });
  };

  const run = () => {
    void autotradeRun().then((r) => {
      if (!r?.ok) {
        toast(st?.on === false ? "Модуль остановлен — сначала «Старт»" : "Не вышло запустить", "err");
        return;
      }
      toast(r.started ? "Пересчёт запущен — обычно 5–30 минут, ход — в строке «Пересчёт»" : "Уже считается");
      setTick((n) => n + 1);
    });
  };

  if (failed) return <Frame title="Автоторговля"><Empty text="Нет доступа или нет связи с сервером" /></Frame>;
  if (!st) return <Frame title="Автоторговля"><Skeleton rows={6} /></Frame>;

  const b = st.backtest;
  return (
    <Frame title="Автоторговля" sub="Копирование китов · фьючерсы Hyperliquid">
      <Card>
        <Row title="Модуль" value={st.on ? "Включён" : "Остановлен"} tone={st.on ? "up" : "dn"}
             sub={st.on ? (st.live ? "Бот входит в сделки; ночью — пересчёт бэктеста" : "Ночной пересчёт идёт")
               : "Новых сделок нет; открытая позиция остаётся с тейком"} wrap />
        <div className="at-switch">
          <Action kind="primary" disabled={busy || st.on} onClick={() => flip(true)}>Старт</Action>
          <Action kind="danger" disabled={busy || !st.on} onClick={() => flip(false)}>Стоп</Action>
        </div>
        {st.live ? null : (
          <Row title="Реальная торговля не установлена" wrap
               sub="На сервере: sudo bash /home/vadymdota2/WhaleScanner/tools/autotrade-install.sh, затем ключ OKX в /etc/whale-autotrade.env" />
        )}
        <Row title="Пересчёт" sub={st.running ? `идёт с ${when(st.started * 1000)}${st.progress ? ` · ${st.progress}` : ""}`
               : `следующий ${when(st.next * 1000)}`}
             value={b ? when(b.generated_at * 1000) : "ещё не было"} valueSub="последний" wrap />
        {st.error ? <Row title="Сбой прошлого пересчёта" sub={st.error} tone="dn" wrap /> : null}
        <Action kind="ghost" disabled={st.running || !st.on} onClick={run}>
          {st.running ? "Считается…" : "Пересчитать сейчас"}
        </Action>
      </Card>

      {st.live ? <Live l={st.live} on={st.on} /> : null}

      {!b ? (
        <Empty text="Итога бэктеста ещё нет"
               hint={st.on ? "Первый пересчёт идёт после «Старт»; обычно 5–30 минут." : "Нажмите «Старт» — сразу начнётся первый пересчёт (обычно 5–30 минут)."} />
      ) : (
        <>
          <Overview s={b} />
          <Exits s={b} />
          <Variants s={b} />
          <Active s={b} />
          <Card>
            <Row title={b.verdict ? "Правила окупаются" : "Правила пока не окупаются"} wrap tone={b.verdict ? "up" : "dn"}
                 sub={`Повтор последних ${Math.round((b.period.to - b.period.from) / 86_400_000)} дн. по актуальным правилам `
                   + `живого бота; ${b.verdict ? "критерий на последней четверти пройден" : "критерий на последней четверти не пройден"}.`} />
            <Row title="Критерий" wrap
                 sub={`на последней четверти: итог > 0, PF ≥ ${b.criteria.pf_ge}, сделок ≥ ${b.criteria.trades_ge}, просадка ≤ ${usd(b.criteria.max_dd_le)}`} />
            <Row title="Правила" wrap
                 sub={`от 2 китов (каждый от 1000 $) в одну сторону за 2 ч; против — не крупнее; не дороже китов на 0,3 %; `
                   + "уровни 4ч × 24: лонг — ниже 40 % диапазона (у поддержки), шорт — выше 60 % (у сопротивления), середина — нет; "
                   + "рейтинг китов по нашим сделкам: выше винрейт — раньше, выше 90 % (от 5) — с ним и в одиночку, без уровней и MA30; "
                   + "MA30 15м: лонг — цена выше, шорт — ниже (уровни важнее); "
                   + `маржа ${b.sizing.margin_pct}% × ${b.sizing.leverage}×, одна позиция, в бумагу — раз в 3 ч; выход — тейк +1 % `
                   + "или по рынку: стоп 0,5 % за уровнем входа (не дальше 1,5 % от входа) или вслед за китом в убытке; усреднения нет"} />
            <Row title="Сигналы в повторе" wrap sub={skipsLine(b.skips)} />
            <Row title="Данные" wrap
                 sub={`${b.data.signals} сигналов; свечи OKX 5 мин — запросов ${b.data.requests}${b.data.errors ? `, сбоев ${b.data.errors}` : ""}; `
                   + `комиссии ${b.sizing.fee_taker_pct}% / ${b.sizing.fee_maker_pct}%, проскальзывание ${b.sizing.slippage_pct}%; фандинг не учтён`} />
          </Card>

          <SectionTitle>Последняя четверть периода</SectionTitle>
          <Card><StatsRows s={b.last} /></Card>
          <SectionTitle>Первые три четверти</SectionTitle>
          <Card><StatsRows s={b.first} /></Card>

          {b.equity.length > 1 ? (
            <>
              <SectionTitle>Капитал на всём периоде</SectionTitle>
              <Card>
                <TrendChart values={b.equity.map((p) => p[1])} />
              </Card>
            </>
          ) : null}

          <Groups title="По бумагам" rows={b.by_coin} />
          <Groups title="По времени суток" rows={b.by_session}
                  label={(k) => (k === "open" ? "Рынок США открыт" : "Рынок США закрыт")} />

          {b.trades.length ? (
            <>
              <SectionTitle>Последние сделки модели</SectionTitle>
              <Card pad={false}>
                {[...b.trades].reverse().slice(0, 30).map((t, i) => (
                  <Row key={i} title={`${t.coin} · ${t.side > 0 ? "лонг" : "шорт"}`}
                       sub={`${when(t.entry)} по ${price(t.px_in)} → ${t.why === "открыта" ? "ещё открыта"
                         : `${when(t.exit)} по ${price(t.px_out)} · ${t.why}`}`}
                       value={usd(t.usd, true)} tone={t.usd >= 0 ? "up" : "dn"} valueSub={pct(t.pct, 2)} />
                ))}
              </Card>
            </>
          ) : null}
        </>
      )}
    </Frame>
  );
}
