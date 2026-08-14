import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toYamlProvider, upsertYamlRecordEntry, upsertYamlStringList } from "../src/omp-models-adapter.js";

describe("upsertYamlRecordEntry", () => {
  test("updates an existing entry in block form", () => {
    const source = "modelRoles:\n  default: a/b\n  smol: c/d\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "x/y");
    assert.equal(out, "modelRoles:\n  default: x/y\n  smol: c/d\n");
  });

  test("inserts a missing entry in block form without rewriting siblings", () => {
    const source = "modelRoles:\n  default: a/b\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "smol", "c/d");
    assert.equal(out, "modelRoles:\n  default: a/b\n  smol: c/d\n");
  });

  test("updates an existing entry in inline map form", () => {
    const source = "modelRoles: { default: a/b, smol: c/d }\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "x/y");
    assert.equal(out, "modelRoles: { default: x/y, smol: c/d }\n");
  });

  test("inserts a missing entry in inline map form without duplicating the key", () => {
    const source = "modelRoles: { default: a/b }\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "smol", "c/d");
    assert.equal(out, "modelRoles: { default: a/b, smol: c/d }\n");
  });

  test("quotes an inline value that contains a colon (thinking selector)", () => {
    const source = "modelRoles: { default: a/b }\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "slow", "x/y:high");
    assert.equal(out, 'modelRoles: { default: a/b, slow: "x/y:high" }\n');
  });

  test("appends block form when the record is absent", () => {
    const source = "otherKey: true\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "a/b");
    assert.equal(out, "otherKey: true\nmodelRoles:\n  default: a/b\n");
  });

  test("preserves CRLF line endings", () => {
    const source = "modelRoles:\r\n  default: a/b\r\n";
    const out = upsertYamlRecordEntry(source, "modelRoles", "default", "x/y");
    assert.equal(out, "modelRoles:\r\n  default: x/y\r\n");
  });
});

describe("toYamlProvider auth boundary", () => {
  test("drops a stale command credential when switching command -> api-key with a blank key", () => {
    const previous = { apiKey: "!op read op://dev/openai/api-key", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "api-key" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal("apiKey" in out, false);
  });

  test("drops a stale command credential when switching command -> oauth", () => {
    const previous = { apiKey: "!op read op://dev/openai/api-key", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "oauth" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal("apiKey" in out, false);
    assert.equal(out.auth, "oauth");
  });

  test("keeps the command credential when re-saving command without re-entering it", () => {
    const previous = { apiKey: "!op read op://dev/openai/api-key", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "command" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal(out.apiKey, "!op read op://dev/openai/api-key");
  });

  test("keeps an existing api key when re-saving api-key with a blank key", () => {
    const previous = { apiKey: "sk-123", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "api-key" as const } };
    const out = toYamlProvider(input, previous);
    assert.equal(out.apiKey, "sk-123");
  });

  test("clearSecret removes the stored key", () => {
    const previous = { apiKey: "sk-123", api: "openai-completions" };
    const input = { id: "p", name: "p", api: "openai-completions", auth: { type: "api-key" as const, clearSecret: true } };
    const out = toYamlProvider(input, previous);
    assert.equal("apiKey" in out, false);
  });

  test("serializes advanced fields (headers/disableStrictTools/transport/remoteCompaction)", () => {
    const input = {
      id: "p",
      name: "p",
      api: "openai-completions",
      auth: { type: "api-key" as const, apiKey: "sk-123" },
      headers: { "X-Org-Id": "org-1" },
      disableStrictTools: true,
      transport: "pi-native" as const,
      remoteCompaction: { enabled: true, model: "gpt-5-mini" },
    };
    const out = toYamlProvider(input, undefined);
    assert.deepEqual(out.headers, { "X-Org-Id": "org-1" });
    assert.equal(out.disableStrictTools, true);
    assert.equal(out.transport, "pi-native");
    assert.deepEqual(out.remoteCompaction, { enabled: true, model: "gpt-5-mini" });
  });

  test("clears advanced fields when disabled/emptied", () => {
    const previous = {
      headers: { "X-Org-Id": "org-1" },
      disableStrictTools: true,
      transport: "pi-native",
      remoteCompaction: { enabled: true, model: "gpt-5-mini" },
    };
    const input = {
      id: "p",
      name: "p",
      api: "openai-completions",
      auth: { type: "api-key" as const, apiKey: "sk-123" },
      headers: {},
      disableStrictTools: false,
      transport: null,
      remoteCompaction: null,
    };
    const out = toYamlProvider(input, previous);
    assert.equal("headers" in out, false);
    assert.equal("disableStrictTools" in out, false);
    assert.equal("transport" in out, false);
    assert.equal("remoteCompaction" in out, false);
  });
});

describe("upsertYamlStringList", () => {
  test("replaces an existing block list", () => {
    const source = "cycleOrder:\n  - smol\n  - default\n  - slow\n";
    const out = upsertYamlStringList(source, "cycleOrder", ["default", "slow"]);
    assert.equal(out, "cycleOrder:\n  - default\n  - slow\n");
  });

  test("appends a missing list as block form", () => {
    const source = "modelRoles:\n  default: a/b\n";
    const out = upsertYamlStringList(source, "cycleOrder", ["smol", "slow"]);
    assert.equal(out, "modelRoles:\n  default: a/b\ncycleOrder:\n  - smol\n  - slow\n");
  });

  test("replaces an inline list with block form", () => {
    const source = "cycleOrder: [smol, default]\n";
    const out = upsertYamlStringList(source, "cycleOrder", ["slow"]);
    assert.equal(out, "cycleOrder:\n  - slow\n");
  });
});
