import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const defaultSourceDirectory = fileURLToPath(new URL("../omp-patch/vendor/oh-my-pi/", import.meta.url));
const sourceDirectory = process.env.OMP_SOURCE_DIR ?? defaultSourceDirectory;

const pin = JSON.parse(readFileSync(new URL("../omp-patch/upstream.json", import.meta.url), "utf8"));
const actual = execFileSync("git", ["-C", resolve(sourceDirectory), "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

if (actual !== pin.commit) {
  throw new Error(`OMP source is at ${actual}; expected ${pin.commit}`);
}

console.log(`Verified OMP source commit ${actual}`);
