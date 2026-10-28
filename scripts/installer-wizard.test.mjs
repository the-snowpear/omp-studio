import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
Var ompDirLocked
Var ompExistingDir
${["ompHideNsisUi", "ompRestoreNsisUi", "ompResolveInstDir", "ompInstFilesPre", "ompInstFilesShow", "ompHtmlFinishShow"].map(productionFunction).join("\n")}
!define MUI_PAGE_CUSTOMFUNCTION_PRE ompInstFilesPre
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ompInstFilesShow
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
