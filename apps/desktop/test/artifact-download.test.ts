import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  assertFreeSpace,
  createProgressThrottle,
  downloadOne,
} from "../src/artifact-download.js";

function makeReadableStream(chunks: Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("artifact-download: progress throttle", () => {
  test("throttle limits emission frequency and flushes pending update", async () => {
    const emitted: Array<[number, number]> = [];
    const throttle = createProgressThrottle((r, t) => {
      emitted.push([r, t]);
    }, 50);

    throttle.report(10, 100);
    throttle.report(20, 100);
    throttle.report(30, 100);

    // Initial report fired immediately
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], [10, 100]);

    await new Promise((r) => setTimeout(r, 70));
    // Timer should have flushed latest report
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[1], [30, 100]);

    throttle.report(40, 100);
    throttle.flush();
    assert.equal(emitted.length, 3);
    assert.deepEqual(emitted[2], [40, 100]);
  });
});

describe("artifact-download: downloadOne", () => {
  test("successful download verifies sha256 and renames part to destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-download-test-"));
    try {
      const destination = join(dir, "target.bin");
      const content = Buffer.from("hello world download test");
      const sha256 = createHash("sha256").update(content).digest("hex");
      const progress: Array<[number, number]> = [];

      const mockFetcher: typeof fetch = async () =>
        new Response(makeReadableStream([content]), {
          status: 200,
          headers: { "Content-Length": String(content.length) },
        });

      await downloadOne({
        url: "https://example.com/target.bin",
        destination,
        expectedSha256: sha256,
        expectedSize: content.length,
        signal: new AbortController().signal,
        onProgress: (r, t) => progress.push([r, t]),
        fetcher: mockFetcher,
      });

      const written = await readFile(destination);
      assert.deepEqual(written, content);
      assert.ok(progress.length > 0);
      assert.equal(progress[progress.length - 1]![0], content.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resumes download with 206 when part file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-download-test-"));
    try {
      const destination = join(dir, "target.bin");
      const part1 = Buffer.from("hello ");
      const part2 = Buffer.from("world");
      const full = Buffer.concat([part1, part2]);
      const sha256 = createHash("sha256").update(full).digest("hex");

      // Write existing .part and .part.json
      await writeFile(`${destination}.part`, part1);
      await writeFile(
        `${destination}.part.json`,
        JSON.stringify({
          url: "https://example.com/target.bin",
          etag: '"etag-1"',
          totalBytes: full.length,
          receivedBytes: part1.length,
        }),
      );

      let requestedHeaders: Headers | undefined;
      const mockFetcher: typeof fetch = async (_url, init) => {
        requestedHeaders = new Headers(init?.headers);
        return new Response(makeReadableStream([part2]), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${part1.length}-${full.length - 1}/${full.length}`,
            "Content-Length": String(part2.length),
            ETag: '"etag-1"',
          },
        });
      };

      await downloadOne({
        url: "https://example.com/target.bin",
        destination,
        expectedSha256: sha256,
        expectedSize: full.length,
        signal: new AbortController().signal,
        onProgress: () => {},
        fetcher: mockFetcher,
      });

      assert.equal(requestedHeaders?.get("range"), `bytes=${part1.length}-`);
      assert.equal(requestedHeaders?.get("if-range"), '"etag-1"');

      const written = await readFile(destination);
      assert.deepEqual(written, full);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects 206 when Content-Range start does not match received bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-download-test-"));
    try {
      const destination = join(dir, "target.bin");
      const part1 = Buffer.from("hello ");
      await writeFile(`${destination}.part`, part1);
      await writeFile(
        `${destination}.part.json`,
        JSON.stringify({
          url: "https://example.com/target.bin",
          totalBytes: 11,
          receivedBytes: part1.length,
        }),
      );

      const mockFetcher: typeof fetch = async () =>
        new Response(makeReadableStream([Buffer.from("world")]), {
          status: 206,
          headers: {
            // Bad starting offset (0 instead of 6)
            "Content-Range": "bytes 0-10/11",
          },
        });

      await assert.rejects(
        () =>
          downloadOne({
            url: "https://example.com/target.bin",
            destination,
            expectedSha256: "dummy",
            expectedSize: 11,
            signal: new AbortController().signal,
            onProgress: () => {},
            fetcher: mockFetcher,
          }),
        /Content-Range 起点不符/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resets to 0 when server returns 200 instead of 206", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-download-test-"));
    try {
      const destination = join(dir, "target.bin");
      const full = Buffer.from("entire content from zero");
      const sha256 = createHash("sha256").update(full).digest("hex");

      // Write stale part file
      await writeFile(`${destination}.part`, Buffer.from("stale bytes"));
      await writeFile(
        `${destination}.part.json`,
        JSON.stringify({
          url: "https://example.com/target.bin",
          totalBytes: 100,
          receivedBytes: 11,
        }),
      );

      const mockFetcher: typeof fetch = async () =>
        new Response(makeReadableStream([full]), {
          status: 200,
          headers: { "Content-Length": String(full.length) },
        });

      await downloadOne({
        url: "https://example.com/target.bin",
        destination,
        expectedSha256: sha256,
        expectedSize: full.length,
        signal: new AbortController().signal,
        onProgress: () => {},
        fetcher: mockFetcher,
      });

      const written = await readFile(destination);
      assert.deepEqual(written, full);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves .part and .part.json on abort signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-download-test-"));
    try {
      const destination = join(dir, "target.bin");
      const controller = new AbortController();

      const chunk1 = Buffer.from("chunk-one ");
      const chunk2 = Buffer.from("chunk-two");

      const mockFetcher: typeof fetch = async () =>
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(chunk1);
              // Wait before sending chunk 2 to allow abort
              await new Promise((r) => setTimeout(r, 20));
              controller.abort(new Error("User cancelled download"));
              c.enqueue(chunk2);
              c.close();
            },
          }),
          { status: 200 },
        );

      await assert.rejects(
        () =>
          downloadOne({
            url: "https://example.com/target.bin",
            destination,
            expectedSha256: "0".repeat(64),
            expectedSize: chunk1.length + chunk2.length,
            signal: controller.signal,
            onProgress: () => {},
            fetcher: mockFetcher,
          }),
        /cancelled/,
      );

      // Verify .part exists and holds the downloaded bytes
      const partStat = await stat(`${destination}.part`);
      assert.ok(partStat.size > 0);
      const metaStat = await stat(`${destination}.part.json`);
      assert.ok(metaStat.size > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects when sha256 mismatch and does not create destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-download-test-"));
    try {
      const destination = join(dir, "target.bin");
      const content = Buffer.from("actual content");

      const mockFetcher: typeof fetch = async () =>
        new Response(makeReadableStream([content]), { status: 200 });

      await assert.rejects(
        () =>
          downloadOne({
            url: "https://example.com/target.bin",
            destination,
            expectedSha256: "f".repeat(64),
            expectedSize: content.length,
            signal: new AbortController().signal,
            onProgress: () => {},
            fetcher: mockFetcher,
          }),
        /SHA-256 校验失败/,
      );

      await assert.rejects(() => stat(destination), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("artifact-download: assertFreeSpace", () => {
  test("passes for reasonable required space and rejects for huge required space", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-space-test-"));
    try {
      await assert.doesNotReject(() => assertFreeSpace(dir, 1024)); // 1 KB
      // 100 PB will definitely exceed any disk space
      await assert.rejects(() => assertFreeSpace(dir, 100 * 1024 * 1024 * 1024 * 1024 * 1024), /磁盘空间不足/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("signed size bounds reject oversized and short bodies even when their hash matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-download-size-"));
  try {
    for (const expectedSize of [2, 20]) {
      const content = Buffer.from("content");
      const destination = join(dir, `size-${expectedSize}`);
      await assert.rejects(downloadOne({
        url: "https://example.com/file", destination, expectedSize,
        expectedSha256: createHash("sha256").update(content).digest("hex"),
        signal: new AbortController().signal, onProgress() {},
        fetcher: async () => new Response(content),
      }), /size/);
      await assert.rejects(stat(destination), { code: "ENOENT" });
      assert.ok((await stat(`${destination}.part`)).size <= expectedSize);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("complete partial file is verified without a 416 request and corrupt completion restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-download-complete-"));
  try {
    const content = Buffer.from("complete");
    for (const corrupt of [false, true]) {
      const destination = join(dir, String(corrupt));
      await writeFile(`${destination}.part`, corrupt ? Buffer.alloc(content.length) : content);
      await writeFile(`${destination}.part.json`, JSON.stringify({ url: "https://example.com/file", receivedBytes: content.length }));
      let requests = 0;
      await downloadOne({
        url: "https://example.com/file", destination, expectedSize: content.length,
        expectedSha256: createHash("sha256").update(content).digest("hex"),
        signal: new AbortController().signal, onProgress() {},
        fetcher: async () => { requests++; return new Response(content); },
      });
      assert.equal(requests, corrupt ? 1 : 0);
      assert.deepEqual(await readFile(destination), content);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("partial HTTP responses require a complete matching Content-Range", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-download-range-"));
  try {
    for (const range of [undefined, "bytes 0-1/99", "bytes 0-1/*"]) {
      await assert.rejects(downloadOne({
        url: "https://example.com/file", destination: join(dir, "file"), expectedSize: 2,
        expectedSha256: "0".repeat(64), signal: new AbortController().signal, onProgress() {},
        fetcher: async () => new Response("ok", { status: 206, headers: range ? { "Content-Range": range } : {} }),
      }), /Content-Range/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
