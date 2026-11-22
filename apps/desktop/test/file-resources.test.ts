import test from "node:test";
import assert from "node:assert/strict";
import { FileResources } from "../src/file-resources.js";
import type { ClientTransport, WorkspaceFileInfo, WorkspaceId } from "@omp-studio/client-contract";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("desktop and SSH file URLs stream ranges and retain the originating target", async () => {
  const data = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz"), targets: (string | null)[] = [];
  const file: WorkspaceFileInfo = { workspaceId: "workspace" as WorkspaceId, id: "same-file", path: "movie.mp4", name: "movie.mp4", version: "one", size: data.length, mime: "video/mp4", writable: true };
  const resources = new FileResources(target => {
    targets.push(target);
    return { query: async (request: { queryName: string; input: { offset?: number; length?: number } }) => {
      const bytes = data.subarray(request.input.offset ?? 0, (request.input.offset ?? 0) + (request.input.length ?? data.length));
      return { ok: true, queryName: request.queryName, result: request.queryName === "workspace.file.inspect" ? file : { data: bytes.toString("base64"), bytes: bytes.length } };
    } } as Pick<ClientTransport, "query">;
  });
  const lease = await resources.open({ targetId: "ssh-server", workspaceId: "workspace", path: "movie.mp4" }, 12);
  const response = await resources.response(new Request(lease.url, { headers: { Range: "bytes=10-19" } }), "null");
  assert.equal(response.status, 206); assert.equal(response.headers.get("Content-Range"), `bytes 10-19/${data.length}`); assert.equal(await response.text(), "abcdefghij");
  const tail = await resources.response(new Request(lease.url, { headers: { Range: "bytes=-3" } }), "null");
  assert.equal(await tail.text(), "xyz"); assert.ok(targets.every(target => target === "ssh-server"));
  const iterator = resources.bytes(lease.id); resources.release(lease.id, 12);
  await assert.rejects(iterator.next(), /closed/);
  assert.equal((await resources.response(new Request(lease.url), "null")).status, 404);
});

test("closing an Office view also aborts its converted PDF stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-pdf-resource-"));
  const file: WorkspaceFileInfo = { workspaceId: "workspace" as WorkspaceId, id: "office", path: "report.docx", name: "report.docx", version: "one", size: 10, mime: "application/octet-stream", writable: true };
  const resources = new FileResources(() => ({ query: async (request: { queryName: string }) => ({ ok: true, queryName: request.queryName, result: file }) }) as Pick<ClientTransport, "query">);
  try {
    const pdf = join(directory, "report.pdf"); await writeFile(pdf, Buffer.alloc(2 * 1024 * 1024, 42));
    const lease = await resources.open({ targetId: null, workspaceId: "workspace", path: "report.docx" }, 12);
    resources.setPdf(lease.id, pdf);
    const response = await resources.response(new Request(`${lease.url}/preview.pdf`), "null"), reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    resources.release(lease.id, 12);
    await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /abort/i);
  } finally { resources.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("an interrupted SSH download preserves the destination and can be retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-ssh-download-"));
  const destination = join(directory, "report.txt");
  const file = { id: "report", path: "/srv/report.txt", name: "report.txt", size: 6, version: "v1" };
  let connected = false;
  const resources = new FileResources(() => ({ query: async (request: { queryName: string; input: { offset?: number } }) => {
    if (request.queryName === "fs.file.inspect") return { ok: true, result: file };
    if (request.input.offset && !connected) throw new Error("SSH disconnected");
    const part = Buffer.from(request.input.offset ? "def" : "abc");
    return { ok: true, result: { data: part.toString("base64"), bytes: part.length } };
  } }) as Pick<ClientTransport, "query">);
  try {
    await writeFile(destination, "existing");
    const lease = await resources.open({ targetId: "ssh", workspaceId: "", path: file.path, source: "system" }, 1);
    await assert.rejects(resources.copy(lease.id, destination), /SSH disconnected/);
    assert.equal(await readFile(destination, "utf8"), "existing");
    assert.deepEqual(await readdir(directory), ["report.txt"]);
    connected = true;
    await resources.copy(lease.id, destination);
    assert.equal(await readFile(destination, "utf8"), "abcdef");
  } finally { resources.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("system file resources use absolute paths on the originating SSH Host", async () => {
  const requests: { queryName: string; input: Record<string, unknown> }[] = [], targets: (string | null)[] = [];
  const resources = new FileResources(target => {
    targets.push(target);
    return { query: async (request: { queryName: string; input: Record<string, unknown> }) => {
      requests.push(request);
      return { ok: true, queryName: request.queryName, result: request.queryName === "fs.file.inspect"
        ? { id: "outside", path: "/home/demo/file.png", name: "file.png", size: 5, version: "v1", writable: true, mime: "image/png" }
        : { data: Buffer.from("image").toString("base64"), bytes: 5 } };
    } } as Pick<ClientTransport, "query">;
  });
  const lease = await resources.open({ targetId: "ssh", workspaceId: "", path: "/home/demo/file.png", source: "system" }, 1);
  assert.equal(await (await resources.response(new Request(lease.url), "null")).text(), "image");
  assert.deepEqual(requests.map(request => request.queryName), ["fs.file.inspect", "fs.file.readChunk"]);
  assert.ok(requests.every(request => request.input.path === "/home/demo/file.png" && !("workspaceId" in request.input)));
  assert.ok(targets.every(target => target === "ssh"));
  resources.releaseOwner(1);
  assert.equal((await resources.response(new Request(lease.url), "null")).status, 404);
});
