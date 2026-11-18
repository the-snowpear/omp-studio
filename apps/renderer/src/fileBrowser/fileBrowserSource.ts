import type { StudioClient, SystemFileMutationResult } from "@omp-studio/client-contract";
import { hostErrorMessage, waitReceipt } from "../hostError";
import type { FileOpenIntent } from "../files/fileLinks";
import { fileKind } from "../files/fileTypes";
import { COMPUTER, driveDisplayName, samePath, within, type FileBrowserSource, type FsEntry, type FsPlaces, type FsPeek } from "./model";

export function systemFileReference(entry: FsEntry): FileOpenIntent {
  return entry.workspace ? { workspaceId: entry.workspace.workspaceId, path: entry.workspace.relativePath }
    : { source: "system", path: entry.path };
}

export function createHostFileBrowserSource(options: {
  client(): Promise<StudioClient>;
  targetId: string | null;
  label: string | (() => string);
  workspaceId?: string | (() => string | undefined) | undefined;
  language: "zh" | "en" | (() => "zh" | "en");
}): FileBrowserSource {
  let trash = false;
  let separator = "/";
  const resolveLanguage = () => (typeof options.language === "function" ? options.language() : options.language);
  const resolveLabel = () => (typeof options.label === "function" ? options.label() : options.label);
  const resolveWorkspaceId = () => (typeof options.workspaceId === "function" ? options.workspaceId() : options.workspaceId);
  const copy = (zh: string, en: string) => (resolveLanguage() === "zh" ? zh : en);
  async function readPlaces() {
    const client = await options.client();
    const [system, projects] = await Promise.all([client.query("fs.places", {}), client.query("projects.list", {})]);
    trash = system.trash;
    separator = system.separator;
    const quickLabels = {
      home: copy("主目录", "Home"),
      desktop: copy("桌面", "Desktop"),
      downloads: copy("下载", "Downloads"),
      documents: copy("文档", "Documents"),
      pictures: copy("图片", "Pictures"),
    };
    const activeWorkspaceId = resolveWorkspaceId();
    const label = resolveLabel();
    const places: FsPlaces = {
      platform: system.platform, separator: system.separator, home: system.home,
      computerLabel: options.targetId ? label : system.platform === "darwin" ? copy("此 Mac", "This Mac") : copy("此电脑", "This computer"),
      quick: system.quick.map(place => ({ ...place, label: quickLabels[place.kind] })),
      drives: system.volumes.map(volume => ({ path: volume.path, label: volume.label, ready: volume.ready, ...(volume.totalBytes === undefined ? {} : { total: volume.totalBytes }), ...(volume.freeBytes === undefined ? {} : { free: volume.freeBytes }) })),
      projects: projects.workspaces.flatMap(project => project.root ? [{ name: project.name, root: project.root, current: project.workspaceId === activeWorkspaceId }] : []),
    };
    return { places, projects };
  }
  let projectRows: Awaited<ReturnType<typeof readPlaces>>["projects"]["workspaces"] = [];
  const loadPlaces = async () => { const result = await readPlaces(); projectRows = result.projects.workspaces; return result.places; };
  const report = (error: unknown): never => {
    const code = (error as { code?: string })?.code;
    if (code === "CAPABILITY_UNAVAILABLE" || code === "INVALID_ARGUMENT" && /fs\.|query/i.test(hostErrorMessage(error, ""))) throw new Error(copy("此 Host 版本尚不支持文件浏览器，请更新 Host。", "This Host version doesn't support the file browser. Update the Host."));
    const text = hostErrorMessage(error, copy("无法读取文件", "Couldn't read the file"));
    if (/EACCES|EPERM/.test(text)) throw new Error(copy("没有权限读取此文件夹", "Permission denied for this folder"));
    if (/ENOENT|ENOTDIR/.test(text)) throw new Error(copy("路径不存在或不是文件夹", "The path doesn't exist or isn't a folder"));
    if (/ENXIO|ENODEV|EBUSY/.test(text)) throw new Error(copy("驱动器未就绪", "The drive isn't ready"));
    throw new Error(text);
  };
  return {
    kind: "host",
    get label() { return resolveLabel(); },
    local: options.targetId === null,
    get trash() { return trash; },
    async places() { try { return await loadPlaces(); } catch (error) { return report(error); } },
    async list(path, showHidden = false) {
      try {
        if (path === COMPUTER) {
          const value = await loadPlaces();
          return { path, entries: value.drives.map(drive => ({ name: driveDisplayName(drive, value.separator), path: drive.path, type: "dir" as const, denied: !drive.ready })) };
        }
        const directory = await (await options.client()).query("fs.list", { path, showHidden });
        const workspace = directory.workspace, project = workspace && projectRows.find(item => item.workspaceId === workspace.workspaceId);
        return { path: directory.path, truncated: directory.truncated,
          ...(workspace ? { workspace } : {}),
          ...(project?.root ? { project: { name: project.name, root: project.root } } : {}),
          entries: directory.entries.map(entry => {
            const owner = projectRows.filter(row => row.root && within(entry.path, row.root, separator)).sort((a, b) => b.root!.length - a.root!.length)[0];
            const identity = entry.link ? undefined : owner?.root ? { workspaceId: owner.workspaceId, relativePath: samePath(entry.path, owner.root, separator) ? "" : entry.path.slice(owner.root.length + (owner.root.endsWith(separator) ? 0 : 1)).split(separator).join("/") }
              : workspace ? { workspaceId: workspace.workspaceId, relativePath: [workspace.relativePath, entry.name].filter(Boolean).join("/") } : undefined;
            return { ...entry, ...(entry.mtimeMs === undefined ? {} : { modified: entry.mtimeMs }), ...(identity ? { workspace: identity } : {}) };
          }),
        };
      } catch (error) { return report(error); }
    },
    async peek(entry): Promise<FsPeek> {
      const client = await options.client();
      if (fileKind(entry.path) === "image" && globalThis.ompStudioChrome?.files) {
        const api = globalThis.ompStudioChrome.files;
        const resource = await api.open({ targetId: options.targetId, workspaceId: "", path: entry.path, source: "system" });
        return { image: resource.url, release: () => { void api.release(resource.id); } };
      }
      if (!["text", "markdown"].includes(fileKind(entry.path))) return {};
      const file = await client.query("fs.file.inspect", { path: entry.path });
      if (!file.size) return { text: "" };
      const chunk = await client.query("fs.file.readChunk", { path: file.path, version: file.version, offset: 0, length: Math.min(file.size, 16 * 1024) });
      const bytes = Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0));
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
      if (encoding === "utf-8" && bytes.includes(0)) return {};
      return { text: new TextDecoder(encoding).decode(bytes, { stream: true }).split(/\r?\n/).slice(0, 40).join("\n") };
    },
    async createFolder(parent, name) {
      const client = await options.client(), handle = await client.command("fs.directory.create", { parent, name });
      return (await waitReceipt<SystemFileMutationResult>(client, handle.requestId)).path;
    },
    async rename(path, name) {
      const client = await options.client(), handle = await client.command("fs.rename", { path, name });
      return (await waitReceipt<SystemFileMutationResult>(client, handle.requestId)).path;
    },
    async trashItems(paths) {
      const client = await options.client(), handle = await client.command("fs.trash", { paths });
      await waitReceipt(client, handle.requestId);
    },
  };
}
