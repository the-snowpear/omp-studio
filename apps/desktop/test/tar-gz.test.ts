import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { gzipSync } from "node:zlib";

import { extractTarGz } from "../src/tar-gz.js";

function buildTarHeader(opts: {
  name: string;
  size: number;
  typeflag?: string | undefined;
  prefix?: string | undefined;
}): Buffer {
  const header = Buffer.alloc(512);
  const { name, size, typeflag = "0", prefix = "" } = opts;

  // Name: 0..99
  Buffer.from(name, "utf8").copy(header, 0, 0, 100);
  // Mode: 100..107
  Buffer.from("0000644\0", "ascii").copy(header, 100);
  // UID: 108..115
  Buffer.from("0000000\0", "ascii").copy(header, 108);
  // GID: 116..123
  Buffer.from("0000000\0", "ascii").copy(header, 116);
  // Size: 124..135 (octal, 11 chars + space or null)
  const octalSize = size.toString(8).padStart(11, "0") + " ";
  Buffer.from(octalSize, "ascii").copy(header, 124);
  // MTime: 136..147
  Buffer.from("14000000000 ", "ascii").copy(header, 136);
  // Checksum placeholder: 148..155 (filled with spaces for calculation)
  header.fill(32, 148, 156);
  // Typeflag: 156
  header[156] = typeflag.charCodeAt(0);
  // Magic: 257..262
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  // Version: 263..264
  Buffer.from("00", "ascii").copy(header, 263);
  // Prefix: 345..499
  if (prefix) {
    Buffer.from(prefix, "utf8").copy(header, 345, 0, 155);
  }

  // Calculate checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i]!;
  }
  const octalSum = sum.toString(8).padStart(6, "0") + "\0 ";
  Buffer.from(octalSum, "ascii").copy(header, 148);

  return header;
}

function createTarGz(entries: Array<{
  name: string;
  content?: Buffer | string;
  typeflag?: string;
  prefix?: string;
  isLongName?: boolean;
}>): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const rawContent = entry.content ?? "";
    const contentBuf = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, "utf8");

    if (entry.isLongName) {
      // GNU LongName header + block
      const longNameBytes = Buffer.from(entry.name + "\0", "utf8");
      const longNameHeader = buildTarHeader({
        name: "././@LongLink",
        size: longNameBytes.length,
        typeflag: "L",
      });
      blocks.push(longNameHeader);
      const padLen = (512 - (longNameBytes.length % 512)) % 512;
      blocks.push(Buffer.concat([longNameBytes, Buffer.alloc(padLen)]));

      // Now the normal file header
      const header = buildTarHeader({
        name: entry.name.slice(0, 100),
        size: contentBuf.length,
        typeflag: entry.typeflag ?? "0",
      });
      blocks.push(header);
    } else {
      const header = buildTarHeader({
        name: entry.name,
        size: contentBuf.length,
        typeflag: entry.typeflag ?? (entry.name.endsWith("/") ? "5" : "0"),
        prefix: entry.prefix,
      });
      blocks.push(header);
    }

    if (contentBuf.length > 0) {
      const padLen = (512 - (contentBuf.length % 512)) % 512;
      blocks.push(Buffer.concat([contentBuf, Buffer.alloc(padLen)]));
    }
  }

  // Two 512-byte zero blocks at the end
  blocks.push(Buffer.alloc(1024));

  const tarData = Buffer.concat(blocks);
  return gzipSync(tarData);
}

