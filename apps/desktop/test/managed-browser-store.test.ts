import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ManagedBrowserStore } from "../src/managed-browser-store.js";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "omp-managed-browser-"));
  const stores: ManagedBrowserStore[] = [];
  const reopen = async () => { const store = new ManagedBrowserStore({ directory, downloadsDirectory: directory }); stores.push(store); await store.load(); return store; };
  context.after(async () => { for (const store of stores) await store.flush(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store: await reopen(), reopen };
}
test("chat tab limits do not evict pages or change another chat's control", async context => {
  const { store } = await fixture(context);
  store.settings({ maxTabs: 2 });
  const first = store.create("alpha", "https://example.com/a", "agent");
  const other = store.create("beta", "https://example.com/b", "human");
  const second = store.create("alpha", "https://example.com/c", "human");
  assert.throws(() => store.create("alpha", "https://example.com/d", "human"), /tab limit/);
  store.select("alpha", other.id);
  store.close("alpha", other.id);
  assert.deepEqual(store.state("alpha").pages.map(page => page.id), [first.id, second.id]);
  assert.equal(store.state("alpha").activePageId, second.id);
  assert.equal(store.state("alpha").control, "agent");
  assert.equal(store.state("beta").control, "human");
  store.control("alpha", "human");
  store.close("alpha", second.id);
  assert.equal(store.state("alpha").activePageId, first.id);
  store.create("alpha", "https://example.com/e", "agent");
  assert.equal(store.state("alpha").control, "human");
});
test("released and restored chats retain order, selected page and spaces without live state", async context => {
  const { store, reopen } = await fixture(context);
  const space = store.addSpace("Testing");
  const first = store.create("alpha", "https://example.com/a", "human");
  const second = store.create("alpha", "https://example.com/b", "agent", space.id);
  store.update(first.id, { title: "Form", status: "ready", canGoBack: true, devtools: true, zoom: 1.25 });
  store.select("alpha", first.id);
  store.control("alpha", "waiting");
  store.connection("alpha", "connected");
  store.release("alpha");
  assert.equal(store.page(first.id), first);
  assert.equal(first.status, "released");
  await store.flush();
  const restored = (await reopen()).state("alpha");
  assert.deepEqual(restored.pages.map(page => [page.id, page.spaceId]), [[first.id, "shared"], [second.id, space.id]]);
  assert.equal(restored.activePageId, first.id);
  assert.equal(restored.control, "human");
  assert.equal(restored.connection, "disconnected");
  assert.equal(restored.pages[0]?.zoom, 1.25);
  assert.ok(restored.pages.every(page => page.status === "released" && !page.devtools && !page.canGoBack));
});
test("flush includes changes made during earlier writes and persists permission revocation", async context => {
  const { store, reopen } = await fixture(context);
  const page = store.create("alpha", "https://example.com", "human");
  const pending = store.flush();
  await Promise.resolve();
  for (let revision = 1; revision <= 40; revision++) store.update(page.id, { url: `https://example.com/${revision}` });
  const permission = { spaceId: "shared", origin: "https://example.com", permission: "media", allowed: true };
  store.permission(permission);
  store.permission({ ...permission, spaceId: "isolated", allowed: false });
  store.forgetPermission("shared", permission.origin, "media");
  store.settings({ maxTabs: 24, askDownloadLocation: true });
  await Promise.all([pending, store.flush()]);
  const restored = (await reopen()).state("alpha");
  assert.equal(restored.pages[0]?.url, "https://example.com/40");
  assert.deepEqual(restored.permissions, [{ ...permission, spaceId: "isolated", allowed: false }]);
  assert.equal(restored.settings.maxTabs, 24);
  assert.equal(restored.settings.askDownloadLocation, true);
});
test("restored tabs keep their site icon but forget who opened them", async context => {
  const { store, reopen } = await fixture(context);
  const opener = store.create("alpha", "https://example.com", "human");
  const child = store.create("alpha", "https://example.com/docs", "human", "shared", { pageId: opener.id, popup: true });
  store.update(child.id, { favicon: "data:image/png;base64,AAAA" });
  assert.deepEqual(store.state("alpha").pages[1]?.opener, { source: "human", pageId: opener.id, popup: true });
  await store.flush();
  const restored = (await reopen()).state("alpha").pages;
  assert.equal(restored[1]?.favicon, "data:image/png;base64,AAAA");
  assert.ok(restored.every(page => page.opener === undefined));
});

test("live page status changes do not rewrite saved tabs, but navigation still persists", async context => {
  const { directory, store, reopen } = await fixture(context);
  const page = store.create("alpha", "https://example.com", "human");
  await store.flush();
  const file = join(directory, "browser.json");
  const savedAt = new Date("2000-01-01T00:00:00Z");
  await utimes(file, savedAt, savedAt);
  let changes = 0;
  store.options.changed = () => { changes++; };
  for (let i = 0; i < 25; i++) {
    store.update(page.id, { title: page.title, url: page.url, status: "loading", documentId: `document-${i}`, canGoBack: true });
    await store.flush();
  }
  assert.equal(changes, 25);
  assert.equal(store.page(page.id)?.documentId, "document-24");
  assert.equal(store.page(page.id)?.canGoBack, true);
  assert.equal((await stat(file)).mtimeMs, savedAt.getTime());
  store.update(page.id, { title: "Next page", url: "https://example.com/next", status: "ready" });
  await store.flush();
  const restored = (await reopen()).state("alpha").pages[0]!;
  assert.equal(restored.title, "Next page");
  assert.equal(restored.url, "https://example.com/next");
  assert.equal(restored.status, "released");
});

test("reading chats without pages does not grow the browser session archive", async context => {
  const { directory, store } = await fixture(context);
  for (let i = 0; i < 1000; i++) {
    assert.deepEqual(store.state(`unopened-${i}`).pages, []);
    assert.equal(store.initialControl(`unopened-${i}`), undefined);
    store.release(`unopened-${i}`);
  }
  store.create("opened", "https://example.com", "human");
  await store.flush();
  const saved = JSON.parse(await readFile(join(directory, "browser.json"), "utf8"));
  assert.deepEqual(saved.sessions.map((entry: { sessionId: string }) => entry.sessionId), ["opened"]);
});
