import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDefaultShell, shellArgs, terminalEnvironment } from "../src/terminal-pty.js";

test("macOS opens the account's login shell, then $SHELL, then zsh", () => {
  assert.deepEqual(resolveDefaultShell({ platform: "darwin", env: { SHELL: "/bin/bash" }, accountShell: () => "/opt/homebrew/bin/fish" }), {
    name: "fish",
    file: "/opt/homebrew/bin/fish",
  });
  assert.deepEqual(resolveDefaultShell({ platform: "darwin", env: { SHELL: "/bin/bash" }, accountShell: () => undefined }), { name: "bash", file: "/bin/bash" });
  assert.deepEqual(resolveDefaultShell({ platform: "darwin", env: {}, accountShell: () => undefined }), { name: "zsh", file: "/bin/zsh" });
  assert.deepEqual(resolveDefaultShell({ platform: "linux", env: {}, accountShell: () => "/bin/zsh" }), { name: "bash", file: "/bin/bash" });
});

test("macOS shells start as login shells, and interactive when there is no PTY", () => {
  assert.deepEqual(shellArgs("/bin/zsh", { platform: "darwin", backend: "pty" }), ["-l"]);
  assert.deepEqual(shellArgs("/bin/zsh", { platform: "darwin", backend: "pipes" }), ["-il"]);
  assert.deepEqual(shellArgs("/bin/tcsh", { platform: "darwin", backend: "pipes" }), ["-i", "-l"]);
  assert.deepEqual(shellArgs("/usr/local/bin/pwsh", { platform: "darwin", backend: "pty" }), ["-NoLogo"]);
  assert.deepEqual(shellArgs("C:\\Windows\\System32\\cmd.exe", { platform: "win32", backend: "pty" }), []);
  assert.deepEqual(shellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe", { platform: "win32", backend: "pty" }), ["-NoLogo"]);
});

test("the macOS shell gets a terminal name and none of Electron's switches; Windows keeps its environment", () => {
  const source = { PATH: "/opt/homebrew/bin:/usr/bin", LANG: "zh_CN.UTF-8", ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" };
  const mac = terminalEnvironment(source, "darwin");
  assert.equal(mac.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(mac.ELECTRON_NO_ATTACH_CONSOLE, undefined);
  assert.equal(mac.TERM_PROGRAM, "OMP-Studio");
  assert.equal(mac.LANG, "zh_CN.UTF-8");
  assert.equal(mac.TERM, "xterm-256color");
  const windows = terminalEnvironment(source, "win32");
  assert.deepEqual(windows, { ...source, TERM: "xterm-256color", COLORTERM: "truecolor" });
});
