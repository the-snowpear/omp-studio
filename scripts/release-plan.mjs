import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runners = [
  { target: "win32-x64", os: "windows-latest" },
  { target: "win32-arm64", os: "windows-11-arm" },
  { target: "linux-x64", os: "ubuntu-24.04" },
  { target: "linux-arm64", os: "ubuntu-24.04-arm" },
  { target: "darwin-x64", os: "macos-15-intel" },
  { target: "darwin-arm64", os: "macos-15" },
];

export function releasePlan({ kind = "desktop", arch = "both", includeMacos = false, platforms } = {}) {
  const windows = runners.filter(row => row.target.startsWith("win32-") && (arch === "both" || row.target.endsWith(`-${arch}`)));
  const targets = platforms && platforms !== "all" ? platforms.split(",")
    : kind === "desktop" ? runners.map(row => row.target)
    : [...windows.map(row => row.target), ...(includeMacos ? ["darwin-arm64"] : [])];
  return {
    kind,
    matrix: { include: windows.map(row => ({ arch: row.target.slice(6), os: row.os })) },
    runtime_platforms: targets.join(","),
    runtime_matrix: { include: runners.filter(row => targets.includes(row.target)) },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const plan = releasePlan({ kind: process.env.REQUEST_KIND || "desktop", arch: process.env.TARGET_ARCH || "both", includeMacos: process.env.INCLUDE_MACOS === "true", platforms: process.env.RUNTIME_PLATFORMS });
  for (const [name, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}
