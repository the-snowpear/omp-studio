import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify, parseArgs } from "node:util";
import { open, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { RemotePeer, type RemoteAttachment } from "./wire.js";
import { RemoteConnectionError } from "./errors.js";
import { remotePlatform, remoteStateRoot, secureRemoteDirectory } from "./platform.js";
import { remoteAuthority } from "./authority.js";
import { withCodeSignatureCheck } from "../platform/code-signature.js";
import type { RemoteHello } from "./server.js";

async function acquireMaintenance(state: string): Promise<() => Promise<void>> {
  const { key, liveness } = remoteAuthority(state);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await liveness.acquire(key)) return () => liveness.release(key);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Remote Host is still running; Runtime installation was not started");
}

async function installRuntime(state: string, artifact: string, keyDirectory: string): Promise<void> {
  const { RuntimeInstaller, createSmokeTestRunner, verifySignedArtifact, parseRuntimeInstallationManifest, RUNTIME_ARTIFACT_LAYOUT } = await import("@omp-studio/runtime-installer");
  const { loadInstallerTrustedKeys } = await import("../runtime-install.js");
  const keys = await loadInstallerTrustedKeys(keyDirectory, { environment: false });
  if (!keys) throw new Error("No trusted signing keys");
  const { manifest } = await verifySignedArtifact({ directory: artifact, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: value => ["runtime-manifest.json", value.entrypoint], trustedKeys: keys.trustedKeys });
  if (manifest.platform !== `${process.platform}-${process.arch}`) throw new Error("Runtime target does not match this machine");
  const release = await acquireMaintenance(state);
  try {
    const savedKeys = await loadInstallerTrustedKeys(join(state, "keys"), { environment: false });
    const trustedKeys = { ...savedKeys?.trustedKeys, ...keys.trustedKeys };
    const installer = new RuntimeInstaller(join(state, "runtimes"), { trustedKeys });
    await installer.install(artifact);
    const smoke = withCodeSignatureCheck(createSmokeTestRunner({ env: { ...process.env, OMP_AGENT_DIR: join(state, "agent"), PI_CODING_AGENT_DIR: join(state, "agent"), OMP_PROFILE: "", PI_PROFILE: "" } }));
    const directory = join(state, "keys");
    await secureRemoteDirectory(directory);
    const mapping: Record<string, string> = {};
    for (const [id, value] of Object.entries(trustedKeys)) {
      const name = `key-${createHash("sha256").update(value).digest("hex")}.pem`;
      await writeFile(join(directory, name), value, { mode: 0o600 });
      mapping[id] = name;
    }
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ keys: mapping }), { flag: "wx", mode: 0o600 });
    await rename(temporary, join(directory, "trusted-keys.json"));
    const result = await installer.activate(manifest.runtimeVersion, { selfCheck: smoke });
    process.stdout.write(JSON.stringify(result));
  } finally { await release(); }
}

