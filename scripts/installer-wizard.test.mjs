import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);

test("the HTML wizard keeps its chosen directory after install-mode selection and exits on Finish", { skip: process.platform !== "win32" }, async () => {
  const { getMakeNsisPath, getNsisPluginsPath } = require("app-builder-lib/out/toolsets/windows.js");
  const compiler = await getMakeNsisPath();
  const plugins = await getNsisPluginsPath();
  const templates = fileURLToPath(new URL("../node_modules/app-builder-lib/templates/nsis/", import.meta.url));
  const hooks = await readFile(new URL("../packaging/nsis/custom.nsh", import.meta.url), "utf8");
  const productionFunction = name => {
    const match = hooks.match(new RegExp(`^\\s*Function ${name}\\r?\\n[\\s\\S]*?^\\s*FunctionEnd`, "m"));
    assert.ok(match, `production function ${name} exists`);
    return match[0];
  };
  const directory = await mkdtemp(join(tmpdir(), "omp-wizard-test-"));
  const setup = join(directory, "Wizard.exe");
  const script = join(directory, "wizard.nsi");

  // Compile the actual hooks with electron-builder's actual directory-reset
  // macro. The fixture writes only its result INI, never an app or registry key.
  await writeFile(script, `
Unicode true
OutFile "${setup}"
RequestExecutionLevel user
!addincludedir "${templates}"
!addincludedir "${join(templates, "include")}"
!addplugindir /x86-unicode "${join(plugins, "x86-unicode")}"
!define PRODUCT_NAME "OMP installer regression"
!define PRODUCT_FILENAME "OMP Studio"
!define APP_FILENAME "OMP Studio"
!define APP_GUID "omp-wizard-regression-${Date.now()}"
!define UNINSTALL_APP_KEY "\${APP_GUID}"
!define VERSION "0.1.13"
!define OMP_PRODUCT_DIR "OMP Studio"
!include "LogicLib.nsh"
!include "StdUtils.nsh"
!include "common.nsh"
!include "${join(templates, "multiUser.nsh")}"
!include "MUI2.nsh"
Var ompHtmlResolved
Var ompHtmlUi
Var ompUiProcess
Var ompDirLocked
Var ompExistingDir
${["ompHideNsisUi", "ompRestoreNsisUi", "ompResolveInstDir", "ompInstFilesPre", "ompInstFilesShow", "ompInstFilesLeave", "ompHtmlFinishShow"].map(productionFunction).join("\n")}
!define MUI_PAGE_CUSTOMFUNCTION_PRE ompInstFilesPre
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ompInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ompInstFilesLeave
!insertmacro MUI_PAGE_INSTFILES
Page custom ompHtmlFinishShow
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  InitPluginsDir
  ReadINIStr $INSTDIR "$EXEDIR\\case.ini" "Case" "Dir"
  StrCpy $ompExistingDir $INSTDIR
  ReadINIStr $ompDirLocked "$EXEDIR\\case.ini" "Case" "Locked"
  WriteINIStr "$PLUGINSDIR\\options.ini" "Install" "Dir" "$INSTDIR"
  StrCpy $ompHtmlResolved "1"
  StrCpy $ompHtmlUi "1"
  !insertmacro setInstallModePerUser
FunctionEnd
Section
  WriteINIStr "$EXEDIR\\result.ini" "Result" "Dir" "$INSTDIR"
  WriteINIStr "$PLUGINSDIR\\finish.ini" "Install" "Run" "0"
SectionEnd
`);
  execFileSync(compiler.path, ["/V2", script], { env: { ...process.env, ...compiler.env }, windowsHide: true, timeout: 30_000 });

  // MUI starts copying automatically. Do not click its hidden Next button:
  // the setup must reach the HTML finish callback and exit on its own.
  for (const [path, locked] of [["D:\\Tools\\Studio Custom", "0"], ["D:\\开发工具\\OMP Studio", "1"]]) {
    await writeFile(join(directory, "case.ini"), `\ufeff[Case]\r\nDir=${path}\r\nLocked=${locked}\r\n`, "utf16le");
    await writeFile(join(directory, "result.ini"), "\ufeff[Result]\r\n", "utf16le");
    execFileSync(setup, [], { windowsHide: true, timeout: 5_000 });
    const result = await readFile(join(directory, "result.ini"), "utf16le");
    assert.ok(result.includes(`Dir=${path}\r\n`), `NSIS must install to ${path}, received ${result}`);
  }
});

