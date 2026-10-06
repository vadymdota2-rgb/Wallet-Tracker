/**
 * Карточка кошелька: остаток, открытые позиции, действия.
 *
 * Позиции и остаток спрашиваем здесь и только здесь. В общей выдаче их нет:
 * ходить в Hyperliquid за каждым кошельком при каждом открытии приложения
 * незачем — смотрят их, когда откроют сам кошелёк.
 */
import { useEffect } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive, walletByAddr } from "../store/live";
import { boardKey, venueName, walletRank } from "../lib/rank";
import { bare, t } from "../i18n/t";
import { lev as levFmt, num, pct, px, shortAddr, signed, since, usd } from "../lib/format";
import { openExternal } from "../lib/telegram";
import { holdTime } from "../lib/labels";
import { fetchWallet, removeWallet, setPrimary } from "../lib/api";
import { applyWalletLive } from "../lib/prefetch";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { CoinIcon } from "../components/CoinIcon";
import { Action, AddrBar, Card, Empty, EyeGlyph, Row, SectionTitle, Tiles, VenueMark } from "../components/ui";

export function WalletScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const back = useApp((s) => s.back);
  const wallets = useLive((s) => s.wallets);
  const rank = useLive((s) => s.rank);

  const w = walletByAddr(wallets, arg);
  const addr = w?.addr ?? "";

  useEffect(() => {
    if (!addr) return;
    const ctrl = new AbortController();
    // Живые данные обычно уже в хранилище — их принесла подгрузка при
    // запуске; здесь только освежаем, если они старше минуты.
    void fetchWallet(addr, ctrl.signal).then((d) => {
      if (!ctrl.signal.aborted) applyWalletLive(addr, d);
    });
    return () => ctrl.abort();
  }, [addr]);

  if (!w) {
    return (
      <Frame title={t(lang, "err_wallet_not_found")}>
        <Empty text={t(lang, "err_loading_wallet")} />
      </Frame>
    );
  }

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
  const hold = holdTime(top?.hold, lang);

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
              label: <><VenueMark venue="spot" size={13} />{t(lang, "wl_spot_rank")} · {venueName("spot")} DEX</>,
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
            <Tiles
              items={[
                // PnL такой же плиткой, как остальные: отдельной крупной
                // строкой он читался заголовком карточки, а это такой же
                // показатель доски, как винрейт или число сделок.
                { label: "PnL", value: signed(top.pnl), tone: top.pnl >= 0 ? "up" : "dn" },
                // Набор полей как в боте: у фьючерсов среднее плечо и нет
                // срока удержания, у спота наоборот. Показывать пустую
                // плитку с прочерком там, где показателя не бывает, — врать
                // о том, что данные потерялись.
                // ROI — только по фьючерсам: см. TraderScreen. По BSC
                // знаменатель недостоверен, показываем абсолютный PnL.
                ...(place.best?.venue === "perp"
                  ? [{ label: t(lang, "rk_roi_per_trade"), value: pct(top.roi, 1) }]
                  : []),
                { label: t(lang, "ws_winrate"), value: `${num(top.win)}%` },
                { label: t(lang, "rk_trades"), value: num(top.tr) },
                place.best?.venue === "perp"
                  ? { label: t(lang, "hl_rk_leverage"), value: top.lev ? `${top.lev}×` : "—" }
                  : { label: t(lang, "rk_avg_hold"), value: hold ?? "—" },
                ...(top.top
                  ? [{
                      label: bare(t(lang, "rk_in_top")),
                      value: `${num(top.top)} ${t(lang, "rk_days")}`,
                    }]
                  : []),
              ]}
            />
          </>
        ) : null}
      </Card>

      <Card>
        {/* Как в боте: одна цифра, общий баланс счёта. Разбивку по споту,
            перпам и акциям убрали — спот приходил количеством токенов, и
            сумма выходила фантастической. */}
        <SectionTitle note={`${bare(t(lang, "rk_trades"))} · ${num(w.trades)}`}>
          {t(lang, "hl_account")}
        </SectionTitle>
        <p className="big">{usd(w.bal)}</p>
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
              // Глазок на самом краю, как в списке кошельков: он говорит, что
              // строку можно открыть, и место у него всегда одно.
              after={<EyeGlyph size={18} />}
              onClick={() => open("position", w.addr, String(i))}
            />
          ))
        )}
      </Card>

      {w.holds?.length ? (
        <Card>
          <SectionTitle note={String(w.holds.length)}>{t(lang, "ui_spot_open")}</SectionTitle>
          {w.holds.map((h, i) => (
            <Row
              key={h.token}
              icon={<CoinIcon sym={h.sym} icon={h.icon} size={30} />}
              title={h.sym}
              // Метка неполной истории: цена входа и вложенное занижены, и
              // это видно сразу, а не после вопроса «почему так».
              badge={h.partial ? t(lang, "ui_partial_tag") : undefined}
              sub={`${t(lang, "ui_invested")} ${h.partial ? "≈ " : ""}${usd(h.cost)}`}
              sub2={`${t(lang, "hl_entry_price")} ${h.partial ? "≈ " : ""}${px(h.entry)} → ${px(h.price)}`}
              value={signed(h.pnl)}
              tone={h.pnl >= 0 ? "up" : "dn"}
              valueSub={pct(h.pct)}
              after={<EyeGlyph size={18} />}
              onClick={() => open("spot", w.addr, String(i))}
            />
          ))}
        </Card>
      ) : null}

      {/* Заводы на биржи и выводы с бирж (BSC): завод часто бывает перед
          продажей, вывод — после покупки. */}
      {w.cex?.length ? (
        <Card>
          <SectionTitle note={String(w.cex.length)}>{t(lang, "wl_cex_moves")}</SectionTitle>
          {w.cex.map((m, i) => (
            <Row
              key={`${m.tx}-${i}`}
              icon={<CoinIcon sym={m.sym} size={30} />}
              title={`${m.wd ? "+" : "−"}${num(m.qty, m.qty >= 1000 ? 0 : 2)} ${m.sym}`}
              sub={t(lang, m.wd ? "btc_wd_from" : "btc_dep_to", { ex: m.ex })}
              sub2={since(Math.floor(Date.now() / 1000) - m.t)}
              value={m.v ? usd(m.v) : "—"}
              tone={m.wd ? "up" : "dn"}
              onClick={() => openExternal(`https://bscscan.com/tx/${m.tx}`)}
            />
          ))}
        </Card>
      ) : null}

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
              {t(lang, "ui_set_main")}
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
