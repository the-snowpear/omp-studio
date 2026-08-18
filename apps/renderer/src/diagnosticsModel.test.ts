import { describe, expect, it } from "vitest";
import type { EnvironmentReadModel, RuntimeConnection } from "@omp-studio/client-contract";
import { deriveDiagnosticsView, formatDiagnosticEntryMessage } from "./diagnosticsModel";

const authority = {
  authorityId: "auth-1" as EnvironmentReadModel["authority"]["authorityId"],
  authorityEpoch: 1 as EnvironmentReadModel["authority"]["authorityEpoch"],
};

function runtime(status: RuntimeConnection["status"], extra: Partial<RuntimeConnection> = {}): RuntimeConnection {
  return { status, classification: status === "connected" ? "managed" : "unavailable", runtimeVersion: "v0.82.1", ...extra };
}

function environment(installer: EnvironmentReadModel["installer"], connection = runtime("connected")): EnvironmentReadModel {
  return { platform: "win32", arch: "x64", authority, runtime: connection, installer };
}

describe("deriveDiagnosticsView", () => {
  it("treats a newer local artifact as the update hero", () => {
    const view = deriveDiagnosticsView({
      runtime: runtime("connected"),
      environment: environment({
        status: "update-available",
        version: "v0.82.1",
        availableVersion: "v0.82.2",
        signature: "verified",
      }),
    });
    expect(view.hero.kind).toBe("update");
    expect(view.hero.title).toBe("有可用 Runtime 更新");
    expect(view.hero.primary).toBe("update");
    expect(view.hero.showReinstall).toBe(true);
    expect(view.checks.find((check) => check.id === "install")?.action).toBe("update");
  });

  it("asks to install when no trusted runtime is present", () => {
    const view = deriveDiagnosticsView({
      runtime: runtime("unavailable"),
      environment: environment(
        { status: "not-installed", signature: "unknown", availableVersion: "v0.82.2" },
        runtime("unavailable"),
      ),
    });
    expect(view.hero.kind).toBe("missing");
    expect(view.hero.primary).toBe("install");
    expect(view.hero.showReinstall).toBe(false);
    expect(view.hero.detail).toContain("v0.82.2");
  });

  it("reports a healthy connected runtime", () => {
    const view = deriveDiagnosticsView({
      runtime: runtime("connected"),
      environment: environment({ status: "installed", version: "v0.82.1", signature: "verified" }),
    });
    expect(view.hero.kind).toBe("ok");
    expect(view.hero.primary).toBe("recheck");
    expect(view.hero.showReinstall).toBe(true);
    expect(view.checks.find((check) => check.id === "runtime")?.tone).toBe("ok");
  });

  it("offers reinstall when the installed runtime is disconnected", () => {
    const view = deriveDiagnosticsView({
      runtime: runtime("disconnected"),
      environment: environment(
        { status: "installed", version: "v0.82.1", signature: "verified" },
        runtime("disconnected"),
      ),
    });
    expect(view.hero.kind).toBe("down");
    expect(view.hero.primary).toBe("recheck");
    expect(view.hero.showReinstall).toBe(true);
  });

  it("names a missing workspace instead of a generic unavailable hero", () => {
    const connection = runtime("unavailable", {
      unavailableCode: "no-workspace",
      unavailableReason: "no workspace is selected",
    });
    const view = deriveDiagnosticsView({
      runtime: connection,
      environment: environment({ status: "installed", version: "v0.82.1", signature: "verified" }, connection),
    });
    expect(view.hero.kind).toBe("down");
    expect(view.hero.title).toBe("未选择工作区");
    expect(view.hero.detail).toContain("选择项目后才会启动 Runtime");
    expect(view.checks.find((check) => check.id === "runtime")?.detail).toContain("未选择工作区");
  });

  it("names a launch failure with the Host reason", () => {
    const connection = runtime("unavailable", {
      unavailableCode: "launch-failed",
      unavailableReason: "Studio Bridge handshake timed out",
    });
    const view = deriveDiagnosticsView({
      runtime: connection,
      environment: environment({ status: "installed", version: "v0.82.1", signature: "verified" }, connection),
    });
    expect(view.hero.title).toBe("Runtime 启动失败");
    expect(view.hero.detail).toContain("Studio Bridge handshake timed out");
  });

  it("names a handshake timeout instead of a generic launch failure", () => {
    const connection = runtime("unavailable", {
      unavailableCode: "handshake-timeout",
      unavailableReason: "Studio Bridge handshake timed out",
    });
    const view = deriveDiagnosticsView({
      runtime: connection,
      environment: environment({ status: "installed", version: "v0.82.1", signature: "verified" }, connection),
    });
    expect(view.hero.title).toBe("Runtime 握手超时");
    expect(view.hero.detail).toContain("Studio Bridge handshake timed out");
    expect(view.checks.find((check) => check.id === "runtime")?.detail).toContain("Runtime 握手超时");
  });

  it("names a process-exit disconnect instead of a generic down hero", () => {
    const connection = runtime("disconnected", {
      classification: "managed",
      disconnectCode: "process-exit",
      disconnectReason: "Runtime process exited (code=1)",
    });
    const view = deriveDiagnosticsView({
      runtime: connection,
      environment: environment({ status: "installed", version: "v0.82.1", signature: "verified" }, connection),
    });
    expect(view.hero.kind).toBe("down");
    expect(view.hero.title).toBe("Runtime 进程已退出");
    expect(view.hero.detail).toContain("Runtime process exited (code=1)");
    expect(view.checks.find((check) => check.id === "runtime")?.detail).toContain("Runtime 进程已退出");
    expect(formatDiagnosticEntryMessage({
      entryId: "diag-1" as never,
      scope: "host",
      level: "error",
      message: "Runtime process exited: Runtime process exited (code=1)",
      detail: { code: "process-exit", reason: "Runtime process exited (code=1)" },
      occurredAt: "2026-08-18T06:26:07.000Z",
    })).toBe("Runtime 进程已退出：Runtime process exited (code=1)");
  });
});
