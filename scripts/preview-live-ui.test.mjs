import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";

import { shouldRebuildFor, startLiveUiPreview } from "./preview-live-ui.mjs";

const rendererRoot = join("D:", "Project", "omp-studio", "apps", "renderer");

test("renderer sources that reach the bundle trigger a rebuild", () => {
  for (const relative of [
    "src/App.tsx",
    "src/components/Button.tsx",
    "src/styles/workbench.css",
    "index.html",
    "graphic-preview.html",
    "src/lib/util.ts",
  ]) {
    assert.equal(shouldRebuildFor(join(rendererRoot, relative)), true, relative);
  }
});

test("dependency, build output and test files do not trigger a rebuild", () => {
  // A rebuild runs the full vite build; reacting to these wastes seconds.
  for (const relative of [
    "node_modules/react/index.js",
    join("src", "node_modules", "react", "index.js"),
    join("dist", "index.html"),
    join("dist", "assets", "index-abc123.js"),
    join("src", "App.navigation.test.tsx"),
    "README.md",
  ]) {
    assert.equal(shouldRebuildFor(join(rendererRoot, relative)), false, relative);
  }
});

test("stopping live preview releases recursive watchers and prevents further builds", async t => {
  const directory = await mkdtemp(join(tmpdir(), "studio-live-preview-"));
  const renderer = join(directory, "renderer");
  const cli = join(directory, "npm.cjs");
  await mkdir(renderer);
  await writeFile(cli, 'require("node:fs").writeFileSync("rebuilt", "yes"); process.exit(1);');
  const preview = await startLiveUiPreview({ rendererRoot: renderer, repoRoot: directory, npmCli: cli, devServerPort: "0" });
  t.after(async () => { preview.stop(); await rm(directory, { recursive: true, force: true }); });
  preview.stop();
  await writeFile(join(renderer, "App.tsx"), "export const App = null;");
  await setTimeout(650);
  await assert.rejects(access(join(directory, "rebuilt")), { code: "ENOENT" });
});
