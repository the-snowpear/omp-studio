/** Isolated install → DOCX/PPTX conversion → cache → uninstall acceptance; never uses the operator profile. */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { zipSync, strToU8 } from "fflate";
import { WorkspaceRegistry } from "../packages/studio-host/dist/src/index.js";
import { createWorkspaceFileService } from "../apps/desktop/dist/src/workspace-files.js";
import { FileResources } from "../apps/desktop/dist/src/file-resources.js";
import { OfficeComponent } from "../apps/desktop/dist/src/office-component.js";

const arg = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const directory = resolve(arg("directory") ?? "outputs/file-viewer-office-qa");
const platform = `${process.platform}-${process.arch}`;
const envelope = JSON.parse(await readFile(join(directory, `office-preview-${platform}.json`), "utf8"));
const key = await readFile(resolve(arg("public-key") ?? join(directory, "qa-public.pem")), "utf8");
const archive = join(directory, basename(new URL(envelope.manifest.archive.url).pathname));
const project = join(directory, "sample-project"), profile = join(directory, "isolated-profile");
await mkdir(project, { recursive: true });
const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const types = 'http://schemas.openxmlformats.org/package/2006/content-types';
const zip = entries => zipSync(Object.fromEntries(Object.entries(entries).map(([name, xml]) => [name, strToU8(xml)])));
const docx = zip({
  '[Content_Types].xml': `<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OMP Studio 中文文档验收</w:t></w:r></w:p><w:p><w:r><w:t>FILE_VIEWER_DOCX</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>文件</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>只读预览</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
});
const pptx = zip({
  '[Content_Types].xml': `<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
  '_rels/.rels': `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/></Relationships>`,
  'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="600000" y="600000"/><a:ext cx="8000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="3200"/><a:t>FILE_VIEWER_PPTX 中文幻灯片</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
});
await writeFile(join(project, "中文文档.docx"), docx); await writeFile(join(project, "中文幻灯片.pptx"), pptx);
const registry = new WorkspaceRegistry(join(profile, "registry.json"));
const workspace = await registry.upsertByPath(project), service = createWorkspaceFileService({ registry });
const resources = new FileResources(() => ({ query: async request => ({ ok: true, queryName: request.queryName, result: await (request.queryName === "workspace.file.inspect" ? service.inspect(request.input) : service.readChunk(request.input)) }) }));
const component = new OfficeComponent(join(profile, "components", "office-preview"), { [envelope.signature.keyId]: key }, { manifestUrl: "https://office-qa.invalid/manifest.json", fetcher: async url => String(url).endsWith(".json") ? Response.json(envelope) : new Response(Readable.toWeb(createReadStream(archive)), { headers: { "Content-Length": String(envelope.manifest.archive.bytes) } }) });
const states = []; component.subscribe(state => { if (states.at(-1) !== state.status) { states.push(state.status); console.log(`Office component: ${state.status}`); } });
const installed = await component.install(); assert.equal(installed.status, "ready", installed.message);
const results = [];
try {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  for (const [path, marker, original] of [["中文文档.docx", "FILE_VIEWER_DOCX", docx], ["中文幻灯片.pptx", "FILE_VIEWER_PPTX", pptx]]) {
    const resource = await resources.open({ targetId: null, workspaceId: workspace.workspaceId, path }, 1);
    const pdf = await component.convert(resources, resource.id, 1);
    assert.equal(await component.convert(resources, resource.id, 1), pdf, "unchanged document should reuse its conversion");
    const data = new Uint8Array(await readFile(pdf)); assert.equal(Buffer.from(data.subarray(0, 5)).toString(), "%PDF-");
    const task = pdfjs.getDocument({ data, useWasm: false }); const document = await task.promise;
    let text = ""; for (let page = 1; page <= document.numPages; page++) text += (await (await document.getPage(page)).getTextContent()).items.map(item => item.str ?? "").join(" ");
    assert.ok(text.includes(marker), `Missing converted text: ${text}`);
    results.push({ path, pages: document.numPages, text }); await task.destroy();
    await copyFile(pdf, join(directory, `${path}.pdf`));
    assert.deepEqual(new Uint8Array(await readFile(join(project, path))), original);
    resources.release(resource.id, 1);
  }
  assert.equal((await component.uninstall()).status, "not-installed");
  await assert.rejects(access(join(profile, "components", "office-preview", "versions")));
  await writeFile(join(directory, "smoke-results.json"), JSON.stringify({ states, results, uninstalled: true }, null, 2));
  console.log(JSON.stringify({ converted: results.map(result => result.path), uninstalled: true }));
} finally { resources.dispose(); component.dispose(); }
