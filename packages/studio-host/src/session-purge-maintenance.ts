import { execFile, type ChildProcess, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RuntimeInstallationManifest, SessionPurgeResult } from "@omp-studio/studio-protocol";

/**
 * This hidden selector first ships in this pinned Studio line. Update this
 * gate deliberately when upgrading the pin: probing an older CLI could treat
 * an unknown selector as chat input. Call only with signature-verified metadata.
 */
export function supportsSessionPurgeMaintenance(manifest: RuntimeInstallationManifest): boolean {
  return (
    (manifest.upstreamVersion === "18.20.2" && manifest.upstreamCommit === "7c49c11aa5bbaf3f418406583096168ad5b8c6dc") ||
    (manifest.upstreamVersion === "19.0.1" && manifest.upstreamCommit === "f40f335845f0b136453d12fec8d6057011082766")
  ) && /^studio\.[1-9]\d*$/u.test(manifest.patchsetVersion);
}

/** Private Host-located identity, never supplied directly by a Renderer command. */
export interface SessionPurgeInput {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly agentDir: string;
  readonly signal?: AbortSignal;
}

export interface SessionPurgeMaintenancePort {
  run(input: SessionPurgeInput): Promise<SessionPurgeResult>;
  dispose(): void;
}

export interface SessionPurgeMaintenanceOptions {
  /** Must resolve through RuntimeInstaller.currentManifest(), not PATH or a cached executable name. */
  readonly executablePath: () => Promise<string | undefined>;
  /** Host-owned directory: deletion must also work when the saved workspace no longer exists. */
  readonly workingDirectory: string;
  readonly timeoutMs?: number;
  /** Same profile environment as the managed Runtime; injectable for isolated process tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Source-entry arguments for internal tests; production uses the signed executable directly. */
  readonly args?: readonly string[];
  readonly execFile?: typeof execFile;
  readonly onDiagnostic?: (info: { status: SessionPurgeResult["status"]; reason?: string }) => void;
}

const SELECTOR = "__omp_worker_session_purge";

/**
 * A one-shot Runtime maintenance process, not a Broker resident. Node's execFile
 * owns the timeout, output bounds and forced termination; completion waits for
 * stdio close, so unlink never races a still-running purge process.
 */
export function createNodeSessionPurgeMaintenance(options: SessionPurgeMaintenanceOptions): SessionPurgeMaintenancePort {
  const children = new Set<ChildProcess>();
  let disposed = false;
  const unavailable = (reason: "cancelled" | "runtime-unavailable"): SessionPurgeResult => ({ status: "partial", reason });
  const run = async (input: SessionPurgeInput): Promise<SessionPurgeResult> => {
    if (disposed || input.signal?.aborted) return unavailable("cancelled");
    let executable: string | undefined;
    try { executable = await options.executablePath(); }
    catch { return unavailable("runtime-unavailable"); }
    if (disposed || input.signal?.aborted) return unavailable("cancelled");
    if (!executable) return unavailable("runtime-unavailable");
    const requestId = randomUUID();
    let closed = Promise.resolve();
    const result = await new Promise<SessionPurgeResult>(resolve => {
      let child: ChildProcess;
      const finish = (error: ExecFileException | null, stdout: string): void => {
        if (disposed || input.signal?.aborted) { resolve(unavailable("cancelled")); return; }
        if (error) {
          resolve({ status: "partial", reason: error.killed && error.signal === "SIGKILL" ? "timeout" : "process-failed" });
          return;
        }
        // Only the private stdio envelope is checked. Native per-store evidence
        // is authoritative; the Host never re-queries SQLite or validates rows.
        try {
          const response = JSON.parse(stdout) as { schemaVersion?: number; requestId?: string; result?: SessionPurgeResult };
          if (response?.schemaVersion !== 1 || response.requestId !== requestId || response.result === undefined) {
            resolve({ status: "partial", reason: "unsupported-runtime" });
          } else resolve(response.result);
        } catch { resolve({ status: "partial", reason: "unsupported-runtime" }); }
      };
      try {
        child = (options.execFile ?? execFile)(executable, [...(options.args ?? []), SELECTOR], {
          cwd: options.workingDirectory,
          env: options.env ?? process.env,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: 64 * 1024,
          killSignal: "SIGKILL",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }, finish);
        children.add(child);
        closed = new Promise<void>(resolveClose => child.once("close", () => { children.delete(child); resolveClose(); }));
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify({
          schemaVersion: 1, requestId, sessionId: input.sessionId,
          sessionFile: input.sessionFile, agentDir: input.agentDir,
        }), "utf8");
      } catch { resolve({ status: "partial", reason: "process-failed" }); }
    });
    // AbortSignal errors can reach execFile's callback before the child closes.
    await closed;
    try { options.onDiagnostic?.({ status: result.status, ...(result.status === "partial" ? { reason: result.reason } : {}) }); }
    catch { /* Diagnostics never change deletion. */ }
    return result;
  };
  return {
    run,
    dispose() {
      disposed = true;
      for (const child of children) child.kill("SIGKILL");
    },
  };
}
