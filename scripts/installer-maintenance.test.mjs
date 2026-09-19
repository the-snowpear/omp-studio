import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("legacy migration waits on the real NSIS process and checks the uninstall result", { skip: process.platform !== "win32" }, async () => {
  const source = await readFile(new URL("../packaging/installer-host/InstallerHost.cs", import.meta.url), "utf8");
  const start = source.indexOf("internal static class UpdateMaintenance"), end = source.indexOf("internal static class Program");
  assert.ok(start >= 0 && end > start);
  // Compile the production maintenance class directly; no WebView2/UI or UAC is needed.
  const directory = await mkdtemp(join(tmpdir(), "omp-maintenance-test-"));
  const path = join(directory, "MaintenanceTest.cs"), exe = join(directory, "MaintenanceTest.exe");
  const harness = `
internal static class Harness {
  static void Check(bool value) { if (!value) throw new Exception("Maintenance regression"); }
  static int Main(string[] args) {
    string oldRoot = Path.Combine(args[0], "old install with spaces");
    Directory.CreateDirectory(oldRoot);
    string original = Path.Combine(oldRoot, "Uninstall OMP Studio.exe");
    string app = Path.Combine(oldRoot, "OMP Studio.exe");
    File.WriteAllText(original, "fixture-uninstaller"); File.WriteAllText(app, "fixture-app");
    string copied = null;
    int code = UpdateMaintenance.UninstallLegacy(oldRoot, delegate(ProcessStartInfo info) {
      copied = info.FileName;
      Check(copied != original && File.ReadAllText(copied) == "fixture-uninstaller");
      Check(info.Arguments == "/S /KEEP_APP_DATA --updated /allusers _?=" + oldRoot);
      Check(info.UseShellExecute && info.Verb == "runas" && info.WindowStyle == ProcessWindowStyle.Hidden);
      return 27; // A started uninstaller that eventually fails must fail migration.
    });
    Check(code == 27 && File.Exists(app) && !File.Exists(copied));
    code = UpdateMaintenance.UninstallLegacy(oldRoot, delegate(ProcessStartInfo info) { return 0; });
    Check(code == 16); // A successful launcher alone is not successful removal.
    code = UpdateMaintenance.UninstallLegacy(oldRoot, delegate(ProcessStartInfo info) {
      throw new System.ComponentModel.Win32Exception(1223); // UAC cancelled.
    });
    Check(code == 13 && File.Exists(app));
    code = UpdateMaintenance.UninstallLegacy(oldRoot, delegate(ProcessStartInfo info) {
      File.Delete(app); File.Delete(original); return 0;
    });
    Check(code == 0 && !File.Exists(app));
    Console.WriteLine("NSIS arguments, failure, incomplete removal, cancellation and success passed");
    return 0;
  }
}`;
  await writeFile(path, "using System; using System.IO; using System.Diagnostics;\n" + source.slice(start, end) + harness);
  const csc = ["Framework64", "Framework"].map(arch => join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", arch, "v4.0.30319", "csc.exe")).find(existsSync);
  assert.ok(csc, ".NET Framework C# compiler is required for the Windows installer");
  execFileSync(csc, ["/nologo", "/target:exe", `/out:${exe}`, path], { windowsHide: true, timeout: 60_000 });
  const output = execFileSync(exe, [directory], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
  assert.match(output, /success passed/);
});
