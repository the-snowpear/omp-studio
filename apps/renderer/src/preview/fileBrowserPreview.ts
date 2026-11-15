/**
 * 文件浏览器的演示文件系统（预览模式专用）。
 *
 * 故事与侧栏一致：项目在 `demoPath()` 下（omp-web、pi-web、mermaid worktree），
 * omp-web 的内容直接取 `PREVIEW_FILE_TREE`；其余是一台普通开发机的盘符、主目录、
 * 下载与系统目录。写操作（新建文件夹 / 重命名 / 移到回收站）只改这份内存树，
 * 不调用 Host。演示路径、容量与时间都不是 Host 真相。
 */
import { PLATFORM } from "../platform";
import { DEMO_TOOLS } from "./demoPaths";
import { PREVIEW_FILE_TREE, PREVIEW_PROJECTS, type PreviewFileNode } from "./fixtures";
import { baseName, COMPUTER, driveDisplayName, joinPath, parentPath, samePath, within, type FileBrowserSource, type FsDirectory, type FsDrive, type FsEntry, type FsPeek, type FsPlaces } from "../fileBrowser/model";

type Node = { name: string; dir?: Node[]; size?: number; age?: number; hidden?: boolean; denied?: boolean; link?: boolean };

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const KB = 1024, MB = KB * 1024, GB = MB * 1024;
const dir = (name: string, children: Node[], extra: Omit<Node, "name" | "dir"> = {}): Node => ({ name, dir: children, ...extra });
const file = (name: string, size: number, age: number, extra: Omit<Node, "name" | "dir" | "size" | "age"> = {}): Node => ({ name, size, age, ...extra });

function fromPreviewTree(nodes: readonly PreviewFileNode[], depth = 0): Node[] {
  return nodes.map((node, index) => node.type === "dir"
    ? dir(node.name, fromPreviewTree(node.children ?? [], depth + 1), { age: (index + 2) * 37 * MIN, hidden: node.name.startsWith(".") })
    : file(node.name, 900 + (node.name.length * 733 + index * 1913) % 48_000, (node.status || node.turn ? 12 + index * 9 : (index + 3) * 7 * HOUR), { hidden: node.name.startsWith(".") && node.name !== ".gitignore" }));
}

const winSystem = (): Node[] => [
  dir("System32", Array.from({ length: 5001 }, (_, index) => file(index % 7 === 0 ? `drivers-${index}.sys` : `api-ms-win-core-${index}.dll`, 24 * KB + index * 311, 90 * DAY + index * HOUR))),
  dir("Fonts", [file("msyh.ttc", 19 * MB, 400 * DAY), file("consola.ttf", 450 * KB, 400 * DAY)]),
  dir("Temp", [], { denied: true }),
  file("explorer.exe", 5 * MB, 30 * DAY),
  file("notepad.exe", 360 * KB, 30 * DAY),
];

