import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  StudioClient,
  ClientBootstrap,
} from "@omp-studio/client-contract";
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