export async function runRemoteHost(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    state: { type: "string" }, runtime: { type: "string" }, keys: { type: "string" }, "agent-dir": { type: "string" }, artifact: { type: "string" },
  } });
  const mode = positionals[0];
  if (positionals.length !== 1 || !["serve", "attach", "network", "start", "install", "probe"].includes(mode ?? "")) throw new Error("Usage: host.mjs start|serve|attach|network|install|probe --state <directory>");
  const state = resolve(values.state ?? remoteStateRoot(remotePlatform(process.platform)));
  const { connectRemoteEndpoint } = await import("./server.js");
  if (mode === "probe") {
    if (!values.runtime) throw new Error("Runtime binary required");
    const { createProcessProbe } = await import("@omp-studio/studio-host");
    const { tmpdir } = await import("node:os");
    const result = await createProcessProbe().probe({ executablePath: resolve(values.runtime), platform: process.platform, arch: process.arch, workspaceDirectory: tmpdir(), supportedProtocolVersions: [1], probeTimeoutMs: 60_000 });
    if (result.failure || !result.hello || !result.commandManifest || result.smoke !== "passed" || result.shutdown !== "passed") throw new Error(`Runtime probe failed: ${JSON.stringify(result)}`);
    process.stdout.write(JSON.stringify({ runtimeVersion: result.hello.runtimeVersion, upstreamVersion: result.hello.upstreamVersion, upstreamCommit: result.hello.upstreamCommit, selectedProtocolVersion: result.hello.selectedProtocolVersion, profile: result.hello.capabilityManifest.profile, capabilityHash: result.hello.capabilityManifest.hash, commandManifestHash: result.commandManifest.hash }));
    return;
  }
  if (mode === "install") {
    if (!values.artifact || !values.keys) throw new Error("Signed artifact and explicit trusted keys required");
    await secureRemoteDirectory(state);
    await installRuntime(state, resolve(values.artifact), resolve(values.keys));
    return;
  }
  if (mode === "attach" || mode === "network") {
    const downstream = new RemotePeer(process.stdin, process.stdout);
    let upstream: RemotePeer | undefined;
    let opening: Promise<RemotePeer> | undefined;
    let closed = false;
    let off: (() => void) | undefined;
    downstream.onClose(() => { closed = true; off?.(); upstream?.close(); });
    downstream.handle(async (method, input) => {
      if (!opening) {
        if (method !== "hello") throw new RemoteConnectionError("protocol", "Remote attachment must start with hello");
        const attachment = input && typeof input === "object" && "attachment" in input ? input.attachment as RemoteAttachment : undefined;
        opening = connectRemoteEndpoint(state, false, attachment, mode === "network").then(peer => {
          if (closed) { peer.close(); throw new RemoteConnectionError("cancelled", "Remote attachment was cancelled"); }
          upstream = peer;
          off = peer.onEvent(event => downstream.publish(event));
          if (mode === "network") {
            peer.handle((method, input) => downstream.request(method, input));
            downstream.onEvent(event => peer.publish(event));
          }
          peer.onClose(error => downstream.close(error));
          return peer;
        });
      }
      const peer = await opening;
      return peer.request(method, input);
    });
    return;
  }
  const entry = fileURLToPath(import.meta.url);
  const bundleVersion = createHash("sha256").update(await readFile(entry)).digest("hex");
  if (mode === "start") {
    let current: RemotePeer | undefined;
    try { current = await connectRemoteEndpoint(state, true); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    }
    if (current) {
      try {
        const hello = await current.request<RemoteHello>("hello");
        if (hello.bundleVersion === bundleVersion) { process.stdout.write('{"ready":true,"reused":true}\n'); return; }
        await current.request("shutdown");
      } finally { current.close(); }
      const release = await acquireMaintenance(state);
      await release();
    }
    await secureRemoteDirectory(state);
    const out = await open(join(state, "server.log"), "a", 0o600);
    let failed: Error | undefined;
    try {
      const args = [entry, "serve", ...argv.slice(1)];
      if (process.platform === "win32") {
        const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
        const commandLine = [process.execPath, ...args].map(value => `"${value}"`).join(" ");
        const script = `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${quote(commandLine)};CurrentDirectory=${quote(state)}};if($r.ReturnValue -ne 0){throw 'Remote Host start failed'}`;
        await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 15_000, windowsHide: true });
      } else {
        const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out.fd, out.fd] });
        child.once("error", error => { failed = error; });
        child.unref();
      }
    } finally { await out.close(); }
    for (let attempt = 0; attempt < 240; attempt++) {
      if (failed) throw failed;
      await new Promise(resolve => setTimeout(resolve, 250));
      let peer: RemotePeer | undefined;
      try {
        peer = await connectRemoteEndpoint(state, true);
        const hello = await peer.request<RemoteHello>("hello");
        if (hello.bundleVersion !== bundleVersion) throw new Error("A different remote Host is still active");
        process.stdout.write('{"ready":true,"reused":false}\n');
        return;
      } catch (error) { if (attempt === 239) throw error; }
      finally { peer?.close(); }
    }
    throw new Error("Remote Host did not become ready");
  }
  const agentDir = resolve(values["agent-dir"] ?? join(state, "agent"));
  process.env.OMP_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  await secureRemoteDirectory(agentDir);
  const { createRemoteHost } = await import("./host.js");
  const { serveRemoteHost } = await import("./server.js");
  const host = await createRemoteHost({ stateDirectory: state, runtimeDirectory: resolve(values.runtime ?? join(state, "runtimes")), trustedKeysDirectory: resolve(values.keys ?? join(state, "keys")) });
  let close: (() => Promise<void>) | undefined;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void close?.().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
  };
  try { const server = await serveRemoteHost(host, state, stop, bundleVersion); close = server.close; }
  catch (error) { await host.close(); throw error; }
  process.stderr.write(`OMP Studio remote Host ready (${process.platform}/${process.arch}); Runtime ${host.composition.status}\n`);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRemoteHost(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
