/**
 * Дайджест: раз в сутки — самое крупное из каждой вкладки аналитики и
 * ближайшие разлоки. Сверху свежий выпуск целиком, ниже — прошлые (всего
 * тридцать), свёрнутыми: открывается тот, что нужен.
 *
 * Всё, что в выпуске, посчитал сервер в полночь UTC и больше не трогает:
 * это снимок того, что было на экранах, а не живая выборка. Поэтому ни одна
 * строка не пишет «5 мин назад» — только размер события и окно выпуска.
 *
 * Разделы про фьючерсы Hyperliquid закрыты подпиской, как и сами вкладки:
 * без неё сервер присылает только отметку, что раздел есть.
 *
 * Под каждым выпуском — лайки и комментарии. Лайк меняется сразу, не
 * дожидаясь сервера, и откатывается, если тот отказал.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { pct, usd } from "../lib/format";
import { haptic } from "../lib/telegram";
import {
  commentDigest,
  fetchDigest,
  fetchDigestComments,
  likeDigest,
  peekDigest,
  uncommentDigest,
} from "../lib/api";
import { CoinIcon } from "../components/CoinIcon";
import {
  Action,
  Empty,
  FundingGlyph,
  NetFlowGlyph,
  OrdersGlyph,
  PositionsGlyph,
  RotationGlyph,
  Row,
  SectionTitle,
  Skeleton,
  StackGlyph,
  UnlockGlyph,
} from "../components/ui";
import type {
  DigestActReply,
  DigestComment,
  DigestCoin,
  DigestItem,
  DigestLocked,
  DigestReply,
} from "../lib/types";

type Lang = Parameters<typeof t>[0];

const COMMENT_MAX = 500;

const isLocked = (v: unknown): v is DigestLocked =>
  typeof v === "object" && v !== null && (v as DigestLocked).locked === true;

/** Время по часам телефона на языке приложения: «03:00». Выпуск выходит в
 *  полночь UTC; «12:00 AM» по-английски читается хуже, чем «00:00». */
function clock(lang: Lang, tsSec: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(tsSec * 1000));
  } catch {
    return new Date(tsSec * 1000).toISOString().slice(11, 16);
  }
}

/** Дата выпуска словами: «30 сентября». */
function dateWord(lang: Lang, tsSec: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(new Date(tsSec * 1000));
  } catch {
    return new Date(tsSec * 1000).toISOString().slice(0, 10);
  }
}

/** Ближайшая полночь UTC — когда выйдет следующий выпуск. */
function nextIssue(nowSec: number): number {
  return Math.floor(nowSec / 86400) * 86400 + 86400;
}

/** Что сервер ответил отказом — словами. */
function actError(lang: Lang, r: DigestActReply | null): string {
  if (!r) return t(lang, "dg_err_net");
  switch (r.error) {
    case "links":
      return t(lang, "dg_err_links");
    case "too_fast":
      return t(lang, "dg_err_fast", { n: r.wait ?? 20 });
    case "day_limit":
      return t(lang, "dg_err_day", { n: r.max ?? 30 });
    case "too_long":
      return t(lang, "dg_err_long", { n: r.max ?? COMMENT_MAX });
    case "muted":
      return t(lang, "dg_err_muted");
    default:
      return t(lang, "dg_err_net");
  }
}

