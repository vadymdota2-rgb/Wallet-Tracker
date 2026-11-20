/**
 * «Автоторговля» — закрытая вкладка владельца: автокопирование китов
 * Hyperliquid по акциям (xyz:, io:, para:).
 *
 * Видит её только владелец: пункт меню показывается по `me.owner`, а данные
 * сервер отдаёт лишь по подписи Telegram владельца — остальным 404, как у
 * несуществующего адреса (wt_autotrade.py, whale_api.py). Тексты — по-русски
 * и в словарь не вынесены: это служебный экран одного человека, людям он не
 * показывается никогда.
 *
 * Сейчас — этап 1, бэктест: сервер пересчитывает его раз в сутки (только
 * чтение базы бота). Вердикт «можно дальше» — не сигнал к торговле, а
 * повод владельцу сказать «да» бумажной торговле; реальная — только после
 * неё и отдельного «да».
 */
import { useEffect, useState } from "react";
import { Frame } from "./Screen";
import { Action, Card, Empty, Row, SectionTitle, Skeleton } from "../components/ui";
import { TrendChart } from "../components/Chart";
import { autotradeRun, autotradeStart, autotradeStop, fetchAutotrade } from "../lib/api";
import { pct, usd } from "../lib/format";
import { toast } from "../components/Toast";
import type { AtGroup, AtParams, AtStats, AtSummary, AutotradeReply } from "../lib/types";

const when = (ms: number) =>
  ms > 0 ? new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

const pf = (v: number | null) => (v === null ? "∞" : v.toFixed(2));

function paramsLine(p: AtParams): string {
  const exits = [
    p.tp ? `тейк ${p.tp}%` : "",
    p.sl ? `стоп ${p.sl}%` : "",
    p.hold ? `по времени ${p.hold} мин` : "",
    p.whale ? "когда кит закрыл" : "",
  ].filter(Boolean);
  return [
    p.wallets > 1 ? `китов в одну сторону от ${p.wallets}${p.min_whale ? `, каждый от ${usd(p.min_whale)}` : ""}` : "",
    p.no_conflict ? "киты не спорят" : "",
    p.rest ? `после выхода ${p.rest / 60} ч в бумагу не входим` : "",
    `вход через ${p.delay} с`,
    `объём от ${usd(p.min_notional)}`,
    p.chase ? `не дороже китов больше чем на ${p.chase}%` : "",
    p.pnl30 ? "кит в плюсе за 30 дн." : "",
    exits.length ? exits.join(", ") : "без выхода — до предела удержания",
  ].filter(Boolean).join(" · ");
}

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
      {s.max_mae !== undefined ? (
        <Row title="Пересиживание" wrap
             sub={`дольше всех — ${Math.round(s.longest_h ?? 0)} ч; провал внутри сделки — до ${usd(-s.max_mae)}`}
             value={s.open ? `открыто ${s.open}` : "все закрыты"} tone={s.open ? "dn" : "up"}
             valueSub={s.open ? usd(s.unrealized, true) : "по тейку"} />
      ) : null}
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

/** Какие бумаги китов можно торговать на OKX: имя на Hyperliquid и на OKX
 *  может не совпадать, а одно имя — означать разные активы. */
