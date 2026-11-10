// Platform `files` replaces the common list in electron-builder. Derive it from
// the shared YAML so adding a Windows-only omission cannot ship source/tests.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { parse } = require("yaml");
const config = parse(readFileSync(join(__dirname, "electron-builder.yml"), "utf8"));
module.exports = {
  ...config,
  win: {
    ...config.win,
    files: [...config.files, "!**/node-pty/prebuilds/!(win32-${arch})/**"],
  },
};
