/*
 * Рынки сверху бокового меню — виджеты TradingView, сетка 2 × 3:
 * US 500, US 100 · DXY, золото · US 10Y, DVOL.
 *
 * Права: котировки показывает TradingView по своим лицензиям — мы их не
 * берём и не храним; ссылка «TradingView» под сеткой и их значок в каждом
 * окне — как требует TradingView (убирать и менять нельзя). Сами индексы
 * S&P 500, Nasdaq-100, VIX и DXY ICE TradingView в виджетах не показывает
 * («only available on TradingView»), поэтому US 500, US 100 и DXY — CFD
 * Capital.com, как их и называет TradingView; US 10Y — FRED (раз в день),
 * DVOL — Deribit по договору TradingView. Об этом — «ⓘ».
 *
 * Безопасность: чужой код в наше приложение не грузится — окна TradingView
 * строим сами (тот же адрес, что делает их скрипт), в песочнице, и с чужого
 * источника им не видно ни наших данных, ни данных входа Telegram. Скрипт
 * TradingView отправил бы им весь адрес страницы — а в нём у Telegram
 * данные входа (#tgWebAppData); мы отдаём только домен и путь.
 *
 * Окна создаются, только когда меню открыто (меню монтируется по открытию).
 *
 * Размер: виджету TradingView нужно TV_W точек ширины — уже он обрезает
 * подписи и прячет цифры под своим значком. В меню ячейка уже, поэтому окно
 * получает свои TV_W точек и уменьшается целиком (со значком) до ширины
 * ячейки — как масштаб страницы, ничего не обрезая.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import type { DictKey } from "../i18n/types";
import { openExternal } from "../lib/telegram";
import { TV_H, TV_LOCALE, TV_SANDBOX, TV_SITE, TV_SYMBOLS, TV_W, tvScale, tvSrc } from "../lib/tv";

const isKey = (l: string): l is DictKey => l.startsWith("mk_");

export function MarketsStrip() {
  const lang = useApp((s) => s.lang);
  const [open, setOpen] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.72);
  useLayoutEffect(() => {
    const el = grid.current?.firstElementChild;
    if (!el) return;
    const fit = () => setK(tvScale(el.getBoundingClientRect().width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { host, pathname } = location;
  const site = `${TV_SITE}?utm_source=${encodeURIComponent(host)}&utm_medium=widget&utm_campaign=tickers`;
  return (
    <section className="mk" aria-label={t(lang, "mk_title")}>
      <div className="mk-grid" ref={grid}>
        {TV_SYMBOLS.map(({ s, t: l }) => {
          const name = isKey(l) ? t(lang, l) : l;
          return (
            <div key={s} className="mk-cell" style={{ height: TV_H * k }}>
              <iframe className="mk-tv" data-s={s} title={`${name} — TradingView`}
                src={tvSrc(s, name, TV_LOCALE[lang], host, pathname)}
                style={{ width: TV_W, height: TV_H, transform: `scale(${k})` }}
                sandbox={TV_SANDBOX} referrerPolicy="strict-origin-when-cross-origin" scrolling="no" />
            </div>
          );
        })}
      </div>
      <p className="mk-src">
        <span className="mk-nw">
          <a href={site} rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); openExternal(site); }}>{t(lang, "mk_tv")}</a>
          <button type="button" className="mk-i" aria-expanded={open} aria-label={t(lang, "mk_about")}
            onClick={() => setOpen((o) => !o)}>ⓘ</button>
        </span>
      </p>
      {open ? <p className="mk-notes">{t(lang, "mk_tv_note")}</p> : null}
    </section>
  );
}
