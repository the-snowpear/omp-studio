// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createWorkbenchHealth, WorkbenchHealth } from "./WorkbenchHealth";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function scheduler() {
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const report = vi.fn();
  const health = createWorkbenchHealth({
    report,
    requestFrame: (callback) => { pending.set(++id, callback); return id; },
    cancelFrame: (key) => { pending.delete(key); },
  });
  const tick = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach((callback) => callback(0)); };
  return { health, report, tick };
}

describe("initial workbench health", () => {
  it("confirms only after a successful commit has painted, and only once", () => {
    const { health, report, tick } = scheduler();
    health.committed();
    expect(report).not.toHaveBeenCalled();
    tick();
    expect(report).not.toHaveBeenCalled();
    tick();
    expect(report.mock.calls).toEqual([["ready"]]);
    health.committed(); tick(); tick();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("unmount cancels pending readiness and a first-screen failure latches across remounts", () => {
    const { health, report, tick } = scheduler();
    const unmount = health.committed();
    tick(); unmount(); tick();
    expect(report).not.toHaveBeenCalled();
    health.committed(); tick(); health.failed(); tick();
    health.committed(); tick(); tick();
    expect(report.mock.calls).toEqual([["failed"]]);
  });

  it("the real ErrorBoundary reports failure without acknowledging a crashing workbench", () => {
    const reportPayloadHealth = vi.fn(async () => true);
    vi.stubGlobal("ompStudioChrome", { reportPayloadHealth });
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Crash(): never { throw new Error("new snapshot cannot render"); }
    const view = render(<ErrorBoundary><WorkbenchHealth /><Crash /></ErrorBoundary>);
    expect(view.getByText("Renderer error")).toBeTruthy();
    expect(reportPayloadHealth.mock.calls).toEqual([["failed"]]);
  });
});
