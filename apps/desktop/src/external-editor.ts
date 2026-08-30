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
import { basename, dirname, join } from "node:path";

export type ExternalEditorId = "vscode" | "cursor" | "windsurf";

export interface ExternalEditorCommand {
  readonly label: string;
  /** Stable family id for installed editors; absent for user-picked executables. */
  readonly id?: ExternalEditorId;
  readonly file: string;
  argsFor(target: string): readonly string[];
}

export interface ResolveExternalEditorOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

function asCommand(id: ExternalEditorId | undefined, label: string, file: string): ExternalEditorCommand {
  return {
    ...(id === undefined ? {} : { id }),
    label,
    file,
    argsFor: (target) => [target],
  };
}

/**
 * All installed editor commands, one per family (VS Code / Cursor /
 * Windsurf). Windows/macOS probe absolute app paths; Linux relies on PATH
 * names and lets spawn surface ENOENT for missing binaries.
 */
export function listExternalEditorCommands(options: ResolveExternalEditorOptions = {}): ExternalEditorCommand[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (platform === "win32") {
    const families: ReadonlyArray<{ id: ExternalEditorId; label: string; segments: readonly string[]; root: string | undefined }> = [
      { id: "vscode", label: "Visual Studio Code", segments: ["Programs", "Microsoft VS Code", "Code.exe"], root: env.LOCALAPPDATA },
      { id: "vscode", label: "Visual Studio Code - Insiders", segments: ["Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"], root: env.LOCALAPPDATA },
      { id: "vscode", label: "Visual Studio Code", segments: ["Microsoft VS Code", "Code.exe"], root: env.ProgramFiles },
      { id: "vscode", label: "Visual Studio Code", segments: ["Microsoft VS Code", "Code.exe"], root: env["ProgramFiles(x86)"] },
      { id: "vscode", label: "Visual Studio Code - Insiders", segments: ["Microsoft VS Code Insiders", "Code - Insiders.exe"], root: env.ProgramFiles },
      { id: "cursor", label: "Cursor", segments: ["Programs", "Cursor", "Cursor.exe"], root: env.LOCALAPPDATA },
      { id: "windsurf", label: "Windsurf", segments: ["Programs", "Windsurf", "Windsurf.exe"], root: env.LOCALAPPDATA },
    ];
    const found: ExternalEditorCommand[] = [];
    for (const candidate of families) {
      if (candidate.root === undefined) continue;
      const file = join(candidate.root, ...candidate.segments);
      if (exists(file) && !found.some((command) => command.id === candidate.id)) {
        found.push(asCommand(candidate.id, candidate.label, file));
      }
    }
    return found;
  }

  if (platform === "darwin") {
    const families: ReadonlyArray<{ id: ExternalEditorId; label: string; file: string }> = [
      { id: "vscode", label: "Visual Studio Code", file: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" },
      { id: "cursor", label: "Cursor", file: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" },
      { id: "windsurf", label: "Windsurf", file: "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" },
    ];
    return families.filter((candidate) => exists(candidate.file)).map((candidate) => asCommand(candidate.id, candidate.label, candidate.file));
  }

  // Linux: rely on PATH. `launchExternalEditor` maps ENOENT to a readable
  // message naming the target editor.
  return [
    asCommand("vscode", "Visual Studio Code", "code"),
    asCommand("cursor", "Cursor", "cursor"),
    asCommand("windsurf", "Windsurf", "windsurf"),
  ];
}

/**
 * Pick the first installed editor command. Windows/macOS use absolute app
 * paths where possible; Linux relies on PATH (`code`, `codium`, ...).
 */
export function resolveExternalEditorCommand(options: ResolveExternalEditorOptions = {}): ExternalEditorCommand | undefined {
  return listExternalEditorCommands(options)[0];
}

export interface LaunchExternalEditorOptions {
  readonly platform?: NodeJS.Platform;
}

/**
 * Spawn the editor detached and resolve once the OS accepted the process.
 * `targetPath` may be a project directory or a single file — the target is
 * passed as the editor argument, while the child's working directory is the
 * target's containing directory (spawn rejects a file path as cwd).
 */
export function launchExternalEditor(
  command: ExternalEditorCommand,
  targetPath: string,
  options: LaunchExternalEditorOptions = {},
): Promise<void> {
  const child = spawn(command.file, [...command.argsFor(targetPath)], {
    cwd: dirname(targetPath),
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
      argsFor: (target) => ["-a", file, target],
    };
  }
  return asCommand(undefined, label, file);
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
