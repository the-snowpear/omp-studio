import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { ClientTransport } from "@omp-studio/client-contract";
import {
  createProductionHostFactory,
  pendingRuntimeArtifact,
  type ProductionHostOptions,
} from "../host-factory.js";
import { desktopPaths } from "../platform/desktop-paths.js";
import { desktopText, setDesktopLanguage } from "../desktop-language-shared.js";
import { serveLocalChannel, type HostCall } from "./local-channel.js";
import { HostControl, isViewCommand } from "./control.js";
import { SharedTerminals } from "./terminals.js";
import { startWebServer, lanAddresses } from "./server.js";
import type { WebStatus } from "./shared.js";
import { HostArtifactUploads } from "./artifacts.js";
import { activeArtifactLibrary } from "../artifact-library.js";
import type { RemotePeer } from "../remote/wire.js";
import { TransientMemoryCredentials } from "../memory-credentials.js";
import { desktopConversationViews } from "../desktop-performance.js";

export async function startSharedHost(
  options: ProductionHostOptions & {
    rendererDirectory: string;
    port?: number;
    bundleVersion?: string;
  },
) {
  let desktop: RemotePeer | undefined;
  const control = new HostControl();
  const memoryCredentials = new TransientMemoryCredentials();
  memoryCredentials.replace([]);
  const desktopCall = <T>(action: string, input?: unknown): Promise<T> => {
    if (!desktop)
      return Promise.reject(
        new Error(desktopText("请打开桌面程序使用此系统操作", "Open the desktop app to use this system action")),
      );
    return desktop.request("host.call", { action, input });
  };
  const factory = createProductionHostFactory({
    ...options,
    memoryCredentials,
    managedBrowser: true,
    pickDirectory: () => desktopCall("pickDirectory"),
    openUrl: async (url) => {
      control.authorizeUrl(url);
      if (desktop) await desktopCall("openUrl", url);
    },
    revealDirectory: (path) => desktopCall("revealDirectory", path),
    systemFiles: {
      knownFolders: () => desktop ? desktopCall("knownFolders") : Promise.resolve(undefined),
      trash: (path) => desktopCall("trash", path),
    },
  });
  const composition = await factory.create();
  const terminals = new SharedTerminals((id) =>
    factory.resolveWorkspaceCwd(id),
  );
  const stateDirectory = desktopPaths().stateRoot;
  const common = {
    host: composition.transport,
    ...(composition.openView
      ? { openView: () => composition.openView!() }
      : {}),
    control,
    terminals,
    stateDirectory,
    rendererDirectory: options.rendererDirectory,
  };
  let local: Awaited<ReturnType<typeof startWebServer>>;
  let lan: Awaited<ReturnType<typeof startWebServer>> | undefined;
  try {
    local = await startWebServer({ ...common, port: options.port ?? 8560 });
  } catch (error) {
    await terminals.close();
    await composition.shutdown();
    throw error;
  }
  const configPath = join(stateDirectory, "web", "listener.json");
  const config: { ip?: string; port?: number } = await readFile(
    configPath,
    "utf8",
  )
    .then((value) => JSON.parse(value))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
  try {
    if (config.ip && lanAddresses().includes(config.ip))
      lan = await startWebServer({
        ...common,
        ip: config.ip,
        ...(config.port === undefined ? {} : { port: config.port }),
      });
  } catch (error) {
    await local.close();
    await terminals.close();
    await composition.shutdown();
    throw error;
  }
  const status = (): WebStatus => ({
    origin: local.origin,
    ...(lan ? { lanOrigin: lan.origin, fingerprint: lan.fingerprint! } : {}),
    addresses: lanAddresses(),
    devices: [...local.adapter.devices(), ...(lan?.adapter.devices() ?? [])],
    control: control.state,
  });
  let closing: Promise<void> | undefined;
  let stopping = false;
  let changingListener = false;
  const channel = await serveLocalChannel(stateDirectory, (peer) => {
    desktopConversationViews.registerWindow(peer, true);
    let view: Promise<ClientTransport> | undefined;
    const rootView = () =>
      (view ??=
        composition.openView?.() ?? Promise.resolve(composition.transport));
    const uploads = new HostArtifactUploads(
      join(stateDirectory, "web", "uploads"),
    );
    const id = randomUUID();
    let disconnected = false;
    const contexts = new Map<string, ClientTransport>();
    const subscriptions = new Map<string, () => void>();
    const offControl = control.subscribe((state) =>
      peer.publish({ kind: "control.changed", control: state }),
    );
    const offTerminal = terminals.subscribe((event) =>
      peer.publish(
        event.kind === "terminal.changed"
          ? { kind: "terminal.snapshot", rows: terminals.list() }
          : event,
      ),
    );
    peer.onClose(() => {
      disconnected = true;
      desktopConversationViews.remove(peer);
      if (desktop === peer) desktop = undefined;
      void uploads.close();
      offControl();
      offTerminal();
      control.release(id);
      for (const off of subscriptions.values()) off();
      for (const context of contexts.values()) void context.close();
      void view?.then((root) => root.close());
    });
    return async ({
      action,
      input,
      contextId,
      version,
    }: HostCall): Promise<unknown> => {
      if (stopping) throw new Error(desktopText("Host 正在停止", "Host is stopping"));
      const target = async () => {
        const transport = contextId
          ? contexts.get(contextId)
          : await rootView();
        if (!transport) throw new Error(desktopText("对话上下文已关闭，请重新打开对话", "Conversation context is closed; reopen the conversation"));
        return transport;
      };
      switch (action) {
        case "desktop.attach":
          desktop = peer;
          return;
        case "memory.credentials":
          memoryCredentials.replace(input);
          return;
        case "view.report":
          return desktopConversationViews.report(peer, input);
        case "artifacts.state":
          return activeArtifactLibrary().state();
        case "artifacts.list":
          return activeArtifactLibrary().list(input);
        case "artifacts.resolve":
          return activeArtifactLibrary().resolve(input);
        case "artifacts.readText":
          return activeArtifactLibrary().readText(input);
        case "artifacts.findByRunId":
          return activeArtifactLibrary().findByRunId(input);
        case "artifacts.append":
          control.assert(id, version);
          return uploads.append(input.id, input.data);
        case "artifacts.finish":
          control.assert(id, version);
          return uploads.finish(input);
        case "artifacts.abort":
          return uploads.abort(input);
        case "identity":
          return {
            id,
            control: control.state,
            bundleVersion: options.bundleVersion,
          };
        case "control.take":
          return control.take(
            id,
            typeof input?.name === "string" ? input.name : "Desktop",
          );
        case "control.release":
          control.release(id);
          return;
        case "status":
          return {
            ...status(),
            busy: composition.isBusy() || terminals.busy,
            runtimeStatus: composition.status,
            cwd: factory.activeWorkspaceCwd(),
            restartBlocker: factory.updateRestartBlocker(),
          };
        case "bootstrap":
          return (await target()).bootstrap();
        case "query":
          return (await target()).query(input);
        case "subscribe": {
          const key = contextId ?? "";
          subscriptions.get(key)?.();
          subscriptions.set(
            key,
            (await target()).subscribe({ scope: "all" }, (event) =>
              peer.publish({ kind: "host.event", contextId: key, event }),
            ),
          );
          return { ok: true };
        }
        case "context.open": {
          if (!composition.transport.openContext)
            throw new Error("Contexts are unavailable");
          const context = await composition.transport.openContext(input);
          if (disconnected) {
            await context.close();
            throw new Error("Client disconnected");
          }
          const contextId = randomUUID();
          contexts.set(contextId, context);
          return { contextId };
        }
        case "context.close":
          subscriptions.get(contextId!)?.();
          subscriptions.delete(contextId!);
          await contexts.get(contextId!)?.close();
          contexts.delete(contextId!);
          return;
        case "workspace.path":
          return factory.resolveWorkspaceCwd(input.workspaceId);
        case "language":
          setDesktopLanguage(input);
          return;
        case "terminals.list":
          return terminals.list();
        case "terminals.recordingStatus":
          return terminals.record("status", input);
        case "web.pair":
          return (lan ?? local).pair();
        case "web.revoke":
          await local.adapter.revokeDevice(input.id);
          await lan?.adapter.revokeDevice(input.id);
          return;
        case "web.rename": {
          const adapter = local.adapter
            .devices()
            .some((row) => row.id === input.id)
            ? local.adapter
            : lan?.adapter;
          await adapter?.renameDevice(input.id, input.name);
          return;
        }
        case "web.certificate":
          return lan?.certificate?.toString("base64");
        case "web.listen": {
          if (changingListener)
            throw new Error(desktopText("网络访问正在切换，请稍候", "Network access is already changing"));
          changingListener = true;
          try {
            const next = input.ip
              ? await startWebServer({
                  ...common,
                  ip: input.ip,
                  port: input.port,
                })
              : undefined;
            await lan?.close();
            lan = next;
            await writeFile(
              configPath,
              JSON.stringify(
                lan
                  ? { ip: input.ip, port: Number(new URL(lan.origin).port) }
                  : {},
              ),
              { mode: 0o600 },
            );
            return status();
          } finally {
            changingListener = false;
          }
        }
        case "shutdown": {
          if (
            !input?.force &&
            (factory.updateRestartBlocker() || terminals.busy)
          )
            throw new Error(
              desktopText("任务、审批或终端仍在活动，请先完成，或显式使用 --force 停止。", "Tasks, approvals or terminals are active. Finish them or explicitly use --force."),
            );
          stopping = true;
          try {
            if (input?.update) await composition.prepareUpdateRestart?.();
          } catch (error) {
            stopping = false;
            throw error;
          }
          setTimeout(() => void close(), 50);
          return { stopping: true };
        }
      }
      if (
        action !== "command" ||
        !isViewCommand(input.commandName, input.input)
      )
        control.assert(id, version);
      switch (action) {
        case "artifacts.begin":
          return uploads.begin(input);
        case "artifacts.setDirectory":
          return activeArtifactLibrary().setDirectory(input);
        case "artifacts.remove":
          return activeArtifactLibrary().remove(input);
        case "artifacts.retain":
          return activeArtifactLibrary().retain(input);
        case "artifacts.discardRun":
          return activeArtifactLibrary().discardRun(input);
        case "artifacts.detachSession":
          return activeArtifactLibrary().detachSession(input);
        case "artifacts.finishSession":
          return activeArtifactLibrary().finishSession(input.id, input.remove);
        case "command": {
          const transport = await target();
          if (!isViewCommand(input.commandName, input.input))
            control.assert(id, version);
          return transport.command(input);
        }
        case "terminals.create":
          return terminals.create(input, () => control.assert(id, version));
        case "terminals.write":
          return terminals.write(input);
        case "terminals.resize":
          return terminals.resize(input);
        case "terminals.rebind":
          return terminals.rebind(input);
        case "terminals.dispose":
          return terminals.remove(input);
        case "terminals.recordingStart":
          return terminals.record("start", input);
        case "terminals.recordingStop":
          return terminals.record("stop", input);
        case "runtime.rollback":
          return factory.rollbackRuntime();
        case "runtime.prune":
          return factory.pruneRuntimes();
        case "runtime.artifact":
          pendingRuntimeArtifact.set(input);
          return;
        case "confirmClose":
          return composition.confirmClose?.() ?? true;
        default:
          throw new Error(`Unknown Host operation: ${action}`);
      }
    };
  }).catch(async (error) => {
    await lan?.close();
    await local.close();
    await terminals.close();
    await composition.shutdown();
    throw error;
  });
  function close(): Promise<void> {
    stopping = true;
    closing ??= (async () => {
      await lan?.close();
      await local.close();
      await terminals.close();
      await composition.shutdown();
      await channel.close();
    })();
    return closing;
  }
  return { status, close };
}
