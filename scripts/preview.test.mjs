import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const launcher = join(import.meta.dirname, "preview.mjs");
const npmCli = process.env.OMP_NPM_CLI
  ?? process.env.npm_execpath
  ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

test("preview repairs incomplete dependencies and command links without rerunning existing install scripts", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "studio-preview-commands-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "preview-command-regression",
    version: "1.0.0",
    scripts: { build: "tsc && vite && node stop-build.cjs" },
    dependencies: {
      electron: "file:fixtures/electron",
      typescript: "file:fixtures/typescript",
      vite: "file:fixtures/vite",
      "preview-support": "file:fixtures/preview-support",
    },
  }));
  // Stop after exercising the npm commands, before the launcher opens Electron.
  await writeFile(join(root, "stop-build.cjs"), "process.exit(23);");
  await writeFile(join(root, "install-side-effect.cjs"), 'require("node:fs").writeFileSync("install-ran", "yes");');
  for (const [name, command] of [["electron", null], ["typescript", "tsc"], ["vite", "vite"], ["preview-support", null]]) {
    const directory = join(root, "fixtures", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name,
      version: "1.0.0",
      main: "index.cjs",
      ...(command ? { bin: { [command]: "command.cjs" } } : {}),
      scripts: { install: "node ../../install-side-effect.cjs" },
    }));
    await writeFile(join(directory, "index.cjs"), "module.exports = true;");
    if (command) {
      await writeFile(join(directory, "command.cjs"), `#!/usr/bin/env node
require("preview-support");
require("node:fs").writeFileSync(${JSON.stringify(`${command}-ran`)}, "yes");
`);
    }
  }

  const env = { ...process.env, npm_config_offline: "true", npm_config_install_links: "false" };
  await execute(process.execPath, [npmCli, "install", "--ignore-scripts", "--bin-links=false", "--no-audit", "--no-fund"], {
    cwd: root,
    env,
    windowsHide: true,
  });
  await rm(join(root, "node_modules", "preview-support"), { recursive: true });

  const launch = () => execute(process.execPath, [launcher], {
    cwd: root,
    env: {
      ...env,
      OMP_NPM_CLI: npmCli,
      OMP_PREVIEW_MODE: "",
      OMP_PREVIEW_DATA: "1",
    },
    windowsHide: true,
  }).catch((error) => error);

  const repaired = await launch();
  assert.equal(repaired.code, 1, repaired.stdout + repaired.stderr);
  assert.ok(existsSync(join(root, "tsc-ran")), repaired.stdout + repaired.stderr);
  assert.ok(existsSync(join(root, "vite-ran")), repaired.stdout + repaired.stderr);
  assert.match(repaired.stderr, /exited with 23/);
  for (const directory of [root, ...["electron", "typescript", "vite"].map((name) => join(root, "fixtures", name))]) {
    assert.equal(existsSync(join(directory, "install-ran")), false);
  }

  const ready = await launch();
  assert.equal(ready.code, 1, ready.stdout + ready.stderr);
  assert.match(ready.stderr, /exited with 23/);
  assert.doesNotMatch(ready.stdout, /rebuilt dependencies successfully/);
});
