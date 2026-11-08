import { randomUUID } from "node:crypto";
import { FILE_VIEWER_CHANNELS as channels, type FileResourceTarget } from "./file-viewer-shared.js";
import type { FileResources } from "./file-resources.js";
import type { OfficeComponent } from "./office-component.js";

interface Sender { id: number; getURL(): string; send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean; once(event: "destroyed", listener: () => void): unknown }
export function registerFileViewerIpc(options: {
  ipc: { handle(channel: string, listener: (event: { sender: Sender }, ...args: any[]) => unknown): void; removeHandler(channel: string): void };
  trusted(sender: Sender): boolean; resources: FileResources; office: OfficeComponent;
  pickExport(name: string): Promise<string | undefined>; show(): void;
}) {
  const senders = new Map<number, Sender>(), dirty = new Map<number, number>();
  const closeRequests = new Map<string, { owner: number; resolve: (allow: boolean) => void }>();
  const registered: string[] = [];
  const register = (channel: string, action: (sender: Sender, ...args: any[]) => unknown) => {
    registered.push(channel);
    options.ipc.handle(channel, (event, ...args) => {
      const sender = event.sender;
      if (!options.trusted(sender)) throw new Error("Untrusted file viewer sender");
      if (!senders.has(sender.id)) {
        senders.set(sender.id, sender);
        sender.once("destroyed", () => {
          senders.delete(sender.id); dirty.delete(sender.id); options.resources.releaseOwner(sender.id);
          for (const [id, request] of closeRequests) if (request.owner === sender.id) { closeRequests.delete(id); request.resolve(false); }
        });
      }
      return action(sender, ...args);
    });
  };
  const openResource = async (sender: Sender, input: FileResourceTarget) => {
    const resource = await options.resources.open(input, sender.id);
    if (sender.isDestroyed()) { options.resources.release(resource.id, sender.id); throw new Error("文件窗口已关闭"); }
    return resource;
  };
  register(channels.open, openResource);
  register(channels.release, (sender, id: string) => options.resources.release(id, sender.id));
  register(channels.export, async (sender, input: FileResourceTarget) => {
    const resource = await openResource(sender, input);
    try { const path = await options.pickExport(resource.file.name); if (!path) return false; await options.resources.copy(resource.id, path); return true; }
    finally { options.resources.release(resource.id, sender.id); }
  });
  register(channels.officeState, (_sender, check?: boolean) => options.office.getState(check));
  register(channels.officeInstall, () => options.office.install());
  register(channels.officeCancel, () => options.office.cancel());
  register(channels.officeUninstall, () => options.office.uninstall());
  register(channels.officePreview, async (sender, id: string) => {
    const path = await options.office.convert(options.resources, id, sender.id);
    options.resources.setPdf(id, path); return { url: `omp-file://viewer/${id}/preview.pdf` };
  });
  register(channels.dirty, (sender, count: number) => { dirty.set(sender.id, Math.max(0, count)); });
  register(channels.finishClose, (sender, id: string, allow: boolean) => { const request = closeRequests.get(id); if (request?.owner === sender.id) { closeRequests.delete(id); request.resolve(allow); } });
  const off = options.office.subscribe(state => { for (const sender of senders.values()) if (!sender.isDestroyed()) sender.send(channels.officeChanged, state); });
  return {
    hasDirty: () => [...dirty].some(([id, count]) => count > 0 && !senders.get(id)?.isDestroyed()),
    async requestClose(): Promise<boolean> {
      const owners = [...dirty].filter(([id, count]) => count > 0 && !senders.get(id)?.isDestroyed());
      if (!owners.length) return true;
      options.show();
      const outcomes = await Promise.all(owners.map(([owner]) => new Promise<boolean>(resolve => { const id = randomUUID(); closeRequests.set(id, { owner, resolve }); senders.get(owner)!.send(channels.closeRequested, id); })));
      return outcomes.every(Boolean);
    },
    dispose() { off(); for (const channel of registered) options.ipc.removeHandler(channel); for (const request of closeRequests.values()) request.resolve(false); closeRequests.clear(); options.resources.dispose(); options.office.dispose(); },
  };
}
