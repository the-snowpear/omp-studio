/**
 * Best-effort launch of the project in an installed desktop editor.
 *
 * The Renderer never learns the command or the workspace path: Main resolves
 * both and only reports success/failure. Editor discovery is deliberately
 * small and local (VS Code / Cursor / Windsurf); no user input is ever used
 * to build the command.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export interface ExternalEditorCommand {
  readonly label: string;
  readonly file: string;
  argsFor(cwd: string): readonly string[];
}

export interface ResolveExternalEditorOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

function asCommand(label: string, file: string): ExternalEditorCommand {
  return {
    label,
    file,
    argsFor: (cwd) => [cwd],
  };
}

/**
 * Pick the first installed editor command. Windows/macOS use absolute app
 * paths where possible; Linux relies on PATH (`code`, `codium`, ...).
 */
export function resolveExternalEditorCommand(options: ResolveExternalEditorOptions = {}): ExternalEditorCommand | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (platform === "win32") {
    const roots: Array<{ path: string | undefined; label: string; segments: readonly string[] }> = [
      { path: env.LOCALAPPDATA, label: "Visual Studio Code", segments: ["Programs", "Microsoft VS Code", "Code.exe"] },
      { path: env.LOCALAPPDATA, label: "Visual Studio Code - Insiders", segments: ["Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"] },
      { path: env.ProgramFiles, label: "Visual Studio Code", segments: ["Microsoft VS Code", "Code.exe"] },
      { path: env["ProgramFiles(x86)"], label: "Visual Studio Code", segments: ["Microsoft VS Code", "Code.exe"] },
      { path: env.ProgramFiles, label: "Visual Studio Code - Insiders", segments: ["Microsoft VS Code Insiders", "Code - Insiders.exe"] },
      { path: env.LOCALAPPDATA, label: "Cursor", segments: ["Programs", "Cursor", "Cursor.exe"] },
      { path: env.LOCALAPPDATA, label: "Windsurf", segments: ["Programs", "Windsurf", "Windsurf.exe"] },
    ];
    for (const root of roots) {
      if (root.path === undefined) continue;
      const file = join(root.path, ...root.segments);
      if (exists(file)) {
        return asCommand(root.label, file);
      }
    }
    return undefined;
  }

  if (platform === "darwin") {
    const candidates: ReadonlyArray<{ label: string; file: string }> = [
      { label: "Visual Studio Code", file: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" },
      { label: "Cursor", file: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" },
      { label: "Windsurf", file: "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" },
    ];
    for (const candidate of candidates) {
      if (exists(candidate.file)) return asCommand(candidate.label, candidate.file);
    }
    return undefined;
  }

  // Linux: rely on PATH. `launchExternalEditor` maps ENOENT to a readable
  // message naming the first preferred editor.
  const commands: ReadonlyArray<{ label: string; file: string }> = [
    { label: "Visual Studio Code", file: "code" },
    { label: "VSCodium", file: "codium" },
    { label: "Cursor", file: "cursor" },
    { label: "Windsurf", file: "windsurf" },
  ];
  const preferred = commands[0];
  return preferred === undefined ? undefined : asCommand(preferred.label, preferred.file);
}

export interface LaunchExternalEditorOptions {
  readonly platform?: NodeJS.Platform;
}

/** Spawn the editor detached and resolve once the OS accepted the process. */
export function launchExternalEditor(
  command: ExternalEditorCommand,
  cwd: string,
  options: LaunchExternalEditorOptions = {},
): Promise<void> {
  const child = spawn(command.file, [...command.argsFor(cwd)], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error(`未找到外部编辑器 ${command.label}，请确认其已安装并可从 PATH 启动`));
        return;
      }
      reject(error);
    };
    child.once("error", fail);
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

export type CreateExternalEditorOpenerOptions = ResolveExternalEditorOptions;

/**
 * Build a launch command for an executable the user selected in the system
 * picker. On macOS an `.app` bundle is launched through `/usr/bin/open -a`.
 */
export function externalEditorCommandForPath(
  file: string,
  options: { readonly platform?: NodeJS.Platform } = {},
): ExternalEditorCommand {
  const platform = options.platform ?? process.platform;
  const label = basename(file).replace(/\.app$/iu, "");
  if (platform === "darwin" && file.toLowerCase().endsWith(".app")) {
    return {
      label,
      file: "/usr/bin/open",
      argsFor: (cwd) => ["-a", file, cwd],
    };
  }
  return asCommand(label, file);
}

/** Main-side opener: discover an installed editor, then launch it detached. */
export function createExternalEditorOpener(options: CreateExternalEditorOpenerOptions = {}) {
  return async (cwd: string): Promise<void> => {
    const command = resolveExternalEditorCommand(options);
    if (command === undefined) {
      throw new Error("未找到外部编辑器，请安装 Visual Studio Code / Cursor / Windsurf");
    }
    await launchExternalEditor(command, cwd, options);
  };
}