function OkxCard({ s }: { s: AtSummary }) {
  const map = s.okx?.map;
  if (!map) return null;
  const all = Object.entries(map);
  const short = (inst = "") => inst.replace(/-USDT-SWAP$/, "");
  const ok = all.filter(([, m]) => m.status === "ok");
  const renamed = ok.filter(([c, m]) => short(m.inst) !== c.split(":").pop())
    .map(([c, m]) => `${c} → ${short(m.inst)}${m.scale && m.scale !== 1 ? ` (×${m.scale})` : ""}`);
  const other = all.filter(([, m]) => m.status === "mismatch").map(([c, m]) => `${c} ≠ ${short(m.inst)}`);
  const none = all.filter(([, m]) => m.status === "missing" || m.status === "unverified").map(([c]) => c);
  const list = (xs: string[], n = 40) => xs.slice(0, n).join(", ") + (xs.length > n ? ` … ещё ${xs.length - n}` : "");
  return (
    <>
      <SectionTitle>OKX</SectionTitle>
      <Card>
        <Row title={s.okx?.venue === "okx" ? "Торгуем на OKX" : "Торгуем на Hyperliquid"}
             sub={`На OKX есть ${ok.length} из ${all.length} бумаг китов (сверено по цене, ±2 %)`} wrap />
        {renamed.length ? <Row title="На OKX под другим именем" sub={list(renamed)} wrap /> : null}
        {other.length ? <Row title="То же имя — другой актив" sub={list(other)} tone="dn" wrap /> : null}
        {none.length ? <Row title="Нет на OKX" sub={list(none)} wrap /> : null}
      </Card>
    </>
  );
}

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
        toast("Нет связи с сервером", "err");
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
      toast(r.started ? "Пересчёт запущен — займёт до часа" : "Уже считается");
      setTick((n) => n + 1);
    });
  };

  if (failed) return <Frame title="Автоторговля"><Empty text="Нет доступа или нет связи с сервером" /></Frame>;
  if (!st) return <Frame title="Автоторговля"><Skeleton rows={6} /></Frame>;

  const b = st.backtest;
  const best = b?.top[0];
  return (
    <Frame title="Автоторговля" sub="Копирование китов · фьючерсы Hyperliquid">
      <Card>
        <Row title="Модуль" value={st.on ? "Включён" : "Остановлен"} tone={st.on ? "up" : "dn"}
             sub={st.on ? "Ночной пересчёт идёт" : "Ничего не считается и не торгуется"} wrap />
        <div className="at-switch">
          <Action kind="primary" disabled={busy || st.on} onClick={() => flip(true)}>Старт</Action>
          <Action kind="danger" disabled={busy || !st.on} onClick={() => flip(false)}>Стоп</Action>
        </div>
        <Row title="Этап 1 — бэктест" sub="Бумажная и реальная торговля — только после вашего «да»" wrap />
        <Row title="Пересчёт" sub={st.running ? `идёт с ${when(st.started * 1000)}` : `следующий ${when(st.next * 1000)}`}
             value={b ? when(b.generated_at * 1000) : "ещё не было"} valueSub="последний" wrap />
        {st.error ? <Row title="Сбой прошлого пересчёта" sub={st.error} tone="dn" wrap /> : null}
        <Action kind="ghost" disabled={st.running || !st.on} onClick={run}>
          {st.running ? "Считается…" : "Пересчитать сейчас"}
        </Action>
      </Card>

      {!b ? (
        <Empty text="Итога бэктеста ещё нет" hint="Первый пересчёт идёт после запуска сервера; до часа." />
      ) : (
        <>
          <Card>
            <Row title={b.verdict ? "Вердикт: можно дальше" : "Вердикт: нет"}
                 sub={b.verdict
                   ? "Лучший набор прошёл проверку на отложенных данных. Следующий шаг — бумажная торговля (2–4 недели), если скажете «да»."
                   : "На отложенных данных критерий не пройден — копирование не окупает комиссии и риск."}
                 tone={b.verdict ? "up" : "dn"} wrap />
            <Row title="Критерий" wrap
                 sub={`итог > 0, PF ≥ ${b.criteria.pf_ge}, сделок ≥ ${b.criteria.trades_ge}, просадка ≤ ${usd(b.criteria.max_dd_le)}${b.criteria.beats_fade ? "; за китами лучше, чем против них" : ""}`} />
            <Row title="Размер" wrap
                 sub={`${b.sizing.cross ? "кросс-маржа" : "изолированная маржа"}; депозит ${usd(b.sizing.deposit)}, маржа ${b.sizing.margin_pct}% × ${b.sizing.leverage}× = позиция ${usd(b.sizing.notional)}; позиций сразу: ${b.sizing.max_open || "без предела"}; ликвидация при ходе против ${b.sizing.liq_move_pct}%; выход — только тейк, пересиживаем всегда (пока позиция открыта, новых сделок нет)`} />
            <Row title="Сигнал" wrap
                 sub={`открытие лонга или шорта на фьючерсах (${b.sizing.markets === "all" ? "крипта, акции, металлы" : "акции"}); китов считаем за ${b.sizing.cluster_hours} ч${b.sizing.min_whale ? `, у каждого позиция от ${usd(b.sizing.min_whale)}` : ""}; цена ниже средней китов (для шорта — выше) — входим, ушла в другую сторону дальше предела — пропуск`} />
            <Row title="Данные" wrap
                 sub={`${b.data.signals} сигналов, ${when(b.period.from)} — ${when(b.period.to)}; отложенные — после ${when(b.period.cut)}; свечи: ${Object.entries(b.data.candles).map(([k, v]) => `${k} ${v}`).join(", ")}`} />
          </Card>

          <OkxCard s={b} />

          {best ? (
            <>
              <SectionTitle>Лучший набор на отложенных данных</SectionTitle>
              <Card>
                <Row title="Параметры" sub={paramsLine(best.params)} wrap />
                <StatsRows s={best.holdout} />
                {b.fade ? (
                  <Row title="Против китов (наоборот)" wrap
                       sub={`${b.fade.trades} сделок · ${pct(b.fade.win_pct, 0, false)} в плюс · ${b.fade.net < best.holdout.net ? "за китами лучше" : "за китами НЕ лучше — преимущества нет, только форма стратегии"}`}
                       value={usd(b.fade.net, true)} tone={b.fade.net < best.holdout.net ? "up" : "dn"} />
                ) : null}
              </Card>
              <SectionTitle>Тот же набор на подборе</SectionTitle>
              <Card><StatsRows s={best.train} /></Card>
            </>
          ) : null}

          {b.full && b.equity.length > 1 ? (
            <>
              <SectionTitle>Капитал на всём периоде</SectionTitle>
              <Card>
                <TrendChart values={b.equity.map((p) => p[1])} />
                <StatsRows s={b.full} />
              </Card>
            </>
          ) : null}

          {b.top.length > 1 ? (
            <>
              <SectionTitle>Лучшие {b.top.length} наборов (отложенные)</SectionTitle>
              <Card pad={false}>
                {b.top.map((x, i) => (
                  <Row key={i} title={`${i + 1}. ${paramsLine(x.params)}`} wrap
                       sub={`${x.holdout.trades} сделок · PF ${pf(x.holdout.pf)} · просадка ${usd(x.holdout.max_dd)}`}
                       value={usd(x.holdout.net, true)} tone={x.holdout.net >= 0 ? "up" : "dn"}
                       valueSub={x.passes ? "проходит" : "не проходит"} />
                ))}
              </Card>
            </>
          ) : null}

          {b.pace?.length ? (
            <>
              <SectionTitle>Сколько сделок в день</SectionTitle>
              <Card pad={false}>
                {b.entries_per_day !== undefined ? (
                  <Row title="Возможностей входа" wrap value={`${b.entries_per_day} в день`}
                       sub="по правилу китов — верхняя граница: пока позиция не дошла до тейка, новые не открываются" />
                ) : null}
                {b.pace.map((x) => (
                  <Row key={x.max_open} wrap
                       title={`Позиций сразу: ${x.max_open} (маржа ${x.max_open * b.sizing.margin_pct}%)`}
                       sub={`${x.trades} сделок · до тейка обычно ${x.median_tp_h} ч · открыто на конец ${x.open} · просадка ${usd(x.max_dd)}${x.bust ? ` · депозит кончился ${when(x.bust)}` : ""}`}
                       value={`${x.per_day} в день`} valueSub={usd(x.net, true)} tone={x.bust || x.net < 0 ? "dn" : "up"} />
                ))}
              </Card>
            </>
          ) : null}

          {b.by_chase?.length ? (
            <>
              <SectionTitle>По пределу догона</SectionTitle>
              <Card pad={false}>
                {b.by_chase.map((c) => (
                  <Row key={c.chase} title={`Не дороже китов на ${c.chase}%`}
                       sub={`подбор ${usd(c.train.net, true)} · отложенные: ${c.holdout.trades} сделок, PF ${pf(c.holdout.pf)}`}
                       value={usd(c.holdout.net, true)} tone={c.holdout.net >= 0 ? "up" : "dn"} valueSub="отложенные" />
                ))}
              </Card>
            </>
          ) : null}

          <Groups title="По бумагам" rows={b.by_coin} />
          <Groups title="По времени суток" rows={b.by_session}
                  label={(k) => (k === "open" ? "Рынок США открыт" : "Рынок США закрыт")} />
          <Groups title="По причине выхода" rows={b.by_exit} />
          <Groups title="По китам" rows={b.by_whale} />

          {b.trades.length ? (
            <>
              <SectionTitle>Последние сделки</SectionTitle>
              <Card pad={false}>
                {[...b.trades].reverse().slice(0, 30).map((t, i) => (
                  <Row key={i} title={`${t.coin} · ${t.side > 0 ? "лонг" : "шорт"}`}
                       sub={`${when(t.entry)} → ${when(t.exit)} · ${t.why}${t.holdout ? " · отложенные" : ""}`}
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
