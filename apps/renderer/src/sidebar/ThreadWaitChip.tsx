import { useI18n } from "../i18n";
import { THREAD_WAIT_LABEL, THREAD_WAIT_TONE, type ThreadWaitKind } from "./threadWait";

const THREAD_WAIT_KEY: Record<ThreadWaitKind, string> = {
  approval: "sidebar.waitingApproval",
  plan: "sidebar.waitingPlan",
  ask: "sidebar.waitingAsk",
};

/** Far-right status capsule on a sidebar thread row. Visual only. */
export function ThreadWaitChip({ kind }: { kind: ThreadWaitKind }) {
  const { t } = useI18n();
  const label = t(THREAD_WAIT_KEY[kind]);
  return (
    <span className={`t-wait chip ${THREAD_WAIT_TONE[kind]} xs`} role="status" aria-label={label}>
      {label}
    </span>
  );
}
