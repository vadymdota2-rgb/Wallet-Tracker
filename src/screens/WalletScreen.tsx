/** Карточка кошелька: остаток, открытые позиции, действия. */
import { Frame, type ScreenProps } from "./Screen";
import { useApp, isPaused } from "../store/app";
import { useLive, walletByAddr } from "../store/live";
import { boardKey, venueName, walletRank } from "../lib/rank";
import { bare, t } from "../i18n/t";
import { lev as levFmt, num, pct, px, shortAddr, signed, usd } from "../lib/format";
import { holdHours } from "../lib/labels";
import { removeWallet, setPrimary } from "../lib/api";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { CoinIcon } from "../components/CoinIcon";
import { Action, AddrBar, Card, Empty, Row, SectionTitle, Tiles, VenueMark } from "../components/ui";

export function WalletScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const back = useApp((s) => s.back);
  const wallets = useLive((s) => s.wallets);
  const rank = useLive((s) => s.rank);
  const plan = useLive((s) => s.me.plan);

  const w = walletByAddr(wallets, arg);
  if (!w) {
    return (
      <Frame title={t(lang, "err_wallet_not_found")}>
        <Empty text={t(lang, "err_loading_wallet")} />
      </Frame>
    );
  }

  const paused = isPaused(plan, w.primary);
  const eq = w.equity;
  const place = walletRank(rank, w.addr);
  // Длинное «не в рейтинге» в плитку не влезает — там прочерк, а словами
  // это сказано примечанием к разделу.
  const spot = place.spot ? `🏆 ${place.spot.place}` : "—";
  const perp = place.perp ? `🏆 ${place.perp.place}` : "—";
  // За что именно место — по прибыли, доходности, винрейту или активности.
  // Доски кошелька — всегда за 30 дней; окно подписано, чтобы «+$412K» не
  // читалось как прибыль за всё время.
  const board = place.best
    ? `${bare(t(lang, boardKey(place.best.kind)))} · 30 ${t(lang, "rk_days")}`
    : t(lang, "wl_not_ranked");
  // Строка доски, по которой кошелёк туда попал: место само по себе ничего
  // не говорит, а прибыль, доходность и винрейт за окно — говорят.
  const top = place.best?.row;
  const hold = top ? holdHours(top.hold) : null;

  return (
    <Frame title={w.name} sub={shortAddr(w.addr)}>
      <Card>
        <AddrBar
          addr={w.addr}
          label={bare(t(lang, "ton_step_address"))}
          copy={t(lang, "ui_copy")}
          onDone={(ok) =>
            ok ? toast(t(lang, "ui_copied")) : toast(t(lang, "ui_copy_failed"), "err")
          }
        />
      </Card>

      <Card>
        <SectionTitle note={board}>{t(lang, "rk_in_top")}</SectionTitle>
        <Tiles
          items={[
            {
              label: <><VenueMark venue="spot" size={13} />{t(lang, "wl_spot_rank")} · {venueName("spot")}</>,
              value: spot,
              tone: place.spot === null ? "dim" : undefined,
            },
            {
              label: <><VenueMark venue="perp" size={13} />{t(lang, "wl_perp_rank")} · {venueName("perp")}</>,
              value: perp,
              tone: place.perp === null ? "dim" : undefined,
            },
          ]}
        />
        {top ? (
          <>
            <p className={`big ${top.pnl >= 0 ? "up" : "dn"}`}>{signed(top.pnl)}</p>
            <Tiles
              items={[
                { label: t(lang, "hl_rk_roi_account"), value: pct(top.roi, 1) },
                { label: t(lang, "ws_winrate"), value: `${num(top.win)}%` },
                { label: t(lang, "rk_trades"), value: num(top.tr) },
                {
                  label: t(lang, "rk_avg_hold"),
                  value: hold === null ? "—" : `${hold}${t(lang, "unit_hour")}`,
                },
              ]}
            />
            {top.lev ? (
              <Tiles items={[{ label: t(lang, "hl_rk_leverage"), value: `${top.lev}×` }]} />
            ) : null}
          </>
        ) : null}
      </Card>

      <Card>
        {/* Депозит складывается из трёх частей: спот, перпы и акции (HIP-3). */}
        <SectionTitle note={usd(w.bal)}>{t(lang, "hl_account")}</SectionTitle>
        <Tiles
          items={[
            { label: t(lang, "ai_spot"), value: usd(eq.spot) },
            { label: t(lang, "ai_perp"), value: usd(eq.perp) },
            { label: t(lang, "ui_hip3"), value: usd(eq.hip3), tone: eq.hip3 ? undefined : "dim" },
            { label: t(lang, "rk_trades"), value: num(w.trades) },
          ]}
        />
        {paused ? <p className="note warn">{t(lang, "mw_free_notice1")}</p> : null}
      </Card>

      <Card>
        <SectionTitle note={w.pos.length ? `${w.pos.length}` : undefined}>
          {t(lang, "hl_open_positions")}
        </SectionTitle>
        {w.pos.length === 0 ? (
          <Empty text={t(lang, "hl_no_open_positions")} />
        ) : (
          w.pos.map((p, i) => (
            <Row
              key={`${p.sym}-${i}`}
              icon={<CoinIcon sym={p.sym} size={30} />}
              title={p.sym}
              badge={p.long ? t(lang, "hl_side_long") : t(lang, "hl_side_short")}
              sub={
                <>
                  {levFmt(p.lev)} · {p.isolated ? t(lang, "hl_isolated") : t(lang, "hl_cross")}
                </>
              }
              // Вход и текущая цена не влезали в одну строку с плечом и
              // обрезались на «Вх…». Вторая строка вмещает обе цены целиком.
              sub2={
                <>
                  {t(lang, "hl_entry_price")} {px(p.entry)} → {px(p.now)}
                </>
              }
              value={signed(p.pnl)}
              tone={p.pnl >= 0 ? "up" : "dn"}
              valueSub={pct(p.pct)}
              onClick={() => open("position", w.addr, String(i))}
            />
          ))
        )}
      </Card>

      <Card>
        <div className="stack-actions">
          {!w.primary ? (
            <Action
              kind="ghost"
              onClick={async () => {
                const res = await setPrimary(w.addr);
                if (res?.ok) {
                  toast(t(lang, "toast_main_wallet_set"));
                  void syncNow();
                } else toast(t(lang, "generic_error_retry"), "err");
              }}
            >
              {t(lang, "wl_main_wallet")}
            </Action>
          ) : null}
          <Action kind="ghost" onClick={() => open("rename", w.addr)}>
            {t(lang, "rename_title")}
          </Action>
          <Action
            kind="danger"
            onClick={async () => {
              const res = await removeWallet(w.addr);
              if (res?.ok) {
                toast(t(lang, "toast_wallet_removed"));
                back();
                void syncNow();
              } else toast(t(lang, "generic_error_retry"), "err");
            }}
          >
            {t(lang, "remove_yes")}
          </Action>
          <small className="hint">{t(lang, "remove_confirm_notice")}</small>
        </div>
      </Card>
    </Frame>
  );
}
