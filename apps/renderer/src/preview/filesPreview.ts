import type { WorkspaceFileInfo, WorkspaceFileText } from "@omp-studio/client-contract";
import workbookUrl from "./fileAssets/usage.xlsx?url";
import legacyWorkbookUrl from "./fileAssets/usage.xls?url";

const CSV = "Model,Requests,Tokens\nClaude,128,52400\nGPT,96,41800\nGemini,64,28700\n";
const README = "# OMP Studio\n\n直接在工作台阅读和编辑项目文件。\n\n## 文件窗口\n\n- 文件树单击打开\n- 拖动标题栏停靠\n- Ctrl / Cmd + S 保存文本\n\n[查看数据](./usage.csv)\n\n```ts\nconst workspace = 'OMP Studio';\nconsole.log(workspace);\n```\n";
export function previewFile(path: string, workspaceId: string): WorkspaceFileInfo {
  path = path.replaceAll("\\", "/").split("/").reduce<string[]>((parts, part) => { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); return parts; }, []).join("/");
  return { workspaceId: workspaceId as WorkspaceFileInfo["workspaceId"], path, id: `preview:${path}`, name: path.split(/[\\/]/).pop() ?? path, size: README.length, version: "demo-1", mime: "text/plain", writable: true };
}
export function previewFileText(file: WorkspaceFileInfo): WorkspaceFileText {
  const text = /\.[ct]sv$/i.test(file.name) ? CSV : /\.md$/i.test(file.name) ? README : /\.json$/i.test(file.name) ? '{\n  "name": "omp-studio",\n  "private": true\n}\n' : "// OMP Studio\nexport function hello(name: string) {\n  return `Hello, ${name}`;\n}\n";
  return { file, text, encoding: "utf8", bom: false, lineEnding: "lf" };
}
/** Demo working-tree patches so the Git gutter and Diff view have something to show; other files read as clean. */
export function previewFilePatch(path: string): string {
  const name = path.replaceAll("\\", "/");
  if (/(^|\/)main\.ts$/i.test(name)) return [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1,5 +1,4 @@", " // OMP Studio", "-export function hello(name) {", "+export function hello(name: string) {", "   return `Hello, ${name}`;", " }", "-// TODO: type the argument", ""].join("\n");
  if (/\.md$/i.test(name)) return [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -5,4 +5,5 @@", " ## 文件窗口", " ", " - 文件树单击打开", " - 拖动标题栏停靠", "+- Ctrl / Cmd + S 保存文本", ""].join("\n");
  return "";
}
export const PREVIEW_OFFICE_COMPONENT = { id: "office-preview" as const, status: "not-installed" as const, availableVersion: "26.8.2", downloadBytes: 350 * 1024 * 1024 };
let officeInstalled = false;
const officeListeners = new Set<() => void>();
export const previewOfficeState = () => ({ ...PREVIEW_OFFICE_COMPONENT, status: officeInstalled ? "ready" as const : "not-installed" as const, ...(officeInstalled ? { installedVersion: PREVIEW_OFFICE_COMPONENT.availableVersion } : {}) });
export function setPreviewOfficeInstalled(value: boolean) { officeInstalled = value; for (const listener of officeListeners) listener(); }
export function subscribePreviewOffice(listener: () => void) { officeListeners.add(listener); return () => { officeListeners.delete(listener); }; }
export async function previewFileBlob(file: WorkspaceFileInfo): Promise<Blob | null> {
  if (/\.[ct]sv$/i.test(file.name)) return new Blob([CSV], { type: "text/csv" });
  if (/\.(png|jpg|jpeg|gif|webp|svg|avif|bmp)$/i.test(file.name)) return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#172c43"/><circle cx="480" cy="260" r="140" fill="#72cbb4"/><text x="480" y="480" text-anchor="middle" fill="white" font-size="44" font-family="sans-serif">OMP Studio</text></svg>'], { type: "image/svg+xml" });
  if (/\.pdf$/i.test(file.name)) return previewPdf();
  if (/\.xlsx?$/i.test(file.name)) {
    const response = await fetch(/\.xls$/i.test(file.name) ? legacyWorkbookUrl : workbookUrl);
    return response.blob();
  }
  if (/\.(wav|mp3|ogg|flac|m4a|aac|opus)$/i.test(file.name)) {
    const bytes = new Uint8Array(44 + 16000 * 2), view = new DataView(bytes.buffer);
    const word = (offset: number, value: string) => [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
    word(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); word(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, "data"); view.setUint32(40, bytes.length - 44, true);
    for (let index = 0; index < 16000; index++) view.setInt16(44 + index * 2, Math.sin(index / 16000 * 440 * Math.PI * 2) * 1400, true);
    return new Blob([bytes], { type: "audio/wav" });
  }
  if (/\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/i.test(file.name) && typeof MediaRecorder !== "undefined") {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext("2d")!; context.fillStyle = "#172c43"; context.fillRect(0, 0, 640, 360);
    const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks: BlobPart[] = [];
    return new Promise(resolve => {
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); resolve(new Blob(chunks, { type: "video/webm" })); };
      recorder.start(); track.requestFrame(); let frame = 0;
      const timer = setInterval(() => { context.fillStyle = "#172c43"; context.fillRect(0, 0, 640, 360); context.fillStyle = "#72cbb4"; context.beginPath(); context.arc(140 + frame * 8, 150, 55, 0, Math.PI * 2); context.fill(); context.fillStyle = "white"; context.font = "28px sans-serif"; context.fillText("OMP Studio", 220, 290); track.requestFrame(); if (++frame === 40) { clearInterval(timer); recorder.stop(); } }, 50);
    });
  }
  return null;
}
function previewPdf(): Blob {
  const stream = (text: string) => `BT /F1 24 Tf 60 720 Td (${text}) Tj ET`;
  const first = stream("OMP Studio - File viewer"), second = stream("Searchable document - Page 2");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>", `<< /Length ${first.length} >>\nstream\n${first}\nendstream`, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>", `<< /Length ${second.length} >>\nstream\n${second}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let result = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(result.length); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = result.length;
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([result], { type: "application/pdf" });
}
