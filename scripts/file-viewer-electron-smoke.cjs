/** Real sandboxed Electron / file:// CSP acceptance, with an isolated profile and no AgentSession. */
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const argument = name => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1]; };
const target = path.resolve(argument("file") ?? path.join(root, "outputs/file-viewer-office-qa/中文文档.docx.pdf"));
const output = path.join(root, "outputs/file-viewer-electron-qa");
if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [__filename, "--file", target], { env, stdio: "inherit", windowsHide: true });
  child.on("error", error => { console.error(error); process.exitCode = 1; });
  child.on("close", code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, protocol, ipcMain } = require("electron");
  app.setPath("userData", path.join(output, "profile"));
  protocol.registerSchemesAsPrivileged([{ scheme: "omp-file", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
  (async () => {
    await fs.mkdir(output, { recursive: true }); await fs.access(target);
    const { FileResources } = await import(pathToFileURL(path.join(root, "apps/desktop/dist/src/file-resources.js")));
    const { createWorkspaceFileService } = await import(pathToFileURL(path.join(root, "apps/desktop/dist/src/workspace-files.js")));
    const { WorkspaceRegistry } = await import(pathToFileURL(path.join(root, "packages/studio-host/dist/src/index.js")));
    const { RENDERER_CSP } = await import(pathToFileURL(path.join(root, "apps/desktop/dist/src/security.js")));
    const registry = new WorkspaceRegistry(path.join(output, "registry.json"));
    const workspace = await registry.upsertByPath(path.dirname(target));
    const service = createWorkspaceFileService({ registry });
    const resources = new FileResources(() => ({ query: async request => ({ ok: true, queryName: request.queryName, result: await (request.queryName === "workspace.file.inspect" ? service.inspect(request.input) : service.readChunk(request.input)) }) }));
    const requests = [], consoleErrors = [];
    await app.whenReady();
    protocol.handle("omp-file", request => { requests.push({ method: request.method, range: request.headers.get("range"), origin: request.headers.get("origin") }); return resources.response(request, "null"); });
    const preload = path.join(output, "preload.cjs"), html = path.join(output, "index.html"), script = path.join(output, "viewer.mjs");
    await fs.writeFile(preload, 'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("fileSmoke",{open:()=>ipcRenderer.invoke("file-smoke-open"),report:result=>ipcRenderer.invoke("file-smoke-result",result)});');
    const worker = pathToFileURL(path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs")).href;
    const library = pathToFileURL(path.join(root, "node_modules/pdfjs-dist/build/pdf.mjs")).href;
    await fs.writeFile(html, `<!doctype html><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP.replace("frame-ancestors 'none'", "")}"><body><canvas></canvas><script type="module" src="./viewer.mjs"></script></body>`);
    await fs.writeFile(script, `import * as pdfjs from ${JSON.stringify(library)};
      let phase='resource'; try {
        const resource=await window.fileSmoke.open();
        const response=await fetch(resource.url,{headers:{Range:'bytes=0-15'}});
        const prefix=new TextDecoder().decode(await response.arrayBuffer());
        if(response.status!==206 || !prefix.startsWith('%PDF-')) throw new Error('Range read failed: '+response.status);
        phase='pdf-worker'; const nativeWorker=new Worker(${JSON.stringify(worker)},{type:'module'});
        const worker=pdfjs.PDFWorker.create({port:nativeWorker});
        const task=pdfjs.getDocument({url:resource.url,worker,useWasm:false});
        const pdf=await task.promise; const page=await pdf.getPage(1);
        phase='render'; const viewport=page.getViewport({scale:1.2}), canvas=document.querySelector('canvas'); canvas.width=viewport.width;canvas.height=viewport.height;
        await page.render({canvasContext:canvas.getContext('2d'),canvas,viewport}).promise;
        const text=(await page.getTextContent()).items.map(item=>item.str||'').join(' ');
        await window.fileSmoke.report({ok:true,pages:pdf.numPages,text,rangeStatus:response.status});
        await task.destroy(); worker.destroy(); nativeWorker.terminate();
      } catch(error) { await window.fileSmoke.report({ok:false,phase,message:String(error)}); }
    `);
    const window = new BrowserWindow({ show: false, width: 1000, height: 1250, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.on("console-message", event => { if (event.level === "error") consoleErrors.push(event.message); });
    ipcMain.handle("file-smoke-open", event => { if (event.sender !== window.webContents) throw new Error("Invalid smoke sender"); return resources.open({ targetId: null, workspaceId: workspace.workspaceId, path: path.basename(target) }, event.sender.id); });
    const timer = setTimeout(() => { console.error("Electron file smoke timed out", consoleErrors, requests); resources.dispose(); window.destroy(); app.exit(1); }, 45000);
    ipcMain.handle("file-smoke-result", async (event, result) => {
      if (event.sender !== window.webContents) throw new Error("Invalid smoke sender");
      clearTimeout(timer);
      if (result.ok) await fs.writeFile(path.join(output, "office-pdf.png"), (await window.webContents.capturePage()).toPNG());
      await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ ...result, consoleErrors, requests }, null, 2));
      console.log(JSON.stringify({ ...result, consoleErrors, requests }));
      setTimeout(() => { resources.dispose(); window.destroy(); app.exit(result.ok && !consoleErrors.some(error => /Content Security Policy|Refused to/.test(error)) ? 0 : 1); }, 150);
      return true;
    });
    await window.loadFile(html);
  })().catch(error => { console.error(error); app.exit(1); });
}
