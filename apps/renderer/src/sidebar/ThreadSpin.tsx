
import { useI18n } from "../i18n";

/** Folder-column slot on a sidebar thread row. Occupies the same 14px
 *  gutter as the project folder icon so titles stay left-aligned. */
export function ThreadSpin({ running }: { running: boolean }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  return (
    <span className="t-gutter">
      {running ? <span className="t-spin" role="img" aria-label={zh ? "运行中" : "Running"} /> : null}
    </span>
  );
}
