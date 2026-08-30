import { afterEach, describe, expect, it } from "vitest";

import {
  __resetExpandMemoryForTests,
  readExplorerExpansion,
  readExpandedProjects,
  writeExplorerExpansion,
  writeExpandedProjects,
} from "./expandMemory";

afterEach(() => {
  __resetExpandMemoryForTests();
});

describe("readExpandedProjects", () => {
  it("reports no memory before anything was written", () => {
    expect(readExpandedProjects()).toEqual({ restored: false });
  });

  it("round-trips expanded project ids", () => {
    writeExpandedProjects(new Set(["ws-a", "ws-b"]));
    const memory = readExpandedProjects();
    expect(memory.restored).toBe(true);
    if (memory.restored) {
      expect([...memory.ids].sort()).toEqual(["ws-a", "ws-b"]);
    }
  });

  it("treats an empty written set as valid memory (all collapsed)", () => {
    writeExpandedProjects(new Set());
    expect(readExpandedProjects()).toEqual({ restored: true, ids: new Set() });
  });

  it("falls back to no memory on corrupt payloads", () => {
    localStorage.setItem("omp.sidebar.expandedProjects", "{not json");
    expect(readExpandedProjects()).toEqual({ restored: false });
    localStorage.setItem("omp.sidebar.expandedProjects", JSON.stringify({ expandedProjects: [42, "ok"] }));
    expect(readExpandedProjects()).toEqual({ restored: false });
  });
});

describe("readExplorerExpansion / writeExplorerExpansion", () => {
  it("round-trips paths per workspace without cross-talk", () => {
    writeExplorerExpansion("ws-a", new Set(["src", "src/app"]));
    writeExplorerExpansion("ws-b", new Set(["docs"]));
    expect(readExplorerExpansion("ws-a")).toEqual(new Set(["src", "src/app"]));
    expect(readExplorerExpansion("ws-b")).toEqual(new Set(["docs"]));
    expect(readExplorerExpansion("ws-c")).toEqual(new Set());
  });

  it("deletes the workspace entry when the expansion becomes empty", () => {
    writeExplorerExpansion("ws-a", new Set(["src"]));
    writeExplorerExpansion("ws-a", new Set());
    expect(readExplorerExpansion("ws-a")).toEqual(new Set());
  });

  it("ignores corrupt stored payloads", () => {
    localStorage.setItem("omp.sidebar.explorerExpansion", "{not json");
    expect(readExplorerExpansion("ws-a")).toEqual(new Set());
    localStorage.setItem("omp.sidebar.explorerExpansion", JSON.stringify({ "ws-a": "not-an-array" }));
    expect(readExplorerExpansion("ws-a")).toEqual(new Set());
  });
});
