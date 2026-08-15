import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createOmpExtensibilityService } from "../src/omp-extensibility-adapter.js";

const NOW = "2026-08-13T15:41:14.000Z";

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), body, "utf8");
}

describe("createOmpExtensibilityService", () => {
  test("returns empty inventory when the home tree is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-ext-empty-"));
    const cwd = join(home, "cwd");
    await mkdir(cwd);
    try {
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      assert.deepEqual(result, {
        skills: [],
        plugins: [],
        warnings: [],
        generatedAt: NOW,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reads user, project, managed skills and prefers the project winner", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-ext-skills-"));
    const cwd = join(home, "project");
    const agent = join(home, ".omp", "agent");
    try {
      await writeSkill(
        join(cwd, ".omp", "skills"),
        "shared",
        "---\nname: shared\ndescription: project copy\n---\n",
      );
      await writeSkill(
        join(agent, "skills"),
        "shared",
        "---\nname: shared\ndescription: user copy\n---\n",
      );
      await writeSkill(
        join(agent, "skills"),
        "commit-msg",
        "---\nname: commit-msg\ndescription: Conventional commits\nenabled: false\n---\n",
      );
      await writeSkill(
        join(agent, "managed-skills"),
        "oss-audit",
        "---\nname: oss-audit\ndescription: OSS dependency audit\n---\n",
      );
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      assert.equal(result.unavailableReason, undefined);
      assert.deepEqual(
        result.skills.map((skill) => skill.name),
        ["commit-msg", "oss-audit", "shared"],
      );
      const shared = result.skills.find((skill) => skill.name === "shared");
      assert.equal(shared?.sourceLabel, "OMP");
      assert.equal(shared?.scope, "workspace");
      assert.equal(shared?.desc, "project copy");
      // enabled: false skills stay listed as disabled inventory
      const commitMsg = result.skills.find((skill) => skill.name === "commit-msg");
      assert.equal(commitMsg?.enabled, false);
      assert.equal(commitMsg?.scope, "global");
      const managed = result.skills.find((skill) => skill.name === "oss-audit");
      assert.equal(managed?.sourceKind, "managed");
      assert.equal(managed?.error, undefined);
      // Collision warning: user "shared" lost to the project copy
      assert.ok(result.warnings.some((item) => item.includes("shared")));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("lists plugins from package.json, lock, and project overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-ext-plugins-"));
    const cwd = join(home, "project");
    const pluginsDir = join(home, ".omp", "plugins");
    const pkgDir = join(pluginsDir, "node_modules", "demo-plugin");
    try {
      await mkdir(pkgDir, { recursive: true });
      await mkdir(join(cwd, ".omp"), { recursive: true });
      await writeFile(
        join(pluginsDir, "package.json"),
        JSON.stringify({
          name: "omp-plugins",
          private: true,
          dependencies: { "demo-plugin": "^1.2.3" },
        }),
        "utf8",
      );
      await writeFile(
        join(pluginsDir, "omp-plugins.lock.json"),
        JSON.stringify({
          plugins: { "demo-plugin": { version: "1.2.3", enabled: true, enabledFeatures: null } },
          settings: {},
        }),
        "utf8",
      );
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "demo-plugin",
          version: "1.2.3",
          omp: {
            tools: "dist/tools.ts",
            hooks: "dist/hooks.ts",
            commands: ["commands/worktree.md"],
            extensions: ["ui/sidebar.ts"],
          },
        }),
        "utf8",
      );
      await writeFile(
        join(cwd, ".omp", "plugin-overrides.json"),
        JSON.stringify({ disabled: ["demo-plugin"] }),
        "utf8",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      assert.equal(result.plugins.length, 1);
      const plugin = result.plugins[0];
      assert.equal(plugin?.name, "demo-plugin");
      assert.equal(plugin?.version, "1.2.3");
      assert.equal(plugin?.enabled, false);
      assert.equal(plugin?.status, "configured");
      assert.equal(plugin?.srcLabel, "npm");
      assert.deepEqual(plugin?.toolItems, ["dist/tools.ts"]);
      assert.deepEqual(plugin?.commandItems, ["commands/worktree.md"]);
      assert.deepEqual(plugin?.hookItems, ["dist/hooks.ts"]);
      assert.deepEqual(plugin?.uiItems, ["ui/sidebar.ts"]);
      assert.equal(plugin?.ui, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("lists packages without omp/pi as error with a path-free err", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-ext-noomp-"));
    const cwd = join(home, "project");
    const pluginsDir = join(home, ".omp", "plugins");
    const pkgDir = join(pluginsDir, "node_modules", "plain-pkg");
    try {
      await mkdir(pkgDir, { recursive: true });
      await mkdir(join(cwd, ".omp"), { recursive: true });
      await writeFile(
        join(pluginsDir, "package.json"),
        JSON.stringify({
          name: "omp-plugins",
          private: true,
          dependencies: { "plain-pkg": "^0.0.1" },
        }),
        "utf8",
      );
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "plain-pkg", version: "0.0.1" }),
        "utf8",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const plugin = result.plugins.find((entry) => entry.name === "plain-pkg");
      assert.ok(plugin);
      assert.equal(plugin?.status, "error");
      assert.equal(plugin?.err, "package.json 缺少 omp/pi");
      assert.ok(!plugin?.err?.includes(home), "err must not leak paths");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("plugins.setEnabled (whole-package toggle)", () => {
  test("marketplace toggle writes installed_plugins.json and plugins.get reflects it", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-set-mkt-"));
    const cwd = join(home, "project");
    const pluginsDir = join(home, ".omp", "plugins");
    const installPath = join(home, "mkt-install");
    try {
      await mkdir(installPath, { recursive: true });
      await mkdir(pluginsDir, { recursive: true });
      await writeFile(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          plugins: { "demo@mkt": [{ installPath, version: "1.0.0", enabled: true }] },
        }),
        "utf8",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const before = await service.get();
      assert.equal(before.plugins.find((entry) => entry.name === "demo")?.enabled, true);

      const result = await service.setEnabled({ name: "demo", enabled: false });
      assert.equal(result.applied, true);
      assert.equal(result.runtimeEffect, "new-session");

      const registry = JSON.parse(await readFile(join(pluginsDir, "installed_plugins.json"), "utf8")) as {
        plugins: Record<string, Array<{ enabled?: boolean }>>;
      };
      assert.equal(registry.plugins["demo@mkt"]?.[0]?.enabled, false);

      const after = await service.get();
      const record = after.plugins.find((entry) => entry.name === "demo");
      assert.ok(record, "disabled marketplace plugin stays listed");
      assert.equal(record?.enabled, false);
      assert.equal(record?.sourceKind, "marketplace");

      // Re-enabling restores the enabled state in the registry and the list.
      await service.setEnabled({ name: "demo", enabled: true });
      const reenabled = await service.get();
      assert.equal(reenabled.plugins.find((entry) => entry.name === "demo")?.enabled, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("npm toggle writes omp-plugins.lock.json enabled: false", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-set-npm-"));
    const cwd = join(home, "project");
    const pluginsDir = join(home, ".omp", "plugins");
    const pkgDir = join(pluginsDir, "node_modules", "demo-plugin");
    try {
      await mkdir(pkgDir, { recursive: true });
      await mkdir(join(cwd, ".omp"), { recursive: true });
      await writeFile(
        join(pluginsDir, "package.json"),
        JSON.stringify({
          name: "omp-plugins",
          private: true,
          dependencies: { "demo-plugin": "^1.2.3" },
        }),
        "utf8",
      );
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "demo-plugin", version: "1.2.3", omp: { tools: "dist/tools.ts" } }),
        "utf8",
      );
      await writeFile(
        join(pluginsDir, "omp-plugins.lock.json"),
        JSON.stringify({
          plugins: { "demo-plugin": { version: "1.2.3", enabled: true, enabledFeatures: null } },
          settings: {},
        }),
        "utf8",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      await service.setEnabled({ name: "demo-plugin", enabled: false });

      const lock = JSON.parse(await readFile(join(pluginsDir, "omp-plugins.lock.json"), "utf8")) as {
        plugins: Record<string, { enabled?: boolean }>;
      };
      assert.equal(lock.plugins["demo-plugin"]?.enabled, false);

      const after = await service.get();
      const record = after.plugins.find((entry) => entry.name === "demo-plugin");
      assert.ok(record, "disabled npm plugin stays listed");
      assert.equal(record?.enabled, false);
      assert.equal(record?.srcLabel, "npm");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("project-scoped lock-only toggle also writes plugin-overrides.json disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-set-lockonly-"));
    const cwd = join(home, "project");
    const projectPlugins = join(cwd, ".omp", "plugins");
    const pkgDir = join(projectPlugins, "node_modules", "lock-only");
    try {
      await mkdir(pkgDir, { recursive: true });
      await mkdir(join(cwd, ".omp"), { recursive: true });
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

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      await service.setEnabled({ name: "lock-only", enabled: false });

      const overrides = JSON.parse(await readFile(join(cwd, ".omp", "plugin-overrides.json"), "utf8")) as {
        disabled?: string[];
      };
      assert.deepEqual(overrides.disabled, ["lock-only"]);

      const after = await service.get();
      const record = after.plugins.find((entry) => entry.name === "lock-only");
      assert.ok(record);
      assert.equal(record?.enabled, false);

      // Re-enabling removes the name from the disabled array.
      await service.setEnabled({ name: "lock-only", enabled: true });
      const reenabled = JSON.parse(await readFile(join(cwd, ".omp", "plugin-overrides.json"), "utf8")) as {
        disabled?: string[];
      };
      assert.deepEqual(reenabled.disabled, []);
      assert.equal((await service.get()).plugins.find((entry) => entry.name === "lock-only")?.enabled, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("user and project toggles of the same plugin do not interfere", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-set-dual-"));
    const cwd = join(home, "project");
    const userPlugins = join(home, ".omp", "plugins");
    const projectPlugins = join(cwd, ".omp", "plugins");
    try {
      for (const [pluginsDir, version] of [[userPlugins, "1.0.0"], [projectPlugins, "2.0.0"]] as const) {
        const pkgDir = join(pluginsDir, "node_modules", "dual");
        await mkdir(pkgDir, { recursive: true });
        await writeFile(
          join(pluginsDir, "package.json"),
          JSON.stringify({ name: "omp-plugins", private: true, dependencies: { dual: `^${version}` } }),
          "utf8",
        );
        await writeFile(
          join(pkgDir, "package.json"),
          JSON.stringify({ name: "dual", version, omp: { tools: "dist/tools.ts" } }),
          "utf8",
        );
        await writeFile(
          join(pluginsDir, "omp-plugins.lock.json"),
          JSON.stringify({ plugins: { dual: { version, enabled: true } }, settings: {} }),
          "utf8",
        );
      }

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });

      // User-scope disable: only the user lock changes; no overrides file.
      await service.setEnabled({ name: "dual", enabled: false, scope: "user" });
      const userLock = JSON.parse(await readFile(join(userPlugins, "omp-plugins.lock.json"), "utf8")) as {
        plugins: Record<string, { enabled?: boolean }>;
      };
      const projectLock = JSON.parse(await readFile(join(projectPlugins, "omp-plugins.lock.json"), "utf8")) as {
        plugins: Record<string, { enabled?: boolean }>;
      };
      assert.equal(userLock.plugins.dual?.enabled, false);
      assert.equal(projectLock.plugins.dual?.enabled, true);

      // Without an explicit scope the winning (project) record is targeted.
      await service.setEnabled({ name: "dual", enabled: false });
      const projectLock2 = JSON.parse(await readFile(join(projectPlugins, "omp-plugins.lock.json"), "utf8")) as {
        plugins: Record<string, { enabled?: boolean }>;
      };
      assert.equal(projectLock2.plugins.dual?.enabled, false);
      const overrides = JSON.parse(await readFile(join(cwd, ".omp", "plugin-overrides.json"), "utf8")) as {
        disabled?: string[];
      };
      assert.deepEqual(overrides.disabled, ["dual"]);

      // Re-enabling the user copy must not touch the project copy.
      await service.setEnabled({ name: "dual", enabled: true, scope: "user" });
      const userLock2 = JSON.parse(await readFile(join(userPlugins, "omp-plugins.lock.json"), "utf8")) as {
        plugins: Record<string, { enabled?: boolean }>;
      };
      assert.equal(userLock2.plugins.dual?.enabled, true);
      const projectLock3 = JSON.parse(await readFile(join(projectPlugins, "omp-plugins.lock.json"), "utf8")) as {
        plugins: Record<string, { enabled?: boolean }>;
      };
      assert.equal(projectLock3.plugins.dual?.enabled, false);

      const after = await service.get();
      const visible = after.plugins.filter((entry) => entry.name === "dual");
      assert.equal(visible.length, 1, "project entry shadows the user entry");
      assert.equal(visible[0]?.enabled, false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("deps-only npm plugin gets a lock entry on disable", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-set-deps-"));
    const cwd = join(home, "project");
    const pluginsDir = join(home, ".omp", "plugins");
    const pkgDir = join(pluginsDir, "node_modules", "deps-only");
    try {
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        join(pluginsDir, "package.json"),
        JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "deps-only": "^0.5.0" } }),
        "utf8",
      );
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "deps-only", version: "0.5.0", omp: { tools: "dist/tools.ts" } }),
        "utf8",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      await service.setEnabled({ name: "deps-only", enabled: false });

      const lock = JSON.parse(await readFile(join(pluginsDir, "omp-plugins.lock.json"), "utf8")) as {
        plugins: Record<string, { version?: string; enabled?: boolean }>;
      };
      assert.equal(lock.plugins["deps-only"]?.enabled, false);
      assert.equal(lock.plugins["deps-only"]?.version, "0.5.0");
      assert.equal((await service.get()).plugins.find((entry) => entry.name === "deps-only")?.enabled, false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("unknown plugins and mismatched scopes fail closed", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-set-err-"));
    const cwd = join(home, "project");
    try {
      await mkdir(join(cwd, ".omp"), { recursive: true });
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });

      await assert.rejects(
        async () => service.setEnabled({ name: "ghost", enabled: false }),
        (error: unknown) =>
          (error as { code?: string }).code === "INVALID_ARGUMENT" &&
          (error as { message?: string }).message?.includes("ghost"),
      );
      await assert.rejects(
        async () => service.setEnabled({ name: "ghost", enabled: false, scope: "project" }),
        (error: unknown) => (error as { code?: string }).code === "INVALID_ARGUMENT",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("skills.setEnabled (whole-skill toggle)", () => {
  async function writeSkill(dir: string, name: string, body: string): Promise<string> {
    const skillDir = join(dir, name);
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, body, "utf8");
    return skillPath;
  }

  test("toggle writes SKILL.md frontmatter enabled and skills.get reflects it", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-skill-set-"));
    const cwd = join(home, "project");
    try {
      await writeSkill(
        join(cwd, ".omp", "skills"),
        "upstream",
        "---\nname: upstream\ndescription: sync flow\n---\nbody\n",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      const before = await service.get();
      assert.equal(before.skills.find((skill) => skill.name === "upstream")?.enabled, true);

      const result = await service.setSkillEnabled({ name: "upstream", enabled: false });
      assert.equal(result.applied, true);
      assert.equal(result.runtimeEffect, "new-session");

      const content = await readFile(join(cwd, ".omp", "skills", "upstream", "SKILL.md"), "utf8");
      assert.match(content, /^enabled: false$/m);

      const after = await service.get();
      const record = after.skills.find((skill) => skill.name === "upstream");
      assert.ok(record, "disabled skill stays listed");
      assert.equal(record?.enabled, false);
      assert.equal(record?.desc, "sync flow");

      // Re-enabling overwrites the line and the list reflects it.
      await service.setSkillEnabled({ name: "upstream", enabled: true });
      const reenabled = await readFile(join(cwd, ".omp", "skills", "upstream", "SKILL.md"), "utf8");
      assert.match(reenabled, /^enabled: true$/m);
      assert.equal((await service.get()).skills.find((skill) => skill.name === "upstream")?.enabled, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("existing enabled: false frontmatter is replaced, other keys preserved", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-skill-repl-"));
    const cwd = join(home, "project");
    try {
      await writeSkill(
        join(cwd, ".omp", "skills"),
        "off",
        "---\nname: off\ndescription: disabled skill\nhide: true\nenabled: false\n---\nbody\n",
      );

      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      assert.equal((await service.get()).skills.find((skill) => skill.name === "off")?.enabled, false);

      await service.setSkillEnabled({ name: "off", enabled: true });
      const content = await readFile(join(cwd, ".omp", "skills", "off", "SKILL.md"), "utf8");
      assert.match(content, /^enabled: true$/m);
      assert.match(content, /^hide: true$/m, "unrelated frontmatter keys must be preserved");
      assert.equal((await service.get()).skills.find((skill) => skill.name === "off")?.enabled, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("explicit scope only targets that scope's visible record", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-skill-scope-"));
    const cwd = join(home, "project");
    try {
      // A user-scope skill with no project shadow: explicit scope works.
      await writeSkill(
        join(home, ".omp", "agent", "skills"),
        "global-only",
        "---\nname: global-only\ndescription: user copy\n---\n",
      );
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      await service.setSkillEnabled({ name: "global-only", enabled: false, scope: "user" });
      const userContent = await readFile(join(home, ".omp", "agent", "skills", "global-only", "SKILL.md"), "utf8");
      assert.match(userContent, /^enabled: false$/m);
      assert.equal((await service.get()).skills.find((skill) => skill.name === "global-only")?.enabled, false);
      await assert.rejects(
        async () => service.setSkillEnabled({ name: "global-only", enabled: true, scope: "project" }),
        (error: unknown) => (error as { code?: string }).code === "INVALID_ARGUMENT",
      );

      // Same name in user and project: the project winner is targeted by
      // default; the shadowed user record is not reachable by scope.
      await writeSkill(
        join(cwd, ".omp", "skills"),
        "shared",
        "---\nname: shared\ndescription: project copy\n---\n",
      );
      await writeSkill(
        join(home, ".omp", "agent", "skills"),
        "shared",
        "---\nname: shared\ndescription: user copy\n---\n",
      );
      await assert.rejects(
        async () => service.setSkillEnabled({ name: "shared", enabled: false, scope: "user" }),
        (error: unknown) => (error as { code?: string }).code === "INVALID_ARGUMENT",
      );
      await service.setSkillEnabled({ name: "shared", enabled: false });
      const projectContent = await readFile(join(cwd, ".omp", "skills", "shared", "SKILL.md"), "utf8");
      assert.match(projectContent, /^enabled: false$/m);
      const userContent2 = await readFile(join(home, ".omp", "agent", "skills", "shared", "SKILL.md"), "utf8");
      assert.doesNotMatch(userContent2, /^enabled:/m, "user copy must stay untouched");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("builtin and unknown skills fail closed", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-skill-err-"));
    const cwd = join(home, "project");
    try {
      await writeSkill(
        join(home, ".omp", "agent", "managed-skills"),
        "oss-audit",
        "---\nname: oss-audit\ndescription: audit\n---\n",
      );
      const service = createOmpExtensibilityService({ home, cwd, now: () => NOW });
      assert.equal((await service.get()).skills.find((skill) => skill.name === "oss-audit")?.scope, "builtin");

      await assert.rejects(
        async () => service.setSkillEnabled({ name: "oss-audit", enabled: false }),
        (error: unknown) =>
          (error as { code?: string }).code === "INVALID_ARGUMENT" &&
          (error as { message?: string }).message?.includes("内置"),
      );
      await assert.rejects(
        async () => service.setSkillEnabled({ name: "ghost", enabled: false }),
        (error: unknown) =>
          (error as { code?: string }).code === "INVALID_ARGUMENT" &&
          (error as { message?: string }).message?.includes("ghost"),
      );
      await assert.rejects(
        async () => service.setSkillEnabled({ name: "oss-audit", enabled: false, scope: "project" }),
        (error: unknown) => (error as { code?: string }).code === "INVALID_ARGUMENT",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
