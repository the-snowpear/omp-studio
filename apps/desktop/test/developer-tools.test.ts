import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkspaceRegistry } from "@omp-studio/studio-host";

import { createDesktopGitService } from "../src/git-service.js";
import { HostProcessError, HostProcessRunner } from "../src/git-process.js";
import { COMMAND_LINE_TOOLS_MISSING, createCommandLineToolsGuard, resolveCommandOnPath } from "../src/platform/developer-tools.js";

const onDisk = (...paths: string[]) => (path: string) => paths.includes(path);

test("commands resolve through PATH the way execvp does", () => {
  const isExecutable = onDisk("/usr/bin/git", "/opt/homebrew/bin/git");
  assert.equal(resolveCommandOnPath("git", "/opt/homebrew/bin:/usr/bin", isExecutable), "/opt/homebrew/bin/git");
  assert.equal(resolveCommandOnPath("git", ":/usr/bin/:/bin", isExecutable), "/usr/bin/git");
  assert.equal(resolveCommandOnPath("gh", "/usr/bin", isExecutable), undefined);
  assert.equal(resolveCommandOnPath("/usr/local/bin/git", "", isExecutable), "/usr/local/bin/git");
});

test("Apple's git stub never runs without the Command Line Tools", async () => {
  let probes = 0;
  const guard = createCommandLineToolsGuard({
    isExecutable: onDisk("/usr/bin/git"),
    developerDirectory: async () => { probes += 1; return undefined; },
    exists: () => false,
    now: () => 0,
  });
  assert.equal(await guard.unavailableReason("git", { PATH: "/usr/bin:/bin" }), COMMAND_LINE_TOOLS_MISSING);
  assert.equal(await guard.unavailableReason("git", { PATH: "/usr/bin:/bin" }), COMMAND_LINE_TOOLS_MISSING);
  assert.equal(probes, 1);
});

test("Homebrew git, gh and installed Command Line Tools are left alone", async () => {
  let probes = 0;
  const developerDirectory = async () => { probes += 1; return "/Library/Developer/CommandLineTools"; };
  const guard = createCommandLineToolsGuard({
    isExecutable: onDisk("/usr/bin/git", "/opt/homebrew/bin/git", "/opt/homebrew/bin/gh"),
    developerDirectory,
    exists: onDisk("/Library/Developer/CommandLineTools/usr/bin/git"),
  });
  assert.equal(await guard.unavailableReason("git", { PATH: "/opt/homebrew/bin:/usr/bin" }), undefined);
  assert.equal(await guard.unavailableReason("gh", { PATH: "/opt/homebrew/bin:/usr/bin" }), undefined);
  assert.equal(probes, 0);
  assert.equal(await guard.unavailableReason("git", { PATH: "/usr/bin" }), undefined);
  assert.equal(await guard.unavailableReason("git", { PATH: "/usr/bin" }), undefined);
  assert.equal(probes, 1);
});

test("installing the Command Line Tools is noticed without a restart", async () => {
  let clock = 0;
  let installed = false;
  const guard = createCommandLineToolsGuard({
    isExecutable: onDisk("/usr/bin/git"),
    developerDirectory: async () => (installed ? "/Library/Developer/CommandLineTools" : undefined),
    exists: () => installed,
    now: () => clock,
  });
  assert.equal(await guard.unavailableReason("git", { PATH: "/usr/bin" }), COMMAND_LINE_TOOLS_MISSING);
  installed = true;
  clock = 10_000;
  assert.equal(await guard.unavailableReason("git", { PATH: "/usr/bin" }), COMMAND_LINE_TOOLS_MISSING);
  clock = 31_000;
  assert.equal(await guard.unavailableReason("git", { PATH: "/usr/bin" }), undefined);
});

test("a blocked command fails as unavailable before anything is spawned", async () => {
  const seen: string[] = [];
  const runner = new HostProcessRunner({
    commandLineTools: { unavailableReason: async (command) => { seen.push(command); return COMMAND_LINE_TOOLS_MISSING; } },
  });
  await assert.rejects(
    runner.run({ command: "definitely-not-a-real-command-omp", args: ["--version"] }),
    (error: unknown) => error instanceof HostProcessError && error.kind === "unavailable" && error.message === COMMAND_LINE_TOOLS_MISSING,
  );
  assert.deepEqual(seen, ["definitely-not-a-real-command-omp"]);
});

test("the Git toolchain row explains the missing Command Line Tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-clt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = new HostProcessRunner({
    commandLineTools: { unavailableReason: async (command) => (command === "git" ? COMMAND_LINE_TOOLS_MISSING : undefined) },
  });
  const service = createDesktopGitService({
    registry: new WorkspaceRegistry(join(root, "registry.json")),
    pickDirectory: async () => undefined,
    preferencesPath: join(root, "git-preferences.json"),
    runner,
  });
  const toolchain = await service.toolchain();
  assert.deepEqual(toolchain.git, { available: false, unavailableReason: COMMAND_LINE_TOOLS_MISSING });
});
