/**
 * Порог алертов. Пресеты, границы и правила разбора — те же, что в
 * alert_settings.cpp бота: $50 минимум, $1 000 000 000 максимум, не более
 * двух знаков после запятой.
 *
 * Пустое поле уходило на сервер как NaN. Теперь не уходит вовсе.
 */
import { useState } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { bare, t } from "../i18n/t";
import { usd, usdFull } from "../lib/format";
import { setThreshold } from "../lib/api";
import { toast } from "../components/Toast";
import { Action, Card, Row, SectionTitle, ThresholdGlyph } from "../components/ui";

const PRESETS = [100, 500, 1000, 5000, 10000, 50000];
const MIN = 50;
const MAX = 1_000_000_000;

export function ThresholdScreen() {
  const lang = useApp((s) => s.lang);
  const back = useApp((s) => s.back);
  const current = useLive((s) => s.me.threshold);
  const patchMe = useLive((s) => s.patchMe);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = async (value: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await setThreshold(value);
      if (res?.ok) {
        // Сервер хранит ровно то, что мы прислали, — полная выгрузка ради
        // одного числа заставляла список ждать несколько секунд.
        patchMe({ threshold: value });
        toast(t(lang, "threshold_updated"));
        back();
      } else if (res?.error === "min") toast(t(lang, "err_threshold_too_small"), "err");
      else if (res?.error === "max") toast(t(lang, "err_threshold_too_large"), "err");
      else toast(t(lang, "threshold_save_failed"), "err");
    } finally {
      setBusy(false);
    }
  };

  const submitCustom = () => {
    const raw = draft.trim().replace(",", ".");
    if (!raw) return;
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      toast(t(lang, /\.\d{3,}/.test(raw) ? "err_threshold_decimals" : "err_invalid_number"), "err");
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return void toast(t(lang, "err_threshold_positive"), "err");
    if (value < MIN) return void toast(t(lang, "err_threshold_too_small"), "err");
    if (value > MAX) return void toast(t(lang, "err_threshold_too_large"), "err");
    void apply(value);
  };

  return (
    <Frame
      title={<><ThresholdGlyph size={16} /> {bare(t(lang, "threshold_title"))}</>}
      sub={t(lang, "threshold_desc")}
    >
      <Card>
        <SectionTitle note={usdFull(current)}>{t(lang, "threshold_current")}</SectionTitle>
        {PRESETS.map((p) => (
          <Row
            key={p}
            title={usd(p)}
            value={p === Math.round(current) ? "✅" : undefined}
            onClick={() => void apply(p)}
          />
        ))}
      </Card>

      <Card>
        <SectionTitle>{t(lang, "threshold_custom_title")}</SectionTitle>
        <input
          className="find"
          value={draft}
          inputMode="decimal"
          placeholder="7500"
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t(lang, "threshold_custom_btn")}
        />
        <div className="stack-actions">
          <Action onClick={submitCustom} disabled={busy || !draft.trim()}>
            {t(lang, "ui_save")}
          </Action>
        </div>
      </Card>
    </Frame>
  );
}
