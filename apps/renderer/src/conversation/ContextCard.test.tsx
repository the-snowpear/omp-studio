import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { SessionId, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import { ContextCard, ContextDockCard } from "./ContextCard";
import { PREVIEW_CONTEXT_CARD } from "../preview/contextCardPreview";
import { PreviewModeProvider } from "../preview/PreviewContext";

afterEach(cleanup);

const liveId = "context-live" as SessionId;
const archivedId = "context-archived" as SessionId;
const liveTelemetry: SessionTelemetrySnapshot = {
  sessionId: liveId,
  capturedAt: "2026-11-01T07:00:00Z",
  tokens: { input: 2400, output: 400, total: 2800, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  context: { contextWindow: 128000, usedTokens: 2400, percent: 1.875, anchored: true, systemPromptTokens: 100, systemToolsTokens: 300, systemContextTokens: 200, skillsTokens: 400, messagesTokens: 1400 },
};

describe("ContextCard", () => {
  it("measures every category against the context window and updates as usage grows", () => {
    const { container, rerender } = render(<ContextCard context={PREVIEW_CONTEXT_CARD} onOpenDetails={() => {}} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("22.04");
    const rows = container.querySelectorAll(".context-card-row");
    expect(rows[0]?.textContent).toContain("123.4k12.3%");
    expect(rows[5]?.textContent).toContain("779.6k78.0%");
    rerender(<ContextCard context={{ ...PREVIEW_CONTEXT_CARD, usedTokens: 420_400, messagesTokens: 323_400, percent: 42.04 }} onOpenDetails={() => {}} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("42.04");
    expect(rows[5]?.textContent).toContain("579.6k58.0%");
  });

  it("shows an honest empty state without fixture numbers or an unusable detail action", () => {
    render(<ContextCard context={null} onOpenDetails={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("220.4k")).toBeNull();
  });

  it("opens the existing context viewer from the detail action", () => {
    const open = vi.fn();
    render(<ContextCard context={PREVIEW_CONTEXT_CARD} onOpenDetails={open} />);
    fireEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("ContextDockCard data sources", () => {
  it("shows OMP's live context and updates from subsequent telemetry without fixture fallback", () => {
    const query = vi.fn().mockResolvedValue({ cache: null });
    const props = { client: { query } as unknown as StudioClient, visible: true, viewedSessionId: liveId, liveSessionId: liveId, liveTelemetry, onOpenDetails: () => {} };
    const { rerender } = render(<ContextDockCard {...props} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("1.875");
    expect(screen.getByText("2.4k")).toBeTruthy();
    expect(screen.queryByText("220.4k")).toBeNull();
    rerender(<ContextDockCard {...props} liveTelemetry={{ ...liveTelemetry, context: { ...liveTelemetry.context!, usedTokens: 4800, messagesTokens: 3800, percent: 3.75 } }} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("3.75");
    expect(screen.getByText("4.8k")).toBeTruthy();
    expect(query).toHaveBeenCalledWith("session.cache.get", { sessionId: liveId });
    expect(query).toHaveBeenCalledOnce();
  });

  it("reads the viewed historical session and restores live usage on return", async () => {
    const query = vi.fn().mockResolvedValue({ sessionId: archivedId, source: "persisted", semantics: "last-observed", telemetry: { ...liveTelemetry, sessionId: archivedId, context: { ...liveTelemetry.context!, usedTokens: 64000, messagesTokens: 63000, percent: 50 } } });
    const props = { client: { query } as unknown as StudioClient, visible: true, liveSessionId: liveId, liveTelemetry, onOpenDetails: () => {} };
    const { rerender } = render(<ContextDockCard {...props} viewedSessionId={archivedId} />);
    expect(screen.queryByRole("meter")).toBeNull();
    await waitFor(() => expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("50"));
    expect(query).toHaveBeenCalledWith("session.telemetry.read", { sessionId: archivedId });
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ContextDockCard {...props} viewedSessionId={liveId} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("1.875");
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("uses fixtures only when preview is explicitly on, and makes no Host read", () => {
    const query = vi.fn();
    window.history.replaceState(null, "", "/?preview=1&marks=off");
    try {
      render(<PreviewModeProvider><ContextDockCard client={{ query } as unknown as StudioClient} visible viewedSessionId={archivedId} liveSessionId={liveId} liveTelemetry={liveTelemetry} onOpenDetails={() => {}} /></PreviewModeProvider>);
      expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("22.04");
      expect(screen.getByText("220.4k")).toBeTruthy();
      expect(query).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
