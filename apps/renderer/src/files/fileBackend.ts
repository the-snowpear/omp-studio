import type { StudioClient, WorkspaceFileInfo, WorkspaceFileText, WorkspaceFileWrite, WorkspaceFileSaveResult, SystemFileInfo, SystemFileSaveResult } from "@omp-studio/client-contract";
import { waitReceipt } from "../hostError";

/** workspaceId is empty for system files; source selects the service and buffer identity. */
export type FileBackendTarget = Pick<WorkspaceFileInfo, "workspaceId" | "path"> & { source?: "system" };
export type DocumentFileInfo = WorkspaceFileInfo & { source?: "system" };
export type DocumentFileText = Omit<WorkspaceFileText, "file"> & { file: DocumentFileInfo };
const systemInfo = (file: SystemFileInfo, target: FileBackendTarget): DocumentFileInfo => ({ ...file, workspaceId: target.workspaceId, source: "system" });

export async function inspectFileBackend(client: StudioClient, target: FileBackendTarget): Promise<DocumentFileInfo> {
  return target.source === "system" ? systemInfo(await client.query("fs.file.inspect", { path: target.path }), target)
    : client.query("workspace.file.inspect", { workspaceId: target.workspaceId, path: target.path });
}
export async function readFileBackend(client: StudioClient, target: FileBackendTarget): Promise<DocumentFileText> {
  if (target.source !== "system") return client.query("workspace.file.readText", { workspaceId: target.workspaceId, path: target.path });
  const value = await client.query("fs.file.readText", { path: target.path });
  return { ...value, file: systemInfo(value.file, target) };
}
export async function writeFileBackend(client: StudioClient, target: FileBackendTarget, input: Omit<WorkspaceFileWrite, "workspaceId" | "path">): Promise<WorkspaceFileSaveResult & { file: DocumentFileInfo }> {
  if (target.source === "system") {
    const handle = await client.command("fs.file.writeText", { path: target.path, ...input });
    const result = await waitReceipt<SystemFileSaveResult>(client, handle.requestId);
    return { ...result, file: systemInfo(result.file, target) };
  }
  const handle = await client.command("workspace.file.writeText", { workspaceId: target.workspaceId, path: target.path, ...input });
  return waitReceipt<WorkspaceFileSaveResult>(client, handle.requestId);
}
