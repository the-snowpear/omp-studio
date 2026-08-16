/**
 * Host file log: redacted one-line records under a caller-supplied directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHostFileLog, formatHostLogLine } from "../src/host-log.js";

test("formatHostLogLine redacts paths, tokens, PIDs and strips ANSI", () => {
  const now = new Date("2026-08-15T09:01:00.000Z");
  const line = formatHostLogLine(
    now,
    "error",
    "runtime.stderr",
    "Error: Session not found\npipe \\\\.\\pipe\\omp-studio-bridge-aaaa token sk-abcdefghijklmnopqrstuvwxyz012345 pid 12345 \x1B[31mred\x1B[0m C:\\Users\\ckpa\\AppData\\Roaming\\omp-studio",
  );
  assert.equal(line.startsWith("2026-08-15T09:01:00.000Z error runtime.stderr "), true);
  assert.equal(line.includes("Session not found"), true);
  assert.equal(line.includes("[redacted]"), true);
  assert.equal(line.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.equal(line.includes("12345"), false);
  assert.equal(line.includes("C:\\Users"), false);
  assert.equal(line.includes("\\\\.\\pipe"), false);
  assert.equal(line.includes("\x1B"), false);
  assert.equal(line.slice(0, -1).includes("\n"), false);
});

test("createHostFileLog appends a dated file without throwing on later writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-host-log-"));
  try {
    const log = createHostFileLog({
      directory,
      now: () => new Date("2026-08-15T09:02:00.000Z"),
    });
    log.write("info", "runtime.launch.begin", "generation=1 resume=no");
    const path = join(directory, "host-2026-08-15.log");
    const started = Date.now();
    let text = "";
    while (Date.now() - started < 2_000) {
      try {
        text = await readFile(path, "utf8");
        if (text.length > 0) break;
      } catch {
        // append is async; the file appears after mkdir.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(text, "2026-08-15T09:02:00.000Z info runtime.launch.begin generation=1 resume=no\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
