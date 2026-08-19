import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, rename, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const root = process.cwd();
const previewHost = "127.0.0.1";
const previewPort = process.env.OMP_PREVIEW_PORT ?? "5173";
const previewUrl = `http://${previewHost}:${previewPort}`;
const npmCli = process.env.OMP_NPM_CLI ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const esbuildCli = join(
  root,
  "node_modules",
  "esbuild",
  "bin",
  "esbuild",
);
const electronDist = join(root, "node_modules", "electron", "dist");
const previewElectronDir = join(root, "outputs", "preview-electron");
const previewElectronExe = join(previewElectronDir, "OMP Studio.exe");
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
  const shortcutPath = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "OMP Studio.lnk");
  const aumid = "com.ompstudio.desktop";
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

async function preparePreviewElectron() {
  if (!existsSync(electronDist)) {
    throw new Error("Electron distribution is missing. Run `npm install` once, then retry.");
  }
  if (process.platform !== "win32") {
    return join(electronDist, "Electron.app", "Contents", "MacOS", "Electron");
  }
  if (!existsSync(appIcon) || !existsSync(rceditExe)) {
    throw new Error("Preview icon resources are missing. Expected apps/desktop/resources/icon.ico and rcedit.exe.");
  }

  await rm(previewElectronDir, { recursive: true, force: true });
  await mkdir(previewElectronDir, { recursive: true });
  await cp(electronDist, previewElectronDir, { recursive: true });
  await rename(join(previewElectronDir, "electron.exe"), previewElectronExe);

  await run(rceditExe, [
    previewElectronExe,
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
  return previewElectronExe;
}

async function main() {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("The current preview launcher supports Windows and macOS Electron builds.");
  }
  if (!existsSync(esbuildCli) || !existsSync(join(root, "node_modules", "electron", "package.json"))) {
    throw new Error("Dependencies are missing. Run `npm install` once, then retry.");
  }

  console.log("[preview] Building workspace...");
  await run(process.execPath, [npmCli, "run", "build"]);

  console.log("[preview] Bundling sandboxed preload...");
  await run(process.execPath, [esbuildCli, 
    "apps/desktop/src/preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=apps/desktop/dist/preload.cjs",
  ]);

  const electronExecutable = await preparePreviewElectron();

  console.log(`[preview] Starting Renderer at ${previewUrl}...`);
  const renderer = start(process.execPath, [npmCli,
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

  console.log("[preview] Opening OMP Studio Desktop...");
  const desktop = start(electronExecutable, [join(root, "apps", "desktop")], {
    env: { ...process.env, OMP_RENDERER_DEV_URL: previewUrl },
  });

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
