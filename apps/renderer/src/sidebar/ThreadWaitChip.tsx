import { THREAD_WAIT_LABEL, THREAD_WAIT_TONE, type ThreadWaitKind } from "./threadWait";

/** Far-right status capsule on a sidebar thread row. Visual only. */
export function ThreadWaitChip({ kind }: { kind: ThreadWaitKind }) {
  const label = THREAD_WAIT_LABEL[kind];
  return (
    <span className={`t-wait chip ${THREAD_WAIT_TONE[kind]} xs`} role="status" aria-label={label}>
      {label}
    </span>
  );
}
