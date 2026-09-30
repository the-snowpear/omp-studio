import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyLoginEnvironment,
  localeToLang,
  loginShellArgs,
  mergeLoginEnvironment,
  parseLoginEnvironmentOutput,
  resolveLoginEnvironment,
  withFallbackPath,
  type ShellRunner,
} from "../src/platform/login-env.js";

const MARK = "__OMP_STUDIO_LOGIN_ENV__";
const FINDER_ENV = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/dev", SHELL: "/bin/zsh" });
const everyLocale = () => true;

test("the environment is read between the markers, whatever the profile prints around it", () => {
  const stdout = `[oh-my-zsh] update?\n${MARK}{"PATH":"/opt/homebrew/bin:/usr/bin","LANG":"zh_CN.UTF-8","N":1}${MARK}\nbye`;
  assert.deepEqual(parseLoginEnvironmentOutput(stdout), { PATH: "/opt/homebrew/bin:/usr/bin", LANG: "zh_CN.UTF-8" });
  assert.equal(parseLoginEnvironmentOutput("no markers here"), undefined);
  assert.equal(parseLoginEnvironmentOutput(`${MARK}{"PATH":`), undefined);
  assert.equal(parseLoginEnvironmentOutput(`${MARK}{broken}${MARK}`), undefined);
  assert.equal(parseLoginEnvironmentOutput(`${MARK}["PATH"]${MARK}`), undefined);
});

test("profile values win, except Electron switches, Studio's channel and shell bookkeeping", () => {
  const merged = mergeLoginEnvironment(
    { ...FINDER_ENV, ELECTRON_RUN_AS_NODE: undefined, OMP_STUDIO_MEDIA_ROOT: "/app/media", ONLY_APP: "1" },
    {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      ELECTRON_RUN_AS_NODE: "1",
      OMP_STUDIO_MEDIA_ROOT: "/profile/media",
      OMP_STUDIO_RESOLVING_ENVIRONMENT: "1",
      OMP_CODING_AGENT_DIR: "/Users/dev/.omp/agent",
      SHLVL: "2",
      PWD: "/Users/dev",
      _: "/usr/bin/env",
      HOMEBREW_PREFIX: "/opt/homebrew",
    },
  );
  assert.equal(merged.PATH, "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(merged.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(merged.OMP_STUDIO_MEDIA_ROOT, "/app/media");
  assert.equal(merged.OMP_STUDIO_RESOLVING_ENVIRONMENT, undefined);
  assert.equal(merged.OMP_CODING_AGENT_DIR, "/Users/dev/.omp/agent");
  assert.equal(merged.HOMEBREW_PREFIX, "/opt/homebrew");
  assert.equal(merged.ONLY_APP, "1");
  assert.equal(merged.SHLVL, undefined);
  assert.equal(merged.PWD, undefined);
  assert.equal(merged._, undefined);
});

test("well-known tool directories are appended once, after everything already on PATH", () => {
  const env = withFallbackPath({ PATH: "/usr/local/bin:/usr/bin" }, "/Users/dev");
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Users/dev/.bun/bin:/Users/dev/.local/bin:/Users/dev/.cargo/bin");
  assert.equal(withFallbackPath(env, "/Users/dev").PATH, env.PATH);
});

test("the UI locale becomes a UTF-8 LANG the system actually has", () => {
  assert.equal(localeToLang("zh-CN", everyLocale), "zh_CN.UTF-8");
  assert.equal(localeToLang("en_GB", everyLocale), "en_GB.UTF-8");
  assert.equal(localeToLang("zh-Hans-CN", everyLocale), "zh_CN.UTF-8");
  assert.equal(localeToLang("zh-Hant", everyLocale), "zh_TW.UTF-8");
  assert.equal(localeToLang("en", everyLocale), "en_US.UTF-8");
  assert.equal(localeToLang("", everyLocale), "en_US.UTF-8");
  assert.equal(localeToLang("en-CN", (name) => name === "en_US.UTF-8"), "en_US.UTF-8");
});

test("csh and tcsh get the one flag form they accept", () => {
  assert.deepEqual(loginShellArgs("/bin/zsh"), ["-i", "-l", "-c"]);
  assert.deepEqual(loginShellArgs("/opt/homebrew/bin/fish"), ["-i", "-l", "-c"]);
  assert.deepEqual(loginShellArgs("/bin/tcsh"), ["-ic"]);
  assert.deepEqual(loginShellArgs("/bin/csh"), ["-ic"]);
});

test("Windows and terminal launches keep the environment they were given", async () => {
  let ran = false;
  const run: ShellRunner = async () => { ran = true; return { stdout: "", timedOut: false }; };
  const env = { ...FINDER_ENV };
  assert.deepEqual(await resolveLoginEnvironment({ platform: "win32", env, run }), { env, status: "skipped" });
  const terminal = { ...FINDER_ENV, TERM: "xterm-256color" };
  assert.deepEqual(await resolveLoginEnvironment({ platform: "darwin", env: terminal, run }), { env: terminal, status: "skipped" });
  assert.equal(ran, false);
});

test("a Finder launch asks the login shell and runs the app binary as Node to print the environment", async () => {
  const calls: Array<{ shell: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
  const run: ShellRunner = async (shell, args, env, timeoutMs) => {
    calls.push({ shell, args, env, timeoutMs });
    return { stdout: `Last login\n${MARK}${JSON.stringify({ ...env, PATH: "/opt/homebrew/bin:/usr/bin:/bin", LANG: "zh_CN.UTF-8" })}${MARK}\n`, timedOut: false };
  };
  const result = await resolveLoginEnvironment({
    platform: "darwin",
    env: { ...FINDER_ENV },
    execPath: "/Applications/OMP Studio.app/Contents/MacOS/OMP Studio",
    homedir: "/Users/dev",
    locale: "en-US",
    run,
    hasLocale: everyLocale,
  });
  assert.equal(result.status, "resolved");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.shell, "/bin/zsh");
  assert.deepEqual(calls[0]!.args.slice(0, 3), ["-i", "-l", "-c"]);
  assert.equal(
    calls[0]!.args[3],
    `'/Applications/OMP Studio.app/Contents/MacOS/OMP Studio' -p '"${MARK}" + JSON.stringify(process.env) + "${MARK}"'`,
  );
  assert.equal(calls[0]!.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[0]!.env.OMP_STUDIO_RESOLVING_ENVIRONMENT, "1");
  assert.equal(calls[0]!.timeoutMs, 10_000);
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.env.OMP_STUDIO_RESOLVING_ENVIRONMENT, undefined);
  assert.equal(result.env.LANG, "zh_CN.UTF-8");
  assert.match(result.env.PATH ?? "", /^\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin:/u);
});

