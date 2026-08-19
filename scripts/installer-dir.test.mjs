import assert from "node:assert/strict";
import { test } from "node:test";

import { PRODUCT_DIR, isDriveRoot, isProductDir, resolveInstallDir } from "./installer-dir.mjs";

test("drive roots always nest a product folder so uninstall cannot RMDir a volume", () => {
  assert.equal(resolveInstallDir("D:\\"), `D:\\${PRODUCT_DIR}`);
  assert.equal(resolveInstallDir("D:"), `D:\\${PRODUCT_DIR}`);
  assert.equal(isDriveRoot("C:\\"), true);
});

test("a path whose last segment is already OMP Studio is kept, including after a double nest", () => {
  assert.equal(isProductDir("C:\\Program Files\\OMP Studio"), true);
  assert.equal(resolveInstallDir("C:\\Program Files\\OMP Studio"), "C:\\Program Files\\OMP Studio");
  assert.equal(
    resolveInstallDir("C:\\Program Files\\OMP Studio\\OMP Studio"),
    "C:\\Program Files\\OMP Studio",
  );
});

test("Program Files, Desktop, and other container names nest even when empty", () => {
  assert.equal(
    resolveInstallDir("C:\\Program Files", { exists: true, empty: true }),
    `C:\\Program Files\\${PRODUCT_DIR}`,
  );
  assert.equal(
    resolveInstallDir("C:\\Users\\Ada\\Desktop", { exists: true, empty: true }),
    `C:\\Users\\Ada\\Desktop\\${PRODUCT_DIR}`,
  );
  assert.equal(
    resolveInstallDir("C:\\Users\\Ada\\Documents", { exists: true, empty: false }),
    `C:\\Users\\Ada\\Documents\\${PRODUCT_DIR}`,
  );
});

test("an empty custom folder or a path that does not exist yet is the install root", () => {
  assert.equal(resolveInstallDir("D:\\Dev", { exists: true, empty: true }), "D:\\Dev");
  assert.equal(resolveInstallDir("D:\\MyTools\\Workbench", { exists: false }), "D:\\MyTools\\Workbench");
});

test("a non-empty custom folder nests so program files are not mixed in", () => {
  assert.equal(
    resolveInstallDir("D:\\Projects", { exists: true, empty: false }),
    `D:\\Projects\\${PRODUCT_DIR}`,
  );
});

test("a folder that already has this app's exe is kept even when the name differs", () => {
  assert.equal(
    resolveInstallDir("D:\\Tools", { exists: true, empty: false, hasProductFiles: true }),
    "D:\\Tools",
  );
});

test("upgrade lock uses the previous InstallLocation without nesting", () => {
  assert.equal(
    resolveInstallDir("C:\\Program Files", { lockedPath: "D:\\Apps\\OMP Studio" }),
    "D:\\Apps\\OMP Studio",
  );
});

test("special folder equality matches NSIS $PROGRAMFILES-style roots", () => {
  assert.equal(
    resolveInstallDir("C:\\Program Files", {
      exists: true,
      empty: true,
      specialFolders: ["C:\\Program Files"],
    }),
    `C:\\Program Files\\${PRODUCT_DIR}`,
  );
});
