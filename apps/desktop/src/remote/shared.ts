import type { ClientBootstrap, ClientCommandAccepted, ClientCommandRequest, ClientEvent, ClientQueryRequest, ClientQueryResponse, CommandName, QueryName, WorkspaceListReadModel } from "@omp-studio/client-contract";

export const REMOTE_CHANNELS = {
  installRuntime: "omp-studio:remote:install-runtime",
  list: "omp-studio:remote:list", save: "omp-studio:remote:save", remove: "omp-studio:remote:remove", connect: "omp-studio:remote:connect", disconnect: "omp-studio:remote:disconnect", select: "omp-studio:remote:select",
  bootstrap: "omp-studio:remote:bootstrap", query: "omp-studio:remote:query", command: "omp-studio:remote:command", directories: "omp-studio:remote:directories", register: "omp-studio:remote:register", event: "omp-studio:remote:event", changed: "omp-studio:remote:changed",
} as const;
export interface RemoteConnectionProfile { id: string; name: string; host: string; user?: string; port?: number; platform: "linux" | "win32" | "darwin"; authMode?: "agent" | "password"; }
export interface RemoteCredentials { password: string; }
export interface RemoteConnectionStatus {
  id: string;
  state: "disconnected" | "connecting" | "recovering" | "degraded" | "synchronizing" | "connected" | "failed";
  message?: string;
  arch?: string;
  generation?: number;
  attempt?: number;
  maxAttempts?: number;
  retryAt?: number;
  hostRestarted?: boolean;
  operation?: "installing-runtime";
}
export interface RemoteInventory { profiles: RemoteConnectionProfile[]; statuses: RemoteConnectionStatus[]; activeId?: string | null; }
export interface RemoteDirectoryList { path: string; parent: string; directories: { name: string; path: string }[]; }
export interface RemoteApi {
  list(): Promise<RemoteInventory>;
  save(profile: Omit<RemoteConnectionProfile, "id"> & { id?: string }): Promise<RemoteConnectionProfile>;
  remove(id: string): Promise<void>;
  connect(id: string, credentials?: RemoteCredentials): Promise<void>;
  installRuntime(id: string): Promise<{ installed: boolean }>;
  disconnect(id: string): Promise<void>;
  select(id: string | null): Promise<void>;
  bootstrap(id: string): Promise<ClientBootstrap>;
  query<T extends QueryName>(id: string, request: ClientQueryRequest<T>): Promise<ClientQueryResponse<T>>;
  command<T extends CommandName>(id: string, request: ClientCommandRequest<T>): Promise<ClientCommandAccepted<T>>;
  directories(id: string, path?: string): Promise<RemoteDirectoryList>;
  register(id: string, path: string): Promise<WorkspaceListReadModel>;
  onEvent(listener: (event: { id: string; generation: number; event: ClientEvent }) => void): () => void;
  onChanged(listener: () => void): () => void;
}
