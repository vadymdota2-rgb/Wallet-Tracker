/**
 * Добавление кошелька. Проверки те же, что в боте: адрес 0x + 40 знаков,
 * имя до 32 символов. Лимит плана проверяет сервер — на бесплатном один
 * кошелёк, на премиуме пятьдесят.
 */
import { useState } from "react";
import { Frame } from "./Screen";
import type { ScreenProps } from "./Screen";
import { useApp, walletLimit } from "../store/app";
import { useLive } from "../store/live";
import { bare, split, t } from "../i18n/t";
import { addWallet } from "../lib/api";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { Action, AddrBar, BotText, Card, PlusGlyph, SectionTitle } from "../components/ui";

const ADDR = /^0x[a-fA-F0-9]{40}$/;
const NAME_MAX = 32;

export function AddWalletScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const back = useApp((s) => s.back);
  const open = useApp((s) => s.open);
  const { me, wallets } = useLive();

  /* Экран открывают и с пустыми руками, и из рейтинга — там адрес уже
     выбран, и спрашивать его второй раз незачем: остаётся только имя. */
  const preset = arg && ADDR.test(arg.trim()) ? arg.trim() : "";
  const [addr, setAddr] = useState(preset);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const limit = walletLimit(me.plan);
  const full = wallets.length >= limit;
  // В боте это одно сообщение: строка заголовка, а под ней объяснение —
  // какой адрес слать и где взять чужой. Мини-апп загонял всё в заголовок
  // экрана, где длинный текст обрезался многоточием, и пояснение пропадало.
  const intro = split(t(lang, "add_wallet_title"));

  const submit = async () => {
    const a = addr.trim();
    if (!ADDR.test(a)) return void toast(t(lang, "add_wallet_invalid"), "err");
    const n = name.trim();
    if (n.length > NAME_MAX) return void toast(t(lang, "err_name_too_long"), "err");
    if (wallets.some((w) => w.addr.toLowerCase() === a.toLowerCase())) {
      return void toast(t(lang, "already_tracking"), "err");
    }
    setBusy(true);
    try {
      const res = await addWallet(a, n);
      if (res?.ok) {
        toast(t(lang, "add_wallet_success"));
        back();
        void syncNow();
      } else if (res?.error === "limit") toast(t(lang, "pr_limit_title"), "err");
      else if (res?.error === "dup") toast(t(lang, "already_tracking"), "err");
      else if (res?.error === "banned") toast(t(lang, "wallet_bot_banned"), "err");
      else if (res?.error === "bad_addr") toast(t(lang, "err_invalid_address"), "err");
      else toast(t(lang, "generic_error_retry"), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      title={<><PlusGlyph size={16} /> {bare(intro[0])}</>}
      sub={`${wallets.length} / ${limit}`}
    >
      <Card>
        {/* Подсказка «пришлите адрес, а если не знаете чей — загляните в
            рейтинг» нужна только тем, кто пришёл с пустыми руками. Из
            рейтинга адрес уже выбран, и совет искать его в рейтинге читался
            бы издевательством. Заголовок «Адрес» тоже лишний: своя подпись
            есть у самой строки адреса. */}
        {preset ? null : intro[1] ? <BotText text={intro[1]} /> : null}
        {preset ? null : <SectionTitle>{t(lang, "add_wallet_address_label")}</SectionTitle>}
        {preset ? (
          <AddrBar
            addr={preset}
            label={bare(t(lang, "add_wallet_address_label"))}
            copy={t(lang, "ui_copy")}
            onDone={(ok) =>
              ok ? toast(t(lang, "ui_copied")) : toast(t(lang, "ui_copy_failed"), "err")
            }
          />
        ) : (
          <input
            className="find mono"
            value={addr}
            placeholder="0x…"
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => setAddr(e.target.value)}
            aria-label={t(lang, "add_wallet_address_label")}
          />
        )}
        <SectionTitle>{t(lang, "add_wallet_name_label")}</SectionTitle>
        <input
          className="find"
          value={name}
          maxLength={NAME_MAX}
          placeholder={t(lang, "add_wallet_name_label")}
          // Адрес уже известен — курсор сразу в поле имени, ради которого
          // экран и открыли.
          autoFocus={!!preset}
          onChange={(e) => setName(e.target.value)}
          aria-label={t(lang, "add_wallet_name_label")}
        />
        <div className="stack-actions">
          <Action onClick={submit} disabled={busy || full || !addr.trim()}>
            <PlusGlyph /> {bare(t(lang, "menu_add_wallet"))}
          </Action>
          {full ? (
            <>
              <small className="hint warn">
                {me.plan === "premium" ? t(lang, "limit_50_reached") : t(lang, "pr_limit_free")}
              </small>
              {me.plan !== "premium" ? (
                <Action kind="ghost" onClick={() => open("premium")}>
                  {t(lang, "mw_upgrade")}
                </Action>
              ) : null}
            </>
          ) : null}
        </div>
      </Card>
    </Frame>
  );
}
