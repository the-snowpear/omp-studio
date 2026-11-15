import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, rename, symlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import process from "node:process";

import { bundlePreload } from "./preload-bundle.mjs";
import { startLiveUiPreview } from "./preview-live-ui.mjs";

const root = process.cwd();
const previewHost = "127.0.0.1";
const previewPort = process.env.OMP_PREVIEW_PORT ?? "5173";
const previewUrl = `http://${previewHost}:${previewPort}`;
/** 生产预览的 CDP 端口：用于在重建后触发渲染层重载。 */
const previewCdpPort = process.env.OMP_PREVIEW_CDP_PORT ?? "9333";
const previewAumid = "com.ompstudio.desktop.preview";
/**
 * 生产预览（OMP_PREVIEW_MODE=production）必须复现已安装形态：改名的 exe
 * 让 Electron 报告 app.isPackaged === true，桌面端才会走托管 Runtime 的
 * 发现、验签与激活路径。开发预览必须保持 isPackaged === false，否则
 * rendererDevServerUrl() 会丢掉 OMP_RENDERER_DEV_URL，Vite HMR 形同虚设。
 */
const production = process.env.OMP_PREVIEW_MODE === "production";
/**
 * 预览数据（OMP_PREVIEW_DATA=1）：渲染层收到 `?preview=1` 后强制走演示
 * fixture，和顶栏预览开关是同一条路径（apps/renderer/src/preview/PreviewContext.tsx）。
 * 同时带上 `marks=off`：隐藏所有「演示 / 预览」提示，把 fixture 当真实页面展示。
 * 只在 dev server 形态下可用——生产预加载的是 file:// 构建产物，没有查询串可挂。
 */
const previewData = process.env.OMP_PREVIEW_DATA === "1";
/** 渲染层入口地址；预览数据时带上强制预览与隐藏提示的查询串。 */
const rendererEntryUrl = previewData ? `${previewUrl}/?preview=1&marks=off` : previewUrl;
// A Homebrew or nvm Node on macOS keeps npm outside dirname(node); `npm run` names the CLI it runs.
const npmCli = process.env.OMP_NPM_CLI
  ?? (process.platform === "win32" ? undefined : process.env.npm_execpath)
  ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const electronDist = join(root, "node_modules", "electron", "dist");
/**
 * Managed-Runtime tree an earlier preview run wrote into the Electron
 * distribution (see preparePreviewElectron). Never copied forward.
 */
const staleRuntimeDir = join(electronDist, "runtime");
const previewElectronDir = join(root, "outputs", "preview-electron");
const previewElectronExe = join(previewElectronDir, "OMP Studio.exe");
const previewRuntimePayload = join(root, "packaging", "runtime-payload");
const previewRuntimeKeys = join(root, "packaging", "runtime-keys");
const appIcon = join(root, "apps", "desktop", "resources", "icon.ico");
const rceditExe = join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let stopping = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  children.push(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  if (process.platform === "darwin" && child.pid !== undefined) {
    child.kill("SIGTERM");
    return;
  }
  child.kill("SIGTERM");
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map((child) => stopChild(child)));
}

async function waitForRenderer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Renderer dev server exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(previewUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Renderer did not become ready at ${previewUrl}`);
}

async function registerWindowsPreviewShortcut() {
  if (process.platform !== "win32") return;
  const appData = process.env.APPDATA;
  if (!appData) return;
  // Distinct name and AUMID: sharing the installed app's would hijack its taskbar and toast identity.
  const shortcutPath = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "OMP Studio (Preview).lnk");
  const aumid = previewAumid;
  const psScript = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace ShellHelpers {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class ShellLink {}

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    public interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cchMaxPath, out IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cchMaxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cchMaxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cchMaxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cchIconPath, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    public interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropertyKey {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid guid, uint id) { fmtid = guid; pid = id; }
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PropVariant {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pwszVal;
        public static PropVariant FromString(string val) {
            PropVariant pv = new PropVariant();
            pv.vt = 31;
            pv.pwszVal = Marshal.StringToCoTaskMemUni(val);
            return pv;
        }
    }

    public static class ShortcutManager {
        public static void CreateOrUpdate(string shortcutPath, string targetExe, string iconPath, string aumid) {
            IShellLinkW link = (IShellLinkW)new ShellLink();
            link.SetPath(targetExe);
            link.SetIconLocation(iconPath, 0);
            link.SetDescription("OMP Studio");

            IPropertyStore store = (IPropertyStore)link;
            PropertyKey key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
            PropVariant pv = PropVariant.FromString(aumid);
            store.SetValue(ref key, ref pv);
            store.Commit();

            ((IPersistFile)link).Save(shortcutPath, true);
        }
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[ShellHelpers.ShortcutManager]::CreateOrUpdate("${shortcutPath.replace(/\\/g, "\\\\")}", "${previewElectronExe.replace(/\\/g, "\\\\")}", "${appIcon.replace(/\\/g, "\\\\")}", "${aumid}")
`;
  try {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript]);
  } catch (err) {
    console.warn(`[preview] Warning: Could not register Start Menu shortcut for preview: ${err}`);
  }
}

