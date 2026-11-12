import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { commandArguments, resolveCommandShell } from "../src/terminal-command.js";
import { remoteTerminalCommand } from "../src/remote/terminal.js";
import { TerminalSessionManager, type PtySpawnOptions } from "../src/terminal-pty.js";

test("Windows Bash selects Git Bash even when the WSL launcher comes first", () => {
  const files = new Set(['C:\\Windows\\System32\\bash.exe', 'D:\\Program Files\\Git\\cmd\\git.exe', 'D:\\Program Files\\Git\\bin\\bash.exe']);
  const shell = resolveCommandShell({ shell: "bash", text: "pwd" }, { platform: "win32", env: { PATH: 'C:\\Windows\\System32;D:\\Program Files\\Git\\cmd' }, exists: file => files.has(file) });
  assert.equal(shell.file, 'D:\\Program Files\\Git\\bin\\bash.exe');
});

test("a whole multiline command runs with its own interpreter and preserves literal quoting", () => {
  for (const command of [
    { shell: "bash" as const, text: 'value="hello world"\nprintf "%s\\n" "$value"\nprintf "%s\\n" "quote: \' and 中文"' },
    { shell: "powershell" as const, text: '$value = "hello world"\nWrite-Output $value\nWrite-Output "quote: \' and 中文"' },
  ]) {
    // PowerShell is optional on Unix; Windows ships at least Windows PowerShell.
    if (command.shell === "powershell" && process.platform !== "win32") continue;
    const shell = resolveCommandShell(command);
    const result = spawnSync(shell.file, commandArguments(command), { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /hello world/);
    assert.match(result.stdout, /quote: '/);
  }
});

test("CRLF scripts run with Unix interpreters locally and over SSH", () => {
  const command = { shell: "bash" as const, text: 'set -e\r\nif true; then\r\n  printf "%s" "中文 ok"\r\nfi' };
  const args = commandArguments(command);
  assert.equal(args[1], command.text.replace(/\r\n/g, "\n"));
  const shell = resolveCommandShell(command);
  const result = spawnSync(shell.file, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, "中文 ok");
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const remote = remoteTerminalCommand(platform, platform === "win32" ? "D:\\work" : "/work", command);
    const script = platform === "win32" ? Buffer.from(remote.slice(1, -1).split(" ").at(-1)!, "base64").toString("utf16le") : remote;
    assert.ok(!script.includes("\r"));
  }
});

test("terminal manager starts a command in the requested workspace without writing into an interactive shell", () => {
  let spawned!: PtySpawnOptions;
  const writes: string[] = [];
  const manager = new TerminalSessionManager({ spawner: { spawn: options => {
    spawned = options;
    return { write: text => writes.push(text), resize() {}, kill() {}, onData() {}, onExit() {} };
  } } });
  const command = { shell: "bash" as const, text: 'printf "%s\\n" "a b"\npwd' };
  const info = manager.create(1, { cols: 80, rows: 24, command }, { onData() {}, onExit() {} }, process.cwd());
  assert.equal(spawned.cwd, process.cwd());
  assert.deepEqual(spawned.args, ["-lc", command.text]);
  assert.deepEqual(writes, []);
  manager.dispose(1, info.id);
});

test("SSH commands retain their selected shell, workspace and complete script", () => {
  const command = { shell: "bash" as const, text: 'printf "%s\\n" "a \' quote"\npwd' };
  const unix = remoteTerminalCommand("linux", "/work dir/a'b", command);
  assert.match(unix, /&& exec bash '-lc'/);
  assert.ok(unix.includes("'\\''"));
  assert.ok(unix.includes("\npwd"));
  const windows = remoteTerminalCommand("win32", "D:\\work dir", command);
  const script = Buffer.from(windows.slice(1, -1).split(" ").at(-1)!, "base64").toString("utf16le");
  assert.ok(script.includes("Set-Location -LiteralPath 'D:\\work dir'"));
  assert.ok(script.includes("Get-Command git.exe"));
  assert.ok(script.includes("bin\\bash.exe"));
  assert.ok(script.includes("\npwd"));
});
