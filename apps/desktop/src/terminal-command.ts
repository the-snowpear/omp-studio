import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { TerminalCommand } from "./terminal-shared.js";

export function commandArguments(command: TerminalCommand): string[] {
  if (!command || typeof command.text !== "string" || !command.text.trim()) throw new Error("Terminal command is empty");
  switch (command.shell) {
    case "powershell": return ["-NoLogo", "-EncodedCommand", Buffer.from(command.text, "utf16le").toString("base64")];
    case "bash": case "sh": case "zsh": return ["-lc", command.text];
    default: throw new Error("Unsupported command shell");
  }
}

export function resolveCommandShell(command: TerminalCommand, options: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean;
} = {}): { file: string; name: string } {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env, exists = options.exists ?? existsSync;
  const windows = platform === "win32", path = windows ? win32 : posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":").filter(Boolean).map(dir => dir.replace(/^"|"$/g, ""));
  const names = command.shell === "powershell" ? windows ? ["pwsh.exe", "powershell.exe"] : ["pwsh"] : [command.shell + (windows ? ".exe" : "")];
  const candidates: string[] = [];
  if (windows && (command.shell === "bash" || command.shell === "sh")) {
    // Prefer Git's shell; System32/bash.exe is the WSL launcher.
    for (const dir of dirs) if (exists(win32.join(dir, "git.exe"))) candidates.push(win32.resolve(dir, "..", "bin", names[0]!));
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs")]) {
      if (base) candidates.push(win32.join(base, "Git", "bin", names[0]!));
    }
  }
  for (const name of names) candidates.push(...dirs.map(dir => path.join(dir, name)));
  if (windows && command.shell === "powershell") candidates.push(
    win32.join(env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  if (!windows) for (const name of names) candidates.push(`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`);
  const wsl = win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "bash.exe").toLowerCase();
  const file = candidates.find(candidate => (!windows || candidate.toLowerCase() !== wsl) && exists(candidate));
  if (!file) throw new Error(`未找到 ${command.shell === "powershell" ? "PowerShell" : command.shell}，请先安装对应 Shell`);
  return { file, name: path.basename(file).replace(/\.exe$/i, "") };
}
