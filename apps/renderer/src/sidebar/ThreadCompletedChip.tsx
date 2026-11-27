import { useI18n } from "../i18n";

/** Far-right status capsule on a sidebar thread row: the agent turn
 *  finished recently. Visual only. */
export function ThreadCompletedChip() {
  const { t } = useI18n();
  const label = t("sidebar.completed");
  return (
    <span className="t-wait chip gray xs" role="status" aria-label={label}>
      {label}
    </span>
  );
}
