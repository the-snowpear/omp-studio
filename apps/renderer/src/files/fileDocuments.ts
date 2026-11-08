import type { StudioClient, WorkspaceFileInfo, WorkspaceFileText, WorkspaceFileSaveResult } from "@omp-studio/client-contract";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { previewFile, previewFileText } from "../preview/filesPreview";

/** Persisted identity is enough to reopen a view; size, version and permissions stay unknown until read. */
export type FileDocumentIdentity = Pick<WorkspaceFileInfo, "workspaceId" | "path" | "id" | "name"> & Partial<Pick<WorkspaceFileInfo, "mime" | "size" | "version" | "writable">>;

export interface FileDocumentSnapshot {
  file: FileDocumentIdentity; text: string; baseline: string; loaded: boolean; loading: boolean; saving: boolean;
  dirty: boolean; error: string; external?: WorkspaceFileInfo | undefined; diskText?: string | undefined;
  /** Encoding and line endings of the last read; saves write them back unchanged. */
  format: TextFormat;
}
export type TextFormat = Pick<WorkspaceFileText, "encoding" | "bom" | "lineEnding">;
export class FileDocument {
  private state: FileDocumentSnapshot;
  private listeners = new Set<() => void>();
  private format: TextFormat = { encoding: "utf8", bom: false, lineEnding: "lf" };
  private refreshing = false;
  private pendingSave: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private visible = new Set<string>();
  private closedViews = new Set<string>();
  constructor(file: FileDocumentIdentity, public client: () => Promise<StudioClient>, readonly preview = false) {
    this.state = { file, text: "", baseline: "", loaded: false, loading: false, saving: false, dirty: false, error: "", format: this.format };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<FileDocumentSnapshot>) { const wasDirty = this.state.dirty; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); if (wasDirty !== this.state.dirty) for (const listener of dirtyListeners) listener(); }
  edit(text: string) { this.patch({ text, dirty: text !== this.state.baseline }); }
  async load(discard = false): Promise<void> {
    if (this.state.loading || this.state.dirty && !discard) return;
    this.patch({ loading: true, error: "" });
    try {
      const value = this.preview ? previewFileText(previewFile(this.state.file.path, this.state.file.workspaceId)) : await (await this.client()).query("workspace.file.readText", this.state.file);
      this.format = { encoding: value.encoding, bom: value.bom, lineEnding: value.lineEnding };
      // A background read must never replace typing that began while it was in flight.
      if (!discard && this.state.dirty) { this.patch({ external: value.file }); return; }
      this.patch({ file: value.file, text: value.text, baseline: value.text, loaded: true, dirty: false, external: undefined, diskText: undefined, format: this.format });
    } catch (error) { this.patch({ error: message(error) }); }
    finally { this.patch({ loading: false }); }
  }
  async refresh(): Promise<void> {
    if (this.preview || this.refreshing || this.state.loading || this.state.saving) return;
    this.refreshing = true;
    try {
      if (this.pendingSave !== undefined) {
        const pending = this.pendingSave;
        const disk = await (await this.client()).query("workspace.file.readText", this.state.file);
        this.pendingSave = undefined;
        if (disk.text === pending) { this.patch({ file: disk.file, baseline: pending, dirty: this.state.text !== pending, external: undefined, error: "" }); return; }
        if (disk.file.version !== this.state.file.version) this.patch({ external: disk.file });
      }
      const file = await (await this.client()).query("workspace.file.inspect", this.state.file);
      if (file.version !== this.state.file.version) {
        if (this.state.dirty) this.patch({ external: file });
        else if (this.state.loaded) await this.load();
        else this.patch({ file });
      }
    } catch (error) { this.patch({ error: message(error) }); }
    finally { this.refreshing = false; }
  }
  setVisible(id: string, visible: boolean) {
    if (visible) this.visible.add(id); else this.visible.delete(id);
    if (this.visible.size && !this.timer && !this.preview) this.timer = setInterval(() => { void this.refresh(); }, 4000);
    if (!this.visible.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  async compare() {
    try { const value = this.preview ? previewFileText(previewFile(this.state.file.path, this.state.file.workspaceId)) : await (await this.client()).query("workspace.file.readText", this.state.file); this.patch({ external: value.file, diskText: value.text }); }
    catch (error) { this.patch({ error: message(error) }); }
  }
  async save(overwrite = false): Promise<boolean> {
    if (this.pendingSave !== undefined && !this.state.saving) { await this.refresh(); if (this.pendingSave !== undefined) return false; }
    if (!this.state.dirty) return true;
    if (this.state.saving || !this.state.loaded || !this.state.file.version) return false;
    const text = this.state.text;
    this.patch({ saving: true, error: "" });
    try {
      if (this.preview) { this.patch({ baseline: text, dirty: this.state.text !== text }); return true; }
      const client = await this.client();
      const expectedVersion = overwrite && this.state.external ? this.state.external.version : this.state.file.version;
      this.pendingSave = text;
      const handle = await client.command("workspace.file.writeText", { workspaceId: this.state.file.workspaceId, path: this.state.file.path, text, expectedVersion, ...this.format });
      const result = await waitReceipt<WorkspaceFileSaveResult>(client, handle.requestId);
      this.pendingSave = undefined;
      if (!result.saved) { this.patch({ external: result.file }); return false; }
      this.patch({ file: result.file, baseline: text, dirty: this.state.text !== text, external: undefined, diskText: undefined });
      return true;
    } catch (error) {
      // A lost SSH acknowledgement is resolved by reading, never by replaying the write.
      try {
        const disk = await (await this.client()).query("workspace.file.readText", this.state.file);
        this.pendingSave = undefined;
        if (disk.text === text) { this.patch({ file: disk.file, baseline: text, dirty: this.state.text !== text, external: undefined }); return true; }
        if (disk.file.version !== this.state.file.version) this.patch({ external: disk.file });
      } catch { /* Keep the draft while the connection is unavailable. */ }
      this.patch({ error: message(error) }); return false;
    } finally { this.patch({ saving: false }); }
  }
  discard() { this.pendingSave = undefined; this.patch({ text: this.state.baseline, dirty: false, external: undefined, diskText: undefined }); }
  hideComparison() { this.patch({ diskText: undefined }); }
  closeView(id: string) { this.closedViews.add(id); }
  isViewClosed(id: string) { return this.closedViews.has(id); }
  dispose() { clearInterval(this.timer); this.listeners.clear(); }
}
const message = (error: unknown) => hostErrorMessage(error, "无法读取或保存文件");
const documents = new Map<string, FileDocument>();
const dirtyListeners = new Set<() => void>();
export function subscribeDirtyFiles(listener: () => void) { dirtyListeners.add(listener); return () => { dirtyListeners.delete(listener); }; }
export function fileDocumentKey(target: string | null, file: FileDocumentIdentity, preview: boolean) { return JSON.stringify([preview, target, file.workspaceId, file.id]); }
export function getFileDocument(target: string | null, file: FileDocumentIdentity, client: () => Promise<StudioClient>, preview: boolean): FileDocument {
  const key = fileDocumentKey(target, file, preview);
  let value = documents.get(key);
  if (!value) for (const [storedKey, document] of documents) {
    const [mode, source, workspace] = JSON.parse(storedKey) as [boolean, string | null, string];
    if (mode === preview && source === target && workspace === file.workspaceId && document.getSnapshot().file.id === file.id) { value = document; documents.set(key, value); break; }
  }
  if (!value) { value = new FileDocument(file, client, preview); documents.set(key, value); }
  else value.client = client;
  return value;
}
export function dirtyFileDocuments() { return [...documents.values()].filter(item => !item.preview && item.getSnapshot().dirty); }
export function releaseFileDocument(document: FileDocument) {
  if (document.getSnapshot().dirty) return;
  for (const [key, value] of documents) if (value === document) { documents.delete(key); document.dispose(); }
}
