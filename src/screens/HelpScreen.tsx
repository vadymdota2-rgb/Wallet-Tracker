/**
 * Помощь — инструкция к приложению.
 *
 * Прежняя версия повторяла меню бота строками, обрезанными на полуслове
 * («Добавить кошелёк — начать отслеж…»), и не отвечала ни на один настоящий
 * вопрос. Теперь это руководство: быстрый старт по шагам, разбор каждой
 * вкладки, словарь терминов, частые вопросы, Premium, поддержка и отказ
 * от ответственности.
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
  DigestGlyph,
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
  { ic: <DigestGlyph size={22} />, title: "hp_g_dg_t", sub: "hp_g_dg_s", body: "hp_g_dg_d" },
  { ic: <span className="fold-dots">⋯</span>, title: "hp_g_more_t", sub: "hp_g_more_s", body: "hp_g_more_d" },
];

/** Словарь терминов: те же абзацы, что в подсказках «?» на экранах, —
 *  объяснение одно, где бы человек его ни открыл. NetFlow и ETF — термины,
 *  их не переводят, поэтому заголовок без ключа словаря. */
const TERMS: { title: Key | "NetFlow" | "ETF"; body: Key[] }[] = [
  { title: "ETF", body: ["ef_how_1", "ef_how_3"] },
  { title: "NetFlow", body: ["q_netflow_1", "q_netflow_2"] },
  { title: "ui_rotation", body: ["q_rot_1", "q_rot_2"] },
  { title: "ex_flows", body: ["q_exflow_1", "q_exflow_2"] },
  { title: "ui_tab_ls", body: ["q_ls_1", "q_ls_2"] },
  { title: "q_t_lev", body: ["q_perp_2", "lqs_how_1"] },
  { title: "q_t_fund", body: ["q_fund_1", "q_fund_2"] },
  { title: "oih_oi", body: ["oih_how_1", "oih_how_2"] },
  { title: "q_t_pnl", body: ["q_top_2", "q_top_3"] },
  { title: "dm_dom", body: ["dm_how_1", "dm_how_3"] },
  { title: "q_t_opt", body: ["op_how_1", "op_how_2", "op_how_3"] },
];

const FAQ: [Key, Key][] = [
  ["hp_q1", "hp_a1"],
  ["hp_q3", "hp_a3"],
  ["hp_q4", "hp_a4"],
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
        <SectionTitle>{t(lang, "hp_terms_title")}</SectionTitle>
        <p className="note dim">{t(lang, "hp_terms_note")}</p>
        <div className="folds">
          {TERMS.map((g) => (
            <details key={g.title} className="fold faq" onToggle={() => haptic("select")}>
              <summary>
                <span className="fold-main">
                  <b>{g.title === "NetFlow" || g.title === "ETF" ? g.title : t(lang, g.title)}</b>
                </span>
                <span className="fold-chev" aria-hidden="true" />
              </summary>
              <p className="fold-body">{g.body.map((k) => t(lang, k)).join("\n\n")}</p>
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
          <Action kind="ghost" onClick={() => open("premium", "help")}>{t(lang, "hp_premium_btn")}</Action>
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
