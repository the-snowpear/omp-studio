import type { SessionTitleRow } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import "./sessionTitles.css";
export function SessionTitleMark({
  row,
  title,
}: {
  row: SessionTitleRow | undefined;
  title: string;
}) {
  const { resolvedLanguage } = useI18n(),
    zh = resolvedLanguage === "zh";
  if (row?.state !== "available" || !row.card || row.title !== title)
    return null;
  // Native titles already contain their card as "emoji CODE: title".
  // Keep that stored text intact; only legacy/preview titles need another mark.
  if (row.card.emoji && title.startsWith(`${row.card.emoji} ${row.card.code}: `))
    return null;
  const source =
    row.source === "user"
      ? zh
        ? "手动标题"
        : "Manual title"
      : zh
        ? "自动标题"
        : "Generated title";
  return (
    <span
      className="session-title-card"
      aria-hidden="true"
      data-tip={
        source +
        " · " +
        row.card.code +
        (row.card.nf ? " · " + row.card.nf : "")
      }
    >
      {row.card.emoji ? (
        <span className="session-title-emoji">{row.card.emoji}</span>
      ) : null}
      <code>{row.card.code}</code>
    </span>
  );
}
