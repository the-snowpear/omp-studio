import { useEffect } from "react";

type Status = "ready" | "failed";

/** Per-document latch. A first-screen error must never be followed by a healthy acknowledgement. */
export function createWorkbenchHealth(options: {
  readonly report: (status: Status) => void;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (id: number) => void;
}) {
  let failed = false;
  let reported = false;
  let frame: number | undefined;
  const cancel = () => {
    if (frame !== undefined) options.cancelFrame(frame);
    frame = undefined;
  };
  return {
    committed(): () => void {
      cancel();
      if (failed || reported) return cancel;
      // Let the committed workbench and its initial effects paint before confirming.
      frame = options.requestFrame(() => {
        frame = options.requestFrame(() => {
          frame = undefined;
          if (failed || reported) return;
          reported = true;
          options.report("ready");
        });
      });
      return cancel;
    },
    failed(): void {
      cancel();
      if (failed) return;
      failed = true;
      options.report("failed");
    },
  };
}

const health = createWorkbenchHealth({
  report: (status) => { void globalThis.ompStudioChrome?.reportPayloadHealth?.(status).catch(() => {}); },
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
});

export function reportWorkbenchFailure(): void { health.failed(); }

/** Render only after bootstrap and the initial model have committed successfully. */
export function WorkbenchHealth(): null {
  useEffect(() => health.committed(), []);
  return null;
}
