import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));

import { AppSidebar } from "./App.js";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { I18nProvider } from "./i18n";

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
});

type SidebarChrome = Parameters<typeof AppSidebar>[0]["chrome"];

function fakeSidebarChrome(overrides: Partial<SidebarChrome> = {}): SidebarChrome {
  return {
    splitRatio: 0.5,
    sidebarWidth: 272,
    collapsed: false,
    explorerOpen: true,
    skillsOpen: false,
    skillsEnabledCount: 0,
    paletteOpen: false,
    ompMenuOpen: false,
    previewDeckWait: null,
    hiddenPreviewThreads: new Set(),
    projectThreadLimits: {},
    onCreateProject: vi.fn(),
    onStartNewChat: vi.fn(),
    onToggleSkills: vi.fn(),
    onToggleProject: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectThread: vi.fn(),
    onSelectPreviewProject: vi.fn(),
    onSelectPreviewThread: vi.fn(),
    onPickProject: vi.fn(),
    onStartChatInProject: vi.fn(),
    onArchivePreviewThread: vi.fn(),
    onArchiveThread: vi.fn(),
    onUnarchiveThread: vi.fn(),
    onRenameThread: vi.fn(),
    onForkThread: vi.fn(),
    onHandoffThread: vi.fn(),
    onCompactThread: vi.fn(),
    compactPending: false,
    onExportThread: vi.fn(),
    onOpenCapabilities: vi.fn(),
    onOpenPalette: vi.fn(),
    onToggleOmpMenu: vi.fn(),
    onOpenDialog: vi.fn(),
    onOpenTerminalPanel: vi.fn(),
    onOpenProjectInEditor: vi.fn(),
    onOpenProjectDirectory: vi.fn(),
    projectShellUnavailable: undefined,
    projectShellAction: null,
    onAddComposerContext: vi.fn(),
    onInsertSkill: vi.fn(),
    onRemoveComposerSkill: vi.fn(),
    draftSkills: new Set(),
    usedSkills: new Set(),
    onToggleExplorer: vi.fn(),
    onToggleTheme: vi.fn(),
    onResizeSidebar: vi.fn(),
    onResizeSplit: vi.fn(),
    onSkillsEnabledCount: vi.fn(),
    onLoadMoreThreads: vi.fn(),
    archiveTarget: undefined,
    archiveTargetReason: undefined,
    residentSessionId: undefined,
    selectedProject: null,
    previewProjectId: "p1",
    previewThreadId: "t1",
    projectListExpanded: true,
    ...overrides,
  } as unknown as SidebarChrome;
}

describe("AppSidebar", () => {
  it("triggers onCreateProject when clicking the create project button in Projects & Chats section header", () => {
    const chrome = fakeSidebarChrome();
    const state = {
      model: { workspaces: { workspaces: [] } },
      readStatus: {},
      optimisticStatus: {},
    } as unknown as Parameters<typeof AppSidebar>[0]["state"];
    const client = {
      subscribe: vi.fn(() => () => undefined),
      query: vi.fn().mockResolvedValue({}),
      command: vi.fn().mockResolvedValue({ requestId: "req-1" }),
    } as unknown as Parameters<typeof AppSidebar>[0]["client"];
    const onRoute = vi.fn();
    const onOpenAppUpdateDialog = vi.fn();

    render(
      <PreviewModeProvider switchEnabled>
        <I18nProvider forcedLanguage="zh">
          <AppSidebar
            state={state}
            chrome={chrome}
            client={client}
            onRoute={onRoute}
            onOpenAppUpdateDialog={onOpenAppUpdateDialog}
          />
        </I18nProvider>
      </PreviewModeProvider>,
    );

    const section = screen.getByRole("region", { name: "项目与对话" });
    const createBtn = section.querySelector(".sb-head-actions button");
    expect(createBtn).not.toBeNull();
    expect(createBtn?.getAttribute("aria-label")).toBe("新建项目");
    expect(createBtn?.getAttribute("data-tip")).toBe("新建项目");
    expect(createBtn?.hasAttribute("disabled")).toBe(false);

    fireEvent.click(createBtn!);
    expect(chrome.onCreateProject).toHaveBeenCalledTimes(1);
  });
});
