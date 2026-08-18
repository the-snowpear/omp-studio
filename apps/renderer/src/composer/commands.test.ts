import { describe, expect, it } from "vitest";

import { COMMAND_NAMES } from "@omp-studio/transport-desktop";
import type { ThreadId } from "@omp-studio/client-contract";

import {
  BUILTIN_SLASH_CATALOG,
  bindSlashTypedCommand,
  composerSlashExecute,
  filterSlashCommands,
  lookupSlashCommand,
  parseSlashDraft,
  planComposerSend,
  resolveSlashExecute,
  slashNeedsArgs,
  stripLeadingSlashCommand,
  typedSlashSource,
  visibleSlashCatalog,
  type StudioSlashCommand,
} from "./commands";
import { snapshotFromDoc, snapshotFromText } from "./serialize";

describe("parseSlashDraft", () => {
  it("requires a leading slash and splits on space or colon", () => {
    expect(parseSlashDraft("hello")).toBeNull();
    expect(parseSlashDraft("/")).toEqual({ name: "", args: "", text: "/" });
    expect(parseSlashDraft("/model")).toEqual({ name: "model", args: "", text: "/model" });
    expect(parseSlashDraft("/model openai/gpt")).toEqual({ name: "model", args: "openai/gpt", text: "/model openai/gpt" });
    expect(parseSlashDraft("/model:openai/gpt")).toEqual({ name: "model", args: "openai/gpt", text: "/model:openai/gpt" });
  });

  it("only reads the first line so a path later in the draft is not a command token", () => {
    expect(parseSlashDraft("/plan fix auth\nmore")).toEqual({ name: "plan", args: "fix auth", text: "/plan fix auth" });
  });

  it("does not treat a slash after the first character as a command", () => {
    expect(parseSlashDraft("a/model")).toBeNull();
    expect(parseSlashDraft("hello /plan")).toBeNull();
    expect(parseSlashDraft(" /fast")).toBeNull();
  });
});

describe("typedSlashSource", () => {
  it("reads typed text and ignores capsules that serialize with a slash", () => {
    expect(typedSlashSource({ nodes: [] })).toBe("");
    expect(typedSlashSource({ nodes: [{ type: "text", value: "/model" }] })).toBe("/model");
    expect(typedSlashSource({
      nodes: [
        { type: "chip", chip: { id: "s1", kind: "skill", label: "commit-msg", name: "commit-msg" } },
        { type: "text", value: " 写提交信息" },
      ],
    })).toBe("");
    expect(typedSlashSource({
      nodes: [
        { type: "chip", chip: { id: "m1", kind: "mode", label: "fast", name: "fast" } },
        { type: "text", value: "/model" },
      ],
    })).toBe("/model");
  });
});

describe("catalog", () => {
  it("lists builtins without skills and hides process-only commands", () => {
    const names = visibleSlashCatalog().map((item) => item.name);
    expect(names).toContain("model");
    expect(names).toContain("compact");
    expect(names).not.toContain("quit");
    expect(names).not.toContain("live");
    expect(names.every((name) => name !== "skill")).toBe(true);
    expect(BUILTIN_SLASH_CATALOG.some((item) => item.aliases.includes("models"))).toBe(true);
  });

  it("lists the full visible catalog when the query is empty", () => {
    const names = filterSlashCommands("").map((item) => item.name);
    expect(names).toHaveLength(visibleSlashCatalog().length);
    expect(names).toContain("compact");
    expect(names).toContain("memory");
    expect(names.indexOf("fast")).toBeLessThan(names.indexOf("model"));
  });

  it("classifies the 63 available commands into chip, fill-in, open-page, and run-now", () => {
    const available = BUILTIN_SLASH_CATALOG.filter((item) => item.availability === "available");
    const namesOf = (select: StudioSlashCommand["select"]) =>
      available.filter((item) => item.select === select).map((item) => item.name).sort();
    expect(available).toHaveLength(63);
    expect(namesOf("chip")).toEqual(["fast", "goal", "loop", "plan", "prewalk", "vibe"]);
    expect(namesOf("complete-args")).toEqual([
      "add-dir", "advisor", "browser", "btw", "compact", "computer", "force", "memory",
      "move", "omfg", "queue", "remove-dir", "rename", "security", "session", "shake",
      "ssh", "tan", "todo", "vision",
    ]);
    expect(namesOf("native-ui")).toEqual([
      "agents", "branch", "extensions", "help", "hotkeys", "login", "logout", "marketplace",
      "mcp", "model", "new", "plan-review", "plugins", "resume", "settings", "setup", "switch", "tree",
    ]);
    expect(namesOf("run-now")).toEqual([
      "changelog", "clear", "context", "dirs", "drop", "dump", "export", "fork", "fresh",
      "guided-goal", "handoff", "jobs", "pause", "reload-plugins", "retry", "share", "stats",
      "tools", "usage",
    ]);
  });

  it("filters by name, alias and description", () => {
    expect(filterSlashCommands("mod").map((item) => item.name)[0]).toBe("model");
    expect(filterSlashCommands("providers")[0]?.name).toBe("setup");
    expect(filterSlashCommands("压缩").some((item) => item.name === "compact")).toBe(true);
  });
});

