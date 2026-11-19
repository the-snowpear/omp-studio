import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWslDistributions, wslCommandArgs, assertDistroName } from "../src/remote/wsl.js";
import { detectRemoteEnvironment } from "../src/remote/probe.js";
import { RemoteConnectionManager } from "../src/remote/manager.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("English and Chinese WSL lists preserve default, version and running status", () => {
  for (const [header, encoding] of [["名称 状态 版本", "utf16le"], ["NAME STATE VERSION", "utf8"]] as const) {
    const list = Buffer.from(header + "\r\n  Alpine 已停止 1\r\n* Ubuntu Running 2\r\n docker-desktop 已停止 2\r\n rancher-desktop-data Running 2", encoding);
    assert.deepEqual(parseWslDistributions(list, Buffer.from("Ubuntu\r\n", encoding)), [
      { name: "Ubuntu", isDefault: true, running: true, version: 2 }, { name: "Alpine", isDefault: false, running: false, version: 1 },
    ]);
  }
});
test("WSL executes only the base64 command and rejects option-like distribution names", () => {
  const script = "echo '中文 $HOME'";
  const args = wslCommandArgs("Ubuntu-24.04", script);
  assert.equal(args.at(-1), Buffer.from(script).toString("base64"));
  assert.ok(!args.join(" ").includes(script));
  for (const bad of ["-d", "", "two words"]) assert.throws(() => assertDistroName(bad));
});
test("saved WSL profiles use distribution defaults and preserve the last directory", async t => {
  const dir = await mkdtemp(join(tmpdir(), "omp-wsl-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "profiles.json");
  const manager = new RemoteConnectionManager(path, dir);
  const value = await manager.save({ kind: "wsl", distro: "Debian", name: "", host: "-bad", authMode: "password", networkMode: "local-only" });
  assert.equal(value.id, "wsl-Debian");
  await manager.rememberDirectory(value.id, "/home/test");
  const [loaded] = (await new RemoteConnectionManager(path, dir).list()).profiles;
  assert.equal(loaded?.networkMode, "remote-first");
  assert.equal(loaded?.authMode, undefined);
  assert.equal(loaded?.lastDirectory, "/home/test");
});

test("a failed POSIX probe in WSL never invokes Windows PowerShell through interop", async () => {
  const commands: string[] = [];
  await assert.rejects(detectRemoteEnvironment({ kind: "wsl", host: "Ubuntu", distro: "Ubuntu" }, undefined, undefined, async (_profile, command) => {
    commands.push(command); return "__OMP_PROBE__\nDarwin\nx86_64";
  }), /Linux/u);
  assert.equal(commands.length, 1);
  assert.ok(!commands[0]?.includes("powershell.exe"));
});
