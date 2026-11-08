import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

/** LibreOffice starts soffice.bin; cancelling must end that child as well as the launcher. */
export function runOfficeProcess(executable: string, args: string[], signal: AbortSignal, timeoutMs = 120_000): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "", failure: Error | undefined;
    const kill = (error: Error) => {
      if (failure) return; failure = error;
      if (!child.pid) return;
      if (process.platform === "win32") execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const abort = () => kill(new Error("文档转换已取消"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => kill(new Error("文档转换超时，请使用系统应用检查文件")), timeoutMs);
    const collect = (data: Buffer) => { output = (output + data.toString("utf8")).slice(-4096); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure) reject(failure); else if (code) reject(new Error(output || `Office 转换失败 (${code})`)); else resolve();
    });
    if (signal.aborted) abort();
  });
}
