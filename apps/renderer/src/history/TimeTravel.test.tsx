/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type {
  SessionHistoryEntry,
  StudioClient,
  TimeTravelSettings,
} from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { TimeTravelEntry } from "./TimeTravelActivation";
import { TimeTravelPane } from "./TimeTravelPane";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { timeTravelPreview } from "../preview/timeTravelPreview";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  timeTravelPreview.update({ enabled: false });
});

it("requires a risk confirmation before enabling from the conversation entry", async () => {
  let settings: TimeTravelSettings = {
    enabled: false,
    retentionDays: null,
    exclusions: [],
  };
  const query = vi.fn(async () => settings);
  const command = vi.fn(
    async (_name: string, patch: Partial<TimeTravelSettings>) => {
      settings = { ...settings, ...patch };
      return { requestId: "enable" };
    },
  );
  const client = {
    query,
    command,
    subscribe: () => () => {},
    getState: () => ({
      commands: { enable: { status: "completed", result: settings } },
    }),
  } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <TimeTravelEntry client={client} />
    </I18nProvider>,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Time Travel 开启" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Time Travel 开启" }));
  expect(screen.getByRole("dialog").textContent).toContain(
    "恢复会覆盖当前文件",
  );
  expect(screen.getByRole("dialog").textContent).toContain("占用磁盘");
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "暂不开启" }));
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Time Travel 开启" }));
  fireEvent.click(screen.getByRole("button", { name: "了解风险并开启" }));
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith("timeTravel.settings.set", {
      enabled: true,
    }),
  );
  await screen.findByText("已开启");
});

it("previews affected files before sending the confirmed restore and reports partial failures", async () => {
  const point = {
    id: "checkpoint",
    leafId: "response",
    phase: "after",
    createdAt: "2026-11-09T10:00:00Z",
    fileCount: 4,
  };
  const query = vi.fn(async (name: string) =>
    name === "timeTravel.timeline.read"
      ? { branches: [], events: [], points: [point], activeLeafId: "response" }
      : {
          snapshotId: point.id,
          revision: "reviewed",
          changes: [
            { path: "src/file.ts", kind: "modify" },
            { path: "new.txt", kind: "delete" },
          ],
        },
  );
  const command = vi.fn(async () => ({ requestId: "restore" }));
  const client = {
    query,
    command,
    subscribe: () => () => {},
    getState: () => ({
      commands: {
        restore: {
          status: "completed",
          result: {
            codeRestored: true,
            conversationRestored: false,
            backupId: "backup",
          },
        },
      },
    }),
  } as unknown as StudioClient;
  const entry = {
    sessionId: "session",
    status: "active",
    title: "Project",
  } as SessionHistoryEntry;
  render(
    <I18nProvider forcedLanguage="zh">
      <TimeTravelPane client={client} entry={entry} onOpen={() => {}} />
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "恢复两者" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("src/file.ts");
  expect(dialog.textContent).toContain("new.txt");
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "恢复代码与对话" }),
  );
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith("timeTravel.restore", {
      sessionId: "session",
      leafId: "response",
      mode: "both",
      snapshotId: "checkpoint",
      expectedRevision: "reviewed",
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "代码已恢复，但对话未恢复",
  );
});

it("preview enable and restore only change local UI", async () => {
  window.history.replaceState(null, "", "?preview=1");
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <TimeTravelEntry client={client} />
        <TimeTravelPane
          client={client}
          entry={timeTravelPreview.entry}
          onOpen={() => {}}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Time Travel 开启" }));
  fireEvent.click(screen.getByRole("button", { name: "了解风险并开启" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "恢复代码" }))[0]!,
  );
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "恢复代码",
    }),
  );
  await screen.findByText("演示恢复完成，真实文件与对话未改变。");
  expect(client.query).not.toHaveBeenCalled();
  expect(client.command).not.toHaveBeenCalled();
  window.history.replaceState(null, "", "/");
});
