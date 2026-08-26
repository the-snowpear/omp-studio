import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RuntimeSettingsReadModel } from "@omp-studio/client-contract";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { SettingsPage, type RuntimeSettingsApi } from "./SettingsPage";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

beforeAll(() => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  window.matchMedia = (query: string) =>
    ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
});

const snapshot: RuntimeSettingsReadModel = {
  "edit.autoRepair.enabled": true,
  "features.unexpectedStopDetection": "smart",
  "providers.unexpectedStopModel": "qwen3-1.7b",
  extendedContext: true,
  "compaction.asyncEnabled": false,
  "compaction.methodOrder": ["remote", "snapcompact", "handoff", "shake", "soft"],
  "providers.openai-codex.codeMode": "auto",
};

function renderSettings(options: { preview?: boolean; runtimeSettings?: RuntimeSettingsApi } = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview === true ? "1" : "0");
  return render(
    <PreviewModeProvider switchEnabled>
      <I18nProvider forcedLanguage="zh">
        <SettingsPage
          onSetApprovalMode={vi.fn()}
          {...(options.runtimeSettings === undefined ? {} : { runtimeSettings: options.runtimeSettings })}
        />
      </I18nProvider>
    </PreviewModeProvider>,
  );
}

function openTab(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

describe("Runtime settings seam", () => {
  it("keeps the seven settings disabled without a Runtime snapshot", () => {
    renderSettings();

    openTab("文件与终端");
    expect((screen.getByRole("switch", { name: "自动修复编辑" }) as HTMLButtonElement).disabled).toBe(true);

    openTab("任务与执行");
    expect((screen.getByRole("combobox", { name: "意外停止检测" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "意外停止模型" }) as HTMLSelectElement).disabled).toBe(true);

    openTab("上下文与记忆");
    expect((screen.getByRole("switch", { name: "扩展上下文" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "异步压缩" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "压缩方法顺序" }) as HTMLSelectElement).disabled).toBe(true);

    openTab("高级");
    expect((screen.getByRole("combobox", { name: "Codex code mode" }) as HTMLSelectElement).disabled).toBe(true);
  });

  it("renders the snapshot and sends only the closed whitelist keys", async () => {
    const onSet = vi.fn();
    renderSettings({ runtimeSettings: { snapshot, compactionSpeculation: "running", onSet } });

    openTab("文件与终端");
    fireEvent.click(screen.getByRole("switch", { name: "自动修复编辑" }));
    await waitFor(() => expect(onSet).toHaveBeenCalledTimes(1));

    openTab("任务与执行");
    fireEvent.change(screen.getByRole("combobox", { name: "意外停止检测" }), { target: { value: "mechanical" } });
    await waitFor(() => expect(onSet).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("combobox", { name: "意外停止模型" }), { target: { value: "online" } });
    await waitFor(() => expect(onSet).toHaveBeenCalledTimes(3));

    openTab("上下文与记忆");
    const extended = screen.getByRole("switch", { name: "扩展上下文" });
    const asyncCompaction = screen.getByRole("switch", { name: "异步压缩" });
    expect((extended as HTMLButtonElement).disabled).toBe(false);
    expect((asyncCompaction as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(extended);
    await waitFor(() => expect(onSet).toHaveBeenCalledTimes(4));
    fireEvent.click(asyncCompaction);
    await waitFor(() => expect(onSet).toHaveBeenCalledTimes(5));
    fireEvent.change(screen.getByRole("combobox", { name: "压缩方法顺序" }), { target: { value: "snapcompact,remote,handoff,shake,soft" } });
    await waitFor(() => expect(onSet).toHaveBeenCalledTimes(6));
    expect(screen.getByText("运行中")).toBeTruthy();

    openTab("高级");
    fireEvent.change(screen.getByRole("combobox", { name: "Codex code mode" }), { target: { value: "on" } });
    await waitFor(() => expect(onSet).toHaveBeenCalledTimes(7));

    expect(onSet.mock.calls).toEqual([
      ["edit.autoRepair.enabled", false],
      ["features.unexpectedStopDetection", "mechanical"],
      ["providers.unexpectedStopModel", "online"],
      ["extendedContext", false],
      ["compaction.asyncEnabled", true],
      ["compaction.methodOrder", ["snapcompact", "remote", "handoff", "shake", "soft"]],
      ["providers.openai-codex.codeMode", "on"],
    ]);
  });

  it("keeps preview writes local and never calls the Host callback", () => {
    const onSet = vi.fn();
    renderSettings({ preview: true, runtimeSettings: { snapshot, onSet } });
    openTab("文件与终端");
    const control = screen.getByRole("switch", { name: "自动修复编辑" });
    expect((control as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(control);
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("演示");
  });

  it("uses the Runtime schema defaults in preview mode", () => {
    renderSettings({ preview: true });

    openTab("文件与终端");
    expect((screen.getByRole("switch", { name: "自动修复编辑" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");

    openTab("任务与执行");
    expect((screen.getByRole("combobox", { name: "意外停止检测" }) as HTMLSelectElement).value).toBe("mechanical");
    expect((screen.getByRole("combobox", { name: "意外停止模型" }) as HTMLSelectElement).value).toBe("online");

    openTab("上下文与记忆");
    expect((screen.getByRole("switch", { name: "扩展上下文" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("switch", { name: "异步压缩" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("combobox", { name: "压缩方法顺序" }) as HTMLSelectElement).value).toBe("remote,snapcompact,handoff,shake,soft");

    openTab("高级");
    expect((screen.getByRole("combobox", { name: "Codex code mode" }) as HTMLSelectElement).value).toBe("off");
  });

  it("localizes every compaction speculation state", () => {
    const labels = [
      ["idle", "空闲"],
      ["running", "运行中"],
      ["armed", "已准备"],
    ] as const;
    for (const [state, label] of labels) {
      const view = renderSettings({ runtimeSettings: { snapshot, compactionSpeculation: state } });
      openTab("上下文与记忆");
      expect(screen.getByText(label)).toBeTruthy();
      view.unmount();
    }
  });

  it("announces a pending Runtime update", () => {
    renderSettings({ runtimeSettings: { snapshot, pendingKey: "extendedContext" } });
    openTab("上下文与记忆");
    const pending = screen.getAllByRole("status").find((node) => node.textContent?.includes("正在更新 Runtime"));
    expect(pending).toBeTruthy();
    expect(pending?.getAttribute("aria-live")).toBe("polite");
  });
});
