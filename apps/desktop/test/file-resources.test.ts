import test from "node:test";
import assert from "node:assert/strict";
import { FileResources } from "../src/file-resources.js";
import type { ClientTransport, WorkspaceFileInfo, WorkspaceId } from "@omp-studio/client-contract";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
  await assert.rejects(iterator.next(), /关闭/);
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
