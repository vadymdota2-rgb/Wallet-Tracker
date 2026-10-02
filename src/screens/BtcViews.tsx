/**
 * Bitcoin — третья сеть после BSC и Hyperliquid.
 *
 * Данные пишет сканер бота (WhaleScanner/btc_chain.cpp): каждый блок, адреса
 * бирж, выводы и заводы. Свопов у биткоина нет, поэтому «покупка» здесь —
 * вывод монет с биржи на личный кошелёк (так забирают купленное), «продажа»
 * — завод на биржу. Это и написано в подсказках: без этого «покупка 175 BTC»
 * читалась бы как сделка, которую кто-то видел в стакане.
 *
 * Сканер начинает с момента запуска, истории до него нет. Пока окно длиннее
 * того, сколько он работает, каждый экран говорит об этом прямо — иначе
 * сумма за полдня выдавалась бы за месячную.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Frame } from "./Screen";
import type { ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import type { BigWin, BtcMin, RankWin } from "../store/app";
import { useLive } from "../store/live";
import { t, bare } from "../i18n/t";
import { num, pct, px, shortAddr, signed, since, usd } from "../lib/format";
import { useNow } from "../lib/tick";
import { haptic, openExternal } from "../lib/telegram";
import { removeWallet } from "../lib/api";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import {
  fetchBtcBig, fetchBtcFlow, fetchBtcRank, fetchBtcWallet,
  peekBtcBig, peekBtcFlow, peekBtcRank, peekBtcWallet,
} from "../lib/api";
import { BuySellBar, TrendChart } from "../components/Chart";
import { CoinIcon } from "../components/CoinIcon";
import {
  Card, DealsGlyph, Empty, MinusGlyph, PlusGlyph, Row, SectionTitle, Segmented, Tiles,
} from "../components/ui";
import type { BtcBigReply, BtcFlowReply, BtcRankKind, BtcRankReply, BtcWalletReply } from "../lib/types";

const EXPLORER = "https://mempool.space";
/* Числа со знаком и единицей — изолированным куском слева направо: в
   арабском иначе «+72» превращалось в «72+», а «175 BTC» — в «BTC 175». */
const iso = (x: string | number) => `\u2066${x}\u2069`;
const btc = (v: number, d = 2) => iso(`${num(v, Math.abs(v) >= 1000 ? 0 : d)} BTC`);
const btcSigned = (v: number) => iso(`${v > 0 ? "+" : ""}${num(v, Math.abs(v) >= 1000 ? 0 : 2)} BTC`);
/** Число монет без единицы: до сотни — с десятыми, дальше целыми. */
const short = (v: number, sign = false) => iso(`${sign && v > 0 ? "+" : ""}${num(v, Math.abs(v) >= 100 ? 0 : 1)}`);

