/**
 * «Аналитика» — кнопка 📊 бота со всеми её разделами: поток китов,
 * крупнейшие покупки, крупнейшие позиции, ликвидации, перекос фандинга.
 * Ротация — то, чего в чате показать было неудобно, а на экране видно.
 */
import { useEffect, useState } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num, pct, signed, usd } from "../lib/format";
import { ago } from "../lib/relative";
import { fundingSideKey, isUpKind, levFromSide, tradeKind, tradeKindKey } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { Spark } from "../components/Chart";
import { Card, Empty, Locked, Row, SectionTitle, Segmented, Skeleton } from "../components/ui";
import { fetchBig } from "../lib/api";
import type { BigView, BigWin, FlowWin } from "../store/app";
import type { TradeRow, Trades } from "../lib/types";

const FLOW_WINS: { id: FlowWin; key: Parameters<typeof t>[1] }[] = [
  { id: "1", key: "ai_w1h" },
  { id: "6", key: "ai_w6h" },
  { id: "24", key: "big_win_24h" },
  { id: "168", key: "big_win_7d" },
  { id: "720", key: "big_win_30d" },
];

const BIG_WINS: { id: BigWin; key: Parameters<typeof t>[1] }[] = [
  { id: "1h", key: "big_win_1h" },
  { id: "24h", key: "big_win_24h" },
  { id: "7d", key: "big_win_7d" },
  { id: "30d", key: "big_win_30d" },
];

const VIEWS: { id: BigView; key: Parameters<typeof t>[1] }[] = [
  { id: "flow", key: "flow_btn" },
  { id: "spot", key: "big_btn_spot" },
  { id: "perp", key: "big_btn_perp" },
  { id: "liq", key: "big_btn_liq" },
  { id: "fund", key: "fund_btn" },
  { id: "rot", key: "ui_rotation" },
];

function TradeList({ rows, empty }: { rows: TradeRow[]; empty: string }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  if (!rows.length) return <Empty text={empty} />;
  return (
    <>
      {rows.map((r, i) => {
        const kind = tradeKind(r.side);
        const lev = levFromSide(r.side);
        return (
          <Row
            key={`${r.sym}-${i}`}
            icon={<CoinIcon sym={r.sym} size={30} />}
            title={r.sym}
            sub={`${r.w} · ${ago(r.t)}`}
            value={usd(r.v)}
            tone={isUpKind(kind) ? "up" : "dn"}
            valueSub={`${t(lang, tradeKindKey(kind))}${lev ? ` ${lev}×` : ""}`}
            onClick={() => open("coin", r.sym)}
          />
        );
      })}
    </>
  );
}

/**
 * Крупнейшие сделки за выбранное окно. Сутки уже пришли в bootstrap — за
 * ними на сервер не ходим; остальные окна считаются по запросу.
 */
function useBigTrades(win: BigWin) {
  const cached = useLive((s) => s.trades);
  const [rows, setRows] = useState<Trades | null>(null);

  useEffect(() => {
    if (win === "24h") {
      setRows(null);
      return;
    }
    const ctrl = new AbortController();
    setRows(null);
    void fetchBig(win, ctrl.signal).then((r) => {
      if (!ctrl.signal.aborted) setRows(r);
    });
    return () => ctrl.abort();
  }, [win]);

  if (win === "24h") return { data: cached, loading: false };
  return { data: rows ?? { spot: [], perp: [], liq: [] }, loading: rows === null };
}