/** Раздел выпуска: значок вкладки, её имя и содержимое. */
function Sec({ icon, title, children }: { icon: ReactNode; title: ReactNode; children: ReactNode }) {
  return (
    <div className="dg-sec">
      <div className="dg-sec-head">
        <span className="dg-sec-ic" aria-hidden="true">{icon}</span>
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Quiet({ lang }: { lang: Lang }) {
  return <p className="dg-quiet">{t(lang, "dg_quiet")}</p>;
}

function LockedSec({ lang, onPremium }: { lang: Lang; onPremium: () => void }) {
  return (
    <button type="button" className="dg-locked" onClick={onPremium}>
      <span aria-hidden="true">🔒</span>
      <span>{t(lang, "dg_locked")}</span>
      <b>{t(lang, "menu_premium")}</b>
    </button>
  );
}

/** Подпись над короткими списками внутри раздела: «Приток», «Отток». */
function Sub({ children }: { children: ReactNode }) {
  return <p className="dg-sub">{children}</p>;
}

function CoinRow({
  c,
  sub,
  value,
  tone,
  onOpen,
}: {
  c: DigestCoin;
  sub?: ReactNode;
  value: ReactNode;
  tone?: "up" | "dn";
  onOpen?: () => void;
}) {
  return (
    <Row
      icon={<CoinIcon sym={c.sym} icon={c.icon} size={28} />}
      title={c.sym}
      sub={sub}
      value={value}
      tone={tone}
      onClick={onOpen}
    />
  );
}

function Sections({ it, lang, premium }: { it: DigestItem; lang: Lang; premium: boolean }) {
  const open = useApp((s) => s.open);
  const toPremium = () => open("premium");
  const coin = (c: DigestCoin) => () => open("coin", c.sym, c.addr);
  const chart = (sym: string) => () => open("chart", sym);

  const flow = it.flow;
  const rot = it.rot;
  const unl = it.unl ?? [];

  return (
    <>
      <Sec icon={<NetFlowGlyph size={20} />} title="NetFlow">
        {flow && (flow.in.length || flow.out.length) ? (
          <>
            {flow.net !== undefined ? (
              <p className="dg-sum">
                {t(lang, "dg_net")}{" "}
                <b className={flow.net >= 0 ? "q up" : "q dn"}>{usd(flow.net, true)}</b>
              </p>
            ) : null}
            {flow.in.length ? <Sub>{t(lang, "dg_in")}</Sub> : null}
            {flow.in.map((c) => (
              <CoinRow key={`i${c.sym}`} c={c} value={usd(c.net, true)} tone="up"
                sub={c.w ? t(lang, "dg_wallets", { n: c.w }) : undefined} onOpen={coin(c)} />
            ))}
            {flow.out.length ? <Sub>{t(lang, "dg_out")}</Sub> : null}
            {flow.out.map((c) => (
              <CoinRow key={`o${c.sym}`} c={c} value={usd(c.net, true)} tone="dn"
                sub={c.w ? t(lang, "dg_wallets", { n: c.w }) : undefined} onOpen={coin(c)} />
            ))}
          </>
        ) : (
          <Quiet lang={lang} />
        )}
      </Sec>

      <Sec icon={<OrdersGlyph size={20} />} title={t(lang, "ui_tab_orders")}>
        {it.spot?.length ? (
          it.spot.map((c, i) => (
            <CoinRow key={`s${i}`} c={c} value={usd(c.v)} tone={c.buy ? "up" : "dn"}
              sub={t(lang, c.buy ? "dg_buy" : "dg_sell")} onOpen={coin(c)} />
          ))
        ) : (
          <Quiet lang={lang} />
        )}
      </Sec>

      <Sec icon={<RotationGlyph size={20} />} title={t(lang, "ui_rotation")}>
        {rot && (rot.src.length || rot.dst.length) ? (
          <>
            {rot.usd ? (
              <p className="dg-sum">
                {t(lang, "dg_rot_sum", { v: usd(rot.usd), n: rot.pairs ?? 0, w: rot.w ?? 0 })}
              </p>
            ) : null}
            <div className="dg-pair">
              <div>
                <Sub>{t(lang, "dg_rot_src")}</Sub>
                {rot.src.map((r) => (
                  <button key={`rs${r.sym}`} type="button" className="dg-chip dn"
                    onClick={() => { haptic("select"); open("coin", r.sym); }}>
                    <CoinIcon sym={r.sym} size={18} />
                    <span>{r.sym}</span>
                    <em>{usd(r.usd)}</em>
                  </button>
                ))}
              </div>
              <div>
                <Sub>{t(lang, "dg_rot_dst")}</Sub>
                {rot.dst.map((r) => (
                  <button key={`rd${r.sym}`} type="button" className="dg-chip up"
                    onClick={() => { haptic("select"); open("coin", r.sym); }}>
                    <CoinIcon sym={r.sym} size={18} />
                    <span>{r.sym}</span>
                    <em>{usd(r.usd)}</em>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <Quiet lang={lang} />
        )}
      </Sec>

      <Sec icon={<PositionsGlyph size={20} />} title={t(lang, "ui_tab_ls")}>
        {isLocked(it.ls) || (!premium && it.ls === undefined) ? (
          <LockedSec lang={lang} onPremium={toPremium} />
        ) : it.ls && (it.ls.long.length || it.ls.short.length) ? (
          <>
            {it.ls.long.length ? <Sub>{t(lang, "dg_ls_long")}</Sub> : null}
            {it.ls.long.map((c) => (
              <CoinRow key={`l${c.sym}`} c={c} value={usd(c.net, true)} tone="up"
                sub={c.pct !== undefined ? t(lang, "dg_long_share", { p: pct(c.pct, 0, false) }) : undefined}
                onOpen={chart(c.sym)} />
            ))}
            {it.ls.short.length ? <Sub>{t(lang, "dg_ls_short")}</Sub> : null}
            {it.ls.short.map((c) => (
              <CoinRow key={`h${c.sym}`} c={c} value={usd(c.net, true)} tone="dn"
                sub={c.pct !== undefined ? t(lang, "dg_long_share", { p: pct(c.pct, 0, false) }) : undefined}
                onOpen={chart(c.sym)} />
            ))}
          </>
        ) : (
          <Quiet lang={lang} />
        )}
      </Sec>

      <Sec icon={<StackGlyph size={20} />} title={t(lang, "ui_tab_positions")}>
        {isLocked(it.perp) ? (
          <LockedSec lang={lang} onPremium={toPremium} />
        ) : it.perp?.length ? (
          it.perp.map((c, i) => (
            <CoinRow key={`p${i}`} c={c} value={usd(c.v)} tone={c.long ? "up" : "dn"}
              sub={t(lang, c.long ? "dg_long" : "dg_short")} onOpen={chart(c.sym)} />
          ))
        ) : (
          <Quiet lang={lang} />
        )}
      </Sec>

      <Sec icon={<FundingGlyph size={20} />} title={t(lang, "ui_tab_funding")}>
        {isLocked(it.fund) ? (
          <LockedSec lang={lang} onPremium={toPremium} />
        ) : it.fund && (it.fund.hi.length || it.fund.lo.length) ? (
          <>
            {it.fund.hi.length ? <Sub>{t(lang, "dg_fund_hi")}</Sub> : null}
            {it.fund.hi.map((f) => (
              <CoinRow key={`fh${f.sym}${f.ex}`} c={{ sym: f.sym }} sub={f.ex.toUpperCase()}
                value={pct(f.day, 3, true)} tone="up" onOpen={chart(f.sym)} />
            ))}
            {it.fund.lo.length ? <Sub>{t(lang, "dg_fund_lo")}</Sub> : null}
            {it.fund.lo.map((f) => (
              <CoinRow key={`fl${f.sym}${f.ex}`} c={{ sym: f.sym }} sub={f.ex.toUpperCase()}
                value={pct(f.day, 3, true)} tone="dn" onOpen={chart(f.sym)} />
            ))}
            <p className="dg-note">{t(lang, "dg_per_day")}</p>
          </>
        ) : (
          <Quiet lang={lang} />
        )}
      </Sec>

      <Sec icon={<UnlockGlyph size={20} />} title={t(lang, "dg_unl")}>
        {unl.length ? (
          unl.map((e) => (
            <Row
              key={`u${e.sym}${e.ts}`}
              icon={<CoinIcon sym={e.sym} size={28} />}
              title={e.sym}
              sub={dateWord(lang, e.ts)}
              value={e.usd ? usd(e.usd) : "—"}
              valueSub={e.pct !== null && e.pct !== undefined ? t(lang, "dg_unl_of", { p: pct(e.pct, 2, false) }) : undefined}
              onClick={() => open("unlocks")}
            />
          ))
        ) : (
          <Quiet lang={lang} />
        )}
      </Sec>
    </>
  );
}

function Comments({ it, lang, mod, muted, onCount }: {
  it: DigestItem;
  lang: Lang;
  mod: boolean;
  muted: boolean;
  onCount: (delta: number) => void;
}) {
  const [items, setItems] = useState<DigestComment[] | null>(null);
  const [more, setMore] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    void fetchDigestComments(it.id).then((r) => {
      if (!alive) return;
      setItems(r?.ok ? r.items : []);
      setMore(Boolean(r?.more));
    });
    return () => {
      alive = false;
    };
  }, [it.id]);

  const loadMore = async () => {
    const oldest = items?.[0];
    if (!items || !oldest) return;
    const r = await fetchDigestComments(it.id, oldest.id);
    if (r?.ok) {
      setItems([...r.items, ...items]);
      setMore(r.more);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr("");
    const r = await commentDigest(it.id, body);
    setBusy(false);
    if (r?.ok && r.item) {
      haptic("success");
      setItems([...(items ?? []), r.item]);
      setText("");
      onCount(1);
    } else {
      haptic("error");
      setErr(actError(lang, r));
    }
  };

  const remove = async (c: DigestComment, mute = false) => {
    const r = await uncommentDigest(c.id, mute);
    if (r?.ok) {
      haptic("select");
      setItems((items ?? []).filter((x) => x.id !== c.id));
      onCount(-1);
    }
  };

  const now = Date.now() / 1000;
  return (
    <div className="dg-com">
      {items === null ? (
        <Skeleton rows={2} />
      ) : items.length === 0 ? (
        <p className="dg-quiet">{t(lang, "dg_no_comments")}</p>
      ) : (
        <>
          {more ? (
            <button type="button" className="dg-more" onClick={() => void loadMore()}>
              {t(lang, "dg_more")}
            </button>
          ) : null}
          <ul className="dg-com-list">
            {items.map((c) => (
              <li key={c.id} className={c.mine ? "mine" : ""}>
                <div className="dg-com-head">
                  <b>{c.name}</b>
                  <time>{now - c.at < 86400 ? clock(lang, c.at) : dateWord(lang, c.at)}</time>
                </div>
                <p>{c.text}</p>
                {c.mine || mod ? (
                  <div className="dg-com-acts">
                    <button type="button" onClick={() => void remove(c)}>{t(lang, "dg_delete")}</button>
                    {mod && !c.mine ? (
                      <button type="button" onClick={() => void remove(c, true)}>{t(lang, "dg_mute")}</button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {muted ? (
        <p className="dg-note">{t(lang, "dg_err_muted")}</p>
      ) : (
        <div className="dg-form">
          <textarea
            value={text}
            maxLength={COMMENT_MAX}
            rows={2}
            placeholder={t(lang, "dg_ph")}
            onChange={(e) => {
              setText(e.target.value);
              if (err) setErr("");
            }}
          />
          <div className="dg-form-foot">
            <small>{err ? <span className="dg-err">{err}</span> : t(lang, "dg_rules")}</small>
            <Action onClick={() => void send()} disabled={busy || !text.trim()}>
              {t(lang, "dg_send")}
            </Action>
          </div>
        </div>
      )}
    </div>
  );
}

function DigestCard({ it, lang, premium, mod, muted, fresh }: {
  it: DigestItem;
  lang: Lang;
  premium: boolean;
  mod: boolean;
  muted: boolean;
  /** Свежий выпуск открыт сразу, прошлые — свёрнуты. */
  fresh: boolean;
}) {
  const [shown, setShown] = useState(fresh);
  const [talk, setTalk] = useState(false);
  const [likes, setLikes] = useState(it.likes);
  const [liked, setLiked] = useState(it.liked);
  const [count, setCount] = useState(it.comments);

  const like = async () => {
    haptic("select");
    const was = liked;
    setLiked(!was);
    setLikes((n) => n + (was ? -1 : 1));
    const r = await likeDigest(it.id);
    if (r?.ok && r.likes !== undefined) {
      setLiked(Boolean(r.liked));
      setLikes(r.likes);
    } else {
      setLiked(was);
      setLikes((n) => n + (was ? 1 : -1));
    }
  };

  return (
    <article className={`card dg-card${fresh ? " fresh" : ""}`}>
      <button
        type="button"
        className="dg-head"
        aria-expanded={shown}
        onClick={() => {
          haptic("select");
          setShown(!shown);
        }}
      >
        <span className="dg-date">
          {fresh ? <em>{t(lang, "dg_fresh")}</em> : null}
          <b>{dateWord(lang, it.to)}</b>
        </span>
        <small>{t(lang, "dg_window", { t: clock(lang, it.to) })}</small>
        <span className="dg-chev" aria-hidden="true">{shown ? "▴" : "▾"}</span>
      </button>
      {shown ? <Sections it={it} lang={lang} premium={premium} /> : null}
      <div className="dg-foot">
        <button type="button" className={`dg-like${liked ? " on" : ""}`} aria-pressed={liked}
          aria-label={t(lang, "dg_like")} onClick={() => void like()}>
          <span aria-hidden="true">{liked ? "♥" : "♡"}</span>
          <b>{likes}</b>
        </button>
        <button type="button" className={`dg-talk${talk ? " on" : ""}`} aria-expanded={talk}
          onClick={() => {
            haptic("select");
            setTalk(!talk);
          }}>
          <span aria-hidden="true">💬</span>
          <b>{count}</b>
          <small>{t(lang, "dg_comments")}</small>
        </button>
      </div>
      {talk ? (
        <Comments it={it} lang={lang} mod={mod} muted={muted} onCount={(d) => setCount((n) => Math.max(0, n + d))} />
      ) : null}
    </article>
  );
}

export function DigestTab() {
  const lang = useApp((s) => s.lang);
  const premium = useLive((s) => s.me.plan === "premium");
  const [reply, setReply] = useState<DigestReply | null>(() => peekDigest() ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchDigest().then((r) => {
      if (!alive) return;
      if (r?.ok) setReply(r);
      else if (!reply) setFailed(true);
    });
    return () => {
      alive = false;
    };
    // Подписка поменялась — закрытые разделы надо перезапросить.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [premium]);

  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), [reply]);
  const next = clock(lang, nextIssue(nowSec));

  if (!reply) {
    return failed ? (
      <Empty text={t(lang, "dg_err_load")} />
    ) : (
      <div className="dg">
        <Skeleton rows={6} />
      </div>
    );
  }
  const items = reply.items;
  const first = items[0];
  if (!first) {
    return <Empty text={t(lang, "dg_empty", { t: next })} hint={t(lang, "dg_sub", { t: next })} />;
  }
  return (
    <div className="dg">
      <p className="dg-lead">{t(lang, "dg_sub", { t: next })}</p>
      <DigestCard key={first.id} it={first} lang={lang} premium={premium}
        mod={Boolean(reply.mod)} muted={Boolean(reply.muted)} fresh />
      {items.length > 1 ? <SectionTitle>{t(lang, "dg_past")}</SectionTitle> : null}
      {items.slice(1).map((it) => (
        <DigestCard key={it.id} it={it} lang={lang} premium={premium}
          mod={Boolean(reply.mod)} muted={Boolean(reply.muted)} fresh={false} />
      ))}
    </div>
  );
}

