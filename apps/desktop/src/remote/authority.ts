import { createHash } from "node:crypto";
import { ensurePrivateSocketDirectory } from "@omp-studio/studio-host";
import { createPosixAuthorityLiveness, createWin32AuthorityLiveness } from "../authority-liveness.js";

export function remoteAuthority(stateDirectory: string) {
  const key = `remote-${createHash("sha256").update(stateDirectory).digest("hex").slice(0, 24)}`;
  const liveness = process.platform === "win32" ? createWin32AuthorityLiveness() : createPosixAuthorityLiveness({
    socketDirectory: () => ensurePrivateSocketDirectory(`remote-host:${stateDirectory}`),
  });
  return { key, liveness };
}
