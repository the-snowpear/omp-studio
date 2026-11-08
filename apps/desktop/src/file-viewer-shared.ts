import type { WorkspaceFileInfo } from "@omp-studio/client-contract";

export interface FileResourceTarget { targetId: string | null; workspaceId: string; path: string }
export interface FileResource { id: string; url: string; file: WorkspaceFileInfo }
export interface OfficeComponentState {
  id: "office-preview";
  status: "not-installed" | "ready" | "checking" | "downloading" | "installing" | "error";
  installedVersion?: string;
  availableVersion?: string;
  downloadBytes?: number;
  receivedBytes?: number;
  message?: string;
}
export interface FileViewerDesktopApi {
  open(input: FileResourceTarget): Promise<FileResource>;
  release(id: string): Promise<void>;
  export(input: FileResourceTarget): Promise<boolean>;
  officeState(check?: boolean): Promise<OfficeComponentState>;
  officeInstall(): Promise<OfficeComponentState>;
  officeCancel(): Promise<void>;
  officeUninstall(): Promise<OfficeComponentState>;
  officePreview(id: string): Promise<{ url: string }>;
  onOfficeState(listener: (state: OfficeComponentState) => void): () => void;
  setDirty(count: number): Promise<void>;
  onCloseRequested(listener: (id: string) => void): () => void;
  finishClose(id: string, allow: boolean): Promise<void>;
}
export const FILE_VIEWER_CHANNELS = {
  open: "omp-studio:files-open", release: "omp-studio:files-release", export: "omp-studio:files-export",
  officeState: "omp-studio:office-state", officeInstall: "omp-studio:office-install", officeCancel: "omp-studio:office-cancel",
  officeUninstall: "omp-studio:office-uninstall", officePreview: "omp-studio:office-preview", officeChanged: "omp-studio:office-changed",
  dirty: "omp-studio:files-dirty", closeRequested: "omp-studio:files-close-requested", finishClose: "omp-studio:files-finish-close",
} as const;