function homeTree(platform: "win32" | "darwin"): Node[] {
  const win = platform === "win32";
  return [
    dir("Desktop", [file("会议纪要 1112.docx", 86 * KB, 2 * DAY), file("截图 2026-11-12 143002.png", 412 * KB, 2 * DAY + 3 * HOUR), file("待办.txt", 2 * KB, 40 * MIN)]),
    dir("Documents", [dir("Notes", [file("读书笔记.md", 14 * KB, 9 * DAY), file("周报模板.md", 3 * KB, 21 * DAY)]), file("年度预算.xlsx", 58 * KB, 15 * DAY), file("简历-2026.pdf", 210 * KB, 120 * DAY)]),
    dir("Downloads", [
      file(win ? "OMP-Studio-Setup-0.2.0.exe" : "OMP-Studio-0.2.0-arm64.dmg", 148 * MB, 1 * DAY + 2 * HOUR),
      file("spec-v3.pdf", 2.4 * MB, 3 * HOUR), file("usage.csv", 18 * KB, 5 * HOUR), file("report.xlsx", 64 * KB, 26 * HOUR),
      file("design-review.pptx", 6.8 * MB, 4 * DAY), file("sample-voice.wav", 1.1 * MB, 6 * DAY), file("node-v24.11.0-x64.msi", 31 * MB, 11 * DAY),
    ]),
    dir("Pictures", [dir("Screenshots", [file("mermaid-dark.png", 302 * KB, 3 * DAY), file("mermaid-light.png", 298 * KB, 3 * DAY)]), file("wallpaper.jpg", 3.2 * MB, 200 * DAY)]),
    dir(".omp", [dir("agent", [file("models.yml", 6 * KB, 50 * MIN), file("config.yml", 2 * KB, 3 * DAY), dir("sessions", [file("2026-11-14T09-12.jsonl", 820 * KB, 25 * MIN)])])], { hidden: true }),
    dir(".ssh", [file("config", 1 * KB, 30 * DAY), file("known_hosts", 4 * KB, 2 * DAY), file("id_ed25519", 411, 300 * DAY), file("id_ed25519.pub", 103, 300 * DAY)], { hidden: true }),
    file(".gitconfig", 612, 60 * DAY, { hidden: true }),
    ...(win ? [dir("AppData", [dir("Local", []), dir("Roaming", [])], { hidden: true }), file("NTUSER.DAT", 6 * MB, 10 * MIN, { hidden: true })] : [dir("Library", [], { hidden: true })]),
  ];
}

function tools(): Node[] {
  const omp = fromPreviewTree(PREVIEW_FILE_TREE);
  omp.push(dir(".worktrees", [dir("mermaid", fromPreviewTree(PREVIEW_FILE_TREE.slice(3, 7)))], { hidden: true }));
  return [
    dir("omp-web", omp, { age: 12 * MIN }),
    dir("pi-web", [dir("src", [file("index.ts", 4 * KB, 1 * DAY)]), file("package.json", 2 * KB, 1 * DAY), file("README.md", 6 * KB, 8 * DAY)], { age: 1 * DAY }),
    dir("scratch", [file("notes.md", 1 * KB, 3 * HOUR)], { age: 3 * HOUR }),
  ];
}

/** 按路径把 `tools()` 挂到 `DEMO_TOOLS` 下：`C:\Aspace\Tools` / `/Users/demo/Tools`。 */
function mountTools(root: Node[], sep: string, base: string) {
  const parts = DEMO_TOOLS.slice(base.length).split(sep).filter(Boolean);
  let level = root;
  for (const part of parts) {
    let next = level.find(node => node.name === part);
    if (!next) { next = dir(part, []); level.push(next); }
    next.dir ??= [];
    level = next.dir;
  }
  level.push(...tools());
}

interface Volume { drive: FsDrive; nodes: Node[] }

