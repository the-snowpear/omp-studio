import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandReceipt, CommandRequestId, EnvironmentReadModel, RuntimeConnection, StudioClient } from "@omp-studio/client-contract";
import { DiagnosticsPage, DIAGNOSTICS_INTENT_KEY, setDiagnosticsIntent } from "./DiagnosticsPage";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { UPDATE_CHECK_TIMEOUT_MS } from "./updateCheck";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
  window.sessionStorage.removeItem(DIAGNOSTICS_INTENT_KEY);
});

function fakeClient(): StudioClient & { readonly query: ReturnType<typeof vi.fn>; readonly command: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    throw new Error("query should not run in preview");
  });
  const command = vi.fn(async () => {
    throw new Error("command should not run in preview");
  });
  return { query, command, bootstrap: vi.fn(), subscribe: vi.fn(), close: vi.fn() } as unknown as StudioClient & {
    readonly query: ReturnType<typeof vi.fn>;
    readonly command: ReturnType<typeof vi.fn>;
  };
}

function renderPage(options: {
  preview?: boolean;
  client?: StudioClient;
  runtime?: RuntimeConnection;
  environment?: EnvironmentReadModel;
} = {}) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, options.preview === false ? "0" : "1");
  const client = options.client ?? fakeClient();
  render(
    <PreviewModeProvider>
      <DiagnosticsPage
        client={client}
        {...(options.runtime === undefined ? {} : { runtime: options.runtime })}
        {...(options.environment === undefined ? {} : { environment: options.environment })}
      />
    </PreviewModeProvider>,
  );
  return client;
}

