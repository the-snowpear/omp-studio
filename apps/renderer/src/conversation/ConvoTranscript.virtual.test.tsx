import { cleanup, render, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConvoTranscript, firstItemIndexAfterRows } from "./ConvoTranscript";
import { createConversationViewportController, type ConversationViewportController } from "./conversationViewportController";
import type { TimelineRow } from "./conversationViewModel";

const nativeResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  if (nativeResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  } else {
    globalThis.ResizeObserver = nativeResizeObserver;
  }
});

const rows: readonly TimelineRow[] = Array.from({ length: 500 }, (_, index) => ({
  type: "user" as const,
  itemId: `row-${index}`,
  createdAt: "2026-08-25T00:00:00.000Z",
  text: `message ${index}`,
}));

function VirtualTranscriptHarness({
  className,
  viewportController,
}: {
  readonly className: string;
  readonly viewportController?: ConversationViewportController;
}) {
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const bindScroller = useCallback((node: HTMLElement | null) => setScrollParent(node), []);
  return (
    <VirtuosoMockContext.Provider value={{ viewportHeight: 320, itemHeight: 40 }}>
      <section className={className} ref={bindScroller}>
        <div className={className === "convo-scroll" ? "convo-doc" : "sa-inspect-doc"}>
          <ConvoTranscript
            rows={rows}
            scrollParent={scrollParent}
            {...(viewportController === undefined ? {} : { viewportController })}
          />
        </div>
      </section>
    </VirtuosoMockContext.Provider>
  );
}

describe("ConvoTranscript virtualization", () => {
  it("decrements firstItemIndex by the actual unique prepended row count", () => {
    expect(firstItemIndexAfterRows(rows.slice(20), rows, 1_000_000)).toBe(999_980);
    expect(firstItemIndexAfterRows(rows, rows, 999_980)).toBe(999_980);
  });

  for (const className of ["convo-scroll", "sa-inspect-scroll"] as const) {
    it(`bounds mounted rows in ${className}`, async () => {
      const { container } = render(<VirtualTranscriptHarness className={className} />);
      await waitFor(() => expect(container.querySelectorAll("[data-item-id]").length).toBeGreaterThan(0));
      expect(container.querySelectorAll("[data-item-id]").length).toBeLessThan(100);
      expect(container.querySelectorAll("[data-item-id]").length).toBeLessThan(rows.length);
    });
  }

  it("flushes the first rendered measurements when total height arrives later", async () => {
    const controller = createConversationViewportController();
    const recordMeasurements = vi.spyOn(controller, "recordMeasurements");

    render(<VirtualTranscriptHarness className="convo-scroll" viewportController={controller} />);

    await waitFor(() => expect(recordMeasurements.mock.calls.some(
      ([measurements, totalHeight]) => measurements.length > 0 && totalHeight > 0,
    )).toBe(true));
  });
});
