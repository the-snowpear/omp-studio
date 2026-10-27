import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parse } from "yaml";
import { LocalCredentialVault } from "../src/remote/local-vault.js";
import { applyRemoteProvisioning } from "../src/remote/provisioning.js";

test("model provisioning preserves unrelated remote settings and never persists OAuth refresh tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-provisioning-"));
  const previousUrl = process.env.OMP_AUTH_BROKER_URL, previousToken = process.env.OMP_AUTH_BROKER_TOKEN;
  try {
    await mkdir(join(root, "agent")); await writeFile(join(root, "agent", "config.yml"), "locale: zh\nmodelRoles:\n  default: old/model\n");
    await applyRemoteProvisioning(root, "http://127.0.0.1:12345", { modelsYml: "providers:\n  custom:\n    apiKey: fixture-api-key\n", settings: { modelRoles: { default: "custom/new" } }, brokerToken: "temporary-broker-token" });
    const config = await readFile(join(root, "agent", "config.yml"), "utf8");
    assert.match(config, /locale: zh/); assert.match(config, /custom\/new/); assert.doesNotMatch(config, /refresh/);
    assert.match(await readFile(join(root, "agent", "models.yml"), "utf8"), /fixture-api-key/);
  } finally { if (previousUrl === undefined) delete process.env.OMP_AUTH_BROKER_URL; else process.env.OMP_AUTH_BROKER_URL = previousUrl; if (previousToken === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN; else process.env.OMP_AUTH_BROKER_TOKEN = previousToken; await rm(root, { recursive: true, force: true }); }
});
test("the local credential relay filters MCP secrets and refreshes OAuth at the local vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-vault-relay-")); let refreshes = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/healthz") res.end('{"ok":true}');
    else if (req.url === "/v1/snapshot") res.end(JSON.stringify({ generation: 1, credentials: [{ id: 1, provider: "anthropic", credential: { type: "oauth", access: "access", refresh: "__remote__" } }, { id: 2, provider: "mcp:private", credential: { access: "mcp-secret" } }] }));
    else { refreshes++; res.end('{"entry":{"provider":"anthropic","credential":{"access":"new-access","refresh":"__remote__"}}}'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const brokerFile = join(root, "broker.json"); await writeFile(brokerFile, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "local-only-secret" }));
  const vault = new LocalCredentialVault({ agentDirectory: () => root, brokerFile: async () => brokerFile, runtimeExecutable: async () => { throw new Error("must use the live Runtime's vault"); } });
  try {
    const endpoint = await vault.networkEndpoint(), headers = { Authorization: `Bearer ${endpoint.token}` };
    const snapshot = await (await fetch(`${endpoint.url}/v1/snapshot`, { headers })).text();
    assert.match(snapshot, /anthropic/); assert.doesNotMatch(snapshot, /mcp-secret|mcp:private|local-only-secret/);
    const refresh = await fetch(`${endpoint.url}/v1/credential/1/refresh`, { method: "POST", headers });
    assert.equal(refresh.status, 200); assert.match(await refresh.text(), /new-access/); assert.equal(refreshes, 1);
    assert.equal((await fetch(`${endpoint.url}/v1/credential/2/refresh`, { method: "POST", headers })).status, 403);
    assert.equal((await fetch(`${endpoint.url}/v1/credential`, { method: "POST", headers })).status, 403);
  } finally { vault.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

for (const modelsYml of ["providers: {}\n", ""]) test(`local credential snapshots copy API keys with ${modelsYml ? "configured" : "empty"} models while keeping OAuth refresh tokens at home`, async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-vault-snapshot-"));
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/healthz") res.end('{"ok":true}');
    else if (req.url === "/v1/snapshot") res.end(JSON.stringify({ credentials: [
      { id: 1, provider: "openai", credential: { type: "api_key", key: "local-api-key" } },
      { id: 2, provider: "anthropic", credential: { type: "oauth", access: "short-lived", refresh: "must-stay-local" } },
      { id: 3, provider: "mcp:private", credential: { type: "api_key", key: "mcp-secret" } },
    ] }));
    else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const brokerFile = join(root, "broker.json");
  await writeFile(brokerFile, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "local-only-secret" }));
  await writeFile(join(root, "models.yml"), modelsYml);
  const vault = new LocalCredentialVault({ agentDirectory: () => root, brokerFile: async () => brokerFile, runtimeExecutable: async () => { throw new Error("must use the running local Runtime"); } });
  try {
    const snapshot = await vault.snapshot();
    const models = parse(snapshot.modelsYml) as { providers: Record<string, { apiKey?: string }> };
    assert.equal(models.providers.openai?.apiKey, "local-api-key");
    assert.equal(models.providers.anthropic?.apiKey, undefined);
    assert.equal(models.providers["mcp:private"], undefined);
    assert.doesNotMatch(snapshot.modelsYml, /must-stay-local|mcp-secret/);
  } finally { vault.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