describe("DiagnosticsPage", () => {
  it("shows the update hero and version tiles in preview", () => {
    renderPage({ preview: true });
    expect(screen.getByRole("heading", { level: 1, name: "诊断中心" })).toBeTruthy();
    expect(screen.getByText("有可用 Runtime 更新")).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新 Runtime" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "检查更新" }).length).toBeGreaterThan(1);
    expect(screen.queryByText(/路径 \/ PID/)).toBeNull();
    expect(screen.getByText("托管 Runtime").parentElement?.textContent).toContain("v0.82.1");
    expect(screen.getAllByText(/可更新到 v0\.82\.2/).length).toBeGreaterThan(0);
  });

  it("checks updates in preview without calling Host", () => {
    const client = renderPage({ preview: true });
    fireEvent.click(screen.getAllByRole("button", { name: "检查更新" })[0]!);
    expect(screen.getByText("已检查更新（演示）· v0.82.2 可用")).toBeTruthy();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.command).not.toHaveBeenCalled();
  });

  it("confirms reinstall in preview without calling Host", () => {
    const client = renderPage({ preview: true });
    fireEvent.click(screen.getByRole("button", { name: "重装" }));
    expect(screen.getByRole("dialog", { name: "重装托管 Runtime？" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认重装" }));
    expect(screen.getByText("已重装 Runtime（演示）")).toBeTruthy();
    expect(client.command).not.toHaveBeenCalled();
  });

  it("shows a real update-available installer from the Host read model", () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
    const environment: EnvironmentReadModel = {
      platform: "win32",
      arch: "x64",
      authority: {
        authorityId: "auth-1" as EnvironmentReadModel["authority"]["authorityId"],
        authorityEpoch: 1 as EnvironmentReadModel["authority"]["authorityEpoch"],
      },
      runtime: { status: "connected", classification: "managed", runtimeVersion: "1.0.0-studio.1" },
      installer: {
        status: "update-available",
        version: "1.0.0-studio.1",
        availableVersion: "1.0.2-studio.1",
        signature: "verified",
      },
    };
    render(
      <PreviewModeProvider>
        <DiagnosticsPage
          client={fakeClient()}
          runtime={environment.runtime}
          environment={environment}
        />
      </PreviewModeProvider>,
    );
    expect(screen.getByText("有可用 Runtime 更新")).toBeTruthy();
    expect(screen.getAllByText(/可更新到 1\.0\.2-studio\.1/).length).toBeGreaterThan(0);
    expect(screen.queryByText("演示数据 · 预览开时覆盖真实读模型")).toBeNull();
    expect(screen.queryByText(/路径 \/ PID/)).toBeNull();
  });

  it("honors a check-update intent on mount in preview", () => {
    setDiagnosticsIntent("check-update");
    renderPage({ preview: true });
    expect(screen.getByText("已检查更新（演示）· v0.82.2 可用")).toBeTruthy();
  });

  it("stays quiet when the automatic update check times out", async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => new Promise<never>(() => undefined));
    const client = { ...fakeClient(), query };
    renderPage({ preview: false, client });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    });
    expect(screen.queryByText("检查更新超时")).toBeNull();
    expect(screen.queryByText("检查更新失败")).toBeNull();
    expect(query).toHaveBeenCalled();
  });

  it("reports a timeout only for a manual update check", async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => new Promise<never>(() => undefined));
    const client = { ...fakeClient(), query };
    renderPage({ preview: false, client });
    fireEvent.click(screen.getAllByRole("button", { name: "检查更新" })[0]!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    });
    expect(screen.getByText("检查更新超时")).toBeTruthy();
  });

  it("shows a Chinese launch-failure reason in the preview fail scenario", () => {
    renderPage({ preview: true });
    fireEvent.click(screen.getByRole("button", { name: "预览：有可用更新" }));
    fireEvent.click(screen.getByRole("button", { name: "预览：环境正常" }));
    expect(screen.getByText("Runtime 安装失败")).toBeTruthy();
    expect(screen.getAllByText(/Runtime 启动失败：Studio Bridge handshake timed out/).length).toBeGreaterThan(0);
  });

  it("shows a Chinese unavailable reason from the Host read model", () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
    const environment: EnvironmentReadModel = {
      platform: "win32",
      arch: "x64",
      authority: {
        authorityId: "auth-1" as EnvironmentReadModel["authority"]["authorityId"],
        authorityEpoch: 1 as EnvironmentReadModel["authority"]["authorityEpoch"],
      },
      runtime: {
        status: "unavailable",
        classification: "unavailable",
        unavailableCode: "no-workspace",
        unavailableReason: "no workspace is selected",
      },
      installer: { status: "installed", version: "1.0.0-studio.1", signature: "verified" },
    };
    render(
      <PreviewModeProvider>
        <DiagnosticsPage
          client={fakeClient()}
          runtime={environment.runtime}
          environment={environment}
          diagnostics={{
            generatedAt: "2026-08-18T06:26:07.000Z",
            authority: environment.authority,
            redacted: true,
            entries: [{
              entryId: "diag-1" as never,
              scope: "host",
              level: "warning",
              message: "Runtime is not available: no workspace is selected",
              detail: { code: "no-workspace", reason: "no workspace is selected" },
              occurredAt: "2026-08-18T06:26:07.000Z",
            }],
          }}
        />
      </PreviewModeProvider>,
    );
    expect(screen.getByText("未选择工作区")).toBeTruthy();
    expect(screen.getAllByText("未选择工作区，Runtime 不会启动").length).toBeGreaterThan(0);
    expect(screen.queryByText("Runtime is not available")).toBeNull();
  });

  it("shows a Chinese disconnect reason from the Host read model", () => {
    window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
    const environment: EnvironmentReadModel = {
      platform: "win32",
      arch: "x64",
      authority: {
        authorityId: "auth-1" as EnvironmentReadModel["authority"]["authorityId"],
        authorityEpoch: 1 as EnvironmentReadModel["authority"]["authorityEpoch"],
      },
      runtime: {
        status: "disconnected",
        classification: "managed",
        disconnectCode: "process-exit",
        disconnectReason: "Runtime process exited (code=1)",
      },
      installer: { status: "installed", version: "1.0.0-studio.1", signature: "verified" },
    };
    render(
      <PreviewModeProvider>
        <DiagnosticsPage
          client={fakeClient()}
          runtime={environment.runtime}
          environment={environment}
        />
      </PreviewModeProvider>,
    );
    expect(screen.getByText("Runtime 进程已退出")).toBeTruthy();
    expect(screen.getAllByText(/Runtime 进程已退出：Runtime process exited \(code=1\)/).length).toBeGreaterThan(0);
  });

  it("recheck ensures a disconnected runtime instead of only re-querying", async () => {
    const requestId = "req-ensure" as CommandRequestId;
    const authority = {
      authorityId: "auth-1" as EnvironmentReadModel["authority"]["authorityId"],
      authorityEpoch: 1 as EnvironmentReadModel["authority"]["authorityEpoch"],
    };
    const disconnected: RuntimeConnection = {
      status: "disconnected",
      classification: "managed",
      disconnectCode: "process-exit",
      disconnectReason: "Runtime process exited (code=1)",
    };
    const connected: RuntimeConnection = { status: "connected", classification: "managed", runtimeVersion: "1.0.0-studio.1" };
    const environment: EnvironmentReadModel = {
      platform: "win32",
      arch: "x64",
      authority,
      runtime: disconnected,
      installer: { status: "installed", version: "1.0.0-studio.1", signature: "verified" },
    };
    const query = vi.fn(async (name: string) => {
      if (name === "environment.get") {
        return { ...environment, runtime: connected };
      }
      if (name === "diagnostics.get") {
        return { generatedAt: "2026-08-18T06:26:07.000Z", authority, redacted: true, entries: [] };
      }
      if (name === "capabilities.get") {
        return { profile: "full-parity-v1", generatedAt: "2026-08-18T06:26:07.000Z", hash: "cap", capabilities: [] };
      }
      throw new Error(`unexpected query ${name}`);
    });
    const command = vi.fn(async (name: string) => {
      if (name !== "runtime.ensure") throw new Error(`unexpected command ${name}`);
      return { requestId };
    });
    const subscribe = vi.fn((_scope: unknown, listener: (event: { kind: string; receipt?: CommandReceipt }) => void) => {
      queueMicrotask(() => {
        listener({
          kind: "command.receipt",
          receipt: {
            requestId,
            commandName: "runtime.ensure",
            status: "completed",
            result: connected,
            observedAt: "2026-08-18T06:26:07.000Z",
          },
        });
      });
      return () => undefined;
    });
    const client = { query, command, subscribe, bootstrap: vi.fn(), close: vi.fn() } as unknown as StudioClient & {
      readonly query: ReturnType<typeof vi.fn>;
      readonly command: ReturnType<typeof vi.fn>;
    };
    renderPage({ preview: false, client, runtime: disconnected, environment });
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => {
      expect(command).toHaveBeenCalledWith("runtime.ensure", {});
      expect(screen.getByText("Runtime 已重新连接")).toBeTruthy();
    });
  });
});
