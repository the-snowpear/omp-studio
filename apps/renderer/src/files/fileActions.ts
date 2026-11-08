import type { FileMenuAction, FileMenuTarget, FileOpenerOption } from "../menus";

/** Shell and Composer actions the workbench lends to file windows; absent in harnesses, where the items stay disabled. */
export interface FileViewerActions {
  /** Installed editors for 「打开方式」; local files only. */
  openers: readonly FileOpenerOption[];
  runShell(workspaceId: string, action: FileMenuAction, target: FileMenuTarget): void;
  /** Inserts a file capsule into the main Composer; `lines` follows it as an inclusive `L3-L8` range. */
  addContext(input: { path: string; label: string; lines?: readonly [number, number] | undefined }): void;
}