describe("resolveSlashExecute", () => {
  it("opens the model picker without args", () => {
    const model = lookupSlashCommand("models");
    expect(model).toBeDefined();
    if (!model) return;
    expect(resolveSlashExecute(model, "")).toEqual({ kind: "native-ui", ui: "model-picker" });
  });

  it("points /branch at the user-message action and keeps /tree on the Changes panel", () => {
    expect(resolveSlashExecute(lookupSlashCommand("branch")!, "")).toEqual({
      kind: "native-ui",
      ui: "user-message-branch",
    });
    expect(resolveSlashExecute(lookupSlashCommand("tree")!, "")).toEqual({
      kind: "native-ui",
      ui: "session-tree",
    });
  });

  it("uses typed session ops for TUI-only builtins", () => {
    expect(resolveSlashExecute(lookupSlashCommand("clear")!, "")).toEqual({
      kind: "typed",
      name: "session.clearContext",
      input: {},
    });
    expect(resolveSlashExecute(lookupSlashCommand("queue")!, "later")).toEqual({
      kind: "typed",
      name: "queue.enqueue",
      input: { text: "later" },
    });
  });

  it("maps btw / tan / omfg onto protocol composite commands", () => {
    expect(resolveSlashExecute(lookupSlashCommand("btw")!, "why this file?")).toEqual({
      kind: "typed",
      name: "btw.ask",
      input: { question: "why this file?" },
    });
    expect(resolveSlashExecute(lookupSlashCommand("tan")!, "review tests")).toEqual({
      kind: "typed",
      name: "tan.start",
      input: { work: "review tests" },
    });
    expect(resolveSlashExecute(lookupSlashCommand("omfg")!, "avoid this")).toEqual({
      kind: "typed",
      name: "omfg.generate",
      input: { complaint: "avoid this" },
    });
  });

  it("keeps every typed slash name inside the desktop command allow-list", () => {
    const typed = BUILTIN_SLASH_CATALOG.flatMap((command) => (command.typed === undefined ? [] : [command.typed.name]));
    expect(typed.length).toBeGreaterThan(0);
    for (const name of typed) {
      expect(COMMAND_NAMES).toContain(name);
    }
  });

  it("binds /drop to Host session.drop with the current threadId", () => {
    const execute = resolveSlashExecute(lookupSlashCommand("drop")!, "");
    expect(execute).toEqual({ kind: "typed", name: "session.drop", input: {} });
    if (execute.kind !== "typed") return;
    expect(bindSlashTypedCommand(execute, {})).toEqual({
      ok: false,
      error: "没有当前会话，无法执行 /drop",
    });
    expect(bindSlashTypedCommand(execute, { threadId: "thread-1" as ThreadId })).toEqual({
      ok: true,
      name: "session.drop",
      input: { threadId: "thread-1" },
    });
  });

  it("invokes compact and rename through the operator manifest ids", () => {
    expect(resolveSlashExecute(lookupSlashCommand("compact")!, "soft auth")).toEqual({
      kind: "invoke",
      commandId: "builtin.compact",
      arguments: "soft auth",
    });
    expect(resolveSlashExecute(lookupSlashCommand("rename")!, "New title")).toEqual({
      kind: "invoke",
      commandId: "builtin.rename",
      arguments: "New title",
    });
  });

  it("keeps argument-taking commands in the composer until they have a value", () => {
    expect(slashNeedsArgs(lookupSlashCommand("rename")!, "")).toBe(true);
    expect(slashNeedsArgs(lookupSlashCommand("rename")!, "Hello")).toBe(false);
    expect(slashNeedsArgs(lookupSlashCommand("compact")!, "")).toBe(true);
  });

  it("turns mode chips into typed session ops", () => {
    expect(resolveSlashExecute(lookupSlashCommand("fast")!, "")).toEqual({
      kind: "typed",
      name: "session.fast.set",
      input: { enabled: true },
    });
    expect(resolveSlashExecute(lookupSlashCommand("fast")!, "off")).toEqual({
      kind: "typed",
      name: "session.fast.set",
      input: { enabled: false },
    });
    expect(resolveSlashExecute(lookupSlashCommand("fast")!, "status")).toEqual({
      kind: "invoke",
      commandId: "builtin.fast",
      arguments: "status",
    });
    expect(resolveSlashExecute(lookupSlashCommand("goal")!, "pause")).toEqual({
      kind: "typed",
      name: "goal.pause",
      input: {},
    });
  });
});

