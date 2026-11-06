export const MEMORY_CREDENTIAL_CHANNELS = {
  status: "omp-studio:memory-credential-status",
  set: "omp-studio:memory-credential-set",
  remove: "omp-studio:memory-credential-remove",
} as const;

export interface MemoryCredentialInput { targetId: string | null; url: string }
export type MemoryCredentialResult = { ok: true; configured: boolean; syncSupported: boolean } | { ok: false; message: string };
