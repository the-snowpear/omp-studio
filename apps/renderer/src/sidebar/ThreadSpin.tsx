/** Folder-column slot on a sidebar thread row. Occupies the same 14px
 *  gutter as the project folder icon so titles stay left-aligned. */
export function ThreadSpin({ running }: { running: boolean }) {
  return (
    <span className="t-gutter">
      {running ? <span className="t-spin" role="img" aria-label="运行中" /> : null}
    </span>
  );
}
