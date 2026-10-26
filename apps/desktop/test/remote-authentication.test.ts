import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPasswordAuthentication, sshAuthenticationRequest, type SshAuthentication, type SshAuthenticationRequest } from "../src/remote/authentication.js";

/** Helper produced by `npm run build` (`scripts/build-ssh-askpass.mjs`). */
const helperDirectory = fileURLToPath(new URL("../ssh-askpass/", import.meta.url));
const helper = join(helperDirectory, process.platform === "win32" ? "omp-ssh-askpass.exe" : "askpass.sh");
const skip = existsSync(helper) ? false : "run npm run build first (no ssh-askpass helper)";
const controller = new AbortController();
const passwordProfile = { host: "example.invalid", user: "omp-test", authMode: "password" as const, platform: "linux" as const };
const prompt = "omp-test@example.invalid's password:";

interface HelperOutcome { code: number | null; stdout: Buffer; stderr: string; }

/** Runs one already-issued askpass ticket exactly as OpenSSH does: `SSH_ASKPASS <prompt>`. */
function runRequest(request: SshAuthenticationRequest, question = prompt): Promise<HelperOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.env.SSH_ASKPASS!, [question], { env: request.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
  });
}
const runHelper = (auth: SshAuthentication, question = prompt): Promise<HelperOutcome> => runRequest(auth.request(), question);

async function withAuthentication(run: (auth: SshAuthentication) => Promise<void>, password = "test-password"): Promise<void> {
  const auth = await createPasswordAuthentication(passwordProfile, password, helperDirectory, controller.signal);
  try { await run(auth); } finally { await auth.close(); }
}

test("one askpass ticket releases the password once for the exact prompt", { skip }, async () => {
  await withAuthentication(async auth => {
    const request = auth.request();
    const first = await runRequest(request);
    assert.equal(first.code, 0);
    assert.deepEqual(first.stdout, Buffer.concat([Buffer.from("test-password"), Buffer.from("\n")]));
    assert.equal(first.stderr, "", "the helper must not log to stderr");
    const replay = await runRequest(request);
    assert.equal(replay.code, 1);
    assert.equal(replay.stdout.length, 0);
  });
});

test("host-key, key-passphrase and other-account prompts never receive the password", { skip }, async () => {
  await withAuthentication(async auth => {
    for (const question of [
      "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
      "Enter passphrase for key '/home/user/.ssh/id_ed25519':",
      "root@example.invalid's password:",
    ]) {
      const request = auth.request();
      const outcome = await runRequest(request, question);
      assert.equal(outcome.code, 1, question);
      assert.equal(outcome.stdout.length, 0, question);
      const reused = await runRequest(request);
      assert.equal(reused.code, 1, "a rejected prompt must still consume its ticket");
    }
  });
});

test("spaces, quotes, backslashes and non-ASCII bytes reach SSH unchanged", { skip }, async () => {
  const password = "p a's\"b\\c 密钥 ünïcode";
  await withAuthentication(async auth => {
    const outcome = await runHelper(auth);
    assert.equal(outcome.code, 0);
    assert.deepEqual(outcome.stdout, Buffer.from(`${password}\n`, "utf8"));
  }, password);
});

test("the password never appears in the SSH child environment or argv", { skip }, async () => {
  await withAuthentication(async auth => {
    const request = auth.request();
    const values = Object.values(request.env).filter((value): value is string => typeof value === "string");
    assert.equal(values.some(value => value.includes("test-password")), false);
    assert.equal(JSON.stringify(request.env).includes("test-password"), false, "only the short-lived ticket is exposed");
    assert.equal(prompt.includes("test-password"), false);
    request.dispose();
  });
});

test("a closed authentication refuses further tickets instead of replaying the password", { skip }, async () => {
  const auth = await createPasswordAuthentication(passwordProfile, "test-password", helperDirectory, controller.signal);
  await auth.close();
  assert.throws(() => auth.request(), /SSH 密码已清除/);
});

test("empty, multiline and oversized passwords are rejected before any helper runs", { skip }, async () => {
  for (const password of ["", "line\nbreak", "nul\0byte"]) {
    await assert.rejects(createPasswordAuthentication(passwordProfile, password, helperDirectory, controller.signal), /请输入有效的 SSH 密码/);
  }
  await assert.rejects(createPasswordAuthentication(passwordProfile, "x".repeat(4097), helperDirectory, controller.signal), /4096 个 UTF-8 字节/);
});

test("password mode refuses jump-host connections instead of forwarding the password", { skip }, async () => {
  await assert.rejects(createPasswordAuthentication({ ...passwordProfile, proxyJump: "jump.invalid" }, "test-password", helperDirectory, controller.signal));
});

test("the jump-host refusal names the unsupported feature", { skip }, async () => {
  await assert.rejects(
    createPasswordAuthentication({ ...passwordProfile, proxyJump: "jump.invalid" }, "test-password", helperDirectory, controller.signal),
    /账密模式暂不支持跳板机/,
  );
});

test("a missing helper reports an actionable error rather than failing at authentication time", { skip }, async () => {
  const empty = await mkdtemp(join(tmpdir(), "omp-askpass-missing-"));
  try {
    await assert.rejects(createPasswordAuthentication(passwordProfile, "test-password", empty, controller.signal), /账密认证组件未安装/);
  } finally { await rm(empty, { recursive: true, force: true }); }
});

test("agent connections request no askpass environment, password connections require credentials", () => {
  assert.equal(sshAuthenticationRequest({ host: "build", authMode: "agent" }), undefined);
  assert.equal(sshAuthenticationRequest({ host: "build" }), undefined);
  assert.throws(() => sshAuthenticationRequest({ host: "build", authMode: "password" }), /此连接需要密码/);
});
