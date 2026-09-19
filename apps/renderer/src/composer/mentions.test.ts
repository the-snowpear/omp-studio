import { describe, expect, it, vi } from "vitest";

import type { StudioClient } from "@omp-studio/client-contract";

import {
  createWorkspaceFileIndex,
  filterMentions,
  loadMentions,
  previewMentions,
  type WorkspaceEntry,
} from "./mentions";

describe("filterMentions", () => {
  it("matches label, name and detail", () => {
    const items = [
      { kind: "skill" as const, id: "a", label: "commit-msg", name: "commit-msg", detail: "Conventional Commits" },
      { kind: "skill" as const, id: "b", label: "oss-audit", name: "oss-audit", detail: "license check" },
    ];
    expect(filterMentions(items, "commit").map((item) => item.name)).toEqual(["commit-msg"]);
    expect(filterMentions(items, "license").map((item) => item.name)).toEqual(["oss-audit"]);
  });
});

describe("previewMentions", () => {
  it("does not treat / as a skill mention; @ lists agents plus workspace paths", () => {
    expect(previewMentions("/", "commit")).toEqual([]);
    expect(previewMentions("@", "review").some((item) => item.name === "code-reviewer")).toBe(true);
    const kinds = new Set(previewMentions("@", "").map((item) => item.kind));
    expect(kinds.has("agent")).toBe(true);
    expect(kinds.has("file")).toBe(true);
    expect(kinds.has("dir")).toBe(true);
    expect(kinds.has("skill")).toBe(false);
  });

  it("includes matching skills only after the user types a query", () => {
    expect(previewMentions("@", "commit").some((item) => item.name === "commit-msg")).toBe(true);
  });
});

const TREE: Record<string, WorkspaceEntry[]> = {
  "": [
    { type: "dir", name: "apps", path: "apps" },
    { type: "dir", name: "node_modules", path: "node_modules" },
    { type: "file", name: "package.json", path: "package.json" },
  ],
  apps: [{ type: "dir", name: "renderer", path: "apps/renderer" }],
  "apps/renderer": [
    { type: "file", name: "App.tsx", path: "apps/renderer/App.tsx" },
    { type: "file", name: "appendix.md", path: "apps/renderer/appendix.md" },
  ],
  node_modules: [{ type: "file", name: "index.js", path: "node_modules/index.js" }],
};

function lister() {
  return vi.fn(async (path?: string) => TREE[path ?? ""] ?? []);
}

describe("createWorkspaceFileIndex", () => {
  it("finds nested files and folders, ranking basename prefixes first", async () => {
    const index = createWorkspaceFileIndex(lister());

    const hits = await index.search("app");

    expect(hits.map((item) => item.path)).toEqual([
      "apps",
      "apps/renderer/App.tsx",
      "apps/renderer/appendix.md",
      // Basename misses, matched only through the parent path, so it sorts last.
      "apps/renderer",
    ]);
    expect(hits[0]?.kind).toBe("dir");
    expect(hits[1]?.kind).toBe("file");
  });

  it("keeps generated directories and their contents out of the index", async () => {
    const index = createWorkspaceFileIndex(lister());

    expect(await index.search("index.js")).toEqual([]);
    expect(await index.search("node_modules")).toEqual([]);
  });

  it("carries the parent path as detail so truncated capsules stay identifiable", async () => {
    const index = createWorkspaceFileIndex(lister());

    const [hit] = await index.search("App.tsx");

    expect(hit?.label).toBe("App.tsx");
    expect(hit?.detail).toBe("apps/renderer/App.tsx");
  });

  it("lists a directory directly when the query holds a path", async () => {
    const list = lister();
    const index = createWorkspaceFileIndex(list);

    const hits = await index.search("apps/renderer/appe");

    expect(hits.map((item) => item.path)).toEqual(["apps/renderer/appendix.md"]);
    expect(list).toHaveBeenCalledWith("apps/renderer");
  });

  it("reuses one walk across keystrokes", async () => {
    const list = lister();
    const index = createWorkspaceFileIndex(list);

    await index.search("a");
    await index.search("ap");
    await index.search("app");

    const roots = list.mock.calls.filter(([path]) => path === undefined);
    expect(roots).toHaveLength(1);
  });
});

function fakeModelMentionClient(
  available: Array<{ selector: string; name: string }> | Error,
): { client: StudioClient; calls: () => number } {
  const commands: Record<string, unknown> = {};
  let calls = 0;
  const client = {
    async command(commandName: string, _input: unknown) {
      calls += 1;
      if (available instanceof Error) throw available;
      const requestId = `req-${calls}`;
      commands[requestId] = {
        requestId,
        commandName,
        status: "completed",
        observedAt: "2026-09-19T00:00:00.000Z",
        result: { snapshot: {}, result: { available } },
      };
      return { requestId };
    },
    getState: () => ({ commands }),
    subscribe() {
      return () => {};
    },
    async query() {
      throw new Error("unused");
    },
    async bootstrap() {
      throw new Error("unused");
    },
    async close() {
      throw new Error("unused");
    },
  };
  return { client: client as unknown as StudioClient, calls: () => calls };
}

describe("loadMentions model triggers", () => {
  const available = [
    { selector: "openai/gpt-5", name: "GPT-5" },
    { selector: "anthropic/claude-opus", name: "Claude Opus" },
  ];

  it("fetches ^ candidates once per client and filters locally per keystroke", async () => {
    const { client, calls } = fakeModelMentionClient(available);

    const all = await loadMentions(client, "^", "");
    const narrowed = await loadMentions(client, "^", "claude");

    expect(calls()).toBe(1);
    expect(all.map((item) => item.name)).toEqual(["openai/gpt-5", "anthropic/claude-opus"]);
    expect(all[0]?.label).toBe("GPT-5");
    expect(narrowed.map((item) => item.name)).toEqual(["anthropic/claude-opus"]);
    expect(narrowed[0]?.kind).toBe("model");
  });

  it("caches a failing ^ fetch briefly instead of firing one command per keystroke", async () => {
    const { client, calls } = fakeModelMentionClient(new Error("unknown operation"));

    await expect(loadMentions(client, "^", "g")).rejects.toThrow("unknown operation");
    await expect(loadMentions(client, "^", "gp")).rejects.toThrow("unknown operation");

    expect(calls()).toBe(1);
  });
});
