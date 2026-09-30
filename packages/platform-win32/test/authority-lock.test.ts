import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthorityAlreadyOwnedError,
  AuthorityLockCorruptError,
  Win32AuthorityLock,
  type Win32AuthorityLockServices,
} from "../src/index.js";

/** In-memory filesystem + liveness double; records every path the lock touches. */
function fakeServices(options: { alive?: boolean } = {}) {
  const files = new Map<string, string>();
  const paths: string[] = [];
  let counter = 0;
  const services: Win32AuthorityLockServices = {
    createExclusive(path, content) {
      paths.push(path);
      if (files.has(path)) return false;
      files.set(path, content);
      return true;
    },
    read(path) {
      paths.push(path);
      return files.get(path) ?? null;
    },
    compareAndRemove(path, expected) {
      paths.push(path);
      if (files.get(path) !== expected) return false;
      files.delete(path);
      return true;
    },
    isOwnerAlive: () => options.alive ?? false,
    nowIso: () => "2026-09-29T00:00:00.000Z",
    randomId: () => `id-${++counter}`,
  };
  return { services, files, paths };
}

test("the default lock path keeps the historic Windows form", async () => {
  const fake = fakeServices();
  const lock = new Win32AuthorityLock({ profileDirectory: "C:\\Users\\me\\AppData\\Roaming\\omp-studio\\", environmentKey: "desktop", services: fake.services });
  await lock.acquire();
  assert.deepEqual([...fake.files.keys()], ["C:\\Users\\me\\AppData\\Roaming\\omp-studio\\omp-studio-authority.lock.json"]);
});

test("a POSIX profile keeps the lock file inside the profile directory", async () => {
  const fake = fakeServices();
  const lock = new Win32AuthorityLock({
    profileDirectory: "/Users/me/Library/Application Support/omp-studio/",
    environmentKey: "desktop",
    services: fake.services,
    pathStyle: "posix",
  });
  const lease = await lock.acquire();
  assert.deepEqual([...fake.files.keys()], ["/Users/me/Library/Application Support/omp-studio/omp-studio-authority.lock.json"]);
  await lease.release();
  assert.equal(fake.files.size, 0);
});

test("a live owner blocks a second owner and a dead owner is taken over", async () => {
  const live = fakeServices({ alive: true });
  await new Win32AuthorityLock({ profileDirectory: "/p", environmentKey: "desktop", services: live.services, pathStyle: "posix" }).acquire();
  await assert.rejects(
    () => new Win32AuthorityLock({ profileDirectory: "/p", environmentKey: "desktop", services: live.services, pathStyle: "posix" }).acquire(),
    AuthorityAlreadyOwnedError,
  );
  const dead = fakeServices({ alive: false });
  await new Win32AuthorityLock({ profileDirectory: "/p", environmentKey: "desktop", services: dead.services, pathStyle: "posix" }).acquire();
  const successor = await new Win32AuthorityLock({ profileDirectory: "/p", environmentKey: "desktop", services: dead.services, pathStyle: "posix" }).acquire();
  assert.equal(JSON.parse(dead.files.get("/p/omp-studio-authority.lock.json")!).ownerNonce, successor.nonce);
});

test("corrupt lock metadata fails closed and is never deleted", async () => {
  const fake = fakeServices();
  fake.files.set("/p/omp-studio-authority.lock.json", "{not json");
  await assert.rejects(
    () => new Win32AuthorityLock({ profileDirectory: "/p", environmentKey: "desktop", services: fake.services, pathStyle: "posix" }).acquire(),
    AuthorityLockCorruptError,
  );
  assert.equal(fake.files.get("/p/omp-studio-authority.lock.json"), "{not json");
});
