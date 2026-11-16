import type { WorkspaceId } from "./ids.js";
import type { WorkspaceFileChunkInput, WorkspaceFileInfo, WorkspaceFileText, WorkspaceFileWrite } from "./files.js";

/** User-selected absolute paths are confined to the Host-owned fs.* service. */
export interface SystemFileTarget { readonly path: string }
export type SystemFileInfo = Omit<WorkspaceFileInfo, "workspaceId">;
export interface SystemFileText extends Omit<WorkspaceFileText, "file"> { readonly file: SystemFileInfo }
export type SystemFileChunkInput = Omit<WorkspaceFileChunkInput, "workspaceId">;
export type SystemFileWrite = Omit<WorkspaceFileWrite, "workspaceId">;
export type SystemFileSaveResult =
  | { readonly saved: true; readonly file: SystemFileInfo }
  | { readonly saved: false; readonly conflict: true; readonly file: SystemFileInfo };

export type SystemQuickKind = "home" | "desktop" | "downloads" | "documents" | "pictures";
export interface SystemPlaces {
  readonly platform: "win32" | "darwin" | "linux";
  readonly separator: "\\" | "/";
  readonly home: string;
  readonly quick: readonly { readonly kind: SystemQuickKind; readonly label: string; readonly path: string }[];
  readonly volumes: readonly { readonly path: string; readonly label: string; readonly totalBytes?: number; readonly freeBytes?: number; readonly ready: boolean }[];
  readonly trash: boolean;
}
export interface SystemEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir";
  readonly link?: boolean;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly hidden: boolean;
  readonly denied?: boolean;
}
export type SystemListInput =
  | { readonly path: string; readonly showHidden?: boolean; readonly workspaceId?: never }
  | { readonly workspaceId: WorkspaceId; readonly path?: string; readonly showHidden?: boolean };
export interface SystemDirectory {
  readonly path: string;
  readonly parent: string | null;
  readonly segments: readonly { readonly path: string; readonly label: string }[];
  readonly entries: readonly SystemEntry[];
  readonly truncated: boolean;
  readonly workspace?: { readonly workspaceId: WorkspaceId; readonly relativePath: string };
}
export interface SystemFileMutationResult { readonly path: string }
