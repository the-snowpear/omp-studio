import type { ArtifactKind, ArtifactRecord, ArtifactStorageState } from "@omp-studio/studio-protocol";

export const CHROME_ARTIFACT_CHANNELS = {
  chooseDirectory: "omp-studio:desktop:artifacts-directory",
  import: "omp-studio:desktop:artifacts-import",
  export: "omp-studio:desktop:artifacts-export",
} as const;
export type ArtifactFileResult = { ok: true; cancelled: boolean; artifact?: ArtifactRecord; storage?: ArtifactStorageState } | { ok: false; message: string };
export interface ArtifactImportInput { kind: ArtifactKind; sessionId?: string; workspaceId?: string }
export interface ArtifactDesktopApi {
  chooseArtifactDirectory(): Promise<ArtifactFileResult>;
  importArtifact(input: ArtifactImportInput): Promise<ArtifactFileResult>;
  exportArtifact(input: { artifactId: string }): Promise<ArtifactFileResult>;
}
