import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { desktopText } from "../desktop-language-shared.js";

const execute = promisify(execFile);
const windowsRename = `try {
  Rename-Item -LiteralPath $env:OMP_RENAME_SOURCE -NewName $env:OMP_RENAME_NAME -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit ($_.Exception.GetBaseException().HResult -band 0xffff)
}`;
const posixRename = `use strict;
use warnings;
my ($number, $cwd, $flags, $source, $target) = @ARGV;
if (syscall(int($number), int($cwd), $source, int($cwd), $target, int($flags)) != 0) {
  my $code = 0 + $!;
  print STDERR "$!\\n";
  exit($code == 17 ? 17 : 1);
}`;

export async function renameWithoutOverwrite(source: string, target: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", windowsRename], {
        windowsHide: true,
        env: { ...process.env, OMP_RENAME_SOURCE: source, OMP_RENAME_NAME: basename(target) },
      });
    } else {
      if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error(desktopText(`不支持此平台的独占重命名：${process.platform}-${process.arch}`, `Exclusive rename is unsupported on ${process.platform}-${process.arch}`));
      const syscall = process.platform === "darwin" ? 488 : process.arch === "arm64" ? 276 : 316;
      const cwd = process.platform === "darwin" ? -2 : -100;
      const flags = process.platform === "darwin" ? 4 : 1;
      await execute("/usr/bin/perl", ["-e", posixRename, "--", String(syscall), String(cwd), String(flags), source, target]);
    }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stderr?: string };
    if ([17, 80, 183].includes(Number(failure.code))) throw new Error(desktopText("目标名称已存在，未覆盖原文件", "Destination already exists; no file was overwritten"));
    if (failure.code === "ENOENT" && process.platform !== "win32") throw new Error(desktopText("重命名需要 /usr/bin/perl；请在此主机安装 Perl 后重试", "Renaming requires /usr/bin/perl; install Perl on this host and try again"));
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}
