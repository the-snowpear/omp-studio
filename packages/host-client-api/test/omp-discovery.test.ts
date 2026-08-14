import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createOmpExtensibilityService } from "../src/omp-extensibility-adapter.js";
import { discoverAll } from "../src/omp-discovery/index.js";
import { listOmpPluginRoots } from "../src/omp-discovery/plugin-roots.js";

const NOW = "2026-08-14T00:00:00.000Z";

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), body, "utf8");
}

async function makeEnv(): Promise<{ home: string; cwd: string }> {
  const home = await mkdtemp(join(tmpdir(), "omp-disc-"));
  const cwd = join(home, "project");
  await mkdir(join(cwd, ".omp"), { recursive: true });
  return { home, cwd };
}

async function installOmpPlugin(root: string, name: string, version: string, manifest: unknown): Promise<void> {
  const pkgDir = join(root, "node_modules", ...name.split("/"));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [name]: `^${version}` } }),
    "utf8",
  );
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version, ...(manifest === undefined ? {} : { omp: manifest }) }),
    "utf8",
  );
}

describe("omp-discovery scope alignment", () => {
  test("does not scan .gemini/skills (gemini provider removed)", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await writeSkill(join(cwd, ".gemini", "skills"), "foo", "---\nname: foo\ndescription: gemini skill\n---\n");
      await writeSkill(join(home, ".gemini", "skills"), "bar", "---\nname: bar\ndescription: gemini user skill\n---\n");
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      assert.deepEqual(result.skills.map((skill) => skill.name), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("scans opencode user (~/.config/opencode) and project (.opencode) skills", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await writeSkill(join(home, ".config", "opencode", "skills"), "oc", "---\nname: oc\ndescription: user opencode\n---\n");
      await writeSkill(join(cwd, ".opencode", "skills"), "ocp", "---\nname: ocp\ndescription: project opencode\n---\n");
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const oc = result.skills.find((skill) => skill.name === "oc");
      assert.ok(oc);
      assert.equal(oc?.scope, "global");
      assert.equal(oc?.sourceLabel, "用户");
      const ocp = result.skills.find((skill) => skill.name === "ocp");
      assert.ok(ocp);
      assert.equal(ocp?.scope, "workspace");
      assert.equal(ocp?.sourceLabel, "项目");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("scans marketplace plugin skills plus plugin.json-declared dirs (claude-plugins)", async () => {
    const { home, cwd } = await makeEnv();
    try {
      const installPath = join(home, "market-install");
      await writeSkill(join(installPath, "skills"), "mkt", "---\nname: mkt\ndescription: marketplace skill\n---\n");
      await writeSkill(
        join(installPath, "extra-skills"),
        "mkt2",
        "---\nname: mkt2\ndescription: declared skill dir\n---\n",
      );
      await mkdir(join(installPath, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(installPath, ".claude-plugin", "plugin.json"),
        JSON.stringify({ version: "9.9.9", skills: ["extra-skills", "../outside"] }),
        "utf8",
      );
      await mkdir(join(home, ".omp", "plugins"), { recursive: true });
      await writeFile(
        join(home, ".omp", "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: { "mkt@marketplace-x": [{ installPath, version: "1.0.0", enabled: true }] },
        }),
        "utf8",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const mkt = result.skills.find((skill) => skill.name === "mkt");
      assert.ok(mkt);
      assert.equal(mkt?.sourceKind, "plugin");
      assert.equal(mkt?.sourceLabel, "插件");
      const mkt2 = result.skills.find((skill) => skill.name === "mkt2");
      assert.ok(mkt2, "skills from plugin.json-declared dirs must be scanned");
      assert.equal(mkt2?.sourceKind, "plugin");
      assert.ok(result.warnings.some((item) => item.includes("outside plugin root")));

      const plugin = result.plugins.find((entry) => entry.name === "mkt");
      assert.ok(plugin);
      assert.equal(plugin?.sourceKind, "marketplace");
      assert.equal(plugin?.version, "9.9.9");
      assert.equal(plugin?.status, "configured");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("agent-plugins roots contribute skills exclusively via the agent-plugins provider", async () => {
    const { home, cwd } = await makeEnv();
    try {
      const extDir = join(home, "agent-ext");
      await mkdir(extDir, { recursive: true });
      await writeFile(
        join(extDir, "plugin.json"),
        JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0", name: "agp-ext" }),
        "utf8",
      );
      await writeSkill(join(extDir, "skills"), "agp", "---\nname: agp\ndescription: agent plugin skill\n---\n");
      await writeFile(join(cwd, ".omp", "settings.json"), JSON.stringify({ extensions: [extDir] }), "utf8");

      const internal = await discoverAll({ home, cwd });
      const skill = internal.skills.find((entry) => entry.name === "agp");
      assert.ok(skill);
      assert.equal(skill?.providerId, "agent-plugins");
      // Exclusivity: a standard Agent Plugins root must not be re-scanned by
      // omp-plugins / claude-plugins (they have higher priorities and would
      // otherwise win the dedup under their own providerId).
      assert.equal(internal.skills.filter((entry) => entry.name === "agp").length, 1);

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const view = await service.get();
      const record = view.skills.find((entry) => entry.name === "agp");
      assert.equal(record?.sourceKind, "plugin");
      assert.equal(record?.sourceLabel, "插件");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("project plugins root lists lock-only packages (npm ∪ lock union)", async () => {
    const { home, cwd } = await makeEnv();
    try {
      const projectPlugins = join(cwd, ".omp", "plugins");
      const pkgDir = join(projectPlugins, "node_modules", "lock-only");
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(projectPlugins, "package.json"),
        JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }),
        "utf8",
      );
      await writeFile(
        join(projectPlugins, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: { "lock-only": { version: "2.0.0", enabled: true } }, settings: {} }),
        "utf8",
      );
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "lock-only", version: "2.0.0", omp: { tools: "dist/tools.ts" } }),
        "utf8",
      );

      const internal = await discoverAll({ home, cwd });
      const plugin = internal.plugins.find((entry) => entry.name === "lock-only");
      assert.ok(plugin, "lock-only project plugin must be listed");
      assert.equal(plugin?.sourceKind, "npm");
      assert.equal(plugin?.enabled, true);
      assert.equal(plugin?.hasOmpManifest, true);

      // The shared root enumeration classifies it as project-scoped
      const { roots } = await listOmpPluginRoots(home, cwd);
      const root = roots.find((entry) => entry.name === "lock-only");
      assert.equal(root?.scope, "project");

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const view = await service.get();
      assert.ok(view.plugins.some((entry) => entry.name === "lock-only"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("settings extensions contribute skills to the omp-plugins scan", async () => {
    const { home, cwd } = await makeEnv();
    try {
      const extDir = join(home, "ext");
      await writeSkill(join(extDir, "skills"), "ext", "---\nname: ext\ndescription: extension skill\n---\n");
      await writeFile(join(cwd, ".omp", "settings.json"), JSON.stringify({ extensions: [extDir] }), "utf8");

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const skill = result.skills.find((entry) => entry.name === "ext");
      assert.ok(skill);
      assert.equal(skill?.sourceKind, "plugin");
      assert.equal(skill?.sourceLabel, "插件");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("native skills without description are dropped", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await writeSkill(join(cwd, ".omp", "skills"), "nodesc", "---\nname: nodesc\n---\n");
      await writeSkill(join(cwd, ".omp", "skills"), "withdesc", "---\nname: withdesc\ndescription: ok\n---\n");
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      assert.deepEqual(result.skills.map((skill) => skill.name), ["withdesc"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("managed skills without description are dropped", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await writeSkill(join(home, ".omp", "agent", "managed-skills"), "nodesc", "---\nname: nodesc\n---\n");
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      assert.deepEqual(result.skills.map((skill) => skill.name), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("priority order: project native 100 > omp-plugins 90 > claude 80 > managed 5", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await writeSkill(join(cwd, ".omp", "skills"), "a", "---\nname: a\ndescription: project native\n---\n");
      await writeSkill(join(home, ".omp", "agent", "skills"), "a", "---\nname: a\ndescription: user native\n---\n");

      const pluginsDir = join(home, ".omp", "plugins");
      await installOmpPlugin(pluginsDir, "plug", "1.0.0", { tools: "dist/tools.ts" });
      await writeSkill(join(pluginsDir, "node_modules", "plug", "skills"), "b", "---\nname: b\ndescription: plugin skill\n---\n");
      await writeSkill(join(cwd, ".claude", "skills"), "b", "---\nname: b\ndescription: claude skill\n---\n");

      await writeSkill(join(home, ".omp", "agent", "skills"), "c", "---\nname: c\ndescription: user native\n---\n");
      await writeSkill(join(home, ".omp", "agent", "managed-skills"), "c", "---\nname: c\ndescription: managed\n---\n");

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      assert.equal(result.skills.find((skill) => skill.name === "a")?.sourceLabel, "项目");
      assert.equal(result.skills.find((skill) => skill.name === "b")?.sourceLabel, "插件");
      const c = result.skills.find((skill) => skill.name === "c");
      assert.equal(c?.sourceLabel, "用户");
      assert.equal(c?.scope, "global");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("project plugin shadows user plugin of the same name", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await installOmpPlugin(join(home, ".omp", "plugins"), "shadowed", "1.0.0", { tools: "dist/tools.ts" });
      await installOmpPlugin(join(cwd, ".omp", "plugins"), "shadowed", "2.0.0", { tools: "dist/tools.ts" });

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const matches = result.plugins.filter((entry) => entry.name === "shadowed");
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.version, "2.0.0");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("lock-disabled plugins stay listed as disabled and their skills are not scanned", async () => {
    const { home, cwd } = await makeEnv();
    try {
      const pluginsDir = join(home, ".omp", "plugins");
      await installOmpPlugin(pluginsDir, "off", "1.0.0", { tools: "dist/tools.ts" });
      await writeFile(
        join(pluginsDir, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: { off: { version: "1.0.0", enabled: false } }, settings: {} }),
        "utf8",
      );
      await writeSkill(join(pluginsDir, "node_modules", "off", "skills"), "offskill", "---\nname: offskill\ndescription: disabled plugin skill\n---\n");

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const plugin = result.plugins.find((entry) => entry.name === "off");
      assert.ok(plugin, "disabled plugin stays listed");
      assert.equal(plugin?.enabled, false);
      assert.equal(result.skills.some((skill) => skill.name === "offskill"), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("frontmatter enabled: false skills stay listed as disabled inventory", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await writeSkill(join(cwd, ".omp", "skills"), "off", "---\nname: off\ndescription: disabled\nenabled: false\n---\n");
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const skill = result.skills.find((entry) => entry.name === "off");
      assert.ok(skill, "disabled skill stays listed");
      assert.equal(skill?.enabled, false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an enabled skill wins the name collision over a disabled one", async () => {
    const { home, cwd } = await makeEnv();
    try {
      await writeSkill(join(cwd, ".omp", "skills"), "clash", "---\nname: clash\ndescription: project enabled\n---\n");
      await writeSkill(
        join(home, ".omp", "agent", "skills"),
        "clash",
        "---\nname: clash\ndescription: user disabled\nenabled: false\n---\n",
      );
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const matches = result.skills.filter((entry) => entry.name === "clash");
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.enabled, true);
      assert.equal(matches[0]?.sourceLabel, "项目");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
