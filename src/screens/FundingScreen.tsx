/**
 * Фандинг — отдельным экраном в боковом меню, сразу под картой ликвидаций.
 *
 * Раньше он был плиткой «Аналитики», но по смыслу ближе к карте: и то и
 * другое — про фьючерсы и плечо, про то, кто и сколько платит за позицию.
 * Доступ тот же — по подписке, как всё, что про фьючерсы.
 */
import { useEffect, useState } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import type { LangCode } from "../i18n/types";
import { haptic } from "../lib/telegram";
import { useNow } from "../lib/tick";
import { num, pct, usd } from "../lib/format";
import { fundingSideKey, showSym } from "../lib/labels";
import { CoinIcon } from "../components/CoinIcon";
import { Card, Chips, Empty, Locked, Row, SectionTitle, Skeleton, VenueReel } from "../components/ui";
import { fetchFund } from "../lib/api";
import { syncNow } from "../lib/sync";
import type { FundRow } from "../lib/types";
import { Frame } from "./Screen";

export function FundingScreen() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const premium = useLive((s) => s.me.plan === "premium");
  return (
    <Frame title={t(lang, "ui_tab_funding")}>
      <Card>
        <SectionTitle note={t(lang, "fund_hint")}>{t(lang, "fund_title")}</SectionTitle>
        {premium ? (
          <FundBody />
        ) : (
          <Locked
            text={t(lang, "hl_locked_body")}
            cta={t(lang, "mw_upgrade")}
            onCta={() => open("premium", "perp")}
          />
        )}
      </Card>
    </Frame>
  );
}

/**
 * Биржи фандинга. Порядок и названия — здесь, а не на сервере: сервер
 * отдаёт только те доски, которые собрались, и приложение показывает кнопки
 * ровно для них. Биржа, до которой сервер не достучался, не появляется —
 * пустая вкладка с её именем выглядела бы как поломка у нас.
 *
 * Значок — монета самой биржи там, где она есть: HYPE у Hyperliquid, BNB у
 * Binance. Рисовать чужие логотипы по памяти хуже, чем честная буква в
 * кружке, которую CoinIcon и поставит.
 */
const FUND_VENUES: { id: string; name: string; logo: string }[] = [
  { id: "hl", name: "Hyperliquid", logo: "/cglogo/markets/images/1571/small/PFP.png" },
  { id: "binance", name: "Binance", logo: "/cglogo/markets/images/52/small/binance.jpg" },
  { id: "bybit", name: "Bybit", logo: "/cglogo/markets/images/698/small/bybit_spot.png" },
  { id: "okx", name: "OKX", logo: "/cglogo/markets/images/96/small/WeChat_Image_20220117220452.png" },
  { id: "bitget", name: "Bitget", logo: "/cglogo/markets/images/540/small/2023-07-25_21.47.43.jpg" },
  { id: "bingx", name: "BingX", logo: "/cglogo/markets/images/812/small/YtFwQwJr_400x400.jpg" },
  { id: "gate", name: "Gate", logo: "/cglogo/markets/images/60/small/Frame_1.png" },
  { id: "mexc", name: "MEXC", logo: "/cglogo/markets/images/409/small/164286be-32a5-4b58-978c-d072eea00eb9.jpeg" },
  { id: "kucoin", name: "KuCoin", logo: "/cglogo/markets/images/61/small/kucoin.png" },
  { id: "kraken", name: "Kraken", logo: "/cglogo/markets/images/29/small/kraken.jpg" },
  { id: "coinbase", name: "Coinbase", logo: "/cglogo/markets/images/23/small/Coinbase_Coin_Primary.png" },
  { id: "aster", name: "Aster", logo: "/cglogo/markets/images/22084/small/aster-profile-200.png" },
];

const venueName = (ex: string) => FUND_VENUES.find((v) => v.id === ex)?.name ?? ex;

/**
 * Как часто биржа платит. Отдельной подписью для часа: «каждые 1 ч» — это не
 * по-русски, а раз в час платит Hyperliquid, то есть половина списка.
 */
function everyLabel(lang: LangCode, per: number): string {
  const hours = Math.round(24 / (per || 1));
  return hours <= 1
    ? t(lang, "fund_hourly")
    : t(lang, "fund_every", { h: String(hours) });
}

/** Ставка за выплату: у часовых она сотые доли процента, у восьмичасовых — целые. */
const payRate = (v: number) => pct(Math.abs(v), Math.abs(v) < 0.1 ? 4 : 2, false);

/**
 * Сколько осталось до выплаты. До часа — минуты с секундами, дальше часы с
 * минутами: секунды на третьем часу никому не нужны, а в последние минуты
 * именно они и нужны.
 */
