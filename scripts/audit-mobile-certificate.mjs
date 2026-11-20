import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAll } from "@electron/asar";

export default function auditMobileCertificate({ appOutDir, packager }) {
  // An archive extracted outside the checkout cannot silently use its node_modules.
  const directory = mkdtempSync(join(tmpdir(), "omp-packaged-certificate-"));
  try {
    extractAll(join(packager.getResourcesDir(appOutDir), "app.asar"), directory);
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { getMobileCertificate } from "./dist/src/mobile-certificate.js";
      await getMobileCertificate(".", "127.0.0.1");
    `], { cwd: directory, stdio: "inherit", windowsHide: true });
    console.log("[pack] Generated a mobile HTTPS certificate using the shipped app.asar");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