function volumes(platform: "win32" | "darwin"): Volume[] {
  if (platform === "darwin") {
    const root: Node[] = [
      dir("Applications", [dir("OMP Studio.app", []), dir("Visual Studio Code.app", []), dir("Safari.app", [])]),
      dir("Library", [], { denied: true }),
      dir("System", [], { denied: true }),
      dir("Users", [dir("Shared", []), dir("demo", homeTree("darwin"))]),
      dir("Volumes", [], { hidden: true }),
      dir("private", [], { hidden: true, denied: true }),
      dir("tmp", [], { hidden: true, link: true }),
    ];
    mountTools(root, "/", "/");
    return [
      { drive: { path: "/", label: "Macintosh HD", total: 994 * GB, free: 312 * GB, ready: true }, nodes: root },
      { drive: { path: "/Volumes/Backup", label: "Backup", total: 2 * 1024 * GB, free: 180 * GB, ready: true }, nodes: [dir("Time Machine", [], { denied: true }), dir("Photos 2025", [file("IMG_0001.heic", 3 * MB, 300 * DAY)])] },
    ];
  }
  const c: Node[] = [
    dir("Program Files", [dir("OMP Studio", [file("OMP Studio.exe", 182 * MB, 1 * DAY)]), dir("Git", [dir("bin", [])]), dir("nodejs", [file("node.exe", 72 * MB, 11 * DAY)])]),
    dir("Program Files (x86)", [dir("Microsoft", [])]),
    dir("Users", [dir("Public", []), dir("demo", homeTree("win32"))]),
    dir("Windows", winSystem()),
    dir("$Recycle.Bin", [], { hidden: true }),
    dir("System Volume Information", [], { hidden: true, denied: true }),
    file("pagefile.sys", 12 * GB, 2 * HOUR, { hidden: true }),
    file("hiberfil.sys", 6 * GB, 3 * DAY, { hidden: true }),
  ];
  mountTools(c, "\\", "C:\\");
  return [
    { drive: { path: "C:\\", label: "系统", total: 512 * GB, free: 46 * GB, ready: true }, nodes: c },
    { drive: { path: "D:\\", label: "数据", total: 1024 * GB, free: 640 * GB, ready: true }, nodes: [
      dir("Project", [dir("omp-studio-archive", [file("README.md", 7 * KB, 40 * DAY)]), dir("website", [file("index.html", 9 * KB, 2 * DAY)])]),
      dir("datasets", [file("tickets-2026Q3.csv", 48 * MB, 20 * DAY), file("embeddings.parquet", 1.6 * GB, 35 * DAY)]),
      dir("Games", [dir("Steam", [], { denied: true })]),
      dir("Photos", [file("trip-01.jpg", 4 * MB, 90 * DAY), file("trip-02.jpg", 4 * MB, 90 * DAY)]),
    ] },
    { drive: { path: "E:\\", label: "U 盘", ready: false }, nodes: [] },
  ];
}

const TEXT_SAMPLE: Record<string, string> = {
  md: "# 笔记\n\n- 文件浏览器可以看到整台电脑\n- 双击文件夹进入，Backspace 返回上一级\n\n```ts\nconst place = \"此电脑\";\n```\n",
  yml: "providers:\n  anthropic:\n    models:\n      - id: claude-fable-5-2\n        roles: [default, plan]\n  openai:\n    baseUrl: https://api.openai.com/v1\n",
  json: "{\n  \"name\": \"omp-web\",\n  \"private\": true,\n  \"scripts\": {\n    \"check\": \"node scripts/check.mjs\"\n  }\n}\n",
  csv: "Model,Requests,Tokens\nClaude,128,52400\nGPT,96,41800\nGemini,64,28700\n",
  txt: "1. 回复 pi-web 上游 issue\n2. 整理 0.2.1 发布说明\n3. 周五前看完 spec-v3.pdf\n",
};
const CODE_SAMPLE = "import { useState } from \"react\";\n\nexport function Counter() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>{count}</button>;\n}\n";
const IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#172c43"/><stop offset="1" stop-color="#3b3f8f"/></linearGradient></defs><rect width="480" height="300" fill="url(#g)"/><circle cx="240" cy="130" r="70" fill="#72cbb4"/><text x="240" y="250" text-anchor="middle" fill="white" font-size="26" font-family="sans-serif">OMP Studio</text></svg>')}`;

