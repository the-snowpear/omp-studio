import { describe, it, expect, vi } from "vitest";
import type { StudioClient, WorkspaceFileInfo, WorkspaceFileText } from "@omp-studio/client-contract";
import { FileDocument, getFileDocument, releaseFileDocument } from "./fileDocuments";

const file: WorkspaceFileInfo = { workspaceId: "workspace" as WorkspaceFileInfo["workspaceId"], id: "file", name: "README.md", path: "README.md", mime: "text/markdown", size: 4, version: "v1", writable: true };
const read = (text = "base", version = "v1"): WorkspaceFileText => ({ file: { ...file, version }, text, encoding: "utf8", bom: false, lineEnding: "lf" });
function backend() {
  let disk = read(), receipt: unknown;
  const query = vi.fn(async (name: string) => name === "workspace.file.inspect" ? disk.file : disk);
  const command = vi.fn(async (_name: string, input: { text: string; expectedVersion: string }) => {
    const result = input.expectedVersion === disk.file.version ? { saved: true, file: { ...disk.file, version: "saved" } } : { saved: false, conflict: true, file: disk.file };
    if (result.saved) disk = read(input.text, "saved");
    receipt = { status: "completed", result };
    return { requestId: "write" };
  });
  const client = { query, command, getState: () => ({ commands: { write: receipt } }) } as unknown as StudioClient;
  return { client, query, command, disk: (value: WorkspaceFileText) => { disk = value; } };
}
describe("file editing", () => {
  it("retains a draft when the Agent edits the file and only overwrites after an explicit choice", async () => {
    const source = backend(), document = new FileDocument(file, async () => source.client);
    await document.load(); document.edit("my draft"); source.disk(read("agent edit", "agent"));
    await document.refresh();
    expect(document.getSnapshot().text).toBe("my draft"); expect(document.getSnapshot().external?.version).toBe("agent");
    expect(await document.save()).toBe(false); expect(document.getSnapshot().dirty).toBe(true);
    expect(await document.save(true)).toBe(true); expect(document.getSnapshot().dirty).toBe(false);
    expect(source.command).toHaveBeenLastCalledWith("workspace.file.writeText", expect.objectContaining({ text: "my draft", expectedVersion: "agent" }));
    document.dispose();
  });
  it("resolves a lost acknowledgement by reading back without replaying the write", async () => {
    const source = backend(), document = new FileDocument(file, async () => source.client);
    await document.load(); document.edit("already saved");
    source.command.mockImplementationOnce(async () => { source.disk(read("already saved", "saved")); throw new Error("connection lost"); });
    expect(await document.save()).toBe(true); expect(source.command).toHaveBeenCalledTimes(1); expect(document.getSnapshot().dirty).toBe(false);
    document.dispose();
  });
  it("keeps typing that started while a background reload was in flight", async () => {
    const source = backend(), document = new FileDocument(file, async () => source.client);
    await document.load();
    let finish!: (value: WorkspaceFileText) => void;
    source.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const loading = document.load(); await Promise.resolve(); await Promise.resolve();
    document.edit("new typing"); finish(read("disk change", "new")); await loading;
    expect(document.getSnapshot().text).toBe("new typing"); expect(document.getSnapshot().external?.version).toBe("new");
    document.discard(); document.dispose();
  });
  it("keeps typing that began after an explicit discard and reload", async () => {
    const source = backend(), document = new FileDocument(file, async () => source.client);
    await document.load(); document.edit("old draft");
    let finish!: (value: WorkspaceFileText) => void;
    source.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const loading = document.load(true); await Promise.resolve(); await Promise.resolve();
    document.edit("typing after reload"); finish({ ...read("disk change", "new"), encoding: "utf16le", bom: true }); await loading;
    expect(document.getSnapshot().text).toBe("typing after reload"); expect(document.getSnapshot().dirty).toBe(true);
    expect(document.getSnapshot().format.encoding).toBe("utf8");
    document.discard(); document.dispose();
  });
  it("requires another save before closing if the draft changes during a write", async () => {
    const source = backend(), document = new FileDocument(file, async () => source.client);
    await document.load(); document.edit("first change");
    let finish!: () => void;
    const written = source.command.getMockImplementation()!;
    source.command.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return written(...args); });
    const saving = document.save(); await Promise.resolve(); await Promise.resolve();
    document.edit("second change"); finish();
    expect(await saving).toBe(false); expect(document.getSnapshot().text).toBe("second change"); expect(document.getSnapshot().dirty).toBe(true);
    expect(await document.save()).toBe(true); expect(document.getSnapshot().dirty).toBe(false);
    document.dispose();
  });
  it("reconciles an uncertain save after the SSH connection returns", async () => {
    const source = backend(), document = new FileDocument(file, async () => source.client);
    await document.load(); document.edit("saved remotely");
    source.command.mockImplementationOnce(async () => { source.disk(read("saved remotely", "saved")); throw new Error("connection lost"); });
    source.query.mockRejectedValueOnce(new Error("still offline"));
    expect(await document.save()).toBe(false); expect(document.getSnapshot().dirty).toBe(true);
    await document.refresh();
    expect(document.getSnapshot().dirty).toBe(false); expect(document.getSnapshot().error).toBe(""); expect(source.command).toHaveBeenCalledTimes(1);
    document.dispose();
  });
  it("shares a buffer across conversation views but separates different SSH targets", () => {
    const source = backend(), first = getFileDocument(null, file, async () => source.client, false);
    const same = getFileDocument(null, { ...file, path: "./README.md" }, async () => source.client, false);
    const remote = getFileDocument("ssh", file, async () => source.client, false);
    expect(same).toBe(first); expect(remote).not.toBe(first);
    first.edit("shared"); expect(same.getSnapshot().text).toBe("shared"); expect(remote.getSnapshot().text).toBe("");
    first.discard(); releaseFileDocument(first); releaseFileDocument(remote);
  });
});
