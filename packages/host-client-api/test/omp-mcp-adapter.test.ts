import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

import { createOmpMcpService } from "../src/omp-mcp-adapter.js";

const NOW = "2026-08-15T01:00:00.000Z";

async function withTempHome<T>(run: (home: string, cwd: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(path.join(home, ".omp", "agent"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
  try {
    return await run(home, cwd);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("createOmpMcpService", () => {
  test("lists user and project servers without leaking secrets", async () => {
    await withTempHome(async (home, cwd) => {
      await fs.writeFile(
        path.join(home, ".omp", "agent", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", "/secret/path"],
              env: { TOKEN: "sekrit" },
            },
          },
          disabledServers: ["playwright"],
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(cwd, ".omp", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            github: { type: "http", url: "https://example.internal/mcp", headers: { Authorization: "Bearer x" } },
            playwright: { command: "npx", args: ["playwright"], enabled: true },
          },
        }),
        "utf8",
      );

      const service = createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW });
      const model = await service.get();
      assert.equal(model.generatedAt, NOW);
      assert.equal(model.unavailableReason, undefined);
      const names = model.servers.map((s) => s.name).sort();
      assert.deepEqual(names, ["filesystem", "github", "playwright"]);
      for (const server of model.servers) {
        assert.equal("command" in server, false);
        assert.equal("url" in server, false);
        assert.equal("headers" in server, false);
        assert.equal("env" in server, false);
        assert.equal("args" in server, false);
        const json = JSON.stringify(server);
        assert.equal(json.includes("sekrit"), false);
        assert.equal(json.includes("/secret/"), false);
        assert.equal(json.includes("Bearer"), false);
        assert.equal(json.includes("example.internal"), false);
      }
      const playwright = model.servers.find((s) => s.name === "playwright");
      assert.ok(playwright);
      assert.equal(playwright.enabled, false);
      assert.equal(playwright.status, "disabled");
      const github = model.servers.find((s) => s.name === "github");
      assert.ok(github);
      assert.equal(github.transport, "http");
      assert.equal(github.scope, "project");
      assert.equal(github.enabled, true);
    });
  });

  test("setEnabled disables and re-enables via mcp.json + denylist", async () => {
    await withTempHome(async (home, cwd) => {
      await fs.writeFile(
        path.join(home, ".omp", "agent", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            filesystem: { command: "npx", args: ["fs"] },
          },
        }),
        "utf8",
      );
      const service = createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW });
      let model = await service.get();
      assert.equal(model.servers[0]?.enabled, true);

      const off = await service.setEnabled({ name: "filesystem", enabled: false });
      assert.equal(off.applied, true);
      model = await service.get();
      assert.equal(model.servers[0]?.enabled, false);
      assert.equal(model.servers[0]?.status, "disabled");

      const on = await service.setEnabled({ name: "filesystem", enabled: true });
      assert.equal(on.applied, true);
      model = await service.get();
      assert.equal(model.servers[0]?.enabled, true);
      assert.equal(model.servers[0]?.status, "enabled");
    });
  });

  test("project root .mcp.json is discovered", async () => {
    await withTempHome(async (home, cwd) => {
      await fs.writeFile(
        path.join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            sqlite: { command: "sqlite-mcp" },
          },
        }),
        "utf8",
      );
      const service = createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW });
      const model = await service.get();
      assert.equal(model.servers.length, 1);
      assert.equal(model.servers[0]?.name, "sqlite");
      assert.equal(model.servers[0]?.scope, "project");
      assert.equal(model.servers[0]?.transport, "stdio");
    });
  });

  test("discovers Codex config.toml mcp_servers (OMP cross-tool parity)", async () => {
    await withTempHome(async (home, cwd) => {
      const codexDir = path.join(home, ".codex");
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        path.join(codexDir, "config.toml"),
        `
[mcp_servers.blender]
type = "stdio"
command = "cmd"
args = ["/c", "uvx", "blender-mcp"]

[mcp_servers.blender.env]
BLENDER_HOST = "127.0.0.1"

[mcp_servers.sts2]
command = "uv"
args = ["run", "python", "server.py"]
cwd = 'D:\\games\\demo'
enabled = true

[mcp_servers.node_repl]
command = 'C:\\tools\\node_repl.exe'
args = []
`,
        "utf8",
      );

      const service = createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW });
      const model = await service.get();
      assert.deepEqual(
        model.servers.map((s) => s.name).sort(),
        ["blender", "node_repl", "sts2"],
      );
      for (const server of model.servers) {
        assert.equal(server.sourceLabel, "Codex");
        assert.equal(server.scope, "user");
        assert.equal(server.enabled, true);
        assert.equal(server.transport, "stdio");
        const json = JSON.stringify(server);
        assert.equal(json.includes("BLENDER_HOST"), false);
        assert.equal(json.includes("node_repl.exe"), false);
        assert.equal(json.includes("D:\\\\games"), false);
      }

      const off = await service.setEnabled({ name: "blender", enabled: false });
      assert.equal(off.applied, true);
      const after = await service.get();
      assert.equal(after.servers.find((s) => s.name === "blender")?.enabled, false);
      const native = JSON.parse(await fs.readFile(path.join(home, ".omp", "agent", "mcp.json"), "utf8")) as {
        disabledServers?: string[];
      };
      assert.ok(native.disabledServers?.includes("blender"));
    });
  });

  test("discovers native user .mcp.json", async () => {
    await withTempHome(async (home, cwd) => {
      await fs.writeFile(
        path.join(home, ".omp", "agent", ".mcp.json"),
        JSON.stringify({ mcpServers: { extra: { command: "extra-mcp" } } }),
        "utf8",
      );
      const model = await createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW }).get();
      assert.equal(model.servers[0]?.name, "extra");
      assert.equal(model.servers[0]?.sourceLabel, "用户");
    });
  });

  test("discovers Cursor, Claude, Gemini, OpenCode, VS Code, and Windsurf configs", async () => {
    await withTempHome(async (home, cwd) => {
      await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
      await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
      await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
      await fs.mkdir(path.join(home, ".codeium", "windsurf"), { recursive: true });
      await fs.mkdir(path.join(cwd, ".vscode"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { cursor_fs: { command: "cursor-mcp" } } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { claude_fs: { command: "claude-mcp" } } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(home, ".gemini", "settings.json"),
        JSON.stringify({ mcpServers: { gemini_fs: { command: "gemini-mcp", type: "stdio" } } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(home, ".config", "opencode", "opencode.json"),
        JSON.stringify({ mcp: { oc_remote: { type: "remote", url: "https://example.invalid/mcp" } } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(home, ".codeium", "windsurf", "mcp_config.json"),
        JSON.stringify({ mcpServers: { wind: { command: "wind-mcp" } } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(cwd, ".vscode", "mcp.json"),
        JSON.stringify({ mcp: { servers: { vscode_http: { transport: "http", url: "https://localhost/mcp" } } } }),
        "utf8",
      );

      const model = await createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW }).get();
      const byName = Object.fromEntries(model.servers.map((s) => [s.name, s]));
      assert.equal(byName.cursor_fs?.sourceLabel, "Cursor");
      assert.equal(byName.claude_fs?.sourceLabel, "Claude");
      assert.equal(byName.gemini_fs?.sourceLabel, "Gemini");
      assert.equal(byName.gemini_fs?.transport, "stdio");
      assert.equal(byName.oc_remote?.sourceLabel, "OpenCode");
      assert.equal(byName.oc_remote?.transport, "http");
      assert.equal(byName.wind?.sourceLabel, "Windsurf");
      assert.equal(byName.vscode_http?.sourceLabel, "VS Code");
      assert.equal(byName.vscode_http?.transport, "http");
      const json = JSON.stringify(model.servers);
      assert.equal(json.includes("example.invalid"), false);
      assert.equal(json.includes("localhost"), false);
    });
  });

  test("discovers omp-plugins .mcp.json from settings extensions", async () => {
    await withTempHome(async (home, cwd) => {
      const ext = path.join(cwd, "ext-pack");
      await fs.mkdir(ext, { recursive: true });
      await fs.writeFile(
        path.join(ext, ".mcp.json"),
        JSON.stringify({ mcpServers: { pack_tool: { command: "pack-mcp" } } }),
        "utf8",
      );
      await fs.writeFile(path.join(cwd, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }), "utf8");
      const model = await createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW }).get();
      assert.equal(model.servers[0]?.name, "pack_tool");
      assert.equal(model.servers[0]?.sourceLabel, "插件");
    });
  });

  test("discovers agent-plugins mcp.json as namespaced servers", async () => {
    await withTempHome(async (home, cwd) => {
      const ext = path.join(cwd, "weather-pack");
      await fs.mkdir(ext, { recursive: true });
      await fs.writeFile(
        path.join(ext, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "weather",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(ext, "mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { lookup: { type: "stdio", command: "weather-mcp" } },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(cwd, ".omp", "settings.json"), JSON.stringify({ extensions: [ext] }), "utf8");
      const model = await createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW }).get();
      assert.equal(model.servers[0]?.name, "weather:lookup");
      assert.equal(model.servers[0]?.sourceLabel, "Agent Plugin");
    });
  });

  test("discovers claude-plugins marketplace .mcp.json", async () => {
    await withTempHome(async (home, cwd) => {
      const install = path.join(home, "plugins", "demo-mcp");
      await fs.mkdir(install, { recursive: true });
      await fs.mkdir(path.join(home, ".claude", "plugins"), { recursive: true });
      await fs.writeFile(
        path.join(install, ".mcp.json"),
        JSON.stringify({ mcpServers: { gh: { command: "gh-mcp" } } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "demo-mcp@shop": [{ installPath: install, version: "1.0.0", enabled: true, scope: "user" }],
          },
        }),
        "utf8",
      );
      const model = await createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW }).get();
      assert.equal(model.servers[0]?.name, "demo-mcp:gh");
      assert.equal(model.servers[0]?.sourceLabel, "Claude 插件");
    });
  });

  test("native project config shadows lower-priority mcp-json of the same name", async () => {
    await withTempHome(async (home, cwd) => {
      await fs.writeFile(
        path.join(cwd, ".omp", "mcp.json"),
        JSON.stringify({ mcpServers: { shared: { command: "native-one" } } }),
        "utf8",
      );
      await fs.writeFile(
        path.join(cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { shared: { command: "fallback-one" } } }),
        "utf8",
      );
      const model = await createOmpMcpService({ home, getCwd: () => cwd, now: () => NOW }).get();
      const rows = model.servers.filter((s) => s.name === "shared");
      assert.equal(rows.length, 2);
      const winner = rows.find((s) => s.status !== "shadowed");
      const shadowed = rows.find((s) => s.status === "shadowed");
      assert.equal(winner?.sourceLabel, "项目");
      assert.ok(shadowed);
    });
  });
});

