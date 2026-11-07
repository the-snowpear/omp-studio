import type { StudioWebMcpCatalog, WebMcpInvokeResult } from "@omp-studio/studio-protocol";

export const PREVIEW_WEBMCP: StudioWebMcpCatalog = {
  pageId: "preview-page", documentId: "preview-document", status: "ready", truncated: false, untrusted: true, invocationAvailable: true,
  tools: [{ name: "search_docs", description: "搜索 Studio 使用说明", frameId: "main", origin: "http://localhost:4173", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, untrusted: true }],
};
export const PREVIEW_WEBMCP_RESULT: WebMcpInvokeResult = { ok: true, untrusted: true, result: { title: "浏览器 · 使用说明", section: "网页工具与控制权", matches: 3 } };
