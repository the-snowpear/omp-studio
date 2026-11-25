import assert from "node:assert/strict";
import test from "node:test";
import { REMOTE_UPLOAD_TIMING, hasUploadStalled, remoteUploadRoutes, runUploadFallback, scpLegacyArguments, scpRemotePath, sftpArguments, sftpQuote, sftpRemotePath } from "../src/remote/file-transfer.js";
import { RemoteConnectionError } from "../src/remote/errors.js";

const connection = { host: "deskserver", user: "the_snowpear", port: 2222, authMode: "agent" as const };

test("Windows configuration uploads prefer SFTP and retain SCP and SSH stream fallbacks", () => {
  assert.deepEqual(remoteUploadRoutes("win32", "ssh"), ["sftp", "scp-legacy", "ssh-stream"]);
  assert.deepEqual(remoteUploadRoutes("linux", "ssh"), ["ssh-stream", "sftp"]);
  assert.deepEqual(remoteUploadRoutes("linux", "wsl"), ["ssh-stream"]);
});

test("SFTP and legacy SCP arguments preserve SSH connection options", () => {
  assert.deepEqual(sftpArguments(connection), ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-P", "2222", "-b", "-", "the_snowpear@deskserver"]);
  assert.deepEqual(scpLegacyArguments(connection, "C:\\tmp\\package.zip", "C:\\Users\\the_snowpear\\AppData\\Local\\omp-studio\\remote\\package.zip", "win32").slice(-2), ["C:\\tmp\\package.zip", "the_snowpear@deskserver:'C:/Users/the_snowpear/AppData/Local/omp-studio/remote/package.zip'"]);
});

test("password-mode transfer arguments retain password-only SSH options", () => {
  const passwordConnection = { ...connection, authMode: "password" as const };
  const args = sftpArguments(passwordConnection);
  assert.equal(args[1], "BatchMode=no");
  assert.deepEqual(args.slice(-3), ["-b", "-", "the_snowpear@deskserver"]);
  assert.ok(args.includes("PreferredAuthentications=password"));
  assert.ok(args.includes("KbdInteractiveAuthentication=no"));
});

test("Windows SFTP paths and batch quoting are stable", () => {
  assert.equal(sftpRemotePath("C:\\Users\\someone\\App Data\\package.zip", "win32"), "/C:/Users/someone/App Data/package.zip");
  assert.equal(sftpQuote("C:\\Users\\someone\\App Data\\package.zip"), '"C:/Users/someone/App Data/package.zip"');
  assert.equal(scpRemotePath("C:\\Users\\O'Brien\\App Data\\package.zip", "win32"), `'C:/Users/O'\\''Brien/App Data/package.zip'`);
});

test("upload fallback timing uses a 30 second no-growth window", () => {
  assert.equal(REMOTE_UPLOAD_TIMING.inactivityMs, 30_000);
  assert.equal(REMOTE_UPLOAD_TIMING.pollMs, 5_000);
  assert.equal(REMOTE_UPLOAD_TIMING.routeTimeoutMs, 600_000);
  assert.equal(hasUploadStalled(70_000, 99_999), false);
  assert.equal(hasUploadStalled(70_000, 100_000), true);
});

test("a retryable first route is cleaned before trying the fallback", async () => {
  const attempts: string[] = [];
  const cleanups: string[] = [];
  const result = await runUploadFallback(["sftp", "scp-legacy"], async route => {
    attempts.push(route);
    if (route === "sftp") throw new RemoteConnectionError("network", "no remote growth");
    return "verified";
  }, async route => { cleanups.push(route); });
  assert.deepEqual(attempts, ["sftp", "scp-legacy"]);
  assert.deepEqual(cleanups, ["sftp"]);
  assert.deepEqual(result, { route: "scp-legacy", value: "verified" });
});

test("Windows uploads retain the SSH stream path when both copy helpers fail", async () => {
  const attempts: string[] = [];
  const cleanups: string[] = [];
  const result = await runUploadFallback(["sftp", "scp-legacy", "ssh-stream"], async route => {
    attempts.push(route);
    if (route !== "ssh-stream") throw new RemoteConnectionError("network", `${route} unavailable`);
    return "verified";
  }, async route => { cleanups.push(route); });
  assert.deepEqual(attempts, ["sftp", "scp-legacy", "ssh-stream"]);
  assert.deepEqual(cleanups, ["sftp", "scp-legacy"]);
  assert.deepEqual(result, { route: "ssh-stream", value: "verified" });
});

test("authentication, host-key, configuration, and cancellation failures stop before fallback", async () => {
  for (const code of ["authentication", "host-key", "configuration", "cancelled"] as const) {
    const attempts: string[] = [];
    const cleanups: string[] = [];
    await assert.rejects(runUploadFallback(["sftp", "scp-legacy"], async route => {
      attempts.push(route);
      throw new RemoteConnectionError(code, "terminal failure");
    }, async route => { cleanups.push(route); }), /terminal failure/);
    assert.deepEqual(attempts, ["sftp"], code);
    assert.deepEqual(cleanups, code === "cancelled" ? ["sftp"] : [], code);
  }
});
