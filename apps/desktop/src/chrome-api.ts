import { SKILLSHARE_TOKEN_CHANNEL, type SkillshareTokenReveal } from "./chrome-skillshare-shared.js";
import { LIVE_AUDIO_CHANNELS, type LiveAudioAttach, type LiveAudioChunk, type LiveAudioResult } from "./live-audio-shared.js";
import { CHROME_SERVICE_CHANNELS, type ServiceDefinitionResult, type ServiceDefinitionsInput } from "./chrome-services-shared.js";
import { PAYLOAD_HEALTH_CHANNEL, type PayloadHealthStatus } from "./payload-health-shared.js";
import { CHROME_ARTIFACT_CHANNELS, type ArtifactFileResult, type ArtifactImportInput } from "./chrome-artifacts-shared.js";
import { TITLEBAR_OVERLAY_CHANNEL } from "./titlebar-overlay-shared.js";
import { CHROME_PERFORMANCE_CHANNEL } from "./chrome-performance-shared.js";
import type { MemorySample } from "@omp-studio/studio-protocol";
import { CONVERSATION_VIEW_CHANNEL, type ConversationViewState } from "./conversation-views.js";
import { CHROME_NOTIFY_CHANNEL } from "./chrome-notify-shared.js";
import { CHROME_OPEN_URL_CHANNEL } from "./chrome-open-url-shared.js";
import {
  CHROME_LOGS_CHANNELS,
  type ChromeLogsResult,
} from "./chrome-logs-shared.js";
import {
  CHROME_METRICS_CHANNELS,
  type ProcessMemorySample,
} from "./chrome-metrics-shared.js";
import {
  CHROME_IMAGE_CHANNELS,
  type ChromeImageInput,
  type ChromeImageResult,
} from "./chrome-image-shared.js";
import {
  CHROME_PROFILE_CHANNELS,
  type ChromeAvatarBytes,
  type ChromeAvatarSaveResult,
} from "./chrome-profile-shared.js";
import {
  CHROME_APP_UPDATE_CHANNELS,
  type AppUpdateInfo,
} from "./chrome-app-update-shared.js";
import {
  WORKSPACE_SHELL_IPC_CHANNELS,
  type FileOpenWithInput,
  type FileOpener,
  type PlanSavePathPickResult,
  type ResolvedDroppedPath,
  type WorkspaceFileActionResult,
  type WorkspaceFileTargetInput,
  type WorkspaceShellEditorResult,
} from "./workspace-shell-shared.js";
import {
  CHROME_UPDATES_CHANNELS,
  type ChromeUpdatesImportInput,
  type ChromeUpdatesPrefsSetInput,
  type UpdateApplyResult,
  type UpdateCheckResult,
  type UpdateImportResult,
  type UpdateProgressEvent,
  type UpdateStartResult,
} from "./chrome-updates-shared.js";
import type { UpdatePrefs } from "./update-prefs-store.js";
import { MEDIA_UPLOAD_CHANNELS, type MediaUploadInput, type MediaUploadResult } from "./media-upload-shared.js";

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

export interface WebUtilsLike {
  getPathForFile(file: File): string;
}

export function subscribeChannel<T>(
  ipc: IpcRendererLike,
  channel: string,
  listener: (payload: T) => void,
): () => void {
  const wrapped = (_event: unknown, payload: unknown): void => {
    listener(payload as T);
  };
  ipc.on(channel, wrapped);
  return () => {
    ipc.removeListener(channel, wrapped);
  };
}

