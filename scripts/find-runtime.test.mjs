import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../.github/scripts/find-runtime.sh", import.meta.url));
const bash = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../..", "bin/bash.exe")
  : "bash";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-runtime-cache-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init");
  git("config", "user.name", "Runtime cache test");
  git("config", "user.email", "test@example.invalid");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); };
  const write = async (path, contents) => {
    await mkdir(resolve(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), contents);
  };
  await write("omp-patch/vendor/oh-my-pi/package.json", '{"version":"1"}');
  await write("omp-patch/overlay/host.ts", "host v1");
  await write("packaging/keys/public.pem", "public key v1");
  commit();
  const startup = join(cwd, "mock-gh.sh");
  await writeFile(startup, `gh() {
    printf '%s\\n' "$*" >> "$REQUEST_LOG"
    case "$CACHE_HIT:$2" in
      desktop:*) echo 42 ;;
      remote:*name=*-remote*) echo 84 ;;
    esac
  }
  `);
  const run = async (cacheHit, rebuild = "false") => {
    const output = join(cwd, "result");
    const log = join(cwd, "requests");
    await writeFile(output, ""); await writeFile(log, "");
    execFileSync(bash, [script.replaceAll("\\", "/")], {
      cwd, encoding: "utf8", env: {
        ...process.env, BASH_ENV: startup.replaceAll("\\", "/"),
        GITHUB_OUTPUT: output, REQUEST_LOG: log, CACHE_HIT: cacheHit,
        GITHUB_REPOSITORY: "example/studio", PLATFORM: "win32-x64",
        BUN_VERSION: "1.4.2", OMP_RUNTIME_CHANNEL: "stable", REBUILD: rebuild,
      },
    });
    return {
      ...Object.fromEntries((await readFile(output, "utf8")).trimEnd().split("\n").map(line => line.split("="))),
      requests: await readFile(log, "utf8"),
    };
  };
  return { run, write, commit };
}

test("Runtime reuse downloads the matching desktop or remote artifact; force bypasses lookup", async t => {
  const { run } = await fixture(t);
  const desktop = await run("desktop");
  assert.equal(desktop.run_id, "42");
  assert.equal(desktop.name, desktop.key);
  const remote = await run("remote");
  assert.equal(remote.run_id, "84");
  assert.equal(remote.name, `${remote.key}-remote`);
  const forced = await run("desktop", "true");
  assert.equal(forced.run_id, "");
  assert.equal(forced.requests, "");
  const missing = await run("none");
  assert.equal(missing.run_id, "");
  assert.equal(missing.key, desktop.key);
});

test("Runtime identity survives desktop edits and changes with Runtime sources or signing keys", async t => {
  const { run, write, commit } = await fixture(t);
  const original = (await run("none")).key;
  await write("apps/renderer/src/App.tsx", "desktop v2"); commit();
  assert.equal((await run("none")).key, original);
  await write("omp-patch/overlay/host.ts", "host v2"); commit();
  const runtime = (await run("none")).key;
  assert.notEqual(runtime, original);
  await write("packaging/keys/public.pem", "public key v2"); commit();
  assert.notEqual((await run("none")).key, runtime);
});