test("a slow or broken profile still leaves usable tool directories and a UTF-8 LANG", async () => {
  const options = { platform: "darwin" as const, homedir: "/Users/dev", locale: "zh-CN", hasLocale: everyLocale };
  const timedOut = await resolveLoginEnvironment({ ...options, env: { ...FINDER_ENV }, run: async () => ({ stdout: `${MARK}{"A":"1"}${MARK}`, timedOut: true }) });
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.env.A, undefined);
  assert.equal(timedOut.env.LANG, "zh_CN.UTF-8");
  assert.match(timedOut.env.PATH ?? "", /:\/opt\/homebrew\/bin:/u);
  const noOutput = await resolveLoginEnvironment({ ...options, env: { ...FINDER_ENV }, run: async () => ({ stdout: "zsh: command not found", timedOut: false }) });
  assert.equal(noOutput.status, "failed");
  const thrown = await resolveLoginEnvironment({ ...options, env: { ...FINDER_ENV }, run: async () => { throw new Error("spawn ENOENT"); } });
  assert.equal(thrown.status, "failed");
  assert.equal(thrown.env.LANG, "zh_CN.UTF-8");
  const withLang = await resolveLoginEnvironment({ ...options, env: { ...FINDER_ENV, LC_ALL: "C" }, run: async () => ({ stdout: "", timedOut: false }) });
  assert.equal(withLang.env.LANG, undefined);
});

test("the process environment is resolved once, however many callers ask", async () => {
  const first = applyLoginEnvironment({ platform: "win32" });
  assert.equal(applyLoginEnvironment({ platform: "darwin" }), first);
  assert.equal(await first, "skipped");
});

const posixOnly = { skip: process.platform === "win32" ? "POSIX login shells" : false } as const;

async function fakeHome(profile: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "omp-login-env-"));
  await writeFile(join(home, ".profile"), profile);
  await chmod(join(home, ".profile"), 0o644);
  return home;
}

test("a real login shell's exports reach the app", posixOnly, async (t) => {
  const home = await fakeHome("export OMP_LOGIN_ENV_PROBE=from-profile\n");
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await resolveLoginEnvironment({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/sh" },
    execPath: process.execPath,
    homedir: home,
    timeoutMs: 20_000,
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.env.OMP_LOGIN_ENV_PROBE, "from-profile");
});

test("a profile that hangs costs only the timeout", posixOnly, async (t) => {
  const home = await fakeHome("sleep 30\n");
  t.after(() => rm(home, { recursive: true, force: true }));
  const started = Date.now();
  const result = await resolveLoginEnvironment({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/sh" },
    execPath: process.execPath,
    homedir: home,
    timeoutMs: 300,
  });
  assert.equal(result.status, "timeout");
  assert.ok(Date.now() - started < 5_000);
});

test("a background job holding stdout open does not delay the result", posixOnly, async (t) => {
  const home = await fakeHome("sleep 5 &\n");
  t.after(() => rm(home, { recursive: true, force: true }));
  const started = Date.now();
  const result = await resolveLoginEnvironment({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/sh" },
    execPath: process.execPath,
    homedir: home,
    timeoutMs: 20_000,
  });
  assert.equal(result.status, "resolved");
  assert.ok(Date.now() - started < 4_000);
});
