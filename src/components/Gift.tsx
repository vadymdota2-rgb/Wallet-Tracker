/**
 * Приветствие при первом открытии: подарок — дни Премиума.
 *
 * На весь экран, а не всплывашкой: человек в первый раз смотрит на
 * приложение, и без этого Премиум «откуда-то взялся» и так же молча кончился
 * бы. Здесь — сколько дней, до какого числа, что входит и что будет потом.
 * Экран один на всю жизнь аккаунта: сервер присылает подарок ровно в том
 * ответе, где его выдал. Тот же повод бот отмечает сообщением в чате.
 */
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { dateLong } from "../lib/format";
import { haptic } from "../lib/telegram";
import { Action } from "./ui";

const FEATURES = [
  ["🔔", "gift_f1"],
  ["🏆", "gift_f2"],
  ["📊", "gift_f3"],
  ["📰", "gift_f4"],
] as const;

/** «21 дней» → «21 день»: у пришедшего по приглашению 21 день, а словарь
 *  пишет одну форму. Склоняем там, где число с существительным согласуется
 *  по-разному (русский и украинский). */
export function dayForm(lang: string, text: string, n: number): string {
  const forms: Record<string, [string, string, string]> = {
    ru: ["день", "дня", "дней"],
    uk: ["день", "дні", "днів"],
  };
  const f = forms[lang];
  if (!f) return text;
  const d10 = n % 10, d100 = n % 100;
  const w = d10 === 1 && d100 !== 11 ? f[0] : d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14) ? f[1] : f[2];
  return text.replace(`${n} ${f[2]}`, `${n} ${w}`);
}

export function Gift() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);
  const goTab = useApp((s) => s.goTab);
  const days = useLive((s) => s.gift);
  const until = useLive((s) => s.me.premUntil);
  const drop = useLive((s) => s.dropGift);
  if (!days) return null;

  // Дата — из срока Премиума: у пришедшего по приглашению он длиннее.
  const end = until && until > Date.now() ? until : Date.now() + days * 86400000;

  return (
    <div className="gift-wrap" role="dialog" aria-modal="true" aria-labelledby="gift-ttl">
      <div className="gift">
        <div className="gift-badge" aria-hidden="true">
          <span>🎁</span>
        </div>
        <p className="gift-hi">{t(lang, "gift_hi")}</p>
        <h1 id="gift-ttl">{dayForm(lang, t(lang, "gift_title", { n: String(days) }), days)}</h1>
        <p className="gift-until">{t(lang, "gift_until", { d: dateLong(end / 1000) })}</p>
        <ul className="gift-list">
          {FEATURES.map(([ic, key]) => (
            <li key={key}>
              <span className="gift-li-ic" aria-hidden="true">{ic}</span>
              <span>{t(lang, key)}</span>
            </li>
          ))}
        </ul>
        <p className="gift-after">{t(lang, "gift_after")}</p>
        <div className="stack-actions gift-actions">
          {/* «Начать» — к кошелькам: там первые шаги, и без кошелька
              алертам приходить не с чего. */}
          <Action
            onClick={() => {
              haptic("success");
              drop();
              goTab("wallets");
            }}
          >
            {t(lang, "gift_go")}
          </Action>
          <Action
            kind="ghost"
            onClick={() => {
              drop();
              goTab("more");
              open("premium", "gift");
            }}
          >
            {t(lang, "gift_more")}
          </Action>
        </div>
      </div>
    </div>
  );
}
