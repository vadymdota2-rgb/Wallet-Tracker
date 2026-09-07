/** Переименование кошелька — то же ограничение в 32 символа, что в боте. */
import { useState } from "react";
import { Frame, type ScreenProps } from "./Screen";
import { useApp } from "../store/app";
import { useLive, walletByAddr } from "../store/live";
import { t } from "../i18n/t";
import { renameWallet } from "../lib/api";
import { syncNow } from "../lib/sync";
import { toast } from "../components/Toast";
import { Action, Card, Empty, SectionTitle } from "../components/ui";

const NAME_MAX = 32;

export function RenameScreen({ arg }: ScreenProps) {
  const lang = useApp((s) => s.lang);
  const back = useApp((s) => s.back);
  const wallets = useLive((s) => s.wallets);
  const w = walletByAddr(wallets, arg);
  const [name, setName] = useState(w?.name ?? "");
  const [busy, setBusy] = useState(false);

  if (!w) {
    return (
      <Frame title={t(lang, "rename_title")}>
        <Empty text={t(lang, "err_wallet_not_found")} />
      </Frame>
    );
  }

  const submit = async () => {
    const n = name.trim();
    if (!n) return void toast(t(lang, "err_name_empty"), "err");
    if (n.length > NAME_MAX) return void toast(t(lang, "err_name_too_long"), "err");
    setBusy(true);
    try {
      const res = await renameWallet(w.addr, n);
      if (res?.ok) {
        toast(t(lang, "rename_success"));
        back();
        void syncNow();
      } else toast(t(lang, "generic_error_retry"), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title={t(lang, "rename_title")} sub={`${t(lang, "rename_current_name")} ${w.name}`}>
      <Card>
        <SectionTitle>{t(lang, "rename_enter_new")}</SectionTitle>
        <input
          className="find"
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          aria-label={t(lang, "rename_new_name")}
        />
        <div className="stack-actions">
          <Action onClick={submit} disabled={busy || !name.trim()}>
            {t(lang, "ui_save")}
          </Action>
        </div>
      </Card>
    </Frame>
  );
}