export function createPreviewFileBrowserSource(platform: "win32" | "darwin" = PLATFORM === "darwin" ? "darwin" : "win32", now = Date.now(), language: "zh" | "en" = "zh"): FileBrowserSource {
  const copy = (zh: string, en: string) => language === "zh" ? zh : en;
  const sep = platform === "win32" ? "\\" : "/";
  const driveLabels: Record<string, string> = { 系统: "System", 数据: "Data", "U 盘": "USB drive" };
  const vols = volumes(platform).map(volume => ({ ...volume, drive: { ...volume.drive, label: copy(volume.drive.label, driveLabels[volume.drive.label] ?? volume.drive.label) } }));
  /** 键是比较用的路径（Windows 不分大小写），值保留原始写法。 */
  const folders = new Map<string, { path: string; entries: FsEntry[] }>();
  const keyOf = (path: string) => platform === "win32" ? path.toLowerCase() : path;
  const tree = {
    get: (path: string) => folders.get(keyOf(path))?.entries,
    set: (path: string, entries: FsEntry[]) => { folders.set(keyOf(path), { path, entries }); },
  };
  const index = (path: string, nodes: Node[]) => {
    tree.set(path, nodes.map(node => {
      const child = joinPath(path, node.name, sep);
      if (node.dir) index(child, node.dir);
      return { name: node.name, path: child, type: node.dir ? "dir" : "file", ...(node.size === undefined ? {} : { size: Math.round(node.size) }), ...(node.age === undefined ? {} : { modified: now - node.age }), ...(node.hidden ? { hidden: true } : {}), ...(node.link ? { link: true } : {}), ...(node.denied ? { denied: true } : {}) } satisfies FsEntry;
    }));
  };
  for (const volume of vols) if (volume.drive.ready) index(volume.drive.path, volume.nodes);
  if (platform === "darwin") {
    const backup = vols[1]!;
    tree.set("/Volumes", [{ name: "Backup", path: backup.drive.path, type: "dir", modified: now - 2 * DAY }, { name: "Macintosh HD", path: "/Volumes/Macintosh HD", type: "dir", link: true }]);
  }
  const home = platform === "win32" ? "C:\\Users\\demo" : "/Users/demo";
  const projects = PREVIEW_PROJECTS.map((project, position) => ({ name: project.name, root: project.path, ...(position === 0 ? { current: true } : {}) }));
  const places: FsPlaces = {
    platform, separator: sep, computerLabel: platform === "win32" ? copy("此电脑", "This computer") : copy("此 Mac", "This Mac"), home,
    quick: [
      { kind: "home", label: "demo", path: home },
      { kind: "desktop", label: copy("桌面", "Desktop"), path: joinPath(home, "Desktop", sep) },
      { kind: "downloads", label: copy("下载", "Downloads"), path: joinPath(home, "Downloads", sep) },
      { kind: "documents", label: copy("文档", "Documents"), path: joinPath(home, "Documents", sep) },
      { kind: "pictures", label: copy("图片", "Pictures"), path: joinPath(home, "Pictures", sep) },
    ],
    drives: vols.map(volume => volume.drive),
    projects,
  };
  const wait = <T,>(value: T, ms = 90) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
  const fail = (message: string, ms = 90) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms));
  const findEntry = (path: string) => tree.get(parentPath(path, sep))?.find(entry => samePath(entry.path, path, sep));
  const remap = (from: string, to: string) => {
    for (const [key, folder] of [...folders]) {
      if (!within(folder.path, from, sep)) continue;
      folders.delete(key);
      tree.set(to + folder.path.slice(from.length), folder.entries.map(entry => ({ ...entry, path: to + entry.path.slice(from.length) })));
    }
  };

  return {
    kind: "preview", label: copy("本机", "Local"), local: true, trash: true,
    places: () => wait(places, 40),
    list(path) {
      if (path === COMPUTER) return wait<FsDirectory>({ path, entries: vols.map(volume => ({ name: driveDisplayName(volume.drive, sep), path: volume.drive.path, type: "dir" as const, ...(volume.drive.ready ? {} : { denied: true }) })) }, 40);
      const drive = vols.find(volume => within(path, volume.drive.path, sep));
      if (drive && !drive.drive.ready) return fail(copy(`${drive.drive.label}（${baseName(drive.drive.path, sep)}）未就绪：请插入设备后重试`, `${drive.drive.label} (${baseName(drive.drive.path, sep)}) is not ready; connect the device and try again`));
      const entry = findEntry(path);
      if (entry?.denied) return fail(copy("没有权限读取此文件夹", "Permission denied for this folder"));
      const entries = tree.get(path);
      if (!entries) return fail(copy("路径不存在或不是文件夹", "The path does not exist or is not a folder"));
      const project = projects.find(item => within(path, item.root, sep));
      return wait<FsDirectory>({ path: drive && samePath(drive.drive.path, path, sep) ? drive.drive.path : (entry?.path ?? path), entries: entries.slice(0, 5000), ...(entries.length > 5000 ? { truncated: true } : {}), ...(project ? { project: { name: project.name, root: project.root } } : {}) }, entries.length > 100 ? 220 : 90);
    },
    peek(entry) {
      const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase() : "";
      if (/^(png|jpe?g|gif|webp|svg|bmp|heic)$/.test(ext)) return wait<FsPeek>({ image: IMAGE }, 60);
      if (/^(tsx?|jsx?|mjs|cjs)$/.test(ext)) return wait<FsPeek>({ text: CODE_SAMPLE }, 60);
      const text = language === "en" && ext === "txt" ? "1. Reply to the upstream pi-web issue\n2. Prepare the 0.2.1 release notes\n3. Read spec-v3.pdf before Friday\n"
        : language === "en" && ext === "md" ? "# Notes\n\n- Browse files across this computer\n- Open a folder and press Backspace to go up\n"
        : TEXT_SAMPLE[ext === "yaml" ? "yml" : ext] ?? (["config", "known_hosts", ".gitconfig", ".gitignore"].includes(entry.name) ? "# demo\nHost dev-server\n  HostName 192.168.1.10\n  User demo\n" : undefined);
      return wait<FsPeek>(text === undefined ? {} : { text }, 60);
    },
    createFolder(parent, name) {
      const entries = tree.get(parent);
      if (!entries) return fail(copy("父文件夹不存在", "Parent folder does not exist"));
      if (entries.some(entry => entry.name.toLowerCase() === name.toLowerCase())) return fail(copy(`已存在同名项目：${name}`, `An item named ${name} already exists`));
      const path = joinPath(parent, name, sep);
      entries.push({ name, path, type: "dir", modified: Date.now() });
      tree.set(path, []);
      return wait(path);
    },
    rename(path, name) {
      const parent = parentPath(path, sep), entries = tree.get(parent);
      const entry = entries?.find(item => samePath(item.path, path, sep));
      if (!entries || !entry) return fail(copy("找不到要重命名的项目", "Cannot find the item to rename"));
      if (entries.some(item => item !== entry && item.name.toLowerCase() === name.toLowerCase())) return fail(copy(`已存在同名项目：${name}`, `An item named ${name} already exists`));
      const next = joinPath(parent, name, sep);
      entries.splice(entries.indexOf(entry), 1, { ...entry, name, path: next, modified: Date.now() });
      if (entry.type === "dir") remap(entry.path, next);
      return wait(next);
    },
    trashItems(paths) {
      for (const path of paths) {
        const entries = tree.get(parentPath(path, sep));
        const position = entries?.findIndex(item => samePath(item.path, path, sep)) ?? -1;
        if (entries && position >= 0) entries.splice(position, 1);
        for (const [key, folder] of [...folders]) if (within(folder.path, path, sep)) folders.delete(key);
      }
      return wait(undefined);
    },
  };
}

/** 预览里打开的项目内文件：返回项目 id 与相对路径，交给现有文件窗口。 */
export function previewProjectFile(path: string): { workspaceId: string; path: string } | undefined {
  const sep = PLATFORM === "darwin" ? "/" : "\\";
  const project = PREVIEW_PROJECTS.find(item => within(path, item.path, sep));
  return project ? { workspaceId: project.id, path: path.slice(project.path.length + 1).replaceAll("\\", "/") } : undefined;
}