export function createOmpStudioChromeApi(ipcRenderer: IpcRendererLike, webUtils?: WebUtilsLike) {
  return Object.freeze({
    revealSkillshareToken(input: { secretId: string; sessionId: string }): Promise<SkillshareTokenReveal> { return ipcRenderer.invoke(SKILLSHARE_TOKEN_CHANNEL, input) as Promise<SkillshareTokenReveal>; },
    attachLiveAudio(input: LiveAudioAttach): Promise<LiveAudioResult> { return ipcRenderer.invoke(LIVE_AUDIO_CHANNELS.attach, input) as Promise<LiveAudioResult>; },
    appendLiveAudio(input: LiveAudioChunk): Promise<LiveAudioResult> { return ipcRenderer.invoke(LIVE_AUDIO_CHANNELS.chunk, input) as Promise<LiveAudioResult>; },
    detachLiveAudio(input: { audioId: string }): Promise<LiveAudioResult> { return ipcRenderer.invoke(LIVE_AUDIO_CHANNELS.detach, input) as Promise<LiveAudioResult>; },
    beginMediaUpload(input: MediaUploadInput): Promise<MediaUploadResult> { return ipcRenderer.invoke(MEDIA_UPLOAD_CHANNELS.begin, input) as Promise<MediaUploadResult>; },
    appendMediaUpload(input: { uploadId: string; sequence: number; bytes: ArrayBuffer }): Promise<MediaUploadResult> { return ipcRenderer.invoke(MEDIA_UPLOAD_CHANNELS.chunk, input) as Promise<MediaUploadResult>; },
    finishMediaUpload(input: { uploadId: string }): Promise<MediaUploadResult> { return ipcRenderer.invoke(MEDIA_UPLOAD_CHANNELS.finish, input) as Promise<MediaUploadResult>; },
    abortMediaUpload(input: { uploadId: string }): Promise<MediaUploadResult> { return ipcRenderer.invoke(MEDIA_UPLOAD_CHANNELS.abort, input) as Promise<MediaUploadResult>; },
    listServiceDefinitions(input: ServiceDefinitionsInput): Promise<ServiceDefinitionResult> { return ipcRenderer.invoke(CHROME_SERVICE_CHANNELS.list, input) as Promise<ServiceDefinitionResult>; },
    saveServiceDefinition(input: ServiceDefinitionsInput): Promise<ServiceDefinitionResult> { return ipcRenderer.invoke(CHROME_SERVICE_CHANNELS.save, input) as Promise<ServiceDefinitionResult>; },
    removeServiceDefinition(input: ServiceDefinitionsInput): Promise<ServiceDefinitionResult> { return ipcRenderer.invoke(CHROME_SERVICE_CHANNELS.remove, input) as Promise<ServiceDefinitionResult>; },
    chooseArtifactDirectory(): Promise<ArtifactFileResult> {
      return ipcRenderer.invoke(CHROME_ARTIFACT_CHANNELS.chooseDirectory, {}) as Promise<ArtifactFileResult>;
    },
    importArtifact(input: ArtifactImportInput): Promise<ArtifactFileResult> {
      return ipcRenderer.invoke(CHROME_ARTIFACT_CHANNELS.import, input) as Promise<ArtifactFileResult>;
    },
    exportArtifact(input: { artifactId: string }): Promise<ArtifactFileResult> {
      return ipcRenderer.invoke(CHROME_ARTIFACT_CHANNELS.export, input) as Promise<ArtifactFileResult>;
    },
    setConversationViewState(state: ConversationViewState): Promise<boolean> {
      return ipcRenderer.invoke(CONVERSATION_VIEW_CHANNEL, state) as Promise<boolean>;
    },
    reportPerformanceSample(sample: MemorySample): Promise<boolean> {
      return ipcRenderer.invoke(CHROME_PERFORMANCE_CHANNEL, sample) as Promise<boolean>;
    },
    setTheme(theme: "light" | "dark"): Promise<void> {
      if (theme !== "light" && theme !== "dark") return Promise.resolve();
      return ipcRenderer.invoke(TITLEBAR_OVERLAY_CHANNEL, { theme }) as Promise<void>;
    },
    notify(payload: { title: string; body?: string }): Promise<void> {
      return ipcRenderer.invoke(CHROME_NOTIFY_CHANNEL, payload) as Promise<void>;
    },
    openUrl(payload: { url: string }): Promise<void> {
      return ipcRenderer.invoke(CHROME_OPEN_URL_CHANNEL, payload) as Promise<void>;
    },
    openLogDir(): Promise<ChromeLogsResult> {
      return ipcRenderer.invoke(CHROME_LOGS_CHANNELS.openDir, {}) as Promise<ChromeLogsResult>;
    },
    exportLogs(): Promise<ChromeLogsResult> {
      return ipcRenderer.invoke(CHROME_LOGS_CHANNELS.exportLogs, {}) as Promise<ChromeLogsResult>;
    },
    sampleProcessMemory(): Promise<ProcessMemorySample | null> {
      return ipcRenderer.invoke(CHROME_METRICS_CHANNELS.sample, {}) as Promise<ProcessMemorySample | null>;
    },
    saveAvatar(input: ChromeAvatarBytes): Promise<ChromeAvatarSaveResult | { ok: false; message: string }> {
      return ipcRenderer.invoke(CHROME_PROFILE_CHANNELS.saveAvatar, input) as Promise<
        ChromeAvatarSaveResult | { ok: false; message: string }
      >;
    },
    loadAvatar(): Promise<ChromeAvatarBytes | null> {
      return ipcRenderer.invoke(CHROME_PROFILE_CHANNELS.loadAvatar) as Promise<ChromeAvatarBytes | null>;
    },
    clearAvatar(): Promise<void> {
      return ipcRenderer.invoke(CHROME_PROFILE_CHANNELS.clearAvatar) as Promise<void>;
    },
    openProjectInEditor(workspaceId: string): Promise<WorkspaceShellEditorResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor, { workspaceId }) as Promise<WorkspaceShellEditorResult>;
    },
    openProjectDirectory(workspaceId: string): Promise<void> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager, { workspaceId }) as Promise<void>;
    },
    getPathForFile(file: File): string | null {
      try {
        const path = webUtils?.getPathForFile(file);
        return typeof path === "string" && path.length > 0 ? path : null;
      } catch {
        return null;
      }
    },
    resolveDroppedPaths(workspaceId: string, paths: readonly string[]): Promise<ReadonlyArray<ResolvedDroppedPath>> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths, {
        workspaceId,
        paths,
      }) as Promise<ReadonlyArray<ResolvedDroppedPath>>;
    },
    pickPlanSavePath(input: { workspaceId: string }): Promise<PlanSavePathPickResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.pickPlanSavePath, input) as Promise<PlanSavePathPickResult>;
    },
    openFile(input: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpen, input) as Promise<WorkspaceFileActionResult>;
    },
    openFileWith(input: FileOpenWithInput): Promise<WorkspaceFileActionResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpenWith, input) as Promise<WorkspaceFileActionResult>;
    },
    revealFileInFileManager(input: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileReveal, input) as Promise<WorkspaceFileActionResult>;
    },
    resolveFileAbsolutePath(input: WorkspaceFileTargetInput): Promise<string> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileAbsolutePath, input) as Promise<string>;
    },
    listFileOpeners(input: { workspaceId: string }): Promise<ReadonlyArray<FileOpener>> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpeners, input) as Promise<ReadonlyArray<FileOpener>>;
    },
    copyImage(input: Pick<ChromeImageInput, "mime" | "bytes">): Promise<ChromeImageResult> {
      return ipcRenderer.invoke(CHROME_IMAGE_CHANNELS.copyImage, input) as Promise<ChromeImageResult>;
    },
    saveImage(input: ChromeImageInput): Promise<ChromeImageResult> {
      return ipcRenderer.invoke(CHROME_IMAGE_CHANNELS.saveImage, input) as Promise<ChromeImageResult>;
    },
    reportPayloadHealth(status: PayloadHealthStatus): Promise<boolean> {
      return ipcRenderer.invoke(PAYLOAD_HEALTH_CHANNEL, status) as Promise<boolean>;
    },
    checkAppUpdate(): Promise<AppUpdateInfo | null> {
      return ipcRenderer.invoke(CHROME_APP_UPDATE_CHANNELS.check) as Promise<AppUpdateInfo | null>;
    },
    getUpdateSnapshot(): Promise<import("@omp-studio/runtime-installer").UnifiedUpdateSnapshot | null> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.snapshot) as Promise<import("@omp-studio/runtime-installer").UnifiedUpdateSnapshot | null>;
    },
    prepareUpdates(target: "all" | "app" | "runtime"): Promise<import("@omp-studio/runtime-installer").UnifiedUpdateSnapshot> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.prepare, target) as Promise<import("@omp-studio/runtime-installer").UnifiedUpdateSnapshot>;
    },
    subscribeUpdates(listener: (snapshot: import("@omp-studio/runtime-installer").UnifiedUpdateSnapshot) => void): () => void {
      return subscribeChannel(ipcRenderer, CHROME_UPDATES_CHANNELS.changed, listener);
    },
    checkUpdates(): Promise<UpdateCheckResult | null> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.check) as Promise<UpdateCheckResult | null>;
    },
    getAppVersion(): Promise<{ version: string; bundledVersion: string; payloadVersion?: string }> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.versionGet) as Promise<{ version: string; bundledVersion: string; payloadVersion?: string }>;
    },
    importLocalUpdate(input: ChromeUpdatesImportInput): Promise<UpdateImportResult> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.importLocal, input) as Promise<UpdateImportResult>;
    },
    cancelUpdate(jobId: string): Promise<void> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.cancel, { jobId }) as Promise<void>;
    },
    getUpdatePrefs(): Promise<UpdatePrefs | null> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.prefsGet) as Promise<UpdatePrefs | null>;
    },
    setUpdatePrefs(patch: ChromeUpdatesPrefsSetInput): Promise<UpdatePrefs | null> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.prefsSet, patch) as Promise<UpdatePrefs | null>;
    },
    startApp(): Promise<UpdateStartResult> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.startApp) as Promise<UpdateStartResult>;
    },
    startRuntime(): Promise<UpdateStartResult> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.startRuntime) as Promise<UpdateStartResult>;
    },
    applyUpdate(): Promise<UpdateApplyResult> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.apply) as Promise<UpdateApplyResult>;
    },
    rollbackUpdate(): Promise<UpdateApplyResult> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.rollback) as Promise<UpdateApplyResult>;
    },
    rollbackRuntimeUpdate(): Promise<UpdateApplyResult> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.rollbackRuntime) as Promise<UpdateApplyResult>;
    },
    pruneRuntimeUpdates(): Promise<UpdateApplyResult> {
      return ipcRenderer.invoke(CHROME_UPDATES_CHANNELS.pruneRuntime) as Promise<UpdateApplyResult>;
    },
    subscribeUpdateProgress(listener: (e: UpdateProgressEvent) => void): () => void {
      return subscribeChannel<UpdateProgressEvent>(ipcRenderer, CHROME_UPDATES_CHANNELS.progress, listener);
    },
  });
}

export type OmpStudioChromeApi = ReturnType<typeof createOmpStudioChromeApi>;
