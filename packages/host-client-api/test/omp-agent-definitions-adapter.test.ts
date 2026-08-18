import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createOmpAgentDefinitionsService } from "../src/omp-agent-definitions-adapter.js";

const NOW = "2026-08-14T08:00:00.000Z";

async function writeAgent(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}

describe("createOmpAgentDefinitionsService", () => {
  test("lists bundled agents when the home tree is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-empty-"));
    try {
      const service = createOmpAgentDefinitionsService({ home, now: () => NOW });
      const result = await service.get();
      assert.equal(result.unavailableReason, undefined);
      assert.equal(result.projectScopeAvailable, false);
      assert.ok(result.agents.length >= 7);
      assert.ok(result.agents.every((agent) => agent.source === "bundled"));
      const scout = result.agents.find((agent) => agent.name === "scout");
      assert.equal(scout?.sourceLabel, "内置");
      assert.equal(scout?.editable, false);
      assert.equal(scout?.canFork, true);
      assert.equal(scout?.promptPacked, true);
      assert.equal(scout?.systemPrompt, "");
      assert.ok(scout?.tools?.includes("read"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("project agents shadow user agents which shadow bundled", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-shadow-"));
    const cwd = join(home, "project");
    try {
      await writeAgent(
        join(cwd, ".omp", "agents"),
        "scout",
        "---\nname: scout\ndescription: project scout\n---\nProject body.\n",
      );
      await writeAgent(
        join(home, ".omp", "agent", "agents"),
        "scout",
        "---\nname: scout\ndescription: user scout\n---\nUser body.\n",
      );
      await writeAgent(
        join(home, ".omp", "agent", "agents"),
        "custom",
        "---\nname: custom\ndescription: Use this agent when doing custom work\ntools: read, grep\nmodel: \"@smol\"\nthinking-level: low\n---\nDo the custom thing.\n",
      );
      const service = createOmpAgentDefinitionsService({ home, cwd, now: () => NOW });
      const result = await service.get();
      const scout = result.agents.find((agent) => agent.name === "scout");
      assert.equal(scout?.source, "project");
      assert.equal(scout?.description, "project scout");
      assert.equal(scout?.systemPrompt, "Project body.");
      assert.equal(scout?.editable, true);
      assert.ok(result.warnings.some((item) => item.includes("scout")));
      const custom = result.agents.find((agent) => agent.name === "custom");
      assert.equal(custom?.source, "user");
      assert.deepEqual(custom?.tools, ["read", "grep", "yield"]);
      assert.deepEqual(custom?.model, ["@smol"]);
      assert.equal(custom?.thinkingLevel, "low");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("upsert writes a markdown definition and get reflects it", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-upsert-"));
    try {
      const service = createOmpAgentDefinitionsService({ home, now: () => NOW });
      const write = await service.upsert({
        name: "notes",
        description: "Use this agent when taking notes",
        systemPrompt: "Capture concise notes.",
        scope: "user",
        tools: ["read", "grep"],
        model: ["@smol"],
        thinkingLevel: "low",
        blocking: true,
      });
      assert.equal(write.applied, true);
      const text = await readFile(join(home, ".omp", "agent", "agents", "notes.md"), "utf8");
      assert.match(text, /^---\n/);
      assert.match(text, /name: notes/);
      assert.match(text, /thinking-level: low/);
      assert.match(text, /Capture concise notes/);
      const result = await service.get();
      const notes = result.agents.find((agent) => agent.name === "notes");
      assert.equal(notes?.source, "user");
      assert.equal(notes?.blocking, true);
      assert.ok(notes?.tools?.includes("yield"));
      await service.upsert({
        name: "notes",
        description: "Use this agent when taking notes",
        systemPrompt: "Capture concise notes.",
        scope: "user",
        prewalk: false,
      });
      const withPrewalk = await readFile(join(home, ".omp", "agent", "agents", "notes.md"), "utf8");
      assert.match(withPrewalk, /prewalk: false/);
      const after = await service.get();
      assert.equal(after.agents.find((agent) => agent.name === "notes")?.prewalk, false);
      await service.upsert({
        name: "notes",
        description: "Use this agent when taking notes",
        systemPrompt: "Capture concise notes.",
        scope: "user",
        advisor: true,
      });
      const withAdvisor = await readFile(join(home, ".omp", "agent", "agents", "notes.md"), "utf8");
      assert.match(withAdvisor, /advisor: true/);
      const afterAdvisor = await service.get();
      assert.equal(afterAdvisor.agents.find((agent) => agent.name === "notes")?.advisor, true);
      await service.upsert({
        name: "notes",
        description: "Use this agent when taking notes",
        systemPrompt: "Capture concise notes.",
        scope: "user",
        spawns: [],
      });
      const none = await service.get();
      assert.deepEqual(none.agents.find((agent) => agent.name === "notes")?.spawns, []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("delete removes a user file so the bundled agent returns", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-delete-"));
    try {
      await writeAgent(
        join(home, ".omp", "agent", "agents"),
        "scout",
        "---\nname: scout\ndescription: custom scout\n---\nCustom.\n",
      );
      const service = createOmpAgentDefinitionsService({ home, now: () => NOW });
      const before = await service.get();
      assert.equal(before.agents.find((agent) => agent.name === "scout")?.source, "user");
      await service.delete({ name: "scout", scope: "user" });
      const after = await service.get();
      assert.equal(after.agents.find((agent) => agent.name === "scout")?.source, "bundled");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("configure writes task overlays in config.yml", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-cfg-"));
    try {
      const service = createOmpAgentDefinitionsService({ home, now: () => NOW });
      await service.configure({ name: "scout", disabled: true, overrideModel: "@smol", prewalkOverride: "off", advisorOverride: "on" });
      const text = await readFile(join(home, ".omp", "agent", "config.yml"), "utf8");
      assert.match(text, /disabledAgents:/);
      assert.match(text, /scout/);
      assert.match(text, /agentModelOverrides:/);
      assert.match(text, /agentPrewalk:/);
      assert.match(text, /agentAdvisor:/);
      const result = await service.get();
      const scout = result.agents.find((agent) => agent.name === "scout");
      assert.equal(scout?.disabled, true);
      assert.equal(scout?.overrideModel, "@smol");
      assert.equal(scout?.prewalkOverride, "off");
      assert.equal(scout?.advisorOverride, "on");
      await service.configure({ name: "scout", disabled: false, overrideModel: null, prewalkOverride: null, advisorOverride: null });
      const cleared = await service.get();
      const after = cleared.agents.find((agent) => agent.name === "scout");
      assert.equal(after?.disabled, false);
      assert.equal(after?.overrideModel, undefined);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("numeric YAML name and description still parse", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-numeric-"));
    try {
      await writeAgent(
        join(home, ".omp", "agent", "agents"),
        "111",
        "---\nname: 111\ndescription: 222\nthinking-level: \"off\"\n---\n\n",
      );
      const service = createOmpAgentDefinitionsService({ home, now: () => NOW });
      const result = await service.get();
      const agent = result.agents.find((item) => item.name === "111");
      assert.equal(agent?.description, "222");
      assert.equal(agent?.source, "user");
      assert.equal(result.warnings.some((item) => item.includes("111.md")), false);
      const write = await service.upsert({
        name: "111",
        description: "222",
        systemPrompt: "Keep going.",
        scope: "user",
        thinkingLevel: "off",
      });
      assert.equal(write.applied, true);
      const text = await readFile(join(home, ".omp", "agent", "agents", "111.md"), "utf8");
      assert.match(text, /name: "111"/);
      assert.match(text, /description: "222"/);
      await service.configure({ name: "111", disabled: false });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("files missing name or description become warnings", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-warn-"));
    try {
      await writeAgent(join(home, ".omp", "agent", "agents"), "broken", "---\nname: broken\n---\nNo description.\n");
      const service = createOmpAgentDefinitionsService({ home, now: () => NOW });
      const result = await service.get();
      assert.equal(result.agents.some((agent) => agent.name === "broken"), false);
      assert.ok(result.warnings.length > 0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("project upsert fails closed without a workspace cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-agents-nocwd-"));
    try {
      const service = createOmpAgentDefinitionsService({ home, now: () => NOW });
      await assert.rejects(
        async () =>
          service.upsert({
            name: "local",
            description: "Use this agent when working locally",
            systemPrompt: "Stay in the repo.",
            scope: "project",
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "UNAVAILABLE");
          return true;
        },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
