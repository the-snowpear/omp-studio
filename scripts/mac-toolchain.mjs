// macOS build preflight: report every missing prerequisite at once, before a
// long Bun/Cargo build fails on the first one.
import { execFileSync } from "node:child_process";
import { isRosettaTranslated } from "./target-platform.mjs";

export const MIN_BUN_VERSION = "1.4.2";

export function compareVersions(left, right) {
  const parse = (value) => {
    const parts = String(value).trim().replace(/^v/u, "").split(/[.-]/u);
    return [0, 1, 2].map((index) => Number.parseInt(parts[index] ?? "0", 10) || 0);
  };
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

const defaultRun = (file, args, env) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });

export function macToolchainProblems({
  rust = false,
  bunVersion,
  env = process.env,
  arch = process.arch,
  translated = isRosettaTranslated(),
  run = defaultRun,
} = {}) {
  const problems = [];
  if (arch !== "arm64" || translated) {
    problems.push("Node is not a native arm64 build; install arm64 Node (nodejs.org, nvm or Homebrew on Apple Silicon)");
  }
  // `xcode-select -p` never pops the install dialog; the /usr/bin shims (git,
  // clang, xcrun tools) do, so they are only touched once CLT is known present.
  let clt = false;
  try {
    run("/usr/bin/xcode-select", ["-p"], env);
    clt = true;
  } catch {
    problems.push("Xcode Command Line Tools are missing; run `xcode-select --install`");
  }
  if (clt) {
    try {
      run("/usr/bin/xcrun", ["--find", "clang"], env);
    } catch {
      problems.push("clang is unavailable from the active developer directory; reinstall Xcode Command Line Tools");
    }
  }
  if (bunVersion !== undefined && compareVersions(bunVersion, MIN_BUN_VERSION) < 0) {
    problems.push(`Bun ${MIN_BUN_VERSION} or newer is required; found ${bunVersion}`);
  }
  if (rust) {
    try {
      const host = /^host: (.+)$/mu.exec(run("rustc", ["-vV"], env))?.[1]?.trim();
      if (host !== "aarch64-apple-darwin") problems.push(`Rust must build for aarch64-apple-darwin; rustc host is ${host ?? "unknown"}`);
    } catch {
      problems.push("Rust is missing; install it with rustup (https://rustup.rs)");
    }
  }
  return problems;
}

export function assertMacToolchain(options) {
  const problems = macToolchainProblems(options);
  if (problems.length > 0) throw new Error(`macOS toolchain is not ready:\n- ${problems.join("\n- ")}`);
}
