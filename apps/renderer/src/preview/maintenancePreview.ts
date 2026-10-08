import type {
  GcCategory,
  GcPreview,
  SessionExportResult,
  NativeConnectionCheck,
} from "@omp-studio/studio-protocol";
export function previewGc(categories: GcCategory[]): GcPreview {
  return {
    token: "demo-cleanup",
    expiresAt: Date.now() + 300000,
    summary: {
      applied: false,
      checkedAt: Date.now(),
      policy: {
        coldDays: 30,
        keepGlobal: 20,
        keepPerWorkspace: 10,
        staleDays: 30,
        staleKeep: 20,
      },
      rows: categories.map((category) => ({
        category,
        candidates:
          category === "blobs"
            ? 12
            : category === "archive"
              ? 3
              : category === "wal"
                ? 2
                : 4,
        changed: 0,
        bytes: category === "archive" ? 0 : 4194304,
        skippedActive: category === "archive" ? 2 : 0,
      })),
      errors: [],
    },
  };
}
export const PREVIEW_SESSION_EXPORT: SessionExportResult = {
 format:"html",members:1,warnings:[],
  id: "ddee1111-2222-4333-8444-555566667777",
  createdAt: Date.parse("2026-10-08T02:00:00.000Z"),
  asset: {
    artifactId: "aaaa1111-2222-4333-8444-555566667777",
    kind: "export",
    name: "omp-session-example.html",
    mimeType: "text/html",
    bytes: 426000,
    sha256: "0".repeat(64),
  },
};
export function previewConnectionCheck(): NativeConnectionCheck {
  return {
    checkedAt: Date.now(),
    checks: [
      { id: "bridge", status: "ok", detail: "Studio Bridge" },
      { id: "session", status: "ok", detail: "demo-session" },
      { id: "model", status: "warning", detail: "example/retired-model" },
    ],
  };
}

export function previewSessionExport(format:"archive"|"html"):SessionExportResult{return {...PREVIEW_SESSION_EXPORT,format,members:format==="archive"?4:1,asset:{...PREVIEW_SESSION_EXPORT.asset,name:format==="archive"?"omp-session-example.zip":"omp-session-example.html",mimeType:format==="archive"?"application/zip":"text/html"}};}
