import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  StudioClient,
  ClientBootstrap,
} from "@omp-studio/client-contract";
import type { SessionTitleRow } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { useSessionTitles } from "./useSessionTitles";
import { SessionTitleMark } from "./SessionTitleMark";
import { previewSessionTitle } from "../preview/sessionTitlePreview";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const capabilities = {
  capabilities: [{ id: "session.titles.inspect", grade: "native" }],
} as unknown as ClientBootstrap["capabilityManifest"];
function Panel({
  client,
  id,
  enabled = true,
}: {
  client: StudioClient;
  id: string;
  enabled?: boolean;
}) {
  const result = useSessionTitles(
    client,
    { sessionId: id, available: true, ...(enabled ? { capabilities } : {}) },
    [{ id, title: id }],
  );
  return <output>{result.rows.get(id)?.title ?? "plain"}</output>;
}
it("does not let late metadata from a previous session replace the selected title", async () => {
  let finish!: (value: { requestId: string }) => void;
  const pending = new Promise<{ requestId: string }>((resolve) => {
    finish = resolve;
  });
  const command = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ requestId: "new" });
  const client = {
    command,
    getState: () => ({
      commands: {
        new: {
          status: "completed",
          result: {
            result: {
              rows: [{ sessionId: "new", state: "available", title: "new" }],
            },
          },
        },
        old: {
          status: "completed",
          result: {
            result: {
              rows: [{ sessionId: "old", state: "available", title: "old" }],
            },
          },
        },
      },
    }),
  } as unknown as StudioClient;
  const view = (id: string) => (
    <PreviewModeProvider switchEnabled>
      <Panel client={client} id={id} />
    </PreviewModeProvider>
  );
  const mounted = render(view("old"));
  mounted.rerender(view("new"));
  await screen.findByText("new");
  finish({ requestId: "old" });
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
  expect(screen.getByText("new")).toBeTruthy();
  expect(screen.queryByText("old")).toBeNull();
});
it("keeps old Runtime and preview title display free of real queries", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  const mounted = render(
    <PreviewModeProvider switchEnabled>
      <Panel client={client} id="s" enabled={false} />
    </PreviewModeProvider>,
  );
  expect(client.command).not.toHaveBeenCalled();
  mounted.unmount();
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <Panel client={client} id="s" />
        <SessionTitleMark
          row={previewSessionTitle("s", "跟踪上游 pi-web 更新到 omp-web")}
          title="Changed title"
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(client.command).not.toHaveBeenCalled();
  expect(screen.queryByText("SYNC")).toBeNull();
});

it("shows a saved native title's emoji and code only once across language changes", () => {
  const title = "🛠️ FIX: Repair a test workspace";
  const row: SessionTitleRow = { sessionId: "test", state: "available", title, source: "auto", card: { emoji: "🛠️", code: "FIX" } };
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}>
    <span data-testid="title"><SessionTitleMark row={row} title={title} /><span>{title}</span></span>
  </I18nProvider>;
  const mounted = render(view("zh"));
  for (const language of ["zh", "en", "zh"] as const) {
    mounted.rerender(view(language));
    expect(screen.getByTestId("title").textContent).toBe(title);
    expect(mounted.container.querySelector(".session-title-card")).toBeNull();
  }
});

it("retains separate metadata cards for legacy and preview titles without an embedded card", () => {
  const title = "Repair a test workspace";
  const row: SessionTitleRow = { sessionId: "legacy", state: "available", title, source: "auto", card: { emoji: "🛠️", code: "FIX" } };
  const previewTitle = "跟踪上游 pi-web 更新到 omp-web";
  const mounted = render(<I18nProvider forcedLanguage="zh">
    <SessionTitleMark row={row} title={title} /><span>{title}</span>
    <SessionTitleMark row={previewSessionTitle("preview", previewTitle)} title={previewTitle} />
  </I18nProvider>);
  expect(mounted.container.querySelectorAll(".session-title-card")).toHaveLength(2);
  expect(screen.getByText("FIX")).toBeTruthy();
  expect(screen.getByText("SYNC")).toBeTruthy();
});

it("coalesces concurrent sidebar and topbar title inspections and serves cached rows on switch", async () => {
  const command = vi.fn().mockResolvedValue({ requestId: "batch-1" });
  const client = {
    command,
    getState: () => ({
      commands: {
        "batch-1": {
          status: "completed",
          result: {
            result: {
              rows: [
                { sessionId: "s-1", state: "available", title: "One", source: "user" },
                { sessionId: "s-2", state: "available", title: "Two", source: "user" },
              ],
            },
          },
        },
      },
    }),
  } as unknown as StudioClient;
  function Harness({ viewed }: { viewed: string }) {
    const sidebar = useSessionTitles(client, { sessionId: "live", available: true, capabilities }, [
      { id: "s-1", title: "One" },
      { id: "s-2", title: "Two" },
    ]);
    const topbar = useSessionTitles(client, { sessionId: "live", available: true, capabilities }, [
      { id: viewed, title: viewed === "s-1" ? "One" : "Two" },
    ]);
    return <output>{`${sidebar.rows.size}:${topbar.rows.get(viewed)?.title ?? "none"}`}</output>;
  }
  const mounted = render(<PreviewModeProvider switchEnabled><Harness viewed="s-1" /></PreviewModeProvider>);
  await screen.findByText("2:One");
  expect(command).toHaveBeenCalledTimes(1);
  mounted.rerender(<PreviewModeProvider switchEnabled><Harness viewed="s-2" /></PreviewModeProvider>);
  await screen.findByText("2:Two");
  expect(command).toHaveBeenCalledTimes(1);
});

it("shows the sidebar and topbar title metadata when their combined batch exceeds the Runtime limit", async () => {
  const sidebar = Array.from({ length: 32 }, (_, index) => ({ id: `sidebar-${index}`, title: `Thread ${index}` }));
  const receipts: Record<string, unknown> = {};
  const command = vi.fn(async (_name: string, input: { targetSessionIds: string[] }) => {
    if (input.targetSessionIds.length > 32) throw new Error("Too many titles in one request");
    const requestId = `batch-${input.targetSessionIds[0]}`;
    receipts[requestId] = {
      status: "completed",
      result: { result: { rows: input.targetSessionIds.map(sessionId => ({ sessionId, state: "available", title: sessionId, source: "user" })) } },
    };
    return { requestId };
  });
  const client = { command, getState: () => ({ commands: receipts }) } as unknown as StudioClient;
  const context = { sessionId: "live", available: true, capabilities };
  function Harness() {
    const list = useSessionTitles(client, context, sidebar);
    const topbar = useSessionTitles(client, context, [{ id: "viewed" }]);
    return <output>{`${list.rows.size}:${topbar.rows.get("viewed")?.title ?? "none"}`}</output>;
  }
  render(<PreviewModeProvider switchEnabled><Harness /></PreviewModeProvider>);
  await screen.findByText("32:viewed");
  expect(command.mock.calls.map(([, input]) => input.targetSessionIds)).toEqual([sidebar.map(row => row.id), ["viewed"]]);
});
