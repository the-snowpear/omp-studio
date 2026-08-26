import { describe, expect, it } from "vitest";
import type { OperatorCommandManifest, OperatorCommandManifestEntry } from "@omp-studio/studio-protocol";
import {
  composerSlashExecute,
  mergeSlashCatalogWithManifest,
  planComposerSend,
  resolveSlashExecute,
  visibleSlashCatalog,
} from "./commands";
import { snapshotFromText } from "./serialize";

function entry(overrides: Partial<OperatorCommandManifestEntry> = {}): OperatorCommandManifestEntry {
  return {
    id: "builtin.test",
    name: "test",
    aliases: [],
    description: "test command",
    source: "builtin",
    implementation: "shared-service",
    interactionKinds: [],
    presentation: "native",
    availability: "available",
    risk: "normal",
    effect: "read",
    contractTestId: "test.contract",
    ...overrides,
  };
}

function manifest(commands: OperatorCommandManifestEntry[]): OperatorCommandManifest {
  return {
    generatedAt: "2026-08-23T00:00:00.000Z",
    upstreamCommit: "test",
    hash: "test",
    commands,
    unclassifiedBuiltins: [],
  };
}

describe("mergeSlashCatalogWithManifest", () => {
  it("uses the static catalog only when the manifest is unavailable", () => {
    const fallback = mergeSlashCatalogWithManifest();
    expect(fallback.some((command) => command.name === "compact")).toBe(true);
    expect(fallback.length).toBe(visibleSlashCatalog().length);

    const runtime = mergeSlashCatalogWithManifest(manifest([entry({ id: "skill.only", name: "only", source: "skill" })]));
    expect(runtime.map((command) => command.name)).toEqual(["only"]);
    expect(runtime.some((command) => command.name === "compact")).toBe(false);
  });

  it("projects dynamic skill, extension, template, and file commands to operator.invoke", () => {
    const commands = mergeSlashCatalogWithManifest(manifest([
      entry({ id: "skill.audit", name: "audit", source: "skill" }),
      entry({ id: "extension.review", name: "review", source: "extension", argumentSchema: { type: "string" } }),
      entry({ id: "prompt-template.release", name: "release", source: "prompt-template" }),
      entry({ id: "file-command.deploy", name: "deploy", source: "file-command" }),
    ]));

    expect(commands.map((command) => command.name)).toEqual(["audit", "review", "release", "deploy"]);
    expect(commands.map((command) => command.source)).toEqual(["skill", "extension", "prompt-template", "file-command"]);
    expect(resolveSlashExecute(commands[0]!, "--strict")).toEqual({
      kind: "invoke",
      commandId: "skill.audit",
      arguments: "--strict",
    });
    expect(resolveSlashExecute(commands[1]!, "--owner luna")).toEqual({
      kind: "invoke",
      commandId: "extension.review",
      arguments: "--owner luna",
    });
    expect(resolveSlashExecute(commands[3]!, "--dry-run")).toEqual({
      kind: "invoke",
      commandId: "file-command.deploy",
      arguments: "--dry-run",
    });
  });

  it("keeps matching native/typed metadata while Runtime controls membership and status", () => {
    const commands = mergeSlashCatalogWithManifest(manifest([
      entry({ id: "builtin.model", name: "model", description: "Runtime model", source: "builtin" }),
      entry({ id: "runtime.pause", name: "pause", description: "Runtime pause", source: "builtin" }),
      entry({ id: "builtin.missing", name: "missing", availability: "blocked" }),
    ]));

    expect(commands[0]).toMatchObject({ name: "model", description: "Runtime model", select: "native-ui", ui: "model-picker", invokeId: "builtin.model" });
    expect(commands[1]).toMatchObject({ name: "pause", select: "run-now", typed: { name: "runtime.pause" }, invokeId: "runtime.pause" });
    expect(commands[2]).toMatchObject({ name: "missing", availability: "disabled", disabledReason: "Runtime 已阻止此指令" });
  });

  it("does not let dynamic names shadow builtin native or typed mappings", () => {
    const commands = mergeSlashCatalogWithManifest(manifest([
      entry({ id: "skill.model", name: "model", source: "skill" }),
      entry({ id: "extension.plan", name: "plan", source: "extension" }),
    ]));

    expect(commands[0]).toMatchObject({ name: "model", select: "run-now", invokeId: "skill.model" });
    expect(commands[1]).toMatchObject({ name: "plan", select: "run-now", invokeId: "extension.plan" });
    expect(resolveSlashExecute(commands[0]!, "")).toEqual({ kind: "invoke", commandId: "skill.model", arguments: "" });
    expect(resolveSlashExecute(commands[1]!, "")).toEqual({ kind: "invoke", commandId: "extension.plan", arguments: "" });
  });

  it("fails closed for terminal-only commands without a local mapping", () => {
    const [terminal] = mergeSlashCatalogWithManifest(manifest([
      entry({ id: "builtin.shell", name: "shell", presentation: "terminal" }),
    ]));
    expect(terminal).toMatchObject({ availability: "disabled" });
    expect(resolveSlashExecute(terminal!, "")).toEqual({ kind: "none" });
  });

  it("keeps a chip mapping executable instead of turning it into a no-op", () => {
    const [fast] = mergeSlashCatalogWithManifest(manifest([
      entry({ id: "builtin.fast", name: "fast", source: "builtin" }),
    ]));
    expect(fast).toMatchObject({ select: "chip", typed: { name: "session.fast.set" } });
    expect(resolveSlashExecute(fast!, "")).toEqual({ kind: "typed", name: "session.fast.set", input: { enabled: true } });
  });

  it("uses the explicit catalog through planning and slash readiness", () => {
    const runtime = mergeSlashCatalogWithManifest(manifest([
      entry({ id: "skill.dynamic", name: "dynamic", source: "skill" }),
    ]));
    const dynamic = snapshotFromText("/dynamic");
    expect(planComposerSend(dynamic, runtime)).toMatchObject({ kind: "execute", command: { invokeId: "skill.dynamic" }, args: "" });
    expect(composerSlashExecute(dynamic, runtime)).toMatchObject({ kind: "execute", command: { invokeId: "skill.dynamic" } });

    const removedBuiltin = snapshotFromText("/compact");
    expect(planComposerSend(removedBuiltin, runtime).kind).toBe("prompt");
    expect(composerSlashExecute(removedBuiltin, runtime)).toBeUndefined();

    const previewCatalog = mergeSlashCatalogWithManifest();
    expect(composerSlashExecute(removedBuiltin, previewCatalog)?.command.name).toBe("compact");
  });
});
