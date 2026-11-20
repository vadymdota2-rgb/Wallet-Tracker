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
import { autotradeRun, fetchAutotrade } from "../lib/api";
import { pct, usd } from "../lib/format";
import { toast } from "../components/Toast";
import type { AtGroup, AtParams, AtStats, AutotradeReply } from "../lib/types";

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
    `вход через ${p.delay} с`,
    `объём кита от ${usd(p.min_notional)}`,
    p.pnl30 ? "кит в плюсе за 30 дн." : "",
    exits.length ? exits.join(", ") : "выход по пределу удержания",
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

  const run = () => {
    void autotradeRun().then((r) => {
      if (!r?.ok) {
        toast("Не вышло запустить");
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
    <Frame title="Автоторговля" sub="Копирование китов · акции Hyperliquid">
      <Card>
        <Row title="Этап 1 — бэктест" sub="Бумажная и реальная торговля — только после вашего «да»" wrap />
        <Row title="Пересчёт" sub={st.running ? `идёт с ${when(st.started * 1000)}` : `следующий ${when(st.next * 1000)}`}
             value={b ? when(b.generated_at * 1000) : "ещё не было"} valueSub="последний" wrap />
        {st.error ? <Row title="Сбой прошлого пересчёта" sub={st.error} tone="dn" wrap /> : null}
        <Action kind="ghost" disabled={st.running} onClick={run}>
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
                 sub={`итог > 0, PF ≥ ${b.criteria.pf_ge}, сделок ≥ ${b.criteria.trades_ge}, просадка ≤ ${usd(b.criteria.max_dd_le)}`} />
            <Row title="Размер" wrap
                 sub={`депозит ${usd(b.sizing.deposit)}, маржа ${b.sizing.margin_pct}% × ${b.sizing.leverage}× = позиция ${usd(b.sizing.notional)}; позиций сразу: ${b.sizing.max_open || "без предела"}; ликвидация при ходе против ${b.sizing.liq_move_pct}%`} />
            <Row title="Данные" wrap
                 sub={`${b.data.signals} сигналов, ${when(b.period.from)} — ${when(b.period.to)}; отложенные — после ${when(b.period.cut)}; свечи: ${Object.entries(b.data.candles).map(([k, v]) => `${k} ${v}`).join(", ")}`} />
          </Card>

          {best ? (
            <>
              <SectionTitle>Лучший набор на отложенных данных</SectionTitle>
              <Card>
                <Row title="Параметры" sub={paramsLine(best.params)} wrap />
                <StatsRows s={best.holdout} />
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
