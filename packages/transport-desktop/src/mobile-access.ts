import type { WorkspaceId } from "@omp-studio/client-contract";

export const MOBILE_ACCESS_CHANNELS = {
  status: "omp-studio:mobile:status",
  start: "omp-studio:mobile:start",
  stop: "omp-studio:mobile:stop",
  pair: "omp-studio:mobile:pair",
  revoke: "omp-studio:mobile:revoke",
  exportCertificate: "omp-studio:mobile:certificate",
} as const;

export interface MobileAccessStatus {
  addresses: string[];
  projects: { id: WorkspaceId; name: string }[];
  active?: { origin: string; workspaceName: string; fingerprint: string; paired: boolean };
}

export interface MobileAccessApi {
  status(): Promise<MobileAccessStatus>;
  start(ip: string, workspaceId: WorkspaceId): Promise<void>;
  stop(): Promise<void>;
  pair(): Promise<{ url: string; qr: string; expiresAt: number }>;
  revoke(): Promise<void>;
  exportCertificate(): Promise<boolean>;
}