test("the wizard exchanges Chinese paths and releases its hidden engine after success or a copy failure", { skip: process.platform !== "win32" }, async () => {
  const { getMakeNsisPath, getNsisPluginsPath } = require("app-builder-lib/out/toolsets/windows.js");
  const compiler = await getMakeNsisPath(), plugins = await getNsisPluginsPath();
  const templates = fileURLToPath(new URL("../node_modules/app-builder-lib/templates/nsis/", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "omp-wizard-host-"));
  const resources = join(directory, "resources");
  const host = join(resources, "installer-host");
  await mkdir(host, { recursive: true });
  await mkdir(join(resources, "installer-ui"));
  await writeFile(join(resources, "installer-ui", "index.html"), "fixture");
  await writeFile(join(host, "runtime-version.nsh"), '!define OMP_RUNTIME_VERSION "test"\n!define OMP_TARGET_ARCH "x64"\n');
  const hostSource = await readFile(new URL("../packaging/installer-host/InstallerHost.cs", import.meta.url), "utf8");
  const ini = hostSource.slice(hostSource.indexOf("internal static class Ini"), hostSource.indexOf("internal static class Json"));
  const native = hostSource.slice(hostSource.indexOf("internal static class Native"));
  const fakeSource = join(directory, "Host.cs");
  await writeFile(fakeSource, `
using System; using System.IO; using System.Diagnostics; using System.Text; using System.Threading; using System.Runtime.InteropServices;
${ini}
${native}
static class Host {
  static int Main(string[] args) {
    string root = args[Array.IndexOf(args, "--dir") + 1];
    string result = ${JSON.stringify(join(directory, "host-result.txt"))};
    string expected = ${JSON.stringify(join(directory, "开发工具", "Studio"))};
    string selected = Ini.Read(Path.Combine(root, "host.ini"), "DefaultDir", "missing");
    if (selected != expected) { File.WriteAllText(result, "Bad INI path: " + selected); return 1; }
    File.WriteAllText(Path.Combine(root, "host-ready.txt"), "[Host]\\r\\nPid=" + Process.GetCurrentProcess().Id + "\\r\\n", Encoding.Unicode);
    Thread.Sleep(600); // NSIS must remain in its host wait loop until options exist.
    File.WriteAllText(Path.Combine(root, "options.ini"), "[Install]\\r\\nDir=" + selected + "\\r\\n", Encoding.Unicode);
    IntPtr parent = new IntPtr(long.Parse(args[Array.IndexOf(args, "--parent") + 1]));
    for (int i = 0; i < 500; i++) {
      if (!Native.IsWindow(parent)) { File.WriteAllText(result, "parent exited"); return 0; }
      if (File.Exists(Path.Combine(root, "done.ini"))) {
        string actual = Ini.Read(Path.Combine(root, "done.ini"), "InstDir", "missing", "Install");
        File.WriteAllText(result, actual == expected ? "success" : "Bad completion path: " + actual);
        File.WriteAllText(Path.Combine(root, "finish.ini"), "[Install]\\r\\nRun=0\\r\\n", Encoding.Unicode);
        return 0;
      }
      Thread.Sleep(10);
    }
    File.WriteAllText(result, "NSIS never completed"); return 2;
  }
}`);
  const csc = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
  execFileSync(csc, ["/nologo", "/target:winexe", `/out:${join(host, "OmpInstallerUi.exe")}`, fakeSource], { windowsHide: true, timeout: 30_000 });
  const script = join(directory, "wizard.nsi");
  const setup = join(directory, "Wizard.exe");
  await writeFile(script, `\ufeff
Unicode true
OutFile "${setup}"
RequestExecutionLevel user
!addincludedir "${templates}"
!addincludedir "${join(templates, "include")}"
!addplugindir /x86-unicode "${join(plugins, "x86-unicode")}"
!define PRODUCT_NAME "OMP installer regression"
!define PRODUCT_FILENAME "OMP Studio"
!define APP_FILENAME "OMP Studio"
!define APP_GUID "omp-wizard-host-${Date.now()}"
!define UNINSTALL_APP_KEY "\${APP_GUID}"
!define VERSION "0.1.14"
!define isUpdated "0 == 1"
!define BUILD_RESOURCES_DIR "${resources}"
!include "LogicLib.nsh"
!include "StdUtils.nsh"
!include "common.nsh"
!include "${join(templates, "multiUser.nsh")}"
!include "${fileURLToPath(new URL("../packaging/nsis/custom.nsh", import.meta.url))}"
!include "MUI2.nsh"
!insertmacro customWelcomePage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro customHeader
Function .onInit
  InitPluginsDir
  StrCpy $INSTDIR "${join(directory, "开发工具", "Studio")}"
  StrCpy $ompExistingVersion ""
  StrCpy $ompExistingDir ""
  StrCpy $ompDirLocked "0"
FunctionEnd
Section
  WriteINIStr "$PLUGINSDIR\\done.ini" "Install" "InstDir" "$INSTDIR"
SectionEnd
`, "utf16le");
  execFileSync(compiler.path, ["/V2", script], { env: { ...process.env, ...compiler.env }, windowsHide: true, timeout: 30_000 });
  execFileSync(setup, [], { windowsHide: true, timeout: 10_000 });
  assert.equal(await readFile(join(directory, "host-result.txt"), "utf8"), "success");
  // An actual section Abort must also release the hidden engine. NSIS's
  // .onInstFailed alone runs only after closing its otherwise hidden page.
  await rm(join(directory, "host-result.txt"));
  const failed = (await readFile(script, "utf16le")).replace('  WriteINIStr "$PLUGINSDIR\\done.ini" "Install" "InstDir" "$INSTDIR"', '  Abort "copy failed"');
  await writeFile(script, failed, "utf16le");
  execFileSync(compiler.path, ["/V2", script], { env: { ...process.env, ...compiler.env }, windowsHide: true, timeout: 30_000 });
  assert.throws(() => execFileSync(setup, [], { windowsHide: true, timeout: 10_000 }), error => error.status === 2);
  let result;
  for (let i = 0; i < 100; i++) {
    try { result = await readFile(join(directory, "host-result.txt"), "utf8"); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result, "parent exited");
});
