import type { PortableExport, SessionImportPreview } from "@omp-studio/studio-protocol";
export const PREVIEW_TRANSFER_SESSIONS = [
  { sessionId: "sess-7c2e91", title: "消息队列恢复与附件验证" },
  { sessionId: "sess-4a8f20", title: "浏览器观察与人工接管" },
];
export function previewTransferImport(): SessionImportPreview {
  return { token: "00000000-0000-4000-8000-000000000001", expiresAt: Date.now() + 300000, sourceSessionId: "sess-7c2e91", title: "消息队列恢复与附件验证", sourceDirectory: "本地来源 / Local source", destinationDirectory: "演示工作区 / Demo workspace", upstreamVersion: "18.10.4", messages: 48, artifacts: 6, blobs: 3, conflicts: true };
}
export function previewTransferExport(format: "pack" | "anonymous"): PortableExport {
  return { id: "00000000-0000-4000-8000-000000000002", format, members: format === "pack" ? 11 : 4, warnings: [], asset: { artifactId: "00000000-0000-4000-8000-000000000003", kind: "export", name: format === "pack" ? "omp-session.tar" : "omp-anonymous.zip", mimeType: format === "pack" ? "application/x-tar" : "application/zip", bytes: 482304, sha256: "0".repeat(64) } };
}
