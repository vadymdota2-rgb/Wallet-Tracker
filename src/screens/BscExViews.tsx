/**
 * Поток бирж BSC — сколько долларов завели на биржи и вывели с них по всей
 * сети за окно (бот: bsc_exchanges.cpp, таблица bsc_ex_flow).
 *
 * Это не NetFlow DEX: там свопы кошельков базы, здесь — переводы на биржи и
 * с бирж всей сети. Поэтому отдельная плитка и отдельные числа, без смешения.
 * Вид — как у потока бирж Bitcoin: итог, линия, биржи, а ниже монеты.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useApp } from "../store/app";
import type { BigWin } from "../store/app";
import { t } from "../i18n/t";
import { num, signed, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import { fetchBscExFlow, peekBscExFlow } from "../lib/api";
import { BuySellBar, TrendChart } from "../components/Chart";
import { CoinIcon } from "../components/CoinIcon";
import { Card, SectionTitle } from "../components/ui";
import type { BscExFlowReply } from "../lib/types";

const iso = (x: string | number) => `⁦${x}⁩`;
// Доллары коротко: в узкой строке биржи полное «$1,234,567» переносилось.
const short = (v: number, sign = false) => iso(`${sign && v > 0 ? "+" : ""}${usd(v)}`);

const WIN_KEY: Record<BigWin, { id: string; label: Parameters<typeof t>[1] }> = {
  "1h": { id: "1", label: "big_win_1h" },
  "6h": { id: "6", label: "win_6h" },
  "24h": { id: "24", label: "big_win_24h" },
  "7d": { id: "168", label: "big_win_7d" },
  "30d": { id: "720", label: "big_win_30d" },
};

const EX_OPEN_KEY = "wt-bscx-ex-open";

function stamp(lang: string, ts: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      .format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
}

export function BscExFlowCard({ bigWin, picker }: { bigWin: BigWin; picker?: ReactNode }) {
  const lang = useApp((s) => s.lang);
  const win = WIN_KEY[bigWin].id;
  const [data, setData] = useState<BscExFlowReply | null>(() => peekBscExFlow());
  const [exOpen, setExOpenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(EX_OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const setExOpen = (v: boolean) => {
    setExOpenState(v);
    try {
      localStorage.setItem(EX_OPEN_KEY, v ? "1" : "0");
    } catch {
      // хранилище закрыто — просто не запомним
    }
  };

  useEffect(() => {
    let alive = true;
    void fetchBscExFlow().then((r) => {
      if (alive && r?.ok) setData(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  const w = data?.wins?.[win];
  return (
    <Card>
      <SectionTitle note={t(lang, "bscx_hint")}>
        <span className="btc-ttl">
          <CoinIcon sym="BNB" size={20} />
          {t(lang, "bscx_title")}
        </span>
      </SectionTitle>
      {picker}
      {!data?.ok || !w || (!w.in && !w.out) ? (
        <p className="note dim">{t(lang, "bscx_empty")}</p>
      ) : (
        <>
          <div className="trend">
            <p className="trend-ttl">
              <span>{t(lang, "btc_net")} · {t(lang, WIN_KEY[bigWin].label)}</span>
              <span>{t(lang, "btc_labels", { n: num(data.labels + data.learned) })}</span>
            </p>
            <p className="trend-top">
              <b className={w.net >= 0 ? "up" : "dn"}>{iso(signed(w.net))}</b>
            </p>
            <TrendChart values={w.tr ?? []} />
            {/* Слева вывод — зелёный, как покупки во всём приложении. */}
            <BuySellBar buy={w.out} sell={w.in} />
            <p className="trend-br">
              <span className="up">{t(lang, "btc_wd")} {short(w.out)}</span>
              <span className="dn">{t(lang, "btc_dep")} {short(w.in)}</span>
            </p>
          </div>
          {w.ex.length ? (
            <>
              <button
                type="button"
                className="btc-ex-tg"
                aria-expanded={exOpen}
                onClick={() => {
                  haptic("select");
                  setExOpen(!exOpen);
                }}
              >
                <span>{t(lang, "btc_ex_list", { n: num(w.ex.length) })}</span>
                <i className={exOpen ? "on" : undefined} aria-hidden="true">▾</i>
              </button>
              {exOpen ? (
                <div className="btc-ex">
                  {w.ex.map((e) => {
                    const net = e.out - e.in;
                    return (
                      <div key={e.ex} className="btc-ex-row bscx-row">
                        <b>{e.ex}</b>
                        <span className="up">↑ {short(e.out)}</span>
                        <span className="dn">↓ {short(e.in)}</span>
                        <span className={net >= 0 ? "up" : "dn"}>{short(net, true)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
          {w.coins.length ? (
            <>
              <p className="trend-ttl bscx-coins">
                <span>{t(lang, "bscx_coins", { n: num(w.coins.length) })}</span>
              </p>
              <div className="btc-ex">
                {w.coins.map((c) => {
                  const net = c.out - c.in;
                  return (
                    <div key={c.token || c.sym} className="btc-ex-row bscx-row">
                      <b className="bscx-coin">
                        <CoinIcon sym={c.sym} size={18} />
                        {c.sym}
                      </b>
                      <span className="up">↑ {short(c.out)}</span>
                      <span className="dn">↓ {short(c.in)}</span>
                      <span className={net >= 0 ? "up" : "dn"}>{short(net, true)}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
          {!w.full && data.since ? (
            <p className="note dim btc-part">{t(lang, "btc_partial", { d: stamp(lang, data.since) })}</p>
          ) : null}
          <p className="note dim">{t(lang, "bscx_note")}</p>
        </>
      )}
    </Card>
  );
}
