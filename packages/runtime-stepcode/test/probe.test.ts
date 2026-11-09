import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

// Compiled output sits one directory deeper than the sources, so resolve the
// sibling package from this file rather than from a fixed relative depth.
const runtimeResolver = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "../../studio-host/dist/src/runtime-resolver.js"), resolve(here, "../../../studio-host/dist/src/runtime-resolver.js")]) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  throw new Error("studio-host is not built; run the workspace build first");
})();
const { createProcessProbe } = (await import(runtimeResolver)) as {
  createProcessProbe: (options: {
    cleanupWorkspace?: boolean;
    onOutput?: (stream: "stdout" | "stderr", text: string) => void;
    env?: NodeJS.ProcessEnv;
  }) => {
    probe: (context: unknown) => Promise<{
      failure?: string;
      failureDetail?: string;
      smoke?: string;
      shutdown?: string;
      hello?: { capabilityManifest: { profile: string } };
    }>;
  };
};

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The Host's own probe decides whether a runtime is usable at all, and a
 * runtime that does not exit cleanly on shutdown is *rejected* — not limited.
 * The demo only exercises connect + snapshot, so this is the first time the
 * adapter meets the real gate.
 */
test("the adapter passes the Host's runtime probe", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "step-studio-probe-"));
  // The probe's own options (output, cleanup) belong to the factory; only the
  // candidate description goes to `probe()`.
  const probe = createProcessProbe({
    cleanupWorkspace: true,
    // The probe isolates HOME and the OMP profile dirs; the adapter still needs
    // to know which Step to drive.
    env: { STEP_STUDIO_RUNTIME_CMD: `${process.execPath} ${here("../../test/fake-step.mjs")}` },
    onOutput: (name: "stdout" | "stderr", text: string) => {
      if (name === "stderr") process.stderr.write(`[runtime] ${text}`);
    },
  });

  try {
    const outcome = await probe.probe({
      platform: process.platform,
      arch: process.arch,
      workspaceDirectory: workspace,
      supportedProtocolVersions: [1],
      probeTimeoutMs: 20_000,
      // The probe spawns the executable with its own bridge args, so the
      // adapter must be reachable as an executable — not as a Node script.
      executablePath: here("../../bin/step-studio-runtime"),
      args: [],
    } as never);

    assert.equal(outcome.failure, undefined, `probe failed: ${outcome.failureDetail ?? "unknown"}`);
    assert.equal(outcome.smoke, "passed");
    // A limited runtime may skip the command manifest; it must still shut down.
    assert.equal(outcome.shutdown, "passed", `shutdown was ${outcome.shutdown}`);
    assert.equal(outcome.hello?.capabilityManifest.profile, "limited");
  } finally {
    // The probe owns the child it spawned; nothing to clean up here.
  }
});