/** Дата начала данных — на языке интерфейса. */
function stamp(lang: string, ts: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      .format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Окно не заполнено целиком: сканер работает меньше, чем длится окно. */
function Partial({ full, from }: { full: boolean; from: number }) {
  const lang = useApp((s) => s.lang);
  if (full || !from) return null;
  return <p className="note dim btc-part">{t(lang, "btc_partial", { d: stamp(lang, from) })}</p>;
}

/**
 * Подписка на кошелёк биткоина — та же кнопка, что у сделок BSC: плюс ведёт
 * на экран имени со всеми проверками (лимит плана, повтор), подписан — на
 * том же месте минус. Бот шлёт по нему алерты: покупка, продажа, перевод.
 */
function FollowBtn({ addr, size = 19 }: { addr: string; size?: number }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const wallets = useLive((s) => s.wallets);
  const on = wallets.some((w) => w.addr.toLowerCase() === addr.toLowerCase());
  return (
    <button
      type="button"
      className={on ? "lb-act off" : "lb-act on"}
      aria-label={bare(t(lang, on ? "remove_yes" : "menu_add_wallet"))}
      onClick={async () => {
        if (!on) {
          haptic("select");
          return open("addWallet", addr);
        }
        haptic("light");
        const res = await removeWallet(addr.toLowerCase());
        if (res?.ok) {
          toast(t(lang, "toast_wallet_removed"));
          void syncNow();
        } else toast(t(lang, "generic_error_retry"), "err");
      }}
    >
      {on ? <MinusGlyph size={size} /> : <PlusGlyph size={size} />}
    </button>
  );
}

/* ── Биткоин на биржах ────────────────────────────────────────────────── */

/* Окна ордеров и ключи окон потока на сервере: те же пять сроков. */
const FLOW_KEY: Record<BigWin, { id: string; label: Parameters<typeof t>[1] }> = {
  "1h": { id: "1", label: "big_win_1h" },
  "6h": { id: "6", label: "win_6h" },
  "24h": { id: "24", label: "big_win_24h" },
  "7d": { id: "168", label: "big_win_7d" },
  "30d": { id: "720", label: "big_win_30d" },
};

/**
 * Сколько биткоина за окно ушло с бирж и сколько пришло на них. Стоит во
 * вкладке «Крупные ордера BTC», над самими ордерами: сперва общий итог по
 * сети, потом кто именно выводил и заводил. Окно общее с ордерами.
 */
export function BtcFlowCard({ bigWin }: { bigWin: BigWin }) {
  const lang = useApp((s) => s.lang);
  const win = FLOW_KEY[bigWin].id;
  const [data, setData] = useState<BtcFlowReply | null>(() => peekBtcFlow() ?? null);

  useEffect(() => {
    let alive = true;
    void fetchBtcFlow().then((r) => {
      if (alive && r?.ok) setData(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  const w = data?.wins?.[win];
  if (!data?.ok || !w) return null;
  const price = data.price || 0;

  return (
    <Card>
      <SectionTitle note={t(lang, "btc_flow_hint")}>
        <span className="btc-ttl">
          <CoinIcon sym="BTC" size={20} />
          {t(lang, "btc_flow_title")}
        </span>
      </SectionTitle>
      <div className="trend">
        <p className="trend-ttl">
          <span>{t(lang, "btc_net")} · {t(lang, FLOW_KEY[bigWin].label)}</span>
          <span>{t(lang, "btc_labels", { n: num(data.labels) })}</span>
        </p>
        <p className="trend-top">
          <b className={w.net >= 0 ? "up" : "dn"}>{btcSigned(w.net)}</b>
          {price ? <small>{iso(signed(w.net * price))}</small> : null}
        </p>
        <TrendChart values={w.tr ?? []} />
        {/* Слева вывод — зелёный, как покупки во всём приложении. */}
        <BuySellBar buy={w.out} sell={w.in} />
        <p className="trend-br">
          <span className="up">{t(lang, "btc_wd")} {btc(w.out)}</span>
          <span className="dn">{t(lang, "btc_dep")} {btc(w.in)}</span>
        </p>
      </div>
      {w.ex.length ? (
        <div className="btc-ex">
          {w.ex.slice(0, 6).map((e) => {
            const net = e.out - e.in;
            return (
              <div key={e.ex} className="btc-ex-row">
                {/* Без «BTC» в каждой ячейке: единица одна на всю карточку,
                    а в узкой строке она переносилась под число. */}
                <b>{e.ex}</b>
                <span className="up">↑ {short(e.out)}</span>
                <span className="dn">↓ {short(e.in)}</span>
                <span className={net >= 0 ? "up" : "dn"}>{short(net, true)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="note dim">{t(lang, "btc_empty")}</p>
      )}
      <Partial full={w.full} from={data.since} />
    </Card>
  );
}

/* ── Аналитика: крупные покупки BTC ───────────────────────────────────── */

const MINS: BtcMin[] = [1, 10, 100];

export function BtcBigView({ winPicker, win }: { winPicker: ReactNode; win: BigWin }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const side = useApp((s) => s.btcSide);
  const setSide = useApp((s) => s.setBtcSide);
  const min = useApp((s) => s.btcMin);
  const setMin = useApp((s) => s.setBtcMin);
  const now = useNow();
  const [data, setData] = useState<BtcBigReply | null>(() => peekBtcBig(win, side, min) ?? null);

  useEffect(() => {
    let alive = true;
    const hit = peekBtcBig(win, side, min);
    setData(hit ?? null);
    void fetchBtcBig(win, side, min).then((r) => {
      if (alive) setData(r ?? { ok: false } as BtcBigReply);
    });
    return () => {
      alive = false;
    };
  }, [win, side, min]);

  const buy = data?.tot?.buy;
  const sell = data?.tot?.sell;

  return (
    <Card>
      <SectionTitle note={t(lang, "btc_big_hint")}>{t(lang, "btc_big_tab")}</SectionTitle>
      <Segmented
        value={side}
        onChange={setSide}
        options={[
          { id: "buy", label: t(lang, "ui_side_buys") },
          { id: "sell", label: t(lang, "ui_side_sells") },
        ]}
      />
      <Segmented<string>
        value={String(min)}
        onChange={(v) => setMin(Number(v) as BtcMin)}
        options={MINS.map((m) => ({ id: String(m), label: `≥ ${m} BTC` }))}
      />
      {winPicker}
      {buy && sell ? (
        <Tiles
          cols={3}
          size="sm"
          items={[
            { label: t(lang, "btc_wd"), value: btc(buy.btc, 1), tone: "up" },
            { label: t(lang, "btc_dep"), value: btc(sell.btc, 1), tone: "dn" },
            {
              label: t(lang, "btc_net"),
              value: btcSigned(Math.round((buy.btc - sell.btc) * 10) / 10),
              tone: buy.btc >= sell.btc ? "up" : "dn",
            },
          ]}
        />
      ) : null}
      {data === null ? (
        <Empty text={t(lang, "ui_loading")} />
      ) : !data.ok || !data.rows?.length ? (
        <Empty text={t(lang, "btc_empty")} />
      ) : (
        data.rows.map((r, i) => (
          /* Строка как у крупных ордеров BSC: монета, кошелёк и время, сумма
             и сторона сделки справа, плюс — подписаться. Откуда и куда —
             стрелкой, она читается на любом языке. */
          <Row
            key={`${r.tx}-${r.a}-${i}`}
            icon={<CoinIcon sym="BTC" size={30} />}
            title={btc(r.btc)}
            sub={`${shortAddr(r.a)} · ${since(now - r.t)}`}
            /* Вторая строка — биржа: стрелка от неё (вывод) или к ней
               (завод), и цена сделки. */
            sub2={`${side === "buy" ? "←" : "→"} ${r.ex} · ${px(r.px)}`}
            value={usd(r.v)}
            tone={side === "buy" ? "up" : "dn"}
            valueSub={t(lang, side === "buy" ? "alert_buy" : "alert_sell")}
            action={<FollowBtn addr={r.a} />}
            onClick={() => {
              haptic("select");
              open("btcWallet", r.a);
            }}
          />
        ))
      )}
      {data?.ok ? <Partial full={data.full} from={data.since} /> : null}
    </Card>
  );
}

/* ── Топ трейдеров: доска Bitcoin ─────────────────────────────────────── */

const FREE_ROWS = 30;
const PREMIUM_ROWS = 100;
const KINDS: BtcRankKind[] = ["pnl", "roi", "act"];

export function BtcBoard({ win }: { win: RankWin }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const plan = useLive((s) => s.me.plan);
  const [kind, setKind] = useState<BtcRankKind>("pnl");
  const [data, setData] = useState<BtcRankReply | null>(() => peekBtcRank(win) ?? null);

  useEffect(() => {
    let alive = true;
    setData(peekBtcRank(win) ?? null);
    void fetchBtcRank(win).then((r) => {
      if (alive) setData(r ?? { ok: false } as BtcRankReply);
    });
    return () => {
      alive = false;
    };
  }, [win]);

  const cap = plan === "premium" ? PREMIUM_ROWS : FREE_ROWS;
  const rows = data?.ok ? (data[kind] ?? []).slice(0, cap) : [];
  const label = (k: BtcRankKind) => (k === "act" ? t(lang, "btc_rk_acc") : k === "roi" ? "ROI" : "PnL");

  return (
    <>
      <Card>
        <Segmented<BtcRankKind>
          value={kind}
          onChange={setKind}
          options={KINDS.map((k) => ({ id: k, label: label(k) }))}
        />
        <p className="note dim">{t(lang, "btc_rank_hint")}</p>
        {data?.ok ? <Partial full={data.full} from={data.since} /> : null}
      </Card>
      {data === null ? (
        <Card>
          <Empty text={t(lang, "ui_loading")} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <Empty text={t(lang, "btc_empty")} hint={t(lang, "rk_generating")} />
        </Card>
      ) : (
        rows.map((r, i) => {
          const place = i + 1;
          return (
            <Card key={`${r.a}-${i}`}>
              <div className="lb-hd">
                <span className={place <= 3 ? `rank-n m${place}` : "rank-n"}>{place}</span>
                <span className="lb-addr mono">{shortAddr(r.a)}</span>
                <button
                  type="button"
                  className="lb-act"
                  aria-label={t(lang, "btc_moves")}
                  onClick={() => {
                    haptic("select");
                    open("btcWallet", r.a);
                  }}
                >
                  <DealsGlyph size={20} />
                </button>
                <FollowBtn addr={r.a} size={20} />
              </div>
              <Tiles
                cols={3}
                size="sm"
                items={[
                  { label: "PnL", value: iso(signed(r.pnl)), tone: r.pnl >= 0 ? "up" : "dn" },
                  { label: "ROI", value: iso(pct(r.roi, 1)) },
                  { label: t(lang, "btc_hold"), value: btc(r.btc, 2) },
                  { label: t(lang, "btc_avg"), value: px(r.avg) },
                  { label: t(lang, "btc_in_profit"), value: `${num(r.win)}%` },
                  {
                    label: t(lang, "btc_wd_dep"),
                    value: `${num(r.buys)} / ${num(r.sells)}`,
                  },
                ]}
              />
              <p className="btc-foot dim">
                {r.ex ? <span>{r.ex}</span> : null}
                {r.bal !== undefined ? <span>{t(lang, "btc_bal")} {btc(r.bal)}</span> : null}
              </p>
            </Card>
          );
        })
      )}
      {plan !== "premium" && rows.length >= FREE_ROWS ? (
        <Card>
          <p className="note warn">{t(lang, "rk_unlock_top100")}</p>
        </Card>
      ) : null}
    </>
  );
}

/* ── Экран кошелька ───────────────────────────────────────────────────── */

export function BtcWalletScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const addr = arg ?? "";
  const now = useNow();
  const [data, setData] = useState<BtcWalletReply | null>(() => (addr ? peekBtcWallet(addr) ?? null : null));

  useEffect(() => {
    if (!addr) return;
    let alive = true;
    void fetchBtcWallet(addr).then((r) => {
      if (alive) setData(r ?? { ok: false } as BtcWalletReply);
    });
    return () => {
      alive = false;
    };
  }, [addr]);

  const b = data?.book;
  return (
    <Frame title={t(lang, "btc_wallet_title")} sub={shortAddr(addr)}>
      <Card>
        <p className="mono btc-addr">{addr}</p>
        {data?.ex ? <p className="note warn">{t(lang, "btc_is_exchange", { ex: data.ex })}</p> : null}

        {b ? (
          <Tiles
            cols={3}
            size="sm"
            items={[
              { label: "PnL", value: iso(signed(b.pnl)), tone: b.pnl >= 0 ? "up" : "dn" },
              { label: "ROI", value: iso(pct(b.roi, 1)) },
              { label: t(lang, "btc_hold"), value: btc(b.btc) },
              { label: t(lang, "btc_avg"), value: px(b.avg) },
              { label: t(lang, "btc_in_profit"), value: `${num(b.win)}%` },
              { label: t(lang, "btc_bal"), value: data?.bal !== undefined ? btc(data.bal) : "—" },
            ]}
          />
        ) : null}
        <div className="unl-act">
          <BtcFollowWide addr={addr} />
          <button
            type="button"
            className="unl-btn ghost"
            onClick={() => {
              haptic("light");
              openExternal(`${EXPLORER}/address/${addr}`);
            }}
          >
            {t(lang, "btc_explorer")} ↗
          </button>
        </div>
      </Card>
      <Card>
        <SectionTitle>{t(lang, "btc_moves")}</SectionTitle>
        {data === null ? (
          <Empty text={t(lang, "ui_loading")} />
        ) : !data.moves?.length ? (
          <Empty text={t(lang, "btc_empty")} />
        ) : (
          data.moves.map((m, i) => (
            <Row
              key={`${m.tx}-${i}`}
              icon={<CoinIcon sym="BTC" size={30} />}
              title={iso(`${m.buy ? "+" : "−"}${num(m.btc, m.btc >= 1000 ? 0 : 2)} BTC`)}
              /* С биржей — «вывод с Binance», без биржи — просто «получено». */
              sub={m.ex
                ? t(lang, m.buy ? "btc_wd_from" : "btc_dep_to", { ex: m.ex })
                : t(lang, m.buy ? "btc_move_in" : "btc_move_out")}
              sub2={since(now - m.t)}
              value={usd(m.v)}
              valueSub={px(m.px)}
              tone={m.buy ? "up" : "dn"}
              onClick={() => openExternal(`${EXPLORER}/tx/${m.tx}`)}
            />
          ))
        )}
      </Card>
      <p className="note dim">{bare(t(lang, "btc_rank_hint"))}</p>
    </Frame>
  );
}

/** Широкая кнопка подписки — на экране кошелька, рядом со ссылкой. */
function BtcFollowWide({ addr }: { addr: string }) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const wallets = useLive((s) => s.wallets);
  const on = wallets.some((w) => w.addr.toLowerCase() === addr.toLowerCase());
  if (on) return <p className="note dim btc-follow-on">{t(lang, "btc_followed")}</p>;
  return (
    <button
      type="button"
      className="unl-btn"
      onClick={() => {
        haptic("select");
        open("addWallet", addr);
      }}
    >
      {bare(t(lang, "menu_add_wallet"))}
    </button>
  );
}