function leftTime(lang: LangCode, sec: number): string {
  if (sec <= 0) return t(lang, "flow_now");
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const body = h > 0
    ? `${h}${t(lang, "unit_hour")} ${String(m).padStart(2, "0")}${t(lang, "unit_min")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
  return t(lang, "fund_in", { t: body });
}

/**
 * Часы до следующей выплаты. Своим маленьким компонентом, а не строкой в
 * подписи: раз в секунду перерисовывается только он, а не сорок строк со
 * значками монет.
 */
function FundCountdown({ at }: { at: number }) {
  const lang = useApp((s) => s.lang);
  const now = useNow();
  return <i className="nb fund-left">{leftTime(lang, at - now)}</i>;
}

/**
 * Частота коротко: «/4 ч». Деньги за выплату длиннее ставки, и со словами
 * («$18,72 каждые 4 ч») хвост уезжал под правый столбец. Рядом с суммой за
 * сутки строкой ниже косая черта читается однозначно.
 */
const everyShort = (lang: LangCode, per: number) =>
  `/${Math.round(24 / (per || 1))}${t(lang, "unit_hour")}`;

/**
 * Суточная ставка. Сервер прошлой версии присылал годовые — пока он не
 * перезапущен, суточные выводятся из них делением: строка с прочерком вместо
 * числа выглядела бы как сломанный раздел, хотя данные пришли.
 */
const dayRate = (f: FundRow) =>
  typeof f.day === "number" ? f.day : (f.apr ?? 0) / 365;

/** Строк на странице доски. Столько же сервер кладёт в общую выгрузку. */
const FUND_PAGE = 20;

/** Быстрые суммы: столько, сколько обычно и заводят. */
const CALC_STEPS = [100, 1000, 10_000, 100_000];
/** Быстрые плечи: единица — это «без плеча», дальше привычные ступени. */
const CALC_LEVS = [1, 3, 5, 10, 25];

/**
 * Сколько своих денег и с каким плечом — для всего списка сразу.
 *
 * Фандинг платят с объёма позиции, а не со своих денег: вошёл сотней на
 * пятом плече — платишь и получаешь как за пятьсот. Поэтому полей два, а
 * под ними стоит объём, от которого и считаются деньги в строках.
 *
 * Поля одни на все монеты, а не свои у каждой: сумма у человека одна, а
 * сравнить он хочет, что она принесёт на разных монетах. Своя кнопка у
 * каждой строки заставляла бы вводить её заново и, главное, отнимала у
 * строки ширину — на узком экране от подписи оставались обрывки.
 *
 * Пустое поле — это пустые строки: пока человек не назвал сумму, в списке
 * стоят проценты. Подставлять свою значило бы показать ему чужой счёт.
 */
function FundCalcBar() {
  const lang = useApp((s) => s.lang);
  const amount = useApp((s) => s.fundAmount);
  const setAmount = useApp((s) => s.setFundAmount);
  const lev = useApp((s) => s.fundLev);
  const setLev = useApp((s) => s.setFundLev);
  const [text, setText] = useState(amount ? String(amount) : "");
  const [levText, setLevText] = useState(lev > 1 ? String(lev) : "");

  /* Пробелы и запятые — то, как числа пишут руками; цифры из них достаём
     сами, иначе поле выглядит сломанным. */
  const parse = (v: string) => Number(v.replace(/\s/g, "").replace(",", ".")) || 0;

  return (
    <div className="calc">
      <div className="calc-row">
        <label className="calc-in">
          <span>{t(lang, "calc_amount")}</span>
          <input
            value={text}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^\d.,\s]/g, "");
              setText(raw);
              setAmount(parse(raw));
            }}
            inputMode="decimal"
            placeholder="100"
            aria-label={t(lang, "calc_amount")}
          />
        </label>
        <label className="calc-in calc-lev">
          <span>{t(lang, "calc_lev")}</span>
          <input
            value={levText}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
              setLevText(raw);
              setLev(Number(raw) || 1);
            }}
            inputMode="numeric"
            placeholder="1"
            aria-label={t(lang, "calc_lev")}
          />
        </label>
      </div>
      <Chips<number>
        value={amount}
        options={CALC_STEPS.map((v) => ({ id: v, label: usd(v) }))}
        onChange={(v) => {
          setAmount(v);
          setText(String(v));
        }}
      />
      <Chips<number>
        value={lev}
        options={CALC_LEVS.map((v) => ({ id: v, label: `${v}×` }))}
        onChange={(v) => {
          setLev(v);
          setLevText(v > 1 ? String(v) : "");
        }}
      />
      {/* Объём позиции — то число, с которого биржа берёт фандинг. Без него
          «сто долларов на пятом плече» и деньги в строках не сходятся. */}
      {amount > 0 ? (
        <p className="calc-size">
          {t(lang, "calc_size")} <b>{usd(amount * lev)}</b>
        </p>
      ) : null}
      {/* Оговорка одна на список: цена за это время тоже ходит, и её движение
          может перекрыть любую ставку. Обещать заработок нельзя. */}
      <p className="calc-note">{t(lang, "calc_note")}</p>
    </div>
  );
}

/**
 * Ставок ещё нет: сервер только что перезапущен или первая выгрузка ушла
 * раньше, чем он опросил биржи. Раньше здесь стояло «сейчас нет сильных
 * аномалий» — неправда, данных просто не было, — а следующий опрос сервера
 * был через три минуты. Теперь экран сам переспрашивает с растущей паузой,
 * а через минуту без ответа честно говорит, что не получилось.
 */
const WAIT_STEPS = [3_000, 5_000, 8_000, 12_000, 15_000, 20_000];

function FundWaiting() {
  const lang = useApp((s) => s.lang);
  const [step, setStep] = useState(0);
  const failed = step >= WAIT_STEPS.length;

  useEffect(() => {
    if (failed) return;
    const id = setTimeout(() => {
      void syncNow().finally(() => setStep((n) => n + 1));
    }, WAIT_STEPS[step]);
    return () => clearTimeout(id);
  }, [step, failed]);

  if (failed) {
    return (
      <Empty
        text={t(lang, "fund_fail")}
        hint={
          <button type="button" className="lq-retry" onClick={() => setStep(0)}>{t(lang, "ui_retry")}</button>
        }
      />
    );
  }
  return (
    <>
      <p className="fund-wait">{t(lang, "fund_wait")}</p>
      <Skeleton rows={5} />
    </>
  );
}

/**
 * Фандинг: где сейчас перекос и на какую сторону.
 *
 * Раздел был про одну биржу — Hyperliquid, — и её значок стоял уголком
 * плитки. Бирж теперь несколько, поэтому уголка нет, а выбор площадки стоит
 * внутри раздела первой строкой. Биржи выбирают по одной: общая доска со
 * всех сразу оказалась перечнем повторов — одна монета стояла в ней по разу
 * на биржу, и биржа была единственным, чем строки различались.
 *
 * Перекосы показываются все, а не верхние сорок: список листается
 * страницами, первая приходит с общей выгрузкой, остальные — запросом.
 *
 * Сравнивать ставки между биржами можно только приведя их к одному сроку:
 * Hyperliquid платит каждый час, остальные — раз в четыре или восемь, и одна
 * и та же цифра означает у них разное. Срок этот — сутки: в годовых те же
 * ставки дают «-1971%», а это не перекос, а бессмыслица — ставка держится
 * часы, а не год. Поэтому главное число строки — процент в сутки, а ставка
 * за выплату и её частота стоят подписью: по ним видно, откуда он взялся.
 */
function FundBody() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const fund = useLive((s) => s.fund);
  const counts = useLive((s) => s.fundN);
  /* Деньги в строках считаются с объёма позиции: биржа берёт фандинг с него,
     а не с того, что человек внёс своего. */
  const amount = useApp((s) => s.fundAmount) * useApp((s) => s.fundLev);

  const have = FUND_VENUES.filter((v) => (fund[v.id] ?? []).length > 0);
  /* Биржа не выбрана или её доска опустела — берём первую, что есть: пустой
     раздел с выбранной биржей выглядит поломкой, хотя выбор просто устарел. */
  const [want, setEx] = useState("");
  const ex = have.some((v) => v.id === want) ? want : (have[0]?.id ?? "");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState<FundRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  /* Страница не пришла — это сбой сети, а не «нет аномалий». */
  const [pageErr, setPageErr] = useState(false);
  const [again, setAgain] = useState(0);

  // Сменилась биржа — это другая доска, и она с начала.
  useEffect(() => {
    setPage(1);
    setMore(null);
  }, [ex]);

  useEffect(() => {
    if (!ex || page === 1) {
      setMore(null);
      setBusy(false);
      setPageErr(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    setPageErr(false);
    void fetchFund(ex, (page - 1) * FUND_PAGE, FUND_PAGE, ctrl.signal).then((r) => {
      if (ctrl.signal.aborted) return;
      setMore(r?.ok ? r.rows ?? [] : []);
      setPageErr(!r?.ok);
      setBusy(false);
    });
    return () => ctrl.abort();
  }, [ex, page, again]);

  const first = fund[ex] ?? [];
  const total = counts[ex] ?? first.length;
  const pages = Math.max(1, Math.ceil(total / FUND_PAGE));
  const at = Math.min(page, pages);
  const rows = at === 1 ? first : more ?? [];

  const go = (to: number) => {
    if (to < 1 || to > pages || to === at || busy) return;
    haptic("select");
    setPage(to);
  };

  if (!have.length) return <FundWaiting />;

  return (
    <>
      <VenueReel<string>
        value={ex}
        onChange={setEx}
        label={t(lang, "fund_title")}
        options={have.map((v) => ({
          id: v.id,
          /* Логотип биржи идёт через тот же кружок, что и монеты: если
             картинка не дойдёт, на её месте останется буква, а не пустота. */
          ic: <CoinIcon sym={v.name} icon={[v.logo]} size={28} />,
          label: v.name,
        }))}
      />
      <FundCalcBar />
      {busy && !rows.length ? <Skeleton rows={4} /> : null}
      {!busy && rows.length === 0 ? (
        pageErr ? (
          <Empty text={t(lang, "fund_fail")} hint={
            <button type="button" className="lq-retry" onClick={() => setAgain((n) => n + 1)}>{t(lang, "ui_retry")}</button>
          } />
        ) : <Empty text={t(lang, "fund_empty")} />
      ) : (
        /* Подписи здесь переносятся, а не обрезаются многоточием, как в
           остальных списках: в них стоит объяснение числа — сколько платят и
           как часто, — и обрубок «0,0749% каж…» не объясняет ничего. */
        <div className="fund-rows">{rows.map((f) => (
          <Row
            key={`${f.ex}-${f.sym}`}
            icon={<CoinIcon sym={f.sym} size={30} />}
            title={showSym(f.sym)}
            /* Биржа — меткой у названия: на общей доске одна монета стоит
               несколькими строками, и различает их только она. */
            badge={venueName(f.ex)}
            /* Кто кому платит и откуда взялся суточный процент: ставка за
               выплату и то, как часто её платят. */
            /* Введена сумма — на месте ставки за выплату стоят деньги за ту
               же выплату: это она и есть, только в долларах, и держать рядом
               оба числа значит занимать строку дважды одним и тем же. */
            sub={
              /* Разделители — промежутки, а не точки в тексте: подпись здесь
                 переносится, и точка оставалась висеть в конце обрывка.
                 Число с частотой — одним куском: перенос между «4» и «ч»
                 рвал именно то, ради чего эта подпись и стоит. */
              <span className="fund-sub">
                <i>{t(lang, fundingSideKey(f.rate))}</i>
                <i className={amount > 0 ? "nb calc-pay" : "nb"}>
                  {amount > 0
                    ? `${usd((amount * Math.abs(f.rate)) / 100)}${everyShort(lang, f.per)}`
                    : `${payRate(f.rate)} ${everyLabel(lang, f.per)}`}
                </i>
              </span>
            }
            /* Ликвидность второй строкой, а не в одну с первой: вместе они
               обрывались на многоточии ровно там, где стояла сумма. Биржа
               отдаёт что-то одно — открытый интерес или оборот. */
            sub2={
              <span className="fund-sub">
                {/* Суточные деньги — тоже слева, а не под процентом справа:
                    правый столбец от них разъезжался, и подписи слева
                    оставалось меньше ста пикселей. */}
                {amount > 0 ? (
                  <i className="nb calc-pay">
                    {usd((amount * Math.abs(dayRate(f))) / 100)} {t(lang, "fund_daily")}
                  </i>
                ) : null}
                <i className="nb">
                  {f.oi > 0
                    ? `${t(lang, "fund_oi")} ${usd(f.oi)}`
                    : `${t(lang, "fund_vol")} ${usd(f.vol)}`}
                </i>
                {/* Когда спишут следующую: до неё ставка ещё может уйти в
                    другую сторону, и через минуту заплатят не то, что тут
                    написано. Без этого числа строка про «в сутки» обещает
                    больше, чем знает. */}
                {f.next ? <FundCountdown at={f.next} /> : null}
              </span>
            }
            value={pct(dayRate(f), 2)}
            tone={dayRate(f) >= 0 ? "up" : "dn"}
            valueSub={t(lang, "fund_daily")}
            onClick={() => open("coin", f.sym)}
          />
        ))}</div>
      )}

      {pages > 1 ? (
        <nav className="pager" aria-label={t(lang, "fund_title")}>
          <button type="button" disabled={at <= 1 || busy} onClick={() => go(at - 1)}
                  aria-label={t(lang, "back_button")}>←</button>
          <span>{num(at)} / {num(pages)}</span>
          <button type="button" disabled={at >= pages || busy} onClick={() => go(at + 1)}
                  aria-label={t(lang, "ui_show_more")}>→</button>
        </nav>
      ) : null}
    </>
  );
}