describe("planComposerSend", () => {
  it("applies /fast then prompts the remaining instruction", () => {
    const plan = planComposerSend(snapshotFromText("/fast 帮我加速"));
    expect(plan.kind).toBe("apply-then-prompt");
    if (plan.kind !== "apply-then-prompt") return;
    expect(plan.apply).toEqual([{ command: expect.objectContaining({ name: "fast" }), args: "" }]);
    expect(plan.snapshot.text).toBe("帮我加速");
  });

  it("executes /fast on locally without prompting", () => {
    const plan = planComposerSend(snapshotFromText("/fast on"));
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.command.name).toBe("fast");
    expect(plan.args).toBe("on");
  });

  it("sends /settings with extra text to the model", () => {
    const plan = planComposerSend(snapshotFromText("/settings 帮我改主题"));
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.snapshot.text).toBe("/settings 帮我改主题");
  });

  it("executes /settings with no args", () => {
    const plan = planComposerSend(snapshotFromText("/settings"));
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.command.name).toBe("settings");
  });

  it("executes /compact soft locally", () => {
    const plan = planComposerSend(snapshotFromText("/compact soft auth"));
    expect(plan).toMatchObject({ kind: "execute", args: "soft auth" });
    if (plan.kind !== "execute") return;
    expect(plan.command.name).toBe("compact");
  });

  it("executes /goal pause locally without prompting", () => {
    const plan = planComposerSend(snapshotFromText("/goal pause"));
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.command.name).toBe("goal");
    expect(plan.args).toBe("pause");
  });

  it("sends /fresh with extra text to the model", () => {
    const plan = planComposerSend(snapshotFromText("/fresh 然后继续"));
    expect(plan.kind).toBe("prompt");
    if (plan.kind !== "prompt") return;
    expect(plan.snapshot.text).toBe("/fresh 然后继续");
  });

  it("applies a mode capsule then prompts remaining prose", () => {
    const plan = planComposerSend(snapshotFromDoc({
      nodes: [
        { type: "chip", chip: { id: "m1", kind: "mode", label: "fast", name: "fast" } },
        { type: "text", value: "帮我加速" },
      ],
    }));
    expect(plan.kind).toBe("apply-then-prompt");
    if (plan.kind !== "apply-then-prompt") return;
    expect(plan.apply.map((step) => step.command.name)).toEqual(["fast"]);
    expect(plan.snapshot.text).toBe("帮我加速");
  });

  it("keeps a file capsule once when /fast shares a line with a mention", () => {
    const plan = planComposerSend(snapshotFromDoc({
      nodes: [
        { type: "text", value: "/fast 对照 " },
        { type: "chip", chip: { id: "f1", kind: "file", label: "App.tsx", path: "src/App.tsx" } },
      ],
    }));
    expect(plan.kind).toBe("apply-then-prompt");
    if (plan.kind !== "apply-then-prompt") return;
    expect(plan.snapshot.text).toBe("对照 @src/App.tsx");
    expect(plan.snapshot.text.match(/@src\/App\.tsx/g)).toHaveLength(1);
  });

  it("sends /queue with clipboard images as follow-up so bytes are not dropped", () => {
    const plan = planComposerSend(snapshotFromDoc({
      nodes: [
        { type: "text", value: "/queue 看这张 " },
        {
          type: "chip",
          chip: {
            id: "i1",
            kind: "image",
            label: "图",
            image: { type: "image", mimeType: "image/png", data: "aaa" },
          },
        },
      ],
    }));
    expect(plan.kind).toBe("follow-up");
    if (plan.kind !== "follow-up") return;
    expect(plan.snapshot.text).toContain("看这张");
    expect(plan.snapshot.text.startsWith("/queue")).toBe(false);
    expect(plan.snapshot.images).toEqual([{ type: "image", mimeType: "image/png", data: "aaa" }]);
  });

  it("treats /btw as a slash execute so preview and streaming can still run it", () => {
    expect(composerSlashExecute(snapshotFromText("/btw why this file?"))).toEqual({
      kind: "execute",
      command: expect.objectContaining({ name: "btw" }),
      args: "why this file?",
    });
    expect(composerSlashExecute(snapshotFromText("普通消息"))).toBeUndefined();
  });

  it("strips only the slash token from the first text node", () => {
    const next = stripLeadingSlashCommand(
      snapshotFromText("/queue later please"),
      "queue",
    );
    expect(next.text).toBe("later please");
  });
});
