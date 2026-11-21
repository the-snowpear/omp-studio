import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkspaceFileInfo, WorkspaceId } from "@omp-studio/client-contract";
import { fileMime } from "../src/file-io.js";
import { FileResources } from "../src/file-resources.js";
import { officeManifestPayload, type SignedOfficeComponent } from "../src/office-component-manifest.js";
import { OfficeComponent } from "../src/office-component.js";

for (const action of ["install", "check"] as const) test(`cancels Office ${action} while checking the component manifest`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-office-cancel-"));
  let started!: () => void, calls = 0;
  const checking = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (_input, options) => {
    calls++; started();
    return new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
  };
  const component = new OfficeComponent(directory, {}, { platform: "win32-x64", fetcher });
  try {
    const operation = action === "install" ? component.install() : component.getState(true);
    await checking; component.cancel();
    const state = await operation;
    assert.equal(state.status, "not-installed"); assert.match(state.message!, /cancelled/i); assert.equal(calls, 1);
    assert.equal((await component.getState()).installedVersion, undefined);
  } finally { component.dispose(); await rm(directory, { recursive: true, force: true }); }
});
test("unsupported platforms stay explicit and never request the manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-office-unsupported-"));
  await writeFile(join(directory, "keep.txt"), "preserve");
  let calls = 0;
  const component = new OfficeComponent(directory, {}, { platform: "linux-x64", fetcher: async () => { calls++; throw new Error("unexpected request"); } });
  try {
    assert.equal((await component.getState(true)).status, "unsupported");
    assert.equal((await component.install()).status, "unsupported");
    assert.equal((await component.uninstall()).status, "unsupported");
    assert.match((await component.getState()).message ?? "", /not available/i);
    assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "preserve");
    assert.equal(calls, 0);
  } finally { component.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("new Office formats and macro-enabled spreadsheets receive their file MIME types", () => {
  assert.equal(fileMime("report.ods"), "application/vnd.oasis.opendocument.spreadsheet");
  assert.equal(fileMime("report.docm"), "application/vnd.ms-word.document.macroEnabled.12");
  assert.equal(fileMime("slides.pptm"), "application/vnd.ms-powerpoint.presentation.macroEnabled.12");
  assert.equal(fileMime("report.xlsm"), "application/vnd.ms-excel.sheet.macroEnabled.12");
  assert.equal(fileMime("report.xlsb"), "application/vnd.ms-excel.sheet.binary.macroEnabled.12");
});

async function installManifest(directory: string, version: string): Promise<Readonly<Record<string, string | Buffer>>> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = { schema: 1 as const, component: "office-preview" as const, version, engineVersion: "26.8.2", platform: "win32-x64" as const, entrypoint: "LibreOffice/program/soffice.com", archive: { url: "https://example.org/office.zip", sha256: "a".repeat(64), bytes: 123 }, sourceUrl: "https://www.libreoffice.org", license: "MPL-2.0" };
  const payload = officeManifestPayload(manifest);
  const envelope: SignedOfficeComponent = { manifest, signature: { algorithm: "ed25519", keyId: "test", payloadSha256: createHash("sha256").update(payload).digest("hex"), signature: sign(null, payload, privateKey).toString("base64url") } };
  await mkdir(join(directory, "versions", version, "LibreOffice", "program"), { recursive: true });
  await writeFile(join(directory, "versions", version, "LibreOffice", "program", "soffice.com"), "test engine");
  await writeFile(join(directory, "installed.json"), JSON.stringify(envelope));
  return { test: publicKey.export({ type: "spki", format: "pem" }) };
}

test("initializing an installed component removes obsolete engines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-office-versions-"));
  const keys = await installManifest(directory, "26.8.2");
  await mkdir(join(directory, "versions", "26.7.0"), { recursive: true });
  const component = new OfficeComponent(directory, keys, { platform: "win32-x64" });
  try {
    assert.equal((await component.getState()).status, "ready");
    await access(join(directory, "versions", "26.8.2"));
    await assert.rejects(access(join(directory, "versions", "26.7.0")));
  } finally { component.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("installed engine pruning waits until active conversions release the old version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-office-engine-lease-"));
  const keys = await installManifest(directory, "26.8.2");
  await mkdir(join(directory, "versions", "26.7.0"), { recursive: true });
  const component = new OfficeComponent(directory, keys, { platform: "win32-x64" });
  const internals = component as unknown as { engineUsers: Map<string, number>; releaseEngine(version: string): Promise<void> };
  internals.engineUsers.set("26.7.0", 1);
  try {
    assert.equal((await component.getState()).status, "ready");
    await access(join(directory, "versions", "26.7.0"));
    await internals.releaseEngine("26.7.0");
    await assert.rejects(access(join(directory, "versions", "26.7.0")));
  } finally { component.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("cache pruning keeps PDFs still leased by open file viewers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-office-cache-"));
  const component = new OfficeComponent(directory, {}, { platform: "win32-x64" });
  const file: WorkspaceFileInfo = { workspaceId: "workspace" as WorkspaceId, id: "doc", path: "report.docx", name: "report.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1, version: "v1", writable: true };
  const resources = new FileResources(() => ({ query: async (request: { queryName: string }) => ({ ok: true, queryName: request.queryName, result: file }) }) as never);
  try {
    const resource = await resources.open({ targetId: null, workspaceId: "workspace", path: file.path }, 1);
    const activeKey = "cache-00", keepKey = "cache-32";
    const activePdf = join(directory, "cache", activeKey, "preview.pdf");
    for (let index = 0; index < 33; index++) {
      const pdf = join(directory, "cache", `cache-${String(index).padStart(2, "0")}`, "preview.pdf");
      await mkdir(join(directory, "cache", `cache-${String(index).padStart(2, "0")}`), { recursive: true });
      await writeFile(pdf, `cache ${index}`);
      const timestamp = Date.now() / 1000 - 10_000 + index;
      await utimes(pdf, timestamp, timestamp);
    }
    resources.setPdf(resource.id, activePdf);
    const internals = component as unknown as { pruneCache(key: string, resources: FileResources): Promise<void> };
    await internals.pruneCache(keepKey, resources);
    assert.equal(await readFile(activePdf, "utf8"), "cache 0");
    await assert.rejects(access(join(directory, "cache", "cache-01", "preview.pdf")));
  } finally { resources.dispose(); component.dispose(); await rm(directory, { recursive: true, force: true }); }
});