describe("extractTarGz", () => {
  let tmpDir: string;

  test("extracts files and directories correctly", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const archive = createTarGz([
        { name: "sub/", typeflag: "5" },
        { name: "sub/hello.txt", content: "Hello, World!" },
        { name: "nested/dir/test.json", content: '{"ok":true}' },
      ]);
      const archivePath = join(tmpDir, "test.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await extractTarGz(archivePath, dest);

      const helloContent = await readFile(join(dest, "sub", "hello.txt"), "utf8");
      assert.equal(helloContent, "Hello, World!");

      const jsonContent = await readFile(join(dest, "nested", "dir", "test.json"), "utf8");
      assert.equal(jsonContent, '{"ok":true}');

      const dirStat = await stat(join(dest, "sub"));
      assert.equal(dirStat.isDirectory(), true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("supports GNU LongName extension", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const longPath = "very/deeply/nested/directory/structure/with/a/filename/that/definitely/exceeds/one/hundred/characters/in/total/file.txt";
      const archive = createTarGz([
        { name: longPath, content: "deep content", isLongName: true },
      ]);
      const archivePath = join(tmpDir, "longname.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await extractTarGz(archivePath, dest);

      const content = await readFile(join(dest, ...longPath.split("/")), "utf8");
      assert.equal(content, "deep content");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects path traversal with ..", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const archive = createTarGz([
        { name: "sub/../../escape.txt", content: "evil" },
      ]);
      const archivePath = join(tmpDir, "evil.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await assert.rejects(
        () => extractTarGz(archivePath, dest),
        /非法路径段（含 \.\.）/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects path with backslash", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const archive = createTarGz([
        { name: "sub\\evil.txt", content: "evil" },
      ]);
      const archivePath = join(tmpDir, "backslash.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await assert.rejects(
        () => extractTarGz(archivePath, dest),
        /非法路径格式（含反斜杠）/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects path exceeding 255 bytes", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const hugeName = "a/".repeat(130) + "file.txt";
      const archive = createTarGz([
        { name: hugeName, content: "too long", isLongName: true },
      ]);
      const archivePath = join(tmpDir, "toolong.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await assert.rejects(
        () => extractTarGz(archivePath, dest),
        /路径名称过长/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects unsupported typeflag like symlinks", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const archive = createTarGz([
        { name: "link.txt", content: "target", typeflag: "2" },
      ]);
      const archivePath = join(tmpDir, "symlink.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await assert.rejects(
        () => extractTarGz(archivePath, dest),
        /不支持的条目类型/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("enforces maxEntries limit", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const archive = createTarGz([
        { name: "file1.txt", content: "1" },
        { name: "file2.txt", content: "2" },
        { name: "file3.txt", content: "3" },
      ]);
      const archivePath = join(tmpDir, "entries.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await assert.rejects(
        () => extractTarGz(archivePath, dest, { maxEntries: 2 }),
        /条目数超过上限/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("enforces maxTotalBytes limit", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "targz-test-"));
    try {
      const archive = createTarGz([
        { name: "file1.txt", content: "1234567890" },
        { name: "file2.txt", content: "1234567890" },
      ]);
      const archivePath = join(tmpDir, "bytes.tar.gz");
      await writeFile(archivePath, archive);

      const dest = join(tmpDir, "out");
      await assert.rejects(
        () => extractTarGz(archivePath, dest, { maxTotalBytes: 15 }),
        /解压总量超过上限/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("tar rejects oversized header before its data arrives, truncated data, and directory entry floods", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tar-limits-"));
  try {
    const cases = [
      { archive: gzipSync(buildTarHeader({ name: "huge", size: 2 ** 30 })), limits: { maxTotalBytes: 100 }, error: /解压总量超过上限/ },
      { archive: gzipSync(buildTarHeader({ name: "short", size: 10 })), limits: {}, error: /Truncated/ },
      { archive: createTarGz([{ name: "a/" }, { name: "b/" }]), limits: { maxEntries: 1 }, error: /条目数超过上限/ },
      { archive: createTarGz([{ name: "zeros", content: Buffer.alloc(20000) }]), limits: { maxRatio: 10 }, error: /解压压缩比异常/ },
    ];
    for (const [i, sample] of cases.entries()) {
      const archivePath = join(dir, `${i}.gz`);
      await writeFile(archivePath, sample.archive);
      await assert.rejects(extractTarGz(archivePath, join(dir, `out-${i}`), sample.limits), sample.error);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("tar rejects absolute paths, Windows aliases, duplicate files, and disguised link directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tar-paths-"));
  try {
    const cases = [
      [{ name: "/absolute", content: "x" }],
      [{ name: "file:stream", content: "x" }],
      [{ name: "CON.txt", content: "x" }],
      [{ name: "link/", typeflag: "2" }],
      [{ name: "same", content: "1" }, { name: "same", content: "2" }],
    ];
    for (const [i, entries] of cases.entries()) {
      const archivePath = join(dir, `${i}.gz`);
      await writeFile(archivePath, createTarGz(entries));
      await assert.rejects(extractTarGz(archivePath, join(dir, `out-${i}`)));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
