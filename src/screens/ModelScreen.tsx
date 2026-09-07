/**
 * Состояние модели. Флаг «обучена» берётся с сервера отдельно для спота и
 * перпов: прошлая версия для перпов всегда сообщала «не обучена» — значение
 * было передано жёстко.
 */
import { Frame } from "./Screen";
import { useApp } from "../store/app";
import { useLive } from "../store/live";
import { t } from "../i18n/t";
import { num } from "../lib/format";
import { Card, Row, SectionTitle, Tiles } from "../components/ui";

export function ModelScreen() {
  const lang = useApp((s) => s.lang);
  const sonar = useLive((s) => s.sonar);

  return (
    <Frame title={t(lang, "ai_st_title")}>
      <Card>
        <p className="note">{t(lang, "ai_hint")}</p>
      </Card>
      <Card>
        <SectionTitle note={t(lang, "ai_st_samples")}>{t(lang, "ai_st_ready")}</SectionTitle>
        <Tiles
          items={[
            { label: t(lang, "ai_spot"), value: `${num(sonar.ready.spot)} / ${num(sonar.need)}` },
            { label: t(lang, "ai_perp"), value: `${num(sonar.ready.perp)} / ${num(sonar.need)}` },
          ]}
        />
      </Card>
      <Card>
        <SectionTitle>{t(lang, "ai_st_acc")}</SectionTitle>
        <Row
          title={t(lang, "ai_spot")}
          sub={sonar.trainedSpot ? t(lang, "ai_mode_model") : t(lang, "ai_st_untrained")}
          value={sonar.accSpot === null ? "—" : `${sonar.accSpot}%`}
        />
        <Row
          title={t(lang, "ai_perp")}
          sub={sonar.trainedPerp ? t(lang, "ai_mode_model") : t(lang, "ai_st_untrained")}
          value={sonar.accPerp === null ? "—" : `${sonar.accPerp}%`}
        />
      </Card>
    </Frame>
  );
}
