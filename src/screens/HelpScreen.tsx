/**
 * Помощь — инструкция к приложению.
 *
 * Прежняя версия повторяла меню бота строками, обрезанными на полуслове
 * («Добавить кошелёк — начать отслеж…»), и не отвечала ни на один настоящий
 * вопрос. Теперь это руководство: быстрый старт по шагам, разбор каждой
 * вкладки, частые вопросы, Premium, поддержка и отказ от ответственности.
 *
 * Разделы и вопросы свёрнуты: развёрнутые целиком, они растянули бы экран на
 * десяток прокруток, а искать нужное человек начинает с заголовков. Сделано
 * на <details>: раскрытие работает без скриптов и читается экранными чтецами.
 *
 * Названия вкладок и кнопок в текстах не переводятся заново, а берутся из
 * словаря того же языка при сборке (tools/i18n-extra.json) — инструкция не
 * может разойтись с тем, что человек видит на экране.
 */
import type { ReactNode } from "react";
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { t } from "../i18n/t";
import { haptic, openTg } from "../lib/telegram";
import {
  Action,
  AnalyticsGlyph,
  Card,
  CortexGlyph,
  Row,
  SectionTitle,
  TopGlyph,
  WalletGlyph,
} from "../components/ui";

type Key = Parameters<typeof t>[1];

const SUPPORT_URL = "https://t.me/WalletTrackerHelp";
const CHANNEL_URL = "https://t.me/WalletTrackerOfficial";

const STEPS: [Key, Key][] = [
  ["hp_s1_t", "hp_s1_d"],
  ["hp_s2_t", "hp_s2_d"],
  ["hp_s3_t", "hp_s3_d"],
  ["hp_s4_t", "hp_s4_d"],
];

const GUIDE: { ic: ReactNode; title: Key; sub: Key; body: Key }[] = [
  { ic: <WalletGlyph size={22} />, title: "hp_g_wallets_t", sub: "hp_g_wallets_s", body: "hp_g_wallets_d" },
  { ic: <TopGlyph size={22} />, title: "hp_g_top_t", sub: "hp_g_top_s", body: "hp_g_top_d" },
  { ic: <AnalyticsGlyph size={22} />, title: "hp_g_an_t", sub: "hp_g_an_s", body: "hp_g_an_d" },
  { ic: <CortexGlyph size={26} />, title: "hp_g_cx_t", sub: "hp_g_cx_s", body: "hp_g_cx_d" },
  { ic: <span className="fold-dots">⋯</span>, title: "hp_g_more_t", sub: "hp_g_more_s", body: "hp_g_more_d" },
];

const FAQ: [Key, Key][] = [
  ["hp_q1", "hp_a1"],
  ["hp_q2", "hp_a2"],
  ["hp_q3", "hp_a3"],
  ["hp_q4", "hp_a4"],
  ["hp_q5", "hp_a5"],
  ["hp_q6", "hp_a6"],
  ["hp_q7", "hp_a7"],
];

export function HelpScreen() {
  const lang = useApp((s) => s.lang);
  const open = useApp((s) => s.open);

  const link = (url: string) => {
    haptic("select");
    openTg(url);
  };

  return (
    <Frame title={t(lang, "help_title")}>
      <Card>
        <h2 className="help-h">{t(lang, "hp_intro_title")}</h2>
        <p className="help-p">{t(lang, "hp_intro")}</p>
      </Card>

      <Card>
        <SectionTitle>{t(lang, "hp_start_title")}</SectionTitle>
        <ol className="help-steps">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="help-n" aria-hidden="true">{i + 1}</span>
              <div>
                <b>{t(lang, title)}</b>
                <p>{t(lang, body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <SectionTitle>{t(lang, "hp_guide_title")}</SectionTitle>
        <div className="folds">
          {GUIDE.map((g) => (
            <details key={g.title} className="fold" onToggle={() => haptic("select")}>
              <summary>
                <span className="fold-ic" aria-hidden="true">{g.ic}</span>
                <span className="fold-main">
                  <b>{t(lang, g.title)}</b>
                  <small>{t(lang, g.sub)}</small>
                </span>
                <span className="fold-chev" aria-hidden="true" />
              </summary>
              <p className="fold-body">{t(lang, g.body)}</p>
            </details>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>{t(lang, "hp_faq_title")}</SectionTitle>
        <div className="folds">
          {FAQ.map(([q, a]) => (
            <details key={q} className="fold faq" onToggle={() => haptic("select")}>
              <summary>
                <span className="fold-main">
                  <b>{t(lang, q)}</b>
                </span>
                <span className="fold-chev" aria-hidden="true" />
              </summary>
              <p className="fold-body">{t(lang, a)}</p>
            </details>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>{t(lang, "hp_premium_t")}</SectionTitle>
        <p className="help-p">{t(lang, "hp_premium_d")}</p>
        <div className="stack-actions">
          <Action kind="ghost" onClick={() => open("premium")}>{t(lang, "hp_premium_btn")}</Action>
        </div>
      </Card>

      <Card>
        <SectionTitle>{t(lang, "hp_support_title")}</SectionTitle>
        <p className="help-p">{t(lang, "hp_support_d")}</p>
        <div className="stack-actions">
          <Action onClick={() => link(SUPPORT_URL)}>{t(lang, "hp_support_btn")}</Action>
          <Action kind="ghost" onClick={() => link(CHANNEL_URL)}>{t(lang, "hp_channel_btn")}</Action>
        </div>
        <Row
          icon={<span aria-hidden="true">📄</span>}
          title={t(lang, "ui_legal")}
          onClick={() => open("legal")}
        />
      </Card>

      <Card>
        <p className="note dim">{t(lang, "help_disclaimer")}</p>
      </Card>
    </Frame>
  );
}