async function stagePreviewRuntime() {
  // 开发预览的 exe 保持 electron.exe 这个名字，app.isPackaged === false，
  // 桌面端不会读 <previewElectronDir>/runtime，改从 AppData 的已装 Runtime
  // 与 repo 内产物发现。因此这里无需 stage，也就不必要求已签名产物存在。
  if (!production) return;

  if (!existsSync(previewRuntimePayload)) {
    throw new Error(
      "Signed Runtime payload is missing. Run `npm run pack:win:prepare`, then retry.",
    );
  }
  if (
    !existsSync(join(previewRuntimeKeys, "key-id.txt")) ||
    !existsSync(join(previewRuntimeKeys, "trusted-public.pem"))
  ) {
    throw new Error(
      "Runtime verification keys are missing. Run `npm run pack:win:prepare`, then retry.",
    );
  }

  const versions = (await readdir(previewRuntimePayload, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (versions.length === 0) {
    throw new Error("Signed Runtime payload contains no version directory.");
  }
  for (const version of versions) {
    const directory = join(previewRuntimePayload, version.name);
    for (const required of ["omp.exe", "runtime-manifest.json", "checksums.json", "runtime-signature.json"]) {
      if (!existsSync(join(directory, required))) {
        throw new Error(`Signed Runtime payload ${version.name} is missing ${required}.`);
      }
    }
  }

  // The renamed executable reports app.isPackaged=true. Mirror electron-builder's
  // extraFiles layout so production preview exercises the same managed Runtime
  // discovery, verification and activation path as an installed build.
  await cp(previewRuntimePayload, join(previewElectronDir, "runtime", "versions"), { recursive: true });
  await cp(previewRuntimeKeys, join(previewElectronDir, "runtime-keys"), { recursive: true });
}

async function preparePreviewElectron() {
  if (!existsSync(electronDist)) {
    throw new Error("Electron distribution is missing. Run `npm install` once, then retry.");
  }
  if (process.platform === "linux") {
    // The npm Electron distribution ships the binary at dist/electron; an
    // unpackaged run reports app.isPackaged === false, so no Runtime staging.
    return join(electronDist, "electron");
  }
  if (process.platform !== "win32") {
    return join(electronDist, "Electron.app", "Contents", "MacOS", "Electron");
  }
  if (!existsSync(appIcon) || !existsSync(rceditExe)) {
    throw new Error("Preview icon resources are missing. Expected apps/desktop/resources/icon.ico and rcedit.exe.");
  }

  await rm(previewElectronDir, { recursive: true, force: true });
  await mkdir(previewElectronDir, { recursive: true });
  // Renaming electron.exe makes Electron report app.isPackaged === true, so the
  // Desktop Host puts its managed Runtime tree at <previewElectronDir>/runtime.
  // Anything named `runtime` inside the Electron distribution is therefore a
  // leftover from an earlier preview run, and copying it in would resurrect a
  // stale omp.exe that `rm -rf outputs/preview-electron` cannot reach (it lives
  // under the gitignored node_modules). Skip it so seeding installs the freshly
  // built, signed artifact instead.
  await cp(electronDist, previewElectronDir, {
    recursive: true,
    filter: (source) => source !== staleRuntimeDir && !source.startsWith(`${staleRuntimeDir}${sep}`),
  });
  if (existsSync(staleRuntimeDir)) {
    await rm(staleRuntimeDir, { recursive: true, force: true });
    console.log(`[preview] Removed a stale Runtime tree from the Electron distribution: ${staleRuntimeDir}`);
  }

  /**
   * 生产预览必须改名：Electron 只看可执行文件名决定 isPackaged。改名后
   * app.isPackaged === true，桌面端才会走托管 Runtime 的发现、验签与激活
   * 路径，与已安装形态一致。
   *
   * 开发预览必须保持 electron.exe 这个名字：isPackaged === false 时
   * rendererDevServerUrl() 才会采纳 OMP_RENDERER_DEV_URL，渲染层才会真的
   * 走 Vite dev server，HMR / Fast Refresh 才有意义。改名会让 dev server
   * 白起，渲染层仍读 file:// 构建产物。
   */
  const exePath = production ? previewElectronExe : join(previewElectronDir, "electron.exe");
  if (production) {
    await rename(join(previewElectronDir, "electron.exe"), previewElectronExe);
  }
  await stagePreviewRuntime();

  await run(rceditExe, [
    exePath,
    "--set-icon",
    appIcon,
    "--set-version-string",
    "ProductName",
    "OMP Studio",
    "--set-version-string",
    "FileDescription",
    "OMP Studio",
    "--set-version-string",
    "InternalName",
    "OMP Studio",
    "--set-version-string",
    "OriginalFilename",
    "OMP Studio.exe",
  ]);

  await registerWindowsPreviewShortcut();
  return exePath;
}

async function main() {
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("The current preview launcher supports Windows, macOS and Linux Electron builds.");
  }
  if (!existsSync(join(root, "node_modules", "electron", "package.json"))) {
    throw new Error("Dependencies are missing. Run `npm install` once, then retry.");
  }

  if (production && previewData) {
    throw new Error(
      "OMP_PREVIEW_DATA=1 only applies to the Renderer dev server. Unset OMP_PREVIEW_MODE=production to open the preview with demo data.",
    );
  }

  console.log("[preview] Building workspace...");
  await run(process.execPath, [npmCli, "run", "build"]);

  console.log("[preview] Bundling sandboxed preload...");
  bundlePreload();

  const electronExecutable = await preparePreviewElectron();

  /**
   * 生产模式（OMP_PREVIEW_MODE=production）：跳过 vite dev server。改名后的
   * exe 报告 app.isPackaged === true，桌面端会忽略 OMP_RENDERER_DEV_URL、
   * 直接加载刚构建的 apps/renderer/dist——dev server 从未被它使用，白占一个
   * node 进程（内存 + 文件监听 CPU）和启动等待。
   *
   * 开发模式（默认）：exe 保持 electron.exe 这个名字，app.isPackaged 为
   * false，桌面端才会采纳 OMP_RENDERER_DEV_URL，渲染层真正走 dev server，
   * 改 UI 源码即时热更新，无需重启。
   */
  let renderer = null;
  if (!production) {
    console.log(`[preview] Starting Renderer dev server at ${previewUrl}...`);
    renderer = start(process.execPath, [npmCli,
      "run",
      "dev",
      "-w",
      "@omp-studio/renderer",
      "--",
      "--host",
      previewHost,
      "--port",
      previewPort,
      "--strictPort",
    ]);
    await waitForRenderer(renderer);
  }

  console.log(`[preview] Opening OMP Studio Desktop (${production ? "production bundle" : previewData ? "dev server, preview data" : "dev server"})...`);
  const desktopArgs = [join(root, "apps", "desktop")];
  if (production) {
    // 生产预览的实时 UI 更新靠 CDP 触发渲染层重载。
    desktopArgs.push(`--remote-debugging-port=${previewCdpPort}`);
  }
  const desktop = start(electronExecutable, desktopArgs, {
    env: {
      ...process.env,
      OMP_APP_USER_MODEL_ID: previewAumid,
      ...(production ? {} : { OMP_RENDERER_DEV_URL: rendererEntryUrl }),
    },
  });

  /**
   * 生产预览的 UI 实时预览：改源码 → 重建 renderer → 重载渲染层。
   *
   * 这里启动的是打包形态（改名后的 exe，isPackaged === true），渲染层加载
   * 的是 file:// 的构建产物，改 UI 源码本不会自动反映到窗口。生产预览刻意
   * 保留这个形态（要复现已安装路径），所以「重建 + 重载」这一步在预览进程
   * 侧完成，桌面端代码与 Studio Bridge 契约都不动。
   */
  if (production) {
    await startLiveUiPreview({
      rendererRoot: join(root, "apps", "renderer"),
      devServerPort: previewCdpPort,
      repoRoot: root,
      npmCli,
    });
  }

  const exitCode = await new Promise((resolve, reject) => {
    desktop.once("error", reject);
    desktop.once("exit", (code) => resolve(code ?? 1));
  });
  await cleanup();
  process.exitCode = exitCode;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void cleanup().finally(() => {
      process.exitCode = 130;
    });
  });
}

main().catch(async (error) => {
  console.error(`[preview] ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exitCode = 1;
});
