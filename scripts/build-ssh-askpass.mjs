import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export async function buildSshAskpass(output = join(root, "apps/desktop/dist/ssh-askpass")) {
  const source = join(root, "apps/desktop/ssh-askpass");
  await mkdir(output, { recursive: true });
  if (process.platform === "win32") {
    const framework = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET");
    const csc = ["Framework64", "Framework"].map(name => join(framework, name, "v4.0.30319", "csc.exe")).find(existsSync);
    if (!csc) throw new Error("Building SSH password authentication requires .NET Framework 4.x csc.exe");
    const result = spawnSync(csc, ["/nologo", "/target:winexe", "/platform:anycpu", "/optimize+", `/out:${join(output, "omp-ssh-askpass.exe")}`, join(source, "Askpass.cs")], { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `SSH askpass build failed: ${result.stdout}${result.stderr}`);
  } else {
    await copyFile(join(source, "askpass.cjs"), join(output, "askpass.cjs"));
    await copyFile(join(source, "askpass.sh"), join(output, "askpass.sh"));
    await chmod(join(output, "askpass.sh"), 0o755);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildSshAskpass(process.argv[2]));
