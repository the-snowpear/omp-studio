import type { WorkspaceId } from "./ids.js";

export interface WorkspaceFileTarget { readonly workspaceId: WorkspaceId; readonly path: string }
/**
 * Batched existence probe for path-like text in transcripts. Relative paths
 * resolve inside the workspace; absolute paths resolve through the system file
 * service. Only paths a Host service actually classified are reported back —
 * an unclassified path stays an ordinary link instead of a false negative.
 */
export interface WorkspacePathResolveInput {
  readonly workspaceId: WorkspaceId;
  readonly paths: readonly string[];
  /** Follow deferred paths when the user activates a link. */
  readonly explicit?: boolean;
}
export type WorkspacePathKind = "file" | "directory" | "missing";
export interface WorkspacePathResolution { readonly path: string; readonly kind: WorkspacePathKind }
export interface WorkspacePathResolveResult { readonly resolutions: readonly WorkspacePathResolution[] }
/** System paths belong to the selected Host, including references relative to that Host's home. */
export function isSystemFilePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]|~(?:[\\/]|$)|file:)/i.test(path);
}
export type FileEncoding = "utf8" | "utf16le" | "utf16be";
export interface WorkspaceFileInfo extends WorkspaceFileTarget {
  /** Canonical identity within this Host; qualify with the connection in the UI. */
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly version: string;
  readonly writable: boolean;
}
export interface WorkspaceFileText {
  readonly file: WorkspaceFileInfo;
  readonly text: string;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly lineEnding: "lf" | "crlf";
}
export interface WorkspaceFileChunkInput extends WorkspaceFileTarget {
  readonly version: string;
  readonly offset: number;
  readonly length: number;
}
/** Bounded chunks also work over the authenticated SSH transport. */
export interface WorkspaceFileChunk { readonly data: string; readonly bytes: number }
export interface WorkspaceFileWrite extends WorkspaceFileTarget {
  readonly text: string;
  readonly expectedVersion: string;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly lineEnding: "lf" | "crlf";
}
export type WorkspaceFileSaveResult =
  | { readonly saved: true; readonly file: WorkspaceFileInfo }
  | { readonly saved: false; readonly conflict: true; readonly file: WorkspaceFileInfo };
