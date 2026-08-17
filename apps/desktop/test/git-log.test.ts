import assert from "node:assert/strict";
import test from "node:test";

import { classifyLogRelation, parseLogDecorations, parseLogRecords, parseNameStatus } from "../src/git-log.js";

test("parseLogDecorations maps HEAD, local, remote and tag pills", () => {
  const refs = parseLogDecorations("HEAD -> main, origin/main, tag: v1.0");
  assert.deepEqual(refs, [
    { name: "HEAD", kind: "head", current: true },
    { name: "main", kind: "local", current: true },
    { name: "origin/main", kind: "remote", current: false },
    { name: "v1.0", kind: "tag", current: false },
  ]);
});

test("parseLogRecords splits NUL fields and classifies outgoing commits", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const parent = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const stdout = `${head}\0${parent}\0HEAD -> main\0merge feature\0Ada\0${"2026-08-17T00:00:00+08:00"}\u001e${parent}\0\0origin/main\0initial\0Ada\0${"2026-08-16T00:00:00+08:00"}\u001e`;
  const commits = parseLogRecords(stdout, { headOid: head, outgoing: new Set([head]), incoming: new Set() });
  assert.equal(commits.length, 2);
  assert.equal(commits[0]?.relation, "head");
  assert.equal(commits[0]?.parents[0], parent);
  assert.equal(commits[0]?.refs.some((ref) => ref.kind === "local" && ref.current), true);
  assert.equal(commits[1]?.relation, "common");
  assert.equal(commits[1]?.refs[0]?.kind, "remote");
});

test("parseNameStatus keeps rename original paths", () => {
  const files = parseNameStatus("M\tsrc/a.ts\nR100\told.ts\tnew.ts\nA\tdocs/note.md\n");
  assert.deepEqual(files, [
    { path: "src/a.ts", status: "modified" },
    { path: "new.ts", status: "renamed", originalPath: "old.ts" },
    { path: "docs/note.md", status: "added" },
  ]);
});

test("classifyLogRelation prefers HEAD over outgoing", () => {
  const oid = "cccccccccccccccccccccccccccccccccccccccc";
  assert.equal(classifyLogRelation(oid, oid, new Set([oid]), new Set()), "head");
  assert.equal(classifyLogRelation(oid, "other", new Set([oid]), new Set()), "outgoing");
  assert.equal(classifyLogRelation(oid, "other", new Set(), new Set([oid])), "incoming");
});
