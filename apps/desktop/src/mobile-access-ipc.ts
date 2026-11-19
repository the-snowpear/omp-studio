import { dialog, ipcMain, type WebContents } from "electron";
import { writeFile } from "node:fs/promises";
import type { ClientTransport, WorkspaceId } from "@omp-studio/client-contract";
import { MOBILE_ACCESS_CHANNELS, type MobileAccessStatus } from "@omp-studio/transport-desktop";
import { mobileAddresses, startMobileAccess } from "./mobile-access.js";

export function registerMobileAccessIpc(options: {
  host: ClientTransport | null;
  isTrustedSender: (sender: WebContents) => boolean;
  profileDirectory: string;
  rendererDirectory: string;
}) {
  let running: Awaited<ReturnType<typeof startMobileAccess>> | undefined;
  let starting: Promise<void> | undefined;
  let disposed = false;
  const projects = async (): Promise<MobileAccessStatus["projects"]> => {
    const result = await options.host?.query({ queryName: "projects.list", input: {} });
    return result?.ok ? result.result.workspaces.filter(row => !row.unavailable).map(row => ({ id: row.workspaceId, name: row.name })) : [];
  };
  const requireRunning = () => {
    if (!running) throw new Error("mobile_access_disabled");
    return running;
  };
  const stop = async () => {
    await starting?.catch(() => {});
    const current = running;
    running = undefined;
    await current?.close();
  };
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (disposed || !options.isTrustedSender(event.sender)) throw new Error("untrusted_sender");
      return action(...args);
    });
  };
  handle(MOBILE_ACCESS_CHANNELS.status, async (): Promise<MobileAccessStatus> => {
    const inventory = await projects();
    return {
      addresses: mobileAddresses(),
      projects: inventory,
      ...(running ? { active: { origin: running.origin, workspaceName: running.workspaceName, fingerprint: running.fingerprint, paired: running.paired() } } : {}),
    };
  });
  handle(MOBILE_ACCESS_CHANNELS.start, async (ip, workspaceId) => {
    if (starting || running || typeof ip !== "string" || !mobileAddresses().includes(ip) || !options.host) throw new Error("mobile_access_unavailable");
    const host = options.host;
    starting = (async () => {
      const project = (await projects()).find(row => row.id === workspaceId);
      if (!project) throw new Error("mobile_project_unavailable");
      running = await startMobileAccess({
        host, ip, workspaceId: project.id as WorkspaceId, workspaceName: project.name,
        profileDirectory: options.profileDirectory, rendererDirectory: options.rendererDirectory,
      });
    })();
    try { await starting; } finally { starting = undefined; }
  });
  handle(MOBILE_ACCESS_CHANNELS.stop, stop);
  handle(MOBILE_ACCESS_CHANNELS.pair, () => requireRunning().pair());
  handle(MOBILE_ACCESS_CHANNELS.revoke, () => requireRunning().revoke());
  handle(MOBILE_ACCESS_CHANNELS.exportCertificate, async () => {
    const { certificate } = requireRunning();
    const result = await dialog.showSaveDialog({ defaultPath: "OMP-Studio-Mobile-CA.cer" });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, certificate);
    return true;
  });
  return {
    stop,
    dispose() {
      disposed = true;
      for (const channel of Object.values(MOBILE_ACCESS_CHANNELS)) ipcMain.removeHandler(channel);
      void stop();
    },
  };
}
