import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { parseAvatarSaveInput } from "../src/chrome-profile-shared.js";
import {
  clearProfileAvatar,
  migrateProfileAvatar,
  readProfileAvatar,
  resolveLegacyInstallUserdataRoot,
  resolveProfilePersistRoot,
  writeProfileAvatar,
} from "../src/chrome-profile-store.js";

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9, 0x00, 0x00,
]);

let dir: string | undefined;

afterEach(async () => {
  if (dir === undefined) return;
  await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function tempDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "omp-avatar-"));
  return dir;
}

describe("parseAvatarSaveInput", () => {
  test("accepts a jpeg buffer with a valid SOI marker", () => {
    const parsed = parseAvatarSaveInput({ mime: "image/jpeg", bytes: JPEG });
    assert.ok(parsed);
    assert.equal(parsed.mime, "image/jpeg");
    assert.equal(parsed.bytes.byteLength, JPEG.byteLength);
  });

  test("rejects a non-image mime, tiny payload, and mismatched magic", () => {
    assert.equal(parseAvatarSaveInput({ mime: "image/gif", bytes: JPEG }), undefined);
    assert.equal(parseAvatarSaveInput({ mime: "image/jpeg", bytes: JPEG.slice(0, 8) }), undefined);
    const fakePng = Uint8Array.from(JPEG);
    assert.equal(parseAvatarSaveInput({ mime: "image/png", bytes: fakePng }), undefined);
  });
});

describe("profile avatar store", () => {
  test("persist root is %APPDATA%/omp-studio, not next to the exe", () => {
    const roaming = join(tmpdir(), "Roaming");
    assert.equal(resolveProfilePersistRoot(roaming), join(roaming, "omp-studio"));
    const installDir = join(tmpdir(), "OMP Studio");
    assert.equal(
      resolveLegacyInstallUserdataRoot({
        isPackaged: true,
        execPath: join(installDir, "OMP Studio.exe"),
        appPath: join(installDir, "resources", "app.asar"),
      }),
      join(installDir, "userdata"),
    );
  });

  test("writes one file under profile and replaces the previous avatar", async () => {
    const root = await tempDir();
    await writeProfileAvatar(root, { mime: "image/jpeg", bytes: JPEG });
    const first = join(root, "profile", "avatar.jpg");
    assert.deepEqual(await readFile(first), Buffer.from(JPEG));

    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    await writeProfileAvatar(root, { mime: "image/png", bytes: png });
    const loaded = await readProfileAvatar(root);
    assert.ok(loaded);
    assert.equal(loaded.mime, "image/png");
    await assert.rejects(readFile(first));
  });

  test("clear removes the avatar file and load returns null", async () => {
    const root = await tempDir();
    await writeProfileAvatar(root, { mime: "image/jpeg", bytes: JPEG });
    assert.ok(await readProfileAvatar(root));
    await clearProfileAvatar(root);
    assert.equal(await readProfileAvatar(root), null);
  });

  test("migrates a leftover install-dir avatar into AppData and deletes the source", async () => {
    const base = await tempDir();
    const dest = join(base, "omp-studio");
    const legacy = join(base, "userdata");
    await mkdir(join(legacy, "profile"), { recursive: true });
    await writeFile(join(legacy, "profile", "avatar.jpg"), JPEG);
    await migrateProfileAvatar(dest, [legacy]);
    const loaded = await readProfileAvatar(dest);
    assert.ok(loaded);
    assert.equal(loaded.mime, "image/jpeg");
    await assert.rejects(readFile(join(legacy, "profile", "avatar.jpg")));
  });

  test("does not keep a second copy when AppData already has an avatar", async () => {
    const base = await tempDir();
    const dest = join(base, "omp-studio");
    const legacy = join(base, "userdata");
    await writeProfileAvatar(dest, { mime: "image/jpeg", bytes: JPEG });
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    await writeProfileAvatar(legacy, { mime: "image/png", bytes: png });
    await migrateProfileAvatar(dest, [legacy]);
    const loaded = await readProfileAvatar(dest);
    assert.ok(loaded);
    assert.equal(loaded.mime, "image/jpeg");
    await assert.rejects(readFile(join(legacy, "profile", "avatar.png")));
  });
});