export function AnalyticsTab() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const view = useApp((s) => s.bigView);
  const setView = useApp((s) => s.setBigView);
  const flowWin = useApp((s) => s.flowWin);
  const setFlowWin = useApp((s) => s.setFlowWin);
  const query = useApp((s) => s.flowQuery);
  const setQuery = useApp((s) => s.setFlowQuery);
  const bigWin = useApp((s) => s.bigWin);
  const setBigWin = useApp((s) => s.setBigWin);

  const { funding, me } = useLive();
  const premium = me.plan === "premium";
  const big = useBigTrades(bigWin);
  const showWindows = view === "spot" || view === "perp" || view === "liq";

  const locked = (
    <Locked
      text={t(lang, "hl_locked_body")}
      cta={t(lang, "mw_upgrade")}
      onCta={() => {
        goTab("more");
        open("premium");
      }}
    />
  );

  return (
    <>
      <Card>
        <SectionTitle>{t(lang, "big_title")}</SectionTitle>
        <p className="note dim">{t(lang, "big_menu_hint")}</p>
        <Segmented<BigView>
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ id: v.id, label: t(lang, v.key) }))}
        />
        {showWindows ? (
          <Segmented<BigWin>
            value={bigWin}
            onChange={setBigWin}
            options={BIG_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
          />
        ) : null}
      </Card>

      {view === "flow" ? (
        <Card>
          <SectionTitle note={t(lang, "flow_hint")}>{t(lang, "flow_title")}</SectionTitle>
          <Segmented<FlowWin>
            value={flowWin}
            onChange={setFlowWin}
            options={FLOW_WINS.map((w) => ({ id: w.id, label: t(lang, w.key) }))}
          />
          <input
            className="find"
            value={query}
            placeholder={t(lang, "flow_search_prompt")}
            onChange={(e) => setQuery(e.target.value)}
            inputMode="search"
            aria-label={t(lang, "flow_search_btn")}
          />
          <FlowBody />
        </Card>
      ) : null}

      {view === "spot" ? (
        <Card>
          <SectionTitle>{t(lang, "big_spot_title")}</SectionTitle>
          {big.loading ? <Skeleton rows={3} /> : <TradeList rows={big.data.spot} empty={t(lang, "big_empty")} />}
        </Card>
      ) : null}

      {view === "perp" ? (
        <Card>
          <SectionTitle>{t(lang, "big_perp_title")}</SectionTitle>
          {!premium ? locked : big.loading ? <Skeleton rows={3} /> : (
            <TradeList rows={big.data.perp} empty={t(lang, "big_empty")} />
          )}
        </Card>
      ) : null}

      {view === "liq" ? (
        <Card>
          <SectionTitle>{t(lang, "big_liq_title")}</SectionTitle>
          {big.loading ? <Skeleton rows={3} /> : <TradeList rows={big.data.liq} empty={t(lang, "big_empty")} />}
        </Card>
      ) : null}

      {view === "fund" ? (
        <Card>
          <SectionTitle note={t(lang, "fund_hint")}>{t(lang, "fund_title")}</SectionTitle>
          {!premium ? (
            locked
          ) : funding.length === 0 ? (
            <Empty text={t(lang, "fund_empty")} hint={t(lang, "fund_loading")} />
          ) : (
            funding.map((f) => (
              <Row
                key={f.sym}
                icon={<CoinIcon sym={f.sym} size={30} />}
                title={f.sym}
                sub={`${t(lang, fundingSideKey(f.rate))} · ${t(lang, "fund_oi")} ${usd(f.oi)}`}
                value={pct(f.rate, 4)}
                tone={f.rate >= 0 ? "up" : "dn"}
                valueSub={`${t(lang, "fund_apr")} ${pct(f.apr, 1)}`}
                onClick={() => open("coin", f.sym)}
              />
            ))
          )}
        </Card>
      ) : null}

      {view === "rot" ? (
        <Card>
          <SectionTitle note={t(lang, "ui_rot_hint")}>{t(lang, "ui_rotation")}</SectionTitle>
          <RotBody />
        </Card>
      ) : null}
    </>
  );
}

function FlowBody() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const win = useApp((s) => s.flowWin);
  const query = useApp((s) => s.flowQuery).trim().toUpperCase();
  const flow = useLive((s) => s.flow);

  const bucket = flow[win];
  if (!bucket) return <Empty text={t(lang, "flow_empty")} />;

  const rows = query ? bucket.rows.filter((r) => r.sym.toUpperCase().includes(query)) : bucket.rows;
  if (!rows.length) {
    return <Empty text={query ? t(lang, "flow_search_none") : t(lang, "flow_empty")} />;
  }

  return (
    <>
      <p className="flow-sum">
        <span className={bucket.net >= 0 ? "up" : "dn"}>{signed(bucket.net)}</span>
        <small>
          {num(bucket.coins)} {t(lang, "flow_coins")}
        </small>
      </p>
      {rows.map((r) => (
        <Row
          key={r.sym}
          icon={<CoinIcon sym={r.sym} size={30} />}
          title={r.sym}
          sub={
            <>
              {num(r.w)} {t(lang, "flow_wallets")} · <span className="up">{usd(r.buy)}</span> ·{" "}
              <span className="dn">{usd(r.sell)}</span>
            </>
          }
          value={<><Spark values={r.sp} /> {signed(r.net)}</>}
          tone={r.net >= 0 ? "up" : "dn"}
          onClick={() => open("coin", r.sym)}
        />
      ))}
    </>
  );
}

function RotBody() {
  const lang = useApp((s) => s.lang);
  const rot = useLive((s) => s.rot);
  const win = useApp((s) => s.flowWin);
  const key = win === "168" || win === "720" ? "168" : "24";
  const links = rot[key] ?? [];
  if (!links.length) return <Empty text={t(lang, "flow_empty")} />;
  return (
    <>
      {links.map((l, i) => (
        <Row
          key={`${l.from}-${l.to}-${i}`}
          icon={<CoinIcon sym={l.to} size={30} />}
          title={
            <>
              {l.from} <span className="arrow">→</span> {l.to}
            </>
          }
          sub={`${num(l.w)} ${t(lang, "flow_wallets")}`}
          value={usd(l.usd)}
        />
      ))}
    </>
  );
}
